// @ts-check
// Bench tab → Benchmark history: what the benchmark measured on this device over time, and what that
// means for the model recommendation. One card:
// - the recommendation from the measured runs (models/device.js recommendModels with the history):
//   the model recommended for this device, a step down when its pick decoded too slowly here, and a
//   larger model that ran fast here (suggested, never picked);
// - a bar chart of the median decode rate per model with the two thresholds, and a table with the
//   same numbers, the number of runs, a trend line of the latest runs and the first-token time;
// - JSON export of every stored run, and "Clear history".
//
// Loaded on demand with the Bench tab (bench-ui.js), together with the history store and the charts.
// Model names are literal, every other text is an i18n key.
import { downloadText, setHtml } from '../dom.js';
import { formatNumber, t } from '../i18n/index.js';
import * as history from '../models/bench-history.js';
import { CLASS_KEYS, classifyDevice, FAST_TOK_PER_SEC, recommendModels, SLOW_TOK_PER_SEC } from '../models/device.js';
import { barChart, sparkline } from '../ui/charts.js';
import { html, icon, label, labelText } from '../ui/kit.js';

/** @typedef {import('../models/bench-history.js').BenchEntry} BenchEntry */
/** @typedef {import('../models/bench-history.js').HistoryRow} HistoryRow */
/** @typedef {import('../models/device.js').HardwareProfile} HardwareProfile */
/** @typedef {import('../ui/kit.js').Label} Label */

/**
 * What the view reads and changes; the defaults are the app's own.
 * @typedef {object} HistoryDeps
 * @property {() => Promise<BenchEntry[]>} [readHistory]
 * @property {(entry: BenchEntry) => Promise<void>} [recordRun]
 * @property {() => Promise<void>} [clearHistory]
 * @property {(name: string, text: string, type: string) => void} [download]
 * @property {(message: string) => boolean} [confirm]
 * @property {(name: string, handler: (el: HTMLElement) => unknown) => void} onAction
 * @property {() => number} [now]
 * @property {Parameters<typeof history.browserLabel>[0]} [navigator] where the browser name comes from
 */

/** @param {number} value */
const rate = (value) => formatNumber(value, { maximumFractionDigits: 1 });

/**
 * Builds the card into `el` and wires its actions. Returns a handle for bench-ui.js and the tests.
 * @param {HTMLElement} el
 * @param {HistoryDeps} deps
 */
