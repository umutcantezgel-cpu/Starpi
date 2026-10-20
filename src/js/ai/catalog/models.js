// @ts-check
// The model catalog: curated defaults per provider (snapshot.json, written by
// `npm run models:sync`), the on-device presets, and live model lists merged on top. A model known
// only from a live list gets capability guesses from its id and the list's own fields, marked
// `verified: false` so the picker can show an "unverified" badge.
//
// Reasoning kinds (Caps.reasoning) say how thinking is controlled:
//   none      no control (the model may still reason internally)
//   effort    an effort level (OpenAI reasoning effort, Gemini thinking level, xAI reasoning effort,
//             MiniMax reasoning effort, whose lowest level still thinks)
//   budget    a thinking token budget (Gemini thinking budget)
//   adaptive  the model decides how much to think; effort tunes it (Anthropic)
//   tagged    the model always reasons and sends the reasoning as text (a reasoning field or <think>)
import { NVIDIA_DEFAULT_MODEL } from '../../models/nvidia-catalog.js';
import { WASM_CATALOG } from '../../models/wasm-catalog.js';
import { MODEL_CATALOG } from '../../webgpu/models.js';
import { readText } from '../sse.js';
import { COMPANION_MODEL, getProvider, MINIMAX_M3 } from './providers.js';
import snapshotData from './snapshot.json' with { type: 'json' };

/** @typedef {import('../contract.js').Caps} Caps */
/** @typedef {import('../contract.js').ProviderId} ProviderId */
/** @typedef {import('../contract.js').UsageEvent} UsageEvent */
/** @typedef {import('../transport.js').Transport} Transport */

/** @typedef {'fast' | 'balanced' | 'max'} ModelRole */

/**
 * A model as a live list describes it. Only `id` is always there; the rest refines the guesses.
 * @typedef {object} LiveModel
 * @property {string} id
 * @property {string} [label]
 * @property {number} [contextTokens]
 * @property {number} [maxOutput]
 * @property {Partial<Omit<Caps, 'text' | 'verified'>>} [hints]
 */

/**
 * @typedef {object} ModelEntry
 * @property {ProviderId} provider
 * @property {string} id
 * @property {string} label
 * @property {Caps} caps
 * @property {'snapshot' | 'live' | 'device'} source
 * @property {boolean} listed   false for a snapshot model a live list did not name
 * @property {string} [vendor]
 */

/**
 * @typedef {object} SnapshotModel
 * @property {string} id
 * @property {string} label
 * @property {string} [vendor]
 * @property {boolean} [listed]
 * @property {Caps} caps
 *
 * @typedef {{ roles: Partial<Record<ModelRole, string>>, models: SnapshotModel[] }} SnapshotSection
 * @typedef {{ format: string, note?: string, providers: Partial<Record<ProviderId, SnapshotSection>> }} Snapshot
 */

export const SNAPSHOT_FORMAT = 'starpi.models/v1';
export const MODEL_ROLES = /** @type {readonly ModelRole[]} */ (Object.freeze(['fast', 'balanced', 'max']));

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** The curated snapshot, frozen. */
export const SNAPSHOT = /** @type {Readonly<Snapshot>} */ (deepFreeze(/** @type {Snapshot} */ (snapshotData)));

/** Largest live model list read (some routers list hundreds of models). */
export const MAX_LIST_BYTES = 8 * 1024 * 1024;

/** Context windows assumed when nothing better is known. */
const DEFAULT_CONTEXT = /** @type {Partial<Record<ProviderId, number>>} */ ({ anthropic: 200_000, openai: 128_000, gemini: 1_048_576, local: 4096 });

const ON_DEVICE = new Set(['local', 'webgpu', 'wasm']);

/**
 * The published context window of MiniMax M3 builds (providers.js MINIMAX_M3), as of 2026-10-20;
 * a local server's own figure wins over it.
 */
export const MINIMAX_M3_CONTEXT = 1_000_000;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is number} */
const isCount = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * Capability guesses for a model known only by its id (and what a live list said about it).
 * @param {ProviderId} provider
 * @param {string} id
 * @param {LiveModel['hints'] & { contextTokens?: number, maxOutput?: number }} [hints]
 * @returns {Caps}
 */
