// @ts-check
// Settings tab: compute mode, provider keys (session or device storage), own-server URL,
// WebGPU model preference, and connection tests.
import { STORAGE_KEYS } from './config.js';
import { byId, onAction, onChange, setHidden, setHtml } from './dom.js';
import { renderEngineState, startLocalEngine } from './engine-ui.js';
import { t } from './i18n/index.js';
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

/** @param {string} value */
function maskKey(value) {
  return value ? `Saved (••••${value.slice(-4)})` : t('settings.openrouter_hint');
}

function renderKeyHints() {
  const gemini = byId('cfgGeminiKeyHint');
  const openrouter = byId('cfgOpenrouterKeyHint');
  if (gemini) gemini.textContent = maskKey(readSecret(STORAGE_KEYS.geminiKey));
  if (openrouter) openrouter.textContent = maskKey(readSecret(STORAGE_KEYS.openrouterKey));
}

export function renderPrivacyNotice() {
  const el = byId('privacyNotice');
  if (!el) return;
  const mode = getMode();
  if (mode === 'client') {
    el.textContent = t('status.privacy_local');
  } else if (mode === 'local') {
    let host = 'Local Server';
    try {
      host = new URL(getLlmUrl()).host;
    } catch {
      // keep generic label
    }
    el.textContent = `${t('status.privacy_own_server')} (${host}).`;
  } else if (hasGeminiKey() || hasOpenRouterKey()) {
    el.textContent = t('status.privacy_cloud');
  } else {
    el.textContent = t('chat.fallback_note');
  }
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
    window.alert(err instanceof Error ? err.message : 'Invalid server address.');
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
  window.alert('Stored API keys removed from this device.');
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
  setHtml(box, `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>${isGemini ? 'Testing Gemini connection...' : 'Testing Cloud Assistant...'}</span>`);
  setHidden(box, false);

  const t0 = performance.now();
  try {
    const text = isGemini
      ? (await callGemini('Confirm in one short sentence that the assistant is ready.')).text
      : (
          await callOpenRouter([
            { role: 'system', content: 'You are Starpi. Confirm in one short sentence that the assistant is ready.' },
            { role: 'user', content: 'Confirm readiness.' },
          ])
        ).text;
    const elapsed = Math.round(performance.now() - t0);
    box.className = 'text-xs p-2.5 rounded-lg border bg-emerald-500/10 border-emerald-500/30 text-emerald-800 space-y-1';
    setHtml(
      box,
      `<div class="flex items-center justify-between font-semibold">
        <span class="flex items-center gap-1.5"><i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-600"></i> ${isGemini ? 'Gemini connection ready' : 'Cloud Assistant ready'}</span>
        <span class="font-mono text-[11px]">${elapsed} ms</span>
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
        <span>${notConfigured ? `${isGemini ? 'Gemini' : 'OpenRouter'} not configured` : 'Test failed'}</span>
      </div>
      <p class="text-[11px] mt-1 text-slate-600">${escapeHtml(sanitizeModelNames(err instanceof Error ? err.message : String(err)))}</p>`,
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteModelCache() {
  if (!window.confirm('Delete all downloaded model weights from browser storage?')) {
    return;
  }
  try {
    await engine.deleteCachedModels();
    window.alert('Model weights deleted.');
  } catch (err) {
    window.alert(`Deletion failed: ${err instanceof Error ? err.message : String(err)}`);
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
