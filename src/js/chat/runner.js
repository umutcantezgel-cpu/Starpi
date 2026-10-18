// @ts-check
// The chat's side of the AI layer: installs it (adapters, transport resolver, router world), picks
// the models a question goes to, and streams one answer along them.
//
// Installing (installAiLayer, from providers.js refreshProviders): the built-in adapters with
// Anthropic's server-side fallbacks on (the served model is shown), the transport resolver (keys,
// the site's pools, the relay setting), the site's pool list and health, the live model lists of the
// providers the user has keys for, and configureRouter() with all of it plus the model loaded on
// this device, so purposes (titles, OCR, council) run on what is set up.
//
// Candidates (chatCandidates): an explicit pick is one model; Auto is the user's keys first (the
// model their strength names, else the provider's balanced model), then the site's free pools, then
// the own server, then the model already loaded on this device. A question with images only goes to
// models that can see.
//
// Running (runAnswer): one model after the other until one starts answering. A call that fails
// before any text or reasoning arrived (no key, quota, rate limit, model gone, network, server) moves
// to the next candidate; once text arrived the answer belongs to that model. Every call is recorded
// in `attempts` and the model wheel hears every outcome, as the router's chain does. An answer that
// stops for a server-side pause (Anthropic pause_turn) is sent again with its content appended, so
// the server continues it; the parts are merged into one answer with one set of provider state.
import { createAdapter, registerBuiltInAdapters } from '../ai/adapters/index.js';
import { capsFor, fetchModels, roleModel, snapshotModels } from '../ai/catalog/models.js';
import { POOLS } from '../ai/catalog/pools.js';
import { getProvider } from '../ai/catalog/providers.js';
import { AiError, isRetryable } from '../ai/errors.js';
import { healthClient } from '../ai/health-client.js';
import { complete as completeCall } from '../ai/index.js';
import { getKey, ACCESS_SLOT } from '../ai/keys.js';
import { selectedModel } from '../ai/model-selection.js';
import { configureRouter } from '../ai/router.js';
import { fetchPools, installTransportResolver, selectTransport } from '../ai/transport-select.js';
import { modelWheel } from '../ai/wheel.js';
import { LIMITS } from '../config.js';
import { configuredProviders, providerState, routeOf, updateProviderState } from '../providers.js';
import { getLlmUrl } from '../state.js';
import { getEngineState } from '../webgpu/engine.js';

/** @typedef {import('../ai/contract.js').AiRequest} AiRequest */
/** @typedef {import('../ai/contract.js').AiEvent} AiEvent */
/** @typedef {import('../ai/contract.js').Caps} Caps */
/** @typedef {import('../ai/contract.js').Message} Message */
/** @typedef {import('../ai/contract.js').OpaquePart} OpaquePart */
/** @typedef {import('../ai/contract.js').ProviderId} ProviderId */
/** @typedef {import('../ai/index.js').CompletionResult} CompletionResult */
/** @typedef {import('../ai/catalog/models.js').ModelEntry} ModelEntry */
/** @typedef {import('../ai/stream.js').Adapter} Adapter */
/** @typedef {import('../ai/router.js').AttemptOutcome} AttemptOutcome */
/** @typedef {import('../providers.js').Route} Route */

/**
 * A model a question may go to.
 * @typedef {object} Target
 * @property {ProviderId} provider
 * @property {string} model
 * @property {Route} route
 */

/**
 * One call of an answer, as the answer's details list it.
 * @typedef {object} ChatAttempt
 * @property {ProviderId} provider
 * @property {string} model                the model asked for
 * @property {string} [served]             the model that answered, when another one did
 * @property {AttemptOutcome} outcome
 * @property {import('../ai/errors.js').AiErrorCode} [code]
 * @property {number} latencyMs
 */

/**
 * @typedef {object} RunOptions
 * @property {Target[]} candidates
 * @property {(target: Target) => AiRequest | Promise<AiRequest>} build  the request for one model (its history budget depends on the model)
 * @property {AbortSignal} signal
 * @property {(target: Target, served: string) => void} [onStart]  a model started answering
 * @property {(ev: AiEvent, target: Target) => void} [onEvent]     every event of the answering model
 * @property {(attempt: ChatAttempt) => void} [onAttempt]
 * @property {(target: Target, req: AiRequest) => Adapter | undefined} [adapterFor]  another adapter for one call (e.g. with compaction)
 * @property {typeof completeCall} [complete]
 * @property {Pick<typeof modelWheel, 'acquire' | 'release' | 'succeeded' | 'failed'>} [wheel]
 * @property {number} [maxPauses]
 * @property {() => number} [now]
 */

