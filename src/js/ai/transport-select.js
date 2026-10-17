// @ts-check
// Which way a call to a provider goes, and the setting and memory behind that choice.
//
//   direct  the provider allows browser calls (Anthropic with its browser-access header, OpenAI,
//           Gemini, OpenRouter): the browser calls it with the user's key
//   auto    providers that may block browsers (xAI, Groq, Mistral, DeepSeek): the first call goes
//           direct; when it is blocked before any answer (an AiError `cors`) it is sent once more
//           through this site's relay, if the setting "use the relay for providers that block
//           browsers" is on (the default). The outcome is remembered per provider in localStorage
//           (starpi_transport_<id>), so a provider that needs the relay goes there right away
//   relay   always through the relay (a pool-only provider used with the user's own key)
//   pool    no key of the user's: the site's key pool for that provider, when it has keys
//   device  a local server is always called direct (the relay cannot and must not reach the
//           user's network); in-browser engines need no transport at all
//
// The site's access code (GET /api/health `access: true`) travels with every relay and pool
// call, never with a direct one. Pool availability comes from GET /api/models/pool.
import { DEFAULT_LLM_URL, STORAGE_KEYS } from '../config.js';
import { readLocal, removeLocal, writeLocal } from '../storage.js';
import { isPoolId } from './catalog/pools.js';
import { getProvider, localApiRoot, PROVIDER_ORDER } from './catalog/providers.js';
import { AiError, fromHttp, MAX_ERROR_SNIPPET_CHARS, toAiError } from './errors.js';
import { healthClient } from './health-client.js';
import { setTransportResolver } from './index.js';
import { ACCESS_SLOT, getKey } from './keys.js';
import { directTransport, poolTransport, RELAY_SERVICES, relayTransport } from './transport.js';

/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {import('./errors.js').AiErrorCode} AiErrorCode */
/** @typedef {import('./transport.js').Transport} Transport */
/** @typedef {import('./transport.js').FetchLike} FetchLike */
/** @typedef {import('./transport.js').ServiceId} ServiceId */
/** @typedef {import('./transport.js').BuiltRequest} BuiltRequest */

/** @typedef {'direct' | 'auto' | 'relay' | 'pool' | 'device' | 'none'} Route */
/** @typedef {'unknown' | 'no_key' | 'relay_off' | 'no_server' | 'in_browser'} RouteReason */
/** @typedef {{ route: Route, reason?: RouteReason }} TransportPlan */

/**
 * @typedef {object} MemoryStore  where the relay setting and the remembered routes live (default: localStorage)
 * @property {(key: string) => string | null} read
 * @property {(key: string, value: string) => boolean} write
 * @property {(key: string) => void} remove
 */

/**
 * @typedef {object} SelectOptions
 * @property {string | null} [key]           the user's key ('' or null: none)
 * @property {boolean | null} [pool]         the site's pool for this provider has keys
 * @property {string | null} [baseUrl]       a local server's URL
 * @property {string | (() => string)} [access]  the site's access code
 * @property {boolean} [relay]               overrides the relay setting
 * @property {MemoryStore} [memory]
 * @property {FetchLike} [fetch]
 * @property {string} [origin]
 */

/**
 * @typedef {Transport & { route: () => 'direct' | 'relay' }} AutoTransport
 */

/** localStorage: '0' turns the relay fallback off; anything else (or nothing) leaves it on. */
export const RELAY_SETTING_KEY = 'starpi_relay_fallback';
export const TRANSPORT_MEMORY_PREFIX = 'starpi_transport_';
export const POOL_MODELS_URL = '/api/models/pool';
const POOL_TIMEOUT_MS = 8_000;
const MAX_POOL_CHARS = 262_144;
const TEST_TIMEOUT_MS = 15_000;

/**
 * Voice and search services: how a direct call reaches them. Brave Search does not answer browser
 * calls, so it always goes through the relay; the others are tried direct first.
 * @type {Readonly<Record<ServiceId, { baseUrl: string, transport: 'auto' | 'relay', authHeader: string }>>}
 */
export const SERVICES = Object.freeze({
  elevenlabs: Object.freeze({ baseUrl: 'https://api.elevenlabs.io', transport: 'auto', authHeader: 'xi-api-key' }),
  brave: Object.freeze({ baseUrl: 'https://api.search.brave.com', transport: 'relay', authHeader: 'x-subscription-token' }),
  tavily: Object.freeze({ baseUrl: 'https://api.tavily.com', transport: 'auto', authHeader: 'authorization' }),
});

