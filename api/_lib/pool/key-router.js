// @ts-check
// Key pool of a site-held provider: each request starts at the next key (round robin) and fails
// over to the following keys until one delivers the first byte of a stream, within the failover
// budget. After that byte the response is committed and there is no failover. Keys that fail are
// parked for a while: 429 for its Retry-After, 401/403 for half an hour, timeouts, network errors
// and 408/5xx briefly. Each key also has a token bucket (`keyRpm` requests a minute), so the pool
// spreads load before a provider starts answering 429. Upstream bodies are never read or echoed,
// and log lines name a key by its index only.
//
// The upstream URL and the auth header are parameters, so one router serves every pool: NVIDIA
// (Bearer), Groq and OpenRouter (Bearer), Gemini (x-goog-api-key, the URL names the model).
import { NVIDIA_PROXY } from '../../../src/js/models/nvidia-catalog.js';

/**
 * @typedef {import('../../../src/js/models/nvidia-catalog.js').NvidiaProxyTiming} PoolTiming
 * @typedef {{ ok: true, first: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>, abort: () => void, attempts: number }} OpenOk
 * @typedef {{ ok: false, status: number, error: string, retryAfterS?: number }} OpenFail
 * @typedef {{ signal?: AbortSignal, deadline: number, url?: string }} OpenOptions `url` replaces the router's upstream URL for this request
 * @typedef {{ size: number, open: (body: Record<string, unknown>, options: OpenOptions) => Promise<OpenOk | OpenFail>, coolingUntil: () => number[] }} KeyRouter
 * @typedef {(key: string) => [string, string]} AuthHeader
 * @typedef {{ kind: 'commit', first: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>, abort: () => void }
 *   | { kind: 'retry', cooldownMs: number, reason: string, timeout: boolean }
 *   | { kind: 'fatal', error: string, status: number }
 *   | { kind: 'closed' }} Outcome
 */

/** Longest Retry-After the router sends when every key cools down. */
export const RETRY_AFTER_MAX_S = 300;
// The only HTTP-date format senders may generate (RFC 9110, IMF-fixdate).
const IMF_FIXDATE = /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
/** @type {OpenFail} */
const CLIENT_CLOSED = Object.freeze({ ok: false, status: 499, error: 'client_closed' });
const MINUTE_MS = 60_000;

/** Bearer auth, the style of every OpenAI-compatible pool. */
export const bearerAuth = (/** @type {string} */ key) => /** @type {[string, string]} */ (['Authorization', `Bearer ${key}`]);

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Retry-After as delta-seconds or as an IMF-fixdate.
 * @param {string | null} value
 * @param {number} nowMs
 * @returns {number | null} milliseconds from now, or null when absent or malformed
 */
