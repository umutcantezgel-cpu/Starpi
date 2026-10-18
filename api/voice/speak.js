// @ts-check
// POST /api/voice/speak (Vercel Function): speech output with the site's keys, for read-aloud and
// Live when the user has no key of their own. Body: { text, source: 'gemini' | 'elevenlabs', voice,
// locale? }; text is one piece of at most LIMITS.speakChars characters (the browser's speech queue
// splits longer text and sends only sentences a gate released). The answer is a WAV file (PCM16
// mono, 24 kHz). Checks in this order: origin, per-IP rate limit, access code, body, the source is
// configured, the voice is on the app's list, the client's daily count, the site's daily character
// budget. Neither the text nor the audio is stored or logged.
import { isElevenLabsVoice, isGeminiVoice, LIMITS } from '../../src/js/voice/catalog.js';
import { elevenlabsSpeak } from '../_lib/elevenlabs/tts.js';
import { geminiSpeak } from '../_lib/gemini/tts.js';
import { methodNotAllowed, readJsonBody, refuse } from '../_lib/guards.js';
import { dailyGuard, elevenlabsVoiceKeys, geminiVoiceKeys, requestLocale, unknownField, voiceGuard, voiceRuntimeDeps } from '../_lib/voice-routes.js';

/** @typedef {import('../_lib/voice-routes.js').VoiceDeps} VoiceDeps */

/** A speech request is one short piece of text. */
export const SPEAK_BODY_BYTES = 8_192;
const FIELDS = Object.freeze(['text', 'source', 'voice', 'locale']);

/**
 * Whether this route serves requests (the site has Gemini or ElevenLabs keys for speech); GET
 * /api/health reports it as `voice.tts`.
 * @param {Record<string, string | undefined>} env
 */
export const available = (env) => geminiVoiceKeys(env).length > 0 || elevenlabsVoiceKeys(env).length > 0;

/**
 * @param {Request} request
 * @param {VoiceDeps} deps
 * @returns {Promise<Response>}
 */
export async function handleSpeak(request, deps) {
  const front = await voiceGuard(request, deps);
  if (front) return refuse(front);
  const read = await readJsonBody(request, SPEAK_BODY_BYTES);
  if (!read.ok) return refuse(read);
  const body = read.data;
  const extra = unknownField(body, FIELDS);
  if (extra) return refuse({ status: 400, error: 'unknown_field', field: extra.slice(0, 40) });
  const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > LIMITS.speakChars) return refuse({ status: 400, error: 'invalid_text', field: 'text' });
  if (body.source !== 'gemini' && body.source !== 'elevenlabs') return refuse({ status: 400, error: 'invalid_source', field: 'source' });
  const voice = typeof body.voice === 'string' ? body.voice : '';
  if (body.source === 'gemini' ? !isGeminiVoice(voice) : !isElevenLabsVoice(voice)) return refuse({ status: 400, error: 'unknown_voice', field: 'voice' });
  const locale = requestLocale(body.locale);

  if (body.source === 'gemini' ? !deps.gemini : !deps.elevenlabs) return refuse({ status: 503, error: 'voice_not_configured' });
  const day = dailyGuard(request, deps);
  if (day) return refuse(day);
  const budget = deps.budget.take('tts', text.length);
  if (!budget.ok) return refuse({ status: 429, error: 'budget_exhausted', retryAfterS: budget.retryAfterS });

  const result =
    body.source === 'gemini' && deps.gemini
      ? await geminiSpeak({ ring: deps.gemini.ring, root: deps.gemini.root, model: deps.gemini.models.tts, text, voice, fetch: deps.fetch, signal: request.signal })
      : deps.elevenlabs
        ? await elevenlabsSpeak({ account: deps.elevenlabs.account, model: deps.elevenlabs.model, text, voice, locale, fetch: deps.fetch, signal: request.signal })
        : { ok: /** @type {const} */ (false), status: 503, error: 'voice_not_configured' };
  if (!result.ok) return refuse(result);
  return new Response(/** @type {BodyInit} */ (result.wav), { status: 200, headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** @param {Request} request */
export function POST(request) {
  return handleSpeak(request, voiceRuntimeDeps());
}

function notAllowed() {
  return methodNotAllowed('POST');
}

export { notAllowed as DELETE, notAllowed as GET, notAllowed as HEAD, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as PUT };
