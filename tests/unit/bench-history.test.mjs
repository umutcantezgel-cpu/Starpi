// The benchmark history (src/js/models/bench-history.js) over an IndexedDB of its own: entries from
// measured runs, storage with a size limit, the JSON export, browser names, rows per model, and the
// median rate the answer paths read (models/bench-rates.js) to size a processor model's answers.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  benchEntry,
  browserLabel,
  clearHistory,
  EXPORT_FORMAT,
  exportFileName,
  exportHistory,
  HISTORY_LIMIT,
  historyRows,
  isEntry,
  presetLabel,
  readHistory,
  recordRun,
  TREND_RUNS,
} from '../../src/js/models/bench-history.js';
import { localAnswerTokens, measuredRate } from '../../src/js/models/bench-rates.js';
import { GIB, WASM_OUTPUT_TOKENS } from '../../src/js/models/device.js';
import { openAppDb } from '../../src/js/store/schema.js';
import { chooseModel } from '../../src/js/webgpu/models.js';

const cpu = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 0, hasF16: false, webgpu: false };
const desktop = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 2 * GIB, hasF16: true };

let seq = 0;
async function freshDb() {
  const db = await openAppDb({ name: `bench-history-${(seq += 1)}`, factory: new IDBFactory() });
  return { db, getDb: async () => db };
}

/** @param {number} decode @param {number} [ttft] */
const metrics = (decode, ttft = 300) => ({ ttftMs: ttft, decodeTokensPerSec: decode, totalMs: 5000, promptTokens: 64, completionTokens: 128, prefillTokensPerSec: null });

/**
 * @param {ReturnType<typeof chooseModel>} model
 * @param {number | null} decode null for a failed run
 * @param {number} at
 */
const entryOf = (model, decode, at) => benchEntry({ model, metrics: decode === null ? null : metrics(decode), deviceClass: model.deviceClass, browser: 'Chrome 141', loadMs: null, at });

describe('benchEntry', () => {
  it('stores what was measured, on which model, device class and browser', () => {
    const model = chooseModel(desktop, 'auto');
    const e = benchEntry({ model, metrics: metrics(23.456, 412.6), deviceClass: model.deviceClass, browser: 'Firefox 140', loadMs: 5321.7, at: 1_700_000_000_000 });
    assert.ok(isEntry(e));
    assert.equal(typeof e.id, 'string');
    assert.deepEqual(
      { ...e, id: 'x' },
      {
        id: 'x',
        modelId: model.modelId,
        ref: 'webgpu:qwen-3b',
        label: 'Qwen 2.5 3B',
        runtime: 'webgpu',
        deviceClass: 'desktop',
        browser: 'Firefox 140',
        tokPerSec: 23.46,
        ttftMs: 413,
        loadMs: 5322,
        failures: 0,
        at: 1_700_000_000_000,
      },
    );
  });

  it('records a failed run with zero rates', () => {
    const model = chooseModel(cpu, 'auto');
    const e = entryOf(model, null, 1);
    assert.equal(e.runtime, 'wasm');
    assert.equal(e.deviceClass, 'cpu-only');
    assert.equal(e.failures, 1);
    assert.equal(e.tokPerSec, 0);
    assert.equal(e.loadMs, null);
  });
});

describe('the store', () => {
  it('keeps runs across reads, oldest first, and skips foreign records', async () => {
    const { db, getDb } = await freshDb();
    const model = chooseModel(desktop, 'auto');
    await recordRun(entryOf(model, 30, 20), getDb);
    await recordRun(entryOf(model, 10, 10), getDb);
    await db.put('bench', { id: 'odd', modelId: 'm' });
    const runs = await readHistory(getDb);
    assert.deepEqual(
      runs.map((r) => r.tokPerSec),
      [10, 30],
    );
    await clearHistory(getDb);
    assert.deepEqual(await readHistory(getDb), []);
  });

  it(`drops the oldest runs beyond ${HISTORY_LIMIT}`, async () => {
    const { db, getDb } = await freshDb();
    const model = chooseModel(desktop, 'auto');
    await db.putMany(
      'bench',
      Array.from({ length: HISTORY_LIMIT }, (_, i) => entryOf(model, 10, i + 1)),
    );
    await recordRun(entryOf(model, 99, HISTORY_LIMIT + 1), getDb);
    const runs = await readHistory(getDb);
    assert.equal(runs.length, HISTORY_LIMIT);
    assert.equal(runs[0].at, 2, 'the oldest run is gone');
    assert.equal(runs.at(-1)?.tokPerSec, 99);
  });
});