export function heuristicCaps(provider, id, hints = {}) {
  const lower = String(id).toLowerCase();
  const cloudVision = /claude|gemini|gpt-4o|gpt-4\.1|gpt-5|grok-4|pixtral|mistral-(?:small|medium|large)|llama-4|gemma-3|vision|[-_]vl\b|omni|llava/;
  // Written without a colon inside a bracket: the style build scans these files for class names.
  const tagged = /(?:^|[-/_.])(?:r1|qwq|magistral|reasoner|thinking)(?:$|[-_.]|:)|deepseek-r1|qwen3/;
  const minimax = MINIMAX_M3.test(lower);
  /** @type {Caps['reasoning']} */
  let reasoning = 'none';
  if (provider === 'anthropic') reasoning = 'adaptive';
  else if (provider === 'gemini') reasoning = /gemini-[3-9]/.test(lower) ? 'effort' : /gemini-2\.5/.test(lower) ? 'budget' : 'none';
  else if (provider === 'openai') reasoning = /^(?:o\d|gpt-5)/.test(lower) ? 'effort' : 'none';
  else if (provider === 'minimax' || /gpt-oss|grok-3-mini/.test(lower)) reasoning = 'effort';
  else if (tagged.test(lower) || minimax) reasoning = 'tagged';
  const context = hints.contextTokens ?? (minimax ? MINIMAX_M3_CONTEXT : DEFAULT_CONTEXT[provider]) ?? 32_768;
  const local = ON_DEVICE.has(provider);
  const free = provider === 'nvidia' || local || (provider === 'openrouter' && lower.endsWith(':free'));
  /** @type {Caps} */
  const caps = {
    text: true,
    vision: !local && cloudVision.test(lower),
    pdf: provider === 'anthropic' || provider === 'gemini' || provider === 'openai',
    tools: !local,
    parallelTools: !local,
    reasoning,
    reasoningVisible: reasoning !== 'none',
    search: provider === 'anthropic' || provider === 'openai' || provider === 'gemini' ? 'native' : provider === 'openrouter' ? 'plugin' : 'none',
    imageOut: /image|imagen|dall-e/.test(lower),
    audioIn: false,
    live: false,
    json: !local,
    contextTokens: context,
    maxOutput: Math.min(hints.maxOutput ?? 8192, context),
    // A MiniMax M3 build on a local server is a workstation model, whatever its name says.
    latency: minimax && local ? 'slow' : /mini|nano|flash|lite|instant|small|haiku|fast|\b[1-8]b\b/.test(lower) ? 'fast' : /opus|pro\b|large|ultra|reasoner|405b|\b[1-9]\d{2}b\b/.test(lower) ? 'slow' : 'normal',
    free,
    local,
    verified: false,
  };
  for (const [key, value] of Object.entries(hints)) {
    if ((key in caps || key === 'priceIn' || key === 'priceOut') && key !== 'text' && key !== 'verified' && value !== undefined) /** @type {Record<string, unknown>} */ (caps)[key] = value;
  }
  if (caps.maxOutput > caps.contextTokens) caps.maxOutput = caps.contextTokens;
  return caps;
}

/**
 * Models of the on-device engines: the WebGPU presets and the processor (WASM) presets, by their
 * picker reference (`webgpu:<key>`, `wasm:<key>`).
 * @returns {ModelEntry[]}
 */
export function onDeviceModels() {
  /** @type {ModelEntry[]} */
  const out = [];
  /** @param {ProviderId} provider @param {string} id @param {string} label @param {number} contextTokens @param {number} maxOutput @param {Caps['latency']} latency */
  const add = (provider, id, label, contextTokens, maxOutput, latency) =>
    out.push({
      provider,
      id,
      label,
      source: 'device',
      listed: true,
      caps: { ...heuristicCaps(provider, id, { contextTokens, maxOutput }), reasoning: 'none', reasoningVisible: false, latency, verified: true },
    });
  for (const [key, spec] of Object.entries(MODEL_CATALOG)) add('webgpu', `webgpu:${key}`, spec.label, spec.contextWindow, spec.maxOutputTokens, 'normal');
  for (const [key, spec] of Object.entries(WASM_CATALOG)) add('wasm', `wasm:${key}`, spec.label, spec.contextWindow, spec.maxOutputTokens, 'slow');
  return out;
}

