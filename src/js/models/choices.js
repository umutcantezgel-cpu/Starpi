// @ts-check
// Assistant choices for the model pickers: the option values, what each value selects, and the
// option groups for a device and the providers that are set up. Pure: the caller passes the device
// profile, the benchmark history, the site's pools, the user's keys and the model lists; model
// names come from the catalogs, every other label is returned as an i18n key.
//
// Values (config.js AssistantValue, plus the on-device presets):
//   'auto'                  the best model that is set up (state.js resolves it per question)
//   'webgpu:<key>'          an on-device preset (stored as 'device' with the preset as preference)
//   'wasm:<key>'
//   '<provider>:<model>'    one model of one provider: with the user's key, or through the site's
//                           pool when the user has none ('nvidia:<id>', 'groq:<id>', ...)
//   'local:*'               the first model the user's own server lists; 'local:<id>' one of them
//   'companion:starpi-core' the paired companion (Starpi Core), offered once this browser is paired
// Before the device probe the pickers hold the static options of index.html ('auto', 'device',
// 'local:*'); 2.x values ('council', 'client', 'local', 'nvidia') are still read once.
import { POOLS } from '../ai/catalog/pools.js';
import { COMPANION_MODEL, getProvider, MINIMAX_M3 } from '../ai/catalog/providers.js';
import { MODEL_CATALOG, normalizePreference } from '../webgpu/models.js';
import { recommendModels } from './device.js';
import { NVIDIA_MODELS } from './nvidia-catalog.js';
import { WASM_CATALOG } from './wasm-catalog.js';

/**
 * @typedef {import('../ai/contract.js').ProviderId} ProviderId
 * @typedef {import('../ai/catalog/pools.js').PoolId} PoolId
 * @typedef {import('../webgpu/models.js').LocalModelRef} LocalModelRef
 * @typedef {import('../webgpu/models.js').LocalTier} LocalTier
 * @typedef {import('./device.js').HardwareProfile} HardwareProfile
 * @typedef {import('./device.js').MeasuredRun} MeasuredRun
 *
 * @typedef {'recommended' | 'device' | 'companion' | 'pools' | 'anthropic' | 'openai' | 'gemini' | 'xai' | 'groq' | 'mistral' | 'deepseek' | 'minimax' | 'openrouter' | 'nvidia' | 'server'} GroupId
 *
 * @typedef {'needs-webgpu' | 'heavy' | 'no-vision' | 'not-configured' | 'workstation'} PickerWarning
 *
 * @typedef {object} PickerItem
 * @property {string} value
 * @property {'webgpu' | 'wasm' | 'pool' | 'key' | 'server' | 'companion' | 'mode'} runtime
 * @property {string} [label] Model name (catalog data, never translated).
 * @property {string} [labelKey] i18n key of an item without a model name.
 * @property {ProviderId} [provider]
 * @property {LocalTier} [tier]
 * @property {number} [sizeMB] Approximate download.
 * @property {'auto' | 'pro' | 'measured'} [recommended] What 'auto' picks on this device, the
 *   larger suggestion for strong GPUs, or a larger model the benchmark history measured fast.
 * @property {PickerWarning} [warning]
 * @property {boolean} [free] a model the site's pool serves without a key of the user's
 * @property {boolean} [unverified] only known from a live list
 * @property {boolean} [disabled]
 *
 * @typedef {{ id: GroupId, items: PickerItem[] }} PickerGroup
 *
 * @typedef {object} ModelOption A model of a provider as the merged catalog names it.
 * @property {string} id
 * @property {string} label
 * @property {boolean} [unverified]
 *
 * @typedef {object} PoolState What the site's pool list (GET /api/models/pool) said about one pool.
 * @property {boolean} configured
 * @property {readonly string[]} models
 * @property {string | null} defaultModel
 *
 * @typedef {object} PickerState
 * @property {HardwareProfile | null} hw null before the device probe
 * @property {readonly MeasuredRun[]} [history] the benchmark history of this browser
 * @property {Partial<Record<PoolId, PoolState>> | null} pools null while the site has not answered
 * @property {readonly ProviderId[]} keyed providers with a key of the user's
 * @property {Partial<Record<ProviderId, readonly ModelOption[]>>} models model lists of the keyed providers
 * @property {boolean} server the user set up their own server
 * @property {readonly string[]} serverModels models the own server listed (empty while unknown)
 * @property {boolean} [companion] a companion is paired with this browser
 * @property {string} [current] the value to keep visible even when nothing else offers it
 *
 * @typedef {{ text: string } | { key: string, gb?: number }} OptionPart A model name (data, shown
 *   as is) or an i18n key; `gb` is the download size for the key's {gb} placeholder.
 *
 * @typedef {object} PickedChoice What a picker value selects.
 * @property {import('../config.js').AssistantValue} assistant
 * @property {LocalModelRef} [preference] the on-device preset of a 'webgpu:'/'wasm:' value
 */

