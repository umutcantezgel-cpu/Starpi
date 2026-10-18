// @ts-check
// The site's keys for the speech routes, and one call to a speech service with them.
//
// A key ring hands out the site's keys in turn (round robin). A key that fails is parked: after a
// 429 for its Retry-After (or the retry delay Gemini puts in the body), after 401/403 for half an
// hour, after a timeout, a network error or a 5xx for a few seconds. A call fails over to the next
// key until one answers or every key is parked; a 400 is the request's fault and ends the call.
// Answers are read with a byte cap. Keys travel in their header only, never in a URL, and no log
// line ever names one (or carries any text or audio).
//
// geminiCall() posts a JSON body to the Gemini API and returns the JSON answer.

/**
 * @typedef {{ ok: true, json: any } | { ok: false, status: number, error: string, retryAfterS?: number }} CallResult
 * @typedef {{ ok: true, bytes: Uint8Array, type: string } | { ok: false, status: number, error: string, retryAfterS?: number }} BytesResult
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike
 */

/** How long a key rests after each kind of failure. */
export const PARK_MS = Object.freeze({ auth: 30 * 60_000, rateLimited: 30_000, transient: 8_000, maxRetryAfter: 300_000 });
/** One upstream call may take this long. */
export const CALL_TIMEOUT_MS = 40_000;
/** Largest answer read (speech for 600 characters is far below). */
export const MAX_ANSWER_BYTES = 12 * 1024 * 1024;

/**
 * @typedef {object} KeyRing
 * @property {number} size
 * @property {() => { key: string, index: number } | null} next  the next key that is not parked
 * @property {(index: number, ms: number) => void} park
 * @property {() => number} retryAfterS   seconds until the first parked key is free again
 */

/**
 * @param {readonly string[]} keys
 * @param {() => number} now
 * @returns {KeyRing}
 */
export function createKeyRing(keys, now) {
  const parkedUntil = keys.map(() => 0);
  let cursor = 0;
  return {
    size: keys.length,
    next() {
      const at = now();
      for (let i = 0; i < keys.length; i += 1) {
        const index = (cursor + i) % keys.length;
        if (parkedUntil[index] <= at) {
          cursor = (index + 1) % keys.length;
          return { key: keys[index], index };
        }
      }
      return null;
    },
    park(index, ms) {
      if (index >= 0 && index < parkedUntil.length) parkedUntil[index] = Math.max(parkedUntil[index], now() + ms);
    },
    retryAfterS() {
      const at = now();
      const soonest = Math.min(...parkedUntil.map((t) => (t > at ? t : Infinity)));
      return Number.isFinite(soonest) ? Math.max(1, Math.ceil((soonest - at) / 1000)) : 1;
    },
  };
}

/**
 * Seconds to wait from a 429: Retry-After, else the RetryInfo delay of a Gemini error body.
 * @param {Response} res
 * @param {string} bodyText at most a few KB of the body
 * @returns {number | null}
 */
export function retryAfterOf(res, bodyText) {
  const header = Number((res.headers.get('retry-after') ?? '').trim());
  if (Number.isFinite(header) && header > 0) return header;
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText);
  return m ? Math.ceil(Number(m[1])) : null;
}

/**
 * The body of a response, or null once it exceeds `max` bytes (reading stops).
 * @param {Response} res
 * @param {number} max
 * @returns {Promise<Uint8Array | null>}
 */
export async function readCapped(res, max) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * @typedef {object} UpstreamRequest
 * @property {string} url          the full upstream URL (no key in it)
 * @property {'GET' | 'POST'} method
 * @property {Record<string, string>} headers  without the key
 * @property {string} [body]
 */

/**
 * Sends one request with each key in turn until one answers.
 * @param {{ ring: KeyRing, authHeader: string, fetch: FetchLike, request: UpstreamRequest, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number }} options
 * @returns {Promise<BytesResult>}
 */
export async function sendWithRing({ ring, authHeader, fetch: send, request, signal, timeoutMs = CALL_TIMEOUT_MS, maxBytes = MAX_ANSWER_BYTES }) {
  if (ring.size === 0) return { ok: false, status: 503, error: 'voice_not_configured' };
  for (let attempt = 0; attempt < ring.size; attempt += 1) {
    const picked = ring.next();
    if (!picked) break;
    const result = await sendOnce({ key: picked.key, authHeader, fetch: send, request, signal, timeoutMs, maxBytes });
    if (result.ok) return result;
    if (signal?.aborted) return { ok: false, status: 499, error: 'client_closed' };
    if (result.park === null) return { ok: false, status: result.status, error: result.error };
    ring.park(picked.index, result.park);
  }
  return { ok: false, status: 503, error: 'voice_busy', retryAfterS: ring.retryAfterS() };
}

/**
 * One request with one key. `park` says how long the key should rest (null: the request, not the
 * key, is the problem, so no other key would do better).
 * @param {{ key: string, authHeader: string, fetch: FetchLike, request: UpstreamRequest, signal?: AbortSignal, timeoutMs: number, maxBytes: number }} options
 * @returns {Promise<{ ok: true, bytes: Uint8Array, type: string } | { ok: false, status: number, error: string, park: number | null }>}
 */
export async function sendOnce({ key, authHeader, fetch: send, request, signal, timeoutMs, maxBytes }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await send(request.url, { method: request.method, headers: { ...request.headers, [authHeader]: key }, body: request.body, redirect: 'error', signal: combined });
  } catch {
    return { ok: false, status: timeout.aborted ? 504 : 502, error: timeout.aborted ? 'upstream_timeout' : 'upstream_unreachable', park: PARK_MS.transient };
  }
  if (res.ok) {
    const bytes = await readCapped(res, maxBytes).catch(() => null);
    if (!bytes) return { ok: false, status: 502, error: 'upstream_too_large', park: null };
    return { ok: true, bytes, type: res.headers.get('content-type') ?? '' };
  }
  const snippet = new TextDecoder().decode((await readCapped(res, 4096).catch(() => null)) ?? new Uint8Array(0));
  if (res.status === 429) {
    const wait = retryAfterOf(res, snippet);
    return { ok: false, status: 429, error: 'upstream_rate_limited', park: Math.min(PARK_MS.maxRetryAfter, (wait ?? PARK_MS.rateLimited / 1000) * 1000) };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: 502, error: 'upstream_auth', park: PARK_MS.auth };
  if (res.status >= 500 || res.status === 408) return { ok: false, status: 502, error: 'upstream_error', park: PARK_MS.transient };
  return { ok: false, status: res.status === 404 ? 502 : 400, error: res.status === 404 ? 'upstream_not_found' : 'upstream_refused', park: null };
}

/**
 * POSTs a JSON body to the Gemini API (`root` + `path`) with the site's keys.
 * @param {{ ring: KeyRing, root: string, path: string, body: unknown, fetch: FetchLike, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<CallResult>}
 */
export async function geminiCall({ ring, root, path, body, fetch: send, signal, timeoutMs }) {
  const result = await sendWithRing({
    ring,
    authHeader: 'x-goog-api-key',
    fetch: send,
    request: { url: `${root}${path}`, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) },
    signal,
    timeoutMs,
  });
  if (!result.ok) return result;
  try {
    return { ok: true, json: JSON.parse(new TextDecoder().decode(result.bytes)) };
  } catch {
    return { ok: false, status: 502, error: 'upstream_bad_response' };
  }
}