describe('the JSON export', () => {
  it('carries the format id, the time and every run', () => {
    const model = chooseModel(desktop, 'auto');
    const runs = [entryOf(model, 12, 1), entryOf(model, 14, 2)];
    const now = Date.UTC(2026, 9, 17, 12, 30);
    const parsed = JSON.parse(exportHistory(runs, now));
    assert.equal(parsed.format, EXPORT_FORMAT);
    assert.equal(parsed.exportedAt, '2026-10-17T12:30:00.000Z');
    assert.deepEqual(parsed.runs, runs);
    for (const run of parsed.runs) {
      for (const field of ['modelId', 'runtime', 'deviceClass', 'browser', 'tokPerSec', 'ttftMs', 'loadMs', 'failures', 'at']) assert.ok(field in run, field);
    }
    assert.equal(exportFileName(now), 'starpi-bench-history-2026-10-17.json');
  });
});

describe('browserLabel', () => {
  it('names the browser and its major version', () => {
    assert.equal(browserLabel({ userAgentData: { brands: [{ brand: 'Not)A;Brand', version: '8' }, { brand: 'Chromium', version: '141' }, { brand: 'Google Chrome', version: '141.0.1' }] } }), 'Chrome 141');
    assert.equal(browserLabel({ userAgentData: { brands: [{ brand: 'Chromium', version: '140' }] } }), 'Chromium 140');
    assert.equal(browserLabel({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }), 'Firefox 140');
    assert.equal(browserLabel({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15' }), 'Safari 18');
    assert.equal(browserLabel({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1' }), 'Safari 18');
    assert.equal(browserLabel({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0' }), 'Edge 141');
    assert.equal(browserLabel({}), 'unknown');
  });
});

describe('historyRows', () => {
  it('groups runs per model of one device class, fastest first, with a trend of the latest runs', () => {
    const big = chooseModel(desktop, 'auto');
    const small = chooseModel(desktop, 'webgpu:llama-1b');
    const runs = [entryOf(big, 6, 1), entryOf(small, 40, 2), entryOf(big, null, 3), entryOf(big, 9, 4), { ...entryOf(big, 70, 5), deviceClass: 'laptop' }];
    const rows = historyRows(runs, 'desktop');
    assert.deepEqual(
      rows.map((r) => [r.ref, r.runs, r.failures, r.tokPerSec, r.trend]),
      [
        ['webgpu:llama-1b', 1, 0, 40, [40]],
        ['webgpu:qwen-3b', 3, 1, 6, [6, 0, 9]],
      ],
    );
    assert.equal(rows[1].ttftMs, 300);
    assert.equal(rows[1].label, 'Qwen 2.5 3B');
    const many = Array.from({ length: TREND_RUNS + 5 }, (_, i) => entryOf(big, i, i));
    assert.equal(historyRows(many, 'desktop')[0].trend.length, TREND_RUNS);
  });

  it('labels presets from the catalogs', () => {
    assert.equal(presetLabel('wasm:qwen-0.5b'), 'Qwen 2.5 0.5B');
    assert.equal(presetLabel('webgpu:gemma-9b'), 'Gemma 2 9B');
    assert.equal(presetLabel('webgpu:gone'), 'webgpu:gone');
  });
});

describe('measuredRate and localAnswerTokens', () => {
  it('read the median rate of the loaded model on its device class', async () => {
    const { getDb } = await freshDb();
    const wasm = chooseModel(cpu, 'auto');
    assert.equal(await measuredRate(wasm, getDb), null);
    assert.equal(await localAnswerTokens(wasm, { free: true }, getDb), WASM_OUTPUT_TOKENS);
    await recordRun(entryOf(wasm, 12, 1), getDb);
    await recordRun(entryOf(wasm, 14, 2), getDb);
    await recordRun(entryOf(wasm, 40, 3), getDb);
    // Runs of the same model on another device class or runtime do not count.
    await recordRun({ ...entryOf(wasm, 1, 4), deviceClass: 'laptop' }, getDb);
    assert.equal(await measuredRate(wasm, getDb), 14);
    assert.equal(await localAnswerTokens(wasm, { free: true }, getDb), 512, '14 tok/s fills the class budget');
    assert.equal(await localAnswerTokens(wasm, { free: false }, getDb), WASM_OUTPUT_TOKENS);
    const gpu = chooseModel(desktop, 'auto');
    assert.equal(await localAnswerTokens(gpu, { free: true }, getDb), 2048);
  });

  it('never fails and never waits long for the database', async () => {
    const wasm = chooseModel(cpu, 'auto');
    assert.equal(
      await measuredRate(wasm, async () => {
        throw new Error('blocked');
      }),
      null,
    );
    const started = Date.now();
    assert.equal(await measuredRate(wasm, () => new Promise(() => {})), null);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(await measuredRate({ modelId: 'x', runtime: 'wasm' }), null, 'without a device class there is nothing to compare');
  });
});
