// @ts-check
// How a request reaches a provider. A transport sends what a wire adapter built and returns the
// raw Response (the stream driver reads status and body); for SDK adapters it also offers a
// `fetch` and a `baseURL` that route the SDK's own requests the same way.
//
// - directTransport: browser to provider, key in the provider's header
// - relayTransport:  browser to this site's stateless relay (/api/relay/<provider><path>), the key
//                    travels per request in the provider's native header; besides the model
//                    providers the relay serves the voice and search services (ServiceId)
// - poolTransport:   browser to this site's key pools (/api/pool), no key in the browser
//
// A site may ask for an access code (GET /api/health reports `access: true`); relay and pool
// transports then send it in the x-starpi-access header (`options.access`). A direct call never
// carries it, so the code only ever goes to this site.
//
// Paths: an adapter builds the path below the provider's API root, as the relay's allowlist sees it
// (/v1/messages, /v1/chat/completions, /v1beta/models/<id>:streamGenerateContent?alt=sse). A
// direct base URL is that root without the version segment (https://api.example.com, or
// https://api.example.com/openai for a provider whose API lives under a prefix), so one built
// request works on every transport.
//
// Every transport fetches with redirect: 'error' and the caller's AbortSignal, refuses keys in the
// URL, strips any auth header an adapter or SDK set and adds its own. A fetch that throws before
// any answer becomes an AiError: `cors` for a direct call (the usual cause in a browser is a
// provider that does not allow cross-origin calls), `network` for this site's own endpoints.
import { AiError, toAiError } from './errors.js';

/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {'elevenlabs' | 'brave' | 'tavily'} ServiceId */
/** @typedef {ProviderId | ServiceId} RelayTarget */
/** @typedef {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} FetchLike */
/** @typedef {(key: string) => [string, string]} AuthHeaderFn */

/**
 * What a wire adapter builds: a path relative to the provider's base URL (it may carry a query),
 * headers without auth, and a body (objects are sent as JSON).
 * @typedef {object} BuiltRequest
 * @property {string} path
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]
 */

/**
 * @typedef {object} TransportInfo
 * @property {'direct' | 'relay' | 'pool'} kind
 * @property {RelayTarget | null} provider
 * @property {string} baseURL   absolute when an origin is known; SDK adapters send their requests below it
 * @property {FetchLike} fetch  for SDK adapters: applies this transport's auth and guards
 */

/**
 * @typedef {((adapter: { authHeader?: AuthHeaderFn } | null | undefined, built: BuiltRequest, options?: { signal?: AbortSignal }) => Promise<Response>) & TransportInfo} Transport
 */

/**
 * @typedef {object} TransportOptions
 * @property {FetchLike} [fetch]   defaults to globalThis.fetch, looked up at call time
 * @property {string} [origin]     origin of this site, for the relay and pool (defaults to location.origin)
 * @property {string | (() => string)} [access]  the site's access code, for the relay and pool (read per request)
 */

export const RELAY_BASE_PATH = '/api/relay';
export const POOL_ENDPOINT = '/api/pool';
/** Header that carries the site's access code to its own endpoints. */
export const ACCESS_HEADER = 'x-starpi-access';

/** Header names that carry credentials; adapters and SDKs never get to set them. */
export const AUTH_HEADER_NAMES = Object.freeze(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'xi-api-key', 'x-subscription-token', 'cookie', ACCESS_HEADER]);

/** Providers and services whose native auth header is not `Authorization: Bearer`. */
const NATIVE_AUTH = /** @type {Readonly<Partial<Record<RelayTarget, string>>>} */ (
  Object.freeze({ anthropic: 'x-api-key', gemini: 'x-goog-api-key', elevenlabs: 'xi-api-key', brave: 'x-subscription-token' })
);

/** Providers the site can relay or pool; local servers and in-browser engines never leave the device. */
const REMOTE_PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'openrouter', 'nvidia']);
/** Voice and search services the relay also forwards to (never pooled). */
export const RELAY_SERVICES = /** @type {readonly ServiceId[]} */ (Object.freeze(['elevenlabs', 'brave', 'tavily']));
const RELAY_TARGETS = new Set([...REMOTE_PROVIDERS, ...RELAY_SERVICES]);

