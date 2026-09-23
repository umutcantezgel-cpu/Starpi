// @ts-check
// Pure model selection and prompt budgeting for on-device inference. No DOM or WebGPU access,
// so everything here is unit-tested under Node (tests/unit/models.test.mjs).

/**
 * @typedef {'llama-1b' | 'qwen-1.5b' | 'qwen-3b'} ModelKey
 * @typedef {'auto' | ModelKey} ModelPreference
 *
 * @typedef {object} ModelSpec
 * @property {string} label
 * @property {string} f16 WebLLM model id using shader-f16 kernels.
 * @property {string} f32 Fallback id for adapters without the shader-f16 feature.
 * @property {number} approxDownloadMB
 *
 * @typedef {object} HardwareProfile
 * @property {boolean} isMobile
 * @property {number | null} deviceMemoryGB navigator.deviceMemory (null when the browser hides it)
 * @property {number} maxBufferSize adapter.limits.maxBufferSize in bytes
 * @property {boolean} hasF16 adapter.features.has('shader-f16')
 *
 * @typedef {object} ModelChoice
 * @property {ModelKey} key
 * @property {string} modelId
 * @property {string} label
 * @property {boolean} f16
 * @property {number} approxDownloadMB
 * @property {{ context_window_size: number, prefill_chunk_size: number }} chatOptions
 * @property {'manual' | 'auto'} reason
 */

/** @type {Readonly<Record<ModelKey, ModelSpec>>} */
export const MODEL_CATALOG = Object.freeze({
  'llama-1b': {
    label: 'Llama 3.2 1B',
    f16: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 700,
  },
  'qwen-1.5b': {
    label: 'Qwen 2.5 1.5B',
    f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 1_000,
  },
  'qwen-3b': {
    label: 'Qwen 2.5 3B',
    f16: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-3B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 1_900,
  },
});

/** Every WebLLM model id this app may request (validated against WebLLM's prebuilt list in CI). */
export const ALL_MODEL_IDS = Object.freeze(Object.values(MODEL_CATALOG).flatMap((m) => [m.f16, m.f32]));

const GIB = 1024 ** 3;

/**
 * Normalizes a persisted preference. Unknown values (e.g. models removed in later versions) become 'auto'.
 * @param {unknown} value
 * @returns {ModelPreference}
 */
export function normalizePreference(value) {
  return typeof value === 'string' && Object.hasOwn(MODEL_CATALOG, value) ? /** @type {ModelKey} */ (value) : 'auto';
}

/**
 * Picks a model for the adapter. Manual preferences win; 'auto' is conservative when memory is unknown.
 * @param {HardwareProfile} hw
 * @param {ModelPreference} preference
 * @returns {ModelChoice}
 */
export function chooseModel(hw, preference) {
  /** @type {ModelKey} */
  let key;
  if (preference !== 'auto') {
    key = preference;
  } else if (hw.isMobile) {
    key = 'llama-1b';
  } else if (hw.maxBufferSize >= GIB && hw.deviceMemoryGB !== null && hw.deviceMemoryGB >= 8) {
    key = 'qwen-3b';
  } else if (hw.maxBufferSize >= GIB && hw.deviceMemoryGB === null) {
    key = 'qwen-1.5b';
  } else {
    key = 'llama-1b';
  }

  const spec = MODEL_CATALOG[key];
  const large = key === 'qwen-3b' && !hw.isMobile;
  return {
    key,
    modelId: hw.hasF16 ? spec.f16 : spec.f32,
    label: spec.label,
    f16: hw.hasF16,
    approxDownloadMB: spec.approxDownloadMB,
    chatOptions: {
      context_window_size: large ? 4096 : 2048,
      prefill_chunk_size: hw.isMobile ? 128 : large ? 512 : 256,
    },
    reason: preference === 'auto' ? 'auto' : 'manual',
  };
}

/**
 * @param {{ userAgent: string, userAgentDataMobile?: boolean | undefined }} nav
 */
export function detectMobile(nav) {
  if (typeof nav.userAgentDataMobile === 'boolean') return nav.userAgentDataMobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
}

/** Conservative characters-per-token estimate (German text tokenizes denser than English). */
const CHARS_PER_TOKEN = 3;

/**
 * Trims system context, history and user prompt so the request fits the model's context window.
 * Priority: the user's question, then retrieved context, then the most recent history.
 * @param {{ contextWindow: number, maxOutputTokens: number, system: string, context: string, history: Array<{ role: 'user' | 'assistant', content: string }>, user: string }} input
 */
export function budgetPrompt(input) {
  const reserveTokens = input.maxOutputTokens + 128; // output + chat template overhead
  let remaining = Math.max(256, input.contextWindow - reserveTokens) * CHARS_PER_TOKEN;

  const take = (/** @type {string} */ text, /** @type {number} */ max) => {
    const allowed = Math.max(0, Math.min(max, remaining));
    const out = text.length > allowed ? `${text.slice(0, Math.max(0, allowed - 1))}…` : text;
    remaining -= out.length;
    return out;
  };

  const system = take(input.system, Math.floor(remaining * 0.15));
  const user = take(input.user, Math.floor(remaining * 0.35));
  const context = take(input.context, Math.floor(remaining * 0.8));

  /** @type {Array<{ role: 'user' | 'assistant', content: string }>} */
  const history = [];
  for (const msg of [...input.history].reverse()) {
    const content = msg.content.length > 600 ? `${msg.content.slice(0, 599)}…` : msg.content;
    if (content.length > remaining) break;
    remaining -= content.length;
    history.unshift({ role: msg.role, content });
  }
  return { system, context, user, history };
}
