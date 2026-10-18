// @ts-check
// Gemini as a speech source. With the user's own key the browser calls the Gemini API directly
// (it allows cross-origin calls; the key goes in its header, never in the URL). Without one the
// site's speech routes speak and transcribe with the site's keys, when the site offers that
// (GET /api/voice/voices). Requests and answers follow gemini-wire.js, the same as the routes.
import { selectTransport } from '../../ai/transport-select.js';
import { DEFAULT_GEMINI_VOICE, GEMINI_VOICES, SPEECH_MODELS } from '../catalog.js';
import { apiSpeak, apiTranscribe } from '../client.js';
import { blockedReason, readSpeech, readTranscript, speechRequest, transcriptionRequest } from '../gemini-wire.js';
import { SpeechError } from '../tts.js';
import { bytesToBase64 } from '../wav.js';
import { asSourceError, checkResponse, pcmPlayable, SttError, wavPlayable } from './shared.js';

/** @typedef {import('./shared.js').SourceContext} SourceContext */
/** @typedef {import('./shared.js').SttSource} SttSource */
/** @typedef {import('./shared.js').TtsSource} TtsSource */

/** @param {SourceContext} ctx */
const userKey = (ctx) => ctx.getKey('gemini').trim();

/**
 * Calls generateContent of a model with the user's key.
 * @param {SourceContext} ctx
 * @param {string} model
 * @param {unknown} body
 * @param {AbortSignal} signal
 * @param {'speech' | 'stt'} kind
 */
async function generate(ctx, model, body, signal, kind) {
  const transport = selectTransport('gemini', { key: userKey(ctx), pool: false, fetch: ctx.fetch, origin: ctx.origin });
  if (!transport) throw kind === 'speech' ? new SpeechError('auth') : new SttError('auth');
  const res = checkResponse(await transport(null, { path: `/v1beta/models/${model}:generateContent`, method: 'POST', body }, { signal }), kind);
  return res.json();
}

/** @type {SttSource} */
export const geminiStt = {
  id: 'gemini',
  local: false,
  available: (ctx) => !ctx.onDevice() && (userKey(ctx) !== '' || ctx.site()?.geminiStt === true),
  async transcribe(wav, { locale, glossary, signal }, ctx) {
    try {
      if (!userKey(ctx)) return await apiTranscribe({ wav, locale, glossary }, { fetch: ctx.fetch, origin: ctx.origin, access: ctx.access, signal });
      const json = await generate(ctx, SPEECH_MODELS.geminiStt, transcriptionRequest({ audioBase64: bytesToBase64(wav), locale, glossary }), signal, 'stt');
      if (blockedReason(json)) throw new SttError('refused', 'blocked');
      return readTranscript(json) ?? '';
    } catch (err) {
      throw asSourceError(err, 'stt', signal);
    }
  },
};

/** @type {TtsSource} */
export const geminiTts = {
  id: 'gemini',
  local: false,
  available: (ctx) => !ctx.onDevice() && (userKey(ctx) !== '' || ctx.site()?.geminiTts === true),
  engine: (ctx) => ({
    id: 'gemini',
    async prepare(text, { voice, locale, signal }) {
      const name = voice && GEMINI_VOICES.includes(voice) ? voice : DEFAULT_GEMINI_VOICE;
      try {
        if (!userKey(ctx)) {
          const bytes = await apiSpeak({ text, source: 'gemini', voice: name, locale }, { fetch: ctx.fetch, origin: ctx.origin, access: ctx.access, signal });
          return wavPlayable(ctx.playback(), bytes);
        }
        const json = await generate(ctx, SPEECH_MODELS.geminiTts, speechRequest({ text, voice: name }), signal, 'speech');
        const audio = readSpeech(json);
        if (!audio) throw new SpeechError(blockedReason(json) ? 'refused' : 'failed', 'no audio');
        return pcmPlayable(ctx.playback(), audio.samples, audio.rate);
      } catch (err) {
        throw asSourceError(err, 'speech', signal);
      }
    },
  }),
  voices: async () => GEMINI_VOICES.map((id) => ({ id, label: id })),
};