/**
 * @typedef {object} RunResult
 * @property {CompletionResult} result  the answer (merged over pause continuations); `error` when none came
 * @property {Target | null} target     the model that answered (null when none started)
 * @property {ChatAttempt[]} attempts
 * @property {number} continued         how often a paused answer was sent again
 */

/** Errors after which the next candidate is asked (nothing was answered yet). */
const NEXT_CANDIDATE = new Set(['auth', 'quota', 'rate_limited', 'not_found', 'bad_request', 'context_length', 'server', 'timeout', 'network', 'bad_response', 'cors', 'stream_cut']);

/**
 * The site's pool of a provider.
 * @param {ProviderId} provider
 */
function poolOf(provider) {
  return Object.values(POOLS).find((p) => p.provider === provider) ?? null;
}

/** @type {Readonly<Record<string, AttemptOutcome>>} */
const OUTCOMES = Object.freeze({
  auth: 'unavailable',
  quota: 'unavailable',
  cors: 'unavailable',
  network: 'unavailable',
  rate_limited: 'rate_limited',
  not_found: 'not_found',
  timeout: 'timeout',
  refusal: 'refused',
});

// ---------------------------------------------------------------------------------------------
// Installing the AI layer
// ---------------------------------------------------------------------------------------------

let installed = false;
/** Merged model lists (snapshot plus live list) of the providers the user has keys for. */
/** @type {Map<ProviderId, ModelEntry[]>} */
const catalogs = new Map();
/** @type {Map<ProviderId, string[]>} */
const liveIds = new Map();

/**
 * The model ids a provider listed: the live list read here, for the own server also the list read
 * when it was picked (providers.js probeLocalServer); null while unknown.
 * @param {ProviderId} provider
 * @returns {string[] | null}
 */
function listedIds(provider) {
  const ids = liveIds.get(provider);
  if (ids) return ids;
  if (provider !== 'local') return null;
  const probed = providerState().serverModels;
  return probed.length ? probed : null;
}

/**
 * The capabilities of a model: the merged list of its provider, else the shipped catalog's entry or
 * guesses (marked unverified).
 * @param {ProviderId} provider
 * @param {string} model
 * @returns {Caps}
 */
export function capsOf(provider, model) {
  if (provider === 'local' || provider === 'webgpu' || provider === 'wasm') return capsFor(provider, model);
  const pool = Object.values(POOLS).find((p) => p.provider === provider);
  const caps = capsFor(provider, model, catalogs.get(provider));
  // A pool model's vision is what the pool allows, whatever the provider's model could do.
  if (routeOf(provider) === 'pool' && pool) return { ...caps, vision: pool.visionModels.includes(model), pdf: false };
  return caps;
}

/** The model loaded on this device, as the router and the chat name it. */
export function deviceModel() {
  const s = getEngineState();
  if (s.status !== 'ready' || !s.model) return null;
  return { provider: /** @type {ProviderId} */ (s.model.runtime === 'wasm' ? 'wasm' : 'webgpu'), model: s.model.ref };
}

/**
 * A transport for model lists, as a call would take it; null when the provider cannot be reached.
 * @param {ProviderId} provider
 */
function listTransport(provider) {
  try {
    return selectTransport(provider, { key: getKey(provider), pool: false, baseUrl: provider === 'local' ? getLlmUrl() : null, access: () => getKey(ACCESS_SLOT) });
  } catch {
    return null;
  }
}

/** When the live lists were read last, and for which providers. */
let listsRead = { at: 0, providers: '' };
/** @type {Promise<void> | null} */
let listsRun = null;
/** Live model lists are read again after this long. */
const LISTS_MAX_AGE_MS = 30 * 60_000;

/** Publishes the model lists of the keyed providers: the live ones read so far, else the snapshot. */
function publishModelLists() {
  /** @type {Partial<Record<ProviderId, import('../models/choices.js').ModelOption[]>>} */
  const models = {};
  for (const provider of providerState().keyed) {
    const entries = catalogs.get(provider) ?? snapshotModels(provider);
    models[provider] = entries.filter((m) => m.listed !== false && !m.caps.imageOut).map((m) => ({ id: m.id, label: m.label || m.id, ...(m.caps.verified ? {} : { unverified: true }) }));
  }
  updateProviderState({ models, serverModels: liveIds.get('local') ?? providerState().serverModels });
}

