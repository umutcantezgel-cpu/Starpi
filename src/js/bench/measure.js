// @ts-check
// The measuring flow of the benchmark: which runtime it can use on this device (WebGPU models, or
// processor (WASM) models when the browser offers no adapter), and one measurement: load the
// selected model when none is ready, then run the engine's benchmark. The engine is passed in, so the
// flow runs against a stand-in in the unit tests (tests/unit/bench-history-wasm.test.mjs). Loaded
// with the Bench tab (bench-tab.js).
import { computeBenchmarkMetrics } from './diagnostics.js';

/** @typedef {import('./diagnostics.js').BenchmarkMetrics} BenchmarkMetrics */
/** @typedef {import('../webgpu/engine.js').BenchmarkRun} BenchmarkRun */
/** @typedef {import('../webgpu/models.js').ModelChoice} ModelChoice */

/**
 * The runtime the benchmark can measure here: WebGPU models when the browser offers an adapter,
 * otherwise processor (WASM) models, and nothing without WebAssembly.
 * @param {{ supported: boolean }} probe the WebGPU probe (webgpu/engine.js probeWebGPU)
 * @param {boolean} [hasWasm]
 * @returns {'webgpu' | 'wasm' | null}
 */
export function benchRuntime(probe, hasWasm = typeof WebAssembly === 'object') {
  if (probe.supported) return 'webgpu';
  return hasWasm ? 'wasm' : null;
}

/**
 * The part of the engine controller (webgpu/engine.js) a benchmark uses.
 * @typedef {object} BenchEngine
 * @property {() => boolean} isReady
 * @property {() => { status: string, model: ModelChoice | null }} getEngineState
 * @property {(fn: (s: { status: string }) => void) => () => unknown} onEngineChange returns the unsubscribe function
 * @property {(options: { outputTokens?: number, onPhase?: (phase: 'warmup' | 'prefill' | 'decode', done: number, total: number) => void }) => Promise<BenchmarkRun>} runBenchmark
 *
 * @typedef {object} MeasureResult
 * @property {'done' | 'declined' | 'failed'} status declined: the model was not loaded (download
 *   declined, or the load failed and was reported by the loader)
 * @property {ModelChoice | null} model the model that was measured
 * @property {BenchmarkRun | null} run
 * @property {BenchmarkMetrics | null} metrics
 * @property {number | null} loadMs load time when the benchmark loaded the model itself
 * @property {unknown} [error] why a run failed
 * @property {boolean} recordable whether the run belongs in the history: measured, or failed on the
 *   device (GPU lost or out of memory) after the model was loaded
 */

/** Engine failures that say something about the device, so a failed run is kept in the history. */
const DEVICE_FAILURES = new Set(['device-lost', 'out-of-memory']);

/**
 * Loads the selected model when none is ready, then measures it with the engine's benchmark. The
 * load time counts from the moment the engine starts loading (after any download question) until
 * the model is ready.
 * @param {BenchEngine} engine
 * @param {{ load: () => Promise<boolean>, outputTokens: number, onPhase?: (phase: 'warmup' | 'prefill' | 'decode', done: number, total: number) => void, now?: () => number }} options
 * @returns {Promise<MeasureResult>}
 */
export async function measureModel(engine, options) {
  const now = options.now ?? (() => performance.now());
  /** @type {number | null} */
  let loadMs = null;
  if (!engine.isReady()) {
    /** @type {number | null} */
    let started = null;
    const off = engine.onEngineChange((s) => {
      if (s.status === 'loading' && started === null) started = now();
    });
    const asked = now();
    /** @type {boolean} */
    let loaded;
    try {
      loaded = await options.load();
    } finally {
      off();
    }
    if (!loaded || !engine.isReady()) return { status: 'declined', model: null, run: null, metrics: null, loadMs: null, recordable: false };
    loadMs = Math.max(0, now() - (started ?? asked));
  }
  const model = engine.getEngineState().model;
  try {
    const run = await engine.runBenchmark({ outputTokens: options.outputTokens, onPhase: options.onPhase });
    return { status: 'done', model, run, metrics: computeBenchmarkMetrics(run), loadMs, recordable: model !== null };
  } catch (error) {
    const kind = error && typeof error === 'object' ? /** @type {{ kind?: unknown }} */ (error).kind : undefined;
    return { status: 'failed', model, run: null, metrics: null, loadMs, error, recordable: model !== null && typeof kind === 'string' && DEVICE_FAILURES.has(kind) };
  }
}
