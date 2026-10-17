// @ts-check
// What a pool request may carry, and the upstream request built from it. A pool spends the site's
// keys, so it accepts far less than the relay: text, and images for models flagged `vision`; no
// tools, no response formats, no provider extras; an output limit clamped to the model's; a model
// from the pool's allowlist. Every field not named here is dropped, `stream` is always on.
//
// Two dialects: OpenAI-compatible chat completions (NVIDIA, Groq, OpenRouter) and Gemini's
// streamGenerateContent. For text-only models the chat rules are exactly those of
// api/_lib/nvidia-request.js, which the shared NVIDIA vectors pin down; a unit test runs every
// vector through both.

/**
 * @typedef {import('./allowlist.js').PoolSpec} PoolSpec
 * @typedef {import('./allowlist.js').PoolModel} PoolModel
 * @typedef {{ ok: false, status: number, error: string, field?: string }} PoolRefusal
 * @typedef {{ dialect: 'openai-chat' } | { dialect: 'gemini', model: string }} PoolRoute
 * @typedef {{ ok: true, model: PoolModel, body: Record<string, unknown>, url: string }} PoolRequest
 */

const ROLES = ['system', 'user', 'assistant'];
// Only ASCII whitespace counts as blank, so every implementation agrees on every string.
const BLANK = /^[\t\n\v\f\r ]*$/;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_DETAIL = ['auto', 'low', 'high'];
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];
const CHAT_PATH = '/v1/chat/completions';
const GEMINI_PATH = /^\/v1beta\/models\/([a-z0-9][a-z0-9.-]{0,99}):streamGenerateContent(?:\?alt=sse)?$/;
const MAX_PARTS = 16;

/**
 * @param {string} field
 * @returns {PoolRefusal}
 */
const invalid = (field) => ({ ok: false, status: 400, error: 'invalid_field', field });

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 */
const present = (value) => value !== undefined && value !== null;

/**
 * The route of a pool path: chat completions, or a Gemini model's streamGenerateContent.
 * @param {PoolSpec} spec
 * @param {string} path the upstream path the browser names (it may carry ?alt=sse)
 * @returns {({ ok: true } & PoolRoute) | PoolRefusal}
 */
export function poolRoute(spec, path) {
  if (spec.dialect === 'openai-chat') return path === CHAT_PATH ? { ok: true, dialect: 'openai-chat' } : { ok: false, status: 404, error: 'path_not_allowed' };
  const m = GEMINI_PATH.exec(path);
  return m ? { ok: true, dialect: 'gemini', model: m[1] } : { ok: false, status: 404, error: 'path_not_allowed' };
}

/**
 * The output limit: the requested one (a positive integer) or the model's default, clamped.
 * @param {unknown} value
 * @param {PoolModel} model
 * @param {PoolSpec} spec
 * @returns {number | null} null when the value is not a positive integer
 */
function outputLimit(value, model, spec) {
  const cap = Math.min(model.maxOutputTokens, spec.limits.maxOutputTokens);
  if (!present(value)) return Math.min(model.defaultMaxTokens, cap);
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 1) return null;
  return Math.min(/** @type {number} */ (value), cap);
}

/**
 * Counts text and images against the request limits.
 * @param {PoolSpec} spec
 */
function budget(spec) {
  let chars = 0;
  let images = 0;
  let imageChars = 0;
  return {
    /** @param {string} text */
    text(text) {
      chars += text.length;
      return text.length <= spec.limits.maxMessageChars && chars <= spec.limits.maxTotalChars;
    },
    /** @param {string} data */
    image(data) {
      images++;
      imageChars += data.length;
      return images <= spec.limits.maxImages && imageChars <= spec.limits.maxImageChars;
    },
  };
}

/**
 * One chat content: a string, or (vision models) an array of text and image_url parts.
 * @param {unknown} content
 * @param {PoolModel} model
 * @param {ReturnType<typeof budget>} count
 * @returns {{ content: string | Array<Record<string, unknown>>, text: string, images: number } | null}
 */
