// @ts-check
// The site's key pools: which providers the site can offer with its own keys, the dialect each one
// speaks, its endpoint and key variable, per-key pacing, request limits and the model allowlist.
// A pool model must be free or cheap to serve and must not need tools; nothing else is forwarded.
// The MiniMax pool serves the cloud base model with the site's own keys (MINIMAX_API_KEYS); it is
// offered only where the operator sets them.
//
// The model lists, default models and output caps come from the browser catalog
// (src/js/ai/catalog/pools.js), so the picker and the server always agree on what a pool allows;
// NVIDIA's per-model limits and fixed upstream fields come from src/js/models/nvidia-catalog.js.
// Check the lists with `npm run providers:ping -- --provider <id>` before a release (the ids of
// free models change often).
import { isPoolModel, parsePoolIds, POOLS } from '../../../src/js/ai/catalog/pools.js';
import { findNvidiaModel, NVIDIA_LIMITS, NVIDIA_PROXY, NVIDIA_UPSTREAM_URL } from '../../../src/js/models/nvidia-catalog.js';
import { KEY_PATTERN as NVIDIA_KEY_PATTERN } from '../env.js';

/**
 * @typedef {'openai-chat' | 'gemini'} PoolDialect
 * @typedef {object} PoolModel
 * @property {string} id sent upstream
 * @property {string} label a proper name, never translated
 * @property {string} vendor
 * @property {boolean} reasoning streams reasoning before the answer
 * @property {boolean} vision the pool accepts images for this model
 * @property {number} maxOutputTokens the pool clamps the requested output to this
 * @property {number} defaultMaxTokens used when a request names no limit
 * @property {Readonly<Record<string, unknown>>} [upstream] fixed extra fields of the upstream request
 * @typedef {object} PoolLimits
 * @property {number} maxMessages
 * @property {number} maxMessageChars UTF-16 code units of text per message
 * @property {number} maxTotalChars UTF-16 code units of text over all messages
 * @property {number} maxOutputTokens
 * @property {number} maxBodyBytes
 * @property {number} maxImages per request, vision models only
 * @property {number} maxImageChars base64 characters over all images of a request
 * @typedef {object} PoolSpec
 * @property {string} id
 * @property {string} label
 * @property {PoolDialect} dialect
 * @property {string} root API root; the dialect's path follows it
 * @property {'bearer' | 'x-goog-api-key'} auth
 * @property {string} keysVariable
 * @property {RegExp} keyPattern entries of another shape are ignored (and only counted)
 * @property {number} keyRpm requests per key and minute
 * @property {string} defaultModel
 * @property {PoolLimits} limits
 * @property {import('../../../src/js/models/nvidia-catalog.js').NvidiaProxyTiming} timing
 * @property {readonly PoolModel[]} models
 */

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !(value instanceof RegExp)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Keys of providers without a fixed shape: one token of URL-safe characters. */
const GENERIC_KEY = /^[A-Za-z0-9._~+/=-]{16,512}$/;
/** The same for a provider whose keys may be long signed tokens: as long as the relay accepts. */
const LONG_KEY = /^[A-Za-z0-9._~+/=-]{16,1024}$/;

/** Limits shared by the pools; the NVIDIA text limits stay those of its catalog. */
const IMAGE_LIMITS = { maxBodyBytes: 4_000_000, maxImages: 4, maxImageChars: 3_600_000 };

/** Output a request gets when it names no limit; reasoning models need room for their thinking. */
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_TOKENS_REASONING = 2048;

/**
 * The models of a pool as the catalog lists them, capped at the pool's output limit, with fixed
 * upstream fields when the pool sets any.
 * @param {import('../../../src/js/ai/catalog/pools.js').PoolId} id
 * @param {Readonly<Record<string, unknown>>} [upstream]
 * @returns {PoolModel[]}
 */
function catalogModels(id, upstream) {
  const pool = POOLS[id];
  return pool.entries.map(({ id: modelId, label, vendor, reasoning, vision }) => ({
    id: modelId,
    label,
    vendor,
    reasoning,
    vision,
    maxOutputTokens: pool.maxOutputTokens,
    defaultMaxTokens: Math.min(pool.maxOutputTokens, reasoning ? DEFAULT_MAX_TOKENS_REASONING : DEFAULT_MAX_TOKENS),
    ...(upstream ? { upstream } : {}),
  }));
}

/**
 * The MiniMax pool always asks for the lowest thinking effort: its models cannot switch thinking
 * off (src/js/ai/quirks/minimax.js), and the site's keys should not pay for the provider's default
 * of the highest effort. The browser's own effort field is dropped like every other extra.
 */
export const MINIMAX_POOL_UPSTREAM = Object.freeze({ reasoning_effort: 'low' });

/**
 * The NVIDIA pool's models: the catalog's list with NVIDIA's own per-model limits and fixed
 * upstream fields.
 * @returns {PoolModel[]}
 */
function nvidiaModels() {
  return POOLS.nvidia.models.flatMap((modelId) => {
    const m = findNvidiaModel(modelId);
    if (!m) return [];
    const { id, label, vendor, reasoning, vision, maxOutputTokens, defaultMaxTokens, upstream } = m;
    return [{ id, label, vendor, reasoning, vision, maxOutputTokens, defaultMaxTokens, ...(upstream ? { upstream } : {}) }];
  });
}

