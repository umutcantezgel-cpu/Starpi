// @ts-check
// Settings tab: the assistant (picked in either model picker: Auto, a model on this device, a free
// model of the site's pools, a model of a provider the user has a key for, or their own server),
// the model strength Auto and provider picks follow, the privacy notice under the composer, and
// the deletion of model data and chat history. Keys, the vault, the relay and the own server's
// address live in Settings › Model providers and keys (settings/providers-view.js, ai/keys.js).
import { deleteChatHistory } from './chat-store.js';
import { isChatBusy, resetConversation } from './chat.js';
import { canSyncChats } from './supabase.js';
import { byId, onAction, onChange } from './dom.js';
import { renderEngineState, startLocalEngine } from './engine-ui.js';
import { refreshIcons } from './icons.js';
import { setText, t } from './i18n/index.js';
import { currentPickerValue, syncPickerValue } from './model-picker.js';
import { builtInRoute } from './chat/mode-control.js';
import { parsePickerValue } from './models/choices.js';
import { configuredProviders, onProvidersChange, probeLocalServer, providerLabel, routeOf } from './providers.js';
import { listWorkspace } from './rag/workspace.js';
import { assistantTarget, getAssistant, getChatMode, getLlmUrl, getModelPreference, getNvidiaModel, onAssistantChange, onChatModeChange, setAssistant } from './state.js';
import { setAssistantStatus, setEngineDot } from './ui.js';
import * as engine from './webgpu/engine.js';

/** @typedef {import('./config.js').AssistantValue} AssistantValue */

/**
 * Where a question goes with the chosen assistant: on this device, the own server, a provider with
 * the user's key, a pool of this site, or nowhere (no model is set up).
 * @param {AssistantValue} value
 * @returns {{ kind: 'device' | 'local' | 'key' | 'pool' | 'none', provider?: import('./ai/contract.js').ProviderId }}
 */
export function destinationOf(value) {
  if (value === 'device') return { kind: 'device' };
  const provider = value === 'auto' ? configuredProviders()[0] : assistantTarget(value)?.provider;
  if (!provider) return value === 'auto' && engine.isReady() ? { kind: 'device' } : { kind: 'none' };
  const route = routeOf(provider);
  if (route === 'key' || route === 'pool') return { kind: route, provider };
  if (route === 'local') return { kind: 'local' };
  return { kind: 'none' };
}

/** Footer under the chat input: where the question goes with the chosen assistant and mode. */
export function renderPrivacyNotice() {
  const el = byId('privacyNotice');
  if (!el) return;
  const mode = getChatMode();
  // The free chat searches no sources: its notices say what goes where instead.
  const free = (mode === 'auto' ? builtInRoute({ mode, attachments: [], workspaceDocs: listWorkspace().length }) : mode) === 'free';
  const dest = destinationOf(getAssistant());
  let icon = free ? 'info' : 'library';
  let key = free ? 'privacy.free_no_model' : 'privacy.extractive';
  /** @type {Record<string, string> | undefined} */
  let params;
  if (dest.kind === 'device') {
    icon = 'lock';
    key = free ? 'privacy.free_local' : 'privacy.local';
  } else if (dest.kind === 'local') {
    icon = 'server';
    key = free ? 'privacy.free_server' : 'privacy.server';
    let host = '';
    try {
      host = new URL(getLlmUrl()).host;
    } catch {
      // keep empty host
    }
    params = { host: host || '–' };
  } else if (dest.kind === 'pool') {
    icon = 'cloud';
    key = free ? 'chat-thread.privacy.free_pool' : 'chat-thread.privacy.pool';
    params = { provider: providerLabel(/** @type {import('./ai/contract.js').ProviderId} */ (dest.provider)) };
  } else if (dest.kind === 'key') {
    icon = 'cloud';
    key = free ? 'chat-thread.privacy.free_key' : 'chat-thread.privacy.key';
    params = { provider: providerLabel(/** @type {import('./ai/contract.js').ProviderId} */ (dest.provider)) };
  }
  const iconEl = document.createElement('i');
  iconEl.dataset.lucide = icon;
  iconEl.className = 'w-3.5 h-3.5 flex-shrink-0';
  const text = document.createElement('span');
  setText(text, key, params);
  el.replaceChildren(iconEl, text);
  // Disclose where the conversation itself is kept when it leaves the browser.
  if (dest.kind !== 'device' && canSyncChats()) {
    const history = document.createElement('span');
    history.className = 'basis-full sm:basis-auto'; // its own line on phones
    setText(history, 'privacy.history_synced');
    el.append(history);
  }
  refreshIcons(el);
}

