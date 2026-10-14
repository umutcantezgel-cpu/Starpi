// @ts-check
// Assistant choices for the model pickers: the option values, what each value selects, and the
// option groups for a device. Pure: the caller passes the device profile and the NVIDIA status,
// model names come from the catalogs, and other labels are returned as i18n keys.
//
// Values: 'council', 'local', 'webgpu:<key>', 'wasm:<key>' and 'nvidia:<id>'. Before the device
// probe the pickers only hold the static modes 'council', 'client', 'nvidia' and 'local'.
import { MODEL_CATALOG, normalizePreference } from '../webgpu/models.js';
import { recommendModels } from './device.js';
import { NVIDIA_MODELS } from './nvidia-catalog.js';
import { WASM_CATALOG } from './wasm-catalog.js';

/**
 * @typedef {import('../config.js').ComputeMode} ComputeMode
 * @typedef {import('../webgpu/models.js').LocalModelRef} LocalModelRef
 * @typedef {import('../webgpu/models.js').LocalTier} LocalTier
 * @typedef {import('./device.js').HardwareProfile} HardwareProfile
 * @typedef {import('./nvidia-catalog.js').NvidiaModel} NvidiaModel
 *
 * @typedef {object} AssistantChoice What a picker value selects; parts it leaves out keep their stored value.
 * @property {ComputeMode} mode
 * @property {LocalModelRef} [local]
 * @property {string} [nvidia]
 *
 * @typedef {object} AssistantState The stored settings a picker shows.
 * @property {ComputeMode} mode
 * @property {LocalModelRef} local
 * @property {string} nvidia
 *
 * @typedef {object} NvidiaStatus
 * @property {'pending' | 'absent' | 'unconfigured' | 'configured'} state pending: not asked yet;
 *   absent: this server has no NVIDIA route; unconfigured: the route has no keys; configured: ready.
 * @property {readonly string[]} ids Model ids the server offers.
 * @property {string} defaultModel
 * @property {ComputeMode} currentMode
 * @property {string} currentId The stored NVIDIA model.
 *
 * @typedef {'needs-webgpu' | 'heavy' | 'not-configured'} PickerWarning
 *
 * @typedef {object} PickerItem
 * @property {string} value
 * @property {'webgpu' | 'wasm' | 'nvidia' | 'mode'} runtime
 * @property {string} [label] Model name (catalog data, never translated).
 * @property {string} [labelKey] i18n key of an item without a model name.
 * @property {LocalTier} [tier]
 * @property {number} [sizeMB] Approximate download.
 * @property {'auto' | 'pro'} [recommended] What 'auto' picks, or the larger suggestion for strong GPUs.
 * @property {PickerWarning} [warning]
 * @property {boolean} [disabled]
 *
 * @typedef {{ id: 'recommended' | 'local' | 'nvidia' | 'other', items: PickerItem[] }} PickerGroup
 */

/**
 * Reads a picker value. Bare 'client' and 'nvidia' (static options before the probe) keep the
 * stored model. Null means the pickers never offer this value: reject it and revert the picker.
 * @param {string} value
 * @param {readonly string[]} nvidiaIds allowlisted NVIDIA model ids
 * @returns {AssistantChoice | null}
 */
export function parseAssistantChoice(value, nvidiaIds) {
  if (value === 'council' || value === 'client' || value === 'local' || value === 'nvidia') return { mode: value };
  if (value.startsWith('nvidia:')) {
    const id = value.slice('nvidia:'.length);
    return nvidiaIds.includes(id) ? { mode: 'nvidia', nvidia: id } : null;
  }
  const local = normalizePreference(value);
  return local !== 'auto' && local === value ? { mode: 'client', local } : null;
}

/**
 * The picker value that shows the stored settings. Without a device profile only the bare modes
 * exist; with one, 'auto' shows as the model it resolves to.
 * @param {AssistantState} current
 * @param {HardwareProfile | null} hw
 * @returns {string}
 */
