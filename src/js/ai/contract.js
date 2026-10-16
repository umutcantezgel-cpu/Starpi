// @ts-check
// The contract every AI provider adapter speaks: the request, message parts, tool specs, model
// capabilities and the normalized stream events. JSDoc types plus small runtime validators that
// return a list of problems (empty when valid). No DOM and no I/O, so the browser, workers and
// server code share it.

/**
 * @typedef {'anthropic' | 'openai' | 'gemini' | 'xai' | 'groq' | 'mistral' | 'deepseek' | 'openrouter' | 'nvidia' | 'local' | 'webgpu' | 'wasm'} ProviderId
 */

/** @typedef {'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'} ImageMime */
/** @typedef {'application/pdf' | 'text/plain' | 'text/markdown' | 'text/csv'} FileMime */

/**
 * One piece of a message. `data` holds base64 without a data: prefix. `opaque` is provider state
 * that is replayed unchanged (signed reasoning blocks, thought signatures, encrypted reasoning
 * items); it is dropped when the conversation goes to another provider (withoutForeignOpaque).
 * @typedef {{ type: 'text', text: string }} TextPart
 * @typedef {{ type: 'image', mime: ImageMime, data: string, name?: string }} ImagePart
 * @typedef {{ type: 'file', mime: FileMime, data: string, name: string }} FilePart
 * @typedef {{ type: 'tool_call', id: string, name: string, args: Record<string, unknown> }} ToolCallPart
 * @typedef {{ type: 'tool_result', id: string, content: string, isError?: boolean }} ToolResultPart
 * @typedef {{ type: 'opaque', provider: ProviderId, model: string, block: unknown }} OpaquePart
 * @typedef {TextPart | ImagePart | FilePart | ToolCallPart | ToolResultPart | OpaquePart} Part
 */

/** @typedef {'system' | 'user' | 'assistant' | 'tool'} Role */
/** @typedef {{ role: Role, content: Part[] }} Message */

/**
 * A tool the model may call. `schema` is a JSON Schema object for the arguments; `sideEffects`
 * tells the tool loop whether a call needs the user's approval.
 * @typedef {{ name: string, description: string, schema: Record<string, unknown>, sideEffects: boolean }} ToolSpec
 */

/** @typedef {'off' | 'auto' | 'on'} ThinkingMode */
/** @typedef {'low' | 'medium' | 'high' | 'max'} Effort */
/** @typedef {{ mode: ThinkingMode, effort?: Effort, show?: boolean }} ThinkingOptions */
/** @typedef {{ enabled: boolean, maxUses?: number, allowDomains?: string[], blockDomains?: string[] }} SearchOptions */
/** @typedef {{ type: 'json_schema', schema: Record<string, unknown> }} ResponseFormat */

/**
 * One model call, independent of the provider. A forced tool choice is not part of the contract:
 * several current models reject it, so only 'auto' and 'none' exist.
 * @typedef {object} AiRequest
 * @property {ProviderId} provider
 * @property {string} model
 * @property {Message[]} messages
 * @property {string} [system]
 * @property {ToolSpec[]} [tools]
 * @property {'auto' | 'none'} [toolChoice]
 * @property {ThinkingOptions} [thinking]
 * @property {SearchOptions} [search]
 * @property {ResponseFormat} [responseFormat]
 * @property {number} [maxOutputTokens]
 * @property {number} [temperature]
 * @property {number} [timeoutMs]   hard deadline for the whole call
 */

/**
 * What a model can do. `reasoning` names how thinking is controlled; `search` how web search is
 * reached; `verified` is false for models only known from a live list.
 * @typedef {object} Caps
 * @property {true} text
 * @property {boolean} vision
 * @property {boolean} pdf
 * @property {boolean} tools
 * @property {boolean} parallelTools
 * @property {'none' | 'effort' | 'budget' | 'adaptive' | 'tagged'} reasoning
 * @property {boolean} reasoningVisible
 * @property {'native' | 'plugin' | 'xai-tools' | 'none'} search
 * @property {boolean} imageOut
 * @property {boolean} audioIn
 * @property {boolean} live
 * @property {boolean} json
 * @property {number} contextTokens
 * @property {number} maxOutput
 * @property {number} [priceIn]    USD per million input tokens
 * @property {number} [priceOut]   USD per million output tokens
 * @property {'fast' | 'normal' | 'slow'} latency
 * @property {boolean} free
 * @property {boolean} local
 * @property {boolean} verified
 */

