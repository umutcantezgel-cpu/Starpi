// @ts-check
// NVIDIA NIM cloud models that the proxy may call, with the request limits and timings both proxies
// enforce. Pure data and helpers: bundled by the app (model picker, NVIDIA client), imported by the
// Vercel Functions in api/. It is also the NVIDIA section of the AI layer's model catalog: nvidiaSnapshotSection()
// is what `npm run models:sync` writes into src/js/ai/catalog/snapshot.json. Check the endpoints
// with `npm run providers:ping` before changing the list.

/**
 * @typedef {object} NvidiaModel
 * @property {string} id NVIDIA model id, sent upstream as `model`.
 * @property {string} label Name shown in the model picker (a proper name, never translated).
 * @property {string} vendor
 * @property {boolean} reasoning Streams `reasoning_content` before the answer.
 * @property {boolean} vision Accepts images upstream (Starpi sends text only).
 * @property {number} maxOutputTokens Upper bound for `max_tokens` (the server clamps to it).
 * @property {number} defaultMaxTokens `max_tokens` the app sends.
 * @property {Readonly<Record<string, unknown>>} [upstream] Fixed extra fields for the upstream request.
 *
 * @typedef {object} NvidiaLimits
 * @property {number} maxMessages
 * @property {number} maxMessageChars UTF-16 code units per message.
 * @property {number} maxTotalChars UTF-16 code units over all messages.
 * @property {number} maxOutputTokens
 * @property {number} defaultMaxTokens
 * @property {number} maxBodyBytes
 *
 * @typedef {object} NvidiaProxyTiming
 * @property {number} attemptTimeoutMs Time one key gets to deliver the first byte.
 * @property {number} failoverBudgetMs Time all keys together get to deliver the first byte.
 * @property {number} idleTimeoutMs Longest gap between two chunks once the stream runs.
 * @property {number} streamMaxMs Longest stream, measured from the request.
 * @property {number} maxStreamBytes
 * @property {number} rateLimitPerMinute Requests per client IP and minute (per instance).
 * @property {{ rateLimitedDefault: number, rateLimitedMin: number, rateLimitedMax: number, auth: number, transient: number }} cooldownMs
 *
 * @typedef {{ models: number, firstByte: number, idle: number, total: number }} NvidiaClientTimeouts
 */

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const THINKING_OFF = { chat_template_kwargs: { enable_thinking: false } };

export const NVIDIA_CATALOG = deepFreeze({
  version: 1,
  upstream: 'https://integrate.api.nvidia.com/v1/chat/completions',
  defaultModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  /** @type {NvidiaLimits} */
  limits: { maxMessages: 40, maxMessageChars: 24000, maxTotalChars: 64000, maxOutputTokens: 4096, defaultMaxTokens: 1024, maxBodyBytes: 262144 },
  /** @type {NvidiaProxyTiming} */
  proxy: {
    attemptTimeoutMs: 20000,
    failoverBudgetMs: 25000,
    idleTimeoutMs: 30000,
    streamMaxMs: 240000,
    maxStreamBytes: 4194304,
    rateLimitPerMinute: 20,
    cooldownMs: { rateLimitedDefault: 20000, rateLimitedMin: 1000, rateLimitedMax: 300000, auth: 1800000, transient: 10000 },
  },
  /** @type {NvidiaModel[]} */
  models: [
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 Lightning 30B A3B', vendor: 'NVIDIA', reasoning: false, vision: false, maxOutputTokens: 2048, defaultMaxTokens: 1024, upstream: THINKING_OFF },
    { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B A12B', vendor: 'NVIDIA', reasoning: true, vision: false, maxOutputTokens: 4096, defaultMaxTokens: 2048 },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 3 Ultra 550B A55B', vendor: 'NVIDIA', reasoning: true, vision: false, maxOutputTokens: 4096, defaultMaxTokens: 2048 },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', label: 'Nemotron 3 Nano Omni 30B A3B', vendor: 'NVIDIA', reasoning: true, vision: true, maxOutputTokens: 4096, defaultMaxTokens: 2048 },
    { id: 'moonshotai/kimi-k3', label: 'Kimi K3', vendor: 'Moonshot AI', reasoning: true, vision: true, maxOutputTokens: 4096, defaultMaxTokens: 2048 },
    { id: 'z-ai/glm-5.3', label: 'GLM-5.3', vendor: 'Z.ai', reasoning: true, vision: false, maxOutputTokens: 4096, defaultMaxTokens: 2048 },
    { id: 'z-ai/glm-5.3-flash', label: 'GLM-5.3 Flash', vendor: 'Z.ai', reasoning: true, vision: true, maxOutputTokens: 4096, defaultMaxTokens: 2048 },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', vendor: 'OpenAI', reasoning: true, vision: false, maxOutputTokens: 4096, defaultMaxTokens: 2048 },
    { id: 'meta/muse-glimmer-30b', label: 'Muse Glimmer 30B', vendor: 'Meta', reasoning: true, vision: true, maxOutputTokens: 4096, defaultMaxTokens: 2048 },
    { id: 'poolside/laguna-xs-2.1', label: 'Laguna XS 2.1', vendor: 'Poolside', reasoning: false, vision: false, maxOutputTokens: 2048, defaultMaxTokens: 1024 },
    { id: 'meta/llama-3.2-90b-vision-instruct', label: 'Llama 3.2 90B Vision Instruct', vendor: 'Meta', reasoning: false, vision: true, maxOutputTokens: 2048, defaultMaxTokens: 1024 },
    { id: 'meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 11B Vision Instruct', vendor: 'Meta', reasoning: false, vision: true, maxOutputTokens: 2048, defaultMaxTokens: 1024 },
    { id: 'google/diffusiongemma-26b-a4b-it', label: 'DiffusionGemma 26B A4B', vendor: 'Google', reasoning: false, vision: false, maxOutputTokens: 2048, defaultMaxTokens: 1024 },
  ],
});

