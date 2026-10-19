// @ts-check
// A voice server on the user's own machine (Settings -> Voice -> local voice server): speech input
// with a Whisper-class model and speech output with Piper voices, over the OpenAI-shaped routes
//   GET  <server>/v1/audio/voices          the installed voices
//   POST <server>/v1/audio/transcriptions  multipart: file, model, language, prompt, glossary
//   POST <server>/v1/audio/speech          JSON { model, input, voice, response_format: 'wav', speed }
// The browser calls it directly (never through the site, which cannot reach the user's network).
// Only Piper voices of api/_lib/voice-allowlist.json are listed or spoken, whatever the server has
// installed. The companion (companion.js) relays the same routes.
import { isPiperVoice, LIMITS, piperVoicesFor, SPEECH_MODELS } from '../catalog.js';
import { SpeechError } from '../tts.js';
import { asSourceError, checkResponse, fetchFor, SttError, wavPlayable } from './shared.js';
import { transcriptionForm, transcriptText } from './openai.js';

/** @typedef {import('./shared.js').SourceContext} SourceContext */
/** @typedef {import('../catalog.js').VoiceEntry} VoiceEntry */

/**
 * @typedef {object} VoiceServer
 * @property {string} base                 API root without /v1
 * @property {Record<string, string>} headers  auth headers of the server (the companion's token or CSRF value)
 * @property {'omit' | 'same-origin'} [credentials]  cookies sent along: only to the companion that serves this page
 */

/**
 * The API root of a server address ("http://127.0.0.1:8000/v1" -> "http://127.0.0.1:8000").
 * @param {string} url
 */
export function serverRoot(url) {
  return String(url ?? '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * @param {SourceContext} ctx
 * @param {VoiceServer} server
 * @param {string} path
 * @param {RequestInit} init
 */
function serverFetch(ctx, server, path, init) {
  return fetchFor(ctx)(`${server.base}${path}`, { ...init, headers: { ...server.headers, ...(/** @type {Record<string, string>} */ (init.headers ?? {})) }, credentials: server.credentials ?? 'omit', redirect: 'error', cache: 'no-store' });
}

/**
 * Speech input through a voice server.
 * @param {SourceContext} ctx
 * @param {VoiceServer} server
 * @param {Uint8Array} wav
 * @param {import('./shared.js').TranscribeOptions} options
 */
export async function serverTranscribe(ctx, server, wav, { locale, glossary, signal }) {
  if (wav.byteLength > LIMITS.maxWavBytes) throw new SttError('refused', 'too long');
  try {
    const res = checkResponse(await serverFetch(ctx, server, '/v1/audio/transcriptions', { method: 'POST', body: transcriptionForm({ wav, model: 'whisper', locale, glossary, glossaryField: true }), signal }), 'stt');
    return await transcriptText(res);
  } catch (err) {
    throw asSourceError(err, 'stt', signal);
  }
}

/**
 * The allowlisted voices a server has installed ({ voices: [{ id } | "id"] } or { data: [...] }).
 * @param {unknown} json
 * @returns {string[]}
 */
export function installedVoices(json) {
  const list = /** @type {any} */ (json)?.voices ?? /** @type {any} */ (json)?.data;
  if (!Array.isArray(list)) return [];
  return list.map((v) => (typeof v === 'string' ? v : v?.id ?? v?.voice_id)).filter((id) => isPiperVoice(id));
}

/**
 * A speech engine of a voice server.
 * @param {SourceContext} ctx
 * @param {string} id      engine id
 * @param {() => VoiceServer | null} server
 * @returns {import('../tts.js').SpeechEngine}
 */
export function serverEngine(ctx, id, server) {
  return {
    id,
    async prepare(text, { voice, locale, rate, signal }) {
      const target = server();
      if (!target) throw new SpeechError('unavailable');
      const chosen = voice && isPiperVoice(voice) ? voice : (piperVoicesFor(locale)[0]?.id ?? null);
      if (!chosen) throw new SpeechError('no_voice');
      try {
        const body = JSON.stringify({ model: SPEECH_MODELS.piper, input: text, voice: chosen, response_format: 'wav', speed: rate });
        const res = checkResponse(await serverFetch(ctx, target, '/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'audio/wav' }, body, signal }), 'speech');
        return wavPlayable(ctx.playback(), new Uint8Array(await res.arrayBuffer()));
      } catch (err) {
        throw asSourceError(err, 'speech', signal);
      }
    },
  };
}

/**
 * The voices of a server for a language: installed and allowlisted.
 * @param {SourceContext} ctx
 * @param {VoiceServer | null} server
 * @param {string} locale
 * @returns {Promise<VoiceEntry[]>}
 */
export async function serverVoices(ctx, server, locale) {
  if (!server) return [];
  try {
    const res = checkResponse(await serverFetch(ctx, server, '/v1/audio/voices', { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }), 'speech');
    const installed = new Set(installedVoices(await res.json()));
    return piperVoicesFor(locale).filter((v) => installed.has(v.id)).map((v) => ({ id: v.id, label: v.label }));
  } catch {
    return [];
  }
}

/** @param {SourceContext} ctx @returns {VoiceServer | null} */
const localServer = (ctx) => {
  const url = ctx.settings().localUrl;
  return url ? { base: serverRoot(url), headers: {} } : null;
};

/** @type {import('./shared.js').SttSource} */
export const localStt = {
  id: 'local',
  local: true,
  available: (ctx) => localServer(ctx) !== null,
  transcribe(wav, options, ctx) {
    const server = localServer(ctx);
    if (!server) return Promise.reject(new SttError('unavailable'));
    return serverTranscribe(ctx, server, wav, options);
  },
};

/** @type {import('./shared.js').TtsSource} */
export const localTts = {
  id: 'local',
  local: true,
  available: (ctx) => localServer(ctx) !== null,
  engine: (ctx) => serverEngine(ctx, 'local', () => localServer(ctx)),
  voices: (ctx, locale) => serverVoices(ctx, localServer(ctx), locale),
};
