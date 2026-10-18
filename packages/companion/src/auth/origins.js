// @ts-check
// Which web origins may talk to the companion. Its own origin (http://127.0.0.1:<port>, the
// self-served app of Mode A) always may; the hosted app (https://www.starpi.app by default) and
// any origin the owner adds may use Mode B: cross-origin requests with a bearer token. Every other
// origin gets no CORS headers and a refusal, so a page somewhere on the web cannot read anything
// from the loopback port.

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['https://www.starpi.app']);

/** @param {string} host */
const loopbackHost = (host) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

/**
 * The canonical form of an origin (`scheme://host[:port]`, lower case, default port dropped), or
 * null. Plain http is accepted only for loopback hosts.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value === '' || value === 'null') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin === 'null' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && loopbackHost(url.hostname)) return url.origin;
  return null;
}

/**
 * @param {{ allowed?: readonly string[], port: number }} options
 */
export function createOriginPolicy({ allowed = DEFAULT_ALLOWED_ORIGINS, port }) {
  const self = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  const cross = new Set();
  for (const entry of allowed) {
    const origin = normalizeOrigin(entry);
    if (origin === null) throw new TypeError(`allowedOrigins: ${JSON.stringify(entry)} is not an https origin (or an http loopback origin)`);
    if (!self.has(origin)) cross.add(origin);
  }
  return {
    /** The origin the self-served app runs on. */
    canonical: `http://127.0.0.1:${port}`,
    /** @param {string | null} origin */
    isSelf: (origin) => origin !== null && self.has(origin),
    /** @param {string | null} origin */
    isAllowed: (origin) => origin !== null && cross.has(origin),
    list: () => [...cross].sort(),
    /**
     * CORS headers for an allowed cross origin (empty for anything else).
     * @param {string | null} origin
     * @param {{ preflight?: boolean, privateNetwork?: boolean }} [options]
     * @returns {Record<string, string>}
     */
    corsHeaders(origin, { preflight = false, privateNetwork = false } = {}) {
      if (origin === null || !cross.has(origin)) return {};
      /** @type {Record<string, string>} */
      const headers = {
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Expose-Headers': 'X-Companion-Audit-Head',
      };
      if (preflight) {
        headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE';
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
        headers['Access-Control-Max-Age'] = '600';
        if (privateNetwork) headers['Access-Control-Allow-Private-Network'] = 'true';
      }
      return headers;
    },
  };
}

/** @typedef {ReturnType<typeof createOriginPolicy>} OriginPolicy */
