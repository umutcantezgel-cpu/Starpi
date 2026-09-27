// @ts-check
// Settings tab: compute mode, provider keys (session or device storage), own-server URL,
// WebGPU model preference, and connection tests.
import { deleteChatHistory } from './chat-store.js';
import { isChatBusy, resetConversation } from './chat.js';
import { STORAGE_KEYS } from './config.js';
import { canSyncChats } from './supabase.js';
import { byId, onAction, onChange, setHidden } from './dom.js';
import { renderEngineState, startLocalEngine } from './engine-ui.js';
import { refreshIcons } from './icons.js';
import { formatNumber, getLocale, setText, t } from './i18n/index.js';
import { readinessPrompt } from './prompts.js';
import { callGemini, callOpenRouter, hasGeminiKey, hasOpenRouterKey, normalizeServerUrl, probeLocalServer } from './providers.js';
import { sanitizeModelNames } from './render.js';
import { getLlmUrl, getMode, getModelPreference, setLlmUrl, setMode, setModelPreference } from './state.js';
import { readLocal, readSecret, removeSecret, writeLocal, writeSecret } from './storage.js';
import { setAssistantStatus, setEngineDot } from './ui.js';
import * as engine from './webgpu/engine.js';

/** @typedef {import('./config.js').ComputeMode} ComputeMode */

function rememberKeys() {
  return readLocal(STORAGE_KEYS.rememberKeys) === '1';
}

/**
 * @param {HTMLElement | null} el
 * @param {string} value
 */
function renderKeyHint(el, value) {
  if (value) setText(el, 'settings.key_saved', { last4: value.slice(-4) });
  else setText(el, 'settings.key_none');
}

function renderKeyHints() {
  renderKeyHint(byId('cfgGeminiKeyHint'), readSecret(STORAGE_KEYS.geminiKey));
  renderKeyHint(byId('cfgOpenrouterKeyHint'), readSecret(STORAGE_KEYS.openrouterKey));
}

/** Footer under the chat input: where the question goes in the current mode. */
export function renderPrivacyNotice() {
  const el = byId('privacyNotice');
  if (!el) return;
  const mode = getMode();
  let icon = 'library';
  let key = 'privacy.extractive';
  /** @type {Record<string, string> | undefined} */
  let params;
  if (mode === 'client') {
    icon = 'lock';
    key = 'privacy.local';
  } else if (mode === 'local') {
    icon = 'server';
    key = 'privacy.server';
    let host = '';
    try {
      host = new URL(getLlmUrl()).host;
    } catch {
      // keep empty host
    }
    params = { host: host || '–' };
  } else if (hasGeminiKey() || hasOpenRouterKey()) {
    icon = 'cloud';
    key = 'privacy.cloud';
  }
  const iconEl = document.createElement('i');
  iconEl.dataset.lucide = icon;
  iconEl.className = 'w-3.5 h-3.5 flex-shrink-0';
  const text = document.createElement('span');
  setText(text, key, params);
  el.replaceChildren(iconEl, text);
  // Disclose where the conversation itself is kept when it leaves the browser.
  if (mode !== 'client' && canSyncChats()) {
    const history = document.createElement('span');
    history.className = 'basis-full sm:basis-auto'; // its own line on phones
    setText(history, 'privacy.history_synced');
    el.append(history);
  }
  refreshIcons(el);
}

/** @param {ComputeMode} mode */
function syncModeSelectors(mode) {
  for (const id of ['engineSelector', 'cfgComputeMode']) {
    const sel = /** @type {HTMLSelectElement | null} */ (byId(id));
    if (sel && sel.value !== mode) sel.value = mode;
  }
}

/**
 * Applies a compute mode. `interactive` is true when the user picked it (allows a model download).
 * @param {string} value
 * @param {{ interactive: boolean }} opts
 * @returns {Promise<boolean>} whether the mode was also stored for the next visit
 */