/** @typedef {'end_turn' | 'max_tokens' | 'tool_call' | 'refusal' | 'pause' | 'cancelled' | 'timeout' | 'error'} StopReason */

/**
 * Normalized stream events. A stream yields exactly one `start` first and one `end` last.
 * - start: the model that actually serves (it may differ from the requested one after a fallback)
 * - reasoning: visible or summarized text (`delta`), or only a count (`tokens`)
 * - tool_call: argument JSON arrives in `argsDelta` pieces; `final` marks the complete call
 * - citation: `start`/`end` are UTF-16 offsets into the answer text
 * - usage: totals so far; a later usage event replaces the fields it carries
 * - end: `error` is set when the call failed
 * @typedef {{ type: 'start', provider: ProviderId, model: string, requestId?: string | null }} StartEvent
 * @typedef {{ type: 'text', delta: string }} TextEvent
 * @typedef {{ type: 'reasoning', delta: string, tokens?: undefined } | { type: 'reasoning', tokens: number, delta?: undefined }} ReasoningEvent
 * @typedef {{ type: 'tool_call', id: string, name: string, argsDelta?: string, args?: Record<string, unknown>, final: boolean }} ToolCallEvent
 * @typedef {{ type: 'citation', url: string, title: string, citedText?: string, start?: number, end?: number }} CitationEvent
 * @typedef {{ type: 'image', mime: string, data: string }} ImageEvent
 * @typedef {{ type: 'opaque', block: unknown }} OpaqueEvent
 * @typedef {{ type: 'usage', input?: number, output?: number, reasoning?: number, cacheRead?: number, costUsd?: number }} UsageEvent
 * @typedef {{ type: 'end', stopReason: StopReason, error?: import('./errors.js').AiError }} EndEvent
 * @typedef {StartEvent | TextEvent | ReasoningEvent | ToolCallEvent | CitationEvent | ImageEvent | OpaqueEvent | UsageEvent | EndEvent} AiEvent
 */

