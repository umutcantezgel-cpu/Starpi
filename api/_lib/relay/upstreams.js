// @ts-check
// The fixed upstreams of the stateless relay: the providers it forwards to, the API root of each,
// the one auth header each expects, and the method and path pairs it accepts. The browser names a
// provider and a path; the host always comes from this table, so a local server, a custom URL or
// any other address can never be reached through the relay (no SSRF). Paths are checked as sent,
// still percent-encoded, so an escape cannot smuggle in another segment.
//
// For tests and local fakes, STARPI_<PROVIDER>_BASE_URL replaces an API root, but only with a
// loopback address (localhost, 127.0.0.1, [::1]); GET /api/health then reports the provider as
// simulated. The STARPI_ prefix keeps a developer's own SDK settings (such as a provider's
// <NAME>_BASE_URL for a local proxy) from redirecting the keys of the relay's users.

/**
 * @typedef {'bearer' | 'x-api-key' | 'x-goog-api-key' | 'xi-api-key' | 'x-subscription-token'} AuthStyle
 * @typedef {'json' | 'multipart'} BodyKind
 * @typedef {{ method: 'GET' | 'POST', path: RegExp, body?: readonly BodyKind[] }} UpstreamRoute
 * @typedef {object} Upstream
 * @property {string} id
 * @property {string} root API root without the version segment; a route's path follows it
 * @property {AuthStyle} auth
 * @property {readonly UpstreamRoute[]} routes
 * @property {readonly string[]} [extraHeaders] provider-specific request headers the relay forwards
 */

/** Request headers that carry credentials. Exactly one of them, the provider's own, may be present. */
export const CREDENTIAL_HEADERS = Object.freeze(['authorization', 'proxy-authorization', 'x-api-key', 'x-goog-api-key', 'xi-api-key', 'x-subscription-token', 'api-key']);

/**
 * anthropic-beta values the relay forwards; any other value is left out. Each one only switches on
 * a documented feature of the Messages API, and none can change where the request goes.
 */
export const KNOWN_ANTHROPIC_BETAS = Object.freeze([
  'server-side-fallback-2026-07-01',
  'server-side-fallback-2026-06-01',
  'compact-2026-01-12',
  'context-management-2025-06-27',
  'fast-mode-2026-02-01',
  'task-budgets-2026-03-13',
  'mid-conversation-output-config-2026-07-01',
  'mid-conversation-system-clear-at-2026-08-21',
  'thinking-display-updates-2026-08-18',
  'code-execution-2025-08-25',
  'mcp-client-2025-11-20',
  'structured-outputs-2025-11-13',
  'interleaved-thinking-2025-05-14',
  'context-1m-2025-08-07',
]);

/** @param {string} path */
const post = (path, body = /** @type {readonly BodyKind[]} */ (['json'])) => /** @type {UpstreamRoute} */ ({ method: 'POST', path: new RegExp(`^${path}$`), body });
/** @param {string} path */
const get = (path) => /** @type {UpstreamRoute} */ ({ method: 'GET', path: new RegExp(`^${path}$`) });

const CHAT = post('/v1/chat/completions');
// A Gemini model path: lower-case id, never a dot segment.
const GEMINI_MODEL = '/v1beta/models/[a-z0-9][a-z0-9.\\-]{0,99}';
const MODELS = get('/v1/models');
const TRANSCRIBE = post('/v1/audio/transcriptions', ['multipart']);
const SPEECH = post('/v1/audio/speech');

