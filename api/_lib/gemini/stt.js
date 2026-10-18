// @ts-check
// Speech input with Gemini and the site's keys (POST /api/voice/transcribe). The recording arrives
// as a 16 kHz mono WAV (base64 in the JSON body); it is checked before any call: a readable PCM16
// WAV, not shorter than a tap and not longer than LIMITS.utteranceSec. The instruction and the
// reading of the answer follow src/js/voice/gemini-wire.js; the only vocabulary hint is the user's
// own glossary. Neither the audio nor the transcript is stored or logged.
import { LIMITS } from '../../../src/js/voice/catalog.js';
import { blockedReason, parseGlossary, readTranscript, transcriptionRequest } from '../../../src/js/voice/gemini-wire.js';
import { base64ToBytes, decodeWav } from '../../../src/js/voice/wav.js';
import { geminiCall } from './client.js';

/**
 * @typedef {import('./client.js').KeyRing} KeyRing
 * @typedef {import('./client.js').FetchLike} FetchLike
 */

/** Characters of base64 a recording may have (the WAV limit, plus padding). */
export const MAX_AUDIO_BASE64 = Math.ceil(LIMITS.maxWavBytes / 3) * 4 + 4;

/**
 * Decodes and checks a recording.
 * @param {unknown} audio base64 of a WAV file
 * @returns {{ ok: true, base64: string, seconds: number } | { ok: false, error: 'invalid_audio' | 'audio_too_long' | 'audio_too_short' }}
 */
export function checkRecording(audio) {
  if (typeof audio !== 'string' || audio.length === 0 || audio.length > MAX_AUDIO_BASE64) return { ok: false, error: typeof audio === 'string' && audio.length > MAX_AUDIO_BASE64 ? 'audio_too_long' : 'invalid_audio' };
  const bytes = base64ToBytes(audio);
  const wav = bytes ? decodeWav(bytes) : null;
  if (!bytes || !wav) return { ok: false, error: 'invalid_audio' };
  const seconds = wav.samples.length / wav.rate;
  if (seconds > LIMITS.utteranceSec + 0.5) return { ok: false, error: 'audio_too_long' };
  if (seconds * 1000 < LIMITS.minUtteranceMs) return { ok: false, error: 'audio_too_short' };
  return { ok: true, base64: audio.replace(/\s+/g, ''), seconds };
}

/**
 * @param {{ ring: KeyRing, root: string, model: string, audioBase64: string, locale: string, glossary: unknown, fetch: FetchLike, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true, text: string } | { ok: false, status: number, error: string, retryAfterS?: number }>}
 */
export async function geminiTranscribe({ ring, root, model, audioBase64, locale, glossary, fetch: send, signal }) {
  const body = transcriptionRequest({ audioBase64, locale, glossary: parseGlossary(glossary) });
  const result = await geminiCall({ ring, root, path: `/v1beta/models/${model}:generateContent`, body, fetch: send, signal });
  if (!result.ok) return result;
  if (blockedReason(result.json)) return { ok: false, status: 422, error: 'upstream_blocked' };
  return { ok: true, text: readTranscript(result.json) ?? '' };
}
