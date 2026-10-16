// @ts-check
// Small helpers the provider adapters share: record checks and tolerant JSON, base64 text, the
// UTF-8 to UTF-16 offset conversion for providers that count bytes, a streaming splitter for
// reasoning written as <think> tags, a tool call tracker, usage events, and the mapping of error
// identifiers that arrive inside an event stream onto AiError codes. No DOM and no I/O.
import { AiError } from '../errors.js';

/** @typedef {import('../contract.js').AiEvent} AiEvent */
/** @typedef {import('../contract.js').AiRequest} AiRequest */
/** @typedef {import('../contract.js').Effort} Effort */
/** @typedef {import('../contract.js').Message} Message */
/** @typedef {import('../contract.js').ProviderId} ProviderId */
/** @typedef {import('../contract.js').UsageEvent} UsageEvent */
/** @typedef {import('../errors.js').AiErrorCode} AiErrorCode */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parsed JSON, or undefined when the text is not JSON.
 * @param {string} text
 * @returns {unknown}
 */
export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The argument object of a tool call from its JSON text; an empty text is an empty object and
 * anything that is not a JSON object is undefined (the caller keeps the raw text).
 * @param {string} text
 * @returns {Record<string, unknown> | undefined}
 */
export function argsObject(text) {
  if (!text.trim()) return {};
  const value = safeJson(text);
  return isRecord(value) ? value : undefined;
}

/**
 * Text of base64 data (UTF-8), for text files sent to providers that take text inline.
 * @param {string} data
 */
export function base64Text(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * @param {string} mime
 * @param {string} data base64
 */
export function dataUrl(mime, data) {
  return `data:${mime};base64,${data}`;
}

/**
 * A text file as one block of text that names the file, for providers without document input.
 * @param {string} name
 * @param {string} data base64
 */
export function fileAsText(name, data) {
  return `${name}\n\n${base64Text(data)}`;
}

/**
 * The UTF-16 offset of a UTF-8 byte offset into `text` (some providers count bytes). Offsets in the
 * middle of a character round down to its start; offsets past the end clamp to the length.
 * @param {string} text
 * @param {number} byteOffset
 */
export function utf16Offset(text, byteOffset) {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > byteOffset) return i;
    bytes += size;
    i += code >= 0x10000 ? 2 : 1;
  }
  return text.length;
}

/**
 * The name of the tool a call id belongs to, from the assistant turns of a conversation.
 * @param {Message[]} messages
 * @param {string} id
 */
export function toolNameFor(messages, id) {
  for (const m of messages) {
    for (const p of m.content) if (p.type === 'tool_call' && p.id === id) return p.name;
  }
  return null;
}

/**
 * The effort of a request's thinking options, or the fallback.
 * @param {AiRequest} req
 * @param {Effort} [fallback]
 * @returns {Effort | undefined}
 */
export function effortOf(req, fallback) {
  return req.thinking?.effort ?? fallback;
}

/**
 * A usage event from counts; values that are not non-negative integers are left out. Null when no
 * count is known.
 * @param {{ input?: unknown, output?: unknown, reasoning?: unknown, cacheRead?: unknown }} counts
 * @returns {UsageEvent | null}
 */
export function usageEvent(counts) {
  /** @type {UsageEvent} */
  const ev = { type: 'usage' };
  let any = false;
  for (const key of /** @type {const} */ (['input', 'output', 'reasoning', 'cacheRead'])) {
    const value = counts[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      ev[key] = value;
      any = true;
    }
  }
  return any ? ev : null;
}

/** Provider error identifiers that arrive inside a stream (an error event, a failed response). */
const STREAM_ERROR_CODES = /** @type {Readonly<Record<string, AiErrorCode>>} */ ({
  rate_limit: 'rate_limited',
  rate_limit_error: 'rate_limited',
  rate_limit_exceeded: 'rate_limited',
  resource_exhausted: 'rate_limited',
  too_many_requests: 'rate_limited',
  overloaded: 'server',
  overloaded_error: 'server',
  server_error: 'server',
  api_error: 'server',
  internal: 'server',
  internal_error: 'server',
  unavailable: 'server',
  service_unavailable: 'server',
  invalid_request_error: 'bad_request',
  invalid_request: 'bad_request',
  invalid_prompt: 'bad_request',
  invalid_argument: 'bad_request',
  bad_request: 'bad_request',
  authentication_error: 'auth',
  permission_error: 'auth',
  invalid_api_key: 'auth',
  unauthenticated: 'auth',
  permission_denied: 'auth',
  not_found_error: 'not_found',
  model_not_found: 'not_found',
  not_found: 'not_found',
  billing_error: 'quota',
  insufficient_quota: 'quota',
  quota_exceeded: 'quota',
  context_length_exceeded: 'context_length',
  request_too_large: 'context_length',
  timeout: 'timeout',
  deadline_exceeded: 'timeout',
  content_filter: 'refusal',
  refusal: 'refusal',
});

/**
 * An AiError for an error identifier a provider sent inside its stream. Unknown identifiers count
 * as a provider failure (`server`), which the router may retry elsewhere.
 * @param {ProviderId} provider
 * @param {unknown} identifier
 * @param {AiErrorCode} [fallback]
 */
