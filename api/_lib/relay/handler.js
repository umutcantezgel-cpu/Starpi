// @ts-check
// The stateless BYOK relay: /api/relay/<provider>/<path> forwards one request, with the user's own
// key, to an allowlisted provider path and streams the answer back. It keeps nothing: no key, no
// body and no header is stored or logged. The guards run in this order:
//
//   1. same-origin check (STARPI_ALLOWED_ORIGINS and its aliases)
//   2. per-IP limit (STARPI_RELAY_RPM_PER_IP, default 30 a minute)
//   3. access code, when the site sets STARPI_ACCESS_CODE
//   4. upstream allowlist: a known provider, an allowed method and path, a clean query
//   5. exactly one auth header, in the provider's own style; keys in the query are refused
//   6. body: at most 4 MB, JSON (an object) or, for transcription, multipart
//   7. forwarded headers: an allowlist (content-type, accept, anthropic-version, known betas, ...)
//
// Then the upstream fetch runs with redirect 'error'. A 200 event stream is relayed by relayStream
// (idle 90 s, hard deadline 3 s before the function's maxDuration, 16 MB); JSON and audio pass
// through capped. Any other status becomes `{ error, upstreamStatus }`: the relay reads at most
// 2 KB of the upstream body and keeps only an identifier matching ^[a-z_]{1,40}$.
//
// vercel.json rewrites /api/relay/:provider/:path* to api/relay.js; the function still sees the
// original URL and reads the provider and the path from it (scripts/serve.mjs does the same).
import { readAccessCode } from '../access.js';
import { positiveInt, readEnv } from '../env.js';
import { createRateLimiter, json, refuse } from '../guards.js';
import { relayStream } from '../nvidia-stream.js';
import { parseRetryAfter } from '../pool/key-router.js';
import { allowedOrigins, guardRequest } from '../origins.js';
import { scrubSecrets, hasKnownKey } from './scrub.js';
import { authHeaderFor, CREDENTIAL_HEADERS, findUpstream, KNOWN_ANTHROPIC_BETAS, matchUpstreamRoute, RELAY_PROVIDERS, resolveRoot } from './upstreams.js';

/**
 * @typedef {import('../guards.js').Refusal} Refusal
 * @typedef {import('./upstreams.js').Upstream} Upstream
 * @typedef {import('./upstreams.js').UpstreamRoute} UpstreamRoute
 * @typedef {(input: string, init: RequestInit) => Promise<Response>} FetchLike
 * @typedef {object} RelayDeps
 * @property {ReturnType<typeof createRateLimiter>} limiter
 * @property {readonly string[]} extraOrigins
 * @property {string} accessCode '' when the site has none
 * @property {Readonly<Record<string, string>>} roots API root per provider (fixed, or a loopback fake)
 * @property {FetchLike} fetch
 * @property {() => number} now
 */

export const RELAY_LIMITS = Object.freeze({
  /** Request bodies; Vercel accepts 4.5 MB, and the browser downscales images first. */
  maxBodyBytes: 4_000_000,
  /** Longest silence between two upstream chunks, the first one included. */
  idleMs: 90_000,
  /** Event streams. */
  maxStreamBytes: 16 * 1024 * 1024,
  /** JSON and audio answers. */
  maxPassthroughBytes: 16 * 1024 * 1024,
  /** What the relay reads of an upstream error answer. */
  maxErrorBytes: 2048,
  /** Length of the forwarded query string. */
  maxQueryChars: 2048,
  /** Requests per client IP and minute (STARPI_RELAY_RPM_PER_IP). */
  rateLimitPerMinute: 30,
});

/** vercel.json `functions["api/relay.js"].maxDuration` in milliseconds (a unit test keeps them equal). */
export const RELAY_FUNCTION_MAX_MS = 300_000;
// The relay ends a stream this long before the platform stops the function, so the end arrives.
const SHUTDOWN_MARGIN_MS = 3000;
const RATE_WINDOW_MS = 60_000;

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Content-Type-Options': 'nosniff',
  'X-Accel-Buffering': 'no',
});

const PASSTHROUGH_HEADERS = Object.freeze({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });

