// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
// Runs one purpose (purposes.js) along a fallback chain until an answer passes validation:
//   1. selected   the model the user chose (pinned, or the one their strength names)
//   2. role       the other models of the purpose's role at the same provider, then its fallback roles
//   3. provider   the next configured provider in the user's priority order, the same way
//   4. device     the model loaded on this device, when the purpose can run there (no images)
//   5. cache      the last good answer for the same purpose, language and input
//   6. template   a deterministic answer: the quote-only answer of synthesizer.js for a grounded
//                 question, the purpose's own fallback when it has one, else { unavailable: true }
// The model wheel (wheel.js) is asked before every call, so a model cooling down after a 429, with
// an open circuit or marked not found is skipped, and told the outcome after it. A rejected answer
// gets one retry on the same model with a message that names the problems; an answer cut off at the
// token limit (stop reason max_tokens) is never retried, the same limit would cut it again. Key,
// quota and browser-access problems end every further call to that provider in this run.
//
// Nothing switches silently: every call, skip and retry is in `attempts`, and the result names the
// model that served (which may differ from the requested one when a provider falls back itself).
// A cached answer remembers whether its provider was simulated (a local fake behind the site's
// relay, as GET /api/health reports) and is only served while that provider still is, so simulated
// and real answers never stand in for each other. runPurpose() never rejects, except with an
// AbortError when the caller's signal aborts.
import { getLocale } from '../i18n/index.js';
import { isProviderId, textPart } from './contract.js';
import { providerSimulated } from './health-client.js';
import { complete as completeCall } from './index.js';
import { selectedModel } from './model-selection.js';
import { getPurpose, responseSchema } from './purposes.js';
import { roleChainModels } from './roles.js';
import { applyThinking, isThinkingOn, thinkingFor } from './thinking.js';
import { modelWheel } from './wheel.js';
import { readLocalJson, writeLocalJson } from '../storage.js';

/** @typedef {import('./contract.js').AiRequest} AiRequest */
/** @typedef {import('./contract.js').Caps} Caps */
/** @typedef {import('./contract.js').Message} Message */
/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {import('./errors.js').AiErrorCode} AiErrorCode */
/** @typedef {import('./index.js').CompletionResult} CompletionResult */
/** @typedef {import('./purposes.js').PurposeDef} PurposeDef */
/** @typedef {import('./purposes.js').PromptLocale} PromptLocale */
/** @typedef {import('./roles.js').ModelRef} ModelRef */
/** @typedef {import('./roles.js').ModelRole} ModelRole */
/** @typedef {import('./wheel.js').BlockReason} BlockReason */
/** @typedef {import('./wheel.js').ModelWheel} ModelWheel */

/** @typedef {'selected' | 'role' | 'provider' | 'device' | 'cache' | 'template'} RouteTier */
/**
 * ok: validated; invalid: failed validation; truncated: cut off at the token limit; refused: the
 * model declined; skipped: the wheel held the model back (see `blocked`).
 * @typedef {'ok' | 'invalid' | 'truncated' | 'refused' | 'rate_limited' | 'not_found' | 'unavailable' | 'timeout' | 'error' | 'skipped'} AttemptOutcome
 */

/**
 * @typedef {object} Attempt
 * @property {RouteTier} tier
 * @property {ProviderId} provider
 * @property {string} model                the model asked for
 * @property {string} [served]             the model that answered, when it was another one
 * @property {AttemptOutcome} outcome
 * @property {AiErrorCode} [code]          the error of a failed call
 * @property {string[]} [errors]           why validation rejected the answer
 * @property {BlockReason} [blocked]       why the wheel skipped the model
 * @property {boolean} [retry]             the one retry after a rejected answer
 * @property {boolean} [thinking]          the call asked the model to think
 * @property {number} latencyMs
 */

/**
 * @typedef {object} PurposeResult
 * @property {string} purpose
 * @property {boolean} ok              a model, the device or the cache answered; false for the template
 * @property {unknown} [value]         the validated answer of a JSON purpose (also a template value)
 * @property {string} [text]           the validated answer of a text purpose; the quote-only template
 * @property {true} [unavailable]      the template had nothing to offer
 * @property {ProviderId | null} provider
 * @property {string | null} model     the model that served
 * @property {RouteTier} tier
 * @property {boolean} simulated       the answer came from a simulated provider
 * @property {Attempt[]} attempts
 * @property {boolean} [thinking]
 * @property {number} [cachedAt]       epoch ms the cached answer was made
 * @property {string} [fallbackReason] why the chain went past its first step
 */

