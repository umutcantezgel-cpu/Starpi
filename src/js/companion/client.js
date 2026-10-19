// @ts-check
// The HTTP client of the local companion (Starpi Core, packages/companion): one origin on the
// loopback interface, JSON in and out, server-sent events for streams, and the signed audit head
// every answer carries. It knows the two ways a browser is signed in:
//   cookie  Mode A: the app is served by the companion itself (same origin). The HttpOnly cookie
//           travels on its own; the CSRF value of the pairing goes in X-Companion-CSRF.
//   bearer  Mode B: the app runs on another origin the companion allows (the hosted site). The
//           token goes in Authorization; no cookie is sent (credentials 'omit').
// Requests are never cached by the browser (cache: 'no-store'), never follow a redirect and carry
// no headers beyond Authorization and Content-Type, the two the companion's CORS answer allows.
//
// The audit head of an answer comes from the X-Companion-Audit-Head header (`<seq>.<hash>.<sig>`),
// a JSON body's `auditHead` or a stream's final `audit` event, and is handed to `onHead`; checking
// its signature and comparing it with the highest head seen is the pairing's job (pair.js). The
// signature covers the canonical JSON of { hash, key, kind, seq, v } (sorted keys, no whitespace),
// made with the companion's Ed25519 identity key; the key id is the SHA-256 (hex) of the raw
// 32-byte public key.
//
// Errors are CompanionError with the companion's stable snake_case code (`{ error: { code } }`), or
// `unreachable` (no answer), `bad_response` (an answer that is not the companion's) and `aborted`.
import { readSse } from '../ai/sse.js';
import { canonicalJson, fromBase64url, fromHex, sha256Hex } from '../core/hash.js';

/** Where `starpi-companion start` listens unless told otherwise. */
export const DEFAULT_COMPANION_ORIGIN = 'http://127.0.0.1:47821';
/** The CSRF header of a cookie session (Mode A). */
export const CSRF_HEADER = 'X-Companion-CSRF';
/** The header that carries the signed audit head. */
export const HEAD_HEADER = 'X-Companion-Audit-Head';
/** What the signature of an audit head says it is. */
export const HEAD_KIND = 'starpi.companion.audit-head';
/** Longest wait for a JSON answer; streams have no overall limit (the server pings them). */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Largest JSON answer read. */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

const LOOPBACK_HOSTS = Object.freeze(new Set(['127.0.0.1', 'localhost', '[::1]']));
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** @typedef {{ seq: number, hash: string, sig: string }} SignedHead */
/** @typedef {{ kind: 'cookie', csrf: string } | { kind: 'bearer', token: string }} CompanionAuth */
/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike */

/** A failed companion call; `code` is a stable snake_case code the app translates. */
export class CompanionError extends Error {
  /**
   * @param {string} code
   * @param {{ status?: number, message?: string, details?: unknown }} [opts]
   */
  constructor(code, opts = {}) {
    super(opts.message || code);
    this.name = 'CompanionError';
    this.code = CODE.test(code) ? code : 'bad_response';
    this.status = opts.status ?? 0;
    this.details = opts.details;
  }
}

/**
 * The canonical origin of a loopback address (`http://127.0.0.1:47821`), or null for anything
 * else: another host, a path, credentials, a scheme other than http(s).
 * @param {unknown} value
 * @returns {string | null}
 */
export function loopbackOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  return url.origin;
}

/**
 * A signed head from the header form `<seq>.<hash>.<sig>`, or null.
 * @param {string | null | undefined} value
 * @returns {SignedHead | null}
 */
export function parseHeadHeader(value) {
  const m = /^(\d{1,15})\.([0-9a-f]{64})\.([A-Za-z0-9_-]{80,100})$/.exec(String(value ?? '').trim());
  return m ? { seq: Number(m[1]), hash: m[2], sig: m[3] } : null;
}

/**
 * A signed head as the JSON forms carry it, or null when it is not one.
 * @param {unknown} value
 * @returns {SignedHead | null}
 */
export function asHead(value) {
  if (!value || typeof value !== 'object') return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isSafeInteger(v.seq) || /** @type {number} */ (v.seq) < 0 || typeof v.hash !== 'string' || !/^[0-9a-f]{64}$/.test(v.hash) || typeof v.sig !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(v.sig)) return null;
  return { seq: /** @type {number} */ (v.seq), hash: v.hash, sig: v.sig };
}

/**
 * The exact text an audit head signature covers.
 * @param {{ keyId: string, seq: number, hash: string }} head
 */
export function headMessage({ keyId, seq, hash }) {
  return canonicalJson({ v: 1, kind: HEAD_KIND, key: keyId, seq, hash });
}