/** The engine dot and status line for the chosen assistant (not by colour alone). */
function renderReach() {
  const dest = destinationOf(getAssistant());
  if (dest.kind === 'device') {
    setEngineDot(engine.isReady() ? 'ok' : 'off');
    return;
  }
  setEngineDot(dest.kind === 'none' ? 'off' : 'ok');
}

/**
 * Applies a picker value (models/choices.js parsePickerValue): Auto, an on-device preset, a model of
 * a provider or pool, or the own server. `interactive` is true when the user picked it (allows a
 * model download). A switch is refused while an answer is being written; the pickers then show the
 * stored choice again.
 * @param {string} value
 * @param {{ interactive: boolean }} opts
 * @returns {Promise<boolean>} whether the choice was also stored for the next visit
 */
export async function changeEngine(value, opts) {
  const picked = parsePickerValue(value, { nvidiaModel: getNvidiaModel() });
  if (!picked) {
    syncPickerValue();
    return false;
  }
  const previousLocal = getModelPreference();
  const switching = picked.assistant !== getAssistant() || (picked.preference !== undefined && picked.preference !== previousLocal);
  // The answer being written keeps its model; unloading it would cut the answer off.
  if (switching && isChatBusy()) {
    syncPickerValue();
    if (opts.interactive) window.alert(t('models.switch_busy'));
    return false;
  }

  if (picked.preference !== undefined) {
    // Another on-device model was loaded (or is loading) for the previous choice: free it, so the
    // picked one is loaded below or with the next question.
    const s = engine.getEngineState();
    if (picked.preference !== previousLocal && s.status !== 'idle' && !(s.status === 'ready' && s.model?.ref === picked.preference)) await engine.unloadModel();
  }
  const stored = setAssistant(picked.preference ?? picked.assistant);
  syncPickerValue();
  renderPrivacyNotice();
  renderEngineState(engine.getEngineState());

  const assistant = getAssistant();
  if (assistant === 'device') {
    if (engine.isReady()) {
      setEngineDot('ok');
      return stored;
    }
    const loaded = await startLocalEngine({ interactive: opts.interactive });
    if (!loaded && !opts.interactive && engine.getEngineState().status === 'idle') setEngineDot('off');
  } else if (assistant.startsWith('local:')) {
    setEngineDot('busy');
    const reachable = await probeLocalServer(getLlmUrl());
    setEngineDot(reachable ? 'ok' : 'warn');
    // Not by colour alone: the status line says it too.
    setAssistantStatus(reachable ? 'status.ready' : 'status.server_unreachable');
  } else {
    renderReach();
    const dest = destinationOf(assistant);
    if (dest.kind === 'none' && assistant !== 'auto') setAssistantStatus('chat-thread.status.not_set_up');
  }
  return stored;
}

/** Applies the model strength (Auto and provider picks follow it) and shows the stored one. */
async function initStrength() {
  const sel = /** @type {HTMLSelectElement | null} */ (byId('cfgStrength'));
  if (!sel) return;
  const m = await import('./ai/model-selection.js');
  sel.value = m.getModelStrength();
  m.onModelSelectionChange((strength) => {
    sel.value = strength;
  });
}