export function streamError(provider, identifier, fallback = 'server') {
  const id = typeof identifier === 'string' ? identifier.toLowerCase() : '';
  const code = Object.hasOwn(STREAM_ERROR_CODES, id) ? STREAM_ERROR_CODES[id] : fallback;
  return new AiError(code, { provider, providerCode: id || null });
}

/** Tags that wrap reasoning in the text of local and open models. */
const THINK_TAGS = Object.freeze(['think', 'thought', 'denkprozess']);
const OPEN_TAG = /<(think|thought|denkprozess)>/i;

/**
 * Length of the longest suffix of `text` that could be the start of one of `candidates`, so a tag
 * split over two deltas is held back until the next one decides it.
 * @param {string} text
 * @param {string[]} candidates lower case
 */
function partialTagLength(text, candidates) {
  const start = text.lastIndexOf('<');
  if (start === -1) return 0;
  const tail = text.slice(start).toLowerCase();
  return candidates.some((c) => c.startsWith(tail) && c !== tail) ? tail.length : 0;
}

/**
 * A streaming splitter for answers that carry their reasoning inside <think>, <thought> or
 * <denkprozess> tags. push() returns reasoning and text pieces in order; a tag split over deltas is
 * held back until it is complete. Line breaks right after a closing tag are dropped, as
 * splitReasoning() does for whole answers.
 */
export function createThinkSplitter() {
  let inside = /** @type {string | null} */ (null);
  let held = '';
  let trimNext = false;
  const opens = THINK_TAGS.map((t) => `<${t}>`);

  return {
    /**
     * @param {string} delta
     * @returns {Array<{ type: 'text' | 'reasoning', delta: string }>}
     */
    push(delta) {
      /** @type {Array<{ type: 'text' | 'reasoning', delta: string }>} */
      const out = [];
      let text = held + delta;
      held = '';
      while (text) {
        if (inside) {
          const close = `</${inside}>`;
          const at = text.toLowerCase().indexOf(close);
          if (at === -1) {
            const keep = partialTagLength(text, [close]);
            const piece = text.slice(0, text.length - keep);
            if (piece) out.push({ type: 'reasoning', delta: piece });
            held = text.slice(text.length - keep);
            return out;
          }
          if (at > 0) out.push({ type: 'reasoning', delta: text.slice(0, at) });
          text = text.slice(at + close.length);
          inside = null;
          trimNext = true;
          continue;
        }
        if (trimNext) {
          text = text.replace(/^\s+/, '');
          if (!text) return out;
          trimNext = false;
        }
        const match = OPEN_TAG.exec(text);
        if (match) {
          if (match.index > 0) out.push({ type: 'text', delta: text.slice(0, match.index) });
          inside = match[1].toLowerCase();
          text = text.slice(match.index + match[0].length);
          continue;
        }
        const keep = partialTagLength(text, opens);
        const piece = text.slice(0, text.length - keep);
        if (piece) out.push({ type: 'text', delta: piece });
        held = text.slice(text.length - keep);
        return out;
      }
      return out;
    },
    /** What is still held back, at the end of the stream. */
    flush() {
      const rest = held;
      held = '';
      if (!rest) return [];
      return [{ type: /** @type {'text' | 'reasoning'} */ (inside ? 'reasoning' : 'text'), delta: rest }];
    },
  };
}

/**
 * Collects streamed tool calls (by a provider index or id) and emits contract events: a first
 * event with id and name, argument pieces, and one final event with the parsed arguments.
 */
export function createToolCalls() {
  /** @type {Map<string | number, { id: string, name: string, args: string, final: boolean }>} */
  const calls = new Map();
  return {
    /**
     * Starts a call or adds to it. Returns the events for this piece.
     * @param {string | number} key
     * @param {{ id?: unknown, name?: unknown, argsDelta?: unknown }} piece
     * @param {() => string} makeId  id for providers that send none
     * @returns {AiEvent[]}
     */
    add(key, piece, makeId) {
      /** @type {AiEvent[]} */
      const out = [];
      let call = calls.get(key);
      if (!call) {
        if (typeof piece.name !== 'string' || !piece.name) return out;
        call = { id: typeof piece.id === 'string' && piece.id ? piece.id : makeId(), name: piece.name, args: '', final: false };
        calls.set(key, call);
        out.push({ type: 'tool_call', id: call.id, name: call.name, final: false });
      }
      if (typeof piece.argsDelta === 'string' && piece.argsDelta) {
        call.args += piece.argsDelta;
        out.push({ type: 'tool_call', id: call.id, name: call.name, argsDelta: piece.argsDelta, final: false });
      }
      return out;
    },
    /**
     * The final event of every open call.
     * @returns {AiEvent[]}
     */
    finish() {
      /** @type {AiEvent[]} */
      const out = [];
      for (const call of calls.values()) {
        if (call.final) continue;
        call.final = true;
        const args = argsObject(call.args);
        out.push(args ? { type: 'tool_call', id: call.id, name: call.name, args, final: true } : { type: 'tool_call', id: call.id, name: call.name, final: true });
      }
      return out;
    },
    get size() {
      return calls.size;
    },
    /** The calls in the order they started. */
    list() {
      return [...calls.values()].map(({ id, name, args }) => ({ id, name, args }));
    },
  };
}
