// @ts-check
// The assistant pickers: the header's #engineSelector and the settings' #cfgComputeMode. Once the
// device is probed they are rebuilt as option groups: recommended for this device (Auto, the
// model this device runs best, the site's default free model), on this device, free through the
// site's pools, one group per provider the user has a key for, and their own server
// (models/choices.js). Until then the static options in index.html stay. The settings also show
// the hardware badges and the state of the site's pools. Model names come from the catalogs;
// everything else is translated.
//
// 'auto' for the on-device model shows as the model it resolves to: the hardware pick, stepped down
// when the benchmark history measured it slow on this device (read once, with a short timeout).
//
// Must not import settings.js or chat.js: settings.js imports this module.
import { TIMEOUTS_MS } from './config.js';
import { byId, reportUnexpected, setHidden } from './dom.js';
import { formatNumber, onLocaleChange, setText, t } from './i18n/index.js';
import { assistantGroups, choiceValue, groupLabel, optionParts } from './models/choices.js';
import { hardwareBadges } from './models/device.js';
import { onProvidersChange, providerState, refreshModelLists } from './providers.js';
import { getAssistant, getModelPreference, onAssistantChange } from './state.js';
import { getDeviceProbe } from './webgpu/engine.js';
import { POOL_IDS, POOLS } from './ai/catalog/pools.js';
import { getProvider } from './ai/catalog/providers.js';

/**
 * @typedef {import('./models/choices.js').PickerItem} PickerItem
 * @typedef {import('./models/choices.js').PickerGroup} PickerGroup
 * @typedef {import('./models/device.js').HardwareProfile} HardwareProfile
 * @typedef {import('./models/device.js').MeasuredRun} MeasuredRun
 */

/** @type {Readonly<Record<string, string>>} */
const HEADER_LABELS = Object.freeze({});
/** @type {Readonly<Record<string, string>>} */
const SETTINGS_LABELS = Object.freeze({ 'chat-thread.picker.auto': 'chat-thread.picker.auto_long' });

/**
 * The two pickers. The settings' select is wider and says more about Auto.
 * @type {ReadonlyArray<{ id: string, labels: Readonly<Record<string, string>> }>}
 */
const PICKERS = Object.freeze([
  { id: 'engineSelector', labels: HEADER_LABELS },
  { id: 'cfgComputeMode', labels: SETTINGS_LABELS },
]);

/** @type {HardwareProfile | null} */
let hw = null;
/** @type {readonly MeasuredRun[]} */
let history = [];

/** @type {Promise<readonly MeasuredRun[]> | null} */
let historyRead = null;

/**
 * The benchmark history of this browser for the recommendation, read once (lazily, at most
 * TIMEOUTS_MS.benchHistory); empty when it cannot be read in time.
 * @returns {Promise<readonly MeasuredRun[]>}
 */
export function benchHistory() {
  historyRead ??= Promise.race([
    import('./models/bench-history.js').then((m) => m.readHistory()),
    new Promise((resolve) => setTimeout(() => resolve([]), TIMEOUTS_MS.benchHistory)),
  ]).then(
    (runs) => /** @type {readonly MeasuredRun[]} */ (Array.isArray(runs) ? runs : []),
    () => [],
  );
  return historyRead;
}

/** The stored choice as the pickers show it. */
function currentState() {
  return { assistant: getAssistant(), preference: getModelPreference() };
}

/**
 * @param {PickerItem} item
 * @param {Readonly<Record<string, string>>} labels i18n keys this picker uses instead
 */
function optionText(item, labels) {
  return optionParts(item)
    .map((part) => {
      if ('text' in part) return part.text;
      const key = labels[part.key] ?? part.key;
      return part.gb === undefined ? t(key) : t(key, { gb: formatNumber(part.gb, { maximumFractionDigits: 2 }) });
    })
    .join(' · ');
}

/**
 * @param {PickerGroup} group
 * @param {Readonly<Record<string, string>>} labels
 */
function buildGroup(group, labels) {
  const el = document.createElement('optgroup');
  const label = groupLabel(group.id);
  el.label = 'key' in label ? t(label.key) : label.text;
  el.dataset.group = group.id;
  for (const item of group.items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = optionText(item, labels);
    option.disabled = Boolean(item.disabled);
    el.append(option);
  }
  return el;
}

