// Model recommendations from a benchmark history (src/js/models/device.js recommendModels with
// `history`): a pick that decodes below 8 tok/s on this device class steps down a rung, a larger model
// measured above 20 tok/s is suggested (never picked), failed runs count as 0 tok/s, and runs of other
// device classes do not count.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLASS_KEYS,
  FAST_TOK_PER_SEC,
  GIB,
  median,
  medianRate,
  measuredRates,
  presetSize,
  recommendModels,
  SLOW_TOK_PER_SEC,
} from '../../src/js/models/device.js';
import { WASM_CATALOG } from '../../src/js/models/wasm-catalog.js';
import { MODEL_CATALOG } from '../../src/js/webgpu/models.js';

const desktop = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 2 * GIB, hasF16: true };
const laptop = { ...desktop, deviceMemoryGB: null };
const cpu = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 0, hasF16: false, webgpu: false };
const pro = { ...desktop, vendor: 'nvidia', maxStorageBufferBindingSize: 2 * GIB };

let at = 0;
/**
 * @param {string} ref
 * @param {string} deviceClass
 * @param {number} tokPerSec
 * @param {number} [failures]
 */
const runOf = (ref, deviceClass, tokPerSec, failures = 0) => ({ ref, modelId: ref, runtime: ref.split(':')[0], deviceClass, tokPerSec, failures, at: (at += 1) });

describe('the thresholds', () => {
  it('are 8 and 20 tokens per second', () => {
    assert.equal(SLOW_TOK_PER_SEC, 8);
    assert.equal(FAST_TOK_PER_SEC, 20);
  });
});

describe('median and medianRate', () => {
  it('take the middle value, counting failed runs as 0 tok/s', () => {
    assert.equal(median([]), 0);
    assert.equal(median([5]), 5);
    assert.equal(median([9, 1, 5]), 5);
    assert.equal(median([1, 2, 3, 10]), 2.5);
    assert.equal(medianRate([]), null);
    assert.equal(medianRate([{ tokPerSec: 30, failures: 0 }, { tokPerSec: 30, failures: 0 }, { tokPerSec: 25, failures: 1 }]), 30);
    assert.equal(medianRate([{ tokPerSec: 30, failures: 0 }, { tokPerSec: 0, failures: 1 }, { tokPerSec: 0, failures: 1 }]), 0);
    assert.equal(medianRate([{ tokPerSec: Number.NaN, failures: 0 }]), 0);
  });

  it('group runs per preset of one device class', () => {
    const rates = measuredRates(
      [runOf('webgpu:qwen-3b', 'desktop', 10), runOf('webgpu:qwen-3b', 'desktop', 14), runOf('webgpu:qwen-3b', 'laptop', 2), { ...runOf('x', 'desktop', 1), ref: undefined }, runOf('webgpu:unknown', 'desktop', 99)],
      'desktop',
    );
    assert.deepEqual([...rates], [['webgpu:qwen-3b', { tokPerSec: 12, runs: 2 }]]);
  });
});

describe('presetSize', () => {
  it('knows every preset of both runtimes', () => {
    for (const key of Object.keys(MODEL_CATALOG)) assert.ok(presetSize(`webgpu:${key}`) > 0, key);
    for (const key of Object.keys(WASM_CATALOG)) assert.ok(presetSize(`wasm:${key}`) > 0, key);
    assert.equal(presetSize('webgpu:nope'), 0);
    assert.ok(presetSize('webgpu:qwen-7b') > presetSize('webgpu:qwen-3b'));
    assert.equal(presetSize('wasm:qwen-0.5b'), presetSize('webgpu:qwen-0.5b'));
  });
});

