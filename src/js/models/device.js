// @ts-check
// Device classes, model recommendations and output budgets. Pure: webgpu/engine.js probes the
// adapter and the navigator hints, and the benchmark history (models/bench-history.js) is passed in,
// so everything here runs under Node in the unit tests (tests/unit/device*.test.mjs).
//
// The browser reports no VRAM, and navigator.deviceMemory is capped at 8 GB and hidden by Safari
// and Firefox. 'auto' therefore never picks a T3 preset; a strong GPU only gets it suggested.
// Measured runs refine that guess: a pick that decodes too slowly here steps down, and a larger
// model that ran fast here is suggested (never picked).

/**
 * @typedef {object} HardwareProfile
 * @property {boolean} isMobile
 * @property {number | null} deviceMemoryGB navigator.deviceMemory (null when the browser hides it)
 * @property {number} maxBufferSize adapter.limits.maxBufferSize in bytes (0 without WebGPU)
 * @property {boolean} hasF16 adapter.features.has('shader-f16')
 * @property {boolean} [webgpu] false when the browser offers no WebGPU adapter (default true)
 * @property {number} [maxStorageBufferBindingSize] adapter.limits.maxStorageBufferBindingSize in bytes
 * @property {string} [vendor] adapter.info.vendor, e.g. 'apple', 'nvidia', 'intel'
 * @property {string} [architecture] adapter.info.architecture
 *
 * @typedef {'cpu-only' | 'mobile' | 'low' | 'laptop' | 'desktop' | 'desktop-pro'} DeviceClass
 * @typedef {{ key: string, params?: Record<string, string> }} HardwareBadge i18n key and its values
 * @typedef {import('../webgpu/models.js').PresetRef} PresetRef
 *
 * @typedef {object} Recommendation
 * @property {DeviceClass} cls
 * @property {PresetRef} local what 'auto' resolves to
 * @property {PresetRef | null} pro a larger model suggested on strong GPUs or measured fast here,
 *   never picked automatically
 * @property {{ from: PresetRef, tokPerSec: number } | null} stepDown set when measured runs moved
 *   `local` below the pick of the device class: the pick it replaced and that pick's median rate
 * @property {number | null} proTokPerSec the median rate behind a `pro` that the history suggests
 *
 * One measured run, as the benchmark history stores it (models/bench-history.js). Only the fields
 * the recommendation reads; failures > 0 marks a run that ended in an engine failure.
 * @typedef {object} MeasuredRun
 * @property {string} [ref] the preset that ran ('webgpu:<key>' or 'wasm:<key>')
 * @property {string} deviceClass
 * @property {number} tokPerSec decode tokens per second
 * @property {number} failures
 */

export const GIB = 1024 ** 3;

/** Adapter vendors whose GPUs (discrete, or Apple's unified memory) run the 7-9B presets usefully. */
const PRO_VENDORS = ['apple', 'nvidia', 'amd'];

/** i18n keys naming each device class. @type {Readonly<Record<DeviceClass, string>>} */
export const CLASS_KEYS = Object.freeze({
  'cpu-only': 'models.class_cpu_only',
  mobile: 'models.class_mobile',
  low: 'models.class_low',
  laptop: 'models.class_laptop',
  desktop: 'models.class_desktop',
  'desktop-pro': 'models.class_desktop_pro',
});

/** @param {HardwareProfile} hw */
function isProGpu(hw) {
  return hw.hasF16 && (hw.maxStorageBufferBindingSize ?? 0) >= GIB && PRO_VENDORS.includes((hw.vendor ?? '').toLowerCase());
}

/**
 * @param {HardwareProfile} hw
 * @returns {DeviceClass}
 */
export function classifyDevice(hw) {
  if (hw.webgpu === false) return 'cpu-only';
  if (hw.isMobile) return 'mobile';
  if (hw.maxBufferSize < GIB || (hw.deviceMemoryGB !== null && hw.deviceMemoryGB < 8)) return 'low';
  // Checked before the memory hint: Safari hides deviceMemory on Apple silicon too.
  if (isProGpu(hw)) return 'desktop-pro';
  return hw.deviceMemoryGB === null ? 'laptop' : 'desktop';
}

/**
 * The preset 'auto' resolves to. On WebGPU devices these are the picks of earlier versions, so a
 * model that is already cached keeps being used; without WebGPU a processor (WASM) model is picked.
 * @param {DeviceClass} cls
 * @param {HardwareProfile} hw
 * @returns {PresetRef}
 */
