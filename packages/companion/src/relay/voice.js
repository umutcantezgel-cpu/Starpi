// @ts-check
// The client of the local voice server: the OpenAI-shaped routes a voice server on this machine
// offers (speech recognition with a Whisper-class model, speech output with installed voices):
//   GET  <server>/v1/audio/voices
//   POST <server>/v1/audio/speech           JSON -> audio/wav
//   POST <server>/v1/audio/transcriptions   multipart/form-data -> JSON { text }
// The address must be loopback; redirects are refused; answers are read up to a size. Audio, text
// and transcripts only pass through: nothing is stored, and errors carry statuses, never content.
import { fail } from '../lib/errors.js';
import { parseLoopbackUrl } from '../setup/loopback.js';

export const VOICES_TIMEOUT_MS = 5_000;
export const SPEECH_TIMEOUT_MS = 60_000;
export const TRANSCRIBE_TIMEOUT_MS = 120_000;
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_BYTES = 512 * 1024;

/**
 * Reads a body up to a size.
 * @param {Response} response
 * @param {number} max
 */
async function readCapped(response, max) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw fail('voice_too_large', 'the voice server sent more than expected', { status: 502 });
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/**
 * @param {string} url  e.g. http://127.0.0.1:8000 (with or without /v1)
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createVoiceClient(url, { fetchImpl = globalThis.fetch } = {}) {
  const target = parseLoopbackUrl(url, 'modules.voice.url');
  const root = target.url.replace(/\/v1$/, '');

  /**
   * @param {string} path
   * @param {RequestInit & { timeoutMs: number }} init
   * @param {AbortSignal | undefined} signal
   */
  async function send(path, { timeoutMs, ...init }, signal) {
    const limit = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, limit]) : limit });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (limit.aborted) throw fail('voice_timeout', 'the voice server did not answer in time', { status: 504, cause: err });
      throw fail('voice_unreachable', 'the voice server could not be reached', { status: 502, cause: err });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw fail(response.status === 429 ? 'voice_busy' : 'voice_failed', `the voice server answered ${response.status}`, { status: response.status === 429 ? 429 : 502, details: { providerStatus: response.status } });
    }
    return response;
  }

  /** @param {Response} response */
  async function json(response) {
    try {
      return JSON.parse((await readCapped(response, MAX_JSON_BYTES)).toString('utf8'));
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'voice_too_large') throw err;
      throw fail('voice_bad_answer', 'the voice server sent no JSON', { status: 502 });
    }
  }

  return {
    url: root,
    /** @param {AbortSignal} [signal] */
    async voices(signal) {
      return json(await send('/v1/audio/voices', { method: 'GET', headers: { accept: 'application/json' }, timeoutMs: VOICES_TIMEOUT_MS }, signal));
    },
    /**
     * @param {{ model?: string, input: string, voice?: string, speed?: number }} request
     * @param {AbortSignal} [signal]
     */
    async speech(request, signal) {
      const response = await send('/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'audio/wav' }, body: JSON.stringify({ ...request, response_format: 'wav' }), timeoutMs: SPEECH_TIMEOUT_MS }, signal);
      const audio = await readCapped(response, MAX_AUDIO_BYTES);
      if (audio.length < 12 || audio.toString('latin1', 0, 4) !== 'RIFF' || audio.toString('latin1', 8, 12) !== 'WAVE') throw fail('voice_bad_answer', 'the voice server sent no WAV audio', { status: 502 });
      return audio;
    },
    /**
     * @param {Buffer} body          the multipart form as the app sent it
     * @param {string} contentType   with its boundary
     * @param {AbortSignal} [signal]
     */
    async transcribe(body, contentType, signal) {
      return json(await send('/v1/audio/transcriptions', { method: 'POST', headers: { 'content-type': contentType, accept: 'application/json' }, body, timeoutMs: TRANSCRIBE_TIMEOUT_MS }, signal));
    },
  };
}

/** @typedef {ReturnType<typeof createVoiceClient>} VoiceClient */