export function mountHistoryView(el, deps) {
  const read = deps.readHistory ?? (() => history.readHistory());
  const store = deps.recordRun ?? ((entry) => history.recordRun(entry));
  const clear = deps.clearHistory ?? (() => history.clearHistory());
  const download = deps.download ?? downloadText;
  const confirmAction = deps.confirm ?? ((/** @type {string} */ message) => globalThis.confirm?.(message) ?? false);
  const now = deps.now ?? Date.now;

  /** @type {BenchEntry[]} */
  let entries = [];
  /** @type {HardwareProfile | null} */
  let hw = null;
  /** @type {HistoryRow[]} */
  let shown = [];
  let drawnWidth = 0;

  /** @param {string} name */
  const part = (name) => /** @type {HTMLElement | null} */ (el.querySelector(`[data-bh="${name}"]`));

  /** @param {string} ref */
  const nameOf = (ref) => history.presetLabel(ref);

  function recommendationMarkup() {
    if (!hw) return '';
    const rec = recommendModels(hw, { history: entries });
    /** @type {import('../ui/kit.js').SafeHtml[]} */
    const lines = [
      html`<p class="flex items-start gap-1.5 text-sm text-slate-800" data-bh-local="${rec.local}">${icon('gauge', 'w-4 h-4 mt-0.5 flex-shrink-0 text-emerald-600')}${label({ key: 'diagnostics.history_recommended', params: { model: nameOf(rec.local) } })}</p>`,
    ];
    if (rec.stepDown) {
      lines.push(
        html`<p class="flex items-start gap-1.5 text-xs text-amber-800" data-bh-step-down="${rec.stepDown.from}">${icon('triangle-alert', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label({
          key: 'diagnostics.history_step_down',
          params: { model: nameOf(rec.stepDown.from), rate: rate(rec.stepDown.tokPerSec), slow: SLOW_TOK_PER_SEC },
        })}</p>`,
      );
    }
    if (rec.pro) {
      lines.push(
        html`<p class="flex items-start gap-1.5 text-xs text-slate-700" data-bh-suggest="${rec.pro}">${icon('lightbulb', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-600')}${label(
          rec.proTokPerSec === null
            ? { key: 'diagnostics.history_suggest_untested', params: { model: nameOf(rec.pro) } }
            : { key: 'diagnostics.history_suggest_fast', params: { model: nameOf(rec.pro), rate: rate(rec.proTokPerSec), fast: FAST_TOK_PER_SEC } },
        )}</p>`,
      );
    }
    return html`<div class="space-y-1.5">${lines}</div>`;
  }

  /** @param {HistoryRow[]} rows */
  function tableMarkup(rows) {
    const body = rows.map(
      (row) => html`<tr class="border-t border-slate-100" data-bh-row="${row.ref}">
        <th scope="row" class="py-2 pr-3 text-left font-medium text-slate-900">${row.label} <span class="block text-[11px] font-normal text-slate-500">${label(row.runtime === 'wasm' ? 'models.runtime_wasm' : 'models.runtime_webgpu')}</span></th>
        <td class="py-2 pr-3 text-right tabular-nums">${formatNumber(row.runs)}${row.failures ? html` <span class="text-[11px] text-rose-700">${label({ key: 'diagnostics.history_failed_runs', params: { n: row.failures } })}</span>` : ''}</td>
        <td class="py-2 pr-3 text-right font-semibold tabular-nums">${rate(row.tokPerSec)}</td>
        <td class="py-2 pr-3" data-bh-trend="${row.ref}"></td>
        <td class="py-2 text-right tabular-nums">${row.ttftMs === null ? '–' : `${formatNumber(row.ttftMs)} ms`}</td>
      </tr>`,
    );
    return html`<div class="overflow-x-auto"><table class="w-full text-xs text-slate-700">
      <caption class="sr-only">${label('diagnostics.history_table_caption')}</caption>
      <thead class="text-[11px] text-slate-500"><tr>
        <th scope="col" class="pb-1.5 pr-3 text-left font-medium">${label('diagnostics.history_col_model')}</th>
        <th scope="col" class="pb-1.5 pr-3 text-right font-medium">${label('diagnostics.history_col_runs')}</th>
        <th scope="col" class="pb-1.5 pr-3 text-right font-medium">${label('diagnostics.history_col_median')}</th>
        <th scope="col" class="pb-1.5 pr-3 text-left font-medium">${label('diagnostics.history_col_trend')}</th>
        <th scope="col" class="pb-1.5 text-right font-medium">${label('diagnostics.history_col_ttft')}</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  /** The device class the view shows: the probed one, else the class of the latest run. */
  function deviceClass() {
    if (hw) return classifyDevice(hw);
    return entries.length ? entries[entries.length - 1].deviceClass : null;
  }

  function render() {
    const cls = deviceClass();
    const rows = cls ? history.historyRows(entries, cls) : [];
    const others = entries.length - rows.reduce((n, r) => n + r.runs, 0);
    const badge = cls && Object.hasOwn(CLASS_KEYS, cls) ? html`<span class="badge badge-muted">${label(CLASS_KEYS[/** @type {keyof typeof CLASS_KEYS} */ (cls)])}</span>` : '';
    setHtml(
      el,
      html`<div class="card p-4 sm:p-5 space-y-4" data-bh-root data-runs="${entries.length}">
        <div class="card-header">
          <h3 class="card-title">${icon('activity', 'w-4 h-4 text-emerald-600')}${label('diagnostics.history_title')}</h3>
          ${badge}
        </div>
        ${label('diagnostics.history_subtitle', { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed -mt-2' })}
        <div data-bh="recommendation">${recommendationMarkup()}</div>
        ${
          rows.length
            ? html`<figure class="space-y-1.5">
                <figcaption class="text-[11px] text-slate-500">${label({ key: 'diagnostics.history_chart_caption', params: { slow: SLOW_TOK_PER_SEC, fast: FAST_TOK_PER_SEC } })}</figcaption>
                <div data-bh="chart" class="w-full"></div>
              </figure>
              <div data-bh="table">${tableMarkup(rows)}</div>`
            : label('diagnostics.history_empty', { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })
        }
        ${others > 0 ? label({ key: 'diagnostics.history_other_class', params: { n: others } }, { tag: 'p', className: 'text-[11px] text-slate-500' }) : ''}
        <div class="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-end gap-2">
          <button type="button" class="btn btn-ghost" data-action="bench-history-clear"${entries.length ? '' : html` disabled`}>${icon('trash-2', 'w-3.5 h-3.5')}${label('diagnostics.history_clear')}</button>
          <button type="button" class="btn btn-secondary" data-action="bench-history-export"${entries.length ? '' : html` disabled`}>${icon('download', 'w-3.5 h-3.5')}${label('diagnostics.history_export')}</button>
        </div>
        <p class="text-xs min-w-0" role="status" aria-live="polite" data-bh="result"></p>
      </div>`.value,
    );
    drawCharts(rows);
  }

  /** @param {HistoryRow[]} rows */
  function drawCharts(rows) {
    shown = rows;
    const host = part('chart');
    if (!host || rows.length === 0) return;
    // Drawn at the width it gets; a hidden tab has none yet and is redrawn when it is shown.
    drawnWidth = host.clientWidth;
    const width = drawnWidth || el.clientWidth || 560;
    const unit = t('diagnostics.history_unit');
    host.replaceChildren(
      barChart(
        rows.map((r) => ({ label: r.label, value: r.tokPerSec, valueText: `${rate(r.tokPerSec)} ${unit}` })),
        {
          width,
          label: t('diagnostics.history_chart_label'),
          marks: [
            { value: SLOW_TOK_PER_SEC, label: `${SLOW_TOK_PER_SEC} ${unit}` },
            { value: FAST_TOK_PER_SEC, label: `${FAST_TOK_PER_SEC} ${unit}` },
          ],
        },
      ),
    );
    // One scale for every trend line, so their heights compare like the bars do.
    const top = Math.max(...rows.flatMap((r) => r.trend), FAST_TOK_PER_SEC);
    const byRef = new Map(rows.map((r) => [r.ref, r]));
    for (const cell of el.querySelectorAll('[data-bh-trend]')) {
      const row = byRef.get(cell.getAttribute('data-bh-trend') ?? '');
      if (!row) continue;
      cell.replaceChildren(sparkline(row.trend, { label: t('diagnostics.history_trend_label', { model: row.label, rates: row.trend.map(rate).join(', '), unit }), max: top }));
    }
  }

  /**
   * @param {Label} text
   * @param {'ok' | 'danger'} tone
   */
  function report(text, tone) {
    const target = part('result');
    if (target) setHtml(target, String(html`<span class="flex items-start gap-1.5" data-tone="${tone}">${icon(tone === 'ok' ? 'check-circle-2' : 'triangle-alert', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(text)}</span>`));
  }

  async function refresh() {
    try {
      entries = await read();
    } catch {
      entries = [];
    }
    render();
  }

  deps.onAction('bench-history-export', () => {
    if (entries.length === 0) return;
    const at = now();
    download(history.exportFileName(at), history.exportHistory(entries, at), 'application/json');
    report({ key: 'diagnostics.history_exported', params: { n: entries.length } }, 'ok');
  });
  deps.onAction('bench-history-clear', async () => {
    if (entries.length === 0 || !confirmAction(labelText('diagnostics.history_clear_confirm'))) return;
    try {
      await clear();
      await refresh();
      report('diagnostics.history_cleared', 'ok');
    } catch {
      report('diagnostics.history_storage_error', 'danger');
    }
  });

  render();
  const loaded = refresh();
  // The chart is drawn in pixels: redraw it when its width changes (a rotated phone, a shown tab).
  const resize =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const width = part('chart')?.clientWidth ?? 0;
          if (width && Math.abs(width - drawnWidth) > 16) drawCharts(shown);
        })
      : null;
  resize?.observe(el);

  return {
    /** Resolves when the stored runs have been read. */
    loaded,
    refresh,
    /** Re-renders, e.g. after a language change (numbers and chart labels follow the language). */
    render,
    /** @param {HardwareProfile | null} profile the probed device, for the recommendation */
    setDevice(profile) {
      hw = profile;
      render();
    },
    /**
     * Stores a measured (or failed) benchmark run and shows it.
     * @param {{ model: import('../webgpu/models.js').ModelChoice, metrics: import('./diagnostics.js').BenchmarkMetrics | null, loadMs: number | null }} result
     */
    async record(result) {
      const entry = history.benchEntry({
        model: result.model,
        metrics: result.metrics,
        loadMs: result.loadMs,
        deviceClass: result.model.deviceClass ?? deviceClass() ?? 'unknown',
        browser: history.browserLabel(deps.navigator ?? globalThis.navigator ?? {}),
        at: now(),
      });
      try {
        await store(entry);
      } catch {
        report('diagnostics.history_storage_error', 'danger');
        return;
      }
      await refresh();
    },
  };
}
