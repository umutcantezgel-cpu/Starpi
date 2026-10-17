// @ts-check
// DeepSeek on its OpenAI-compatible endpoint. The reasoner streams `reasoning_content` before the
// answer; that text must never be sent back in later turns (the API refuses a history that carries
// it), and the adapter never replays reasoning of this dialect. Prompt cache hits are reported as
// `prompt_cache_hit_tokens`. The stream may start with keep-alive comments, which the event parser
// skips.
import { defineQuirks } from './generic.js';

export const deepseekQuirks = defineQuirks({
  id: 'deepseek',
  reasoningFields: ['reasoning_content'],
  replayReasoningDetails: false,
});
