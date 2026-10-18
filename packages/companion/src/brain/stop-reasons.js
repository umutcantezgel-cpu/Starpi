// @ts-check
// Why a model stopped, mapped from each provider's wording onto one small set. Normalising stop
// reasons into a provider-neutral vocabulary is an idea we first met in OpenClaw (MIT, see
// NOTICE); the tables here are written for the companion's dialects. Anything a table does not
// know becomes `error`: an unexplained stop is never reported as a finished answer.

/** @typedef {'end_turn' | 'max_tokens' | 'tool_call' | 'refusal' | 'cancelled' | 'timeout' | 'error'} StopReason */

/** @type {readonly StopReason[]} */
export const STOP_REASONS = Object.freeze(['end_turn', 'max_tokens', 'tool_call', 'refusal', 'cancelled', 'timeout', 'error']);

const OPENAI = Object.freeze({ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_call', function_call: 'tool_call', content_filter: 'refusal' });
const ANTHROPIC = Object.freeze({ end_turn: 'end_turn', stop_sequence: 'end_turn', pause_turn: 'end_turn', max_tokens: 'max_tokens', model_context_window_exceeded: 'max_tokens', tool_use: 'tool_call', refusal: 'refusal' });
const GEMINI = Object.freeze({ STOP: 'end_turn', MAX_TOKENS: 'max_tokens', SAFETY: 'refusal', RECITATION: 'refusal', BLOCKLIST: 'refusal', PROHIBITED_CONTENT: 'refusal', SPII: 'refusal', IMAGE_SAFETY: 'refusal', MALFORMED_FUNCTION_CALL: 'error', LANGUAGE: 'error', OTHER: 'error' });

/**
 * @param {'openai' | 'anthropic' | 'gemini'} dialect
 * @param {unknown} value
 * @returns {StopReason}
 */
export function mapStopReason(dialect, value) {
  const table = /** @type {Record<string, StopReason>} */ (dialect === 'openai' ? OPENAI : dialect === 'anthropic' ? ANTHROPIC : GEMINI);
  return typeof value === 'string' && Object.hasOwn(table, value) ? table[value] : 'error';
}
