// @ts-check
// OpenAI-shaped speech APIs: transcription (POST /v1/audio/transcriptions, a multipart form) and
// speech (POST /v1/audio/speech, JSON in, raw PCM out). OpenAI itself is used with the user's key
// through the transport the key settings choose (direct, or the site's relay); Groq (groq.js) and
// local voice servers (local.js) speak the same shape, so the form and the answer handling live here.
import { selectTransport } from '../../ai/transport-select.js';
import { DEFAULT_OPENAI_VOICE, LIMITS, OPENAI_VOICES, SPEECH_MODELS } from '../catalog.js';
import { SpeechError } from '../tts.js';
import { bytesToPcm16 } from '../wav.js';
import { asSourceError, checkResponse, langOf, pcmPlayable, SttError } from './shared.js';

/** @typedef {import('./shared.js').SourceContext} SourceContext */
/** @typedef {import('./shared.js').SttSource} SttSource */
/** @typedef {import('./shared.js').TtsSource} TtsSource */

/**
 * The multipart form of a transcription.
 * @param {{ wav: Uint8Array, model: string, locale: string, glossary: readonly string[], glossaryField?: boolean }} input
 *   glossaryField: also send the terms as a `glossary` field (local voice servers read it)
 */
export function transcriptionForm({ wav, model, locale, glossary, glossaryField = false }) {
  const form = new FormData();
  form.append('file', new Blob([/** @type {BlobPart} */ (wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  form.append('language', langOf(locale));
  form.append('response_format', 'json');
  // The prompt steers spelling; a short list of the user's own terms is what it is meant for.
  if (glossary.length) form.append('prompt', glossary.join(', '));
  if (glossaryField && glossary.length) form.append('glossary', glossary.join('\n'));
  return form;
}

/**
 * The text of a transcription answer ({ text } as JSON, or plain text).
 * @param {Response} res
 */
export async function transcriptText(res) {
  const type = res.headers.get('content-type') ?? '';
  const raw = /json/i.test(type) ? (await res.json())?.text : await res.text();
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, LIMITS.transcriptChars) : '';
}

/**
 * Transcribes with a provider of the AI layer (openai, groq) and the user's key.
 * @param {'openai' | 'groq'} provider
 * @param {string} model
 * @param {Uint8Array} wav
 * @param {import('./shared.js').TranscribeOptions} options
 * @param {SourceContext} ctx
 */
export async function transcribeWith(provider, model, wav, { locale, glossary, signal }, ctx) {
  const transport = selectTransport(provider, { key: ctx.getKey(provider), pool: false, fetch: ctx.fetch, origin: ctx.origin, access: ctx.access });
  if (!transport) throw new SttError('auth');
  try {
    const res = checkResponse(await transport(null, { path: '/v1/audio/transcriptions', method: 'POST', body: transcriptionForm({ wav, model, locale, glossary }) }, { signal }), 'stt');
    return await transcriptText(res);
  } catch (err) {
    throw asSourceError(err, 'stt', signal);
  }
}

/** @type {SttSource} */
export const openaiStt = {
  id: 'openai',
  local: false,
  available: (ctx) => !ctx.onDevice() && ctx.getKey('openai').trim() !== '',
  transcribe: (wav, options, ctx) => transcribeWith('openai', SPEECH_MODELS.openaiStt, wav, options, ctx),
};

/** @type {TtsSource} */
export const openaiTts = {
  id: 'openai',
  local: false,
  available: (ctx) => !ctx.onDevice() && ctx.getKey('openai').trim() !== '',
  engine: (ctx) => ({
    id: 'openai',
    async prepare(text, { voice, rate, signal }) {
      const transport = selectTransport('openai', { key: ctx.getKey('openai'), pool: false, fetch: ctx.fetch, origin: ctx.origin, access: ctx.access });
      if (!transport) throw new SpeechError('auth');
      const body = { model: SPEECH_MODELS.openaiTts, input: text, voice: voice && OPENAI_VOICES.includes(voice) ? voice : DEFAULT_OPENAI_VOICE, response_format: 'pcm', speed: rate };
      try {
        const res = checkResponse(await transport(null, { path: '/v1/audio/speech', method: 'POST', body }, { signal }), 'speech');
        const samples = bytesToPcm16(new Uint8Array(await res.arrayBuffer()));
        if (samples.length === 0) throw new SpeechError('failed', 'no audio');
        // pcm answers are 24 kHz mono PCM16.
        return pcmPlayable(ctx.playback(), samples, 24_000);
      } catch (err) {
        throw asSourceError(err, 'speech', signal);
      }
    },
  }),
  voices: async () => OPENAI_VOICES.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
};
