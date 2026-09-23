import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BYTE_LIMITS, computeBenchmarkMetrics, formatBytes } from '../../src/js/bench/diagnostics.js';

const run = (overrides = {}) => ({
  modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  f16: true,
  promptTokens: 64,
  completionTokens: 128,
  startedAt: 1_000,
  firstTokenAt: 1_250,
  finishedAt: 3_790,
  engineStats: { prefill_tokens_per_s: 256.4, decode_tokens_per_s: 50.1 },
  ...overrides,
});

describe('computeBenchmarkMetrics', () => {
  it('measures time to first token and decode throughput from real timestamps', () => {
    const m = computeBenchmarkMetrics(run());
    assert.equal(m.ttftMs, 250);
    // 127 tokens after the first one in 2.54 s
    assert.ok(Math.abs(m.decodeTokensPerSec - 127 / 2.54) < 1e-9);
    assert.equal(m.totalMs, 2_790);
    assert.equal(m.promptTokens, 64);
    assert.equal(m.completionTokens, 128);
    assert.equal(m.prefillTokensPerSec, 256.4);
  });

  it('never reports throughput it did not measure', () => {
    const one = computeBenchmarkMetrics(run({ completionTokens: 1, finishedAt: 1_250 }));
    assert.equal(one.decodeTokensPerSec, 0);
    assert.equal(computeBenchmarkMetrics(run({ engineStats: null })).prefillTokensPerSec, null);
    assert.equal(computeBenchmarkMetrics(run({ engineStats: { prefill_tokens_per_s: Number.NaN } })).prefillTokensPerSec, null);
  });
});

describe('formatBytes', () => {
  it('formats sizes with binary units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
    assert.equal(formatBytes(4.5 * 1024 ** 3), '4.5 GB');
  });

  it('knows which adapter limits are byte sizes', () => {
    assert.ok(BYTE_LIMITS.has('maxBufferSize'));
    assert.ok(!BYTE_LIMITS.has('maxComputeInvocationsPerWorkgroup'));
  });
});