/** @type {ModelEntry[] | null} */
let deviceCache = null;

export { COMPANION_MODEL, MINIMAX_M3 };


/**
 * The paired companion as a model: text in and out, no tools, images or web search of its own here
 * (the companion runs its own tools), and it runs on this machine.
 * @returns {ModelEntry}
 */
function companionEntry() {
  return {
    provider: 'companion',
    id: COMPANION_MODEL,
    label: 'Starpi Core',
    source: 'device',
    listed: true,
    caps: {
      ...heuristicCaps('companion', COMPANION_MODEL, { contextTokens: 8192, maxOutput: 1500 }),
      vision: false,
      pdf: false,
      tools: false,
      parallelTools: false,
      reasoning: 'none',
      reasoningVisible: false,
      search: 'none',
      imageOut: false,
      json: false,
      latency: 'normal',
      free: true,
      local: true,
      verified: true,
    },
  };
}

/**
 * The curated models of a provider (for webgpu and wasm: the on-device presets).
 * @param {ProviderId} provider
 * @returns {ModelEntry[]}
 */
export function snapshotModels(provider) {
  if (provider === 'companion') return [companionEntry()];
  if (provider === 'webgpu' || provider === 'wasm') {
    deviceCache ??= onDeviceModels();
    return deviceCache.filter((m) => m.provider === provider);
  }
  const section = SNAPSHOT.providers[provider];
  if (!section) return [];
  return section.models.map((m) => ({ provider, id: m.id, label: m.label, caps: { ...m.caps }, source: 'snapshot', listed: m.listed !== false, ...(m.vendor ? { vendor: m.vendor } : {}) }));
}

/**
 * @param {ProviderId} provider
 * @param {string} id
 * @param {ModelEntry[]} [catalog] a merged list to look in first
 * @returns {ModelEntry | null}
 */
export function findModel(provider, id, catalog) {
  const fromCatalog = Array.isArray(catalog) ? catalog.find((m) => m.provider === provider && m.id === id) : undefined;
  return fromCatalog ?? snapshotModels(provider).find((m) => m.id === id) ?? null;
}

/**
 * The capabilities of a model: the catalog's entry, or guesses marked unverified.
 * @param {ProviderId} provider
 * @param {string} id
 * @param {unknown} [catalog] a merged ModelEntry list (other values are ignored)
 * @returns {Caps}
 */
export function capsFor(provider, id, catalog) {
  const entry = findModel(provider, id, Array.isArray(catalog) ? /** @type {ModelEntry[]} */ (catalog) : undefined);
  return entry ? { ...entry.caps } : heuristicCaps(provider, id);
}

/**
 * The curated candidate of a role (fast, balanced, max), or null.
 * @param {ProviderId} provider
 * @param {ModelRole} role
 * @returns {string | null}
 */
export function roleModel(provider, role) {
  if (provider === 'nvidia' && !SNAPSHOT.providers.nvidia) return NVIDIA_DEFAULT_MODEL;
  return SNAPSHOT.providers[provider]?.roles?.[role] ?? null;
}

/** Ids of list entries that are not chat models (embeddings, speech, moderation, image-only). */
const NOT_CHAT = /embed|whisper|tts|transcribe|moderation|dall-e|imagen|veo|guard|realtime|audio|search-preview|ocr|rerank|^text-|babbage|davinci|aqa/;

/**
 * Whether a listed id is a chat model the picker should offer.
 * @param {string} id
 */
export function isChatModelId(id) {
  return !NOT_CHAT.test(String(id).toLowerCase());
}

/**
 * USD per million tokens from a per-token price string or number.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function perMillion(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : undefined;
}

/**
 * Reads a live model list. Anthropic (/v1/models), Gemini (/v1beta/models) and OpenRouter
 * (/api/v1/models) describe their models; other OpenAI-compatible lists give ids only.
 * @param {ProviderId} provider
 * @param {unknown} json
 * @returns {LiveModel[]}
 */
