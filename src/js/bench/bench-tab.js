// @ts-check
// Diagnostics & Benchmark tab: WebGPU adapter properties, a real inference benchmark on the
// on-device model (time to first token and decode throughput measured on actual generation) and the
// history of those runs (history-view.js). Without WebGPU the benchmark measures a processor (WASM)
// model. Loaded by bench-ui.js when the tab first opens or the benchmark is started, so this module,
// the history store and the charts stay out of the app's first load.
import { byId, onAction, setHidden } from '../dom.js';
import { refreshIcons } from '../icons.js';
import { formatNumber, setText } from '../i18n/index.js';
import * as engine from '../webgpu/engine.js';
import { BYTE_LIMITS, formatBytes } from './diagnostics.js';
import { mountHistoryView } from './history-view.js';
import { benchRuntime, measureModel } from './measure.js';

const OUTPUT_TOKENS = 128;
let running = false;
/** @type {Awaited<ReturnType<typeof engine.probeWebGPU>> | null} */
let lastProbe = null;
/** @type {import('../models/device.js').HardwareProfile | null} */
let lastHw = null;
/** @type {ReturnType<typeof mountHistoryView> | null} */
let historyView = null;

/** The history card, mounted on first use (null without its container). */
function openHistory() {
  const host = byId('benchHistory');
  if (!historyView && host) historyView = mountHistoryView(host, { onAction });
  return historyView;
}

/**
 * @param {string} id
 * @param {string} value
 */
function setValue(id, value) {
  const el = byId(id);
  if (el) el.textContent = value || '–';
}

/**
 * @param {'ok' | 'warn' | 'muted'} tone
 * @param {string} key
 */
function setStatusBadge(tone, key) {
  const badge = byId('benchWebgpuBadge');
  if (!badge) return;
  badge.className = `badge badge-${tone}`;
  setText(byId('benchWebgpuStatusText'), key);
}

function renderLimits() {
  const box = byId('benchLimitsContainer');
  if (!box || !lastProbe?.supported) return;
  const rows = Object.entries(lastProbe.adapter.limits).map(([name, value]) => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-3 py-1.5 border-b border-slate-100 last:border-0';
    const label = document.createElement('span');
    label.className = 'text-slate-500 font-mono';
    label.textContent = name;
    const val = document.createElement('span');
    val.className = 'font-semibold text-slate-900 font-mono';
    val.textContent = BYTE_LIMITS.has(name) ? formatBytes(value, formatNumber) : formatNumber(value);
    row.append(label, val);
    return row;
  });
  box.replaceChildren(...rows);
}

export function renderRunner() {
  const btn = /** @type {HTMLButtonElement | null} */ (byId('btnRunBenchmark'));
  const label = byId('benchRunLabel');
  const hint = byId('benchModelHint');
  // Without WebGPU the benchmark measures a processor (WASM) model; nothing runs without WebAssembly.
  const runtime = lastProbe ? benchRuntime(lastProbe) : null;
  const s = engine.getEngineState();
  if (btn) btn.disabled = running || !runtime;
  if (running) setText(label, 'diagnostics.running');
  else setText(label, s.status === 'ready' ? 'diagnostics.run' : 'diagnostics.load_and_run');
  if (!runtime) setText(hint, lastProbe ? 'diagnostics.hint_unsupported' : 'diagnostics.checking');
  else if (s.status === 'ready' && s.model) setText(hint, 'diagnostics.hint_ready', { model: s.model.modelId });
  else setText(hint, runtime === 'wasm' ? 'diagnostics.hint_load_wasm' : 'diagnostics.hint_load');
}