/** Query parameter names that carry a credential; such a query is refused, not stripped. */
const KEY_PARAM = /^(?:key|api[_-]?key|apikey|access[_-]?token|token|auth|authorization|xi-api-key|x-goog-api-key|x-api-key|x-subscription-token)$/i;
/** Ordinary query parameter names (alt=sse, q=..., output_format=..., pageToken=...). */
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
/** A key as one header value: printable ASCII without spaces (two values joined by ", " fail). */
const KEY_VALUE = /^[\x21-\x7e]{8,1024}$/;
const BEARER_VALUE = /^Bearer ([\x21-\x7e]{8,1024})$/;
const SAFE_HEADER_VALUE = /^[\x20-\x7e]{1,256}$/;
const ANTHROPIC_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const MULTIPART = /^multipart\/form-data;\s*boundary=(?:"[0-9A-Za-z'()+_,./:=?-]{1,70}"|[0-9A-Za-z'()+_,./:=?-]{1,70})$/i;
const UPSTREAM_CODE = /^[a-z_]{1,40}$/;
const PASSTHROUGH_TYPE = /^(?:application\/json|audio\/[a-z0-9.+-]+|application\/octet-stream)\b/i;

/** @type {{ signature: string, deps: RelayDeps } | null} */
let cached = null;

/**
 * Dependencies from the environment, rebuilt only when a relevant variable changes, so rate windows
 * carry over between requests on a warm instance.
 * @returns {RelayDeps}
 */
export function relayRuntimeDeps() {
  const env = readEnv();
  const names = ['STARPI_RELAY_RPM_PER_IP', 'STARPI_ALLOWED_ORIGINS', 'NVIDIA_ALLOWED_ORIGINS', 'RELAY_ALLOWED_ORIGINS', 'STARPI_ACCESS_CODE', ...RELAY_PROVIDERS.map((id) => `STARPI_${id.toUpperCase()}_BASE_URL`)];
  const signature = names.map((name) => env[name] ?? '').join('\n');
  if (cached?.signature !== signature) {
    const now = () => Date.now();
    cached = {
      signature,
      deps: {
        limiter: createRateLimiter({ limit: positiveInt(env.STARPI_RELAY_RPM_PER_IP, RELAY_LIMITS.rateLimitPerMinute), windowMs: RATE_WINDOW_MS, now }),
        extraOrigins: allowedOrigins(env),
        accessCode: readAccessCode(env),
        roots: relayRoots(env),
        fetch: (input, init) => fetch(input, init),
        now,
      },
    };
  }
  return cached.deps;
}

/**
 * The API root of every relay provider, with loopback fakes applied.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function relayRoots(env) {
  return Object.fromEntries(RELAY_PROVIDERS.map((id) => [id, resolveRoot(id, /** @type {Upstream} */ (findUpstream(id)).root, env).root]));
}

/**
 * Provider, upstream path and query of a relay URL. The path is the part after
 * /api/relay/<provider>, still percent-encoded; a URL of the bare /api/relay endpoint may name both
 * as the query parameters `provider` and `path` instead.
 * @param {string} url
 * @returns {{ provider: string, path: string, query: URLSearchParams } | null}
 */
