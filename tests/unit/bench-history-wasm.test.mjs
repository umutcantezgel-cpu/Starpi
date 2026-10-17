// The benchmark on a device without WebGPU (src/js/bench/measure.js benchRuntime and
// measureModel): it measures a processor (WASM) model instead of refusing, through a stand-in engine
// with the controller API of webgpu/engine.js. The run goes into the history, and a seeded history
// changes the recommendation for the device.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { computeBenchmarkMetrics } from '../../src/js/bench/diagnostics.js';
import { benchRuntime, measureModel } from '../../src/js/bench/measure.js';
import { benchEntry, readHistory, recordRun } from '../../src/js/models/bench-history.js';
import { recommendModels } from '../../src/js/models/device.js';
import { openAppDb } from '../../src/js/store/schema.js';
import { EngineError } from '../../src/js/webgpu/engine.js';
import { chooseModel } from '../../src/js/webgpu/models.js';

const cpu = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 0, hasF16: false, webgpu: false };

/**
 * A stand-in for the engine controller: loading picks the model for the device like the real one
 * (chooseModel with 'auto'), reports 'loading' then 'ready', and the benchmark returns timestamps of a
 * run that decodes `tokPerSec` tokens per second.
 * @param {{ hw?: typeof cpu, tokPerSec?: number, fail?: unknown, ready?: boolean, clock?: { t: number } }} [script]
 */
function fakeEngine(script = {}) {
  const clock = script.clock ?? { t: 0 };
  const listeners = new Set();
  /** @type {{ status: string, model: any }} */
  let state = { status: 'idle', model: null };
  const set = (/** @type {any} */ next) => {
    state = next;
    for (const fn of listeners) fn(state);
  };
  if (script.ready) state = { status: 'ready', model: chooseModel(script.hw ?? cpu, 'auto') };
  /** @type {any[]} */
  const benchCalls = [];
  return {
    clock,
    benchCalls,
    isReady: () => state.status === 'ready',
    getEngineState: () => state,
    onEngineChange(/** @type {any} */ fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The loader the bench tab passes in (startLocalEngine); the user takes 4 s to confirm the download. */
    async load() {
      clock.t += 4_000;
      set({ status: 'loading', model: null });
      clock.t += 1_500;
      set({ status: 'ready', model: chooseModel(script.hw ?? cpu, 'auto') });
      return true;
    },
    /** @param {{ outputTokens?: number, onPhase?: (phase: string, done: number, total: number) => void }} options */
    async runBenchmark(options) {
      benchCalls.push(options);
      if (script.fail) throw script.fail;
      const total = options.outputTokens ?? 128;
      options.onPhase?.('warmup', 0, total);
      options.onPhase?.('prefill', 0, total);
      const startedAt = clock.t;
      const firstTokenAt = startedAt + 900;
      const finishedAt = firstTokenAt + ((total - 1) / (script.tokPerSec ?? 6)) * 1000;
      options.onPhase?.('decode', total, total);
      clock.t = finishedAt;
      return { modelId: state.model.modelId, runtime: state.model.runtime, f16: false, promptTokens: 64, completionTokens: total, startedAt, firstTokenAt, finishedAt, engineStats: null };
    },
  };
}

describe('benchRuntime', () => {
  it('measures a processor (WASM) model when there is no WebGPU', () => {
    assert.equal(benchRuntime({ supported: true }), 'webgpu');
    assert.equal(benchRuntime({ supported: false }), 'wasm', 'Node has WebAssembly, like every browser the app supports');
    assert.equal(benchRuntime({ supported: false }, false), null);
  });
});

describe('measureModel on a device without WebGPU', () => {
  it('loads the processor model, measures it and times the load from the moment loading starts', async () => {
    const engine = fakeEngine({ tokPerSec: 6 });
    /** @type {string[]} */
    const phases = [];
    const result = await measureModel(engine, { load: () => engine.load(), outputTokens: 128, onPhase: (phase) => phases.push(phase), now: () => engine.clock.t });
    assert.equal(result.status, 'done');
    assert.equal(result.model?.runtime, 'wasm');
    assert.equal(result.model?.ref, 'wasm:qwen-0.5b');
    assert.equal(result.model?.deviceClass, 'cpu-only');
    assert.equal(result.loadMs, 1_500, 'the download question is not load time');
    assert.equal(engine.benchCalls[0].outputTokens, 128);
    assert.deepEqual(phases, ['warmup', 'prefill', 'decode']);
    assert.ok(result.metrics && result.run);
    assert.deepEqual(result.metrics, computeBenchmarkMetrics(result.run));
    assert.ok(Math.abs(result.metrics.decodeTokensPerSec - 6) < 1e-9);
    assert.equal(result.metrics.ttftMs, 900);
    assert.equal(result.recordable, true);
  });

  it('measures a model that is already loaded without a load time', async () => {
    const engine = fakeEngine({ ready: true, tokPerSec: 11 });
    let loads = 0;
    const result = await measureModel(engine, { load: async () => (loads += 1) > 0, outputTokens: 64, now: () => engine.clock.t });
    assert.equal(loads, 0);
    assert.equal(result.loadMs, null);
    assert.equal(result.status, 'done');
    assert.equal(engine.benchCalls[0].outputTokens, 64);
  });

  it('stops when the download is declined', async () => {
    const engine = fakeEngine();
    const result = await measureModel(engine, { load: async () => false, outputTokens: 128 });
    assert.equal(result.status, 'declined');
    assert.equal(result.recordable, false);
    assert.equal(engine.benchCalls.length, 0);
  });

  it('keeps device failures for the history, not other errors', async () => {
    const oom = await measureModel(fakeEngine({ ready: true, fail: new EngineError('out-of-memory', 'Out of memory') }), { load: async () => true, outputTokens: 128 });
    assert.equal(oom.status, 'failed');
    assert.equal(oom.recordable, true);
    assert.ok(oom.error instanceof EngineError);
    const busy = await measureModel(fakeEngine({ ready: true, fail: new EngineError('busy', 'Busy') }), { load: async () => true, outputTokens: 128 });
    assert.equal(busy.status, 'failed');
    assert.equal(busy.recordable, false);
  });

  it('records the run, and the seeded history changes the recommendation', async () => {
    const db = await openAppDb({ name: 'bench-wasm', factory: new IDBFactory() });
    const getDb = async () => db;
    assert.equal(recommendModels(cpu, { history: await readHistory(getDb) }).local, 'wasm:qwen-0.5b');

    for (const tokPerSec of [5, 6, 7]) {
      const engine = fakeEngine({ tokPerSec, ready: tokPerSec !== 5 });
      const result = await measureModel(engine, { load: () => engine.load(), outputTokens: 128, now: () => engine.clock.t });
      assert.ok(result.model);
      await recordRun(benchEntry({ model: result.model, metrics: result.metrics, loadMs: result.loadMs, deviceClass: result.model.deviceClass, browser: 'Firefox 140', at: 1_000 + tokPerSec }), getDb);
    }
    const history = await readHistory(getDb);
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((r) => [r.runtime, r.deviceClass, Math.round(r.tokPerSec)]),
      [
        ['wasm', 'cpu-only', 5],
        ['wasm', 'cpu-only', 6],
        ['wasm', 'cpu-only', 7],
      ],
    );
    assert.equal(history[0].loadMs, 1_500);
    const rec = recommendModels(cpu, { history });
    assert.equal(rec.local, 'wasm:smollm2-360m', 'median 6 tok/s is below 8: one step down');
    assert.equal(rec.stepDown?.from, 'wasm:qwen-0.5b');
  });
});