/** Provider groups, in picker order. */
export const PROVIDER_GROUPS = /** @type {readonly ProviderId[]} */ (Object.freeze(['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'minimax', 'openrouter', 'nvidia']));

/** i18n keys of the option group labels (provider groups are named by the catalog's label). */
export const GROUP_KEYS = Object.freeze({
  recommended: 'chat-thread.picker.group_recommended',
  device: 'chat-thread.picker.group_device',
  pools: 'chat-thread.picker.group_pools',
  server: 'chat-thread.picker.group_server',
});

/** i18n keys naming where a model runs. */
const RUNTIME_KEYS = Object.freeze({
  webgpu: 'models.runtime_webgpu',
  wasm: 'models.runtime_wasm',
  pool: 'chat-thread.picker.runtime_pool',
});

/** @type {Readonly<Record<PickerWarning, string>>} */
const WARNING_KEYS = Object.freeze({
  'needs-webgpu': 'models.warn_needs_webgpu',
  heavy: 'models.warn_heavy',
  'no-vision': 'chat-thread.picker.warn_no_vision',
  'not-configured': 'models.warn_not_configured',
  workstation: 'chat-thread.picker.warn_workstation',
});

/** @type {Readonly<Record<NonNullable<PickerItem['recommended']>, string>>} */
const RECOMMENDED_KEYS = Object.freeze({
  auto: 'models.recommended',
  pro: 'models.pro_pick',
  measured: 'chat-thread.picker.measured_fast',
});

/** A model id as a picker value carries it (the same rule as state.js normalizeAssistant). */
const MODEL_ID = /^(?:\*|[\w][\w.:/@+-]{0,199})$/;
/** Providers whose models a value may name; the on-device engines go through their presets. */
const VALUE_PROVIDERS = new Set([...PROVIDER_GROUPS, 'local', 'companion']);
/** The picker value of the paired companion. */
export const COMPANION_VALUE = `companion:${COMPANION_MODEL}`;
/** i18n key of the companion's option. */
const COMPANION_LABEL_KEY = 'companion.card.title';

/**
 * Reads a picker value. 2.x values map once: 'council' to auto, 'client' to the on-device model,
 * 'local' to the first model of the own server and 'nvidia' to the stored NVIDIA model. Null means
 * the pickers never offer this value: reject it and revert the picker.
 * @param {string} value
 * @param {{ nvidiaModel?: string }} [stored] the 2.x NVIDIA model
 * @returns {PickedChoice | null}
 */
export function parsePickerValue(value, stored = {}) {
  if (value === 'auto' || value === 'council') return { assistant: 'auto' };
  if (value === 'device' || value === 'client') return { assistant: 'device' };
  if (value === 'local') return { assistant: 'local:*' };
  if (value === 'nvidia') return stored.nvidiaModel ? { assistant: `nvidia:${stored.nvidiaModel}` } : null;
  if (/^(?:webgpu|wasm):/.test(value)) {
    const preference = normalizePreference(value);
    return preference !== 'auto' && preference === value ? { assistant: 'device', preference } : null;
  }
  const at = value.indexOf(':');
  if (at <= 0) return null;
  const provider = value.slice(0, at);
  const model = value.slice(at + 1);
  if (!VALUE_PROVIDERS.has(provider) || !MODEL_ID.test(model)) return null;
  if (model === '*' && provider !== 'local') return null;
  // The companion has one model: which of its own models answers is the companion's choice.
  if (provider === 'companion' && model !== COMPANION_MODEL) return null;
  // NVIDIA models are an allowlist: the site's pool serves no others.
  if (provider === 'nvidia' && !NVIDIA_MODELS.some((m) => m.id === model)) return null;
  return { assistant: /** @type {import('../config.js').AssistantValue} */ (value) };
}

/**
 * The model the device's 'auto' stands for: the hardware pick, stepped down when the benchmark
 * history measured it slow (models/device.js recommendModels).
 * @param {HardwareProfile} hw
 * @param {readonly MeasuredRun[]} [history]
 */
export function recommendedLocal(hw, history = []) {
  return recommendModels(hw, { history }).local;
}

/**
 * The picker value that shows the stored choice. 'device' shows as its preset, and as the model
 * 'auto' resolves to once the device is known; before that as 'device'.
 * @param {{ assistant: import('../config.js').AssistantValue, preference: LocalModelRef }} current
 * @param {HardwareProfile | null} hw
 * @param {readonly MeasuredRun[]} [history]
 * @returns {string}
 */
export function choiceValue(current, hw, history = []) {
  if (current.assistant !== 'device') return current.assistant;
  if (current.preference !== 'auto') return hw ? current.preference : 'device';
  return hw ? recommendedLocal(hw, history) : 'device';
}

/**
 * The text of an option, in order: model name, where it runs, download size, the recommendation and
 * a warning. Items without a model name have a single i18n key.
 * @param {PickerItem} item
 * @returns {OptionPart[]}
 */
export function optionParts(item) {
  if (item.labelKey) return [{ key: item.labelKey }];
  /** @type {OptionPart[]} */
  const parts = [{ text: item.label ?? item.value }];
  if (item.runtime === 'webgpu' || item.runtime === 'wasm' || item.runtime === 'pool') parts.push({ key: RUNTIME_KEYS[item.runtime] });
  if (item.sizeMB) parts.push({ key: 'models.download_size', gb: item.sizeMB / 1000 });
  if (item.recommended) parts.push({ key: RECOMMENDED_KEYS[item.recommended] });
  if (item.unverified) parts.push({ key: 'chat-thread.picker.unverified' });
  if (item.warning) parts.push({ key: WARNING_KEYS[item.warning] });
  return parts;
}

/**
 * Every on-device preset: WebGPU by tier, then the processor (WASM) models.
 * @param {import('./device.js').DeviceClass | null} cls null before the device probe
 * @returns {PickerItem[]}
 */
function deviceItems(cls) {
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
 * Models the site's pools serve, for the providers the user has no key for (a key of their own
 * takes the same values in its provider group).
 * @param {PickerState} state
 * @returns {PickerItem[]}
 */
function poolItems(state) {
  /** @type {PickerItem[]} */
  const items = [];
  for (const [id, info] of Object.entries(POOLS)) {
    const pool = state.pools?.[/** @type {PoolId} */ (id)];
    if (!pool?.configured || state.keyed.includes(info.provider)) continue;
    const offered = pool.models.length ? info.entries.filter((e) => pool.models.includes(e.id)) : info.entries;
    for (const e of offered) items.push({ value: `${info.provider}:${e.id}`, runtime: 'pool', provider: info.provider, label: e.label, free: true });
  }
  return items;
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
 * The value of the site's default free model, when a pool serves one, in the catalog's pool order:
 * the base model's pool (MiniMax) first, then NVIDIA and the others.
 * @param {PickerState} state
 * @returns {string | null}
 */
export function defaultPoolValue(state) {
  for (const [id, info] of Object.entries(POOLS)) {
    const pool = state.pools?.[/** @type {PoolId} */ (id)];
    if (!pool?.configured || state.keyed.includes(info.provider)) continue;
    const model = pool.defaultModel && info.models.includes(pool.defaultModel) ? pool.defaultModel : info.defaultModel;
    return `${info.provider}:${model}`;
  }
  return null;
}

/**
 * Option groups in picker order: recommended (Auto, the device's pick and suggestion, the site's
 * default free model), on this device, the paired companion, free through the site's pools, one
 * group per provider the user has a key for, and their own server. A stored value nothing offers stays visible in the
 * group it belongs to, so the picker can show it.
 * @param {PickerState} state
 * @returns {PickerGroup[]}
 */
export function assistantGroups(state) {
  const { hw } = state;
  const rec = hw ? recommendModels(hw, { history: state.history ?? [] }) : null;
  const device = deviceItems(rec?.cls ?? null);
  const pools = poolItems(state);
  /** @type {PickerItem[]} */
  const recommended = [{ value: 'auto', runtime: 'mode', labelKey: 'chat-thread.picker.auto' }];
  if (rec) {
    promote(device, recommended, rec.local, { recommended: 'auto' });
    promote(device, recommended, rec.pro, { recommended: rec.proTokPerSec !== null ? 'measured' : 'pro' });
  }
  promote(pools, recommended, defaultPoolValue(state));
  /** @type {PickerGroup[]} */
  const groups = [{ id: 'recommended', items: recommended }, { id: 'device', items: device }];
  if (pools.length) groups.push({ id: 'pools', items: pools });
  for (const provider of PROVIDER_GROUPS) {
    if (!state.keyed.includes(provider)) continue;
    const items = (state.models[provider] ?? []).map((m) => /** @type {PickerItem} */ ({ value: `${provider}:${m.id}`, runtime: 'key', provider, label: m.label || m.id, ...(m.unverified ? { unverified: true } : {}) }));
    groups.push({ id: /** @type {GroupId} */ (provider), items });
  }
  if (state.companion || state.current === COMPANION_VALUE) {
    // Offered only while paired; a stored choice of an unpaired one stays visible, disabled.
    groups.splice(2, 0, { id: 'companion', items: [{ value: COMPANION_VALUE, runtime: 'companion', provider: 'companion', labelKey: COMPANION_LABEL_KEY, ...(state.companion ? {} : { disabled: true }) }] });
  }
  if (state.server || state.current?.startsWith('local:')) {
    /** @type {PickerItem[]} */
    const items = [{ value: 'local:*', runtime: 'server', labelKey: 'chat-thread.picker.server_first' }, ...state.serverModels.map((id) => serverItem(id))];
    groups.push({ id: 'server', items });
  }
  keepCurrent(groups, state);
  return groups.filter((g) => g.items.length > 0);
}

/**
 * A model the own server lists. A self-hosted MiniMax M3 or M3.1 build is marked as a workstation
 * model: it needs about 160 GB of memory or more, which no phone, laptop browser or in-browser
 * engine has.
 * @param {string} id
 * @returns {PickerItem}
 */
export function serverItem(id) {
  return { value: `local:${id}`, runtime: 'server', label: id, ...(MINIMAX_M3.test(id) ? { warning: /** @type {const} */ ('workstation') } : {}) };
}

/**
 * Adds the stored value to its group when no group offers it (a model that left a live list, a
 * pool that is not answering yet), so the picker still shows what is selected. A pool model the
 * site's answered pool list does not offer is shown disabled, marked as not set up.
 * @param {PickerGroup[]} groups
 * @param {PickerState} state
 */
function keepCurrent(groups, state) {
  const value = state.current;
  if (!value || groups.some((g) => g.items.some((i) => i.value === value))) return;
  const picked = parsePickerValue(value);
  if (!picked) return;
  const at = value.indexOf(':');
  const provider = /** @type {ProviderId} */ (value.slice(0, at));
  const model = value.slice(at + 1);
  if (provider === 'local') {
    const server = groups.find((g) => g.id === 'server');
    if (server) server.items.push(serverItem(model));
    return;
  }
  const keyed = state.keyed.includes(provider);
  const pool = Object.values(POOLS).find((p) => p.provider === provider);
  const label = pool?.entries.find((e) => e.id === model)?.label ?? model;
  /** @type {PickerItem} */
  const item = { value, runtime: keyed ? 'key' : 'pool', provider, label, ...(keyed ? {} : { free: true }), ...(!keyed && state.pools !== null ? { disabled: true, warning: /** @type {const} */ ('not-configured') } : {}) };
  const groupId = /** @type {GroupId} */ (keyed ? provider : 'pools');
  const group = groups.find((g) => g.id === groupId);
  if (group) group.items.push(item);
  else groups.push({ id: groupId, items: [item] });
}

/**
 * The label of an option group: an i18n key, or a provider's proper name (never translated).
 * @param {GroupId} id
 * @returns {{ key: string } | { text: string }}
 */
export function groupLabel(id) {
  if (id in GROUP_KEYS) return { key: GROUP_KEYS[/** @type {keyof typeof GROUP_KEYS} */ (id)] };
  return { text: getProvider(id)?.label ?? id };
}