export async function changeEngine(value, opts) {
  const stored = setMode(/** @type {ComputeMode} */ (value));
  const mode = getMode();
  syncModeSelectors(mode);
  renderPrivacyNotice();
  renderEngineState(engine.getEngineState());

  if (mode === 'client') {
    if (engine.isReady()) {
      setEngineDot('ok');
      return stored;
    }
    const loaded = await startLocalEngine({ interactive: opts.interactive });
    if (!loaded && !opts.interactive && engine.getEngineState().status === 'idle') {
      setEngineDot('off');
    }
  } else if (mode === 'local') {
    setEngineDot('busy');
    const reachable = await probeLocalServer(getLlmUrl());
    setEngineDot(reachable ? 'ok' : 'warn');
    // Not by colour alone: the status line says it too.
    setAssistantStatus(reachable ? 'status.ready' : 'status.server_unreachable');
  } else {
    setEngineDot(hasGeminiKey() || hasOpenRouterKey() ? 'ok' : 'off');
  }
  return stored;
}

async function saveSettings() {
  const urlInput = /** @type {HTMLInputElement | null} */ (byId('cfgLlmUrl'));
  const geminiInput = /** @type {HTMLInputElement | null} */ (byId('cfgGeminiKey'));
  const openrouterInput = /** @type {HTMLInputElement | null} */ (byId('cfgOpenrouterKey'));
  const rememberInput = /** @type {HTMLInputElement | null} */ (byId('cfgRememberKeys'));
  const modeInput = /** @type {HTMLSelectElement | null} */ (byId('cfgComputeMode'));
  const modelInput = /** @type {HTMLSelectElement | null} */ (byId('cfgWebgpuModel'));

  let url;
  try {
    url = normalizeServerUrl(urlInput?.value ?? '');
  } catch (err) {
    window.alert(err instanceof Error ? err.message : t('provider.invalid_url'));
    urlInput?.focus();
    return;
  }
  // Every write reports whether the browser stored it (private windows and full or disabled
  // storage refuse); the confirmation must not claim more than was kept.
  let stored = setLlmUrl(url);
  if (urlInput) urlInput.value = url;

  const remember = Boolean(rememberInput?.checked);
  const wasRemembered = rememberKeys();
  stored = writeLocal(STORAGE_KEYS.rememberKeys, remember ? '1' : '0') && stored;
  for (const [key, input] of /** @type {Array<[string, HTMLInputElement | null]>} */ ([
    [STORAGE_KEYS.geminiKey, geminiInput],
    [STORAGE_KEYS.openrouterKey, openrouterInput],
  ])) {
    const typed = input?.value.trim() ?? '';
    const existing = readSecret(key);
    if (typed) stored = writeSecret(key, typed, remember) && stored;
    else if (existing && remember !== wasRemembered) stored = writeSecret(key, existing, remember) && stored;
    if (input) input.value = '';
  }
  renderKeyHints();

  const previousPreference = getModelPreference();
  stored = setModelPreference(modelInput?.value ?? 'auto') && stored;
  const mode = /** @type {ComputeMode} */ (modeInput?.value ?? 'council');
  if (engine.getEngineState().status !== 'idle' && previousPreference !== getModelPreference()) {
    await engine.unloadModel();
  }
  stored = (await changeEngine(mode, { interactive: true })) && stored;
  window.alert(t(stored ? 'settings.saved_toast' : 'settings.save_failed'));
}

function clearKeys() {
  removeSecret(STORAGE_KEYS.geminiKey);
  removeSecret(STORAGE_KEYS.openrouterKey);
  renderKeyHints();
  renderPrivacyNotice();
  window.alert(t('settings.keys_cleared'));
}

/**
 * A result line: icon plus a translated text that follows a language switch.
 * @param {string} icon
 * @param {string} iconClass
 * @param {string} key
 * @param {Record<string, string>} [params]
 */
function statusLine(icon, iconClass, key, params) {
  const line = document.createElement('span');
  line.className = 'flex items-center gap-1.5';
  const i = document.createElement('i');
  i.dataset.lucide = icon;
  i.className = `w-3.5 h-3.5 flex-shrink-0 ${iconClass}`;
  const text = document.createElement('span');
  setText(text, key, params);
  line.append(i, text);
  return line;
}

/**
 * @param {'gemini' | 'openrouter'} provider
 */