async function saveSettings() {
  const modeInput = /** @type {HTMLSelectElement | null} */ (byId('cfgComputeMode'));
  const strengthInput = /** @type {HTMLSelectElement | null} */ (byId('cfgStrength'));
  let stored = true;
  if (strengthInput) {
    const m = await import('./ai/model-selection.js');
    if (m.isModelStrength(strengthInput.value) && strengthInput.value !== m.getModelStrength()) stored = m.setModelStrength(strengthInput.value) && stored;
  }
  // A pick is applied when it is made. Only a picker showing something else than the stored choice
  // (e.g. a switch that waited for the keyboard to settle) is applied here: re-applying the shown
  // recommendation would replace a stored 'auto' with a fixed model.
  if (modeInput && modeInput.value !== currentPickerValue()) stored = (await changeEngine(modeInput.value, { interactive: true })) && stored;
  window.alert(t(stored ? 'settings.saved_toast' : 'settings.save_failed'));
}

async function deleteHistory() {
  // An answer still being written would store its turn again after the delete.
  if (isChatBusy()) {
    window.alert(t('settings.delete_history_busy'));
    return;
  }
  if (!window.confirm(t('settings.delete_history_confirm'))) return;
  const ok = await deleteChatHistory();
  resetConversation();
  window.alert(t(ok ? 'settings.delete_history_done' : 'settings.delete_history_partial'));
}

async function deleteModelCache() {
  if (!window.confirm(t('settings.delete_models_confirm'))) return;
  try {
    await engine.deleteCachedModels();
    window.alert(t('settings.delete_models_done'));
  } catch (err) {
    window.alert(t('settings.delete_models_failed', { reason: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Arrow keys on a closed <select> fire a change at every step in Chrome on Windows and Linux. Each
 * step would switch the engine: unload the loaded model and ask to download the next one. A change
 * that follows a key press is therefore applied once the user rests on an option (or leaves the
 * picker, or presses Enter); a pick with the mouse or touch is applied at once.
 */
const KEY_SETTLE_MS = 700;
/** @type {WeakMap<HTMLSelectElement, { keyAt: number, timer: ReturnType<typeof setTimeout> | null }>} */
const pickerKeys = new WeakMap();

/** @param {HTMLSelectElement} sel */
function applyPick(sel) {
  const state = pickerKeys.get(sel);
  if (state?.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  return changeEngine(sel.value, { interactive: true });
}

/** @param {KeyboardEvent} event */
function notePickerKey(event) {
  const sel = event.target;
  if (!(sel instanceof HTMLSelectElement) || sel.dataset.change !== 'change-engine') return;
  const state = pickerKeys.get(sel) ?? { keyAt: 0, timer: null };
  if (event.key === 'Enter' && state.timer) {
    void applyPick(sel);
    return;
  }
  state.keyAt = performance.now();
  pickerKeys.set(sel, state);
}

/** @param {HTMLSelectElement} sel */
function pickFromSelect(sel) {
  const state = pickerKeys.get(sel);
  if (!state || performance.now() - state.keyAt > 500) return applyPick(sel);
  if (state.timer) clearTimeout(state.timer);
  else {
    sel.addEventListener(
      'blur',
      () => {
        if (pickerKeys.get(sel)?.timer) void applyPick(sel);
      },
      { once: true },
    );
  }
  state.timer = setTimeout(() => void applyPick(sel), KEY_SETTLE_MS);
  return undefined;
}

export function initSettings() {
  syncPickerValue();
  renderPrivacyNotice();
  // The mode control lives in the chat, which must not import this module: state.js tells us.
  onChatModeChange(() => renderPrivacyNotice());
  onAssistantChange(() => renderPrivacyNotice());
  onProvidersChange(() => {
    renderPrivacyNotice();
    renderReach();
  });

  onChange('change-engine', (el) => pickFromSelect(/** @type {HTMLSelectElement} */ (el)));
  onChange('change-strength', async (el) => {
    const m = await import('./ai/model-selection.js');
    const value = /** @type {HTMLSelectElement} */ (el).value;
    if (m.isModelStrength(value)) m.setModelStrength(value);
  });
  document.addEventListener('keydown', notePickerKey, true);
  onAction('save-settings', () => saveSettings());
  onAction('delete-model-cache', () => deleteModelCache());
  onAction('delete-chat-history', () => deleteHistory());
  const idle = () => void initStrength().catch(() => {});
  if (typeof requestIdleCallback === 'function') requestIdleCallback(idle, { timeout: 2_000 });
  else setTimeout(idle, 0);
}
