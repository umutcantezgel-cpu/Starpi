// @ts-check
// Speech output with Gemini and the site's keys (POST /api/voice/speak, source "gemini"): the
// request and the answer follow src/js/voice/gemini-wire.js, the same as a call with the user's
// own key; the PCM answer is returned as a WAV file.
import { readSpeech, speechRequest } from '../../../src/js/voice/gemini-wire.js';
import { encodeWav } from '../../../src/js/voice/wav.js';
import { geminiCall } from './client.js';

/**
 * @typedef {import('./client.js').KeyRing} KeyRing
 * @typedef {import('./client.js').FetchLike} FetchLike
 * @typedef {{ ok: true, wav: Uint8Array } | { ok: false, status: number, error: string, retryAfterS?: number }} SpeakResult
 */

/**
 * @param {{ ring: KeyRing, root: string, model: string, text: string, voice: string, fetch: FetchLike, signal?: AbortSignal }} options
 * @returns {Promise<SpeakResult>}
 */
export async function geminiSpeak({ ring, root, model, text, voice, fetch: send, signal }) {
  const result = await geminiCall({ ring, root, path: `/v1beta/models/${model}:generateContent`, body: speechRequest({ text, voice }), fetch: send, signal });
  if (!result.ok) return result;
  const audio = readSpeech(result.json);
  if (!audio) return { ok: false, status: 502, error: 'upstream_no_audio' };
  return { ok: true, wav: encodeWav(audio.samples, audio.rate) };
}
