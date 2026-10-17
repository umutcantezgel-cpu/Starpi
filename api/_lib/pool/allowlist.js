// @ts-check
// The site's key pools: which providers the site can offer with its own keys, the dialect each one
// speaks, its endpoint and key variable, per-key pacing, request limits and the model allowlist.
// A pool model must be free or cheap to serve and must not need tools; nothing else is forwarded.
//
// The NVIDIA section comes from src/js/models/nvidia-catalog.js. The other lists are a curated
// start: check them with `npm run providers:ping -- --provider <id>` before a release (the ids of
// free models change often). Once the browser catalog carries pool allowlists of its own
// (src/js/ai/catalog/pools.js), these lists should be read from there instead.
import { NVIDIA_DEFAULT_MODEL, NVIDIA_LIMITS, NVIDIA_MODELS, NVIDIA_PROXY, NVIDIA_UPSTREAM_URL } from '../../../src/js/models/nvidia-catalog.js';
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

/** Limits shared by the pools; the NVIDIA text limits stay those of its catalog. */
const IMAGE_LIMITS = { maxBodyBytes: 4_000_000, maxImages: 4, maxImageChars: 3_600_000 };

/** @param {string} id @param {string} label @param {string} vendor @param {Partial<PoolModel>} [rest] */
const model = (id, label, vendor, rest = {}) => ({ id, label, vendor, reasoning: false, vision: false, maxOutputTokens: 4096, defaultMaxTokens: 1024, ...rest });

/** @type {Readonly<Record<string, PoolSpec>>} */
export const POOL_SPECS = deepFreeze({
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    dialect: 'openai-chat',
    root: new URL('../..', NVIDIA_UPSTREAM_URL).href.replace(/\/+$/, ''),
    auth: 'bearer',
    keysVariable: 'NVIDIA_API_KEYS',
    keyPattern: NVIDIA_KEY_PATTERN,
    keyRpm: 40,
    defaultModel: NVIDIA_DEFAULT_MODEL,
    limits: { maxMessages: NVIDIA_LIMITS.maxMessages, maxMessageChars: NVIDIA_LIMITS.maxMessageChars, maxTotalChars: NVIDIA_LIMITS.maxTotalChars, maxOutputTokens: NVIDIA_LIMITS.maxOutputTokens, ...IMAGE_LIMITS },
    timing: NVIDIA_PROXY,
    models: NVIDIA_MODELS.map(({ id, label, vendor, reasoning, vision, maxOutputTokens, defaultMaxTokens, upstream }) => ({ id, label, vendor, reasoning, vision, maxOutputTokens, defaultMaxTokens, ...(upstream ? { upstream } : {}) })),
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
    defaultModel: 'llama-3.3-70b-versatile',
    limits: { maxMessages: 40, maxMessageChars: 24000, maxTotalChars: 64000, maxOutputTokens: 4096, ...IMAGE_LIMITS },
    timing: NVIDIA_PROXY,
    models: [
      model('llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', 'Meta'),
      model('llama-3.1-8b-instant', 'Llama 3.1 8B Instant', 'Meta'),
      model('meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B 16E', 'Meta', { vision: true }),
      model('openai/gpt-oss-120b', 'GPT-OSS 120B', 'OpenAI', { reasoning: true, defaultMaxTokens: 2048 }),
      model('openai/gpt-oss-20b', 'GPT-OSS 20B', 'OpenAI', { reasoning: true, defaultMaxTokens: 2048 }),
      model('qwen/qwen3-32b', 'Qwen3 32B', 'Alibaba', { reasoning: true, defaultMaxTokens: 2048 }),
    ],
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
    defaultModel: 'gemini-2.5-flash',
    limits: { maxMessages: 40, maxMessageChars: 24000, maxTotalChars: 64000, maxOutputTokens: 8192, ...IMAGE_LIMITS },
    timing: NVIDIA_PROXY,
    models: [
      model('gemini-2.5-flash', 'Gemini 2.5 Flash', 'Google', { reasoning: true, vision: true, maxOutputTokens: 8192, defaultMaxTokens: 2048 }),
      model('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 'Google', { vision: true, maxOutputTokens: 8192, defaultMaxTokens: 1024 }),
    ],
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
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    limits: { maxMessages: 40, maxMessageChars: 24000, maxTotalChars: 64000, maxOutputTokens: 4096, ...IMAGE_LIMITS },
    timing: NVIDIA_PROXY,
    models: [
      model('meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B Instruct (free)', 'Meta'),
      model('openai/gpt-oss-20b:free', 'GPT-OSS 20B (free)', 'OpenAI', { reasoning: true, defaultMaxTokens: 2048 }),
      model('deepseek/deepseek-chat-v3.1:free', 'DeepSeek V3.1 (free)', 'DeepSeek'),
      model('google/gemma-3-27b-it:free', 'Gemma 3 27B (free)', 'Google', { vision: true }),
    ],
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
 * @param {PoolSpec} spec
 * @param {unknown} id
 * @returns {PoolModel | undefined}
 */
export function findPoolModel(spec, id) {
  return typeof id === 'string' ? spec.models.find((m) => m.id === id) : undefined;
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
  const names = (raw ?? '').split(/[\s,]+/).map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return [...POOL_IDS];
  return POOL_IDS.filter((id) => names.includes(id));
}
