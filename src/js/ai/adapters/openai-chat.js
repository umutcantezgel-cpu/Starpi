// @ts-check
// Adapter for OpenAI-compatible Chat Completions, the dialect most providers and local servers
// share. One wire adapter per provider, shaped by its quirks object (src/js/ai/quirks): where the
// reasoning arrives (`reasoning_content`, `reasoning`, typed content chunks or <think> tags), extra
// headers, request fields for reasoning and search, and where usage is reported.
//
// Streamed chunks become AiEvents: content deltas as text, reasoning deltas as reasoning, tool calls
// with argument pieces and a final parsed call, url_citation annotations as citations, generated
// images (data URLs) as image events. `[DONE]` ends the stream; a body that closes after a finish
// reason without `[DONE]` ends it too, and one that closes before is a cut stream.
//
// The legacy fold of the same chunks into one answer string (createChatStreamAssembler, used by
// the 2.x NVIDIA client) and splitReasoning() for whole answers stay in chat-stream.js and are
// re-exported here.
import { messageText, withoutForeignOpaque } from '../contract.js';
import { AiError } from '../errors.js';
import { fromLocal, fromOpenAiChat } from '../stop-reason.js';
import { capsFor, findModel, parseModelList } from '../catalog/models.js';
import { GENERIC_QUIRKS } from '../quirks/generic.js';
import { createThinkSplitter, createToolCalls, dataUrl, fileAsText, isRecord, safeJson, streamError, usageEvent } from './common.js';

export { createChatStreamAssembler, splitReasoning } from '../../chat-stream.js';

/** @typedef {import('../contract.js').AiRequest} AiRequest */
/** @typedef {import('../contract.js').AiEvent} AiEvent */
/** @typedef {import('../contract.js').Caps} Caps */
/** @typedef {import('../contract.js').Part} Part */
/** @typedef {import('../contract.js').ProviderId} ProviderId */
/** @typedef {import('../quirks/generic.js').ChatQuirks} ChatQuirks */
/** @typedef {import('../stream.js').WireAdapter} WireAdapter */

export const CHAT_PATH = '/v1/chat/completions';
/** The `kind` of the opaque block holding structured reasoning to replay (OpenRouter). */
export const OPAQUE_REASONING_DETAILS = 'chat-reasoning-details';

/**
 * Content of a user message: a plain string when it is text only (every server takes that), else
 * typed parts. Images go to vision models and to models the catalog does not describe (a local
 * model may well read images); PDFs only where the quirks allow file parts; text files as text.
 * @param {Part[]} parts
 * @param {ChatQuirks} quirks
 * @param {boolean} images
 */
function userContent(parts, quirks, images) {
  /** @type {any[]} */
  const items = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text) items.push({ type: 'text', text: p.text });
    } else if (p.type === 'image') {
      if (images) items.push({ type: 'image_url', image_url: { url: dataUrl(p.mime, p.data) } });
    } else if (p.type === 'file') {
      if (p.mime !== 'application/pdf') items.push({ type: 'text', text: fileAsText(p.name, p.data) });
      else if (quirks.filesAsParts) items.push({ type: 'file', file: { filename: p.name, file_data: dataUrl(p.mime, p.data) } });
    }
  }
  if (items.every((i) => i.type === 'text')) return items.map((i) => i.text).join('\n\n');
  return items;
}

/**
 * The messages in Chat Completions form.
 * @param {AiRequest} req
 * @param {ProviderId} provider
 * @param {ChatQuirks} quirks
 * @param {Caps} caps
 */