/** Printable ASCII without spaces: anything else would break or inject a header. */
const KEY_PATTERN = /^[\x21-\x7e]{1,1024}$/;
/** An access code as a header value: printable ASCII, inner spaces allowed. */
const ACCESS_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;
/** A path below the base URL: one leading slash, no parent segments, no backslashes, no fragment. */
const PATH_PATTERN = /^\/(?!\/)[^\s\\#]*$/;
const KEY_IN_QUERY = /[?&](?:key|api[_-]?key|access[_-]?token)=/i;

/**
 * The provider's (or service's) own auth header for a key.
 * @param {string} provider
 * @param {string} key
 * @returns {[string, string]}
 */
export function nativeAuthHeader(provider, key) {
  const name = NATIVE_AUTH[/** @type {RelayTarget} */ (provider)];
  return name ? [name, key] : ['authorization', `Bearer ${key}`];
}

/**
 * @param {string | AuthHeaderFn | undefined} spec
 * @returns {AuthHeaderFn | null}
 */
function authFrom(spec) {
  if (typeof spec === 'function') return spec;
  if (typeof spec !== 'string' || !spec) return null;
  const name = spec.toLowerCase();
  return name === 'authorization' ? (key) => ['authorization', `Bearer ${key}`] : (key) => [name, key];
}

/**
 * @param {string | null | undefined} key
 * @param {string | null} provider
 * @returns {string}
 */
function checkedKey(key, provider) {
  const value = typeof key === 'string' ? key.trim() : '';
  if (!KEY_PATTERN.test(value)) throw new AiError('auth', { provider });
  return value;
}

/**
 * @param {unknown} path
 * @param {string | null} provider
 * @returns {string}
 */
function checkedPath(path, provider) {
  if (typeof path !== 'string' || !PATH_PATTERN.test(path) || /(?:^|\/)\.\.?(?:\/|$|\?)/.test(path) || KEY_IN_QUERY.test(path)) {
    throw new AiError('bad_request', { provider });
  }
  return path;
}

/**
 * @param {HeadersInit | undefined} source
 */
function withoutAuth(source) {
  const headers = new Headers(source);
  for (const name of AUTH_HEADER_NAMES) headers.delete(name);
  return headers;
}

/**
 * @param {unknown} body
 * @param {Headers} headers
 * @returns {BodyInit | undefined}
 */
function encodeBody(body, headers) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return /** @type {BodyInit} */ (body);
  if ((typeof Blob !== 'undefined' && body instanceof Blob) || (typeof FormData !== 'undefined' && body instanceof FormData)) return body;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body;
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return JSON.stringify(body);
}

/**
 * @param {string} trimmed
 */
const trimSlash = (trimmed) => trimmed.replace(/\/+$/, '');

/**
 * @typedef {object} TransportSpec
 * @property {'direct' | 'relay' | 'pool'} kind
 * @property {RelayTarget | null} provider
 * @property {string} baseURL
 * @property {(path: string) => string} urlFor          URL of a wire request's path
 * @property {(url: string) => string | null} rewrite   URL an SDK request goes to; null when outside baseURL
 * @property {(adapter: { authHeader?: AuthHeaderFn } | null | undefined) => [string, string] | null} auth
 * @property {RequestCredentials} credentials
 * @property {FetchLike} fetchImpl
 * @property {() => string} [access]  the site's access code ('' for none)
 */

/**
 * @param {TransportSpec} spec
 * @returns {Transport}
 */
function makeTransport(spec) {
  const { kind, provider } = spec;
  const beforeResponse = kind === 'direct' ? 'cors' : 'network';

  /**
   * @param {string} url
   * @param {RequestInit} init
   */
  const guarded = async (url, init) => {
    try {
      return await spec.fetchImpl(url, { ...init, redirect: 'error', credentials: spec.credentials });
    } catch (err) {
      throw toAiError(err, { provider, signal: init.signal, beforeResponse });
    }
  };

  /**
   * @param {Headers} headers
   * @param {{ authHeader?: AuthHeaderFn } | null | undefined} adapter
   */
  const authorize = (headers, adapter) => {
    const pair = spec.auth(adapter);
    if (pair) headers.set(pair[0], pair[1]);
    const code = spec.access?.().trim() ?? '';
    if (code && ACCESS_PATTERN.test(code)) headers.set(ACCESS_HEADER, code);
  };

  /** @type {(adapter: { authHeader?: AuthHeaderFn } | null | undefined, built: BuiltRequest, options?: { signal?: AbortSignal }) => Promise<Response>} */
  const send = async (adapter, built, options = {}) => {
    const path = checkedPath(built?.path, provider);
    const headers = withoutAuth(built.headers);
    authorize(headers, adapter);
    const body = encodeBody(built.body, headers);
    return guarded(spec.urlFor(path), { method: built.method ?? (body === undefined ? 'GET' : 'POST'), headers, body, signal: options.signal });
  };

  /** @type {FetchLike} */
  const sdkFetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = spec.rewrite(raw);
    if (url === null || KEY_IN_QUERY.test(raw)) throw new AiError('bad_request', { provider });
    const headers = withoutAuth(init.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
    authorize(headers, null);
    return guarded(url, { ...init, headers });
  };

  return Object.assign(send, { kind, provider, baseURL: spec.baseURL, fetch: sdkFetch });
}

/**
 * @param {TransportOptions} options
 * @returns {FetchLike}
 */