export function parseModelList(provider, json) {
  if (!isRecord(json)) return [];
  /** @type {LiveModel[]} */
  const out = [];
  if (provider === 'gemini') {
    for (const m of Array.isArray(json.models) ? json.models : []) {
      if (!isRecord(m) || typeof m.name !== 'string') continue;
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      if (!methods.includes('generateContent')) continue;
      const id = m.name.replace(/^models\//, '');
      /** @type {LiveModel} */
      const entry = { id };
      if (typeof m.displayName === 'string') entry.label = m.displayName;
      if (isCount(m.inputTokenLimit)) entry.contextTokens = m.inputTokenLimit;
      if (isCount(m.outputTokenLimit)) entry.maxOutput = m.outputTokenLimit;
      if (typeof m.thinking === 'boolean') entry.hints = { reasoning: m.thinking ? (/gemini-[3-9]/.test(id) ? 'effort' : 'budget') : 'none', reasoningVisible: m.thinking };
      out.push(entry);
    }
    return out;
  }
  for (const m of Array.isArray(json.data) ? json.data : []) {
    if (!isRecord(m) || typeof m.id !== 'string' || !m.id) continue;
    /** @type {LiveModel} */
    const entry = { id: m.id };
    if (provider === 'anthropic') {
      if (typeof m.display_name === 'string') entry.label = m.display_name;
      if (isCount(m.max_input_tokens)) entry.contextTokens = m.max_input_tokens;
      if (isCount(m.max_tokens)) entry.maxOutput = m.max_tokens;
      const c = isRecord(m.capabilities) ? m.capabilities : {};
      /** @type {NonNullable<LiveModel['hints']>} */
      const hints = {};
      if (isRecord(c.image_input) && typeof c.image_input.supported === 'boolean') hints.vision = c.image_input.supported;
      if (isRecord(c.pdf_input) && typeof c.pdf_input.supported === 'boolean') hints.pdf = c.pdf_input.supported;
      if (isRecord(c.structured_outputs) && typeof c.structured_outputs.supported === 'boolean') hints.json = c.structured_outputs.supported;
      const adaptive = c.thinking?.types?.adaptive?.supported;
      const enabled = c.thinking?.types?.enabled?.supported;
      if (adaptive === true) hints.reasoning = 'adaptive';
      else if (enabled === true) hints.reasoning = 'budget';
      if (Object.keys(hints).length) entry.hints = hints;
    } else if (provider === 'openrouter') {
      if (typeof m.name === 'string') entry.label = m.name;
      if (isCount(m.context_length)) entry.contextTokens = m.context_length;
      const top = isRecord(m.top_provider) ? m.top_provider : {};
      if (isCount(top.max_completion_tokens)) entry.maxOutput = top.max_completion_tokens;
      const arch = isRecord(m.architecture) ? m.architecture : {};
      const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
      const outputs = Array.isArray(arch.output_modalities) ? arch.output_modalities : [];
      const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
      const pricing = isRecord(m.pricing) ? m.pricing : {};
      const priceIn = perMillion(pricing.prompt);
      const priceOut = perMillion(pricing.completion);
      /** @type {NonNullable<LiveModel['hints']>} */
      const hints = {
        vision: inputs.includes('image'),
        pdf: inputs.includes('file'),
        imageOut: outputs.includes('image'),
        tools: params.includes('tools'),
        parallelTools: params.includes('tools'),
        json: params.includes('structured_outputs') || params.includes('response_format'),
        free: m.id.endsWith(':free') || (priceIn === 0 && priceOut === 0),
      };
      if (params.includes('reasoning')) {
        hints.reasoning = 'effort';
        hints.reasoningVisible = true;
      }
      if (priceIn !== undefined) hints.priceIn = priceIn;
      if (priceOut !== undefined) hints.priceOut = priceOut;
      entry.hints = hints;
    } else {
      if (!isChatModelId(m.id)) continue;
      if (isCount(m.context_length)) entry.contextTokens = m.context_length;
      else if (isCount(m.context_window)) entry.contextTokens = m.context_window;
      else if (isCount(m.max_context_length)) entry.contextTokens = m.max_context_length;
      else if (isCount(m.max_model_len)) entry.contextTokens = m.max_model_len;
    }
    out.push(entry);
  }
  return out;
}

/**
 * The snapshot's models merged with a live list. Snapshot models keep their curated caps (with the
 * live context and output limits when the list has them); a snapshot model the list does not name
 * stays, marked `listed: false`; models only the list names get guesses marked unverified.
 * @param {ProviderId} provider
 * @param {LiveModel[] | null | undefined} live
 * @returns {ModelEntry[]}
 */
export function mergeModels(provider, live) {
  const curated = snapshotModels(provider);
  if (!Array.isArray(live)) return curated;
  const byId = new Map(live.map((m) => [m.id, m]));
  /** @type {ModelEntry[]} */
  const out = curated.map((entry) => {
    const found = byId.get(entry.id);
    if (!found) return { ...entry, listed: false };
    const caps = { ...entry.caps };
    if (isCount(found.contextTokens)) caps.contextTokens = found.contextTokens;
    if (isCount(found.maxOutput)) caps.maxOutput = Math.min(found.maxOutput, caps.contextTokens);
    return { ...entry, caps, listed: true };
  });
  const known = new Set(curated.map((m) => m.id));
  for (const m of live) {
    if (known.has(m.id)) continue;
    known.add(m.id);
    out.push({ provider, id: m.id, label: m.label ?? m.id, caps: heuristicCaps(provider, m.id, { ...m.hints, contextTokens: m.contextTokens, maxOutput: m.maxOutput }), source: 'live', listed: true });
  }
  return out;
}

/**
 * The request of a provider's live model list, as a wire adapter builds it, or null for providers
 * without one.
 * @param {ProviderId} provider
 * @returns {{ path: string, method: 'GET', headers: Record<string, string> } | null}
 */
export function modelListRequest(provider) {
  const info = getProvider(provider);
  if (!info?.modelsPath) return null;
  /** @type {Record<string, string>} */
  const headers = provider === 'anthropic' ? { 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : {};
  const path = provider === 'anthropic' ? `${info.modelsPath}?limit=100` : provider === 'gemini' ? `${info.modelsPath}?pageSize=1000` : info.modelsPath;
  return { path, method: 'GET', headers };
}

/**
 * Fetches a provider's live list through a transport and merges it with the snapshot. A failed
 * list leaves the snapshot as it is; the error is returned, not thrown.
 * @param {ProviderId} provider
 * @param {Transport} transport
 * @param {{ signal?: AbortSignal, authHeader?: (key: string) => [string, string] }} [options]
 * @returns {Promise<{ models: ModelEntry[], error: unknown }>}
 */
export async function fetchModels(provider, transport, options = {}) {
  const built = modelListRequest(provider);
  if (!built) return { models: snapshotModels(provider), error: null };
  try {
    const res = await transport(options.authHeader ? { authHeader: options.authHeader } : null, built, { signal: options.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { models: snapshotModels(provider), error: new Error(`HTTP ${res.status}`) };
    }
    const json = JSON.parse(await readText(res.body, { maxBytes: MAX_LIST_BYTES }));
    return { models: mergeModels(provider, parseModelList(provider, json)), error: null };
  } catch (err) {
    return { models: snapshotModels(provider), error: err };
  }
}

/**
 * An estimate in USD of what a call cost, from its usage and the model's price hints; null when a
 * price is unknown. Cache reads are counted at a tenth of the input price, a common rate.
 * @param {Pick<UsageEvent, 'input' | 'output' | 'cacheRead'>} usage
 * @param {Caps} caps
 * @returns {number | null}
 */
export function estimateCostUsd(usage, caps) {
  if (caps.priceIn === undefined || caps.priceOut === undefined) return null;
  const cached = usage.cacheRead ?? 0;
  const fresh = Math.max(0, (usage.input ?? 0) - cached);
  const cost = (fresh * caps.priceIn + cached * caps.priceIn * 0.1 + (usage.output ?? 0) * caps.priceOut) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}
