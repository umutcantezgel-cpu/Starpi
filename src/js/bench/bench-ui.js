// @ts-check
// UI controller for the Hardware Diagnostics & Benchmark panel.
import { byId, onAction, setHidden } from '../dom.js';
import { t } from '../i18n/index.js';
import { queryHardwareProfile, runStandardBenchmark } from './diagnostics.js';

/**
 * Initializes the Diagnostics & Benchmark UI and actions.
 */
export function initBenchUi() {
  onAction('run-benchmark', () => void executeBenchmark());
}

/**
 * Refreshes the hardware diagnostics cards.
 */
export async function refreshDiagnostics() {
  const profile = await queryHardwareProfile();

  const vendorEl = byId('benchVendor');
  if (vendorEl) vendorEl.textContent = profile.vendor;

  const archEl = byId('benchArch');
  if (archEl) archEl.textContent = profile.architecture;

  const f16El = byId('benchF16');
  if (f16El) {
    f16El.textContent = profile.hasF16 ? t('bench.f16_supported') : t('bench.f16_unsupported');
    f16El.className = `font-semibold text-sm ${profile.hasF16 ? 'text-emerald-700' : 'text-amber-700'}`;
  }

  const memEl = byId('benchMemory');
  if (memEl) {
    memEl.textContent = profile.deviceMemoryGB ? `${profile.deviceMemoryGB} GB RAM (${profile.cpuCores} CPU Cores)` : `${profile.cpuCores} CPU Cores`;
  }

  const dot = byId('benchWebgpuDot');
  const text = byId('benchWebgpuStatusText');
  const badge = byId('benchWebgpuBadge');

  if (profile.webgpuAvailable) {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
    if (text) text.textContent = t('bench.webgpu_available');
    if (badge) badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 flex items-center gap-1';
  } else {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-400';
    if (text) text.textContent = t('bench.webgpu_unavailable');
    if (badge) badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1';
  }

  const limitsContainer = byId('benchLimitsContainer');
  if (limitsContainer) {
    limitsContainer.replaceChildren();
    for (const [key, val] of Object.entries(profile.limits)) {
      const row = document.createElement('div');
      row.className = 'flex justify-between py-1 border-b border-slate-100 last:border-0';
      const label = document.createElement('span');
      label.className = 'text-slate-500';
      label.textContent = key;
      const value = document.createElement('span');
      value.className = 'font-bold text-slate-800';
      value.textContent = String(val);
      row.append(label, value);
      limitsContainer.appendChild(row);
    }
  }
}

/**
 * Runs the standardized hardware benchmark and displays performance results.
 */
export async function executeBenchmark() {
  const btn = /** @type {HTMLButtonElement | null} */ (byId('btnRunBenchmark'));
  const progressCard = byId('benchProgressCard');
  const progressText = byId('benchProgressText');
  const progressBar = byId('benchProgressBar');
  const progressPercent = byId('benchProgressPercent');

  if (btn) btn.disabled = true;
  setHidden(progressCard, false);

  try {
    const result = await runStandardBenchmark(({ stage, percent }) => {
      if (progressText) progressText.textContent = stage;
      if (progressPercent) progressPercent.textContent = `${percent}%`;
      if (progressBar) progressBar.style.width = `${percent}%`;
    });

    const ttftEl = byId('benchResultTTFT');
    if (ttftEl) ttftEl.textContent = `${result.ttftMs} ms`;

    const tpsEl = byId('benchResultTPS');
    if (tpsEl) tpsEl.textContent = `${result.tokensPerSec} tok/s`;

    const latencyEl = byId('benchResultLatency');
    if (latencyEl) latencyEl.textContent = `${result.totalLatencyMs} ms`;

    if (progressText) progressText.textContent = t('bench.status_complete');
  } catch (err) {
    if (progressText) progressText.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => {
      setHidden(progressCard, true);
    }, 4000);
  }
}
