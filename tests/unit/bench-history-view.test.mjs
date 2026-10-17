// Bench tab → Benchmark history in a DOM (src/js/bench/history-view.js) and its charts
// (src/js/ui/charts.js): a seeded history changes the recommendation shown for the device, the chart
// and the table show the median rate per model, the JSON export holds every run, "Clear history"
// asks first, the charts are CSP-safe SVG (classes only, no inline styles) with accessible names, and
// every text exists in English and German.
/* global document */
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'SVGElement', 'NodeFilter', 'Text', 'localStorage', 'location'];

/** @type {typeof import('../../src/js/bench/history-view.js')} */
let view;
/** @type {typeof import('../../src/js/models/bench-history.js')} */
let history;
/** @type {typeof import('../../src/js/ui/charts.js')} */
let charts;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;
/** @type {typeof import('../../src/js/i18n/index.js')} */
let i18n;
/** @type {typeof import('../../src/js/store/schema.js')} */
let schema;
/** @type {typeof import('../../src/js/webgpu/models.js')} */
let models;

before(async () => {
  const jsdom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example/' });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  view = await import('../../src/js/bench/history-view.js');
  history = await import('../../src/js/models/bench-history.js');
  charts = await import('../../src/js/ui/charts.js');
  i18n = await import('../../src/js/i18n/index.js');
  schema = await import('../../src/js/store/schema.js');
  models = await import('../../src/js/webgpu/models.js');
});

after(() => {
  for (const key of GLOBALS) delete (/** @type {any} */ (globalThis))[key];
});

afterEach(() => {
  document.querySelectorAll('[data-test-host]').forEach((el) => el.remove());
});

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const GIB = 1024 ** 3;
const desktop = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 2 * GIB, hasF16: true };

let seq = 0;
let at = 0;

/**
 * @param {string} pref
 * @param {number | null} decode
 */
function runOf(pref, decode) {
  const model = models.chooseModel(desktop, pref);
  const metrics = decode === null ? null : { ttftMs: 250, decodeTokensPerSec: decode, totalMs: 4000, promptTokens: 64, completionTokens: 128, prefillTokensPerSec: null };
  return history.benchEntry({ model, metrics, deviceClass: model.deviceClass, browser: 'Chrome 141', loadMs: null, at: (at += 1) });
}

/** Mounts the view over a database of its own, with the given runs stored. */
async function mount(/** @type {{ runs?: any[], confirm?: boolean }} */ opts = {}) {
  const db = await schema.openAppDb({ name: `bench-view-${(seq += 1)}`, factory: new IDBFactory() });
  const getDb = async () => db;
  for (const run of opts.runs ?? []) await history.recordRun(run, getDb);
  const downloads = /** @type {Array<{ name: string, text: string, type: string }>} */ ([]);
  const confirmations = { asked: /** @type {string[]} */ ([]), answer: opts.confirm ?? true };
  const host = document.createElement('div');
  host.dataset.testHost = '';
  document.body.append(host);
  const handle = view.mountHistoryView(host, {
    onAction: dom.onAction,
    readHistory: () => history.readHistory(getDb),
    recordRun: (entry) => history.recordRun(entry, getDb),
    clearHistory: () => history.clearHistory(getDb),
    download: (name, text, type) => downloads.push({ name, text, type }),
    confirm: (message) => (confirmations.asked.push(message), confirmations.answer),
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' },
    now: () => Date.UTC(2026, 9, 17, 9),
  });
  await handle.loaded;
  handle.setDevice(desktop);
  /** @param {string} selector */
  const q = (selector) => /** @type {HTMLElement | null} */ (host.querySelector(selector));
  /** @param {string} action */
  const click = async (action) => {
    const button = /** @type {HTMLButtonElement | null} */ (host.querySelector(`[data-action="${action}"]`));
    assert.ok(button, action);
    button.click();
    await settle();
  };
  return { host, db, getDb, q, click, downloads, confirmations, handle };
}

