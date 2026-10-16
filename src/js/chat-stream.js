// @ts-check
// Pure helpers for streamed chat completions: an assembler for OpenAI-compatible completion chunks
// and the split of model output into reasoning and answer, plus the text/event-stream parser
// re-exported from ai/sse.js. No DOM and no I/O, so the browser client and the unit tests share them.

// The event-stream parser lives in ai/sse.js now; it is re-exported here so existing imports keep working.
export { createSseParser, MAX_SSE_BUFFER_CHARS } from './ai/sse.js';

/** Longest answer (content plus reasoning) the assembler accepts. */
export const MAX_STREAM_CHARS = 200_000;

/**
 * An error code as a short identifier; anything else (such as server text) is replaced.
 * @param {unknown} value
 */
function errorCode(value) {
  return typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'stream_error';
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @typedef {object} ChatStreamAssembler
 * @property {(data: string) => boolean} push  feeds one event's data; true when the visible text changed
 * @property {(code: unknown) => void} fail     records an error event (only its code is kept)
 * @property {() => string} text                the answer so far, reasoning wrapped in <think>
 * @property {string} content
 * @property {string} reasoning
 * @property {string | null} finishReason
 * @property {boolean} done                     `[DONE]` arrived
 * @property {string | null} error
 * @property {boolean} overflow                 the answer outgrew MAX_STREAM_CHARS
 */

/** Reasoning tags splitReasoning() looks for; a stray one inside the reasoning would end the block early. */
const REASONING_TAGS = /<\/?(?:think|thought|denkprozess)>/gi;

/**
 * The reasoning without reasoning tags. Applied to the whole text, not per delta, because a tag can
 * arrive split over two deltas.
 * @param {string} reasoning
 */
function visibleReasoning(reasoning) {
  return reasoning.replace(REASONING_TAGS, '');
}

/**
 * Folds OpenAI-compatible `chat.completion.chunk` events into an answer. Reasoning deltas
 * (`reasoning_content`, or `reasoning` on some servers) are kept apart from the content and
 * returned as a leading <think> block, the form splitReasoning() reads.
 * @returns {ChatStreamAssembler}
 */
export function createChatStreamAssembler() {
  let content = '';
  let reasoning = '';
  /** @type {string | null} */
  let finishReason = null;
  let done = false;
  /** @type {string | null} */
  let error = null;
  let overflow = false;

  /** @param {unknown} code */
  const fail = (code) => {
    error = errorCode(code);
  };

  return {
    push(data) {
      if (data.trim() === '[DONE]') {
        done = true;
        return false;
      }
      let chunk;
      try {
        chunk = record(JSON.parse(data));
      } catch {
        return false;
      }
      if (!chunk) return false;
      if (chunk.error) {
        const err = record(chunk.error);
        fail(err ? err.code : chunk.error);
        return false;
      }
      // Usage chunks carry `choices: []`.
      const choice = Array.isArray(chunk.choices) ? record(chunk.choices[0]) : null;
      if (!choice) return false;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason.slice(0, 40);
      const delta = record(choice.delta);
      if (!delta) return false;
      const before = content.length + reasoning.length;
      if (typeof delta.content === 'string') content += delta.content;
      const thought = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
      reasoning += thought;
      const after = content.length + reasoning.length;
      if (after > MAX_STREAM_CHARS) overflow = true;
      return after !== before;
    },
    fail,
    text() {
      const thoughts = visibleReasoning(reasoning);
      return thoughts.trim() ? `<think>${thoughts}</think>\n\n${content}` : content;
    },
    get content() {
      return content;
    },
    get reasoning() {
      return visibleReasoning(reasoning);
    },
    get finishReason() {
      return finishReason;
    },
    get done() {
      return done;
    },
    get error() {
      return error;
    },
    get overflow() {
      return overflow;
    },
  };
}

/**
 * Splits model output into an optional reasoning part (<think>, <thought>, <denkprozess>) and the answer.
 * @param {string} rawText
 */
export function splitReasoning(rawText) {
  const text = String(rawText ?? '');
  const tags = [/<denkprozess>([\s\S]*?)<\/denkprozess>/i, /<(?:thought|think)>([\s\S]*?)<\/(?:thought|think)>/i];
  for (const re of tags) {
    const match = text.match(re);
    if (match) {
      return { thoughts: match[1].trim(), answer: text.replace(re, '').replace(/<\/?antwort>/gi, '').trim() };
    }
  }
  return { thoughts: '', answer: text.replace(/<\/?antwort>/gi, '').trim() };
}

/**
 * The visible part of a reply while it streams. `thinking` is true while the reply holds reasoning
 * but no answer yet: a leading <think>/<thought>/<denkprozess> that is still open, or one that was
 * closed before any answer text arrived.
 * @param {string} text
 * @returns {{ answer: string, thinking: boolean }}
 */
export function splitStreamingText(text) {
  if (/<\/(?:think|thought|denkprozess)>/i.test(text)) {
    const answer = splitReasoning(text).answer;
    return { answer, thinking: !answer };
  }
  if (/^\s*<(?:think|thought|denkprozess)>/i.test(text)) return { answer: '', thinking: true };
  return { answer: splitReasoning(text).answer, thinking: false };
}
