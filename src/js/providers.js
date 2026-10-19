// @ts-check
// The AI layer as the app sees it (src/js/ai/**): which providers are set up, how each one is
// reached, and the loader of the parts a chat call needs. This module stays small because the shell
// imports it at start: the adapters, the router and the model catalog load with chat/runner.js,
// after the first paint (refreshProviders, loadRunner).
//
// Set up means: a key of the user's (ai/keys.js; the providers view in Settings manages them), a
// pool of this site with keys (GET /api/models/pool), the user's own server (a saved URL), or the
// model on this device. refreshProviders() runs at start and whenever keys, the vault, the own
// server or the pools change; it installs the adapters, the transport resolver and the router's
// world (configureRouter: configured providers, live model lists, capabilities, the loaded
// on-device model) and tells the listeners (model picker, privacy notice).
//
// Keys never leave the browser except to their provider (direct) or through the stateless relay;
// pool calls carry no key at all.
//
// The paired companion (Starpi Core) is a provider of its own: offered once this browser is paired
// (the flag companion/pair.js keeps in localStorage while a link is stored, so a browser that never
// paired opens no database for it), reached through the pairing, never part of Auto and never
// asked for a purpose (titles, OCR, council).
import { COMPANION_MODEL, getProvider, PROVIDER_ORDER } from './ai/catalog/providers.js';
import { POOLS } from './ai/catalog/pools.js';
import { hasKey, onKeysChange } from './ai/keys.js';
import { STORAGE_KEYS, TIMEOUTS_MS } from './config.js';
import { t } from './i18n/index.js';
import { findNvidiaModel } from './models/nvidia-catalog.js';
import { WASM_CATALOG } from './models/wasm-catalog.js';
import { onLlmUrlChange } from './state.js';
import { readLocal } from './storage.js';
import { MODEL_CATALOG } from './webgpu/models.js';

/** @typedef {import('./ai/contract.js').ProviderId} ProviderId */
/** @typedef {import('./ai/catalog/pools.js').PoolId} PoolId */
/** @typedef {import('./models/choices.js').ModelOption} ModelOption */
/** @typedef {import('./models/choices.js').PoolState} PoolState */

/**
 * How a call to a provider goes: the user's key, this site's pool, the user's own server, the
 * engine in this browser, or the paired companion on this machine; 'none' when it cannot be reached.
 * @typedef {'key' | 'pool' | 'local' | 'device' | 'companion' | 'none'} Route
 */

/**
 * What is set up, for the pickers and the chat.
 * @typedef {object} ProviderState
 * @property {ProviderId[]} keyed           providers with a key of the user's, in picker order
 * @property {Partial<Record<PoolId, PoolState>> | null} pools  null while the site has not answered
 * @property {boolean} server               the user saved the address of their own server
 * @property {string[]} serverModels        models the own server listed (empty while unknown)
 * @property {Partial<Record<ProviderId, ModelOption[]>>} models  model lists of the keyed providers
 * @property {boolean} ready                the AI layer is installed (adapters, resolver, router)
 * @property {boolean} companion            a companion is paired with this browser
 */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, notConfigured?: boolean, cause?: unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message, { cause: info.cause });
    this.name = 'ProviderError';
    this.status = info.status;
    this.notConfigured = info.notConfigured ?? false;
  }
}

// Exactly the plain-http hosts the CSP connect-src allows. CSP host sources cannot express IPv6
// literals, so http://[::1] would pass here and then be blocked by the browser.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Validates a user-supplied Chat Completions base URL: https anywhere, plain http only on loopback.
 * @param {string} value
 * @returns {string} normalized URL without trailing slash
 */
export function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProviderError(t('provider.invalid_url'));
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ProviderError(t('provider.insecure_url'));
  }
  if (url.username || url.password) throw new ProviderError(t('provider.credentials_in_url'));
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/** Model ids the own server's GET /models listed, per server URL. */
const serverModels = new Map();

/**
 * Checks the own server and remembers the models it lists: servers such as Ollama reject a chat
 * request without a `model` field, and 'local:*' means the first one.
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function probeLocalServer(baseUrl) {
  try {
    const base = normalizeServerUrl(baseUrl);
    const res = await fetch(`${base.replace(/\/v1$/, '')}/v1/models`, { method: 'GET', signal: AbortSignal.timeout(TIMEOUTS_MS.localServerProbe) });
    if (!res.ok) return false;
    /** @type {{ data?: Array<{ id?: unknown }> } | null} */
    const body = await res.json().catch(() => null);
    const ids = (body?.data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200);
    serverModels.set(base, /** @type {string[]} */ ([...new Set(ids)].slice(0, 50)));
    if (base === serverBase()) {
      state = { ...state, serverModels: serverModels.get(base) ?? [] };
      notify();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The own server's models as last listed, first one first (empty while unknown).
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function listedServerModels(baseUrl) {
  try {
    return serverModels.get(normalizeServerUrl(baseUrl)) ?? [];
  } catch {
    return [];
  }
}

/** The saved own-server URL, normalized; '' when none was saved. */
function serverBase() {
  const saved = readLocal(STORAGE_KEYS.llmUrl);
  if (!saved) return '';
  try {
    return normalizeServerUrl(saved);
  } catch {
    return '';
  }
}

/** Set while a companion link is stored (companion/pair.js LINK_MARKER). */
export const COMPANION_LINK_MARKER = 'starpi_companion_linked';

/** What the page's pairing last reported (setCompanionPaired); null while it has not loaded. */
/** @type {boolean | null} */
let companionReported = null;

/**
 * Whether a companion is paired: what the page's pairing reported, else the flag alone (no
 * database is opened for it before the pairing loads).
 */
const companionLinked = () => companionReported ?? readLocal(COMPANION_LINK_MARKER) === '1';

/** Providers a key can be added for, in picker order. */
const KEY_PROVIDERS = PROVIDER_ORDER.filter((id) => getProvider(id)?.byok);

/** @returns {ProviderId[]} */
function keyedProviders() {
  return KEY_PROVIDERS.filter((id) => hasKey(id));
}

/** @type {ProviderState} */
let state = { keyed: keyedProviders(), pools: null, server: serverBase() !== '', serverModels: [], models: {}, ready: false, companion: companionLinked() };
/** @type {Set<(state: ProviderState) => void>} */
const listeners = new Set();

function notify() {
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error('[starpi] a provider listener failed', err);
    }
  }
}