describe('Bench tab → Benchmark history', () => {
  it('explains that nothing was measured yet, and offers nothing to export', async () => {
    const { q } = await mount();
    assert.match(q('[data-bh-root]')?.textContent ?? '', /No runs yet/);
    assert.match(q('[data-bh="recommendation"]')?.textContent ?? '', /Recommended for this device: Qwen 2\.5 3B/);
    assert.equal(/** @type {HTMLButtonElement} */ (q('[data-action="bench-history-export"]')).disabled, true);
    assert.equal(q('[data-bh="chart"]'), null, 'no chart without runs');
  });

  it('changes the recommendation when the seeded history is slow, and suggests a fast larger model', async () => {
    const { q } = await mount({ runs: [runOf('auto', 4.2), runOf('auto', 5), runOf('auto', 6.5), runOf('webgpu:llama-8b', 24)] });
    const rec = q('[data-bh="recommendation"]');
    assert.equal(q('[data-bh-local]')?.dataset.bhLocal, 'webgpu:qwen-1.5b');
    assert.match(rec?.textContent ?? '', /Recommended for this device: Qwen 2\.5 1\.5B/);
    assert.match(rec?.textContent ?? '', /Qwen 2\.5 3B measured 5 tok\/s here, below 8 tok\/s/);
    assert.equal(q('[data-bh-suggest]')?.dataset.bhSuggest, 'webgpu:llama-8b');
    assert.match(rec?.textContent ?? '', /Llama 3\.1 8B measured 24 tok\/s here, above 20 tok\/s: worth trying/);
  });

  it('charts the median rate per model and lists the same numbers in a table', async () => {
    const { q, host } = await mount({ runs: [runOf('auto', 12), runOf('auto', 14), runOf('auto', null), runOf('webgpu:llama-1b', 31)] });
    const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (q('[data-bh="chart"] svg')));
    assert.ok(svg, 'bar chart');
    assert.equal(svg.getAttribute('role'), 'img');
    assert.match(svg.getAttribute('aria-label') ?? '', /Median decode rate per model/);
    const bars = [...svg.querySelectorAll('g[data-bar]')];
    assert.deepEqual(
      bars.map((g) => g.querySelector('title')?.textContent),
      ['Llama 3.2 1B: 31 tok/s', 'Qwen 2.5 3B: 12 tok/s'],
      'fastest first; the failed run counts as 0 in the median of 12, 14 and 0',
    );
    assert.deepEqual(
      [...svg.querySelectorAll(':scope > text')].map((t) => t.textContent),
      ['8 tok/s', '20 tok/s'],
      'the two thresholds',
    );
    const rows = [...host.querySelectorAll('[data-bh-row]')];
    assert.deepEqual(
      rows.map((r) => /** @type {HTMLElement} */ (r).dataset.bhRow),
      ['webgpu:llama-1b', 'webgpu:qwen-3b'],
    );
    assert.match(rows[1].textContent ?? '', /Qwen 2\.5 3B.*GPU \(WebGPU\).*3 \(1 failed\).*12.*250 ms/s);
    const trend = rows[1].querySelector('[data-bh-trend] svg');
    assert.ok(trend, 'trend line');
    assert.match(trend.getAttribute('aria-label') ?? '', /latest runs of Qwen 2\.5 3B: 12, 14, 0 tok\/s/);
    assert.equal(host.querySelector('table caption')?.textContent, 'Measured runs per model');
  });

  it('records a measured run and shows it at once', async () => {
    const { q, handle, getDb } = await mount();
    await handle.record({ model: models.chooseModel(desktop, 'auto'), metrics: { ttftMs: 410, decodeTokensPerSec: 9.4, totalMs: 14_000, promptTokens: 64, completionTokens: 128, prefillTokensPerSec: null }, loadMs: 2200 });
    const runs = await history.readHistory(getDb);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].browser, 'Firefox 140');
    assert.equal(runs[0].deviceClass, 'desktop');
    assert.equal(runs[0].loadMs, 2200);
    assert.equal(runs[0].at, Date.UTC(2026, 9, 17, 9));
    assert.equal(q('[data-bh-root]')?.dataset.runs, '1');
    assert.ok(q('[data-bh-row="webgpu:qwen-3b"]'));
  });

  it('exports every run as JSON', async () => {
    const { click, downloads, q } = await mount({ runs: [runOf('auto', 12), { ...runOf('auto', 3), deviceClass: 'laptop' }] });
    assert.match(q('[data-bh-root]')?.textContent ?? '', /1 run from another device class is kept in the export/);
    await click('bench-history-export');
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].name, 'starpi-bench-history-2026-10-17.json');
    assert.equal(downloads[0].type, 'application/json');
    const parsed = JSON.parse(downloads[0].text);
    assert.equal(parsed.format, history.EXPORT_FORMAT);
    assert.equal(parsed.runs.length, 2);
    assert.match(q('[data-bh="result"]')?.textContent ?? '', /Exported 2 runs/);
  });

  it('clears the history only after confirming', async () => {
    const declined = await mount({ runs: [runOf('auto', 12)], confirm: false });
    await declined.click('bench-history-clear');
    assert.equal(declined.confirmations.asked.length, 1);
    assert.match(declined.confirmations.asked[0], /Delete every saved benchmark run/);
    assert.equal((await history.readHistory(declined.getDb)).length, 1);

    const accepted = await mount({ runs: [runOf('auto', 12)] });
    await accepted.click('bench-history-clear');
    assert.equal((await history.readHistory(accepted.getDb)).length, 0);
    assert.match(accepted.q('[data-bh-root]')?.textContent ?? '', /No runs yet/);
    assert.match(accepted.q('[data-bh="result"]')?.textContent ?? '', /was deleted/);
  });

  it('reports a history that cannot be stored', async () => {
    const host = document.createElement('div');
    host.dataset.testHost = '';
    document.body.append(host);
    const handle = view.mountHistoryView(host, {
      onAction: dom.onAction,
      readHistory: async () => [],
      recordRun: async () => {
        throw new Error('quota');
      },
    });
    await handle.loaded;
    await handle.record({ model: models.chooseModel(desktop, 'auto'), metrics: null, loadMs: null });
    assert.match(host.querySelector('[data-bh="result"]')?.textContent ?? '', /could not be saved or read/);
  });

  it('uses only keys that exist in English and German, and renders in German', async () => {
    const { host, handle } = await mount({ runs: [runOf('auto', 5), runOf('webgpu:llama-8b', 24), { ...runOf('auto', 3), deviceClass: 'laptop' }, runOf('auto', null)] });
    const keys = new Set([...host.querySelectorAll('[data-i18n]')].map((el) => el.getAttribute('data-i18n') ?? ''));
    for (const k of ['history_chart_label', 'history_unit', 'history_trend_label', 'history_clear_confirm', 'history_exported', 'history_cleared', 'history_storage_error', 'history_empty', 'history_suggest_untested', 'hint_load_wasm', 'hint_unsupported']) {
      keys.add(`diagnostics.${k}`);
    }
    keys.delete('');
    await i18n.loadLocale('de');
    assert.deepEqual([...keys].filter((k) => !i18n.hasKey(k, 'en') || !i18n.hasKey(k, 'de')), []);
    await i18n.setLocale('de');
    try {
      handle.render();
      assert.match(host.textContent ?? '', /Benchmark-Verlauf/);
      assert.match(host.textContent ?? '', /Empfohlen für dieses Gerät/);
      assert.match(host.textContent ?? '', /1 Lauf aus einer anderen Geräteklasse bleibt im Export erhalten/);
      assert.match(host.querySelector('[data-bh="chart"] svg')?.getAttribute('aria-label') ?? '', /Token pro Sekunde/);
    } finally {
      await i18n.setLocale('en');
    }
  });
});

