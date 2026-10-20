// @ts-check
// Speech output with ElevenLabs and the site's keys: premade voices only (the app's list in
// src/js/voice/catalog.js, and the account must still call the voice premade), raw 24 kHz PCM from
// the service, returned as a WAV file. Nothing can clone, design or upload a voice here.
import { isElevenLabsVoice } from '../../../src/js/voice/catalog.js';
import { bytesToPcm16, encodeWav } from '../../../src/js/voice/wav.js';
import { sendWithRing } from '../gemini/client.js';

/**
 * @typedef {import('./client.js').ElevenLabsAccount} ElevenLabsAccount
 * @typedef {import('../gemini/client.js').FetchLike} FetchLike
 */

/**
 * @param {{ account: ElevenLabsAccount, model: string, text: string, voice: string, locale: string, fetch: FetchLike, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true, wav: Uint8Array } | { ok: false, status: number, error: string, retryAfterS?: number }>}
 */
export async function elevenlabsSpeak({ account, model, text, voice, locale, fetch: send, signal }) {
  if (!isElevenLabsVoice(voice)) return { ok: false, status: 400, error: 'unknown_voice' };
  const premade = await account.premade(send, signal);
  if (premade && !premade.has(voice)) return { ok: false, status: 400, error: 'unknown_voice' };
  const lang = String(locale ?? '').slice(0, 2).toLowerCase();
  const result = await sendWithRing({
    ring: account.ring,
    authHeader: 'xi-api-key',
    fetch: send,
    request: {
      url: `${account.root}/v1/text-to-speech/${voice}?output_format=pcm_24000`,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/pcm' },
      body: JSON.stringify({ text, model_id: model, ...(/^[a-z]{2}$/.test(lang) && model.includes('flash') ? { language_code: lang } : {}) }),
    },
    signal,
  });
  if (!result.ok) return result;
  const samples = bytesToPcm16(result.bytes);
  if (samples.length === 0) return { ok: false, status: 502, error: 'upstream_no_audio' };
  return { ok: true, wav: encodeWav(samples, 24_000) };
}
