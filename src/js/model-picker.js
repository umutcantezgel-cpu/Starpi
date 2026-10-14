// @ts-check
// The assistant pickers: the header's #engineSelector and the settings' #cfgComputeMode. Once the
// device is probed, both are rebuilt from the model catalogs as option groups (recommended for this
// device, on-device, NVIDIA cloud, other assistants), and the settings show the hardware badges.
// Until then the static options in index.html stay (the bare modes 'council', 'client', 'nvidia' and
// 'local'). Model names come from the catalogs; everything else is translated.
//
// Must not import settings.js or chat.js: settings.js imports this module.
import { byId, reportUnexpected, setHidden } from './dom.js';
import { formatNumber, onLocaleChange, setText, t } from './i18n/index.js';
import { assistantGroups, choiceValue, GROUP_KEYS, nvidiaStatus, optionParts } from './models/choices.js';
import { hardwareBadges } from './models/device.js';
import { getNvidiaCatalog, onNvidiaCatalog } from './providers.js';
import { getMode, getModelPreference, getNvidiaModel, onModeChange } from './state.js';
import { getDeviceProbe } from './webgpu/engine.js';

/**
 * @typedef {import('./models/choices.js').PickerItem} PickerItem
 * @typedef {import('./models/choices.js').PickerGroup} PickerGroup
 * @typedef {import('./models/choices.js').AssistantState} AssistantState
 * @typedef {import('./models/choices.js').NvidiaCatalogSummary} NvidiaCatalogSummary
 * @typedef {import('./models/device.js').HardwareProfile} HardwareProfile
 */

/** @type {Readonly<Record<string, string>>} */
const HEADER_LABELS = Object.freeze({});
/** @type {Readonly<Record<string, string>>} */
const SETTINGS_LABELS = Object.freeze({ 'engine.mode_cloud': 'settings.mode_cloud', 'engine.mode_server': 'settings.mode_server' });

/**
 * The two pickers. The settings' select is wider and names the other assistants in more detail.
 * @type {ReadonlyArray<{ id: string, labels: Readonly<Record<string, string>> }>}
 */
const PICKERS = Object.freeze([
  { id: 'engineSelector', labels: HEADER_LABELS },
  { id: 'cfgComputeMode', labels: SETTINGS_LABELS },
]);

/** @type {HardwareProfile | null} */
let hw = null;
/** @type {NvidiaCatalogSummary | null} */
let catalog = null;

/** @returns {AssistantState} */
function currentState() {
  return { mode: getMode(), local: getModelPreference(), nvidia: getNvidiaModel() };
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
  el.label = t(GROUP_KEYS[group.id]);
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

/**
 * Rebuilds both pickers for this device and the NVIDIA proxy's state, and selects the stored choice.
 * Does nothing before the device probe: the static options stay until then.
 */
export function renderModelPickers() {
  if (!hw) return;
  const current = currentState();
  const groups = assistantGroups(hw, nvidiaStatus(catalog, current));
  const value = choiceValue(current, hw);
  for (const { id, labels } of PICKERS) {
    const sel = byId(id);
    if (!(sel instanceof HTMLSelectElement)) continue;
    sel.replaceChildren(...groups.map((group) => buildGroup(group, labels)));
    sel.value = value;
    sel.dataset.ready = 'true';
  }
  renderBadges();
}

/** The picker value of the stored choice ('auto' shows as the recommended model once the device is probed). */
export function currentPickerValue() {
  return choiceValue(currentState(), hw);
}

/**
 * Selects the stored choice in both pickers without rebuilding them, for example after a switch was
 * refused. Rebuilds when the choice has no option yet (an NVIDIA model that was hidden).
 */
export function syncPickerValue() {
  const value = currentPickerValue();
  for (const { id } of PICKERS) {
    const sel = byId(id);
    if (!(sel instanceof HTMLSelectElement)) continue;
    if (hw && ![...sel.options].some((option) => option.value === value)) {
      renderModelPickers();
      return;
    }
    if (sel.value !== value) sel.value = value;
  }
}

/** @param {NvidiaCatalogSummary} next */
function applyCatalog(next) {
  if (next === catalog) return;
  catalog = next;
  renderModelPickers();
}

/**
 * Probes the device (default adapter, at most 2.5 s) and asks the NVIDIA proxy for its models once
 * the page is idle, then rebuilds the pickers. Language switches and later proxy answers rebuild
 * them again; mode changes only move the selection.
 */
export function initModelPicker() {
  onLocaleChange(() => renderModelPickers());
  onModeChange(() => syncPickerValue());
  onNvidiaCatalog(applyCatalog);
  const run = () => {
    getDeviceProbe()
      .then((probe) => {
        hw = probe.hw;
        renderModelPickers();
      })
      .catch(reportUnexpected);
    getNvidiaCatalog().then(applyCatalog).catch(reportUnexpected);
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2_000 });
  else setTimeout(run, 0);
}