export const NVIDIA_MODELS = NVIDIA_CATALOG.models;
export const NVIDIA_LIMITS = NVIDIA_CATALOG.limits;
export const NVIDIA_PROXY = NVIDIA_CATALOG.proxy;
export const NVIDIA_DEFAULT_MODEL = NVIDIA_CATALOG.defaultModel;
export const NVIDIA_UPSTREAM_URL = NVIDIA_CATALOG.upstream;

/**
 * Browser-side timeouts, derived from the proxy's so that the proxy's own error always arrives first.
 * @type {Readonly<NvidiaClientTimeouts>}
 */
export const NVIDIA_CLIENT_TIMEOUTS = Object.freeze({
  models: 6000,
  firstByte: NVIDIA_PROXY.failoverBudgetMs + 10000,
  idle: NVIDIA_PROXY.idleTimeoutMs + 10000,
  total: NVIDIA_PROXY.streamMaxMs + 15000,
});

/**
 * @param {unknown} id
 * @returns {NvidiaModel | undefined}
 */
export function findNvidiaModel(id) {
  return typeof id === 'string' ? NVIDIA_MODELS.find((m) => m.id === id) : undefined;
}

/**
 * An allowlisted id, or the default model for anything else (e.g. a model removed in a later version).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeNvidiaModel(value) {
  return findNvidiaModel(value)?.id ?? NVIDIA_DEFAULT_MODEL;
}

/**
 * The model list as GET /api/models/nvidia publishes it: no upstream extras.
 * @param {boolean} configured whether the server has at least one key
 */
export function publicCatalog(configured) {
  return {
    configured,
    version: NVIDIA_CATALOG.version,
    defaultModel: NVIDIA_DEFAULT_MODEL,
    limits: NVIDIA_LIMITS,
    models: NVIDIA_MODELS.map(({ id, label, vendor, reasoning, vision, maxOutputTokens, defaultMaxTokens }) => ({
      id,
      label,
      vendor,
      reasoning,
      vision,
      maxOutputTokens,
      defaultMaxTokens,
    })),
  };
}

/** The catalog as stable JSON text (for tools that need a file copy of the allowlist). */
export function catalogJson() {
  return `${JSON.stringify(NVIDIA_CATALOG, null, 2)}\n`;
}

/** Context window assumed for NIM models; the proxy caps every request well below it (NVIDIA_LIMITS). */
export const NVIDIA_CONTEXT_TOKENS = 32_768;

/**
 * The NVIDIA section of the model catalog snapshot: every allowlisted model with its capability
 * flags, in catalog order, and the default model as the candidate for every role. The models
 * reason visibly (`tagged`) when they stream reasoning, take images when flagged, and are free
 * through the site pool.
 */
export function nvidiaSnapshotSection() {
  const fast = NVIDIA_MODELS.find((m) => !m.reasoning)?.id ?? NVIDIA_DEFAULT_MODEL;
  return {
    roles: { fast, balanced: NVIDIA_DEFAULT_MODEL, max: NVIDIA_MODELS.find((m) => m.id.includes('ultra'))?.id ?? NVIDIA_DEFAULT_MODEL },
    models: NVIDIA_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      vendor: m.vendor,
      caps: {
        text: true,
        vision: m.vision,
        pdf: false,
        tools: false,
        parallelTools: false,
        reasoning: m.reasoning ? 'tagged' : 'none',
        reasoningVisible: m.reasoning,
        search: 'none',
        imageOut: false,
        audioIn: false,
        live: false,
        json: false,
        contextTokens: NVIDIA_CONTEXT_TOKENS,
        maxOutput: m.maxOutputTokens,
        latency: m.reasoning ? 'normal' : 'fast',
        free: true,
        local: false,
        verified: true,
      },
    })),
  };
}