/**
 * The retrieved passages of a grounded question, as synthesizer.js reads them.
 * @typedef {{ query: string, hits: any[], citations: any[], knownTitles: string[], kbUnavailable?: boolean, focusName?: string | null }} GroundingInput
 */

/**
 * @typedef {object} CacheEntry
 * @property {'value' | 'text'} kind
 * @property {unknown} output
 * @property {ProviderId} provider
 * @property {string} model
 * @property {boolean | null} simulated  null: not known when it was stored (never served)
 * @property {number} at
 */

/**
 * @typedef {object} PurposeCache
 * @property {(key: string) => CacheEntry | null} get
 * @property {(key: string, entry: CacheEntry) => void} set
 */

/**
 * The world the router works in; every part is replaceable (tests pass fakes, the app installs the
 * real ones with configureRouter()).
 * @typedef {object} RouterDeps
 * @property {(req: AiRequest, options: { signal?: AbortSignal }) => { result: Promise<CompletionResult> }} complete
 * @property {() => readonly ProviderId[]} configured       providers with a key, pool or server, in the user's priority order
 * @property {(provider: ProviderId) => readonly string[] | null} liveModels  the provider's live model ids, null while unknown
 * @property {(provider: ProviderId, model: string) => Caps | null} caps
 * @property {() => ModelRef | null} device                 the model loaded on this device
 * @property {(provider: ProviderId) => ModelRef | null} selection  the user's choice at a provider (pin or strength)
 * @property {ModelWheel} wheel
 * @property {PurposeCache} cache
 * @property {(provider: ProviderId) => boolean | null} simulated
 * @property {() => number} now
 * @property {() => PromptLocale} locale
 */

/**
 * @typedef {object} RunOptions
 * @property {PromptLocale} [locale]            default: the interface language
 * @property {AbortSignal} [signal]             aborting rejects with an AbortError (no fallback)
 * @property {ProviderId} [provider]            the selected provider; default: the first configured one
 * @property {string} [model]                   the selected model at that provider
 * @property {readonly ProviderId[]} [providers]  replaces deps.configured()
 * @property {boolean} [thinking]               default: the extended-thinking switch
 * @property {'fallback' | 'prefer' | 'off'} [cache]  prefer: a cached answer answers without a call; default fallback
 * @property {string} [cacheKey]                replaces the hash of the input in the cache key
 * @property {GroundingInput} [grounding]       makes the template the quote-only answer
 * @property {boolean} [fallback]               false: only the selected model, no further steps and no cache (council members)
 * @property {number} [maxCalls]                model calls in one run, retries included (default MAX_CALLS)
 * @property {number} [deadlineMs]              time budget of the whole run
 * @property {(attempt: Attempt) => void} [onAttempt]  every attempt as it is recorded
 * @property {Partial<RouterDeps>} [deps]
 */

/** Model calls one run makes at most, retries included. */
export const MAX_CALLS = 8;
/** Codes that end every further call to the provider in this run: the key, the account or the browser path is the problem. */
const PROVIDER_FAILURES = new Set(['auth', 'quota', 'cors']);
const ON_DEVICE = new Set(['webgpu', 'wasm', 'local']);

/** @type {Readonly<Record<AiErrorCode, AttemptOutcome>>} */
const OUTCOME_OF_CODE = Object.freeze({
  auth: 'unavailable',
  quota: 'unavailable',
  rate_limited: 'rate_limited',
  not_found: 'not_found',
  bad_request: 'error',
  context_length: 'error',
  server: 'error',
  timeout: 'timeout',
  network: 'unavailable',
  aborted: 'error',
  bad_response: 'error',
  cors: 'unavailable',
  stream_cut: 'error',
  refusal: 'refused',
});

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