function autoPick(cls, hw) {
  const memory = hw.deviceMemoryGB;
  if (cls === 'cpu-only') {
    if (memory !== null && memory < 2) return 'wasm:smollm2-135m';
    return hw.isMobile || (memory !== null && memory < 4) ? 'wasm:smollm2-360m' : 'wasm:qwen-0.5b';
  }
  if (cls === 'mobile' || cls === 'low') return 'webgpu:llama-1b';
  // Unknown memory stays with the mid-size model, also on a pro GPU.
  return memory === null ? 'webgpu:qwen-1.5b' : 'webgpu:qwen-3b';
}

/** Below this median decode rate (tokens per second) answers feel sluggish: 'auto' steps down. */
export const SLOW_TOK_PER_SEC = 8;
/** Above this median decode rate a larger model has room: it is suggested, never picked. */
export const FAST_TOK_PER_SEC = 20;

/**
 * Where 'auto' goes when its pick measured slow, largest first: one rung is the pick of the next
 * smaller device class, below that the smallest presets of the same runtime.
 * @type {Readonly<Record<'webgpu' | 'wasm', readonly PresetRef[]>>}
 */
const LADDER = Object.freeze({
  webgpu: ['webgpu:qwen-3b', 'webgpu:qwen-1.5b', 'webgpu:llama-1b', 'webgpu:qwen-0.5b', 'webgpu:smollm2-360m'],
  wasm: ['wasm:qwen-0.5b', 'wasm:smollm2-360m', 'wasm:smollm2-135m'],
});

/** Parameters (billions) per preset key, to tell which of two models is the larger one. */
const PARAMS_B = Object.freeze({
  'smollm2-135m': 0.135,
  'smollm2-360m': 0.36,
  'qwen-0.5b': 0.5,
  'llama-1b': 1.2,
  'qwen-1.5b': 1.5,
  'smollm2-1.7b': 1.7,
  'gemma-2b': 2.6,
  'qwen-3b': 3.1,
  'llama-3b': 3.2,
  'phi-3.5-mini': 3.8,
  'mistral-7b': 7.2,
  'qwen-7b': 7.6,
  'llama-8b': 8,
  'gemma-9b': 9.2,
});

/**
 * Model size in billions of parameters (0 for an unknown ref).
 * @param {string} ref
 */
export function presetSize(ref) {
  const key = ref.slice(ref.indexOf(':') + 1);
  return Object.hasOwn(PARAMS_B, key) ? PARAMS_B[/** @type {keyof typeof PARAMS_B} */ (key)] : 0;
}

/** @param {readonly number[]} values */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median decode rate of some runs. A failed run counts as 0 tok/s, so a model that mostly fails
 * reads as slow. Null without runs.
 * @param {readonly Pick<MeasuredRun, 'tokPerSec' | 'failures'>[]} runs
 * @returns {number | null}
 */
export function medianRate(runs) {
  if (runs.length === 0) return null;
  return median(runs.map((r) => (r.failures > 0 || !Number.isFinite(r.tokPerSec) ? 0 : Math.max(0, r.tokPerSec))));
}

/**
 * Median decode rate per preset, over the runs of one device class.
 * @param {readonly MeasuredRun[]} history
 * @param {string} cls
 * @returns {Map<string, { tokPerSec: number, runs: number }>}
 */
export function measuredRates(history, cls) {
  /** @type {Map<string, MeasuredRun[]>} */
  const byRef = new Map();
  for (const run of history) {
    if (run.deviceClass !== cls || typeof run.ref !== 'string' || !presetSize(run.ref)) continue;
    const list = byRef.get(run.ref) ?? [];
    list.push(run);
    byRef.set(run.ref, list);
  }
  return new Map([...byRef].map(([ref, runs]) => [ref, { tokPerSec: medianRate(runs) ?? 0, runs: runs.length }]));
}

/**
 * The models for this device: what 'auto' resolves to and a larger suggestion. With a benchmark
 * history, a pick whose median rate on this device class is below SLOW_TOK_PER_SEC steps down one
 * rung (again while the next rung measured slow too), and the largest preset that measured above
 * FAST_TOK_PER_SEC and is larger than the pick becomes the suggestion.
 * @param {HardwareProfile} hw
 * @param {{ history?: readonly MeasuredRun[] }} [options]
 * @returns {Recommendation}
 */
