// @ts-check
// Groq on its OpenAI-compatible endpoint (API root https://api.groq.com/openai). Reasoning text
// arrives in a `reasoning` field when the request asks for it parsed; usage comes in `x_groq` on
// the last chunk. The open GPT models take `include_reasoning` and a three-level
// `reasoning_effort`; the other reasoning models take `reasoning_format` ('parsed' shows the
// reasoning, 'hidden' drops it), and Qwen3 also turns thinking off with `reasoning_effort: 'none'`.
// These field names follow Groq's public reference; check them with `npm run providers:ping` when
// a model family changes.
import { defineQuirks, threeStepEffort } from './generic.js';

export const groqQuirks = defineQuirks({
  id: 'groq',
  reasoningFields: ['reasoning'],
  usageOf: (chunk) => chunk.x_groq?.usage,
  shape(body, req, caps) {
    if (caps.reasoning === 'none') return;
    const model = String(req.model).toLowerCase();
    const mode = req.thinking?.mode ?? 'auto';
    const show = req.thinking?.show ?? true;
    if (model.includes('gpt-oss')) {
      body.include_reasoning = show;
      if (mode !== 'auto') body.reasoning_effort = mode === 'off' ? 'low' : threeStepEffort(req, 'high');
      return;
    }
    body.reasoning_format = show && mode !== 'off' ? 'parsed' : 'hidden';
    if (model.includes('qwen3') && mode === 'off') body.reasoning_effort = 'none';
  },
});