/** What is set up right now. */
export function providerState() {
  return state;
}

/**
 * Calls the listener whenever what is set up changes (keys, pools, own server, model lists).
 * @param {(state: ProviderState) => void} fn
 * @returns {() => void}
 */
export function onProvidersChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Applies a change to the state and tells the listeners (chat/runner.js reports through this).
 * @param {Partial<ProviderState>} patch
 */
export function updateProviderState(patch) {
  state = { ...state, ...patch };
  notify();
}

/**
 * How a provider is reached now.
 * @param {ProviderId} provider
 * @returns {Route}
 */
export function routeOf(provider) {
  if (provider === 'webgpu' || provider === 'wasm') return 'device';
  if (provider === 'companion') return state.companion ? 'companion' : 'none';
  if (provider === 'local') return state.server ? 'local' : 'none';
  if (state.keyed.includes(provider)) return 'key';
  const pool = Object.values(POOLS).find((p) => p.provider === provider);
  return pool && state.pools?.[pool.id]?.configured ? 'pool' : 'none';
}

/**
 * Providers that can answer now, in the order Auto tries them: the user's keys, the site's pools,
 * the own server. The engine in this browser comes last and is not listed here; the paired
 * companion answers only when it is picked.
 * @returns {ProviderId[]}
 */
export function configuredProviders() {
  /** @type {ProviderId[]} */
  const out = [...state.keyed];
  for (const pool of Object.values(POOLS)) if (!out.includes(pool.provider) && state.pools?.[pool.id]?.configured) out.push(pool.provider);
  if (state.server) out.push('local');
  return out;
}

/**
 * The display name of a model: the catalogs' label, else the id. Proper names, never translated.
 * @param {ProviderId} provider
 * @param {string} model
 */
export function modelLabel(provider, model) {
  if (provider === 'companion') return model && model !== COMPANION_MODEL ? model : 'Starpi Core';
  if (provider === 'webgpu') return MODEL_CATALOG[/** @type {keyof typeof MODEL_CATALOG} */ (model.replace(/^webgpu:/, ''))]?.label ?? model;
  if (provider === 'wasm') return WASM_CATALOG[/** @type {keyof typeof WASM_CATALOG} */ (model.replace(/^wasm:/, ''))]?.label ?? model;
  if (provider === 'nvidia') return findNvidiaModel(model)?.label ?? model;
  const listed = state.models[provider]?.find((m) => m.id === model)?.label;
  if (listed) return listed;
  const pool = Object.values(POOLS).find((p) => p.provider === provider);
  return pool?.entries.find((e) => e.id === model)?.label ?? model;
}

/**
 * The display name of a provider (catalog data).
 * @param {ProviderId} provider
 */
export function providerLabel(provider) {
  return getProvider(provider)?.label ?? provider;
}

/**
 * Tells the pickers whether a companion is paired now (the pairing calls this when it pairs,
 * unpairs, drops a stored link it cannot use, or finds its session gone). From then on its word
 * counts, not the flag.
 * @param {boolean} paired
 */
export function setCompanionPaired(paired) {
  companionReported = paired;
  if (state.companion === paired) return;
  state = { ...state, companion: paired };
  notify();
}

/** @type {Promise<typeof import('./chat/runner.js')> | null} */
let runner = null;

/** The chat's AI module (adapters, router wiring, the answer runner), loaded once. */
export function loadRunner() {
  runner ??= import('./chat/runner.js').catch((err) => {
    runner = null;
    throw err;
  });
  return runner;
}

/**
 * Reads the live model lists of the providers that are set up (for the pickers; no provider is
 * asked before the user opens one). Never rejects.
 * @returns {Promise<void>}
 */
export function refreshModelLists() {
  return loadRunner()
    .then((m) => m.ensureModelLists())
    .catch(() => {});
}

/** @type {Promise<void> | null} */
let refreshing = null;
let again = false;

/**
 * Reads what is set up (keys, the site's pools, the own server, live model lists) and installs the
 * AI layer with it. Runs once at a time; a call during a run runs once more after it.
 * @returns {Promise<void>}
 */
export function refreshProviders() {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  state = { ...state, keyed: keyedProviders(), server: serverBase() !== '', companion: companionLinked() };
  notify();
  refreshing = (async () => {
    try {
      const m = await loadRunner();
      await m.installAiLayer();
    } catch (err) {
      console.warn('[starpi] the AI layer could not be set up', err);
    } finally {
      refreshing = null;
      if (again) {
        again = false;
        void refreshProviders();
      }
    }
  })();
  return refreshing;
}

/**
 * Starts watching keys and the vault, and sets the AI layer up once the page is idle.
 */
export function initProviders() {
  onKeysChange(() => void refreshProviders());
  onLlmUrlChange(() => void refreshProviders());
  const run = () => void refreshProviders();
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1_500 });
  else setTimeout(run, 0);
}