export const PROVIDER_IDS = /** @type {readonly ProviderId[]} */ (
  Object.freeze(['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'openrouter', 'nvidia', 'local', 'webgpu', 'wasm'])
);
export const ROLES = /** @type {readonly Role[]} */ (Object.freeze(['system', 'user', 'assistant', 'tool']));
export const PART_TYPES = Object.freeze(['text', 'image', 'file', 'tool_call', 'tool_result', 'opaque']);
export const IMAGE_MIMES = /** @type {readonly ImageMime[]} */ (Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']));
export const FILE_MIMES = /** @type {readonly FileMime[]} */ (Object.freeze(['application/pdf', 'text/plain', 'text/markdown', 'text/csv']));
export const THINKING_MODES = /** @type {readonly ThinkingMode[]} */ (Object.freeze(['off', 'auto', 'on']));
export const EFFORTS = /** @type {readonly Effort[]} */ (Object.freeze(['low', 'medium', 'high', 'max']));
export const TOOL_CHOICES = Object.freeze(['auto', 'none']);
export const STOP_REASONS = /** @type {readonly StopReason[]} */ (Object.freeze(['end_turn', 'max_tokens', 'tool_call', 'refusal', 'pause', 'cancelled', 'timeout', 'error']));
export const EVENT_TYPES = Object.freeze(['start', 'text', 'reasoning', 'tool_call', 'citation', 'image', 'opaque', 'usage', 'end']);

/** Upper bounds the validators enforce; generous, they only stop runaway input. */
export const CONTRACT_LIMITS = Object.freeze({
  messages: 10_000,
  partsPerMessage: 512,
  textChars: 4_000_000,
  dataChars: 48_000_000,
  tools: 128,
  toolDescriptionChars: 10_000,
  modelChars: 200,
  nameChars: 256,
  domains: 64,
  maxOutputTokens: 1_000_000,
  timeoutMs: 3_600_000,
});

/** Tool names every supported provider accepts. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {number} max */
const isString = (value, max) => typeof value === 'string' && value.length <= max;
/** @param {unknown} value @param {number} max */
const isNonEmpty = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isCount = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
/**
 * @param {readonly string[]} list
 * @param {unknown} value
 */
const oneOf = (list, value) => typeof value === 'string' && list.includes(value);

/**
 * @param {unknown} value
 * @returns {value is ProviderId}
 */
export function isProviderId(value) {
  return oneOf(PROVIDER_IDS, value);
}

/**
 * @param {unknown} value
 * @returns {value is StopReason}
 */
export function isStopReason(value) {
  return oneOf(STOP_REASONS, value);
}

/**
 * Problems of one message part; empty when it is valid.
 * @param {unknown} part
 * @param {string} [at] path prefix for the messages
 * @returns {string[]}
 */
export function validatePart(part, at = 'part') {
  if (!isRecord(part)) return [`${at}: not an object`];
  /** @type {string[]} */
  const problems = [];
  const need = (/** @type {boolean} */ ok, /** @type {string} */ field, /** @type {string} */ what) => {
    if (!ok) problems.push(`${at}.${field}: ${what}`);
  };
  switch (part.type) {
    case 'text':
      need(isString(part.text, CONTRACT_LIMITS.textChars), 'text', 'string expected');
      break;
    case 'image':
      need(oneOf(IMAGE_MIMES, part.mime), 'mime', 'unsupported image type');
      need(isNonEmpty(part.data, CONTRACT_LIMITS.dataChars) && BASE64.test(/** @type {string} */ (part.data)), 'data', 'base64 expected');
      if (part.name !== undefined) need(isString(part.name, CONTRACT_LIMITS.nameChars), 'name', 'string expected');
      break;
    case 'file':
      need(oneOf(FILE_MIMES, part.mime), 'mime', 'unsupported file type');
      need(isNonEmpty(part.data, CONTRACT_LIMITS.dataChars) && BASE64.test(/** @type {string} */ (part.data)), 'data', 'base64 expected');
      need(isNonEmpty(part.name, CONTRACT_LIMITS.nameChars), 'name', 'file name expected');
      break;
    case 'tool_call':
      need(isNonEmpty(part.id, CONTRACT_LIMITS.nameChars), 'id', 'id expected');
      need(typeof part.name === 'string' && TOOL_NAME_PATTERN.test(part.name), 'name', 'tool name expected');
      need(isRecord(part.args), 'args', 'object expected');
      break;
    case 'tool_result':
      need(isNonEmpty(part.id, CONTRACT_LIMITS.nameChars), 'id', 'id expected');
      need(isString(part.content, CONTRACT_LIMITS.textChars), 'content', 'string expected');
      if (part.isError !== undefined) need(typeof part.isError === 'boolean', 'isError', 'boolean expected');
      break;
    case 'opaque':
      need(isProviderId(part.provider), 'provider', 'unknown provider');
      need(isNonEmpty(part.model, CONTRACT_LIMITS.modelChars), 'model', 'model id expected');
      need(part.block !== undefined, 'block', 'value expected');
      break;
    default:
      problems.push(`${at}.type: unknown part type`);
  }
  return problems;
}

/** Part types each role may carry. */
const PARTS_BY_ROLE = /** @type {Record<Role, readonly string[]>} */ ({
  system: ['text'],
  user: ['text', 'image', 'file'],
  assistant: ['text', 'image', 'tool_call', 'opaque'],
  tool: ['tool_result'],
});

/**
 * Problems of one message; empty when it is valid.
 * @param {unknown} message
 * @param {string} [at]
 * @returns {string[]}
 */
export function validateMessage(message, at = 'message') {
  if (!isRecord(message)) return [`${at}: not an object`];
  if (!oneOf(ROLES, message.role)) return [`${at}.role: unknown role`];
  const role = /** @type {Role} */ (message.role);
  if (!Array.isArray(message.content)) return [`${at}.content: array of parts expected`];
  if (message.content.length === 0) return [`${at}.content: at least one part expected`];
  if (message.content.length > CONTRACT_LIMITS.partsPerMessage) return [`${at}.content: too many parts`];
  /** @type {string[]} */
  const problems = [];
  message.content.forEach((part, i) => {
    const where = `${at}.content[${i}]`;
    const own = validatePart(part, where);
    problems.push(...own);
    if (own.length === 0 && !PARTS_BY_ROLE[role].includes(/** @type {Part} */ (part).type)) {
      problems.push(`${where}.type: not allowed in a ${role} message`);
    }
  });
  return problems;
}

/**
 * Problems of a tool spec; empty when it is valid.
 * @param {unknown} tool
 * @param {string} [at]
 * @returns {string[]}
 */
export function validateToolSpec(tool, at = 'tool') {
  if (!isRecord(tool)) return [`${at}: not an object`];
  /** @type {string[]} */
  const problems = [];
  if (typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name)) problems.push(`${at}.name: 1-64 letters, digits, _ or - expected`);
  if (!isNonEmpty(tool.description, CONTRACT_LIMITS.toolDescriptionChars)) problems.push(`${at}.description: text expected`);
  if (!isRecord(tool.schema)) problems.push(`${at}.schema: JSON Schema object expected`);
  if (typeof tool.sideEffects !== 'boolean') problems.push(`${at}.sideEffects: boolean expected`);
  return problems;
}

/**
 * @param {unknown} list
 * @param {string} at
 * @param {string[]} problems
 */
function checkDomains(list, at, problems) {
  if (list === undefined) return;
  if (!Array.isArray(list) || list.length > CONTRACT_LIMITS.domains || !list.every((d) => typeof d === 'string' && DOMAIN.test(d))) {
    problems.push(`${at}: list of host names expected`);
  }
}

/**
 * Problems of a request; empty when it is valid.
 * @param {unknown} req
 * @returns {string[]}
 */
export function validateRequest(req) {
  if (!isRecord(req)) return ['request: not an object'];
  /** @type {string[]} */
  const problems = [];
  if (!isProviderId(req.provider)) problems.push('provider: unknown provider');
  if (!isNonEmpty(req.model, CONTRACT_LIMITS.modelChars)) problems.push('model: model id expected');
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    problems.push('messages: at least one message expected');
  } else if (req.messages.length > CONTRACT_LIMITS.messages) {
    problems.push('messages: too many messages');
  } else {
    req.messages.forEach((m, i) => problems.push(...validateMessage(m, `messages[${i}]`)));
  }
  if (req.system !== undefined && !isString(req.system, CONTRACT_LIMITS.textChars)) problems.push('system: string expected');
  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools) || req.tools.length > CONTRACT_LIMITS.tools) {
      problems.push(`tools: up to ${CONTRACT_LIMITS.tools} tools expected`);
    } else {
      req.tools.forEach((t, i) => problems.push(...validateToolSpec(t, `tools[${i}]`)));
      const names = req.tools.map((t) => (isRecord(t) ? t.name : undefined));
      if (new Set(names).size !== names.length) problems.push('tools: names must be unique');
    }
  }
  if (req.toolChoice !== undefined && !oneOf(TOOL_CHOICES, req.toolChoice)) problems.push("toolChoice: 'auto' or 'none' expected");
  if (req.thinking !== undefined) {
    const th = req.thinking;
    if (!isRecord(th) || !oneOf(THINKING_MODES, th.mode)) problems.push("thinking.mode: 'off', 'auto' or 'on' expected");
    else {
      if (th.effort !== undefined && !oneOf(EFFORTS, th.effort)) problems.push('thinking.effort: low, medium, high or max expected');
      if (th.show !== undefined && typeof th.show !== 'boolean') problems.push('thinking.show: boolean expected');
    }
  }
  if (req.search !== undefined) {
    const s = req.search;
    if (!isRecord(s) || typeof s.enabled !== 'boolean') problems.push('search.enabled: boolean expected');
    else {
      if (s.maxUses !== undefined && !(isCount(s.maxUses) && /** @type {number} */ (s.maxUses) > 0 && /** @type {number} */ (s.maxUses) <= 100)) {
        problems.push('search.maxUses: 1-100 expected');
      }
      checkDomains(s.allowDomains, 'search.allowDomains', problems);
      checkDomains(s.blockDomains, 'search.blockDomains', problems);
      if (Array.isArray(s.allowDomains) && s.allowDomains.length && Array.isArray(s.blockDomains) && s.blockDomains.length) {
        problems.push('search: allowDomains and blockDomains exclude each other');
      }
    }
  }
  if (req.responseFormat !== undefined) {
    const f = req.responseFormat;
    if (!isRecord(f) || f.type !== 'json_schema' || !isRecord(f.schema)) problems.push("responseFormat: { type: 'json_schema', schema } expected");
  }
  if (req.maxOutputTokens !== undefined && !(isCount(req.maxOutputTokens) && req.maxOutputTokens > 0 && req.maxOutputTokens <= CONTRACT_LIMITS.maxOutputTokens)) {
    problems.push('maxOutputTokens: positive integer expected');
  }
  if (req.temperature !== undefined && !(typeof req.temperature === 'number' && req.temperature >= 0 && req.temperature <= 2)) {
    problems.push('temperature: 0-2 expected');
  }
  if (req.timeoutMs !== undefined && !(isCount(req.timeoutMs) && req.timeoutMs > 0 && req.timeoutMs <= CONTRACT_LIMITS.timeoutMs)) {
    problems.push('timeoutMs: positive integer expected');
  }
  return problems;
}