export function relayTarget(url) {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  const m = /^\/api\/relay\/([a-z0-9-]{1,32})(\/.*)?$/.exec(parsed.pathname);
  if (m) return { provider: m[1], path: m[2] ?? '', query: parsed.searchParams };
  if (parsed.pathname !== '/api/relay' && parsed.pathname !== '/api/relay/') return null;
  const query = new URLSearchParams(parsed.searchParams);
  const provider = query.get('provider') ?? '';
  const raw = query.get('path') ?? '';
  query.delete('provider');
  query.delete('path');
  // The rewrite form carries the path without its leading slash and decoded; re-encode it as a path.
  const path = raw ? `/${raw.replace(/^\/+/, '')}`.replace(/[^A-Za-z0-9._~!$&'()*+,;=:@/-]/g, encodeURIComponent) : '';
  return /^[a-z0-9-]{1,32}$/.test(provider) ? { provider, path, query } : null;
}

/**
 * Checks the query string: no credential, ordinary names, a bounded length.
 * @param {URLSearchParams} query
 * @returns {Refusal | null}
 */
function checkQuery(query) {
  for (const [name, value] of query) {
    if (KEY_PARAM.test(name) || hasKnownKey(value) || hasKnownKey(name)) return { status: 400, error: 'key_in_query' };
    if (!PARAM_NAME.test(name)) return { status: 400, error: 'query_not_allowed' };
  }
  return query.toString().length > RELAY_LIMITS.maxQueryChars ? { status: 414, error: 'query_too_long' } : null;
}

/**
 * The key of the request: exactly one credential header, the provider's own.
 * @param {Headers} headers
 * @param {Upstream} upstream
 * @returns {{ ok: true, key: string } | ({ ok: false } & Refusal)}
 */
function readKey(headers, upstream) {
  const own = upstream.auth === 'bearer' ? 'authorization' : upstream.auth;
  for (const name of CREDENTIAL_HEADERS) {
    if (name !== own && headers.has(name)) return { ok: false, status: 400, error: 'auth_header_not_allowed' };
  }
  const value = headers.get(own);
  if (value === null || value === '') return { ok: false, status: 401, error: 'key_required' };
  const key = upstream.auth === 'bearer' ? BEARER_VALUE.exec(value)?.[1] : KEY_VALUE.test(value) ? value : undefined;
  return key ? { ok: true, key } : { ok: false, status: 400, error: 'auth_header_invalid' };
}

/**
 * Reads at most `maxBytes` bytes.
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array | null>} null once the body exceeds the cap (reading stops)
 */
async function readCapped(body, maxBytes) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The request body: none for GET; for POST at most 4 MB of JSON (an object, whose `model`, when
 * present, is a short string) or of multipart form data where the route takes it. Fields are not
 * dropped: the key and the request are the user's own.
 * @param {Request} request
 * @param {UpstreamRoute} route
 * @returns {Promise<{ ok: true, bytes: Uint8Array | null, contentType: string | null } | ({ ok: false } & Refusal)>}
 */
async function readBody(request, route) {
  if (route.method === 'GET') return { ok: true, bytes: null, contentType: null };
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > RELAY_LIMITS.maxBodyBytes) return { ok: false, status: 413, error: 'payload_too_large' };
  const contentType = (request.headers.get('content-type') ?? '').trim();
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  const kinds = route.body ?? ['json'];
  const kind = mediaType === 'application/json' && kinds.includes('json') ? 'json' : MULTIPART.test(contentType) && kinds.includes('multipart') ? 'multipart' : null;
  if (!kind) return { ok: false, status: 415, error: 'unsupported_media_type' };
  const bytes = await readCapped(request.body, RELAY_LIMITS.maxBodyBytes);
  if (!bytes) return { ok: false, status: 413, error: 'payload_too_large' };
  if (kind === 'multipart') return { ok: true, bytes, contentType };

  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, status: 400, error: 'json_body_must_be_object' };
  if ('model' in data && (typeof data.model !== 'string' || data.model.length > 256)) return { ok: false, status: 400, error: 'invalid_field', field: 'model' };
  return { ok: true, bytes, contentType: 'application/json' };
}

/**
 * The headers sent upstream: the key in the provider's style plus an allowlist. Cookies, client
 * addresses (x-forwarded-*) and everything else stay behind.
 * @param {Headers} incoming
 * @param {Upstream} upstream
 * @param {string} key
 * @param {string | null} contentType
 */
function upstreamHeaders(incoming, upstream, key, contentType) {
  const [name, value] = authHeaderFor(upstream.auth, key);
  /** @type {Record<string, string>} */
  const out = { [name]: value };
  if (contentType) out['content-type'] = contentType;
  const accept = incoming.get('accept');
  if (accept && SAFE_HEADER_VALUE.test(accept)) out.accept = accept;
  if (upstream.id === 'anthropic') {
    const version = incoming.get('anthropic-version');
    if (version && ANTHROPIC_VERSION.test(version)) out['anthropic-version'] = version;
    const betas = (incoming.get('anthropic-beta') ?? '')
      .split(',')
      .map((b) => b.trim())
      .filter((b) => KNOWN_ANTHROPIC_BETAS.includes(b));
    if (betas.length > 0) out['anthropic-beta'] = [...new Set(betas)].join(',');
  }
  for (const extra of upstream.extraHeaders ?? []) {
    const v = incoming.get(extra);
    if (v && SAFE_HEADER_VALUE.test(v)) out[extra] = v;
  }
  return out;
}

