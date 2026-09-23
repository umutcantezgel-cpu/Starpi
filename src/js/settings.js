// @ts-check
// Settings tab: compute mode, provider keys (session or device storage), own-server URL,
// WebGPU model preference, and connection tests.
import { STORAGE_KEYS } from './config.js';
import { byId, onAction, onChange, setHidden, setHtml } from './dom.js';
import { renderEngineState, startLocalEngine } from './engine-ui.js';
import { refreshIcons } from './icons.js';
import { formatNumber, getLocale, setText, t } from './i18n/index.js';
import { readinessPrompt } from './prompts.js';
import { callGemini, callOpenRouter, hasGeminiKey, hasOpenRouterKey, normalizeServerUrl, probeLocalServer } from './providers.js';
import { escapeHtml, sanitizeModelNames } from './render.js';
import { getLlmUrl, getMode, getModelPreference, setLlmUrl, setMode, setModelPreference } from './state.js';
import { readLocal, readSecret, removeSecret, writeLocal, writeSecret } from './storage.js';
import { setEngineDot } from './ui.js';
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
 */
export async function changeEngine(value, opts) {
  setMode(/** @type {ComputeMode} */ (value));
  const mode = getMode();
  syncModeSelectors(mode);
  renderPrivacyNotice();
  renderEngineState(engine.getEngineState());

  if (mode === 'client') {
    if (engine.isReady()) {
      setEngineDot('ok');
      return;
    }
    const loaded = await startLocalEngine({ interactive: opts.interactive });
    if (!loaded && !opts.interactive && engine.getEngineState().status === 'idle') {
      setEngineDot('off');
    }
  } else if (mode === 'local') {
    setEngineDot('busy');
    setEngineDot((await probeLocalServer(getLlmUrl())) ? 'ok' : 'warn');
  } else {
    setEngineDot(hasGeminiKey() || hasOpenRouterKey() ? 'ok' : 'off');
  }
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
  setLlmUrl(url);
  if (urlInput) urlInput.value = url;

  const remember = Boolean(rememberInput?.checked);
  const wasRemembered = rememberKeys();
  writeLocal(STORAGE_KEYS.rememberKeys, remember ? '1' : '0');
  for (const [key, input] of /** @type {Array<[string, HTMLInputElement | null]>} */ ([
    [STORAGE_KEYS.geminiKey, geminiInput],
    [STORAGE_KEYS.openrouterKey, openrouterInput],
  ])) {
    const typed = input?.value.trim() ?? '';
    const existing = readSecret(key);
    if (typed) writeSecret(key, typed, remember);
    else if (existing && remember !== wasRemembered) writeSecret(key, existing, remember);
    if (input) input.value = '';
  }
  renderKeyHints();

  const previousPreference = getModelPreference();
  setModelPreference(modelInput?.value ?? 'auto');
  const mode = /** @type {ComputeMode} */ (modeInput?.value ?? 'council');
  if (engine.getEngineState().status !== 'idle' && previousPreference !== getModelPreference()) {
    await engine.unloadModel();
  }
  await changeEngine(mode, { interactive: true });
  window.alert(t('settings.saved_toast'));
}

function clearKeys() {
  removeSecret(STORAGE_KEYS.geminiKey);
  removeSecret(STORAGE_KEYS.openrouterKey);
  renderKeyHints();
  renderPrivacyNotice();
  window.alert(t('settings.keys_cleared'));
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
  setHtml(box, `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>${escapeHtml(t(isGemini ? 'settings.test_running_primary' : 'settings.test_running_secondary'))}</span>`);
  setHidden(box, false);

  const t0 = performance.now();
  try {
    const prompt = readinessPrompt(getLocale());
    const text = isGemini
      ? (await callGemini(prompt)).text
      : (await callOpenRouter([{ role: 'user', content: prompt }])).text;
    const elapsed = Math.round(performance.now() - t0);
    box.className = 'text-xs p-2.5 rounded-lg border bg-emerald-500/10 border-emerald-500/30 text-emerald-800 space-y-1';
    setHtml(
      box,
      `<div class="flex items-center justify-between font-semibold">
        <span class="flex items-center gap-1.5"><i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-600"></i> ${escapeHtml(t(isGemini ? 'settings.test_ok_primary' : 'settings.test_ok_secondary'))}</span>
        <span class="font-mono text-[11px]">${escapeHtml(formatNumber(elapsed))} ms</span>
      </div>
      <p class="text-[11px] text-slate-600 italic">"${escapeHtml(sanitizeModelNames(text.slice(0, 140)))}"</p>`,
    );
  } catch (err) {
    const notConfigured = Boolean(err && typeof err === 'object' && 'notConfigured' in err && err.notConfigured);
    box.className = `text-xs p-2.5 rounded-lg border ${notConfigured ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-rose-500/10 border-rose-500/30 text-rose-700'}`;
    setHtml(
      box,
      `<div class="flex items-center gap-1.5 font-semibold">
        <i data-lucide="${notConfigured ? 'info' : 'alert-circle'}" class="w-3.5 h-3.5"></i>
        <span>${escapeHtml(notConfigured ? t('settings.test_not_configured', { provider: isGemini ? 'Gemini' : 'OpenRouter' }) : t('settings.test_failed'))}</span>
      </div>
      <p class="text-[11px] mt-1 text-slate-600">${escapeHtml(sanitizeModelNames(err instanceof Error ? err.message : String(err)))}</p>`,
    );
  } finally {
    if (btn) btn.disabled = false;
  }
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
}
