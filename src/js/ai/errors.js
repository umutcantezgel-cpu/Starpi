// @ts-check
// One error type for every AI provider. A failure is reduced to a short code the UI maps to its own
// text (i18n key `ai.error.<code>`); provider error text is never kept, shown or logged, because it
// can quote request details. At most a provider's own error identifier survives, and only when it
// is a short snake_case word.

/**
 * auth: key missing, invalid or not allowed; quota: credits or plan exhausted; rate_limited: too
 * many requests for now; not_found: unknown model or path; bad_request: the provider rejected the
 * request shape; context_length: the conversation is too long for the model; server: provider
 * failure; timeout: deadline or idle limit; network: no answer at all; aborted: the caller stopped;
 * bad_response: an answer that cannot be read; cors: a direct browser call was blocked before any
 * answer; stream_cut: the stream ended before its last event; refusal: the provider declined.
 * @typedef {'auth' | 'quota' | 'rate_limited' | 'not_found' | 'bad_request' | 'context_length' | 'server' | 'timeout' | 'network' | 'aborted' | 'bad_response' | 'cors' | 'stream_cut' | 'refusal'} AiErrorCode
 */

/** @typedef {Headers | Record<string, string | string[] | undefined> | null | undefined} HeaderSource */

export const AI_ERROR_CODES = /** @type {readonly AiErrorCode[]} */ (
  Object.freeze(['auth', 'quota', 'rate_limited', 'not_found', 'bad_request', 'context_length', 'server', 'timeout', 'network', 'aborted', 'bad_response', 'cors', 'stream_cut', 'refusal'])
);

/** i18n namespace of the error texts (src/locales/ai/<lang>.json, key `error.<code>`). */
export const AI_ERROR_NAMESPACE = 'ai';

/**
 * The i18n key for every code, for views that map codes to text.
 * @type {Readonly<Record<AiErrorCode, string>>}
 */
export const AI_ERROR_KEYS = Object.freeze(
  /** @type {Record<AiErrorCode, string>} */ (Object.fromEntries(AI_ERROR_CODES.map((code) => [code, `${AI_ERROR_NAMESPACE}.error.${code}`]))),
);

/** i18n key of the "try again in {seconds} s" hint for errors with a retryAfterMs. */
export const AI_RETRY_KEY = `${AI_ERROR_NAMESPACE}.retry_in`;

/** Codes worth another attempt (later, or on another model or key). */
const RETRYABLE = new Set(['rate_limited', 'server', 'timeout', 'network', 'stream_cut']);

/** Longest wait a Retry-After may ask for; longer values are clamped. */
export const MAX_RETRY_AFTER_MS = 10 * 60_000;
/** How much of an error body the classifier reads. */
export const MAX_ERROR_SNIPPET_CHARS = 2048;

/** A provider error identifier that is safe to keep. */
const SAFE_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * @param {unknown} value
 * @returns {value is AiErrorCode}
 */
export function isAiErrorCode(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (AI_ERROR_CODES).includes(value);
}

export class AiError extends Error {
  /**
   * @param {AiErrorCode} code
   * @param {{ status?: number, retryAfterMs?: number | null, provider?: string | null, providerCode?: string | null, cause?: unknown }} [info]
   *   `providerCode` is kept only when it is a short snake_case identifier
   */
  constructor(code, info = {}) {
    if (!isAiErrorCode(code)) throw new TypeError(`Unknown AI error code: ${String(code).slice(0, 40)}`);
    const status = Number.isInteger(info.status) && /** @type {number} */ (info.status) > 0 ? /** @type {number} */ (info.status) : 0;
    super(status ? `${code} (HTTP ${status})` : code, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'AiError';
    /** @type {AiErrorCode} */
    this.code = code;
    this.status = status;
    /** @type {number | null} */
    this.retryAfterMs = typeof info.retryAfterMs === 'number' && Number.isFinite(info.retryAfterMs) ? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.round(info.retryAfterMs))) : null;
    /** @type {string | null} */
    this.provider = typeof info.provider === 'string' ? info.provider : null;
    /** @type {string | null} */
    this.providerCode = safeCode(info.providerCode);
  }

  /** The i18n key of this error's text. */
  get messageKey() {
    return AI_ERROR_KEYS[this.code];
  }

  get retryable() {
    return isRetryable(this.code);
  }
}