/** @type {Readonly<Record<string, Upstream>>} */
export const UPSTREAMS = Object.freeze({
  anthropic: {
    id: 'anthropic',
    root: 'https://api.anthropic.com',
    auth: 'x-api-key',
    routes: [post('/v1/messages'), post('/v1/messages/count_tokens'), MODELS, get('/v1/models/[a-z0-9][a-z0-9.-]{0,99}')],
  },
  openai: {
    id: 'openai',
    root: 'https://api.openai.com',
    auth: 'bearer',
    routes: [post('/v1/responses'), CHAT, MODELS, post('/v1/images/generations'), SPEECH, TRANSCRIBE],
  },
  gemini: {
    id: 'gemini',
    root: 'https://generativelanguage.googleapis.com',
    auth: 'x-goog-api-key',
    routes: [post(`${GEMINI_MODEL}:(?:stream)?[gG]enerateContent`), post(`${GEMINI_MODEL}:countTokens`), get('/v1beta/models'), get(GEMINI_MODEL)],
  },
  xai: {
    id: 'xai',
    root: 'https://api.x.ai',
    auth: 'bearer',
    routes: [CHAT, post('/v1/responses'), MODELS, post('/v1/images/generations')],
  },
  groq: {
    id: 'groq',
    root: 'https://api.groq.com/openai',
    auth: 'bearer',
    routes: [CHAT, MODELS, TRANSCRIBE, SPEECH],
  },
  mistral: {
    id: 'mistral',
    root: 'https://api.mistral.ai',
    auth: 'bearer',
    routes: [CHAT, MODELS, TRANSCRIBE],
  },
  deepseek: {
    id: 'deepseek',
    root: 'https://api.deepseek.com',
    auth: 'bearer',
    routes: [CHAT, MODELS],
  },
  // Chat Completions only: the catalog relies on no model list of this provider.
  minimax: {
    id: 'minimax',
    root: 'https://api.minimax.io',
    auth: 'bearer',
    routes: [CHAT],
  },
  openrouter: {
    id: 'openrouter',
    root: 'https://openrouter.ai/api',
    auth: 'bearer',
    routes: [CHAT, MODELS],
    // Optional app attribution, sent as the provider documents it.
    extraHeaders: ['http-referer', 'x-title'],
  },
  nvidia: {
    id: 'nvidia',
    root: 'https://integrate.api.nvidia.com',
    auth: 'bearer',
    routes: [CHAT, MODELS],
  },
  elevenlabs: {
    id: 'elevenlabs',
    root: 'https://api.elevenlabs.io',
    auth: 'xi-api-key',
    routes: [post('/v1/text-to-speech/[A-Za-z0-9]{1,64}(?:/stream)?'), get('/v1/voices'), get('/v2/voices'), MODELS],
  },
  brave: {
    id: 'brave',
    root: 'https://api.search.brave.com',
    auth: 'x-subscription-token',
    routes: [get('/res/v1/web/search')],
  },
  tavily: {
    id: 'tavily',
    root: 'https://api.tavily.com',
    auth: 'bearer',
    routes: [post('/search')],
  },
});

export const RELAY_PROVIDERS = Object.freeze(Object.keys(UPSTREAMS));

/**
 * @param {string} id
 * @returns {Upstream | null}
 */
export function findUpstream(id) {
  return Object.hasOwn(UPSTREAMS, id) ? UPSTREAMS[id] : null;
}

/**
 * The route of a provider that answers a method and a path, or why there is none.
 * @param {Upstream} upstream
 * @param {string} method
 * @param {string} path as sent, starting with "/"
 * @returns {{ ok: true, route: UpstreamRoute } | { ok: false, status: 404 | 405, error: 'path_not_allowed' | 'method_not_allowed' }}
 */
export function matchUpstreamRoute(upstream, method, path) {
  const routes = upstream.routes.filter((r) => r.path.test(path));
  const route = routes.find((r) => r.method === method);
  if (route) return { ok: true, route };
  return routes.length > 0 ? { ok: false, status: 405, error: 'method_not_allowed' } : { ok: false, status: 404, error: 'path_not_allowed' };
}

/**
 * The header that carries a key in the provider's own style.
 * @param {AuthStyle} style
 * @param {string} key
 * @returns {[string, string]}
 */
export function authHeaderFor(style, key) {
  return style === 'bearer' ? ['authorization', `Bearer ${key}`] : [style, key];
}

/** Environment variable that points a provider at a local fake. */
export const baseUrlVariable = (/** @type {string} */ id) => `STARPI_${id.toUpperCase()}_BASE_URL`;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A loopback http(s) URL without credentials, query or fragment, as an API root without a trailing
 * slash; null for anything else (which is then ignored).
 * @param {string | undefined} raw
 * @returns {string | null}
 */
export function parseLoopbackRoot(raw) {
  const url = URL.parse((raw ?? '').trim());
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !LOOPBACK.has(url.hostname)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, '');
}

/**
 * The API root of a provider: its fixed root, or a loopback fake from STARPI_<ID>_BASE_URL.
 * @param {string} id
 * @param {string} fixedRoot
 * @param {Record<string, string | undefined>} env
 * @returns {{ root: string, simulated: boolean }}
 */
export function resolveRoot(id, fixedRoot, env) {
  const fake = parseLoopbackRoot(env[baseUrlVariable(id)]);
  return fake ? { root: fake, simulated: true } : { root: fixedRoot, simulated: false };
}