/**
 * Checks that a public key (raw 32 bytes, base64url) has the given key id.
 * @param {string} publicKey
 * @param {string} keyId
 */
export async function keyIdMatches(publicKey, keyId) {
  const raw = typeof publicKey === 'string' ? fromBase64url(publicKey) : null;
  if (!raw || raw.length !== 32 || typeof keyId !== 'string' || !fromHex(keyId)) return false;
  return (await sha256Hex(raw)) === keyId;
}

/**
 * Imports the companion's identity key for signature checks (Ed25519, raw 32 bytes, base64url).
 * Rejects when the browser has no Ed25519 in WebCrypto.
 * @param {string} publicKey
 * @returns {Promise<CryptoKey>}
 */
export async function importIdentityKey(publicKey) {
  const raw = fromBase64url(publicKey);
  if (!raw || raw.length !== 32) throw new CompanionError('identity_invalid');
  return crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
}

/**
 * Whether a head's signature was made by the companion's identity key.
 * @param {SignedHead} head
 * @param {{ key: CryptoKey, keyId: string }} identity
 */
export async function verifyHead(head, identity) {
  const sig = fromBase64url(head.sig);
  if (!sig || sig.length !== 64) return false;
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, identity.key, sig, new TextEncoder().encode(headMessage({ keyId: identity.keyId, seq: head.seq, hash: head.hash })));
  } catch {
    return false;
  }
}

/**
 * @param {unknown} body
 * @param {number} status
 */
function errorOf(body, status) {
  const err = body && typeof body === 'object' ? /** @type {any} */ (body).error : null;
  const code = typeof err?.code === 'string' && CODE.test(err.code) ? err.code : status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'bad_response';
  return new CompanionError(code, { status, message: typeof err?.message === 'string' ? err.message.slice(0, 300) : undefined, details: err?.details });
}

/**
 * @param {Response} res
 * @returns {Promise<any>}
 */
async function readJson(res) {
  const length = Number(res.headers.get('content-length') ?? '0');
  if (length > MAX_JSON_BYTES) throw new CompanionError('bad_response', { status: res.status });
  const text = await res.text();
  if (text.length > MAX_JSON_BYTES) throw new CompanionError('bad_response', { status: res.status });
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new CompanionError('bad_response', { status: res.status });
  }
}

/**
 * @typedef {object} RequestOptions
 * @property {unknown} [body]                     JSON body
 * @property {{ type: string, data: Blob | ArrayBuffer | Uint8Array }} [raw]  a raw body (an upload)
 * @property {Record<string, string | number | boolean | null | undefined>} [query]
 * @property {AbortSignal} [signal]
 * @property {boolean} [anonymous]                send no credentials (the probe)
 * @property {number} [timeoutMs]
 */

/**
 * A client for one companion.
 * @param {object} options
 * @param {string} options.origin          a loopback origin
 * @param {CompanionAuth | null} [options.auth]
 * @param {FetchLike} [options.fetch]
 * @param {(head: SignedHead) => void} [options.onHead]  every head an answer carried
 */