/** @type {MemoryStore} */
const LOCAL_MEMORY = { read: readLocal, write: writeLocal, remove: removeLocal };

/**
 * @param {unknown} id
 * @returns {id is ServiceId}
 */
function isService(id) {
  return typeof id === 'string' && /** @type {readonly string[]} */ (RELAY_SERVICES).includes(id);
}

/**
 * Whether failed direct calls may go through the relay (default on).
 * @param {MemoryStore} [memory]
 */
export function relayEnabled(memory = LOCAL_MEMORY) {
  return memory.read(RELAY_SETTING_KEY) !== '0';
}

/**
 * @param {boolean} on
 * @param {MemoryStore} [memory]
 * @returns {boolean} whether the browser stored it
 */
export function setRelayEnabled(on, memory = LOCAL_MEMORY) {
  if (on) {
    memory.remove(RELAY_SETTING_KEY);
    return memory.read(RELAY_SETTING_KEY) === null;
  }
  return memory.write(RELAY_SETTING_KEY, '0');
}

/**
 * The route an auto provider took last time: 'direct', 'relay' or null when not known yet.
 * @param {string} id
 * @param {MemoryStore} [memory]
 * @returns {'direct' | 'relay' | null}
 */
export function rememberedTransport(id, memory = LOCAL_MEMORY) {
  const value = memory.read(TRANSPORT_MEMORY_PREFIX + id);
  return value === 'direct' || value === 'relay' ? value : null;
}

/**
 * Forgets the remembered routes (of one provider, or of all).
 * @param {string} [id]
 * @param {MemoryStore} [memory]
 */
export function forgetTransports(id, memory = LOCAL_MEMORY) {
  const ids = id ? [id] : [...PROVIDER_ORDER, ...RELAY_SERVICES];
  for (const one of ids) memory.remove(TRANSPORT_MEMORY_PREFIX + one);
}

/**
 * How a provider (or service) would be reached with these options, without building anything.
 * @param {string} id
 * @param {SelectOptions} [opts]
 * @returns {TransportPlan}
 */
export function planTransport(id, opts = {}) {
  const memory = opts.memory ?? LOCAL_MEMORY;
  const relayOn = opts.relay ?? relayEnabled(memory);
  const info = getProvider(id);
  const service = isService(id) ? SERVICES[id] : null;
  if (!info && !service) return { route: 'none', reason: 'unknown' };
  const mode = info?.transport ?? /** @type {'auto' | 'relay'} */ (service?.transport);
  if (mode === 'device') {
    if (id !== 'local') return { route: 'device', reason: 'in_browser' };
    return opts.baseUrl && localApiRoot(opts.baseUrl) ? { route: 'direct' } : { route: 'none', reason: 'no_server' };
  }
  const hasKey = typeof opts.key === 'string' && opts.key.trim() !== '';
  if (!hasKey) {
    if (info?.pool && isPoolId(id) && opts.pool === true) return { route: 'pool' };
    return { route: 'none', reason: 'no_key' };
  }
  if (mode === 'direct') return { route: 'direct' };
  if (mode === 'auto') {
    if (!relayOn) return { route: 'direct' };
    return rememberedTransport(id, memory) === 'relay' ? { route: 'relay' } : { route: 'auto' };
  }
  // 'relay', or 'pool' with the user's own key: the provider does not answer browser calls.
  return relayOn ? { route: 'relay' } : { route: 'none', reason: 'relay_off' };
}

/**
 * @param {Response} res
 */
function relayMissing(res) {
  const type = res.headers.get('content-type') ?? '';
  // A static host without the site's functions answers 404/405, or its HTML page.
  return /^text\/html/i.test(type) || ((res.status === 404 || res.status === 405) && !/json/i.test(type));
}

/**
 * Direct first; a call blocked before any answer goes once more through the relay. The route
 * that answered is remembered.
 * @param {string} id
 * @param {Transport} direct
 * @param {Transport} relay
 * @param {MemoryStore} memory
 * @returns {AutoTransport}
 */
