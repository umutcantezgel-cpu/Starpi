// @ts-check
// Pure helpers for the diagnostics panel: benchmark metrics from measured timestamps and
// human-readable adapter limits. Nothing here measures or simulates anything by itself.

/**
 * @typedef {object} BenchmarkMetrics
 * @property {number} ttftMs            time to first token (request start -> first content token)
 * @property {number} decodeTokensPerSec generated tokens after the first, per second of decode time
 * @property {number} totalMs           request start -> last token
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number | null} prefillTokensPerSec reported by WebLLM, when available
 */

/**
 * @param {import('../webgpu/engine.js').BenchmarkRun} run
 * @returns {BenchmarkMetrics}
 */
export function computeBenchmarkMetrics(run) {
  const ttftMs = Math.max(0, run.firstTokenAt - run.startedAt);
  const decodeMs = Math.max(0, run.finishedAt - run.firstTokenAt);
  const decodedAfterFirst = Math.max(0, run.completionTokens - 1);
  const decodeTokensPerSec = decodeMs > 0 && decodedAfterFirst > 0 ? decodedAfterFirst / (decodeMs / 1000) : 0;
  const prefill = run.engineStats?.prefill_tokens_per_s;
  return {
    ttftMs,
    decodeTokensPerSec,
    totalMs: Math.max(0, run.finishedAt - run.startedAt),
    promptTokens: run.promptTokens,
    completionTokens: run.completionTokens,
    prefillTokensPerSec: typeof prefill === 'number' && Number.isFinite(prefill) ? prefill : null,
  };
}

/**
 * @param {number} bytes
 * @param {(value: number, options?: Intl.NumberFormatOptions) => string} [format]
 */
export function formatBytes(bytes, format = (v, o) => v.toLocaleString('en-US', o)) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${format(value, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

/** Limits that are byte sizes (the rest are counts). */
export const BYTE_LIMITS = new Set(['maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize']);
