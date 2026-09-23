// @ts-check
// Binds the WebGPU engine state machine to the UI (progress banner, VRAM badge, status dot) and
// provides the user-facing load/cancel/unload actions. Failures never switch the user to a cloud
// provider silently: local mode keeps answering from the knowledge base until the user decides.
import { byId, onAction, setHidden } from './dom.js';
import { formatNumber, onLocaleChange, setText, t } from './i18n/index.js';
import { appendNotice } from './messages.js';
import { getMode, getModelPreference } from './state.js';
import { setEngineDot } from './ui.js';
import * as engine from './webgpu/engine.js';

/** @param {import('./webgpu/engine.js').EngineState} s */
function render(s) {
  const banner = byId('webgpuProgressContainer');
  setHidden(banner, s.status !== 'loading');
  if (s.status === 'loading') {
    const phase = s.progress?.phase ?? 'init';
    setText(byId('webgpuProgressText'), `engine.progress.${phase}`, { model: s.model?.label ?? '' });
    const percent = byId('webgpuPercentText');
    if (percent) percent.textContent = `${formatNumber(Math.round((s.progress?.progress ?? 0) * 100))}%`;
  }

  setHidden(byId('localMemoryControls'), !(getMode() === 'client' || s.status === 'ready' || s.status === 'loading'));
  const dot = byId('vramStatusDot');
  const text = byId('vramStatusText');
  const btn = byId('btnUnloadWebgpu');
  if (s.status === 'ready' && s.model) {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
    const key = s.model.vramMB ? 'engine.vram_ready' : 'engine.vram_ready_no_size';
    setText(text, key, {
      model: s.model.label,
      precision: s.model.f16 ? 'f16' : 'f32',
      gb: s.model.vramMB ? formatNumber(s.model.vramMB / 1024, { maximumFractionDigits: 1 }) : '',
    });
    setHidden(btn, false);
  } else {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-slate-400';
    setText(text, s.status === 'loading' ? 'engine.vram_loading' : 'engine.vram_none');
    setHidden(btn, s.status !== 'loading');
  }

  if (getMode() === 'client') {
    setEngineDot(s.status === 'ready' ? 'ok' : s.status === 'loading' ? 'busy' : s.status === 'error' ? 'warn' : 'off');
  }
}

/** @param {import('./webgpu/models.js').ModelChoice} choice */
function confirmDownload(choice) {
  const conn = /** @type {{ connection?: { saveData?: boolean } }} */ (/** @type {unknown} */ (navigator)).connection;
  const message = t('engine.confirm_download', { model: choice.label, mb: formatNumber(choice.approxDownloadMB) });
  return window.confirm(conn?.saveData ? `${message}\n\n${t('engine.confirm_save_data')}` : message);
}

/** @param {import('./webgpu/engine.js').EngineError} err */
function errorNotice(err) {
  const unsupported = err.kind === 'unsupported' || err.kind === 'no-adapter';
  appendNotice({
    icon: unsupported ? 'info' : 'triangle-alert',
    tone: unsupported ? 'info' : 'warn',
    title: unsupported ? 'engine.notice_unavailable_title' : 'engine.notice_failed_title',
    body: `engine.error.${err.kind}`,
    params: { reason: err.message, ...err.details },
  });
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
      appendNotice({ icon: 'check-circle', tone: 'success', title: 'engine.notice_ready_title', body: 'engine.notice_ready_body', params: { model: s.model.label } });
    }
    return ok;
  } catch (err) {
    if (err instanceof engine.EngineError && err.kind !== 'cancelled') errorNotice(err);
    return false;
  }
}

export function initEngineUi() {
  engine.onEngineChange(render);
  onLocaleChange(() => render(engine.getEngineState()));
  render(engine.getEngineState());

  onAction('cancel-webgpu', async () => {
    await engine.unloadModel();
    appendNotice({ icon: 'info', tone: 'info', title: 'engine.notice_cancelled_title', body: 'engine.notice_cancelled_body' });
  });

  onAction('unload-webgpu', async () => {
    const label = engine.getEngineState().model?.label ?? t('engine.model_generic');
    await engine.unloadModel();
    appendNotice({ icon: 'trash-2', tone: 'info', title: 'engine.notice_unloaded_title', body: 'engine.notice_unloaded_body', params: { model: label } });
  });
}

export { render as renderEngineState };