describe('recommendModels with a history', () => {
  it('is unchanged without measurements', () => {
    assert.deepEqual(recommendModels(desktop, { history: [] }), { cls: 'desktop', local: 'webgpu:qwen-3b', pro: null, stepDown: null, proTokPerSec: null });
    assert.deepEqual(recommendModels(pro), { cls: 'desktop-pro', local: 'webgpu:qwen-3b', pro: 'webgpu:qwen-7b', stepDown: null, proTokPerSec: null });
  });

  it('steps down a tier when the pick measured below 8 tok/s', () => {
    const seeded = [runOf('webgpu:qwen-3b', 'desktop', 5.5), runOf('webgpu:qwen-3b', 'desktop', 6), runOf('webgpu:qwen-3b', 'desktop', 30, 0)];
    // Median 6 tok/s.
    const rec = recommendModels(desktop, { history: seeded });
    assert.equal(rec.local, 'webgpu:qwen-1.5b', 'the laptop pick');
    assert.deepEqual(rec.stepDown, { from: 'webgpu:qwen-3b', tokPerSec: 6 });
    assert.equal(rec.pro, null);
  });

  it('keeps the pick at or above 8 tok/s', () => {
    const rec = recommendModels(desktop, { history: [runOf('webgpu:qwen-3b', 'desktop', 8)] });
    assert.equal(rec.local, 'webgpu:qwen-3b');
    assert.equal(rec.stepDown, null);
  });

  it('steps down again while the next rung measured slow too, and stops at the smallest preset', () => {
    const history = [runOf('webgpu:qwen-3b', 'desktop', 3), runOf('webgpu:qwen-1.5b', 'desktop', 6), runOf('webgpu:llama-1b', 'desktop', 12)];
    assert.equal(recommendModels(desktop, { history }).local, 'webgpu:llama-1b');
    const allSlow = ['webgpu:qwen-3b', 'webgpu:qwen-1.5b', 'webgpu:llama-1b', 'webgpu:qwen-0.5b', 'webgpu:smollm2-360m'].map((ref) => runOf(ref, 'desktop', 1));
    assert.equal(recommendModels(desktop, { history: allSlow }).local, 'webgpu:smollm2-360m');
  });

  it('steps down processor models on devices without WebGPU', () => {
    const rec = recommendModels(cpu, { history: [runOf('wasm:qwen-0.5b', 'cpu-only', 2.4)] });
    assert.equal(rec.local, 'wasm:smollm2-360m');
    assert.deepEqual(rec.stepDown, { from: 'wasm:qwen-0.5b', tokPerSec: 2.4 });
  });

  it('counts failed runs as slow', () => {
    const history = [runOf('webgpu:qwen-1.5b', 'laptop', 0, 1), runOf('webgpu:qwen-1.5b', 'laptop', 0, 1), runOf('webgpu:qwen-1.5b', 'laptop', 40)];
    assert.equal(recommendModels(laptop, { history }).local, 'webgpu:llama-1b');
  });

  it('ignores runs of another device class', () => {
    const rec = recommendModels(desktop, { history: [runOf('webgpu:qwen-3b', 'laptop', 2)] });
    assert.equal(rec.local, 'webgpu:qwen-3b');
    assert.equal(rec.stepDown, null);
  });

  it('suggests, but never picks, the largest model measured above 20 tok/s', () => {
    const history = [runOf('webgpu:qwen-3b', 'desktop', 24), runOf('webgpu:llama-8b', 'desktop', 21), runOf('webgpu:mistral-7b', 'desktop', 26), runOf('webgpu:gemma-9b', 'desktop', 19)];
    const rec = recommendModels(desktop, { history });
    assert.equal(rec.local, 'webgpu:qwen-3b', 'auto keeps its pick');
    assert.equal(rec.pro, 'webgpu:llama-8b');
    assert.equal(rec.proTokPerSec, 21);
    // Exactly 20 tok/s is not above the threshold; a smaller fast model is no suggestion.
    assert.equal(recommendModels(desktop, { history: [runOf('webgpu:llama-8b', 'desktop', 20)] }).pro, null);
    assert.equal(recommendModels(desktop, { history: [runOf('webgpu:llama-1b', 'desktop', 60)] }).pro, null);
  });

  it('replaces the unmeasured suggestion for strong GPUs with evidence', () => {
    assert.equal(recommendModels(pro, { history: [runOf('webgpu:gemma-9b', 'desktop-pro', 22)] }).pro, 'webgpu:gemma-9b');
    // The 7B guess measured slow here: no suggestion.
    const slowGuess = recommendModels(pro, { history: [runOf('webgpu:qwen-7b', 'desktop-pro', 4)] });
    assert.equal(slowGuess.pro, null);
    // Measured fine, but not fast: the guess stays.
    assert.equal(recommendModels(pro, { history: [runOf('webgpu:qwen-7b', 'desktop-pro', 12)] }).pro, 'webgpu:qwen-7b');
  });

  it('suggests a larger model after a step down when one ran fast', () => {
    const history = [runOf('webgpu:qwen-3b', 'desktop', 4), runOf('webgpu:smollm2-1.7b', 'desktop', 23)];
    const rec = recommendModels(desktop, { history });
    assert.equal(rec.local, 'webgpu:qwen-1.5b');
    assert.equal(rec.pro, 'webgpu:smollm2-1.7b');
  });
});

describe('CLASS_KEYS', () => {
  it('names every device class', () => {
    assert.deepEqual(Object.keys(CLASS_KEYS).sort(), ['cpu-only', 'desktop', 'desktop-pro', 'laptop', 'low', 'mobile']);
  });
});