/**
 * Reads the live model lists of the keyed providers and of the own server. Only when a picker is
 * opened (no provider is contacted before the user uses it), at most every half hour unless the
 * providers changed; a call during a read joins it.
 * @returns {Promise<void>}
 */
export function ensureModelLists() {
  const { keyed, server } = providerState();
  const providers = [...keyed, ...(server ? /** @type {ProviderId[]} */ (['local']) : [])];
  const id = providers.join(',');
  if (listsRun) return listsRun;
  if (!providers.length || (listsRead.providers === id && Date.now() - listsRead.at < LISTS_MAX_AGE_MS)) return Promise.resolve();
  listsRun = (async () => {
    try {
      await Promise.all(
        providers.map(async (provider) => {
          const transport = listTransport(provider);
          if (!transport) return;
          const { models, error } = await fetchModels(provider, transport, { signal: AbortSignal.timeout(10_000) });
          // An empty or unreadable list says nothing about what the provider serves: keep the snapshot.
          const listed = models.filter((m) => m.listed !== false).map((m) => m.id);
          if (error || !listed.length) return;
          if (provider !== 'local') catalogs.set(provider, models);
          liveIds.set(provider, listed);
        }),
      );
      listsRead = { at: Date.now(), providers: id };
      publishModelLists();
    } finally {
      listsRun = null;
    }
  })();
  return listsRun;
}

/**
 * Installs the AI layer for this page and refreshes what it knows: adapters and the transport
 * resolver once, then the site's pools, the router's world and the live model lists.
 */
export async function installAiLayer() {
  if (!installed) {
    installed = true;
    // The site's own BYOK chat: Anthropic may fall back on the server to another model for a
    // declined answer; the served model is shown with every answer.
    registerBuiltInAdapters({ anthropic: { serverFallbacks: true } });
    installTransportResolver({ localUrl: getLlmUrl });
  }
  configureRouter({
    configured: configuredProviders,
    // A pool serves its allowlist only; the own server what it lists.
    liveModels: (provider) => (routeOf(provider) === 'pool' ? (poolOf(provider)?.models ?? null) : listedIds(provider)),
    caps: (provider, model) => capsOf(provider, model),
    device: deviceModel,
    selection: (provider, live) => {
      if (provider === 'local') return live?.[0] ? { provider, model: live[0] } : null;
      if (routeOf(provider) === 'pool') {
        const model = defaultModel(provider);
        return model ? { provider, model } : null;
      }
      return selectedModel(provider, { live });
    },
  });
  updateProviderState({ ready: true });
  void healthClient.load().catch(() => {});
  publishModelLists();
  const { reachable, pools } = await fetchPools();
  updateProviderState({ pools: reachable ? pools : {} });
}

// ---------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------

/**
 * The model a provider answers with when the user named none: the pinned model or the strength's
 * model, else the pool's default, else the catalog's balanced model, else the first one listed.
 * @param {ProviderId} provider
 * @returns {string | null}
 */
export function defaultModel(provider) {
  if (provider === 'local') return '*';
  const route = routeOf(provider);
  const live = listedIds(provider);
  const pool = Object.values(POOLS).find((p) => p.provider === provider);
  if (route === 'pool' && pool) {
    const status = providerState().pools?.[pool.id];
    return status?.defaultModel && pool.models.includes(status.defaultModel) ? status.defaultModel : pool.defaultModel;
  }
  const picked = selectedModel(provider, { live })?.model;
  if (picked) return picked;
  const balanced = roleModel(provider, 'balanced');
  if (balanced && (!live || live.includes(balanced))) return balanced;
  return live?.[0] ?? balanced ?? null;
}

/**
 * Resolves 'local:*' to the first model the own server lists (asking it once when the list is not
 * known yet); other targets stay as they are.
 * @param {Target} target
 * @returns {Promise<Target>}
 */
async function resolveServerModel(target) {
  if (target.provider !== 'local' || target.model !== '*') return target;
  let ids = listedIds('local') ?? [];
  if (!ids.length) {
    const transport = listTransport('local');
    if (transport) {
      const { models, error } = await fetchModels('local', transport, { signal: AbortSignal.timeout(5_000) });
      if (!error) {
        ids = models.map((m) => m.id);
        liveIds.set('local', ids);
      }
    }
  }
  return ids[0] ? { ...target, model: ids[0] } : target;
}

