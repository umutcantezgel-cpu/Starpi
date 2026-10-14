// @ts-check
// Pure model catalog, model selection and prompt budgeting for on-device inference. No DOM or WebGPU
// access, so everything here is unit-tested under Node (tests/unit/models.test.mjs).
import { recommendModels } from '../models/device.js';
import { WASM_CATALOG } from '../models/wasm-catalog.js';

export { detectMobile } from '../models/device.js';

/**
 * @typedef {'smollm2-360m' | 'qwen-0.5b' | 'llama-1b' | 'qwen-1.5b' | 'smollm2-1.7b' | 'gemma-2b' | 'llama-3b' | 'phi-3.5-mini' | 'qwen-3b' | 'mistral-7b' | 'qwen-7b' | 'llama-8b' | 'gemma-9b'} ModelKey
 * @typedef {'t1' | 't2' | 't3'} LocalTier
 * @typedef {import('../models/wasm-catalog.js').WasmModelKey} WasmModelKey
 * @typedef {import('../models/wasm-catalog.js').WasmSource} WasmSource
 * @typedef {import('../models/device.js').HardwareProfile} HardwareProfile
 *
 * @typedef {`webgpu:${ModelKey}` | `wasm:${WasmModelKey}`} PresetRef A preset of either runtime.
 * @typedef {'auto' | PresetRef} LocalModelRef Stored in starpi_webgpu_model.
 * @typedef {LocalModelRef} ModelPreference
 *
 * @typedef {object} ModelSpec
 * @property {string} label
 * @property {LocalTier} tier T1 fits phones and small GPUs, T2 needs 2-4 GB and T3 at least 4 GB of VRAM.
 * @property {string} f16 WebLLM model id using shader-f16 kernels.
 * @property {string} f32 Fallback id for adapters without the shader-f16 feature.
 * @property {number} approxDownloadMB
 * @property {{ f16: number, f32: number }} vramMB vram_required_MB of the pinned WebLLM builds, rounded.
 * @property {number} contextWindow Tokens requested on desktops; phones get at most 2,048.
 * @property {number} maxOutputTokens
 *
 * @typedef {object} ModelChoice
 * @property {'webgpu' | 'wasm'} runtime
 * @property {PresetRef} ref
 * @property {string} key
 * @property {string} modelId WebLLM model id, or the Hugging Face repository of a WASM model.
 * @property {string} label
 * @property {boolean} f16
 * @property {LocalTier} tier
 * @property {number} approxDownloadMB
 * @property {number | null} vramMB null for WASM models, which use system memory.
 * @property {{ context_window_size: number, prefill_chunk_size: number }} chatOptions
 * @property {number} maxOutputTokens
 * @property {'manual' | 'auto'} reason
 * @property {WasmSource} [wasm] The pinned source of a WASM model.
 */

/**
 * WebGPU presets. Every pinned WebLLM build is compiled for a 4,096-token context; T1 presets
 * request half of it to fit small GPUs.
 * @type {Readonly<Record<ModelKey, ModelSpec>>}
 */
