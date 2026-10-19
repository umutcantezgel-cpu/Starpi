// @ts-check
// Persisted user preferences shared by several modules (kept dependency-free to avoid import cycles).
//
// The assistant: the model picker stores one value (config.js AssistantValue). The 2.x compute
// mode (getMode) is derived from it for the modules that only ask where answers are computed; a
// stored 2.x mode becomes a picker value once (council -> auto, client -> device, local ->
// local:*, nvidia -> nvidia:<stored model>).
import { ASSISTANT_AUTO, ASSISTANT_DEVICE, CHAT_MODES, COMPUTE_MODES, DEFAULT_LLM_URL, LEGACY_ASSISTANT, LEGACY_MODE_ALIASES, LEGACY_STORAGE_KEYS, LOCAL_ANY_MODEL, STORAGE_KEYS } from './config.js';
import { normalizeNvidiaModel } from './models/nvidia-catalog.js';
import { readLocal, removeLocal, writeLocal } from './storage.js';
import { normalizePreference } from './webgpu/models.js';

/** @typedef {import('./config.js').ComputeMode} ComputeMode */
/** @typedef {import('./config.js').ChatMode} ChatMode */
/** @typedef {import('./config.js').AssistantValue} AssistantValue */
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
  return typeof value === 'string' && /** @type {readonly string[]} */ (CHAT_MODES).includes(value) ? /** @type {ChatMode} */ (value) : 'auto';
}

/** A model id as a picker value carries it: printable, no spaces; '*' for "the server's first model". */
const MODEL_ID = /^(?:\*|[\w][\w.:/@+-]{0,199})$/;
/** Providers a picker value may name; the on-device engines are reached through 'device'. */
const VALUE_PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'openrouter', 'nvidia', 'local', 'companion']);

/**
 * A stored or picked assistant value, or null when it is none. 'webgpu:<key>' and 'wasm:<key>'
 * are on-device presets: they are not values themselves (the picker stores 'device' and the
 * preset as the model preference).
 * @param {unknown} value
 * @returns {AssistantValue | null}
 */
export function normalizeAssistant(value) {
  if (value === ASSISTANT_AUTO || value === ASSISTANT_DEVICE) return value;
  if (typeof value !== 'string') return null;
  const at = value.indexOf(':');
  if (at <= 0) return null;
  const provider = value.slice(0, at);
  const model = value.slice(at + 1);
  return VALUE_PROVIDERS.has(provider) && MODEL_ID.test(model) && (model !== LOCAL_ANY_MODEL || provider === 'local') ? /** @type {AssistantValue} */ (value) : null;
}

/**
 * The provider and model of a value; null for 'auto' and 'device'.
 * @param {AssistantValue} value
 * @returns {{ provider: import('./ai/contract.js').ProviderId, model: string } | null}
 */
export function assistantTarget(value) {
  if (value === ASSISTANT_AUTO || value === ASSISTANT_DEVICE) return null;
  const at = value.indexOf(':');
  return { provider: /** @type {import('./ai/contract.js').ProviderId} */ (value.slice(0, at)), model: value.slice(at + 1) };
}

/**
 * The 2.x compute mode of an assistant value.
 * @param {AssistantValue} value
 * @returns {ComputeMode}
 */
export function computeModeOf(value) {
  if (value === ASSISTANT_DEVICE) return 'client';
  const target = assistantTarget(value);
  if (target?.provider === 'local') return 'local';
  if (target?.provider === 'nvidia') return 'nvidia';
  return 'council';
}

for (const key of LEGACY_STORAGE_KEYS) removeLocal(key);

let mode = normalizeMode(readLocal(STORAGE_KEYS.computeMode));
let preference = normalizePreference(readLocal(STORAGE_KEYS.webgpuModel));
let llmUrl = readLocal(STORAGE_KEYS.llmUrl) || DEFAULT_LLM_URL;
let nvidiaModel = normalizeNvidiaModel(readLocal(STORAGE_KEYS.nvidiaModel));
let chatMode = normalizeChatMode(readLocal(STORAGE_KEYS.chatMode));
/** @type {AssistantValue} */
let assistant = normalizeAssistant(readLocal(STORAGE_KEYS.assistant)) ?? (mode === 'nvidia' ? `nvidia:${nvidiaModel}` : LEGACY_ASSISTANT[mode]);
mode = computeModeOf(assistant);