export function chatMessages(req, provider, quirks, caps) {
  const images = caps.vision || !findModel(provider, req.model);
  /** @type {any[]} */
  const out = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  for (const m of withoutForeignOpaque(req.messages, provider)) {
    if (m.role === 'system') {
      const text = messageText(m);
      if (text) out.push({ role: 'system', content: text });
    } else if (m.role === 'user') {
      const content = userContent(m.content, quirks, images);
      if (content.length) out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const text = messageText(m);
      const calls = m.content.flatMap((p) => (p.type === 'tool_call' ? [{ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.args) } }] : []));
      if (!text && !calls.length) continue;
      /** @type {Record<string, unknown>} */
      const message = { role: 'assistant', content: text || null };
      if (calls.length) message.tool_calls = calls;
      if (quirks.replayReasoningDetails) {
        const details = m.content.find((p) => p.type === 'opaque' && isRecord(p.block) && p.block.kind === OPAQUE_REASONING_DETAILS);
        if (details && details.type === 'opaque' && isRecord(details.block)) message.reasoning_details = details.block.details;
      }
      out.push(message);
    } else {
      for (const p of m.content) if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.id, content: p.content });
    }
  }
  return out;
}

/**
 * The request body of a call.
 * @param {AiRequest} req
 * @param {ProviderId} provider
 * @param {ChatQuirks} quirks
 * @param {Caps} caps
 */
export function buildChatBody(req, provider, quirks, caps) {
  /** @type {Record<string, any>} */
  const body = { model: req.model, messages: chatMessages(req, provider, quirks, caps), stream: true };
  if (quirks.streamUsage) body.stream_options = { include_usage: true };
  const maxTokens = req.maxOutputTokens ?? quirks.defaultMaxTokens?.(req.model);
  if (maxTokens) body.max_tokens = Math.max(1, Math.min(maxTokens, caps.maxOutput));
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
    if (req.toolChoice) body.tool_choice = req.toolChoice;
  }
  if (req.responseFormat) body.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: req.responseFormat.schema, strict: false } };
  quirks.shape?.(body, req, caps);
  return body;
}

/**
 * Merges streamed reasoning_details pieces: entries with the same index and type are one entry
 * whose text fields grow.
 * @param {any[]} into
 * @param {unknown} pieces
 */
function mergeDetails(into, pieces) {
  if (!Array.isArray(pieces)) return;
  for (const piece of pieces) {
    if (!isRecord(piece)) continue;
    const index = typeof piece.index === 'number' ? piece.index : into.length;
    const existing = into.find((d) => d.index === index && d.type === piece.type);
    if (!existing) {
      into.push({ ...piece, index });
      continue;
    }
    for (const key of ['text', 'summary', 'data']) {
      if (typeof piece[key] === 'string') existing[key] = (typeof existing[key] === 'string' ? existing[key] : '') + piece[key];
    }
    for (const [key, value] of Object.entries(piece)) if (!['text', 'summary', 'data', 'index'].includes(key) && value !== null && value !== undefined) existing[key] = value;
  }
}

/**
 * @typedef {object} ChatState
 * @property {string} model
 * @property {boolean} started
 * @property {boolean} ended
 * @property {string | null} finishReason
 * @property {ReturnType<typeof createToolCalls>} tools
 * @property {ReturnType<typeof createThinkSplitter> | null} think
 * @property {Set<string>} cited
 * @property {AiEvent | null} usage
 * @property {any[]} details
 * @property {number} calls
 */

/**
 * @param {ChatState} state
 * @param {ProviderId} provider
 * @returns {AiEvent[]}
 */
function begin(state, provider) {
  if (state.started) return [];
  state.started = true;
  return [{ type: 'start', provider, model: state.model }];
}

/**
 * @param {unknown} raw
 * @returns {AiEvent | null}
 */
function readUsage(raw) {
  if (!isRecord(raw)) return null;
  return usageEvent({
    input: raw.prompt_tokens,
    output: raw.completion_tokens,
    reasoning: raw.completion_tokens_details?.reasoning_tokens,
    cacheRead: raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens,
  });
}

/**
 * Text and reasoning of one content value: a string (through the think splitter when the
 * provider writes <think> tags) or an array of typed chunks.
 * @param {unknown} content
 * @param {ChatState} state
 * @returns {AiEvent[]}
 */