export function createCompanionClient({ origin, auth = null, fetch: fetchImpl, onHead }) {
  const base = loopbackOrigin(origin);
  if (!base) throw new CompanionError('origin_invalid');
  const doFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  // Mode A: the page and the companion share an origin, and the session cookie travels on its own
  // (pairing there must accept the cookie). Every other page sends no cookie at all.
  const sameOrigin = typeof location !== 'undefined' && location.origin === base;
  /** @type {CompanionAuth | null} */
  let current = auth;

  /**
   * @param {string} path
   * @param {RequestOptions['query']} [query]
   */
  const urlOf = (path, query) => {
    if (!path.startsWith('/v1/')) throw new CompanionError('bad_request');
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    return url.toString();
  };

  /** @param {boolean} anonymous */
  const authHeaders = (anonymous) => {
    /** @type {Record<string, string>} */
    const headers = {};
    if (anonymous || !current) return headers;
    if (current.kind === 'bearer') headers.Authorization = `Bearer ${current.token}`;
    else headers[CSRF_HEADER] = current.csrf;
    return headers;
  };

  /** @param {unknown} value */
  const report = (value) => {
    const head = typeof value === 'string' ? parseHeadHeader(value) : asHead(value);
    if (head) onHead?.(head);
    return head;
  };

  /**
   * @param {string} method
   * @param {string} path
   * @param {RequestOptions} [opts]
   * @param {boolean} [stream]
   */
  async function send(method, path, opts = {}, stream = false) {
    const headers = authHeaders(Boolean(opts.anonymous));
    /** @type {BodyInit | undefined} */
    let body;
    if (opts.raw) {
      headers['Content-Type'] = opts.raw.type;
      body = /** @type {BodyInit} */ (opts.raw.data);
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = stream ? null : setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    /** @type {Response} */
    let res;
    try {
      res = await doFetch(urlOf(path, opts.query), {
        method,
        headers,
        body,
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        credentials: sameOrigin && !opts.anonymous ? 'same-origin' : 'omit',
        mode: 'cors',
      });
    } catch (err) {
      cleanup();
      if (opts.signal?.aborted) throw new CompanionError('aborted');
      if (controller.signal.aborted) throw new CompanionError('timeout');
      throw new CompanionError('unreachable', { message: err instanceof Error ? err.message : undefined });
    }
    report(res.headers.get(HEAD_HEADER));
    return { res, cleanup, controller };
  }

  /**
   * One JSON call.
   * @param {'GET' | 'POST' | 'PUT' | 'DELETE'} method
   * @param {string} path  below /v1/
   * @param {RequestOptions} [opts]
   * @returns {Promise<any>}
   */
  async function request(method, path, opts = {}) {
    const { res, cleanup } = await send(method, path, opts);
    try {
      const type = res.headers.get('content-type') ?? '';
      if (!type.startsWith('application/json')) throw new CompanionError(res.ok ? 'bad_response' : errorOf(null, res.status).code, { status: res.status });
      const json = await readJson(res);
      if (json && typeof json === 'object' && 'auditHead' in json) report(json.auditHead);
      if (!res.ok) throw errorOf(json, res.status);
      return json;
    } catch (err) {
      if (err instanceof CompanionError) throw err;
      throw new CompanionError(opts.signal?.aborted ? 'aborted' : 'bad_response', { status: res.status });
    } finally {
      cleanup();
    }
  }

  /**
   * A call answered with server-sent events: each event goes to `onEvent` as { event, data } with
   * the data parsed as JSON. The final `audit` event is reported as a head (and passed on too). An
   * `error` event of the stream rejects with its code.
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {RequestOptions & { onEvent: (event: string, data: any) => void, idleMs?: number }} opts
   */
  async function stream(method, path, opts) {
    const { res, cleanup, controller } = await send(method, path, opts, true);
    try {
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('text/event-stream')) {
        const json = type.startsWith('application/json') ? await readJson(res).catch(() => null) : null;
        throw res.ok ? new CompanionError('bad_response', { status: res.status }) : errorOf(json, res.status);
      }
      for await (const ev of readSse(res.body, { idleMs: opts.idleMs ?? 45_000, ids: false })) {
        let data = null;
        try {
          data = ev.data ? JSON.parse(ev.data) : null;
        } catch {
          continue;
        }
        if (ev.event === 'audit') report(data);
        if (ev.event === 'error') throw new CompanionError(typeof data?.code === 'string' ? data.code : 'stream_failed');
        opts.onEvent(ev.event, data);
      }
    } catch (err) {
      if (err instanceof CompanionError) throw err;
      throw new CompanionError(opts.signal?.aborted ? 'aborted' : 'stream_failed');
    } finally {
      controller.abort();
      cleanup();
    }
  }

  return {
    origin: base,
    /** The sign-in this client sends. */
    auth: () => current,
    /** @param {CompanionAuth | null} next */
    setAuth(next) {
      current = next;
    },
    request,
    stream,
    /**
     * The probe: GET /v1/hello without any credentials.
     * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
     * @returns {Promise<{ name: string, version: string, pairing: boolean }>}
     */
    async hello(opts = {}) {
      const json = await request('GET', '/v1/hello', { anonymous: true, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 4000 });
      if (json?.name !== 'starpi-companion' || typeof json.version !== 'string') throw new CompanionError('not_a_companion');
      return { name: json.name, version: json.version.slice(0, 40), pairing: json.pairing === true };
    },
    /**
     * The URL of a companion file to open in a new tab or download (Mode A only: a cookie session
     * reaches it without headers). Mode B downloads go through request() and a Blob instead.
     * @param {string} path
     */
    url: (path) => urlOf(path),
    /**
     * Fetches a raw answer (a document's file) as a Blob.
     * @param {string} path
     * @param {{ signal?: AbortSignal }} [opts]
     */
    async blob(path, opts = {}) {
      const { res, cleanup } = await send('GET', path, { signal: opts.signal, timeoutMs: 60_000 });
      try {
        if (!res.ok) throw errorOf(await readJson(res).catch(() => null), res.status);
        return await res.blob();
      } finally {
        cleanup();
      }
    },
  };
}

/** @typedef {ReturnType<typeof createCompanionClient>} CompanionClient */