export function parseRetryAfter(value, nowMs) {
  const text = (value ?? '').trim();
  if (/^[0-9]+$/.test(text)) return Number(text) * 1000;
  const at = IMF_FIXDATE.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * `reader.read()`, or null as soon as `signal` aborts (the caller then cancels the reader).
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {AbortSignal} signal
 * @returns {Promise<ReadableStreamReadResult<Uint8Array> | null>}
 */
function readOrAbort(reader, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve(null);
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * The first non-empty chunk, or null when the stream ends, fails or `signal` aborts before it.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {AbortSignal} signal
 * @returns {Promise<Uint8Array | null>}
 */
async function firstChunk(reader, signal) {
  try {
    for (;;) {
      const chunk = await readOrAbort(reader, signal);
      if (!chunk || chunk.done) return null;
      if (chunk.value.byteLength > 0) return chunk.value;
    }
  } catch {
    // A read error before the first byte counts like a network error.
    return null;
  }
}

/** @param {Response} res */
const isEventStream = (res) => (res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream');

/**
 * @param {object} options
 * @param {readonly string[]} options.keys
 * @param {typeof fetch} options.fetch
 * @param {string} options.upstreamUrl the streaming endpoint (a request may name another, see OpenOptions)
 * @param {AuthHeader} [options.authHeader] the header that carries a key (default Bearer)
 * @param {string} [options.label] names the pool in log lines
 * @param {number} [options.keyRpm] requests per key and minute (token bucket); Infinity for none
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 * @param {PoolTiming} [options.timing]
 * @returns {KeyRouter}
 */
export function createKeyRouter({ keys, fetch: send, upstreamUrl, authHeader = bearerAuth, label = 'pool', keyRpm = Number.POSITIVE_INFINITY, now = () => Date.now(), log = (line) => console.warn(line), timing = NVIDIA_PROXY }) {
  if (keys.length === 0) throw new Error('createKeyRouter needs at least one key');
  const size = keys.length;
  const cooldownUntil = keys.map(() => 0);
  const bucketed = Number.isFinite(keyRpm) && keyRpm > 0;
  const tokens = keys.map(() => (bucketed ? keyRpm : 0));
  const refilledAt = keys.map(() => now());
  let cursor = 0;

  /**
   * Milliseconds until the key's bucket holds a token again (0 when it does now).
   * @param {number} index
   * @param {number} at
   */
  function bucketWait(index, at) {
    if (!bucketed) return 0;
    tokens[index] = Math.min(keyRpm, tokens[index] + ((at - refilledAt[index]) * keyRpm) / MINUTE_MS);
    refilledAt[index] = at;
    return tokens[index] >= 1 ? 0 : ((1 - tokens[index]) * MINUTE_MS) / keyRpm;
  }

  /** @param {number} index */
  const usable = (index) => cooldownUntil[index] <= now() && bucketWait(index, now()) === 0;

  /**
   * @param {number} index
   * @param {number} ms
   * @param {string} reason
   */
  function cool(index, ms, reason) {
    cooldownUntil[index] = Math.max(cooldownUntil[index], now() + ms);
    log(`${label}: key ${index + 1}/${size} ${reason}, cooling ${Math.ceil(ms / 1000)} s`);
  }

  /** @returns {OpenFail} */
  function exhausted() {
    const at = now();
    const wait = Math.min(...keys.map((_, i) => Math.max(cooldownUntil[i] - at, bucketWait(i, at))));
    return { ok: false, status: 503, error: 'all_keys_exhausted', retryAfterS: clamp(Math.ceil(wait / 1000), 1, RETRY_AFTER_MAX_S) };
  }

  /**
   * One upstream request with one key, until its first byte or `timeoutMs`.
   * @param {number} index
   * @param {string} url
   * @param {string} payload
   * @param {AbortSignal | undefined} signal the client's request signal
   * @param {number} timeoutMs
   * @returns {Promise<Outcome>}
   */
  async function attempt(index, url, payload, signal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onClientAbort = () => controller.abort();
    signal?.addEventListener('abort', onClientAbort, { once: true });
    // Ends everything this attempt holds; after a commit the relay calls it when the stream ends.
    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onClientAbort);
      controller.abort();
    };
    const transient = timing.cooldownMs.transient;
    const [authName, authValue] = authHeader(keys[index]);

    /** @type {Response} */
    let res;
    try {
      res = await send(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { [authName]: authValue, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: payload,
      });
    } catch {
      release();
      if (signal?.aborted) return { kind: 'closed' };
      return { kind: 'retry', cooldownMs: transient, reason: timedOut ? 'timed out' : 'network error', timeout: timedOut };
    }

    if (res.status === 200 && isEventStream(res)) {
      const reader = res.body?.getReader();
      const first = reader ? await firstChunk(reader, controller.signal) : null;
      if (reader && first) {
        clearTimeout(timer);
        return { kind: 'commit', first, reader, abort: release };
      }
      reader?.cancel().catch(() => {});
      release();
      if (signal?.aborted) return { kind: 'closed' };
      return { kind: 'retry', cooldownMs: transient, reason: timedOut ? 'no first byte in time' : 'empty stream', timeout: timedOut };
    }

    // Any other answer: cancel the body unread.
    res.body?.cancel().catch(() => {});
    release();
    const { status } = res;
    if (status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now()) ?? timing.cooldownMs.rateLimitedDefault;
      return { kind: 'retry', cooldownMs: clamp(retryAfter, timing.cooldownMs.rateLimitedMin, timing.cooldownMs.rateLimitedMax), reason: 'rate limited (429)', timeout: false };
    }
    if (status === 401 || status === 403) return { kind: 'retry', cooldownMs: timing.cooldownMs.auth, reason: `rejected (${status})`, timeout: false };
    if (status === 408 || status >= 500) return { kind: 'retry', cooldownMs: transient, reason: `failed (${status})`, timeout: false };
    return { kind: 'fatal', error: status === 404 ? 'model_unavailable' : 'upstream_rejected', status };
  }

  return {
    size,
    coolingUntil: () => [...cooldownUntil],
    async open(body, { signal, deadline, url = upstreamUrl }) {
      const start = cursor;
      cursor = (cursor + 1) % size;
      const order = keys.map((_, i) => (start + i) % size).filter(usable);
      // Every key cools down or has used its share: answer at once, without an upstream request.
      if (order.length === 0) return exhausted();

      const payload = JSON.stringify(body);
      let attempts = 0;
      let timeouts = 0;
      let outOfTime = false;
      for (const index of order) {
        if (signal?.aborted) return CLIENT_CLOSED;
        // A concurrent request on this instance may have parked the key or used its tokens meanwhile.
        if (!usable(index)) continue;
        const budget = deadline - now();
        if (budget <= 0) {
          outOfTime = true;
          break;
        }
        attempts++;
        if (bucketed) tokens[index] -= 1;
        // The last attempt may get less than its full time; a timeout then says nothing about the key.
        const shortened = budget < timing.attemptTimeoutMs;
        const outcome = await attempt(index, url, payload, signal, Math.min(timing.attemptTimeoutMs, budget));
        if (outcome.kind === 'commit') return { ok: true, first: outcome.first, reader: outcome.reader, abort: outcome.abort, attempts };
        if (outcome.kind === 'closed') return CLIENT_CLOSED;
        if (outcome.kind === 'fatal') {
          log(`${label}: key ${index + 1}/${size} got ${outcome.status}, not retried`);
          return { ok: false, status: 502, error: outcome.error };
        }
        if (outcome.timeout) timeouts++;
        if (!(outcome.timeout && shortened)) cool(index, outcome.cooldownMs, outcome.reason);
      }
      if (timeouts === attempts && (attempts > 0 || outOfTime)) return { ok: false, status: 504, error: 'upstream_timeout' };
      return exhausted();
    },
  };
}