async function testProvider(provider) {
  const isGemini = provider === 'gemini';
  const btn = /** @type {HTMLButtonElement | null} */ (byId(isGemini ? 'btnTestPrimary' : 'btnTestSecondary'));
  const box = byId(isGemini ? 'primaryTestStatus' : 'secondaryTestStatus');
  if (!box) return;
  if (btn) btn.disabled = true;
  box.className = 'text-xs p-2.5 rounded-lg border bg-amber-500/10 border-amber-500/30 text-amber-800 flex items-center gap-2';
  box.replaceChildren(statusLine('loader-2', 'animate-spin', isGemini ? 'settings.test_running_primary' : 'settings.test_running_secondary'));
  refreshIcons(box);
  setHidden(box, false);

  const t0 = performance.now();
  try {
    const prompt = readinessPrompt(getLocale());
    // A key typed but not saved yet is tested as typed.
    const typed = /** @type {HTMLInputElement | null} */ (byId(isGemini ? 'cfgGeminiKey' : 'cfgOpenrouterKey'))?.value.trim() || undefined;
    const text = isGemini
      ? (await callGemini(prompt, { key: typed })).text
      : (await callOpenRouter([{ role: 'user', content: prompt }], { key: typed })).text;
    const elapsed = Math.round(performance.now() - t0);
    box.className = 'text-xs p-2.5 rounded-lg border bg-emerald-500/10 border-emerald-500/30 text-emerald-800 space-y-1';
    const head = document.createElement('div');
    head.className = 'flex items-center justify-between gap-2 font-semibold';
    const ms = document.createElement('span');
    ms.className = 'font-mono text-[11px]';
    ms.textContent = `${formatNumber(elapsed)} ms`;
    head.append(statusLine('check-circle-2', 'text-emerald-600', isGemini ? 'settings.test_ok_primary' : 'settings.test_ok_secondary'), ms);
    const sample = document.createElement('p');
    sample.className = 'text-[11px] text-slate-600 italic';
    sample.textContent = `"${sanitizeModelNames(text.slice(0, 140))}"`;
    box.replaceChildren(head, sample);
  } catch (err) {
    const notConfigured = Boolean(err && typeof err === 'object' && 'notConfigured' in err && err.notConfigured);
    box.className = `text-xs p-2.5 rounded-lg border ${notConfigured ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-rose-500/10 border-rose-500/30 text-rose-700'}`;
    const head = statusLine(
      notConfigured ? 'info' : 'alert-circle',
      '',
      notConfigured ? 'settings.test_not_configured' : 'settings.test_failed',
      notConfigured ? { provider: isGemini ? 'Gemini' : 'OpenRouter' } : undefined,
    );
    head.classList.add('font-semibold');
    const detail = document.createElement('p');
    detail.className = 'text-[11px] mt-1 text-slate-600';
    if (notConfigured) setText(detail, 'settings.test_enter_key');
    else detail.textContent = sanitizeModelNames(err instanceof Error ? err.message : String(err));
    box.replaceChildren(head, detail);
  } finally {
    refreshIcons(box);
    if (btn) btn.disabled = false;
  }
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

export function initSettings() {
  const urlInput = /** @type {HTMLInputElement | null} */ (byId('cfgLlmUrl'));
  if (urlInput) urlInput.value = getLlmUrl();
  const modelInput = /** @type {HTMLSelectElement | null} */ (byId('cfgWebgpuModel'));
  if (modelInput) modelInput.value = getModelPreference();
  const rememberInput = /** @type {HTMLInputElement | null} */ (byId('cfgRememberKeys'));
  if (rememberInput) rememberInput.checked = rememberKeys();
  syncModeSelectors(getMode());
  renderKeyHints();
  renderPrivacyNotice();

  onChange('change-engine', (el) => changeEngine(/** @type {HTMLSelectElement} */ (el).value, { interactive: true }));
  onAction('save-settings', () => saveSettings());
  onAction('clear-keys', () => clearKeys());
  onAction('test-gemini', () => testProvider('gemini'));
  onAction('test-openrouter', () => testProvider('openrouter'));
  onAction('delete-model-cache', () => deleteModelCache());
  onAction('delete-chat-history', () => deleteHistory());
}
