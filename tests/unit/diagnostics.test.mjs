import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBytes, queryHardwareProfile, runStandardBenchmark } from '../../src/js/bench/diagnostics.js';

describe('hardware diagnostics', () => {
  it('formats byte numbers into human-readable strings', () => {
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(1048576 * 10), '10.0 MB');
    assert.equal(formatBytes(1073741824 * 4), '4.0 GB');
  });

  it('queries hardware profile without crashing in test environments', async () => {
    const profile = await queryHardwareProfile();
    assert.ok(profile !== null);
    assert.equal(typeof profile.webgpuAvailable, 'boolean');
    assert.equal(typeof profile.vendor, 'string');
    assert.equal(typeof profile.hasF16, 'boolean');
  });

  it('runs standardized benchmark pass and returns valid performance metrics', async () => {
    let progressCalls = 0;
    const res = await runStandardBenchmark((p) => {
      progressCalls++;
      assert.ok(p.percent >= 0 && p.percent <= 100);
    });

    assert.ok(res.ttftMs >= 0, 'TTFT must be non-negative');
    assert.ok(res.tokensPerSec > 0, 'Throughput must be positive');
    assert.ok(res.totalLatencyMs >= res.ttftMs, 'Total latency must be at least TTFT');
    assert.equal(res.outputTokens, 128);
    assert.ok(progressCalls > 0);
  });
});