export const CACHE_STORAGE_KEY = 'starpi_ai_cache_v1';
/** Entries the default cache keeps (the oldest go first). */
export const CACHE_LIMIT = 60;
/** Longest serialized answer the default cache keeps. */
export const CACHE_ENTRY_CHARS = 32_000;

/**
 * A small answer cache: in memory, mirrored to localStorage when the browser allows it.
 * @param {{ storageKey?: string | null, limit?: number, maxEntryChars?: number }} [options] storageKey null: memory only
 * @returns {PurposeCache & { clear(): void, size(): number }}
 */
export function createPurposeCache(options = {}) {
  const storageKey = options.storageKey === undefined ? CACHE_STORAGE_KEY : options.storageKey;
  const limit = options.limit ?? CACHE_LIMIT;
  const maxChars = options.maxEntryChars ?? CACHE_ENTRY_CHARS;
  /** @type {Map<string, CacheEntry> | null} */
  let entries = null;
  const load = () => {
    if (entries) return entries;
    const stored = storageKey ? readLocalJson(storageKey, /** @type {Array<[string, CacheEntry]>} */ ([])) : [];
    entries = new Map(Array.isArray(stored) ? stored.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1] === 'object') : []);
    return entries;
  };
  const save = () => {
    if (storageKey && entries) writeLocalJson(storageKey, [...entries.entries()]);
  };
  return {
    get: (key) => load().get(key) ?? null,
    set(key, entry) {
      if (JSON.stringify(entry.output ?? null).length > maxChars) return;
      const map = load();
      map.delete(key);
      map.set(key, entry);
      while (map.size > limit) map.delete(/** @type {string} */ (map.keys().next().value));
      save();
    },
    clear() {
      entries = new Map();
      save();
    },
    size: () => load().size,
  };
}

/** @type {RouterDeps} */
const defaults = {
  complete: completeCall,
  configured: () => [],
  liveModels: () => null,
  caps: () => null,
  device: () => null,
  selection: (provider) => selectedModel(provider),
  wheel: modelWheel,
  cache: createPurposeCache(),
  simulated: providerSimulated,
  now: () => Date.now(),
  locale: () => (getLocale() === 'de' ? 'de' : 'en'),
};

/**
 * Installs the app's parts of the router's world: which providers are configured, their live
 * model lists and capabilities, the on-device model, the cache. Parts not given stay.
 * @param {Partial<RouterDeps>} deps
 */
export function configureRouter(deps) {
  for (const [key, value] of Object.entries(deps)) if (value !== undefined) /** @type {Record<string, unknown>} */ (defaults)[key] = value;
}

/**
 * The router's world with the run's replacements.
 * @param {Partial<RouterDeps>} [overrides]
 * @returns {RouterDeps}
 */
export function routerDeps(overrides = {}) {
  return { ...defaults, ...overrides };
}

/**
 * JSON with sorted object keys, so equal inputs give equal text.
 * @param {unknown} value
 * @returns {string}
 */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record)
      .sort()
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A 64-bit FNV-1a hash of the input's stable JSON, as 16 hex digits. Not a security hash: it only
 * tells cache entries apart.
 * @param {unknown} input
 */
