// @ts-check
// Persisted user preferences shared by several modules (kept dependency-free to avoid import cycles).
import { COMPUTE_MODES, DEFAULT_LLM_URL, LEGACY_MODE_ALIASES, LEGACY_STORAGE_KEYS, STORAGE_KEYS } from './config.js';
import { readLocal, removeLocal, writeLocal } from './storage.js';
import { normalizePreference } from './webgpu/models.js';

/** @typedef {import('./config.js').ComputeMode} ComputeMode */
/** @typedef {import('./webgpu/models.js').ModelPreference} ModelPreference */

/**
 * @param {unknown} value
 * @returns {ComputeMode}
 */
export function normalizeMode(value) {
  if (typeof value !== 'string') return 'council';
  const aliased = /** @type {Record<string, string>} */ (LEGACY_MODE_ALIASES)[value] ?? value;
  return /** @type {readonly string[]} */ (COMPUTE_MODES).includes(aliased) ? /** @type {ComputeMode} */ (aliased) : 'council';
}

for (const key of LEGACY_STORAGE_KEYS) removeLocal(key);

let mode = normalizeMode(readLocal(STORAGE_KEYS.computeMode));
let preference = normalizePreference(readLocal(STORAGE_KEYS.webgpuModel));
let llmUrl = readLocal(STORAGE_KEYS.llmUrl) || DEFAULT_LLM_URL;

// Persist normalized values so stale entries from older versions (e.g. removed models) disappear.
writeLocal(STORAGE_KEYS.computeMode, mode);
writeLocal(STORAGE_KEYS.webgpuModel, preference);

/** @type {Set<(mode: ComputeMode) => void>} */
const modeListeners = new Set();

export function getMode() {
  return mode;
}

/**
 * @param {ComputeMode} next
 * @returns {boolean} whether the mode was also stored for the next visit
 */
export function setMode(next) {
  mode = normalizeMode(next);
  const stored = writeLocal(STORAGE_KEYS.computeMode, mode);
  for (const fn of modeListeners) fn(mode);
  return stored;
}

/** @param {(mode: ComputeMode) => void} fn */
export function onModeChange(fn) {
  modeListeners.add(fn);
}

export function getModelPreference() {
  return preference;
}

/**
 * @param {unknown} next
 * @returns {boolean} whether the preference was also stored for the next visit
 */
export function setModelPreference(next) {
  preference = normalizePreference(next);
  return writeLocal(STORAGE_KEYS.webgpuModel, preference);
}

export function getLlmUrl() {
  return llmUrl;
}

/**
 * @param {string} next
 * @returns {boolean} whether the URL was also stored for the next visit
 */
export function setLlmUrl(next) {
  llmUrl = next;
  return writeLocal(STORAGE_KEYS.llmUrl, next);
}
