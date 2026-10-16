// @ts-check
// Why a model stopped, per provider dialect, mapped onto the contract's stop reasons:
// end_turn | max_tokens | tool_call | refusal | pause | cancelled | timeout | error.
// The tables are data so adapters and tests read the same mapping. A value no table knows maps to
// `error`: an unexplained stop is never reported as a finished answer.

/** @typedef {import('./contract.js').StopReason} StopReason */
/** @typedef {import('./errors.js').AiErrorCode} AiErrorCode */
/** @typedef {'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini' | 'local'} StopDialect */

/** Messages API `stop_reason`. `pause_turn` asks the caller to send the turn again to continue. */
export const ANTHROPIC_STOP_REASONS = /** @type {Readonly<Record<string, StopReason>>} */ (
  Object.freeze({
    end_turn: 'end_turn',
    stop_sequence: 'end_turn',
    max_tokens: 'max_tokens',
    model_context_window_exceeded: 'max_tokens',
    tool_use: 'tool_call',
    pause_turn: 'pause',
    refusal: 'refusal',
  })
);

/** Chat Completions `finish_reason`, including spellings OpenAI-compatible servers use. */
export const OPENAI_CHAT_FINISH_REASONS = /** @type {Readonly<Record<string, StopReason>>} */ (
  Object.freeze({
    stop: 'end_turn',
    end: 'end_turn',
    eos: 'end_turn',
    length: 'max_tokens',
    model_length: 'max_tokens',
    tool_calls: 'tool_call',
    tool_call: 'tool_call',
    function_call: 'tool_call',
    content_filter: 'refusal',
    abort: 'cancelled',
    error: 'error',
    insufficient_system_resource: 'error',
  })
);

/** Responses API `status` of the finished response. */
export const OPENAI_RESPONSES_STATUS = /** @type {Readonly<Record<string, StopReason>>} */ (
  Object.freeze({
    completed: 'end_turn',
    incomplete: 'max_tokens',
    failed: 'error',
    cancelled: 'cancelled',
  })
);

/** Responses API `incomplete_details.reason`. */
export const OPENAI_RESPONSES_INCOMPLETE_REASONS = /** @type {Readonly<Record<string, StopReason>>} */ (
  Object.freeze({
    max_output_tokens: 'max_tokens',
    max_tokens: 'max_tokens',
    content_filter: 'refusal',
  })
);

/** Gemini `finishReason` of a candidate. */
export const GEMINI_FINISH_REASONS = /** @type {Readonly<Record<string, StopReason>>} */ (
  Object.freeze({
    STOP: 'end_turn',
    MAX_TOKENS: 'max_tokens',
    SAFETY: 'refusal',
    RECITATION: 'refusal',
    LANGUAGE: 'refusal',
    BLOCKLIST: 'refusal',
    PROHIBITED_CONTENT: 'refusal',
    SPII: 'refusal',
    IMAGE_SAFETY: 'refusal',
    IMAGE_PROHIBITED_CONTENT: 'refusal',
    IMAGE_RECITATION: 'refusal',
    MALFORMED_FUNCTION_CALL: 'error',
    UNEXPECTED_TOOL_CALL: 'error',
    TOO_MANY_TOOL_CALLS: 'error',
    MISSING_THOUGHT_SIGNATURE: 'error',
    NO_IMAGE: 'error',
    IMAGE_OTHER: 'error',
    OTHER: 'error',
    FINISH_REASON_UNSPECIFIED: 'error',
  })
);

/** Gemini `promptFeedback.blockReason`: the prompt itself was declined. */
export const GEMINI_BLOCK_REASONS = /** @type {Readonly<Record<string, StopReason>>} */ (
  Object.freeze({
    SAFETY: 'refusal',
    BLOCKLIST: 'refusal',
    PROHIBITED_CONTENT: 'refusal',
    IMAGE_SAFETY: 'refusal',
    OTHER: 'refusal',
    BLOCK_REASON_UNSPECIFIED: 'refusal',
  })
);

/**
 * Local servers on their native endpoints (done reasons, stop types) and on their
 * OpenAI-compatible ones, which sometimes pass the native word through.
 */
export const LOCAL_STOP_REASONS = /** @type {Readonly<Record<string, StopReason>>} */ (
  Object.freeze({
    stop: 'end_turn',
    end: 'end_turn',
    eos: 'end_turn',
    eos_token: 'end_turn',
    stop_sequence: 'end_turn',
    word: 'end_turn',
    load: 'end_turn',
    length: 'max_tokens',
    limit: 'max_tokens',
    max_tokens: 'max_tokens',
    tool_calls: 'tool_call',
    tool_call: 'tool_call',
    function_call: 'tool_call',
    content_filter: 'refusal',
    abort: 'cancelled',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    unload: 'cancelled',
    timeout: 'timeout',
    error: 'error',
  })
);