/**
 * @param {AiErrorCode} code
 */
export function errorMessageKey(code) {
  return AI_ERROR_KEYS[code];
}

/**
 * @param {string} code
 */
export function isRetryable(code) {
  return RETRYABLE.has(code);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function safeCode(value) {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return SAFE_CODE.test(lower) ? lower : null;
}

/**
 * @param {HeaderSource} headers
 * @param {string} name lower case
 * @returns {string | null}
 */
function header(headers, name) {
  if (!headers) return null;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name);
  const record = /** @type {Record<string, string | string[] | undefined>} */ (headers);
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }
  return null;
}

/**
 * A wait in milliseconds from `retry-after-ms`, or from `retry-after` as delta seconds or an HTTP
 * date; null when absent or unreadable. Clamped to MAX_RETRY_AFTER_MS.
 * @param {HeaderSource} headers
 * @param {number} [now] epoch ms, for HTTP dates
 * @returns {number | null}
 */
export function parseRetryAfter(headers, now = Date.now()) {
  const ms = (header(headers, 'retry-after-ms') ?? '').trim();
  if (/^\d+(?:\.\d+)?$/.test(ms)) return Math.min(MAX_RETRY_AFTER_MS, Math.round(Number(ms)));
  const value = (header(headers, 'retry-after') ?? '').trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.min(MAX_RETRY_AFTER_MS, Math.round(Number(value) * 1000));
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
}

/**
 * A wait some providers put in the error body instead of a header: a `retryDelay` such as "7s" or
 * "1.5s" (structured retry info). Null when there is none.
 * @param {string} snippet
 * @returns {number | null}
 */
export function retryDelayFromBody(snippet) {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(snippet);
  return match ? Math.min(MAX_RETRY_AFTER_MS, Math.round(Number(match[1]) * 1000)) : null;
}

/**
 * Short identifiers a provider error body carries (`error.type`, `error.code`, `error.status`, a
 * string `error`, a top-level `code`), lower-cased; anything that is not an identifier is skipped.
 * @param {unknown} body
 * @returns {string[]}
 */
function codesOf(body) {
  /** @type {string[]} */
  const out = [];
  const add = (/** @type {unknown} */ v) => {
    const code = safeCode(v);
    if (code && !out.includes(code)) out.push(code);
  };
  if (!body || typeof body !== 'object') return out;
  const record = /** @type {Record<string, unknown>} */ (body);
  const err = record.error;
  if (err && typeof err === 'object') {
    const e = /** @type {Record<string, unknown>} */ (err);
    add(e.type);
    add(e.code);
    add(e.status);
  } else add(err);
  add(record.code);
  add(record.type === 'error' ? undefined : record.type);
  return out;
}