const CAPS_BOOLEANS = /** @type {const} */ (['vision', 'pdf', 'tools', 'parallelTools', 'reasoningVisible', 'imageOut', 'audioIn', 'live', 'json', 'free', 'local', 'verified']);

/**
 * Problems of a capability record; empty when it is valid.
 * @param {unknown} caps
 * @returns {string[]}
 */
export function validateCaps(caps) {
  if (!isRecord(caps)) return ['caps: not an object'];
  /** @type {string[]} */
  const problems = [];
  if (caps.text !== true) problems.push('caps.text: true expected');
  for (const key of CAPS_BOOLEANS) if (typeof caps[key] !== 'boolean') problems.push(`caps.${key}: boolean expected`);
  if (!oneOf(['none', 'effort', 'budget', 'adaptive', 'tagged'], caps.reasoning)) problems.push('caps.reasoning: unknown value');
  if (!oneOf(['native', 'plugin', 'xai-tools', 'none'], caps.search)) problems.push('caps.search: unknown value');
  if (!oneOf(['fast', 'normal', 'slow'], caps.latency)) problems.push('caps.latency: unknown value');
  if (!(isCount(caps.contextTokens) && /** @type {number} */ (caps.contextTokens) > 0)) problems.push('caps.contextTokens: positive integer expected');
  if (!(isCount(caps.maxOutput) && /** @type {number} */ (caps.maxOutput) > 0)) problems.push('caps.maxOutput: positive integer expected');
  for (const key of /** @type {const} */ (['priceIn', 'priceOut'])) {
    if (caps[key] !== undefined && !(typeof caps[key] === 'number' && Number.isFinite(caps[key]) && /** @type {number} */ (caps[key]) >= 0)) {
      problems.push(`caps.${key}: non-negative number expected`);
    }
  }
  return problems;
}