/**
 * @param {Readonly<Record<string, StopReason>>} table
 * @param {unknown} raw
 * @returns {StopReason | null}
 */
function lookup(table, raw) {
  return typeof raw === 'string' && Object.hasOwn(table, raw) ? table[raw] : null;
}

/**
 * @param {unknown} raw Messages API stop_reason
 * @returns {StopReason}
 */
export function fromAnthropic(raw) {
  return lookup(ANTHROPIC_STOP_REASONS, raw) ?? 'error';
}

/**
 * A missing finish_reason (common on the last chunk of compatible servers) counts as a normal end.
 * Some servers report `stop` although the message carries tool calls; `hasToolCalls` corrects it.
 * @param {unknown} raw
 * @param {{ hasToolCalls?: boolean }} [context]
 * @returns {StopReason}
 */
export function fromOpenAiChat(raw, context = {}) {
  const mapped = raw === null || raw === undefined ? 'end_turn' : (lookup(OPENAI_CHAT_FINISH_REASONS, raw) ?? 'error');
  return mapped === 'end_turn' && context.hasToolCalls ? 'tool_call' : mapped;
}

/**
 * @param {unknown} status response.status
 * @param {unknown} [incompleteReason] response.incomplete_details.reason
 * @param {{ hasToolCalls?: boolean, refused?: boolean }} [context] `refused`: the output held a refusal part
 * @returns {StopReason}
 */
export function fromOpenAiResponses(status, incompleteReason, context = {}) {
  if (status === 'incomplete') return lookup(OPENAI_RESPONSES_INCOMPLETE_REASONS, incompleteReason) ?? 'max_tokens';
  const mapped = lookup(OPENAI_RESPONSES_STATUS, status) ?? 'error';
  if (mapped !== 'end_turn') return mapped;
  if (context.refused) return 'refusal';
  return context.hasToolCalls ? 'tool_call' : 'end_turn';
}

/**
 * Gemini reports STOP also when the turn ends in a function call; `hasToolCalls` corrects it. A
 * prompt block reason wins over the finish reason.
 * @param {unknown} finishReason
 * @param {{ hasToolCalls?: boolean, blockReason?: unknown }} [context]
 * @returns {StopReason}
 */
export function fromGemini(finishReason, context = {}) {
  if (context.blockReason !== undefined && context.blockReason !== null) return lookup(GEMINI_BLOCK_REASONS, context.blockReason) ?? 'refusal';
  const mapped = lookup(GEMINI_FINISH_REASONS, finishReason) ?? 'error';
  return mapped === 'end_turn' && context.hasToolCalls ? 'tool_call' : mapped;
}

/**
 * @param {unknown} raw
 * @param {{ hasToolCalls?: boolean }} [context]
 * @returns {StopReason}
 */
export function fromLocal(raw, context = {}) {
  const mapped = raw === null || raw === undefined ? 'end_turn' : (lookup(LOCAL_STOP_REASONS, typeof raw === 'string' ? raw.toLowerCase() : raw) ?? 'error');
  return mapped === 'end_turn' && context.hasToolCalls ? 'tool_call' : mapped;
}

/**
 * One entry point for every dialect. For `openai-responses`, `raw` is the response status and
 * `context.incompleteReason` the incomplete reason.
 * @param {StopDialect} dialect
 * @param {unknown} raw
 * @param {{ hasToolCalls?: boolean, refused?: boolean, blockReason?: unknown, incompleteReason?: unknown }} [context]
 * @returns {StopReason}
 */
export function mapStopReason(dialect, raw, context = {}) {
  switch (dialect) {
    case 'anthropic':
      return fromAnthropic(raw);
    case 'openai-chat':
      return fromOpenAiChat(raw, context);
    case 'openai-responses':
      return fromOpenAiResponses(raw, context.incompleteReason, context);
    case 'gemini':
      return fromGemini(raw, context);
    case 'local':
      return fromLocal(raw, context);
    default:
      return 'error';
  }
}

/**
 * The stop reason of a call that ended with an error.
 * @param {AiErrorCode} code
 * @returns {StopReason}
 */
export function stopReasonForError(code) {
  if (code === 'aborted') return 'cancelled';
  if (code === 'timeout') return 'timeout';
  if (code === 'refusal') return 'refusal';
  return 'error';
}

/**
 * i18n keys (namespace `ai`) of the note a view shows under an answer that did not end normally;
 * end_turn and tool_call need none.
 * @type {Readonly<Partial<Record<StopReason, string>>>}
 */
export const STOP_NOTE_KEYS = Object.freeze(
  /** @type {Partial<Record<StopReason, string>>} */ (Object.fromEntries(/** @type {const} */ (['max_tokens', 'refusal', 'pause', 'cancelled', 'timeout', 'error']).map((reason) => [reason, `ai.stop.${reason}`]))),
);
