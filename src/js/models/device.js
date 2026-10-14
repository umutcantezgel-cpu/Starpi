// @ts-check
// Device classes and model recommendations. Pure: webgpu/engine.js probes the adapter and the
// navigator hints, so everything here runs under Node in the unit tests (tests/unit/device.test.mjs).
//
// The browser reports no VRAM, and navigator.deviceMemory is capped at 8 GB and hidden by Safari
// and Firefox. 'auto' therefore never picks a T3 preset; a strong GPU only gets it suggested.

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
 * @property {PresetRef | null} pro a larger model suggested on strong GPUs, never picked automatically
 */

export const GIB = 1024 ** 3;

/** Adapter vendors whose GPUs (discrete, or Apple's unified memory) run the 7-9B presets usefully. */
const PRO_VENDORS = ['apple', 'nvidia', 'amd'];

/** @type {Readonly<Record<DeviceClass, string>>} */
const CLASS_KEYS = Object.freeze({
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

/**
 * @param {HardwareProfile} hw
 * @returns {Recommendation}
 */
export function recommendModels(hw) {
  const cls = classifyDevice(hw);
  return { cls, local: autoPick(cls, hw), pro: cls === 'desktop-pro' ? 'webgpu:qwen-7b' : null };
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