const QUOTA_CODES = new Set(['insufficient_quota', 'billing_error', 'billing_hard_limit_reached', 'payment_required', 'insufficient_credits', 'credit_limit_exceeded', 'quota_exceeded']);
const CONTEXT_CODES = new Set(['context_length_exceeded', 'context_window_exceeded', 'string_above_max_length', 'request_too_large_for_model']);
const AUTH_CODES = new Set(['authentication_error', 'permission_error', 'invalid_api_key', 'api_key_invalid', 'unauthenticated', 'permission_denied', 'unauthorized', 'forbidden']);
const NOT_FOUND_CODES = new Set(['not_found_error', 'model_not_found', 'not_found']);
const CONTEXT_TEXT = /context[ _-]?(?:length|window)|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (?:model'?s? )?(?:maximum|context)|token limit/i;
const AUTH_TEXT = /api[ _-]?key[ _-]?(?:not[ _-]?)?(?:invalid|valid)|invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key/i;

/**
 * Classifies an HTTP error answer. The status decides; codes and phrases in the first bytes of the
 * body refine it (quota versus rate limit, context length versus other bad requests, a key the
 * provider reports as invalid with 400). Bodies shaped `{ error, upstreamStatus }` (Starpi's relay)
 * are classified by the upstream status. Nothing of the body is kept except a safe identifier.
 * @param {number} status
 * @param {HeaderSource} headers
 * @param {string | object | null | undefined} [bodySnippet]
 * @param {{ provider?: string | null, now?: number }} [options]
 * @returns {AiError}
 */
export function fromHttp(status, headers, bodySnippet, options = {}) {
  const snippet = (typeof bodySnippet === 'string' ? bodySnippet : bodySnippet ? safeStringify(bodySnippet) : '').slice(0, MAX_ERROR_SNIPPET_CHARS);
  /** @type {unknown} */
  let body = typeof bodySnippet === 'object' ? bodySnippet : null;
  if (body === null && snippet) {
    try {
      body = JSON.parse(snippet);
    } catch {
      body = null;
    }
  }
  const record = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : null;
  const upstream = record && typeof record.upstreamStatus === 'number' ? record.upstreamStatus : null;
  const effective = upstream && upstream >= 400 && upstream <= 599 ? upstream : status;
  const codes = codesOf(body);
  const has = (/** @type {Set<string>} */ set) => codes.some((c) => set.has(c));
  const retryAfterMs = parseRetryAfter(headers, options.now) ?? retryDelayFromBody(snippet);
  const info = { status: effective, provider: options.provider ?? null, providerCode: codes[0] ?? null };

  /** @type {AiErrorCode} */
  let code;
  if (effective === 401 || effective === 403) code = 'auth';
  else if (effective === 402) code = 'quota';
  else if (effective === 429) code = has(QUOTA_CODES) ? 'quota' : 'rate_limited';
  else if (effective === 404 || effective === 410) code = 'not_found';
  else if (effective === 408 || effective === 504) code = 'timeout';
  else if (effective === 400 || effective === 413 || effective === 422) {
    if (has(CONTEXT_CODES) || CONTEXT_TEXT.test(snippet)) code = 'context_length';
    else if (has(AUTH_CODES) || AUTH_TEXT.test(snippet)) code = 'auth';
    else if (has(QUOTA_CODES)) code = 'quota';
    else code = 'bad_request';
  } else if (effective >= 500 && effective <= 599) code = 'server';
  else if (effective >= 400 && effective <= 499) code = has(NOT_FOUND_CODES) ? 'not_found' : 'bad_request';
  else code = 'bad_response';

  return new AiError(code, { ...info, retryAfterMs: code === 'rate_limited' || code === 'server' || code === 'quota' ? retryAfterMs : null });
}

/**
 * @param {object} value
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Maps something thrown by fetch, a body read or an SDK to an AiError. `responded` tells whether
 * an HTTP answer had already arrived: a network failure after it is a cut stream, before it a
 * blocked direct call (`cors`) or no connection (`network`), depending on `beforeResponse`.
 * @param {unknown} err
 * @param {{ provider?: string | null, signal?: AbortSignal | null, responded?: boolean, beforeResponse?: 'cors' | 'network' }} [options]
 * @returns {AiError}
 */
export function toAiError(err, options = {}) {
  const provider = options.provider ?? null;
  if (err instanceof AiError) return err;
  const cause = /** @type {{ cause?: unknown }} */ (err && typeof err === 'object' ? err : {}).cause;
  if (cause instanceof AiError) return cause;
  if (options.signal?.aborted) {
    const reason = options.signal.reason;
    if (reason instanceof AiError) return reason;
    const name = reason && typeof reason === 'object' ? /** @type {{ name?: unknown }} */ (reason).name : '';
    return new AiError(name === 'TimeoutError' ? 'timeout' : 'aborted', { provider, cause: err });
  }
  const name = err && typeof err === 'object' ? /** @type {{ name?: unknown }} */ (err).name : '';
  if (name === 'TimeoutError') return new AiError('timeout', { provider, cause: err });
  if (name === 'AbortError') return new AiError('aborted', { provider, cause: err });
  // SDK errors carry the HTTP status (and often the headers) of the failed answer.
  const status = err && typeof err === 'object' ? /** @type {{ status?: unknown }} */ (err).status : undefined;
  if (typeof status === 'number' && status >= 400 && status <= 599) {
    const e = /** @type {{ headers?: HeaderSource, error?: unknown }} */ (err);
    return fromHttp(status, e.headers, e.error && typeof e.error === 'object' ? /** @type {object} */ (e.error) : null, { provider });
  }
  if (options.responded) return new AiError('stream_cut', { provider, cause: err });
  if (err instanceof TypeError) return new AiError(options.beforeResponse ?? 'network', { provider, cause: err });
  return new AiError('network', { provider, cause: err });
}