function autoTransport(id, direct, relay, memory) {
  /** @type {'direct' | 'relay'} */
  let last = 'direct';
  /** @param {'direct' | 'relay'} route */
  const remember = (route) => {
    last = route;
    memory.write(TRANSPORT_MEMORY_PREFIX + id, route);
  };
  /**
   * @param {() => Promise<Response>} first
   * @param {() => Promise<Response>} viaRelay
   * @param {AbortSignal | null | undefined} signal
   */
  const run = async (first, viaRelay, signal) => {
    try {
      const res = await first();
      remember('direct');
      return res;
    } catch (err) {
      if (!(err instanceof AiError) || err.code !== 'cors' || signal?.aborted) throw err;
      const res = await viaRelay();
      if (relayMissing(res)) {
        void res.body?.cancel().catch(() => {});
        throw err;
      }
      remember('relay');
      return res;
    }
  };
  /** @type {Transport['fetch']} */
  const sdkFetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const relayUrl = url.startsWith(direct.baseURL) ? relay.baseURL + url.slice(direct.baseURL.length) : url;
    return run(
      () => direct.fetch(input, init),
      () => relay.fetch(relayUrl, init),
      init.signal,
    );
  };
  /** @type {(adapter: Parameters<Transport>[0], built: BuiltRequest, options?: { signal?: AbortSignal }) => Promise<Response>} */
  const send = (adapter, built, options = {}) =>
    run(
      () => direct(adapter, built, options),
      () => relay(adapter, built, options),
      options.signal,
    );
  return Object.assign(send, { kind: /** @type {const} */ ('direct'), provider: direct.provider, baseURL: direct.baseURL, fetch: sdkFetch, route: () => last });
}

/**
 * The transport for a call, following planTransport(). Null when the provider cannot be reached
 * that way (no key and no pool, the relay switched off, no local server) and for in-browser engines,
 * which need none.
 * @param {string} id
 * @param {SelectOptions} [opts]
 * @returns {Transport | AutoTransport | null}
 */
export function selectTransport(id, opts = {}) {
  const plan = planTransport(id, opts);
  const memory = opts.memory ?? LOCAL_MEMORY;
  const site = { fetch: opts.fetch, origin: opts.origin, access: opts.access };
  const key = typeof opts.key === 'string' ? opts.key.trim() : '';
  const info = getProvider(id);
  const service = isService(id) ? SERVICES[id] : null;
  switch (plan.route) {
    case 'direct':
    case 'auto': {
      if (id === 'local') return directTransport(/** @type {string} */ (localApiRoot(opts.baseUrl ?? '')), key || null, 'authorization', { provider: 'local', fetch: opts.fetch });
      const baseUrl = /** @type {string} */ (info?.baseUrl ?? service?.baseUrl);
      const authHeader = info?.authHeader ?? service?.authHeader ?? undefined;
      const direct = directTransport(baseUrl, key, authHeader, { provider: info ? /** @type {ProviderId} */ (id) : undefined, fetch: opts.fetch });
      return plan.route === 'direct' ? direct : autoTransport(id, direct, relayTransport(id, key, site), memory);
    }
    case 'relay':
      return relayTransport(id, key, site);
    case 'pool':
      return poolTransport(id, site);
    default:
      return null;
  }
}

/**
 * @typedef {object} PoolStatus
 * @property {boolean} configured
 * @property {string | null} defaultModel
 * @property {string[]} models
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads GET /api/models/pool (`{ version, pools: { <id>: { configured, defaultModel, models } } }`).
 * Only known pools and short model ids are kept.
 * @param {unknown} json
 * @returns {Record<string, PoolStatus> | null} null when the body is not a pool list
 */
export function parsePoolCatalog(json) {
  if (!isRecord(json) || !isRecord(json.pools)) return null;
  /** @type {Record<string, PoolStatus>} */
  const out = {};
  for (const [id, entry] of Object.entries(json.pools)) {
    if (!isPoolId(id) || !isRecord(entry)) continue;
    const ids = (Array.isArray(entry.models) ? entry.models : []).map((m) => (typeof m === 'string' ? m : isRecord(m) ? m.id : null)).filter((m) => typeof m === 'string' && m.length > 0 && m.length <= 200);
    out[id] = {
      configured: entry.configured === true,
      defaultModel: typeof entry.defaultModel === 'string' && entry.defaultModel.length <= 200 ? entry.defaultModel : null,
      models: /** @type {string[]} */ ([...new Set(ids)].slice(0, 100)),
    };
  }
  return out;
}

/** @type {Record<string, PoolStatus> | null} */
let sitePools = null;

/**
 * Asks the site which pools have keys. Never rejects: without the site's functions (a static host,
 * no network) it reports `reachable: false`. The answer is kept for poolAvailable().
 * @param {{ fetch?: FetchLike, url?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ reachable: boolean, pools: Record<string, PoolStatus> }>}
 */
