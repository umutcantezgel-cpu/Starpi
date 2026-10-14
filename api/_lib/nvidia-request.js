// @ts-check
// Validation of POST /api/chat/nvidia bodies and the upstream request built from them. The Python
// backend applies the same rules in the same order (backend/core/nvidia.py); both test suites run the
// shared vectors in backend/test_fixtures/nvidia_validation.json.
import { findNvidiaModel, NVIDIA_LIMITS } from '../../src/js/models/nvidia-catalog.js';

/** @typedef {import('../../src/js/models/nvidia-catalog.js').NvidiaModel} NvidiaModel */

const ROLES = ['system', 'user', 'assistant'];
// Only ASCII whitespace counts as blank, so JavaScript and Python agree on every string.
const BLANK = /^[\t\n\v\f\r ]*$/;

/**
 * @param {string} field
 * @returns {{ ok: false, status: 400, error: 'invalid_field', field: string }}
 */
const invalid = (field) => ({ ok: false, status: 400, error: 'invalid_field', field });

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} messages
 * @returns {Array<{ role: string, content: string }> | null} the messages with only role and content, or null
 */
function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > NVIDIA_LIMITS.maxMessages) return null;
  let total = 0;
  /** @type {Array<{ role: string, content: string }>} */
  const clean = [];
  for (const [index, message] of messages.entries()) {
    if (!isObject(message)) return null;
    const { role, content } = message;
    if (typeof role !== 'string' || !ROLES.includes(role) || (role === 'system' && index > 0)) return null;
    // Lengths in UTF-16 code units, as String#length counts them (the Python side counts the same way).
    if (typeof content !== 'string' || content.length > NVIDIA_LIMITS.maxMessageChars) return null;
    total += content.length;
    clean.push({ role, content });
  }
  const last = clean[clean.length - 1];
  if (total > NVIDIA_LIMITS.maxTotalChars || last.role !== 'user' || BLANK.test(last.content)) return null;
  return clean;
}

/**
 * Checks a chat request and builds the upstream body from the allowed fields only: every other client
 * field (tools, n, stop, stream, message names, ...) is dropped, and `stream: true` is always set.
 * The catalog's fixed `upstream` fields come first, so they can never override the validated ones.
 * @param {Record<string, unknown>} data parsed JSON object
 * @returns {{ ok: true, model: NvidiaModel, body: Record<string, unknown> }
 *   | { ok: false, status: 400, error: 'invalid_field' | 'model_not_allowed', field?: string }}
 */
export function validateChatRequest(data) {
  if (typeof data.model !== 'string') return invalid('model');
  const model = findNvidiaModel(data.model);
  if (!model) return { ok: false, status: 400, error: 'model_not_allowed' };

  const messages = validMessages(data.messages);
  if (!messages) return invalid('messages');

  const cap = Math.min(model.maxOutputTokens, NVIDIA_LIMITS.maxOutputTokens);
  let maxTokens = model.defaultMaxTokens;
  if (data.max_tokens !== undefined && data.max_tokens !== null) {
    if (!Number.isInteger(data.max_tokens) || /** @type {number} */ (data.max_tokens) < 1) return invalid('max_tokens');
    maxTokens = /** @type {number} */ (data.max_tokens);
  }

  /** @type {Record<string, unknown>} */
  const options = {};
  if (data.temperature !== undefined && data.temperature !== null) {
    if (!isNumber(data.temperature) || data.temperature < 0 || data.temperature > 2) return invalid('temperature');
    options.temperature = data.temperature;
  }
  if (data.top_p !== undefined && data.top_p !== null) {
    if (!isNumber(data.top_p) || data.top_p <= 0 || data.top_p > 1) return invalid('top_p');
    options.top_p = data.top_p;
  }

  return {
    ok: true,
    model,
    body: { ...model.upstream, model: model.id, messages, max_tokens: Math.min(maxTokens, cap), stream: true, ...options },
  };
}
