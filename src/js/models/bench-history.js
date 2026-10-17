// @ts-check
// Benchmark history: every measured run of an on-device model, kept in the app database's `bench`
// store, so the recommendation can learn how fast models really are on this device
// (models/device.js recommendModels) and the Bench tab can chart the runs and export them as JSON.
// Loaded by the Bench tab only; the answer paths read just the median rate (models/bench-rates.js).
//
// A run is { id, modelId, ref, label, runtime, deviceClass, browser, tokPerSec, ttftMs, loadMs,
// failures, at }: modelId names exactly what ran (the WebLLM build or the processor model's
// repository), ref the preset ('webgpu:<key>' or 'wasm:<key>'), tokPerSec the decode rate, loadMs
// the load time when the benchmark loaded the model itself (null when it was loaded already), and
// failures 1 for a run that ended in an engine failure (its rates are 0).
import { appDb } from '../store/schema.js';
import { MODEL_CATALOG } from '../webgpu/models.js';
import { medianRate } from './device.js';
import { WASM_CATALOG } from './wasm-catalog.js';

/** @typedef {import('../store/idb.js').StoreDb} StoreDb */
/** @typedef {import('./device.js').DeviceClass} DeviceClass */
/** @typedef {import('../bench/diagnostics.js').BenchmarkMetrics} BenchmarkMetrics */

/**
 * @typedef {object} BenchEntry
 * @property {string} id
 * @property {string} modelId
 * @property {string} ref
 * @property {string} label
 * @property {'webgpu' | 'wasm'} runtime
 * @property {string} deviceClass
 * @property {string} browser
 * @property {number} tokPerSec
 * @property {number} ttftMs
 * @property {number | null} loadMs
 * @property {number} failures
 * @property {number} at epoch milliseconds
 *
 * @typedef {object} HistoryRow One model in the Bench tab's history.
 * @property {string} ref
 * @property {string} label
 * @property {'webgpu' | 'wasm'} runtime
 * @property {number} runs
 * @property {number} failures
 * @property {number} tokPerSec median decode rate (failed runs count as 0)
 * @property {number[]} trend decode rates of the latest runs, oldest first
 * @property {number | null} ttftMs time to first token of the latest successful run
 * @property {number} lastAt
 */

export const STORE = 'bench';
/** Format id of the JSON export. */
export const EXPORT_FORMAT = 'starpi.bench-history/v1';
/** Runs kept; older ones are dropped when a new run is recorded. */
export const HISTORY_LIMIT = 500;
/** Runs per model in a trend line. */
export const TREND_RUNS = 12;

/**
 * The display name of a preset ref, or the ref itself when the catalogs no longer know it.
 * @param {string} ref
 */
export function presetLabel(ref) {
  const [runtime, key] = ref.split(':');
  const catalog = runtime === 'wasm' ? WASM_CATALOG : runtime === 'webgpu' ? MODEL_CATALOG : null;
  return catalog && key && Object.hasOwn(catalog, key) ? catalog[/** @type {keyof typeof catalog} */ (key)].label : ref;
}

/**
 * A short browser name and major version from the navigator, e.g. 'Chrome 141' or 'Safari 18'.
 * @param {{ userAgent?: string, userAgentData?: { brands?: ReadonlyArray<{ brand: string, version: string }> } }} nav
 */
