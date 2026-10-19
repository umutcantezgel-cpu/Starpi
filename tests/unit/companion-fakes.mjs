// A stand-in for the local companion in unit tests: an Ed25519 identity whose heads are signed the
// way the companion signs them, and a fetch that answers its HTTP API from handlers the test sets
// (JSON with the audit head in the header and the body, errors as { error: { code } }, streams as
// server-sent events ending with the `audit` event). It records every request.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

/** @param {Buffer | Uint8Array} bytes */
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
/** @param {string} text */
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A companion identity: raw public key (base64url), key id, and a signer of heads. */
export function makeIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(/** @type {string} */ (publicKey.export({ format: 'jwk' }).x), 'base64url');
  const keyId = createHash('sha256').update(raw).digest('hex');
  return {
    publicKey: b64url(raw),
    keyId,
    /**
     * A signed head of record `seq` (hash derived from `seq` and `variant` unless given).
     * @param {number} seq
     * @param {{ hash?: string, variant?: string, keyId?: string }} [opts]
     */
    head(seq, opts = {}) {
      const hash = opts.hash ?? sha256(`record ${seq}${opts.variant ?? ''}`);
      const message = `{"hash":"${hash}","key":"${opts.keyId ?? keyId}","kind":"starpi.companion.audit-head","seq":${seq},"v":1}`;
      return { seq, hash, sig: b64url(sign(null, Buffer.from(message, 'utf8'), privateKey)) };
    },
  };
}

/**
 * @typedef {object} FakeRequest
 * @property {string} method
 * @property {string} path
 * @property {URLSearchParams} query
 * @property {Record<string, string>} headers
 * @property {any} body
 * @property {RequestInit} init
 */

/**
 * @typedef {object} HandlerResult
 * @property {number} [status]
 * @property {any} [body]
 * @property {Array<{ event: string, data: unknown }>} [events]  answer as a stream
 * @property {boolean} [noHead]    leave the audit head out
 * @property {string} [type]       another content type
 */

/**
 * A fake companion at `origin`.
 * @param {{ origin?: string, identity?: ReturnType<typeof makeIdentity> }} [opts]
 */
export function fakeCompanion(opts = {}) {
  const origin = opts.origin ?? 'http://127.0.0.1:47821';
  const identity = opts.identity ?? makeIdentity();
  /** @type {FakeRequest[]} */
  const requests = [];
  /** @type {Map<string, (req: FakeRequest) => HandlerResult | Promise<HandlerResult>>} */
  const handlers = new Map();
  let seq = 5;
  /** The head the next answer carries (a test may set another one). */
  /** @type {{ seq: number, hash: string, sig: string } | null} */
  let forced = null;
  const currentHead = () => forced ?? identity.head(seq);

  handlers.set('GET /v1/hello', () => ({ body: { name: 'starpi-companion', version: '2.1.0', pairing: true } }));
  handlers.set('POST /v1/session/pair', (req) =>
    req.body?.code === 'ABCDEFGH'
      ? { body: { mode: 'bearer', session: 'sess-1', role: 'owner', expiresAt: '2099-01-01T00:00:00.000Z', publicKey: identity.publicKey, keyId: identity.keyId, token: 'tok_0123456789abcdefghijklmnopqrstuvwxyzABCDE' } }
      : { status: 401, body: { error: { code: 'pairing_failed', message: 'wrong' } } },
  );
  handlers.set('GET /v1/audit/head', (req) => {
    const at = req.query.get('seq');
    return { body: { head: at === null ? currentHead() : identity.head(Number(at)), keyId: identity.keyId, publicKey: identity.publicKey } };
  });
  handlers.set('POST /v1/session/logout', () => ({ body: { ended: true } }));

  /** @type {(input: string, init?: RequestInit) => Promise<Response>} */
  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    if (url.origin !== origin) throw new TypeError('fetch failed');
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, string>} */ (init.headers ?? {}))) headers[k.toLowerCase()] = v;
    let body = init.body;
    if (typeof body === 'string' && headers['content-type'] === 'application/json') body = JSON.parse(body);
    /** @type {FakeRequest} */
    const req = { method: String(init.method ?? 'GET'), path: url.pathname, query: url.searchParams, headers, body, init };
    requests.push(req);
    const handler = handlers.get(`${req.method} ${req.path}`);
    const result = handler ? await handler(req) : { status: 404, body: { error: { code: 'not_found', message: 'no such route' } } };
    const head = currentHead();
    /** @type {Record<string, string>} */
    const out = result.noHead ? {} : { 'x-companion-audit-head': `${head.seq}.${head.hash}.${head.sig}` };
    if (result.events) {
      const text = [...result.events, ...(result.noHead ? [] : [{ event: 'audit', data: head }])].map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
      return new Response(text, { status: 200, headers: { ...out, 'content-type': 'text/event-stream; charset=utf-8' } });
    }
    const json = result.body !== null && typeof result.body === 'object' && !result.noHead ? { ...result.body, auditHead: head } : result.body;
    return new Response(typeof json === 'string' ? json : JSON.stringify(json ?? {}), { status: result.status ?? 200, headers: { ...out, 'content-type': result.type ?? 'application/json; charset=utf-8' } });
  }

  return {
    origin,
    identity,
    requests,
    handlers,
    fetch: fetchImpl,
    /** @param {number} n */
    setSeq(n) {
      seq = n;
      forced = null;
    },
    /** @param {{ seq: number, hash: string, sig: string } | null} head */
    forceHead(head) {
      forced = head;
    },
    /** @param {string} method @param {string} path */
    calls: (method, path) => requests.filter((r) => r.method === method && r.path === path),
  };
}

/** A link store in memory (the IndexedDB store's contract). */
export function memoryLinkStore() {
  /** @type {any} */
  let link = null;
  /** @type {Map<string, any>} */
  const heads = new Map();
  /** @type {CryptoKey | null} */
  let key = null;
  const calls = { load: 0 };
  return {
    calls,
    load: async () => {
      calls.load += 1;
      return link ? structuredClone(link) : null;
    },
    save: async (/** @type {any} */ value) => {
      link = structuredClone(value);
    },
    clear: async () => {
      link = null;
    },
    head: async (/** @type {string} */ keyId) => heads.get(keyId) ?? null,
    saveHead: async (/** @type {any} */ head) => {
      heads.set(head.keyId, { ...head });
    },
    async sealKey() {
      key ??= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return key;
    },
    /** What is stored, for assertions. */
    peek: () => ({ link, heads }),
  };
}

/** A marker in memory. */
export function memoryMarker() {
  let on = false;
  return { get: () => on, set: (/** @type {boolean} */ v) => (on = v) };
}

/** Waits until queued promise work has run. */
export async function settle() {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));
}