/**
 * `reader.read()` that gives up after `ms`.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} ms
 * @returns {Promise<ReadableStreamReadResult<Uint8Array> | 'timeout'>}
 */
function readWithin(reader, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, ms));
  });
  return /** @type {Promise<ReadableStreamReadResult<Uint8Array> | 'timeout'>} */ (Promise.race([reader.read(), timeout])).finally(() => clearTimeout(timer));
}

/**
 * The provider's error identifier from the first bytes of its error answer: error.code, error.type,
 * a lower-cased error.status (Gemini), a string error or detail.status (ElevenLabs). The text itself
 * is dropped, since it can quote the request or the key.
 * @param {string} text at most 2 KB, possibly cut off
 */
export function upstreamErrorCode(text) {
  /** @type {unknown[]} */
  const candidates = [];
  try {
    const body = JSON.parse(text);
    const err = body?.error;
    if (err && typeof err === 'object') candidates.push(err.code, err.type, typeof err.status === 'string' ? err.status.toLowerCase() : null);
    else candidates.push(err);
    if (body?.detail && typeof body.detail === 'object') candidates.push(body.detail.status, body.detail.code);
    candidates.push(body?.code);
  } catch {
    // A cut-off body: look for the first identifier field in what arrived.
    for (const m of text.matchAll(/"(?:code|type)"\s*:\s*"([^"]{1,41})"/g)) candidates.push(m[1]);
  }
  const code = candidates.find((c) => typeof c === 'string' && UPSTREAM_CODE.test(c));
  return typeof code === 'string' ? code : 'upstream_error';
}

/**
 * The upstream error as `{ error, upstreamStatus }`: a 4xx keeps its status, anything else is 502.
 * A Retry-After the provider sent is passed on.
 * @param {Response} res
 * @param {() => number} now
 */
async function upstreamFailure(res, now) {
  let text = '';
  const reader = res.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let size = 0;
    try {
      while (size < RELAY_LIMITS.maxErrorBytes) {
        const result = await readWithin(reader, 5000);
        if (result === 'timeout' || result.done) break;
        const room = RELAY_LIMITS.maxErrorBytes - size;
        const value = result.value.byteLength > room ? result.value.subarray(0, room) : result.value;
        size += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // a broken error body says nothing more
    }
    reader.cancel().catch(() => {});
  }
  const status = res.status >= 400 && res.status <= 499 ? res.status : 502;
  /** @type {Record<string, string>} */
  const headers = {};
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now());
  if (retryAfter !== null) headers['Retry-After'] = String(Math.min(600, Math.max(1, Math.ceil(retryAfter / 1000))));
  return json(status, { error: upstreamErrorCode(text), upstreamStatus: res.status }, headers);
}

/**
 * A JSON or audio body, passed through with an idle limit, a deadline and a byte cap. A body that
 * breaks a limit ends with a stream error, so the browser sees a cut answer, never a short one.
 * @param {{ reader: ReadableStreamDefaultReader<Uint8Array>, abort: () => void, now: () => number, idleMs: number, hardDeadline: number, maxBytes: number }} options
 * @returns {ReadableStream<Uint8Array>}
 */
function passthroughStream({ reader, abort, now, idleMs, hardDeadline, maxBytes }) {
  let size = 0;
  let ended = false;
  const stop = () => {
    ended = true;
    reader.cancel().catch(() => {});
    abort();
  };
  return new ReadableStream({
    async pull(controller) {
      const fail = () => {
        if (ended) return;
        stop();
        controller.error(new Error('relay_cut'));
      };
      const wait = Math.min(idleMs, hardDeadline - now());
      if (wait <= 0) return fail();
      let result;
      try {
        result = await readWithin(reader, wait);
      } catch {
        return fail();
      }
      if (ended) return;
      if (result === 'timeout') return fail();
      if (result.done) {
        ended = true;
        abort();
        controller.close();
        return;
      }
      size += result.value.byteLength;
      if (size > maxBytes) return fail();
      controller.enqueue(result.value);
    },
    cancel() {
      stop();
    },
  });
}

/**
 * GET or POST /api/relay/<provider>/<path>.
 * @param {Request} request
 * @param {RelayDeps} deps
 * @returns {Promise<Response>}
 */