export function browserLabel(nav) {
  const brands = (nav.userAgentData?.brands ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
  const named = brands.find((b) => b.brand !== 'Chromium') ?? brands[0];
  if (named) return `${named.brand.replace(/^Google /, '')} ${named.version.split('.')[0]}`;
  const ua = nav.userAgent ?? '';
  for (const [re, name] of /** @type {const} */ ([
    [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/FxiOS\/(\d+)/, 'Firefox'],
    [/CriOS\/(\d+)/, 'Chrome'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, 'Safari'],
  ])) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return 'unknown';
}

/** @returns {string} */
function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** @param {unknown} v */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The history entry for one benchmark run.
 * @param {object} run
 * @param {{ modelId: string, ref: string, label?: string, runtime: 'webgpu' | 'wasm' }} run.model the loaded model (webgpu/models.js ModelChoice)
 * @param {BenchmarkMetrics | null} run.metrics null for a run that failed
 * @param {string} run.deviceClass
 * @param {string} run.browser
 * @param {number | null} [run.loadMs]
 * @param {number} [run.at]
 * @returns {BenchEntry}
 */
export function benchEntry(run) {
  const m = run.metrics;
  return {
    id: newId(),
    modelId: run.model.modelId,
    ref: run.model.ref,
    label: run.model.label ?? presetLabel(run.model.ref),
    runtime: run.model.runtime,
    deviceClass: run.deviceClass,
    browser: run.browser,
    tokPerSec: m ? round(m.decodeTokensPerSec, 2) : 0,
    ttftMs: m ? Math.round(m.ttftMs) : 0,
    loadMs: finite(run.loadMs) ? Math.round(/** @type {number} */ (run.loadMs)) : null,
    failures: m ? 0 : 1,
    at: run.at ?? Date.now(),
  };
}

/**
 * @param {number} value
 * @param {number} digits
 */
function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * A stored record that has every field the history reads (records of other shapes are skipped).
 * @param {any} r
 * @returns {r is BenchEntry}
 */
export function isEntry(r) {
  return (
    Boolean(r) &&
    typeof r.id === 'string' &&
    typeof r.modelId === 'string' &&
    typeof r.ref === 'string' &&
    (r.runtime === 'webgpu' || r.runtime === 'wasm') &&
    typeof r.deviceClass === 'string' &&
    finite(r.tokPerSec) &&
    finite(r.ttftMs) &&
    finite(r.failures) &&
    finite(r.at)
  );
}

/**
 * Every stored run, oldest first.
 * @param {() => Promise<StoreDb>} [getDb]
 * @returns {Promise<BenchEntry[]>}
 */
export async function readHistory(getDb = appDb) {
  const db = await getDb();
  const all = await db.getAll(STORE);
  return all.filter(isEntry).sort((a, b) => a.at - b.at);
}

/**
 * Stores a run and drops the oldest runs beyond HISTORY_LIMIT.
 * @param {BenchEntry} entry
 * @param {() => Promise<StoreDb>} [getDb]
 */
export async function recordRun(entry, getDb = appDb) {
  const db = await getDb();
  await db.put(STORE, entry);
  const all = /** @type {Array<{ id: string, at: number }>} */ (await db.getAll(STORE));
  if (all.length <= HISTORY_LIMIT) return;
  const old = all.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(0, all.length - HISTORY_LIMIT);
  await db.transaction(STORE, 'readwrite', async (tx) => {
    await Promise.all(old.map((r) => tx.delete(STORE, r.id)));
  });
}

/**
 * Deletes every stored run.
 * @param {() => Promise<StoreDb>} [getDb]
 */
export async function clearHistory(getDb = appDb) {
  const db = await getDb();
  await db.clear(STORE);
}

/**
 * The JSON export: the format id, the export time and every run, oldest first.
 * @param {readonly BenchEntry[]} entries
 * @param {number} [now]
 */
export function exportHistory(entries, now = Date.now()) {
  return `${JSON.stringify({ format: EXPORT_FORMAT, exportedAt: new Date(now).toISOString(), runs: entries }, null, 2)}\n`;
}

/** @param {number} [now] */
export function exportFileName(now = Date.now()) {
  return `starpi-bench-history-${new Date(now).toISOString().slice(0, 10)}.json`;
}

/**
 * The history per model on one device class, fastest first.
 * @param {readonly BenchEntry[]} entries oldest first
 * @param {string} cls
 * @returns {HistoryRow[]}
 */
export function historyRows(entries, cls) {
  /** @type {Map<string, BenchEntry[]>} */
  const byRef = new Map();
  for (const e of entries) {
    if (e.deviceClass !== cls) continue;
    const list = byRef.get(e.ref) ?? [];
    list.push(e);
    byRef.set(e.ref, list);
  }
  return [...byRef].map(([ref, runs]) => {
    const ok = runs.filter((r) => r.failures === 0);
    const latest = runs[runs.length - 1];
    return {
      ref,
      label: latest.label || presetLabel(ref),
      runtime: latest.runtime,
      runs: runs.length,
      failures: runs.length - ok.length,
      tokPerSec: medianRate(runs) ?? 0,
      trend: runs.slice(-TREND_RUNS).map((r) => (r.failures > 0 ? 0 : r.tokPerSec)),
      ttftMs: ok.length ? ok[ok.length - 1].ttftMs : null,
      lastAt: latest.at,
    };
  }).sort((a, b) => b.tokPerSec - a.tokPerSec || a.label.localeCompare(b.label));
}
