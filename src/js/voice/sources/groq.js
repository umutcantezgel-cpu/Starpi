// @ts-check
// Groq's hosted Whisper as a speech input source, with the user's key. Groq may refuse browser
// calls; the transport then sends the request once more through the site's relay and remembers
// that (ai/transport-select.js), as for Groq's chat models.
import { SPEECH_MODELS } from '../catalog.js';
import { transcribeWith } from './openai.js';

/** @type {import('./shared.js').SttSource} */
export const groqStt = {
  id: 'groq',
  local: false,
  available: (ctx) => !ctx.onDevice() && ctx.getKey('groq').trim() !== '',
  transcribe: (wav, options, ctx) => transcribeWith('groq', SPEECH_MODELS.groqStt, wav, options, ctx),
};