export async function handleRelay(request, deps) {
  const { now } = deps;
  const startedAt = now();
  const front = await guardRequest(request, deps);
  if (front) return refuse(front);

  const target = relayTarget(request.url);
  const upstream = target ? findUpstream(target.provider) : null;
  if (!target || !upstream) return refuse({ status: 404, error: 'unknown_provider' });
  const matched = matchUpstreamRoute(upstream, request.method, target.path);
  if (!matched.ok) return refuse(matched);
  const queryRefusal = checkQuery(target.query);
  if (queryRefusal) return refuse(queryRefusal);

  const key = readKey(request.headers, upstream);
  if (!key.ok) return refuse(key);
  const body = await readBody(request, matched.route);
  if (!body.ok) return refuse(body);

  const query = target.query.toString();
  const url = `${deps.roots[upstream.id] ?? upstream.root}${target.path}${query ? `?${query}` : ''}`;
  const hardDeadline = startedAt + RELAY_FUNCTION_MAX_MS - SHUTDOWN_MARGIN_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(0, Math.min(RELAY_LIMITS.idleMs, hardDeadline - now())));
  const onClientAbort = () => controller.abort();
  request.signal?.addEventListener('abort', onClientAbort, { once: true });
  const release = () => {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onClientAbort);
    controller.abort();
  };

  /** @type {Response} */
  let res;
  try {
    res = await deps.fetch(url, {
      method: matched.route.method,
      redirect: 'error',
      signal: controller.signal,
      headers: upstreamHeaders(request.headers, upstream, key.key, body.contentType),
      ...(body.bytes ? { body: /** @type {BodyInit} */ (body.bytes) } : {}),
    });
  } catch {
    release();
    if (request.signal?.aborted) return refuse({ status: 499, error: 'client_closed' });
    return refuse(timedOut ? { status: 504, error: 'upstream_timeout' } : { status: 502, error: 'upstream_unreachable' });
  }
  clearTimeout(timer);

  if (res.status < 200 || res.status > 299) {
    const failure = await upstreamFailure(res, now);
    release();
    return failure;
  }
  const contentType = res.headers.get('content-type') ?? '';
  const reader = res.body?.getReader();
  if (!reader || res.status === 204) {
    reader?.cancel().catch(() => {});
    release();
    return new Response(null, { status: res.status, headers: PASSTHROUGH_HEADERS });
  }

  if (res.status === 200 && contentType.toLowerCase().startsWith('text/event-stream')) {
    let first = null;
    try {
      for (;;) {
        const result = await readWithin(reader, Math.min(RELAY_LIMITS.idleMs, hardDeadline - now()));
        if (result === 'timeout' || result.done) break;
        if (result.value.byteLength > 0) {
          first = result.value;
          break;
        }
      }
    } catch {
      first = null;
    }
    if (!first) {
      reader.cancel().catch(() => {});
      release();
      return refuse(request.signal?.aborted ? { status: 499, error: 'client_closed' } : { status: 502, error: 'upstream_empty' });
    }
    const stream = relayStream({ first, reader, abort: release, now, idleMs: RELAY_LIMITS.idleMs, hardDeadline, maxBytes: RELAY_LIMITS.maxStreamBytes });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  }

  if (!PASSTHROUGH_TYPE.test(contentType)) {
    reader.cancel().catch(() => {});
    release();
    return refuse({ status: 502, error: 'unexpected_content_type' });
  }
  const stream = passthroughStream({ reader, abort: release, now, idleMs: RELAY_LIMITS.idleMs, hardDeadline, maxBytes: RELAY_LIMITS.maxPassthroughBytes });
  return new Response(stream, { status: res.status, headers: { ...PASSTHROUGH_HEADERS, 'Content-Type': contentType.slice(0, 128) } });
}

/**
 * Runs the relay and turns an unexpected exception into a 500 that names nothing of the request;
 * the log line carries only the scrubbed error class.
 * @param {Request} request
 * @param {RelayDeps} deps
 */
export async function serveRelay(request, deps) {
  try {
    return await handleRelay(request, deps);
  } catch (err) {
    console.error(`relay: ${scrubSecrets(err instanceof Error ? err.name : 'Error')}`);
    return refuse({ status: 500, error: 'relay_failed' });
  }
}