function fetchFrom(options) {
  return options.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

/**
 * @param {TransportOptions} options
 */
function siteOrigin(options) {
  const origin = options.origin ?? /** @type {{ location?: { origin?: string } }} */ (globalThis).location?.origin ?? '';
  return origin === 'null' ? '' : trimSlash(origin);
}

/**
 * @param {string} provider
 */
function remoteProvider(provider) {
  if (!REMOTE_PROVIDERS.has(provider)) throw new TypeError(`Provider ${String(provider).slice(0, 40)} cannot go through this site`);
  return /** @type {ProviderId} */ (provider);
}

/**
 * @param {string} target
 */
function relayTarget(target) {
  if (!RELAY_TARGETS.has(target)) throw new TypeError(`Provider ${String(target).slice(0, 40)} cannot go through this site`);
  return /** @type {RelayTarget} */ (target);
}

/**
 * @param {TransportOptions} options
 * @returns {() => string}
 */
function accessFrom(options) {
  const { access } = options;
  return typeof access === 'function' ? () => String(access() ?? '') : () => access ?? '';
}

/**
 * Browser straight to the provider. `baseUrl` is the API root (see the paths note above).
 * `authHeader` is a header name ('authorization' sends a Bearer token) or a function returning
 * [name, value]; without it the adapter's authHeader() is used, else the native header of
 * `options.provider` (which also covers SDK requests, where no adapter is at hand), else Bearer.
 * Without a key (a local server that needs none) no auth header is sent.
 * @param {string} baseUrl e.g. https://api.example.com
 * @param {string | null | undefined} key
 * @param {string | AuthHeaderFn} [authHeader]
 * @param {TransportOptions & { provider?: ProviderId }} [options]
 * @returns {Transport}
 */
export function directTransport(baseUrl, key, authHeader, options = {}) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError('directTransport needs an absolute base URL');
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('directTransport needs an http(s) base URL without credentials, query or fragment');
  }
  const base = trimSlash(parsed.href);
  const provider = options.provider ?? null;
  const fixed = authFrom(authHeader);
  const hasKey = key !== null && key !== undefined && key !== '';
  return makeTransport({
    kind: 'direct',
    provider,
    baseURL: base,
    urlFor: (path) => base + path,
    rewrite: (url) => (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`) ? url : null),
    auth: (adapter) => {
      if (!hasKey) return null;
      const value = checkedKey(key, provider);
      const fn = fixed ?? adapter?.authHeader ?? ((/** @type {string} */ k) => nativeAuthHeader(provider ?? '', k));
      return fn(value);
    },
    credentials: 'omit',
    fetchImpl: fetchFrom(options),
  });
}

/**
 * Browser to this site's relay, which forwards to the provider and keeps nothing. The key goes in
 * the provider's native header, as it would on a direct call (xi-api-key for ElevenLabs,
 * x-subscription-token for Brave Search, Bearer for Tavily).
 * @param {string} providerId a model provider or a service (RELAY_SERVICES)
 * @param {string} key
 * @param {TransportOptions & { basePath?: string }} [options]
 * @returns {Transport}
 */
export function relayTransport(providerId, key, options = {}) {
  const provider = relayTarget(providerId);
  const prefix = `${siteOrigin(options)}${trimSlash(options.basePath ?? RELAY_BASE_PATH)}/${provider}`;
  return makeTransport({
    kind: 'relay',
    provider,
    baseURL: prefix,
    urlFor: (path) => prefix + path,
    rewrite: (url) => (url.startsWith(`${prefix}/`) ? url : null),
    auth: () => nativeAuthHeader(provider, checkedKey(key, provider)),
    credentials: 'same-origin',
    fetchImpl: fetchFrom(options),
    access: accessFrom(options),
  });
}

/**
 * Browser to this site's key pools. No key leaves the browser; the pool picks one of the site's
 * keys. The provider and the upstream path travel as query parameters of one endpoint.
 * @param {string} providerId
 * @param {TransportOptions & { endpoint?: string }} [options]
 * @returns {Transport}
 */
export function poolTransport(providerId, options = {}) {
  const provider = remoteProvider(providerId);
  const endpoint = `${siteOrigin(options)}${trimSlash(options.endpoint ?? POOL_ENDPOINT)}`;
  const base = `${endpoint}/${provider}`;
  /** @param {string} path */
  const urlFor = (path) => `${endpoint}?${new URLSearchParams({ provider, path })}`;
  return makeTransport({
    kind: 'pool',
    provider,
    baseURL: base,
    urlFor,
    rewrite: (url) => (url.startsWith(`${base}/`) ? urlFor(checkedPath(url.slice(base.length), provider)) : null),
    auth: () => null,
    credentials: 'same-origin',
    fetchImpl: fetchFrom(options),
    access: accessFrom(options),
  });
}