export function hashInput(input) {
  const s = stableJson(input);
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * The cache key of a purpose answer.
 * @param {string} purpose
 * @param {PromptLocale} locale
 * @param {string} inputKey the input hash (or the caller's key)
 */
export function purposeCacheKey(purpose, locale, inputKey) {
  return `purpose:${purpose}:${locale}:${inputKey}`;
}

/**
 * A cached answer that may stand in now: its provider's simulated flag was known when it was
 * stored and is the same now.
 * @param {RouterDeps} deps
 * @param {string} key
 * @returns {CacheEntry | null}
 */
function cachedEntry(deps, key) {
  const entry = deps.cache.get(key);
  if (!entry || typeof entry !== 'object' || !isProviderId(entry.provider) || typeof entry.simulated !== 'boolean') return null;
  return entry.simulated === deps.simulated(entry.provider) ? entry : null;
}

/**
 * The stored answer of a purpose for this input, to show without any call; null when there is
 * none or it was made by another kind of provider (simulated or real) than the one there now.
 * @param {string} purpose
 * @param {unknown} input
 * @param {{ locale?: PromptLocale, cacheKey?: string, deps?: Partial<RouterDeps> }} [options]
 * @returns {PurposeResult | null}
 */
export function cachedPurpose(purpose, input, options = {}) {
  const deps = routerDeps(options.deps);
  const locale = options.locale ?? deps.locale();
  const entry = cachedEntry(deps, purposeCacheKey(purpose, locale, options.cacheKey ?? hashInput(input)));
  return entry ? fromCache(purpose, entry, []) : null;
}

/**
 * @param {string} purpose
 * @param {CacheEntry} entry
 * @param {Attempt[]} attempts
 * @returns {PurposeResult}
 */
function fromCache(purpose, entry, attempts) {
  return {
    purpose,
    ok: true,
    ...(entry.kind === 'text' ? { text: String(entry.output) } : { value: entry.output }),
    provider: entry.provider,
    model: entry.model,
    tier: 'cache',
    simulated: entry.simulated === true,
    attempts,
    cachedAt: entry.at,
  };
}

// ---------------------------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------------------------

/** @typedef {{ tier: RouteTier, provider: ProviderId, model: string, role: ModelRole | null }} Step */

/**
 * The role chain of a provider, each role's models in the wheel's calling order (a slow fast model
 * moves behind the other fast ones).
 * @param {ProviderId} provider
 * @param {ModelRole} role
 * @param {RouterDeps} deps
 * @returns {Array<{ model: string, role: ModelRole }>}
 */
function orderedRoleChain(provider, role, deps) {
  const chain = roleChainModels(provider, role, { live: deps.liveModels(provider) });
  /** @type {Array<{ model: string, role: ModelRole }>} */
  const out = [];
  for (const r of [...new Set(chain.map((e) => e.role))]) {
    for (const model of deps.wheel.order(provider, chain.filter((e) => e.role === r).map((e) => e.model), r)) out.push({ model, role: r });
  }
  return out;
}

/**
 * The model steps of a run, in order and without repeats.
 * @param {PurposeDef} def
 * @param {RunOptions} opts
 * @param {RouterDeps} deps
 * @returns {Step[]}
 */
export function planChain(def, opts, deps) {
  const providers = [...new Set(opts.providers ?? deps.configured())].filter(isProviderId);
  const primary = opts.provider && isProviderId(opts.provider) ? opts.provider : providers[0];
  /** @type {Step[]} */
  const steps = [];
  /** @param {RouteTier} tier @param {ProviderId} provider @param {string} model @param {ModelRole | null} role */
  const add = (tier, provider, model, role) => {
    if (!model || steps.some((s) => s.provider === provider && s.model === model)) return;
    // A model the catalog knows cannot see images never gets an image purpose.
    if (def.role === 'vision' && deps.caps(provider, model)?.vision === false) return;
    steps.push({ tier, provider, model, role });
  };
  /** @param {ProviderId} provider */
  const choice = (provider) => (opts.model && provider === primary ? { provider, model: opts.model } : deps.selection(provider));

  if (primary) {
    const chosen = choice(primary);
    if (chosen && chosen.provider === primary) add('selected', primary, chosen.model, def.role);
  }
  if (opts.fallback === false) return steps;
  if (primary) for (const { model, role } of orderedRoleChain(primary, def.role, deps)) add('role', primary, model, role);
  for (const provider of providers) {
    if (provider === primary) continue;
    const chosen = deps.selection(provider);
    if (chosen && chosen.provider === provider) add('provider', provider, chosen.model, def.role);
    for (const { model, role } of orderedRoleChain(provider, def.role, deps)) add('provider', provider, model, role);
  }
  const device = def.deviceCapable ? deps.device() : null;
  if (device && isProviderId(device.provider)) add('device', device.provider, device.model, null);
  return steps;
}

/** @returns {DOMException} */
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/**
 * One call's request. The time limit is the purpose's (longer with thinking), cut to what is left
 * of the run's budget; `clipped` tells whether the budget cut it.
 * @param {PurposeDef} def
 * @param {Step} step
 * @param {Message[]} messages
 * @param {{ thinking: boolean, remainingMs: number, deps: RouterDeps }} options
 * @returns {{ req: AiRequest, thinks: boolean, clipped: boolean }}
 */
function buildRequest(def, step, messages, options) {
  const caps = options.deps.caps(step.provider, step.model);
  const schema = responseSchema(def);
  /** @type {AiRequest} */
  let req = { provider: step.provider, model: step.model, messages, maxOutputTokens: def.maxTokens, temperature: def.temperature, timeoutMs: def.timeoutMs };
  // The browser engines have no constrained decoding; everyone else gets the schema unless the catalog says no.
  if (schema && caps?.json !== false && step.provider !== 'webgpu' && step.provider !== 'wasm') req.responseFormat = { type: 'json_schema', schema };
  const choice = thinkingFor({ provider: step.provider, model: step.model, caps, on: options.thinking, role: step.role ?? def.role, show: false });
  req = applyThinking(req, choice);
  const natural = req.timeoutMs ?? def.timeoutMs;
  const clipped = options.remainingMs < natural;
  if (clipped) req.timeoutMs = Math.max(1, Math.floor(options.remainingMs));
  return { req, thinks: choice.thinks, clipped };
}

/**
 * The template step: the quote-only answer for a grounded question, the purpose's own
 * deterministic answer, or nothing.
 * @param {PurposeDef} def
 * @param {unknown} input
 * @param {PromptLocale} locale
 * @param {GroundingInput | undefined} grounding
 * @returns {Promise<{ text?: string, value?: unknown, unavailable?: true }>}
 */
async function template(def, input, locale, grounding) {
  if (grounding) {
    const { synthesizeAnswer } = await import('../synthesizer.js');
    return { text: synthesizeAnswer({ ...grounding, modelAvailable: false }) };
  }
  const own = def.fallback ? def.fallback(input, { locale }) : null;
  if (own !== null && own !== undefined) return def.jsonSchema ? { value: own } : { text: String(own) };
  return { unavailable: true };
}

/**
 * Runs a purpose along the chain. Never rejects, except with an AbortError when `signal` aborts.
 * @param {string} purpose
 * @param {unknown} input
 * @param {RunOptions} [opts]
 * @returns {Promise<PurposeResult>}
 */
export async function runPurpose(purpose, input, opts = {}) {
  const def = getPurpose(purpose);
  if (!def) throw new TypeError(`unknown purpose: ${String(purpose).slice(0, 40)}`);
  const deps = routerDeps(opts.deps);
  const locale = opts.locale === 'de' || opts.locale === 'en' ? opts.locale : deps.locale();
  const thinking = opts.thinking ?? isThinkingOn();
  const useCache = opts.cache !== 'off' && opts.fallback !== false;
  const key = useCache ? purposeCacheKey(def.name, locale, opts.cacheKey ?? hashInput(input)) : null;
  const signal = opts.signal;
  const started = deps.now();
  const maxCalls = Math.max(1, opts.maxCalls ?? MAX_CALLS);
  /** @type {Attempt[]} */
  const attempts = [];
  /** @type {string | null} */
  let fallbackReason = null;
  /** @param {Attempt} attempt */
  const record = (attempt) => {
    attempts.push(attempt);
    try {
      opts.onAttempt?.(attempt);
    } catch {
      // a listener's failure must not end the run
    }
  };
  const output = (/** @type {unknown} */ value) => (def.jsonSchema ? { value } : { text: String(value) });

  if (signal?.aborted) throw abortError();
  if (key && opts.cache === 'prefer') {
    const entry = cachedEntry(deps, key);
    if (entry) return fromCache(def.name, entry, []);
  }

  const inputErrors = def.checkInput(input);
  const steps = inputErrors.length ? [] : planChain(def, opts, deps);
  if (inputErrors.length) fallbackReason = 'invalid_input';
  else if (!steps.length) fallbackReason = 'no_models';

  /** @type {Set<ProviderId>} */
  const droppedProviders = new Set();
  let calls = 0;
  for (const step of steps) {
    if (signal?.aborted) throw abortError();
    if (calls >= maxCalls) {
      fallbackReason ??= 'max_calls';
      break;
    }
    if (droppedProviders.has(step.provider)) continue;
    const remaining = () => (typeof opts.deadlineMs === 'number' ? opts.deadlineMs - (deps.now() - started) : Infinity);
    if (remaining() <= 0) {
      fallbackReason ??= 'deadline';
      break;
    }
    const blocked = deps.wheel.acquire(step.provider, step.model);
    if (blocked) {
      record({ tier: step.tier, provider: step.provider, model: step.model, outcome: 'skipped', blocked, latencyMs: 0 });
      fallbackReason ??= blocked === 'cooldown' ? 'rate_limited' : 'unavailable';
      continue;
    }

    let messages = def.buildMessages(input, { locale });
    for (let round = 0; round < 2 && calls < maxCalls && remaining() > 0; round += 1) {
      calls += 1;
      const { req, thinks, clipped } = buildRequest(def, step, messages, { thinking, remainingMs: remaining(), deps });
      const role = step.role ?? def.role;
      const t0 = deps.now();
      const res = await deps.complete(req, { signal }).result;
      const latencyMs = Math.max(0, Math.round(deps.now() - t0));
      if (signal?.aborted) {
        deps.wheel.release(step.provider, step.model);
        throw abortError();
      }
      /** @type {Attempt} */
      const base = { tier: step.tier, provider: step.provider, model: step.model, outcome: 'ok', latencyMs, ...(round ? { retry: true } : {}), ...(thinks ? { thinking: true } : {}) };
      if (res.model && res.model !== step.model) base.served = res.model;

      if (res.error) {
        const code = res.error.code;
        deps.wheel.failed(step.provider, step.model, code === 'timeout' && clipped ? 'deadline' : code, { retryAfterMs: res.error.retryAfterMs, latencyMs, role });
        record({ ...base, outcome: OUTCOME_OF_CODE[code] ?? 'error', code });
        fallbackReason ??= code;
        if (PROVIDER_FAILURES.has(code)) droppedProviders.add(step.provider);
        break;
      }
      if (res.stopReason === 'max_tokens') {
        // The model answered; the limit is the purpose's, so the model's health is fine.
        deps.wheel.succeeded(step.provider, step.model, { latencyMs });
        record({ ...base, outcome: 'truncated', errors: ['truncated'] });
        fallbackReason ??= 'truncated';
        break;
      }
      if (res.stopReason === 'refusal') {
        deps.wheel.failed(step.provider, step.model, 'refusal', { latencyMs, role });
        record({ ...base, outcome: 'refused', code: 'refusal' });
        fallbackReason ??= 'refusal';
        break;
      }
      const checked = def.validate(res.text, input);
      if (checked.ok) {
        deps.wheel.succeeded(step.provider, step.model, { latencyMs, role });
        record(base);
        const served = res.model || step.model;
        const simulated = ON_DEVICE.has(step.provider) ? false : deps.simulated(step.provider);
        if (key) deps.cache.set(key, { kind: def.jsonSchema ? 'value' : 'text', output: checked.value, provider: step.provider, model: served, simulated, at: deps.now() });
        /** @type {PurposeResult} */
        const result = { purpose: def.name, ok: true, ...output(checked.value), provider: step.provider, model: served, tier: step.tier, simulated: simulated === true, attempts };
        if (thinks) result.thinking = true;
        if (fallbackReason) result.fallbackReason = fallbackReason;
        return result;
      }
      deps.wheel.failed(step.provider, step.model, 'invalid_output', { latencyMs, role });
      const errors = checked.errors.slice(0, 8);
      record({ ...base, outcome: 'invalid', errors });
      fallbackReason ??= 'invalid';
      messages = [...messages, { role: 'assistant', content: [textPart(String(res.text).slice(0, 4000) || '-')] }, { role: 'user', content: [textPart(def.retryHint(errors, { locale }))] }];
    }
  }

  if (key) {
    const entry = cachedEntry(deps, key);
    if (entry) return { ...fromCache(def.name, entry, attempts), fallbackReason: fallbackReason ?? 'unavailable' };
  }
  if (signal?.aborted) throw abortError();
  return {
    purpose: def.name,
    ok: false,
    ...(await template(def, input, locale, opts.grounding)),
    provider: null,
    model: null,
    tier: 'template',
    simulated: false,
    attempts,
    fallbackReason: fallbackReason ?? 'unavailable',
  };
}
