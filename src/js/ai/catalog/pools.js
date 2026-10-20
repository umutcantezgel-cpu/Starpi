// @ts-check
// Model allowlists of the site's key pools (/api/pool): which models a pool may call with the
// site's own keys, what the pool tells about each (name, vendor, reasoning, images), its default
// model and its output cap. The NVIDIA pool takes its list from the NVIDIA catalog; the MiniMax pool
// serves the cloud base model (catalog/providers.js BASE_MODEL) and comes first, so a site that
// offers it makes it the default free model; the others list free-tier models of their provider.
// Pure data, imported by the browser (the "Free (via Starpi)" picker group) and by the server's
// pool allowlist (api/_lib/pool/allowlist.js), so both agree on what is allowed.
import { NVIDIA_DEFAULT_MODEL, NVIDIA_LIMITS, NVIDIA_MODELS } from '../../models/nvidia-catalog.js';
import { BASE_MODEL } from './providers.js';

/** @typedef {import('../contract.js').ProviderId} ProviderId */
/** @typedef {'minimax' | 'nvidia' | 'groq' | 'gemini' | 'openrouter'} PoolId */

/**
 * @typedef {object} PoolModelInfo
 * @property {string} id
 * @property {string} label        proper name, never translated
 * @property {string} vendor
 * @property {boolean} reasoning   streams reasoning before the answer
 * @property {boolean} vision      may receive images
 */

/**
 * @typedef {object} PoolInfo
 * @property {PoolId} id
 * @property {ProviderId} provider
 * @property {readonly Readonly<PoolModelInfo>[]} entries  the allowlisted models, in picker order
 * @property {readonly string[]} models        their ids
 * @property {string} defaultModel
 * @property {readonly string[]} visionModels  models of the list that may receive images
 * @property {number} maxOutputTokens          cap on `max_tokens` the pool enforces
 */

export const POOL_IDS = /** @type {readonly PoolId[]} */ (Object.freeze(['minimax', 'nvidia', 'groq', 'gemini', 'openrouter']));

/**
 * @param {Omit<PoolInfo, 'models' | 'visionModels'>} info
 * @returns {Readonly<PoolInfo>}
 */
const pool = (info) => {
  const entries = Object.freeze(info.entries.map((m) => Object.freeze({ ...m })));
  return Object.freeze({ ...info, entries, models: Object.freeze(entries.map((m) => m.id)), visionModels: Object.freeze(entries.filter((m) => m.vision).map((m) => m.id)) });
};

/**
 * @param {string} id
 * @param {string} label
 * @param {string} vendor
 * @param {{ reasoning?: boolean, vision?: boolean }} [flags]
 * @returns {PoolModelInfo}
 */
const entry = (id, label, vendor, flags = {}) => ({ id, label, vendor, reasoning: flags.reasoning === true, vision: flags.vision === true });

/** @type {Readonly<Record<PoolId, Readonly<PoolInfo>>>} */
export const POOLS = Object.freeze({
  // The base model; the server asks it for the lowest thinking effort (api/_lib/pool/allowlist.js).
  minimax: pool({
    id: 'minimax',
    provider: 'minimax',
    entries: [entry(BASE_MODEL, 'MiniMax M3.1 Flash', 'MiniMax', { reasoning: true })],
    defaultModel: BASE_MODEL,
    maxOutputTokens: 4096,
  }),
  nvidia: pool({
    id: 'nvidia',
    provider: 'nvidia',
    entries: NVIDIA_MODELS.map((m) => entry(m.id, m.label, m.vendor, m)),
    defaultModel: NVIDIA_DEFAULT_MODEL,
    maxOutputTokens: NVIDIA_LIMITS.maxOutputTokens,
  }),
  groq: pool({
    id: 'groq',
    provider: 'groq',
    entries: [
      entry('llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', 'Meta'),
      entry('llama-3.1-8b-instant', 'Llama 3.1 8B Instant', 'Meta'),
      entry('openai/gpt-oss-20b', 'GPT-OSS 20B', 'OpenAI', { reasoning: true }),
      entry('openai/gpt-oss-120b', 'GPT-OSS 120B', 'OpenAI', { reasoning: true }),
      entry('qwen/qwen3-32b', 'Qwen3 32B', 'Alibaba', { reasoning: true }),
    ],
    defaultModel: 'llama-3.3-70b-versatile',
    maxOutputTokens: 4096,
  }),
  gemini: pool({
    id: 'gemini',
    provider: 'gemini',
    entries: [entry('gemini-2.5-flash', 'Gemini 2.5 Flash', 'Google', { reasoning: true, vision: true }), entry('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 'Google', { vision: true })],
    defaultModel: 'gemini-2.5-flash-lite',
    maxOutputTokens: 4096,
  }),
  openrouter: pool({
    id: 'openrouter',
    provider: 'openrouter',
    entries: [
      entry('meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B Instruct (free)', 'Meta'),
      entry('deepseek/deepseek-r1:free', 'DeepSeek R1 (free)', 'DeepSeek', { reasoning: true }),
      entry('google/gemma-3-27b-it:free', 'Gemma 3 27B (free)', 'Google', { vision: true }),
      entry('qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 'Alibaba'),
    ],
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    maxOutputTokens: 4096,
  }),
});

/**
 * @param {unknown} id
 * @returns {id is PoolId}
 */
export function isPoolId(id) {
  return typeof id === 'string' && /** @type {readonly string[]} */ (POOL_IDS).includes(id);
}

/**
 * @param {unknown} id
 * @returns {Readonly<PoolInfo> | null}
 */
export function getPool(id) {
  return isPoolId(id) ? POOLS[id] : null;
}

/**
 * The allowlist of a pool; empty for an unknown pool.
 * @param {unknown} id
 * @returns {readonly string[]}
 */
export function poolAllowlist(id) {
  return getPool(id)?.models ?? [];
}

/**
 * Whether a pool may call a model. Only exact ids pass.
 * @param {unknown} id
 * @param {unknown} model
 */
export function isPoolModel(id, model) {
  return typeof model === 'string' && poolAllowlist(id).includes(model);
}

/**
 * An allowlisted model, or the pool's default for anything else; null for an unknown pool.
 * @param {unknown} id
 * @param {unknown} model
 * @returns {string | null}
 */
export function normalizePoolModel(id, model) {
  const info = getPool(id);
  if (!info) return null;
  return isPoolModel(id, model) ? /** @type {string} */ (model) : info.defaultModel;
}

/**
 * The pools a comma-separated setting enables (such as the pool providers environment variable),
 * in the order given, without duplicates or unknown names.
 * @param {unknown} value
 * @returns {PoolId[]}
 */
export function parsePoolIds(value) {
  if (typeof value !== 'string') return [];
  /** @type {PoolId[]} */
  const out = [];
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase();
    if (isPoolId(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
