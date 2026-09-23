// @ts-check
// Binds the WebGPU engine state machine to the UI (progress banner, VRAM badge, status dot) and
// provides the user-facing load/cancel/unload actions. Failures never switch the user to a cloud
// provider silently: local mode keeps answering from the knowledge base until the user decides.
import { byId, onAction, setHidden } from './dom.js';
import { appendMessage } from './messages.js';
import { escapeMarkdown } from './render.js';
import { getMode, getModelPreference } from './state.js';
import { setEngineDot } from './ui.js';
import * as engine from './webgpu/engine.js';

/** @param {import('./webgpu/engine.js').EngineState} s */
function render(s) {
  const banner = byId('webgpuProgressContainer');
  const progressText = byId('webgpuProgressText');
  const percentText = byId('webgpuPercentText');
  setHidden(banner, s.status !== 'loading');
  if (s.status === 'loading') {
    if (progressText) progressText.textContent = s.progress?.text ? `Lade Modell auf GPU: ${s.progress.text}` : 'Initialisiere lokales Modell im Browser...';
    if (percentText) percentText.textContent = `${Math.round((s.progress?.progress ?? 0) * 100)}%`;
  }

  const memControls = byId('localMemoryControls');
  setHidden(memControls, !(getMode() === 'client' || s.status === 'ready' || s.status === 'loading'));
  const dot = byId('vramStatusDot');
  const text = byId('vramStatusText');
  const btn = byId('btnUnloadWebgpu');
  if (s.status === 'ready' && s.model) {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse';
    const vram = s.model.vramMB ? ` · ca. ${(s.model.vramMB / 1024).toFixed(1)} GB VRAM` : '';
    if (text) text.textContent = `${s.model.label}${s.model.f16 ? '' : ' (f32)'}${vram}`;
    setHidden(btn, false);
  } else {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-slate-500';
    if (text) text.textContent = s.status === 'loading' ? 'Modell wird geladen' : 'Kein Modell geladen';
    setHidden(btn, s.status !== 'loading');
  }

  if (getMode() === 'client') {
    setEngineDot(s.status === 'ready' ? 'ok' : s.status === 'loading' ? 'busy' : s.status === 'error' ? 'warn' : 'off');
  }
}

/** @param {import('./webgpu/models.js').ModelChoice} choice */
function confirmDownload(choice) {
  const conn = /** @type {{ connection?: { saveData?: boolean } }} */ (/** @type {unknown} */ (navigator)).connection;
  const saveData = conn?.saveData ? '\n\nHinweis: Ihr Gerät hat den Datensparmodus aktiviert.' : '';
  return window.confirm(
    `Das lokale Modell „${choice.label}“ wird einmalig heruntergeladen (ca. ${choice.approxDownloadMB} MB) und im Browser gespeichert.${saveData}\n\nJetzt herunterladen?`,
  );
}

/** @param {import('./webgpu/engine.js').EngineError} err */
function errorNotice(err) {
  const msg = escapeMarkdown(err.message);
  if (err.kind === 'unsupported' || err.kind === 'no-adapter') {
    return `ℹ️ **Lokaler Modus nicht verfügbar:** ${msg}\n\nNutzen Sie Chrome oder Edge (Version 113 oder neuer) bzw. Safari 26 mit aktivierter GPU, oder wechseln Sie oben zum *Schnellen Assistenten* bzw. zu einem eigenen Server. Bis dahin antwortet Starpi direkt aus der Wissensdatenbank.`;
  }
  return `⚠️ **Lokales Modell konnte nicht geladen werden:** ${msg}\n\nSenden Sie Ihre Frage erneut, um es noch einmal zu versuchen. Bis dahin antwortet Starpi direkt aus der Wissensdatenbank.`;
}

/**
 * Loads the local model. Interactive loads may download (after confirmation); non-interactive
 * loads only use an already cached model.
 * @param {{ interactive: boolean }} opts
 * @returns {Promise<boolean>}
 */
export async function startLocalEngine(opts) {
  try {
    const ok = await engine.loadModel({
      preference: getModelPreference(),
      onlyIfCached: !opts.interactive,
      confirmDownload: opts.interactive ? confirmDownload : undefined,
    });
    const s = engine.getEngineState();
    if (ok && s.model && opts.interactive) {
      appendMessage(
        'assistant',
        `✅ **Lokaler Modus aktiv:** ${escapeMarkdown(s.model.label)}\n\n* Das Modell rechnet in Ihrem Browser auf der GPU.\n* Fragen und Chatverlauf bleiben auf diesem Gerät.`,
      );
    }
    return ok;
  } catch (err) {
    if (err instanceof engine.EngineError && err.kind !== 'cancelled') appendMessage('assistant', errorNotice(err));
    return false;
  }
}

export function initEngineUi() {
  engine.onEngineChange(render);
  render(engine.getEngineState());

  onAction('cancel-webgpu', async () => {
    await engine.unloadModel();
    appendMessage('assistant', 'ℹ️ **Laden abgebrochen.** Starpi antwortet weiter direkt aus der Wissensdatenbank. Sie können das Modell jederzeit mit der nächsten Frage erneut laden oder oben den Modus wechseln.');
  });

  onAction('unload-webgpu', async () => {
    const s = engine.getEngineState();
    const label = s.model?.label ?? 'Das lokale Modell';
    await engine.unloadModel();
    appendMessage('assistant', `🧹 **Arbeitsspeicher freigegeben:** ${escapeMarkdown(label)} wurde entladen und der GPU Speicher freigegeben.`);
  });
}

export { render as renderEngineState };
