// @ts-check
// Model allowlists of the site's key pools (/api/pool): which models a pool may call with the
// site's own keys, its default model and its output cap. The NVIDIA pool takes its list from the
// NVIDIA catalog; the others list free-tier models of their provider. Pure data, imported by the
// browser (the "Free (via Starpi)" picker group) and by the pool's request validator, so both
// agree on what is allowed.
import { NVIDIA_DEFAULT_MODEL, NVIDIA_LIMITS, NVIDIA_MODELS } from '../../models/nvidia-catalog.js';

/** @typedef {import('../contract.js').ProviderId} ProviderId */
/** @typedef {'nvidia' | 'groq' | 'gemini' | 'openrouter'} PoolId */

/**
 * @typedef {object} PoolInfo
 * @property {PoolId} id
 * @property {ProviderId} provider
 * @property {readonly string[]} models        allowlisted model ids, in picker order
 * @property {string} defaultModel
 * @property {readonly string[]} visionModels  models of the list that may receive images
 * @property {number} maxOutputTokens          cap on `max_tokens` the pool enforces
 */

export const POOL_IDS = /** @type {readonly PoolId[]} */ (Object.freeze(['nvidia', 'groq', 'gemini', 'openrouter']));

/**
 * @param {PoolInfo} info
 * @returns {Readonly<PoolInfo>}
 */
const pool = (info) => Object.freeze({ ...info, models: Object.freeze([...info.models]), visionModels: Object.freeze([...info.visionModels]) });

/** @type {Readonly<Record<PoolId, Readonly<PoolInfo>>>} */
export const POOLS = Object.freeze({
  nvidia: pool({
    id: 'nvidia',
    provider: 'nvidia',
    models: NVIDIA_MODELS.map((m) => m.id),
    defaultModel: NVIDIA_DEFAULT_MODEL,
    visionModels: NVIDIA_MODELS.filter((m) => m.vision).map((m) => m.id),
    maxOutputTokens: NVIDIA_LIMITS.maxOutputTokens,
  }),
  groq: pool({
    id: 'groq',
    provider: 'groq',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'],
    defaultModel: 'llama-3.3-70b-versatile',
    visionModels: [],
    maxOutputTokens: 4096,
  }),
  gemini: pool({
    id: 'gemini',
    provider: 'gemini',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    defaultModel: 'gemini-2.5-flash-lite',
    visionModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    maxOutputTokens: 4096,
  }),
  openrouter: pool({
    id: 'openrouter',
    provider: 'openrouter',
    models: ['meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-r1:free', 'google/gemma-3-27b-it:free', 'qwen/qwen3-coder:free'],
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    visionModels: ['google/gemma-3-27b-it:free'],
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
