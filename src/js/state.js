// @ts-check
// Persisted user preferences shared by several modules (kept dependency-free to avoid import cycles).
import { COMPUTE_MODES, DEFAULT_LLM_URL, LEGACY_MODE_ALIASES, LEGACY_STORAGE_KEYS, STORAGE_KEYS } from './config.js';
import { normalizeNvidiaModel } from './models/nvidia-catalog.js';
import { readLocal, removeLocal, writeLocal } from './storage.js';
import { normalizePreference } from './webgpu/models.js';

/** @typedef {import('./config.js').ComputeMode} ComputeMode */
/** @typedef {import('./config.js').ChatMode} ChatMode */
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

/**
 * @param {unknown} value
 * @returns {ChatMode}
 */
export function normalizeChatMode(value) {
  return value === 'free' ? 'free' : 'grounded';
}

for (const key of LEGACY_STORAGE_KEYS) removeLocal(key);

let mode = normalizeMode(readLocal(STORAGE_KEYS.computeMode));
let preference = normalizePreference(readLocal(STORAGE_KEYS.webgpuModel));
let llmUrl = readLocal(STORAGE_KEYS.llmUrl) || DEFAULT_LLM_URL;
let nvidiaModel = normalizeNvidiaModel(readLocal(STORAGE_KEYS.nvidiaModel));
let chatMode = normalizeChatMode(readLocal(STORAGE_KEYS.chatMode));

// Persist normalized values so stale entries from older versions (e.g. removed models) disappear.
writeLocal(STORAGE_KEYS.computeMode, mode);
writeLocal(STORAGE_KEYS.webgpuModel, preference);

/** @type {Set<(mode: ComputeMode) => void>} */
const modeListeners = new Set();
/** @type {Set<(mode: ChatMode) => void>} */
const chatModeListeners = new Set();

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

/** The NVIDIA cloud model the user picked (an allowlisted id; the default until they pick one). */
export function getNvidiaModel() {
  return nvidiaModel;
}

/**
 * @param {unknown} next
 * @returns {boolean} whether the model was also stored for the next visit
 */
export function setNvidiaModel(next) {
  nvidiaModel = normalizeNvidiaModel(next);
  return writeLocal(STORAGE_KEYS.nvidiaModel, nvidiaModel);
}

export function getChatMode() {
  return chatMode;
}

/**
 * @param {unknown} next
 * @returns {boolean} whether the chat mode was also stored for the next visit
 */
export function setChatMode(next) {
  chatMode = normalizeChatMode(next);
  const stored = writeLocal(STORAGE_KEYS.chatMode, chatMode);
  for (const fn of chatModeListeners) fn(chatMode);
  return stored;
}

/** @param {(mode: ChatMode) => void} fn */
export function onChatModeChange(fn) {
  chatModeListeners.add(fn);
}