function chatContent(content, model, count) {
  // Lengths are UTF-16 code units, as String#length counts them; the caller checks them.
  if (typeof content === 'string') return { content, text: content, images: 0 };
  if (!model.vision || !Array.isArray(content) || content.length === 0 || content.length > MAX_PARTS) return null;
  /** @type {Array<Record<string, unknown>>} */
  const parts = [];
  let text = '';
  let images = 0;
  for (const part of content) {
    if (!isObject(part)) return null;
    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && isObject(part.image_url) && typeof part.image_url.url === 'string' && IMAGE_DATA_URL.test(part.image_url.url)) {
      const { url, detail } = part.image_url;
      if (present(detail) && !IMAGE_DETAIL.includes(/** @type {string} */ (detail))) return null;
      if (!count.image(url)) return null;
      images++;
      parts.push({ type: 'image_url', image_url: present(detail) ? { url, detail } : { url } });
    } else return null;
  }
  return { content: parts, text, images };
}

/**
 * @param {unknown} messages
 * @param {PoolSpec} spec
 * @param {PoolModel} model
 * @returns {Array<{ role: string, content: unknown }> | null}
 */
function chatMessages(messages, spec, model) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > spec.limits.maxMessages) return null;
  const count = budget(spec);
  /** @type {Array<{ role: string, content: unknown }>} */
  const clean = [];
  let last = { role: '', text: '', images: 0 };
  for (const [index, message] of messages.entries()) {
    if (!isObject(message)) return null;
    const { role } = message;
    if (typeof role !== 'string' || !ROLES.includes(role) || (role === 'system' && index > 0)) return null;
    // Images only in user messages.
    const content = chatContent(message.content, role === 'user' ? model : { ...model, vision: false }, count);
    if (!content || !count.text(content.text)) return null;
    clean.push({ role, content: content.content });
    last = { role, text: content.text, images: content.images };
  }
  if (last.role !== 'user' || (BLANK.test(last.text) && last.images === 0)) return null;
  return clean;
}

/**
 * Sampling options shared by the dialects.
 * @param {unknown} temperature
 * @param {unknown} topP
 * @param {[string, string]} names the field names to report and to write
 * @returns {{ ok: true, options: Record<string, number> } | PoolRefusal}
 */
function sampling(temperature, topP, names) {
  /** @type {Record<string, number>} */
  const options = {};
  if (present(temperature)) {
    if (!isNumber(temperature) || temperature < 0 || temperature > 2) return invalid(names[0]);
    options[names[0]] = temperature;
  }
  if (present(topP)) {
    if (!isNumber(topP) || topP <= 0 || topP > 1) return invalid(names[1]);
    options[names[1]] = topP;
  }
  return { ok: true, options };
}

/**
 * @param {PoolSpec} spec
 * @param {Record<string, unknown>} data
 * @returns {PoolRequest | PoolRefusal}
 */
function chatRequest(spec, data) {
  if (typeof data.model !== 'string') return invalid('model');
  const model = spec.models.find((m) => m.id === data.model);
  if (!model) return { ok: false, status: 400, error: 'model_not_allowed' };

  const messages = chatMessages(data.messages, spec, model);
  if (!messages) return invalid('messages');
  const maxTokens = outputLimit(data.max_tokens, model, spec);
  if (maxTokens === null) return invalid('max_tokens');
  const options = sampling(data.temperature, data.top_p, ['temperature', 'top_p']);
  if (!options.ok) return options;

  // The model's fixed upstream fields come first, so they can never override the validated ones.
  return {
    ok: true,
    model,
    url: `${spec.root}${CHAT_PATH}`,
    body: { ...model.upstream, model: model.id, messages, max_tokens: maxTokens, stream: true, ...options.options },
  };
}

/**
 * Gemini parts: text, and inline images for vision models in user turns. Thought parts of earlier
 * model turns are left out (the pool never replays reasoning); any other part is refused.
 * @param {unknown} parts
 * @param {boolean} images
 * @param {ReturnType<typeof budget>} count
 * @returns {{ parts: Array<Record<string, unknown>>, text: string, images: number } | null}
 */
function geminiParts(parts, images, count) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) return null;
  /** @type {Array<Record<string, unknown>>} */
  const clean = [];
  let text = '';
  let imageCount = 0;
  for (const part of parts) {
    if (!isObject(part)) return null;
    if (part.thought === true) continue;
    if (typeof part.text === 'string') {
      text += part.text;
      clean.push({ text: part.text });
    } else if (images && isObject(part.inlineData) && IMAGE_MIME.includes(/** @type {string} */ (part.inlineData.mimeType)) && typeof part.inlineData.data === 'string' && BASE64.test(part.inlineData.data)) {
      if (!count.image(part.inlineData.data)) return null;
      imageCount++;
      clean.push({ inlineData: { mimeType: part.inlineData.mimeType, data: part.inlineData.data } });
    } else return null;
  }
  return { parts: clean, text, images: imageCount };
}