/**
 * The models a question goes to, in order.
 * @param {import('../config.js').AssistantValue} value  the picker's choice
 * @param {{ vision?: boolean }} [needs]  vision: the question carries images
 * @returns {Promise<Target[]>}
 */
export async function chatCandidates(value, needs = {}) {
  /** @type {Target[]} */
  let out = [];
  const device = deviceModel();
  if (value === 'device') {
    if (device) out.push({ ...device, route: 'device' });
  } else if (value === 'auto') {
    for (const provider of configuredProviders()) {
      const model = defaultModel(provider);
      if (model) out.push({ provider, model, route: routeOf(provider) });
    }
    if (device) out.push({ ...device, route: 'device' });
  } else {
    const at = value.indexOf(':');
    const provider = /** @type {ProviderId} */ (value.slice(0, at));
    out.push({ provider, model: value.slice(at + 1), route: routeOf(provider) });
  }
  out = await Promise.all(out.map(resolveServerModel));
  if (needs.vision) out = out.filter((c) => capsOf(c.provider, c.model).vision);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Running an answer
// ---------------------------------------------------------------------------------------------

/**
 * One answer's provider state after a continuation: the content of one Anthropic answer is one
 * block (the parts of a paused answer join it, so it replays as one turn); other blocks are kept.
 * @param {OpaquePart[]} before
 * @param {OpaquePart[]} next
 * @returns {OpaquePart[]}
 */
export function mergeOpaque(before, next) {
  const out = [...before];
  for (const part of next) {
    const block = /** @type {Record<string, unknown> | null} */ (part.block && typeof part.block === 'object' ? part.block : null);
    const i = block?.kind === 'anthropic-content' ? out.findIndex((p) => p.provider === part.provider && /** @type {any} */ (p.block)?.kind === 'anthropic-content') : -1;
    if (i >= 0 && block && Array.isArray(block.content)) {
      const prev = /** @type {Record<string, unknown>} */ (out[i].block);
      out[i] = { ...part, block: { ...block, content: [...(Array.isArray(prev.content) ? prev.content : []), ...block.content] } };
    } else out.push(part);
  }
  return out;
}

/**
 * Two results of one answer (a paused one and its continuation) as one.
 * @param {CompletionResult} a
 * @param {CompletionResult} b
 * @returns {CompletionResult}
 */
export function mergeResults(a, b) {
  const shift = a.text.length;
  /** @type {CompletionResult['usage']} */
  let usage = a.usage ?? b.usage;
  if (a.usage && b.usage) {
    usage = { input: a.usage.input + b.usage.input, output: a.usage.output + b.usage.output, reasoning: a.usage.reasoning + b.usage.reasoning, cacheRead: a.usage.cacheRead + b.usage.cacheRead };
    if (a.usage.costUsd !== undefined || b.usage.costUsd !== undefined) usage.costUsd = (a.usage.costUsd ?? 0) + (b.usage.costUsd ?? 0);
  }
  return {
    ...b,
    text: a.text + b.text,
    reasoning: [a.reasoning, b.reasoning].filter(Boolean).join('\n\n'),
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    toolCalls: [...a.toolCalls, ...b.toolCalls],
    citations: [...a.citations, ...b.citations.map((c) => ({ ...c, ...(c.start !== undefined ? { start: c.start + shift } : {}), ...(c.end !== undefined ? { end: c.end + shift } : {}) }))],
    images: [...a.images, ...b.images],
    opaque: mergeOpaque(a.opaque, b.opaque),
    usage,
  };
}

/**
 * A result for an answer no model started.
 * @param {AiError} error
 * @param {Target | undefined} target
 * @returns {CompletionResult}
 */
function noAnswer(error, target) {
  return { text: '', reasoning: '', reasoningTokens: 0, toolCalls: [], citations: [], images: [], opaque: [], stopReason: 'error', provider: target?.provider ?? 'local', model: target?.model ?? 'unknown', requestId: null, usage: null, error };
}

/**
 * Streams one answer along the candidates (see the file comment).
 * @param {RunOptions} opts
 * @returns {Promise<RunResult>}
 */
export async function runAnswer(opts) {
  const complete = opts.complete ?? completeCall;
  const wheel = opts.wheel ?? modelWheel;
  const now = opts.now ?? (() => performance.now());
  const maxPauses = opts.maxPauses ?? LIMITS.pauseContinuations;
  /** @type {ChatAttempt[]} */
  const attempts = [];
  /** @param {ChatAttempt} a */
  const record = (a) => {
    attempts.push(a);
    try {
      opts.onAttempt?.(a);
    } catch {
      // a listener's failure must not end the answer
    }
  };
  /** @type {AiError | null} */
  let lastError = null;

  for (let i = 0; i < opts.candidates.length; i += 1) {
    if (opts.signal.aborted) break;
    const target = opts.candidates[i];
    const more = i < opts.candidates.length - 1;
    const blocked = wheel.acquire(target.provider, target.model);
    if (blocked && more) {
      record({ provider: target.provider, model: target.model, outcome: 'skipped', latencyMs: 0 });
      continue;
    }
    let req = await opts.build(target);
    let started = false;
    let committed = false;
    const t0 = now();
    /** @type {CompletionResult | null} */
    let merged = null;
    let continued = 0;
    for (;;) {
      const call = complete(req, { signal: opts.signal, adapter: opts.adapterFor?.(target, req) });
      for await (const ev of call.events) {
        if (ev.type === 'start') {
          if (!started) opts.onStart?.(target, ev.model);
          started = true;
          continue;
        }
        if (ev.type === 'end') continue;
        if (ev.type === 'text' || ev.type === 'tool_call' || ev.type === 'image' || (ev.type === 'reasoning' && typeof ev.delta === 'string' && ev.delta)) committed = true;
        opts.onEvent?.(ev, target);
      }
      const result = await call.result;
      merged = merged ? mergeResults(merged, result) : result;
      if (result.stopReason !== 'pause' || continued >= maxPauses || opts.signal.aborted) break;
      // The server paused a long turn: send it back with what it wrote, and it goes on.
      continued += 1;
      req = { ...req, messages: [...req.messages, { role: 'assistant', content: [...(result.text ? [{ type: /** @type {const} */ ('text'), text: result.text }] : []), ...result.opaque] }] };
    }
    const result = /** @type {CompletionResult} */ (merged);
    const latencyMs = Math.max(0, Math.round(now() - t0));
    const served = result.model && result.model !== target.model ? { served: result.model } : {};
    if (result.error && !committed && !opts.signal.aborted && NEXT_CANDIDATE.has(result.error.code) && more) {
      wheel.failed(target.provider, target.model, result.error.code, { retryAfterMs: result.error.retryAfterMs, latencyMs });
      record({ provider: target.provider, model: target.model, ...served, outcome: OUTCOMES[result.error.code] ?? 'error', code: result.error.code, latencyMs });
      lastError = result.error;
      continue;
    }
    if (opts.signal.aborted) wheel.release(target.provider, target.model);
    else if (result.error) wheel.failed(target.provider, target.model, result.error.code, { retryAfterMs: result.error.retryAfterMs, latencyMs });
    else wheel.succeeded(target.provider, target.model, { latencyMs });
    /** @type {AttemptOutcome} */
    const outcome = result.error ? (OUTCOMES[result.error.code] ?? 'error') : result.stopReason === 'max_tokens' ? 'truncated' : result.stopReason === 'refusal' ? 'refused' : 'ok';
    record({ provider: target.provider, model: target.model, ...served, outcome, ...(result.error ? { code: result.error.code } : {}), latencyMs });
    return { result, target: started || committed ? target : null, attempts, continued };
  }
  const error = lastError ?? new AiError(opts.signal.aborted ? 'aborted' : 'auth', { provider: opts.candidates[0]?.provider ?? null });
  return { result: noAnswer(error, opts.candidates.at(-1)), target: null, attempts, continued: 0 };
}

/**
 * Whether an error may go away by itself (a later try may work).
 * @param {AiError | null} error
 */
export function transient(error) {
  return Boolean(error && isRetryable(error.code));
}

/**
 * The adapter for one Anthropic call with server-side compaction, for long conversations (the
 * server summarizes the earlier part near its limit; the compaction block is kept with the answer
 * and replayed, as every block is).
 * @returns {Adapter}
 */
export function compactingAnthropic() {
  compacting ??= createAdapter('anthropic', { anthropic: { serverFallbacks: true, compaction: true } });
  return compacting;
}
/** @type {Adapter | null} */
let compacting = null;

/**
 * The provider's display name (catalog data).
 * @param {ProviderId} provider
 */
export function providerName(provider) {
  return getProvider(provider)?.label ?? provider;
}