// Persist normalized values so stale entries from older versions (e.g. removed models) disappear.
writeLocal(STORAGE_KEYS.computeMode, mode);
writeLocal(STORAGE_KEYS.webgpuModel, preference);
writeLocal(STORAGE_KEYS.assistant, assistant);

/** @type {Set<(mode: ComputeMode) => void>} */
const modeListeners = new Set();
/** @type {Set<(value: AssistantValue) => void>} */
const assistantListeners = new Set();
/** @type {Set<(mode: ChatMode) => void>} */
const chatModeListeners = new Set();

export function getMode() {
  return mode;
}

/**
 * Switches by 2.x compute mode: 'client' the on-device model, 'council' Auto, 'local' the own
 * server (its stored model), 'nvidia' the stored NVIDIA model.
 * @param {ComputeMode} next
 * @returns {boolean} whether the mode was also stored for the next visit
 */
export function setMode(next) {
  const target = normalizeMode(next);
  if (target === computeModeOf(assistant)) return setAssistant(assistant);
  if (target === 'nvidia') return setAssistant(`nvidia:${nvidiaModel}`);
  return setAssistant(LEGACY_ASSISTANT[target]);
}

/** @param {(mode: ComputeMode) => void} fn */
export function onModeChange(fn) {
  modeListeners.add(fn);
}

/** The assistant the picker shows (config.js AssistantValue). */
export function getAssistant() {
  return assistant;
}

/**
 * Stores the assistant. An on-device preset ('webgpu:<key>', 'wasm:<key>') stores 'device' with the
 * preset as the model preference; 'nvidia:<id>' also remembers the NVIDIA model. Listeners of the
 * assistant and of the compute mode hear every call.
 * @param {string} next
 * @returns {boolean} whether it was also stored for the next visit (false for a value that is none)
 */
export function setAssistant(next) {
  let stored = true;
  /** @type {AssistantValue | null} */
  let value;
  if (/^(?:webgpu|wasm):/.test(next)) {
    const pref = normalizePreference(next);
    if (pref === 'auto') return false;
    stored = setModelPreference(pref);
    value = ASSISTANT_DEVICE;
  } else {
    value = normalizeAssistant(next);
  }
  if (!value) return false;
  const target = assistantTarget(value);
  if (target?.provider === 'nvidia' && target.model !== LOCAL_ANY_MODEL) stored = setNvidiaModel(target.model) && stored;
  assistant = value;
  mode = computeModeOf(value);
  stored = writeLocal(STORAGE_KEYS.assistant, value) && stored;
  writeLocal(STORAGE_KEYS.computeMode, mode);
  for (const fn of assistantListeners) fn(value);
  for (const fn of modeListeners) fn(mode);
  return stored;
}

/** @param {(value: AssistantValue) => void} fn */
export function onAssistantChange(fn) {
  assistantListeners.add(fn);
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
  const stored = writeLocal(STORAGE_KEYS.llmUrl, next);
  for (const fn of llmUrlListeners) fn(next);
  return stored;
}

/** @type {Set<(url: string) => void>} */
const llmUrlListeners = new Set();

/** @param {(url: string) => void} fn  called when the own server's address changes */
export function onLlmUrlChange(fn) {
  llmUrlListeners.add(fn);
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

let webSearch = readLocal(STORAGE_KEYS.webSearch) === 'on';
/** @type {Set<(on: boolean) => void>} */
const webListeners = new Set();

/** Whether answers may search the web (the composer's Web toggle; default off). */
export function getWebSearch() {
  return webSearch;
}

/**
 * @param {boolean} on
 * @returns {boolean} whether the choice was also stored for the next visit
 */
export function setWebSearch(on) {
  webSearch = Boolean(on);
  const stored = webSearch ? writeLocal(STORAGE_KEYS.webSearch, 'on') : (removeLocal(STORAGE_KEYS.webSearch), readLocal(STORAGE_KEYS.webSearch) === null);
  for (const fn of webListeners) fn(webSearch);
  return stored;
}

/** @param {(on: boolean) => void} fn */
export function onWebSearchChange(fn) {
  webListeners.add(fn);
}