/**
 * @param {PoolSpec} spec
 * @param {string} modelId from the path
 * @param {Record<string, unknown>} data
 * @returns {PoolRequest | PoolRefusal}
 */
function geminiRequest(spec, modelId, data) {
  const model = spec.models.find((m) => m.id === modelId);
  if (!model) return { ok: false, status: 400, error: 'model_not_allowed' };
  const count = budget(spec);

  /** @type {Record<string, unknown> | null} */
  let systemInstruction = null;
  if (present(data.systemInstruction)) {
    const system = isObject(data.systemInstruction) ? geminiParts(data.systemInstruction.parts, false, count) : null;
    if (!system || !count.text(system.text)) return invalid('systemInstruction');
    systemInstruction = { parts: system.parts };
  }

  const { contents } = data;
  if (!Array.isArray(contents) || contents.length === 0 || contents.length > spec.limits.maxMessages) return invalid('contents');
  /** @type {Array<Record<string, unknown>>} */
  const clean = [];
  let last = { role: '', text: '', images: 0 };
  for (const content of contents) {
    if (!isObject(content)) return invalid('contents');
    const role = content.role ?? 'user';
    if (role !== 'user' && role !== 'model') return invalid('contents');
    const parts = geminiParts(content.parts, model.vision && role === 'user', count);
    if (!parts || !count.text(parts.text)) return invalid('contents');
    if (parts.parts.length === 0) continue;
    clean.push({ role, parts: parts.parts });
    last = { role, text: parts.text, images: parts.images };
  }
  if (last.role !== 'user' || (BLANK.test(last.text) && last.images === 0)) return invalid('contents');

  const config = present(data.generationConfig) ? data.generationConfig : {};
  if (!isObject(config)) return invalid('generationConfig');
  const maxOutputTokens = outputLimit(config.maxOutputTokens, model, spec);
  if (maxOutputTokens === null) return invalid('maxOutputTokens');
  const options = sampling(config.temperature, config.topP, ['temperature', 'topP']);
  if (!options.ok) return options;
  /** @type {Record<string, unknown>} */
  const generationConfig = { maxOutputTokens, ...options.options };
  if (present(config.thinkingConfig)) {
    const thinking = config.thinkingConfig;
    if (!isObject(thinking)) return invalid('thinkingConfig');
    /** @type {Record<string, unknown>} */
    const out = {};
    if (present(thinking.includeThoughts)) {
      if (typeof thinking.includeThoughts !== 'boolean') return invalid('thinkingConfig');
      out.includeThoughts = thinking.includeThoughts;
    }
    if (present(thinking.thinkingBudget)) {
      if (!Number.isInteger(thinking.thinkingBudget) || /** @type {number} */ (thinking.thinkingBudget) < -1) return invalid('thinkingConfig');
      out.thinkingBudget = Math.min(/** @type {number} */ (thinking.thinkingBudget), maxOutputTokens);
    }
    if (present(thinking.thinkingLevel)) {
      if (!THINKING_LEVELS.includes(/** @type {string} */ (thinking.thinkingLevel))) return invalid('thinkingConfig');
      out.thinkingLevel = thinking.thinkingLevel;
    }
    if (Object.keys(out).length > 0) generationConfig.thinkingConfig = out;
  }

  return {
    ok: true,
    model,
    url: `${spec.root}/v1beta/models/${model.id}:streamGenerateContent?alt=sse`,
    body: { ...model.upstream, contents: clean, ...(systemInstruction ? { systemInstruction } : {}), generationConfig },
  };
}

/**
 * Checks a pool request and builds the upstream request (body and URL) from the allowed fields.
 * @param {PoolSpec} spec
 * @param {PoolRoute} route from poolRoute()
 * @param {Record<string, unknown>} data parsed JSON object
 * @returns {PoolRequest | PoolRefusal}
 */
export function validatePoolRequest(spec, route, data) {
  return route.dialect === 'gemini' ? geminiRequest(spec, route.model, data) : chatRequest(spec, data);
}
