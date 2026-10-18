// @ts-check
// ElevenLabs as a speech output source, with premade voices only: an id must be on the list of
// catalog.js (re-declared from ElevenLabs' public premade list), and with the user's key the
// account's own voice list must also call it premade. Nothing here can clone, design or upload a
// voice. With the user's key the browser calls ElevenLabs (direct, or through the site's relay
// when the service refuses browser calls); without one the site's speech route speaks with the
// site's key, when it has one.
import { selectTransport } from '../../ai/transport-select.js';
import { DEFAULT_ELEVENLABS_VOICE, ELEVENLABS_VOICES, isElevenLabsVoice, SPEECH_MODELS } from '../catalog.js';
import { apiSpeak, apiVoices } from '../client.js';
import { SpeechError } from '../tts.js';
import { bytesToPcm16 } from '../wav.js';
import { asSourceError, checkResponse, pcmPlayable, wavPlayable } from './shared.js';

/** @typedef {import('./shared.js').SourceContext} SourceContext */
/** @typedef {import('../catalog.js').VoiceEntry} VoiceEntry */

/** Raw PCM at 24 kHz, the rate every voice feature plays. */
const OUTPUT_FORMAT = 'pcm_24000';

/** @param {SourceContext} ctx */
const userKey = (ctx) => ctx.getKey('elevenlabs').trim();

/** @param {SourceContext} ctx */
const transportFor = (ctx) => selectTransport('elevenlabs', { key: userKey(ctx), fetch: ctx.fetch, origin: ctx.origin, access: ctx.access });

/**
 * The allowlisted voices an account's voice list (GET /v1/voices) calls premade.
 * @param {unknown} json
 * @returns {VoiceEntry[]}
 */
export function premadeVoices(json) {
  const listed = Array.isArray(/** @type {any} */ (json)?.voices) ? /** @type {any[]} */ (/** @type {any} */ (json).voices) : [];
  const premade = new Set(listed.filter((v) => v?.category === 'premade' && typeof v.voice_id === 'string').map((v) => v.voice_id));
  return ELEVENLABS_VOICES.filter((v) => premade.has(v.id));
}

/** @type {import('./shared.js').TtsSource} */
export const elevenlabsTts = {
  id: 'elevenlabs',
  local: false,
  available: (ctx) => !ctx.onDevice() && (userKey(ctx) !== '' || ctx.site()?.elevenlabsTts === true),
  engine: (ctx) => ({
    id: 'elevenlabs',
    async prepare(text, { voice, locale, signal }) {
      const id = voice && isElevenLabsVoice(voice) ? voice : DEFAULT_ELEVENLABS_VOICE;
      try {
        if (!userKey(ctx)) {
          const bytes = await apiSpeak({ text, source: 'elevenlabs', voice: id, locale }, { fetch: ctx.fetch, origin: ctx.origin, access: ctx.access, signal });
          return wavPlayable(ctx.playback(), bytes);
        }
        const transport = transportFor(ctx);
        if (!transport) throw new SpeechError('auth');
        const res = checkResponse(
          await transport(null, { path: `/v1/text-to-speech/${id}?output_format=${OUTPUT_FORMAT}`, method: 'POST', headers: { accept: 'audio/pcm' }, body: { text, model_id: SPEECH_MODELS.elevenlabsTts } }, { signal }),
          'speech',
        );
        const samples = bytesToPcm16(new Uint8Array(await res.arrayBuffer()));
        if (samples.length === 0) throw new SpeechError('failed', 'no audio');
        return pcmPlayable(ctx.playback(), samples, 24_000);
      } catch (err) {
        throw asSourceError(err, 'speech', signal);
      }
    },
  }),
  async voices(ctx) {
    try {
      if (userKey(ctx)) {
        const transport = transportFor(ctx);
        if (!transport) return [];
        const res = checkResponse(await transport(null, { path: '/v1/voices', method: 'GET', headers: { accept: 'application/json' } }, { signal: AbortSignal.timeout(10_000) }), 'speech');
        return premadeVoices(await res.json());
      }
      const site = await apiVoices({ fetch: ctx.fetch, origin: ctx.origin, access: ctx.access });
      return site.elevenlabs.voices.filter((v) => isElevenLabsVoice(v.id));
    } catch {
      return [...ELEVENLABS_VOICES];
    }
  },
};
