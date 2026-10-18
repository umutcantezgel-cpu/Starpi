// @ts-check
// The HTTP API of the companion: node:http, bound to loopback only, JSON in and out, small bodies.
//
// Every request passes, in order:
//  1. the Host check: only 127.0.0.1, localhost and [::1] with the companion's port (a page that
//     rebinds a DNS name to 127.0.0.1 gets 421);
//  2. the Origin check: no Origin, the companion's own origin, or an allowed cross origin (Mode B,
//     with CORS headers for exactly that origin and Access-Control-Allow-Private-Network on
//     preflights); any other origin gets 403 and no CORS headers;
//  3. the route's access level: a cookie session (with its X-Companion-CSRF value, same origin only)
//     or a bearer token (bound to the origin it was paired from), and the role the route needs;
//  4. the breaker: the route's lane must be allowed at the current level;
//  5. the body: JSON only, within the route's limit.
// Every answer carries the signed audit head, in the X-Companion-Audit-Head header
// (`<seq>.<hash>.<sig>`) and as `auditHead` in JSON bodies; a stream ends with an `audit` event.
import { createServer } from 'node:http';
import { CompanionError, codeOf } from '../lib/errors.js';
import { roleAllows } from '../contracts/roles.js';
import { normalizeOrigin } from '../auth/origins.js';
import { CSRF_HEADER } from '../auth/sessions.js';

export const DEFAULT_PORT = 47821;
export const DEFAULT_BODY_LIMIT = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
export const STREAM_PING_MS = 15_000;
const LOOPBACK_BINDS = Object.freeze(new Set(['127.0.0.1', '::1', 'localhost']));

/**
 * @typedef {object} RouteRequest
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} params
 * @property {URLSearchParams} query
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {any} body
 * @property {import('../auth/sessions.js').Session | null} session
 * @property {string | null} origin
 * @property {boolean} sameOrigin
 * @property {AbortSignal} signal
 */

/**
 * @typedef {object} RouteResult
 * @property {number} [status]
 * @property {any} [body]
 * @property {Record<string, string>} [headers]
 * @property {Array<{ name: string, value: string, maxAge: number }>} [cookies]
 * @property {AsyncIterable<{ event: string, data: unknown }>} [stream]
 */

/**
 * @typedef {object} Route
 * @property {'GET' | 'POST' | 'PUT' | 'DELETE'} method
 * @property {string} path
 * @property {import('../contracts/roles.js').Access} access
 * @property {'status' | 'interactive' | 'events' | 'background'} [lane]
 * @property {number} [maxBody]
 * @property {(req: RouteRequest) => Promise<RouteResult> | RouteResult} handler
 */

/**
 * Cookies of a request.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || Object.hasOwn(out, name)) continue;
    out[name] = part.slice(at + 1).trim();
  }
  return out;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {number} maxAge
 */
export const serializeCookie = (name, value, maxAge) => `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Path=/; HttpOnly; SameSite=Strict`;

/**
 * Compiles a path pattern with `:name` parameters.
 * @param {string} pattern
 */
function compile(pattern) {
  /** @type {string[]} */
  const names = [];
  const source = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      names.push(seg.slice(1));
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { regex: new RegExp(`^${source.join('/')}$`), names };
}

/**
 * The route table, filled by the kernel and by modules.
 */
export function createRouteTable() {
  /** @type {Array<Route & { regex: RegExp, names: string[] }>} */
  const routes = [];
  return {
    /** @param {Route} route */
    add(route) {
      if (!route.path.startsWith('/v1/')) throw new TypeError(`route ${route.path}: API routes live below /v1/`);
      if (routes.some((r) => r.method === route.method && r.path === route.path)) throw new TypeError(`route ${route.method} ${route.path} exists already`);
      routes.push({ ...route, ...compile(route.path) });
    },
    /**
     * @param {string} method
     * @param {string} path
     * @returns {{ route: Route, params: Record<string, string> } | { route: null, allowed: string[] }}
     */
    match(method, path) {
      const allowed = [];
      for (const r of routes) {
        const m = r.regex.exec(path);
        if (!m) continue;
        if (r.method !== method) {
          allowed.push(r.method);
          continue;
        }
        /** @type {Record<string, string>} */
        const params = {};
        r.names.forEach((n, i) => {
          params[n] = decodeURIComponent(m[i + 1]);
        });
        return { route: r, params };
      }
      return { route: null, allowed };
    },
    list: () => routes.map((r) => ({ method: r.method, path: r.path, access: r.access })),
  };
}