export function recommendModels(hw, options = {}) {
  const cls = classifyDevice(hw);
  const pick = autoPick(cls, hw);
  /** @type {PresetRef | null} */
  const guess = cls === 'desktop-pro' ? 'webgpu:qwen-7b' : null;
  const history = options.history ?? [];
  if (history.length === 0) return { cls, local: pick, pro: guess, stepDown: null, proTokPerSec: null };

  const rates = measuredRates(history, cls);
  const slow = (/** @type {string} */ ref) => (rates.get(ref)?.tokPerSec ?? Infinity) < SLOW_TOK_PER_SEC;
  const ladder = LADDER[pick.startsWith('wasm:') ? 'wasm' : 'webgpu'];
  let local = pick;
  for (let i = ladder.indexOf(pick); i >= 0 && i < ladder.length - 1 && slow(local); i += 1) local = ladder[i + 1];
  const stepDown = local === pick ? null : { from: pick, tokPerSec: rates.get(pick)?.tokPerSec ?? 0 };

  /** @type {PresetRef | null} */
  let fast = null;
  for (const [ref, r] of rates) {
    if (r.tokPerSec > FAST_TOK_PER_SEC && presetSize(ref) > presetSize(local) && (!fast || presetSize(ref) > presetSize(fast))) fast = /** @type {PresetRef} */ (ref);
  }
  if (fast) return { cls, local, pro: fast, stepDown, proTokPerSec: rates.get(fast)?.tokPerSec ?? null };
  // The hardware guess stays only while it is unmeasured (and still larger than the pick): once
  // measured, it is suggested like any other model, that is only above FAST_TOK_PER_SEC.
  const pro = guess && !rates.has(guess) && presetSize(guess) > presetSize(local) ? guess : null;
  return { cls, local, pro, stepDown, proTokPerSec: null };
}

/**
 * Output tokens one on-device answer may use, by device class: phones 512, small GPUs 768, laptops
 * 1,024, desktops and strong GPUs 2,048. Devices without WebGPU run processor models, which keep
 * WASM_OUTPUT_TOKENS unless a benchmark measured them faster (outputBudget).
 * @type {Readonly<Record<DeviceClass, number>>}
 */
export const OUTPUT_BUDGETS = Object.freeze({
  'cpu-only': 512,
  mobile: 512,
  low: 768,
  laptop: 1_024,
  desktop: 2_048,
  'desktop-pro': 2_048,
});

/** Processor (WASM) models decode a few tokens per second; their answers stay short by default. */
export const WASM_OUTPUT_TOKENS = 384;

/** Decoding time a measured processor model may spend on one answer. */
const WASM_ANSWER_SECONDS = 60;

/**
 * The output budget of an on-device model: the table entry of the device class for WebGPU, and
 * WASM_OUTPUT_TOKENS for a processor model, unless its measured median rate fills more within a
 * minute (in steps of 64 tokens, never above the class's table entry).
 * @param {DeviceClass} cls
 * @param {'webgpu' | 'wasm'} runtime
 * @param {number | null} [measuredTokPerSec] median decode rate of the processor model on this device
 * @returns {number}
 */
export function outputBudget(cls, runtime, measuredTokPerSec = null) {
  const table = OUTPUT_BUDGETS[cls] ?? OUTPUT_BUDGETS.mobile;
  if (runtime !== 'wasm') return table;
  if (typeof measuredTokPerSec !== 'number' || !(measuredTokPerSec > 0)) return WASM_OUTPUT_TOKENS;
  const fits = Math.floor((measuredTokPerSec * WASM_ANSWER_SECONDS) / 64) * 64;
  return Math.max(WASM_OUTPUT_TOKENS, Math.min(table, fits));
}

/**
 * What the settings show about this device: GPU support, memory and device class.
 * @param {HardwareProfile} hw
 * @returns {HardwareBadge[]}
 */
export function hardwareBadges(hw) {
  const gpu = hw.webgpu === false ? 'models.badge_cpu_only' : hw.hasF16 ? 'models.badge_webgpu_f16' : 'models.badge_webgpu';
  /** @type {HardwareBadge} */
  const memory =
    hw.deviceMemoryGB === null ? { key: 'models.badge_memory_hidden' } : { key: 'models.badge_memory', params: { gb: String(hw.deviceMemoryGB) } };
  return [{ key: gpu }, memory, { key: CLASS_KEYS[classifyDevice(hw)] }];
}

/**
 * @param {{ userAgent: string, userAgentDataMobile?: boolean | undefined }} nav
 */
export function detectMobile(nav) {
  if (typeof nav.userAgentDataMobile === 'boolean') return nav.userAgentDataMobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
}