export const MODEL_CATALOG = Object.freeze({
  // T1: phones and small GPUs
  'smollm2-360m': {
    label: 'SmolLM2 360M',
    tier: 't1',
    f16: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    f32: 'SmolLM2-360M-Instruct-q4f32_1-MLC',
    approxDownloadMB: 300,
    vramMB: { f16: 376, f32: 580 },
    contextWindow: 2_048,
    maxOutputTokens: 512,
  },
  'qwen-0.5b': {
    label: 'Qwen 2.5 0.5B',
    tier: 't1',
    f16: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 300,
    vramMB: { f16: 945, f32: 1_060 },
    contextWindow: 2_048,
    maxOutputTokens: 512,
  },
  'llama-1b': {
    label: 'Llama 3.2 1B',
    tier: 't1',
    f16: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 700,
    vramMB: { f16: 879, f32: 1_129 },
    contextWindow: 2_048,
    maxOutputTokens: 512,
  },
  'qwen-1.5b': {
    label: 'Qwen 2.5 1.5B',
    tier: 't1',
    f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 1_000,
    vramMB: { f16: 1_630, f32: 1_889 },
    contextWindow: 2_048,
    maxOutputTokens: 512,
  },
  'smollm2-1.7b': {
    label: 'SmolLM2 1.7B',
    tier: 't1',
    f16: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
    f32: 'SmolLM2-1.7B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 1_000,
    vramMB: { f16: 1_774, f32: 2_692 },
    contextWindow: 2_048,
    maxOutputTokens: 512,
  },
  // T2: laptops and desktops
  'gemma-2b': {
    label: 'Gemma 2 2B',
    tier: 't2',
    f16: 'gemma-2-2b-it-q4f16_1-MLC',
    f32: 'gemma-2-2b-it-q4f32_1-MLC',
    approxDownloadMB: 1_500,
    vramMB: { f16: 1_895, f32: 2_509 },
    contextWindow: 4_096,
    maxOutputTokens: 512,
  },
  'llama-3b': {
    label: 'Llama 3.2 3B',
    tier: 't2',
    f16: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    f32: 'Llama-3.2-3B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 1_900,
    vramMB: { f16: 2_264, f32: 2_952 },
    contextWindow: 4_096,
    maxOutputTokens: 512,
  },
  'phi-3.5-mini': {
    label: 'Phi 3.5 mini',
    tier: 't2',
    f16: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
    f32: 'Phi-3.5-mini-instruct-q4f32_1-MLC',
    approxDownloadMB: 2_200,
    vramMB: { f16: 3_672, f32: 5_483 },
    contextWindow: 4_096,
    maxOutputTokens: 512,
  },
  'qwen-3b': {
    label: 'Qwen 2.5 3B',
    tier: 't2',
    f16: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-3B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 1_900,
    vramMB: { f16: 2_505, f32: 2_894 },
    contextWindow: 4_096,
    maxOutputTokens: 512,
  },
  // T3: strong GPUs only, never picked automatically
  'mistral-7b': {
    label: 'Mistral 7B v0.3',
    tier: 't3',
    f16: 'Mistral-7B-Instruct-v0.3-q4f16_1-MLC',
    f32: 'Mistral-7B-Instruct-v0.3-q4f32_1-MLC',
    approxDownloadMB: 4_100,
    vramMB: { f16: 4_573, f32: 5_619 },
    contextWindow: 4_096,
    maxOutputTokens: 512,
  },
  'qwen-7b': {
    label: 'Qwen 2.5 7B',
    tier: 't3',
    f16: 'Qwen2.5-7B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-7B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 4_300,
    vramMB: { f16: 5_107, f32: 5_900 },
    contextWindow: 4_096,
    maxOutputTokens: 512,
  },
  'llama-8b': {
    label: 'Llama 3.1 8B',
    tier: 't3',
    f16: 'Llama-3.1-8B-Instruct-q4f16_1-MLC',
    f32: 'Llama-3.1-8B-Instruct-q4f32_1-MLC',
    approxDownloadMB: 4_600,
    vramMB: { f16: 5_001, f32: 6_101 },
    contextWindow: 4_096,
    maxOutputTokens: 512,
  },
  'gemma-9b': {
    label: 'Gemma 2 9B',
    tier: 't3',
    f16: 'gemma-2-9b-it-q4f16_1-MLC',
    f32: 'gemma-2-9b-it-q4f32_1-MLC',
    approxDownloadMB: 5_300,
    vramMB: { f16: 6_422, f32: 8_383 },
    contextWindow: 4_096,
    maxOutputTokens: 512,
  },
});

/** Every WebLLM model id this app may request (validated against WebLLM's prebuilt list in CI). */
export const ALL_MODEL_IDS = Object.freeze(Object.values(MODEL_CATALOG).flatMap((m) => [m.f16, m.f32]));

/** Phones get a smaller context: less memory for the KV cache and a faster first token. */
const MOBILE_CONTEXT = 2_048;