function contentEvents(content, state) {
  /** @type {AiEvent[]} */
  const out = [];
  if (typeof content === 'string') {
    if (!content) return out;
    if (state.think) for (const piece of state.think.push(content)) out.push({ type: piece.type, delta: piece.delta });
    else out.push({ type: 'text', delta: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const chunk of content) {
    if (!isRecord(chunk)) continue;
    if (chunk.type === 'text' && typeof chunk.text === 'string' && chunk.text) out.push(...contentEvents(chunk.text, state));
    else if (chunk.type === 'thinking') {
      const parts = Array.isArray(chunk.thinking) ? chunk.thinking : [chunk.thinking];
      for (const part of parts) {
        const text = typeof part === 'string' ? part : isRecord(part) && typeof part.text === 'string' ? part.text : '';
        if (text) out.push({ type: 'reasoning', delta: text });
      }
    }
  }
  return out;
}

/**
 * Citation events of url_citation annotations not seen before.
 * @param {unknown} annotations
 * @param {ChatState} state
 * @returns {AiEvent[]}
 */
function citationEvents(annotations, state) {
  /** @type {AiEvent[]} */
  const out = [];
  if (!Array.isArray(annotations)) return out;
  for (const a of annotations) {
    if (!isRecord(a) || a.type !== 'url_citation') continue;
    const c = isRecord(a.url_citation) ? a.url_citation : a;
    if (typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url)) continue;
    const start = Number.isInteger(c.start_index) && c.start_index >= 0 ? c.start_index : undefined;
    const end = Number.isInteger(c.end_index) && c.end_index >= (start ?? 0) ? c.end_index : undefined;
    const key = `${c.url}|${start}|${end}`;
    if (state.cited.has(key)) continue;
    state.cited.add(key);
    out.push({ type: 'citation', url: c.url, title: typeof c.title === 'string' ? c.title : '', ...(typeof c.content === 'string' ? { citedText: c.content } : {}), ...(start !== undefined && end !== undefined ? { start, end } : {}) });
  }
  return out;
}

/**
 * Image events of generated images sent as data URLs.
 * @param {unknown} images
 * @returns {AiEvent[]}
 */
function imageEvents(images) {
  /** @type {AiEvent[]} */
  const out = [];
  if (!Array.isArray(images)) return out;
  for (const img of images) {
    const url = isRecord(img) ? (isRecord(img.image_url) ? img.image_url.url : img.url) : null;
    const m = typeof url === 'string' ? /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url) : null;
    if (m) out.push({ type: 'image', mime: m[1].toLowerCase(), data: m[2] });
  }
  return out;
}

/**
 * The events of one choice delta (streamed) or message (whole answer).
 * @param {Record<string, any>} delta
 * @param {ChatState} state
 * @param {ChatQuirks} quirks
 * @returns {AiEvent[]}
 */
function deltaEvents(delta, state, quirks) {
  /** @type {AiEvent[]} */
  const out = [];
  for (const field of quirks.reasoningFields) {
    const value = delta[field];
    if (typeof value === 'string' && value) {
      out.push({ type: 'reasoning', delta: value });
      break;
    }
  }
  if (quirks.replayReasoningDetails) mergeDetails(state.details, delta.reasoning_details);
  out.push(...contentEvents(quirks.contentChunks || typeof delta.content === 'string' ? delta.content : null, state));
  if (Array.isArray(delta.tool_calls)) {
    for (const [i, call] of delta.tool_calls.entries()) {
      if (!isRecord(call)) continue;
      const key = typeof call.index === 'number' ? call.index : typeof call.id === 'string' ? call.id : i;
      const fn = isRecord(call.function) ? call.function : {};
      out.push(...state.tools.add(key, { id: call.id, name: fn.name, argsDelta: fn.arguments }, () => `call_${state.model.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}_${(state.calls += 1)}`));
    }
  }
  out.push(...citationEvents(delta.annotations, state));
  out.push(...imageEvents(delta.images));
  return out;
}

/**
 * The closing events: held-back text, final tool calls, replayable reasoning, usage, end.
 * @param {ChatState} state
 * @param {ChatQuirks} quirks
 * @returns {AiEvent[]}
 */