export function choiceValue(current, hw) {
  if (!hw) return current.mode;
  if (current.mode === 'client') return current.local === 'auto' ? recommendModels(hw).local : current.local;
  if (current.mode === 'nvidia') return `nvidia:${current.nvidia}`;
  return current.mode;
}

/**
 * Every on-device preset: WebGPU by tier, then the processor (WASM) models.
 * @param {import('./device.js').DeviceClass | null} cls null before the device probe
 * @returns {PickerItem[]}
 */
function localItems(cls) {
  /** @type {PickerItem[]} */
  const items = Object.entries(MODEL_CATALOG).map(([key, spec]) => {
    /** @type {PickerWarning | undefined} */
    const warning = cls === 'cpu-only' ? 'needs-webgpu' : spec.tier === 't3' && cls !== 'desktop-pro' ? 'heavy' : undefined;
    return { value: `webgpu:${key}`, runtime: 'webgpu', label: spec.label, tier: spec.tier, sizeMB: spec.approxDownloadMB, ...(warning ? { warning } : {}) };
  });
  for (const [key, src] of Object.entries(WASM_CATALOG)) {
    items.push({ value: `wasm:${key}`, runtime: 'wasm', label: src.label, tier: 't1', sizeMB: src.approxDownloadMB });
  }
  return items;
}

/**
 * @param {NvidiaModel} model
 * @param {boolean} available
 * @returns {PickerItem}
 */
function nvidiaItem(model, available) {
  return { value: `nvidia:${model.id}`, runtime: 'nvidia', label: model.label, ...(available ? {} : { warning: 'not-configured', disabled: true }) };
}

/**
 * NVIDIA models in catalog order, filtered by what the server offers. Until the server answers, or
 * when it has no NVIDIA route, only a model that is already selected stays visible.
 * @param {NvidiaStatus} nvidia
 * @returns {PickerItem[]}
 */
function nvidiaItems(nvidia) {
  const selected = nvidia.currentMode === 'nvidia' ? nvidia.currentId : null;
  if (nvidia.state === 'pending' || nvidia.state === 'absent') {
    const model = NVIDIA_MODELS.find((m) => m.id === selected);
    return model ? [nvidiaItem(model, nvidia.state === 'pending')] : [];
  }
  return NVIDIA_MODELS.filter((m) => nvidia.ids.includes(m.id) || m.id === selected).map((m) => nvidiaItem(m, nvidia.state === 'configured'));
}

/**
 * Moves the item with this value from `from` into `to`, so every value appears once.
 * @param {PickerItem[]} from
 * @param {PickerItem[]} to
 * @param {string | null} value
 * @param {Partial<PickerItem>} [extra]
 */
function promote(from, to, value, extra) {
  const i = from.findIndex((item) => item.value === value);
  if (i >= 0) to.push({ ...from.splice(i, 1)[0], ...extra });
}

/**
 * Option groups in picker order: recommended (only once the device is known), on-device, NVIDIA
 * cloud (when there is anything to show) and the other assistants.
 * @param {HardwareProfile | null} hw
 * @param {NvidiaStatus} nvidia
 * @returns {PickerGroup[]}
 */
export function assistantGroups(hw, nvidia) {
  const rec = hw ? recommendModels(hw) : null;
  const local = localItems(rec?.cls ?? null);
  const cloud = nvidiaItems(nvidia);
  /** @type {PickerGroup[]} */
  const groups = [];
  if (rec) {
    /** @type {PickerItem[]} */
    const recommended = [];
    promote(local, recommended, rec.local, { recommended: 'auto' });
    promote(local, recommended, rec.pro, { recommended: 'pro' });
    if (nvidia.state === 'configured') promote(cloud, recommended, `nvidia:${nvidia.defaultModel}`);
    groups.push({ id: 'recommended', items: recommended });
  }
  groups.push({ id: 'local', items: local });
  if (cloud.length) groups.push({ id: 'nvidia', items: cloud });
  groups.push({
    id: 'other',
    items: [
      { value: 'council', runtime: 'mode', labelKey: 'engine.mode_cloud' },
      { value: 'local', runtime: 'mode', labelKey: 'engine.mode_server' },
    ],
  });
  return groups;
}