/** @type {Readonly<Record<string, PoolSpec>>} */
export const POOL_SPECS = deepFreeze({
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    dialect: 'openai-chat',
    root: 'https://api.minimax.io',
    auth: 'bearer',
    keysVariable: 'MINIMAX_API_KEYS',
    keyPattern: LONG_KEY,
    keyRpm: 20,
    defaultModel: POOLS.minimax.defaultModel,
    limits: { maxMessages: 40, maxMessageChars: 24000, maxTotalChars: 64000, maxOutputTokens: POOLS.minimax.maxOutputTokens, ...IMAGE_LIMITS },
    timing: NVIDIA_PROXY,
    models: catalogModels('minimax', MINIMAX_POOL_UPSTREAM),
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    dialect: 'openai-chat',
    root: new URL('../..', NVIDIA_UPSTREAM_URL).href.replace(/\/+$/, ''),
    auth: 'bearer',
    keysVariable: 'NVIDIA_API_KEYS',
    keyPattern: NVIDIA_KEY_PATTERN,
    keyRpm: 40,
    defaultModel: POOLS.nvidia.defaultModel,
    limits: { maxMessages: NVIDIA_LIMITS.maxMessages, maxMessageChars: NVIDIA_LIMITS.maxMessageChars, maxTotalChars: NVIDIA_LIMITS.maxTotalChars, maxOutputTokens: POOLS.nvidia.maxOutputTokens, ...IMAGE_LIMITS },
    timing: NVIDIA_PROXY,
    models: nvidiaModels(),
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    dialect: 'openai-chat',
    root: 'https://api.groq.com/openai',
    auth: 'bearer',
    keysVariable: 'GROQ_API_KEYS',
    keyPattern: GENERIC_KEY,
    keyRpm: 30,
    defaultModel: POOLS.groq.defaultModel,
    limits: { maxMessages: 40, maxMessageChars: 24000, maxTotalChars: 64000, maxOutputTokens: POOLS.groq.maxOutputTokens, ...IMAGE_LIMITS },
    timing: NVIDIA_PROXY,
    models: catalogModels('groq'),
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    dialect: 'gemini',
    root: 'https://generativelanguage.googleapis.com',
    auth: 'x-goog-api-key',
    keysVariable: 'GEMINI_API_KEYS',
    keyPattern: GENERIC_KEY,
    keyRpm: 10,
    defaultModel: POOLS.gemini.defaultModel,
    limits: { maxMessages: 40, maxMessageChars: 24000, maxTotalChars: 64000, maxOutputTokens: POOLS.gemini.maxOutputTokens, ...IMAGE_LIMITS },
    timing: NVIDIA_PROXY,
    models: catalogModels('gemini'),
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    dialect: 'openai-chat',
    root: 'https://openrouter.ai/api',
    auth: 'bearer',
    keysVariable: 'OPENROUTER_API_KEYS',
    keyPattern: GENERIC_KEY,
    keyRpm: 20,
    defaultModel: POOLS.openrouter.defaultModel,
    limits: { maxMessages: 40, maxMessageChars: 24000, maxTotalChars: 64000, maxOutputTokens: POOLS.openrouter.maxOutputTokens, ...IMAGE_LIMITS },
    timing: NVIDIA_PROXY,
    models: catalogModels('openrouter'),
  },
});

export const POOL_IDS = Object.freeze(Object.keys(POOL_SPECS));

/**
 * @param {string} id
 * @returns {PoolSpec | null}
 */
export function findPoolSpec(id) {
  return Object.hasOwn(POOL_SPECS, id) ? POOL_SPECS[id] : null;
}

/**
 * A model of the pool's allowlist (exact ids only, as the catalog's isPoolModel decides).
 * @param {PoolSpec} spec
 * @param {unknown} id
 * @returns {PoolModel | undefined}
 */
export function findPoolModel(spec, id) {
  return isPoolModel(spec.id, id) ? spec.models.find((m) => m.id === id) : undefined;
}

/**
 * The models of a pool as GET /api/models/pool publishes them: no upstream extras.
 * @param {PoolSpec} spec
 */
export function publicPoolModels(spec) {
  return spec.models.map(({ id, label, vendor, reasoning, vision, maxOutputTokens, defaultMaxTokens }) => ({ id, label, vendor, reasoning, vision, maxOutputTokens, defaultMaxTokens }));
}

/**
 * Keys of a pool from its variable: split on commas and whitespace, deduplicated; entries of
 * another shape are dropped and only counted, so a caller can report the number without a key.
 * @param {PoolSpec} spec
 * @param {string | undefined} raw
 * @returns {{ keys: string[], invalid: number }}
 */
export function parsePoolKeys(spec, raw) {
  const entries = [...new Set((raw ?? '').split(/[\s,]+/).filter(Boolean))];
  const keys = entries.filter((entry) => spec.keyPattern.test(entry));
  return { keys, invalid: entries.length - keys.length };
}

/**
 * The pools a site offers: STARPI_POOL_PROVIDERS (comma separated), or all of them when unset.
 * Unknown names are ignored. A pool still needs keys before it serves anything.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function enabledPoolIds(raw) {
  const text = (raw ?? '').replace(/\s+/g, ',');
  if (!text.split(',').some(Boolean)) return [...POOL_IDS];
  const names = /** @type {readonly string[]} */ (parsePoolIds(text));
  return POOL_IDS.filter((id) => names.includes(id));
}