/**
 * Problems of one stream event; empty when it is valid. Adapter tests run every event through it.
 * @param {unknown} event
 * @returns {string[]}
 */
export function validateEvent(event) {
  if (!isRecord(event)) return ['event: not an object'];
  /** @type {string[]} */
  const problems = [];
  const need = (/** @type {boolean} */ ok, /** @type {string} */ what) => {
    if (!ok) problems.push(`${String(event.type)}: ${what}`);
  };
  const optionalCount = (/** @type {unknown} */ v) => v === undefined || isCount(v);
  switch (event.type) {
    case 'start':
      need(isProviderId(event.provider), 'provider expected');
      need(isNonEmpty(event.model, CONTRACT_LIMITS.modelChars), 'model expected');
      need(event.requestId === undefined || event.requestId === null || typeof event.requestId === 'string', 'requestId must be a string');
      break;
    case 'text':
      need(typeof event.delta === 'string', 'delta expected');
      break;
    case 'reasoning':
      need((typeof event.delta === 'string') !== isCount(event.tokens), 'either delta or tokens expected');
      break;
    case 'tool_call':
      need(isNonEmpty(event.id, CONTRACT_LIMITS.nameChars), 'id expected');
      need(typeof event.name === 'string' && TOOL_NAME_PATTERN.test(event.name), 'tool name expected');
      need(typeof event.final === 'boolean', 'final expected');
      need(event.argsDelta === undefined || typeof event.argsDelta === 'string', 'argsDelta must be a string');
      need(event.args === undefined || isRecord(event.args), 'args must be an object');
      break;
    case 'citation':
      need(typeof event.url === 'string' && /^https?:\/\//i.test(event.url), 'http(s) url expected');
      need(typeof event.title === 'string', 'title expected');
      need(event.citedText === undefined || typeof event.citedText === 'string', 'citedText must be a string');
      need(optionalCount(event.start) && optionalCount(event.end), 'offsets must be non-negative integers');
      need(!(isCount(event.start) && isCount(event.end)) || /** @type {number} */ (event.start) <= /** @type {number} */ (event.end), 'start after end');
      break;
    case 'image':
      need(typeof event.mime === 'string' && /^image\/[a-z0-9.+-]+$/i.test(event.mime), 'image mime expected');
      need(typeof event.data === 'string' && event.data.length > 0, 'data expected');
      break;
    case 'opaque':
      need(event.block !== undefined, 'block expected');
      break;
    case 'usage':
      for (const key of ['input', 'output', 'reasoning', 'cacheRead']) need(optionalCount(event[key]), `${key} must be a non-negative integer`);
      need(event.costUsd === undefined || (typeof event.costUsd === 'number' && event.costUsd >= 0), 'costUsd must be non-negative');
      break;
    case 'end':
      need(isStopReason(event.stopReason), 'known stopReason expected');
      need(event.error === undefined || (event.error instanceof Error && typeof (/** @type {{ code?: unknown }} */ (event.error).code) === 'string'), 'error must be an AiError');
      break;
    default:
      problems.push('event.type: unknown event type');
  }
  return problems;
}

/**
 * @param {string} text
 * @returns {TextPart}
 */
export function textPart(text) {
  return { type: 'text', text };
}

/**
 * The text parts of a message, joined.
 * @param {Message} message
 */
export function messageText(message) {
  return message.content
    .filter((p) => p.type === 'text')
    .map((p) => /** @type {TextPart} */ (p).text)
    .join('');
}

/**
 * The conversation without other providers' opaque parts; messages left empty are dropped.
 * Opaque parts of the same provider stay, even after a model switch: the provider itself drops
 * blocks the new model cannot read.
 * @param {Message[]} messages
 * @param {ProviderId} provider
 * @returns {Message[]}
 */
export function withoutForeignOpaque(messages, provider) {
  /** @type {Message[]} */
  const out = [];
  for (const m of messages) {
    const content = m.content.filter((p) => p.type !== 'opaque' || p.provider === provider);
    if (content.length === m.content.length) out.push(m);
    else if (content.length) out.push({ ...m, content });
  }
  return out;
}