describe('charts', () => {
  it('draw bars as classed SVG without inline styles, scaled to a round maximum', () => {
    const svg = charts.barChart(
      [
        { label: 'A model with a very long name that will not fit the label column', value: 30, valueText: '30 tok/s' },
        { label: 'B', value: 0, valueText: '0 tok/s' },
        { label: 'C', value: Number.NaN, valueText: '–' },
      ],
      { width: 400, label: 'Rates', marks: [{ value: 8, label: '8' }, { value: 20, label: '20' }] },
    );
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('width'), '400');
    assert.equal(svg.getAttribute('aria-label'), 'Rates');
    for (const node of [svg, ...svg.querySelectorAll('*')]) assert.equal(node.getAttribute('style'), null, node.tagName);
    const paths = svg.querySelectorAll('path');
    assert.equal(paths.length, 1, 'no bar for 0 or a missing value');
    assert.equal(paths[0].getAttribute('class'), 'fill-emerald-600');
    const label = svg.querySelector('g[data-bar="0"] text')?.textContent ?? '';
    assert.ok(label.endsWith('…') && label.length < 40, label);
    assert.equal(svg.querySelector('g[data-bar="0"] title')?.textContent, 'A model with a very long name that will not fit the label column: 30 tok/s');
    // Narrow containers still get a usable chart.
    assert.equal(charts.barChart([], { width: 100, label: 'x' }).getAttribute('width'), '240');
  });

  it('round the scale and the bar ends', () => {
    assert.deepEqual([0, 0.4, 1, 3, 8, 21, 33, 260].map(charts.niceMax), [1, 0.5, 1, 5, 10, 25, 50, 500]);
    assert.equal(charts.barPath(10, 0, 0, 14), '');
    assert.match(charts.barPath(10, 0, 100, 14), /^M10 0H106A4 4 0 0 1 110 4V10A4 4 0 0 1 106 14H10Z$/);
    // A bar shorter than the radius stays a valid shape.
    assert.match(charts.barPath(10, 0, 2, 14), /^M10 0H10A2 2/);
  });

  it('draw a sparkline with a dot on the latest value', () => {
    const svg = charts.sparkline([2, 4, 3], { label: 'Trend', width: 100, height: 30 });
    assert.equal(svg.getAttribute('aria-label'), 'Trend');
    const path = svg.querySelector('path');
    assert.ok(path);
    assert.equal(path.getAttribute('stroke-width'), '2');
    assert.equal(path.getAttribute('class'), 'fill-none stroke-emerald-600');
    const dot = svg.querySelector('circle');
    assert.equal(dot?.getAttribute('cx'), '94');
    assert.equal(dot?.getAttribute('r'), '4');
    assert.equal(charts.sparkline([5], { label: 'One' }).querySelectorAll('circle').length, 1);
    assert.equal(charts.sparkline([], { label: 'None' }).childElementCount, 0);
    for (const node of svg.querySelectorAll('*')) assert.equal(node.getAttribute('style'), null);
  });
});
