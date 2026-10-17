// @ts-check
// The measured decode rate of the loaded on-device model, read from the benchmark history (the app
// database's `bench` store) when an answer is sized: a processor (WASM) model that a benchmark
// measured faster may answer longer (models/device.js outputBudget). This is the only part of the
// history the answer paths load; recording, the chart and the export live in models/bench-history.js,
// which the Bench tab loads on demand.
//
// Reading never throws and never holds an answer up for long: without a measurement (or when the
// database does not answer in time) the answer keeps the default budget.
import { appDb } from '../store/schema.js';
import { answerTokens } from '../webgpu/models.js';
import { medianRate } from './device.js';

/** @typedef {import('../store/idb.js').StoreDb} StoreDb */

/** How long an answer waits for the history before it uses the default budget. */
const READ_TIMEOUT_MS = 300;

/**
 * Median decode rate of a model on this device class, from the stored runs; null without runs.
 * @param {{ modelId: string, runtime: string, deviceClass?: string }} model the engine's loaded model
 * @param {() => Promise<StoreDb>} [getDb]
 * @returns {Promise<number | null>}
 */
export async function measuredRate(model, getDb = appDb) {
  if (!model.modelId || !model.deviceClass) return null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const read = (async () => {
    const db = await getDb();
    /** @type {Array<{ runtime: string, deviceClass: string, tokPerSec: number, failures: number }>} */
    const runs = await db.getAllFromIndex('bench', 'modelId', model.modelId);
    return medianRate(runs.filter((r) => r.runtime === model.runtime && r.deviceClass === model.deviceClass));
  })().catch(() => null);
  const late = /** @type {Promise<null>} */ (
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
    })
  );
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Output tokens of one answer of the loaded model (webgpu/models.js answerTokens), with the measured
 * rate of a processor model looked up first. WebGPU budgets do not depend on measurements.
 * @param {import('../webgpu/models.js').ModelChoice} model
 * @param {{ free: boolean }} options
 * @param {() => Promise<StoreDb>} [getDb]
 * @returns {Promise<number>}
 */
export async function localAnswerTokens(model, options, getDb = appDb) {
  const tokPerSec = model.runtime === 'wasm' ? await measuredRate(model, getDb) : null;
  return answerTokens(model, { free: options.free, tokPerSec });
}
