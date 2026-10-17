// Shared helpers of the relay and pool tests: requests from this site's pages, scripted upstream
// answers, a recording fetch and test keys. Keys are built at runtime, so no key-shaped literal
// exists in the repository.
import { createRateLimiter } from '../../api/_lib/guards.js';
import { createDailyLimiter } from '../../api/_lib/origins.js';

export const HOST = 'starpi.test';
export const SITE = `https://${HOST}`;
export const SAME_ORIGIN = Object.freeze({ origin: SITE, 'sec-fetch-site': 'same-origin' });
const encoder = new TextEncoder();

/**
 * A key of the given style that no provider would accept.
 * @param {'openai' | 'anthropic' | 'gemini' | 'nvidia' | 'groq' | 'plain'} kind
 * @param {number} [n]
 */
export function testKey(kind, n = 1) {
  const tail = `${'t'.repeat(30)}${n}`;
  switch (kind) {
    case 'openai':
      return ['sk', 'proj', tail].join('-');
    case 'anthropic':
      return ['sk', 'ant', 'api03', tail].join('-');
    case 'gemini':
      return `AIza${'T'.repeat(30)}${n}x`;
    case 'nvidia':
      return `nvapi-${'t'.repeat(63)}${n}`;
    case 'groq':
      return `gsk_${tail}`;
    default:
      return `plain${tail}`;
  }
}

/**
 * A request from a page of this site.
 * @param {string} path with query
 * @param {{ method?: string, headers?: Record<string, string | undefined>, body?: BodyInit | null, ip?: string, signal?: AbortSignal }} [options]
 */
export function siteRequest(path, { method = 'POST', headers = {}, body, ip = '203.0.113.7', signal } = {}) {
  const all = { host: HOST, 'x-real-ip': ip, ...SAME_ORIGIN, ...headers };
  const defined = /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)));
  return new Request(`${SITE}${path}`, { method, headers: defined, ...(body !== undefined && body !== null ? { body, duplex: 'half' } : {}), signal });
}

/**
 * A JSON POST from a page of this site.
 * @param {string} path
 * @param {unknown} data
 * @param {{ headers?: Record<string, string | undefined>, ip?: string, signal?: AbortSignal }} [options]
 */
export function jsonRequest(path, data, { headers = {}, ip, signal } = {}) {
  return siteRequest(path, { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data), ip, signal });
}

/**
 * A body stream that records whether it was cancelled.
 * @param {Array<string | Uint8Array>} chunks
 * @param {{ stall?: boolean, fail?: boolean }} [options]
 */
export function body(chunks, { stall = false, fail = false } = {}) {
  const state = { cancelled: false };
  const stream = new ReadableStream(
    {
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        if (!stall && !fail) controller.close();
      },
      pull(controller) {
        if (fail) controller.error(new Error('connection reset'));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

export const SSE_CHUNKS = Object.freeze(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n']);

/**
 * An answer factory with a fresh body per call; `state.cancelled` is true once every body was dropped.
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {Array<string | Uint8Array>} chunks
 * @param {{ stall?: boolean, fail?: boolean }} [options]
 */
export function answer(status, headers, chunks, options) {
  /** @type {Array<{ cancelled: boolean }>} */
  const bodies = [];
  const respond = () => {
    const made = body(chunks, options);
    bodies.push(made.state);
    return new Response(made.stream, { status, headers });
  };
  return Object.assign(respond, {
    state: {
      get cancelled() {
        return bodies.length > 0 && bodies.every((b) => b.cancelled);
      },
    },
  });
}

export const sse = (chunks = [...SSE_CHUNKS], options = {}) => answer(200, { 'content-type': 'text/event-stream' }, chunks, options);
export const jsonAnswer = (/** @type {number} */ status, /** @type {unknown} */ data, headers = {}) => answer(status, { 'content-type': 'application/json', ...headers }, [JSON.stringify(data)]);

/**
 * Fetch that plays the given answers in order (the last one repeats) and records each call with its
 * headers as a plain lower-cased object.
 * @param {...(init: RequestInit) => Response | Promise<Response>} answers
 */
export function recordingFetch(...answers) {
  /** @type {Array<{ url: string, init: RequestInit, headers: Record<string, string>, body: string }>} */
  const calls = [];
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    const headers = Object.fromEntries(Object.entries(/** @type {Record<string, string>} */ (init.headers ?? {})).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = init.body;
    const text = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw : new TextDecoder().decode(/** @type {Uint8Array} */ (raw));
    calls.push({ url, init, headers, body: text });
    return answers[Math.min(calls.length - 1, answers.length - 1)](init);
  };
  return Object.assign(fetch, { calls });
}

/** @param {ReadableStream<Uint8Array> | null} stream */
export async function readAll(stream) {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

/** @param {Response} res */
export async function errorOf(res) {
  return { status: res.status, ...(await res.json()) };
}

/**
 * Front guards for tests: a per-minute limit, a daily budget, origins and an access code.
 * @param {{ limit?: number, daily?: number, extraOrigins?: string[], accessCode?: string, now?: () => number }} [options]
 */
export function frontGuards({ limit = 100, daily = 0, extraOrigins = [], accessCode = '', now = () => Date.now() } = {}) {
  return {
    limiter: createRateLimiter({ limit, windowMs: 60_000, now }),
    daily: createDailyLimiter({ limit: daily, now }),
    extraOrigins,
    accessCode,
    now,
  };
}
