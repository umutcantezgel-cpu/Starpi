// @ts-check
// MiniMax on its OpenAI-compatible Chat Completions endpoint (API root https://api.minimax.io, as
// of 2026-10-20). Its models always think, and a request that asks for no thinking at all
// (`reasoning_effort: 'none'`, or a thinking switch set to disabled) is refused with HTTP 400, so
// neither is ever sent. The depth is `reasoning_effort`: low, medium, high, xhigh or max, and max
// when the request names none. Starpi's "thinking off" asks for low, the contract's other levels go
// across as they are, and a request without a thinking choice leaves the provider's default.
//
// The thinking streams in `reasoning_content` and becomes reasoning events; `content` holds only the
// answer. Content that still carries <think> tags is read as reasoning too, so no thinking text can
// end up in an answer. Because the thinking cannot be switched off, a short output limit could be
// spent before the answer starts: with thinking off, a request that names a limit gets
// LOW_EFFORT_RESERVE more (with thinking on, applyThinking already adds its own room).
import { defineQuirks } from './generic.js';

/** @typedef {import('../contract.js').AiRequest} AiRequest */

/** The effort levels the API takes. */
export const MINIMAX_EFFORTS = Object.freeze(/** @type {const} */ (['low', 'medium', 'high', 'xhigh', 'max']));
/** Output tokens added to a named limit when thinking is off (the low effort still thinks). */
export const LOW_EFFORT_RESERVE = 1024;

/**
 * The `reasoning_effort` a request sends, or null to leave the provider's default. Never 'none'.
 * @param {AiRequest} req
 * @returns {'low' | 'medium' | 'high' | 'max' | null}
 */
export function minimaxEffort(req) {
  const thinking = req.thinking;
  if (!thinking) return null;
  if (thinking.mode === 'off') return 'low';
  if (thinking.mode === 'on') return thinking.effort ?? 'high';
  return thinking.effort ?? null;
}

export const minimaxQuirks = defineQuirks({
  id: 'minimax',
  reasoningFields: ['reasoning_content'],
  thinkTags: true,
  shape(body, req, caps) {
    const effort = minimaxEffort(req);
    if (effort) body.reasoning_effort = effort;
    if (req.thinking?.mode === 'off' && typeof body.max_tokens === 'number') body.max_tokens = Math.min(caps.maxOutput, body.max_tokens + LOW_EFFORT_RESERVE);
  },
});