export async function fetchPools(opts = {}) {
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  try {
    const res = await doFetch(opts.url ?? POOL_MODELS_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? POOL_TIMEOUT_MS),
    });
    if (!res.ok || !/json/i.test(res.headers.get('content-type') ?? '')) {
      void res.body?.cancel().catch(() => {});
      return { reachable: false, pools: {} };
    }
    const text = await res.text();
    const pools = text.length <= MAX_POOL_CHARS ? parsePoolCatalog(JSON.parse(text)) : null;
    if (!pools) return { reachable: false, pools: {} };
    sitePools = pools;
    return { reachable: true, pools };
  } catch {
    return { reachable: false, pools: {} };
  }
}

/**
 * Whether the site's pool for a provider has keys: from the last pool list, else from the last
 * health answer; null while neither has been read.
 * @param {string} id
 * @returns {boolean | null}
 */
export function poolAvailable(id) {
  if (!isPoolId(id)) return false;
  if (sitePools) return sitePools[id]?.configured === true;
  return healthClient.pool(id);
}

/**
 * Headers a provider's model list needs besides the key.
 * @param {string} id
 * @returns {Record<string, string>}
 */
function listHeaders(id) {
  return id === 'anthropic' ? { accept: 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : { accept: 'application/json' };
}

/**
 * @typedef {{ ok: true, via: 'direct' | 'relay', status: number } | { ok: false, code: AiErrorCode, via: 'direct' | 'relay' | null, status: number }} KeyTestResult
 */

/**
 * Tests a key with the provider's model list (GET /models) through the transport a call would take.
 * Only the outcome is kept: ok, or an error code (never the provider's error text).
 * @param {string} id a provider id
 * @param {string} key '' for a local server without a key
 * @param {SelectOptions & { signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<KeyTestResult>}
 */
export async function testKey(id, key, opts = {}) {
  const info = getProvider(id);
  if (!info?.modelsPath) return { ok: false, code: 'bad_request', via: null, status: 0 };
  const transport = selectTransport(id, { ...opts, key, pool: false });
  if (!transport) return { ok: false, code: planTransport(id, { ...opts, key, pool: false }).reason === 'relay_off' ? 'cors' : 'auth', via: null, status: 0 };
  const via = () => ('route' in transport ? transport.route() : transport.kind === 'relay' ? 'relay' : 'direct');
  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? TEST_TIMEOUT_MS);
  try {
    const res = await transport(null, { path: info.modelsPath, method: 'GET', headers: listHeaders(id) }, { signal });
    if (res.ok) {
      void res.body?.cancel().catch(() => {});
      return { ok: true, via: via(), status: res.status };
    }
    const snippet = (await res.text().catch(() => '')).slice(0, MAX_ERROR_SNIPPET_CHARS);
    const err = fromHttp(res.status, res.headers, snippet, { provider: id });
    return { ok: false, code: err.code, via: via(), status: err.status };
  } catch (err) {
    const error = toAiError(err, { provider: id, signal });
    return { ok: false, code: error.code, via: null, status: error.status };
  }
}

/**
 * @typedef {object} ResolverDeps
 * @property {(slot: string) => string} [getKey]
 * @property {(id: string) => boolean | null} [pool]
 * @property {() => string} [localUrl]
 * @property {MemoryStore} [memory]
 * @property {FetchLike} [fetch]
 * @property {string} [origin]
 */

/**
 * The resolver complete() asks for a transport (src/js/ai/index.js): the user's key, the site's
 * pools, the relay setting and the remembered routes. A provider that cannot be reached fails the
 * call with `auth` (no key and no pool) or `cors` (it needs the relay, which is switched off).
 * @param {ResolverDeps} [deps]
 * @returns {import('./index.js').TransportResolver}
 */
export function createTransportResolver(deps = {}) {
  const keyOf = deps.getKey ?? getKey;
  const pool = deps.pool ?? poolAvailable;
  const localUrl = deps.localUrl ?? (() => readLocal(STORAGE_KEYS.llmUrl) || DEFAULT_LLM_URL);
  return (provider) => {
    /** @type {SelectOptions} */
    const opts = { key: keyOf(provider), pool: pool(provider), baseUrl: provider === 'local' ? localUrl() : null, access: () => keyOf(ACCESS_SLOT), memory: deps.memory, fetch: deps.fetch, origin: deps.origin };
    const plan = planTransport(provider, opts);
    if (plan.route === 'none') throw new AiError(plan.reason === 'relay_off' ? 'cors' : plan.reason === 'no_server' ? 'network' : 'auth', { provider });
    return selectTransport(provider, opts);
  };
}

/**
 * Installs the resolver for every complete() call of this page.
 * @param {ResolverDeps} [deps]
 */
export function installTransportResolver(deps) {
  setTransportResolver(createTransportResolver(deps));
}