/** Reads the adapter, fills the hardware card and shows the history for this device. */
export async function refreshDiagnostics() {
  const { webgpu: probe, hw } = await engine.probeDevice();
  lastProbe = probe;
  lastHw = hw;
  openHistory()?.setDevice(lastHw);
  const nav = /** @type {Navigator & { deviceMemory?: number }} */ (navigator);
  const cores = nav.hardwareConcurrency ? formatNumber(nav.hardwareConcurrency) : '–';
  if (nav.deviceMemory) setText(byId('benchMemory'), 'diagnostics.memory_value', { gb: formatNumber(nav.deviceMemory), cores });
  else setText(byId('benchMemory'), 'diagnostics.cores_value', { cores });

  if (probe.supported) {
    const info = probe.adapter.info;
    setValue('benchVendor', info.vendor);
    setValue('benchArch', info.architecture);
    setValue('benchDevice', info.description || info.device);
    setText(byId('benchF16'), probe.hw.hasF16 ? 'diagnostics.f16_yes' : 'diagnostics.f16_no');
    setValue('benchFeatures', probe.adapter.features.join(', '));
    setStatusBadge('ok', 'diagnostics.webgpu_available');
  } else {
    for (const id of ['benchVendor', 'benchArch', 'benchDevice', 'benchFeatures']) setValue(id, '');
    setText(byId('benchF16'), 'diagnostics.not_available');
    setStatusBadge('warn', probe.error.kind === 'unsupported' ? 'diagnostics.webgpu_unsupported' : 'diagnostics.webgpu_no_adapter');
    byId('benchLimitsContainer')?.replaceChildren();
  }
  renderLimits();
  renderRunner();
}

/**
 * @param {number} done
 * @param {number} total
 * @param {string} key
 */
function showProgress(done, total, key) {
  setHidden(byId('benchProgressCard'), false);
  setText(byId('benchProgressText'), key, { done, total });
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const bar = byId('benchProgressBar');
  if (bar) bar.style.width = `${pct}%`;
  setValue('benchProgressPercent', `${pct}%`);
}

/**
 * Runs the benchmark on the selected model, loading it first when needed. The chat and the engine UI
 * come from the app (bench-ui.js), so this chunk does not carry them.
 * @param {{ isChatBusy: () => boolean, startLocalEngine: (opts: { interactive: boolean }) => Promise<boolean> }} app
 */
export async function executeBenchmark(app) {
  if (running) return;
  if (app.isChatBusy()) {
    setText(byId('benchModelHint'), 'diagnostics.hint_busy');
    return;
  }
  running = true;
  renderRunner();
  try {
    const result = await measureModel(engine, {
      load: () => app.startLocalEngine({ interactive: true }),
      outputTokens: OUTPUT_TOKENS,
      onPhase: (phase, done, total) => showProgress(done, total, `diagnostics.phase_${phase}`),
    });
    if (result.model && result.recordable) void openHistory()?.record({ model: result.model, metrics: result.metrics, loadMs: result.loadMs });
    if (result.status === 'declined') return;
    if (result.status === 'failed') throw result.error;
    const run = /** @type {import('../webgpu/engine.js').BenchmarkRun} */ (result.run);
    const m = /** @type {import('./diagnostics.js').BenchmarkMetrics} */ (result.metrics);
    setValue('benchResultTTFT', `${formatNumber(m.ttftMs, { maximumFractionDigits: 0 })} ms`);
    setValue('benchResultTPS', `${formatNumber(m.decodeTokensPerSec, { maximumFractionDigits: 1 })} tok/s`);
    setValue('benchResultPrefill', m.prefillTokensPerSec === null ? '–' : `${formatNumber(m.prefillTokensPerSec, { maximumFractionDigits: 1 })} tok/s`);
    setValue('benchResultLatency', `${formatNumber(m.totalMs, { maximumFractionDigits: 0 })} ms`);
    setText(byId('benchResultMeta'), 'diagnostics.result_meta', {
      model: run.modelId,
      // A processor model runs its own quantization (q8) on WASM, not a WebGPU precision.
      precision: run.runtime === 'wasm' ? 'WASM' : run.f16 ? 'f16' : 'f32',
      prompt: formatNumber(m.promptTokens),
      output: formatNumber(m.completionTokens),
    });
    showProgress(OUTPUT_TOKENS, OUTPUT_TOKENS, 'diagnostics.phase_done');
  } catch (err) {
    const kind = err instanceof engine.EngineError ? err.kind : 'unknown';
    setHidden(byId('benchProgressCard'), false);
    setText(byId('benchProgressText'), `engine.error.${kind}`, { reason: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
    renderRunner();
  }
}

/** After a language change: adapter limits and the history's numbers and chart labels follow it. */
export function onLocale() {
  renderLimits();
  historyView?.render();
  refreshIcons(byId('tab-bench') ?? document);
}