function closing(state, quirks) {
  if (state.ended) return [];
  state.ended = true;
  /** @type {AiEvent[]} */
  const out = [];
  if (state.think) for (const piece of state.think.flush()) out.push({ type: piece.type, delta: piece.delta });
  out.push(...state.tools.finish());
  if (quirks.replayReasoningDetails && state.details.length) out.push({ type: 'opaque', block: { kind: OPAQUE_REASONING_DETAILS, details: state.details } });
  if (state.usage) out.push(state.usage);
  const context = { hasToolCalls: state.tools.size > 0 };
  out.push({ type: 'end', stopReason: quirks.stopDialect === 'local' ? fromLocal(state.finishReason, context) : fromOpenAiChat(state.finishReason, context) });
  return out;
}

/**
 * Events of one parsed chunk (or whole completion).
 * @param {Record<string, any>} chunk
 * @param {ChatState} state
 * @param {ProviderId} provider
 * @param {ChatQuirks} quirks
 * @returns {AiEvent[]}
 */
function chunkEvents(chunk, state, provider, quirks) {
  if (chunk.error !== undefined && chunk.error !== null) {
    const err = isRecord(chunk.error) ? chunk.error : { code: chunk.error };
    state.ended = true;
    const error = streamError(provider, err.code ?? err.type ?? err.status);
    return [...begin(state, provider), { type: 'end', stopReason: error.code === 'refusal' ? 'refusal' : 'error', error }];
  }
  if (typeof chunk.model === 'string' && chunk.model && !state.started) state.model = chunk.model;
  const out = begin(state, provider);
  const usage = readUsage(quirks.usageOf?.(chunk) ?? chunk.usage);
  if (usage) state.usage = usage;
  const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : null;
  if (!choice) return out;
  const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
  out.push(...deltaEvents(delta, state, quirks));
  if (typeof choice.finish_reason === 'string' && choice.finish_reason) state.finishReason = choice.finish_reason.slice(0, 40);
  return out;
}

/**
 * @typedef {object} ChatAdapterOptions
 * @property {ProviderId} [provider]   which provider this adapter speaks for (default 'local')
 * @property {Readonly<ChatQuirks>} [quirks]
 */

/**
 * A Chat Completions adapter for one provider.
 * @param {ChatAdapterOptions} [options]
 * @returns {WireAdapter & { quirks: Readonly<ChatQuirks>, createState(req: AiRequest): ChatState }}
 */
export function createOpenAiChatAdapter(options = {}) {
  const provider = options.provider ?? 'local';
  const quirks = options.quirks ?? GENERIC_QUIRKS;
  return {
    kind: 'wire',
    id: provider,
    dialect: 'openai-chat',
    quirks,
    capabilities: (modelId, catalog) => capsFor(provider, modelId, catalog),
    listModels: { path: '/v1/models', parse: (json) => parseModelList(provider, json).map(({ id, label, contextTokens, maxOutput }) => ({ id, label, contextTokens, maxOutput })) },
    authHeader: (key) => ['authorization', `Bearer ${key}`],
    buildRequest(req) {
      const caps = capsFor(provider, req.model);
      return {
        path: quirks.path ?? CHAT_PATH,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...quirks.headers },
        body: buildChatBody(req, provider, quirks, caps),
      };
    },
    createState(req) {
      return { model: req.model, started: false, ended: false, finishReason: null, tools: createToolCalls(), think: quirks.thinkTags ? createThinkSplitter() : null, cited: new Set(), usage: null, details: [], calls: 0 };
    },
    parseEvent(sse, state) {
      if (state.ended) return [];
      const data = sse.data.trim();
      if (data === '[DONE]') return [...begin(state, provider), ...closing(state, quirks)];
      const chunk = safeJson(data);
      if (!isRecord(chunk)) throw new AiError('bad_response', { provider });
      return chunkEvents(chunk, state, provider, quirks);
    },
    finish(state) {
      // Some servers close the stream after the finish reason without sending [DONE].
      return state.finishReason !== null ? closing(state, quirks) : [];
    },
    parseResponse(json, state) {
      if (!isRecord(json)) throw new AiError('bad_response', { provider });
      return [...chunkEvents(json, state, provider, quirks), ...closing(state, quirks)];
    },
  };
}