function renderBadges() {
  const box = byId('cfgDeviceBadges');
  if (!box) return;
  const badges = hw ? hardwareBadges(hw) : [];
  box.replaceChildren(
    ...badges.map((badge) => {
      const span = document.createElement('span');
      span.className = 'badge badge-muted';
      setText(span, badge.key, badge.params);
      return span;
    }),
  );
  setHidden(box, badges.length === 0);
}

/** The site's pools in the settings: each with a word and an icon, never colour alone. */
function renderPools() {
  const box = byId('cfgPoolHealth');
  if (!box) return;
  const { pools } = providerState();
  box.replaceChildren(
    ...POOL_IDS.map((id) => {
      const state = pools === null ? 'unknown' : pools[id]?.configured ? 'on' : 'off';
      const chip = document.createElement('span');
      chip.className = `badge ${state === 'on' ? 'badge-success' : 'badge-muted'}`;
      chip.dataset.pool = id;
      chip.dataset.state = state;
      const name = document.createElement('span');
      name.textContent = `${getProvider(POOLS[id].provider)?.label ?? id}:`;
      const word = document.createElement('span');
      setText(word, `ai-orchestration.health.${state}`);
      chip.append(name, ' ', word);
      return chip;
    }),
  );
}

/**
 * Rebuilds both pickers for this device and what is set up, and selects the stored choice. Does
 * nothing before the device probe: the static options stay until then.
 */
export function renderModelPickers() {
  renderPools();
  if (!hw) return;
  const state = providerState();
  const value = choiceValue(currentState(), hw, history);
  const groups = assistantGroups({ hw, history, pools: state.pools, keyed: state.keyed, models: state.models, server: state.server, serverModels: state.serverModels, current: value });
  for (const { id, labels } of PICKERS) {
    const sel = byId(id);
    if (!(sel instanceof HTMLSelectElement)) continue;
    // A picker in use is rebuilt when it loses focus: rebuilding would close its open list.
    if (sel === document.activeElement && sel.dataset.ready === 'true') {
      sel.dataset.stale = 'true';
      continue;
    }
    delete sel.dataset.stale;
    sel.replaceChildren(...groups.map((group) => buildGroup(group, labels)));
    sel.value = value;
    sel.dataset.ready = 'true';
  }
  renderBadges();
}

/** The picker value of the stored choice ('device' shows as its model once the device is probed). */
export function currentPickerValue() {
  return choiceValue(currentState(), hw, history);
}

/**
 * Selects the stored choice in both pickers without rebuilding them, for example after a switch was
 * refused. Rebuilds when the choice has no option yet.
 */
export function syncPickerValue() {
  const value = currentPickerValue();
  for (const { id } of PICKERS) {
    const sel = byId(id);
    if (!(sel instanceof HTMLSelectElement)) continue;
    if (![...sel.options].some((option) => option.value === value)) {
      if (hw) {
        renderModelPickers();
        return;
      }
      continue;
    }
    if (sel.value !== value) sel.value = value;
  }
}

/**
 * Probes the device (default adapter, at most 2.5 s) once the page is idle and reads the benchmark
 * history, then rebuilds the pickers. Language switches and changes of what is set up rebuild them
 * again; a new choice only moves the selection.
 */
export function initModelPicker() {
  onLocaleChange(() => renderModelPickers());
  onAssistantChange(() => syncPickerValue());
  onProvidersChange(() => renderModelPickers());
  for (const { id } of PICKERS) {
    const sel = byId(id);
    if (!sel) continue;
    // The providers' live model lists are read when a picker is opened, not at every visit.
    sel.addEventListener('pointerdown', () => void refreshModelLists());
    sel.addEventListener('focus', () => void refreshModelLists());
    sel.addEventListener('blur', () => {
      if (sel.dataset.stale === 'true') renderModelPickers();
    });
  }
  const run = () => {
    Promise.all([getDeviceProbe(), benchHistory()])
      .then(([probe, runs]) => {
        hw = probe.hw;
        history = runs;
        renderModelPickers();
      })
      .catch(reportUnexpected);
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2_000 });
  else setTimeout(run, 0);
}