/**
 * Normalizes a persisted preference. A bare 2.0 key ('qwen-3b') migrates to its WebGPU ref; unknown
 * values (e.g. models removed in later versions) become 'auto'.
 * @param {unknown} value
 * @returns {LocalModelRef}
 */
export function normalizePreference(value) {
  if (typeof value !== 'string') return 'auto';
  if (Object.hasOwn(MODEL_CATALOG, value)) return /** @type {PresetRef} */ (`webgpu:${value}`);
  const ref = /^(webgpu|wasm):(.+)$/.exec(value);
  if (!ref) return 'auto';
  const catalog = ref[1] === 'webgpu' ? MODEL_CATALOG : WASM_CATALOG;
  return Object.hasOwn(catalog, ref[2]) ? /** @type {PresetRef} */ (value) : 'auto';
}

/**
 * @param {WasmSource} src
 * @param {PresetRef} ref
 * @param {'manual' | 'auto'} reason
 * @returns {ModelChoice}
 */
function wasmChoice(src, ref, reason) {
  return {
    runtime: 'wasm',
    ref,
    key: src.key,
    modelId: src.repo,
    label: src.label,
    f16: false,
    tier: 't1',
    approxDownloadMB: src.approxDownloadMB,
    vramMB: null,
    chatOptions: { context_window_size: src.contextWindow, prefill_chunk_size: 256 },
    maxOutputTokens: src.maxOutputTokens,
    reason,
    wasm: src,
  };
}

/**
 * Picks a model for the device. Manual preferences win, a WebGPU preset on a device without WebGPU
 * too (the engine reports it as unsupported); 'auto' follows recommendModels().
 * @param {HardwareProfile} hw
 * @param {unknown} preference
 * @returns {ModelChoice}
 */
export function chooseModel(hw, preference) {
  const pref = normalizePreference(preference);
  const ref = pref === 'auto' ? recommendModels(hw).local : pref;
  const reason = pref === 'auto' ? 'auto' : 'manual';
  if (ref.startsWith('wasm:')) return wasmChoice(WASM_CATALOG[/** @type {WasmModelKey} */ (ref.slice('wasm:'.length))], ref, reason);

  const key = /** @type {ModelKey} */ (ref.slice('webgpu:'.length));
  const spec = MODEL_CATALOG[key];
  const f16 = hw.hasF16 && hw.webgpu !== false;
  const context = hw.isMobile ? Math.min(spec.contextWindow, MOBILE_CONTEXT) : spec.contextWindow;
  return {
    runtime: 'webgpu',
    ref,
    key,
    modelId: f16 ? spec.f16 : spec.f32,
    label: spec.label,
    f16,
    tier: spec.tier,
    approxDownloadMB: spec.approxDownloadMB,
    vramMB: f16 ? spec.vramMB.f16 : spec.vramMB.f32,
    chatOptions: {
      context_window_size: context,
      prefill_chunk_size: hw.isMobile ? 128 : context >= 4_096 ? 512 : 256,
    },
    maxOutputTokens: spec.maxOutputTokens,
    reason,
  };
}

/** Conservative characters-per-token estimate (German text tokenizes denser than English). */
const CHARS_PER_TOKEN = 3;

/**
 * Trims system context, history and user prompt so the request fits the model's context window.
 * Priority: the user's question, then retrieved context, then the most recent history.
 * `turnChars` caps each history turn (default 600; the free chat keeps longer turns).
 * @param {{ contextWindow: number, maxOutputTokens: number, system: string, context: string, history: Array<{ role: 'user' | 'assistant', content: string }>, user: string, turnChars?: number }} input
 */
export function budgetPrompt(input) {
  const turnChars = input.turnChars ?? 600;
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
    const content = msg.content.length > turnChars ? `${msg.content.slice(0, turnChars - 1)}…` : msg.content;
    if (content.length > remaining) break;
    remaining -= content.length;
    history.unshift({ role: msg.role, content });
  }
  return { system, context, user, history };
}