/** @typedef {ReturnType<typeof createRouteTable>} RouteTable */

/**
 * @param {object} options
 * @param {string} [options.host]
 * @param {number} options.port
 * @param {RouteTable} options.routes
 * @param {import('../auth/origins.js').OriginPolicy} options.origins
 * @param {import('../auth/sessions.js').Sessions} options.sessions
 * @param {() => import('../audit/chain.js').SignedHead} options.auditHead
 * @param {import('./static.js').StaticSite | null} [options.site]
 * @param {import('../breaker/breaker.js').Breaker} [options.breaker]
 * @param {string} [options.cookieName]
 * @param {import('../lib/log.js').Logger} [options.log]
 * @param {number} [options.requestTimeoutMs]
 */
export function createHttpServer({ host = '127.0.0.1', port, routes, origins, sessions, auditHead, site = null, breaker, cookieName, log = () => {}, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!LOOPBACK_BINDS.has(host)) throw new TypeError(`the companion binds to loopback only, not ${host}`);
  /** @type {number} */
  let boundPort = port;
  const hostsFor = () => new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
  /** Cookies do not separate ports, so the name carries the port. */
  const currentCookieName = () => cookieName ?? `starpi_companion_${boundPort}`;

  /** @returns {string} */
  function headerValue() {
    const h = auditHead();
    return `${h.seq}.${h.hash}.${h.sig}`;
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} body
   * @param {Record<string, string>} headers
   */
  function sendJson(res, status, body, headers) {
    const head = auditHead();
    const payload = body !== null && typeof body === 'object' && !Array.isArray(body) ? { ...body, auditHead: head } : { value: body, auditHead: head };
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(text)),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Companion-Audit-Head': `${head.seq}.${head.hash}.${head.sig}`,
    });
    res.end(text);
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {unknown} err
   * @param {Record<string, string>} headers
   */
  function sendError(res, err, headers) {
    const status = err instanceof CompanionError ? err.status : 500;
    const code = codeOf(err);
    if (status >= 500) log('error', 'request_failed', { code, error: err });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, status, { error: { code, message: status >= 500 && !(err instanceof CompanionError) ? 'internal error' : /** @type {Error} */ (err).message } }, headers);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {number} limit
   * @returns {Promise<any>}
   */
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const declared = Number(req.headers['content-length'] ?? '0');
      if (declared === 0 && req.headers['transfer-encoding'] === undefined) {
        resolve(null);
        return;
      }
      if (type !== 'application/json') {
        reject(new CompanionError('unsupported_media_type', 'bodies are JSON', { status: 415 }));
        return;
      }
      if (declared > limit) {
        reject(new CompanionError('body_too_large', `bodies are at most ${limit} bytes`, { status: 413 }));
        return;
      }
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new CompanionError('body_too_large', `bodies are at most ${limit} bytes`, { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new CompanionError('body_invalid', 'the body is not JSON', { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {AsyncIterable<{ event: string, data: unknown }>} stream
   * @param {Record<string, string>} headers
   * @param {AbortController} abort
   */
  async function sendStream(res, stream, headers, abort) {
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
      'X-Companion-Audit-Head': headerValue(),
    });
    const ping = setInterval(() => res.write(': ping\n\n'), STREAM_PING_MS);
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        if (abort.signal.aborted) break;
        const { value, done } = await iterator.next();
        if (done) break;
        if (!/^[a-z][a-z0-9_.-]{0,31}$/.test(value.event)) continue;
        const ok = res.write(`event: ${value.event}\ndata: ${JSON.stringify(value.data)}\n\n`);
        if (!ok) await new Promise((resolve) => res.once('drain', resolve));
      }
      if (!abort.signal.aborted) res.write(`event: audit\ndata: ${JSON.stringify(auditHead())}\n\n`);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ code: codeOf(err) })}\n\n`);
    } finally {
      clearInterval(ping);
      await iterator.return?.();
      res.end();
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    if (!hostsFor().has(hostHeader)) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('misdirected request');
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
    const rawOrigin = req.headers.origin;
    const origin = typeof rawOrigin === 'string' ? normalizeOrigin(rawOrigin) : null;
    const crossSite = req.headers['sec-fetch-site'] === 'cross-site' || req.headers['sec-fetch-site'] === 'same-site';
    const sameOrigin = rawOrigin === undefined ? !crossSite : origins.isSelf(origin);
    const allowedCross = !sameOrigin && origins.isAllowed(origin);
    const cors = allowedCross ? origins.corsHeaders(origin) : {};
    const isApi = url.pathname.startsWith('/v1/') || url.pathname === '/v1';

    if (rawOrigin !== undefined && !sameOrigin && !allowedCross) {
      sendError(res, new CompanionError('origin_not_allowed', 'this origin may not use the companion', { status: 403 }), {});
      return;
    }
    if (req.method === 'OPTIONS') {
      if (!allowedCross || !isApi) {
        sendError(res, new CompanionError('origin_not_allowed', 'no cross-origin access here', { status: 403 }), {});
        return;
      }
      const privateNetwork = req.headers['access-control-request-private-network'] === 'true';
      res.writeHead(204, { ...origins.corsHeaders(origin, { preflight: true, privateNetwork }), 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (!isApi) {
      if (site && (req.method === 'GET' || req.method === 'HEAD') && sameOrigin) {
        if (hostHeader !== `127.0.0.1:${boundPort}`) {
          res.writeHead(308, { Location: `http://127.0.0.1:${boundPort}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        if (site.serve(req, res, url.pathname)) return;
      }
      sendError(res, new CompanionError('not_found', 'no such path', { status: 404 }), cors);
      return;
    }

    const found = routes.match(/** @type {string} */ (req.method), url.pathname);
    if (!found.route) {
      const status = 'allowed' in found && found.allowed.length > 0 ? 405 : 404;
      sendError(res, new CompanionError(status === 405 ? 'method_not_allowed' : 'not_found', status === 405 ? 'method not allowed' : 'no such route', { status }), status === 405 ? { ...cors, Allow: found.allowed.join(', ') } : cors);
      return;
    }
    const { route, params } = found;
    const auth = String(req.headers.authorization ?? '');
    const bearer = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(auth)?.[1] ?? null;
    const cookie = parseCookies(req.headers.cookie)[currentCookieName()] ?? null;
    const csrf = typeof req.headers[CSRF_HEADER] === 'string' ? /** @type {string} */ (req.headers[CSRF_HEADER]) : null;
    const session = bearer || cookie ? sessions.authenticate({ bearer, cookie: bearer ? null : cookie, csrf, origin, sameOrigin }) : null;
    if (!roleAllows(session?.role ?? null, route.access)) {
      const status = session ? 403 : 401;
      sendError(res, new CompanionError(session ? 'forbidden' : 'unauthenticated', session ? 'this role may not do that' : 'pair this device first', { status }), cors);
      return;
    }
    const lane = route.lane ?? 'interactive';
    if (breaker && !breaker.allows(lane)) {
      sendError(res, new CompanionError('breaker_engaged', `the companion is ${breaker.level()} and does not take this request`, { status: 503 }), cors);
      return;
    }
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) abort.abort(new CompanionError('client_closed', 'the client went away'));
    });
    try {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req, route.maxBody ?? DEFAULT_BODY_LIMIT) : null;
      const result = await route.handler({ method: /** @type {string} */ (req.method), path: url.pathname, params, query: url.searchParams, headers: req.headers, body, session, origin, sameOrigin, signal: abort.signal });
      /** @type {Record<string, string | string[]>} */
      const headers = { ...cors, ...(result.headers ?? {}) };
      if (result.cookies?.length) headers['Set-Cookie'] = result.cookies.map((c) => serializeCookie(c.name, c.value, c.maxAge));
      if (result.stream) {
        await sendStream(res, result.stream, /** @type {Record<string, string>} */ (headers), abort);
        return;
      }
      sendJson(res, result.status ?? 200, result.body ?? {}, /** @type {Record<string, string>} */ (headers));
    } catch (err) {
      sendError(res, err, cors);
    }
  }

  const server = createServer({ requestTimeout: requestTimeoutMs, headersTimeout: Math.min(requestTimeoutMs, 10_000) }, (req, res) => {
    handle(req, res).catch((err) => sendError(res, err, {}));
  });

  return {
    server,
    /** @returns {Promise<number>} the bound port */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          boundPort = typeof address === 'object' && address ? address.port : port;
          resolve(boundPort);
        });
      });
    },
    port: () => boundPort,
    cookieName: currentCookieName,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections?.();
      });
    },
  };
}
