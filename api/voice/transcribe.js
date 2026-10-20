// @ts-check
// POST /api/voice/transcribe (Vercel Function): speech input with the site's Gemini keys, for users
// without a key of their own. Body: { audio: base64 of a 16 kHz mono PCM16 WAV of at most
// LIMITS.utteranceSec seconds, locale, glossary?: the user's own terms }. Answer: { text }. Checks
// in this order: origin, per-IP rate limit, access code, body and recording, Gemini configured, the
// client's daily count, the site's daily budget of transcribed seconds. Neither the recording nor
// the transcript is stored or logged.
import { LIMITS } from '../../src/js/voice/catalog.js';
import { checkRecording, geminiTranscribe, MAX_AUDIO_BASE64 } from '../_lib/gemini/stt.js';
import { json, methodNotAllowed, readJsonBody, refuse } from '../_lib/guards.js';
import { dailyGuard, geminiVoiceKeys, requestLocale, unknownField, voiceGuard, voiceRuntimeDeps } from '../_lib/voice-routes.js';

/** @typedef {import('../_lib/voice-routes.js').VoiceDeps} VoiceDeps */

/** The recording as base64 plus the other fields. */
export const TRANSCRIBE_BODY_BYTES = MAX_AUDIO_BASE64 + LIMITS.glossaryChars * 4 + 2048;
const FIELDS = Object.freeze(['audio', 'locale', 'glossary']);

/**
 * Whether this route serves requests (the site has Gemini keys for speech); GET /api/health reports
 * it as `voice.stt`.
 * @param {Record<string, string | undefined>} env
 */
export const available = (env) => geminiVoiceKeys(env).length > 0;

/**
 * @param {Request} request
 * @param {VoiceDeps} deps
 * @returns {Promise<Response>}
 */
export async function handleTranscribe(request, deps) {
  const front = await voiceGuard(request, deps);
  if (front) return refuse(front);
  const read = await readJsonBody(request, TRANSCRIBE_BODY_BYTES);
  if (!read.ok) return refuse(read);
  const body = read.data;
  const extra = unknownField(body, FIELDS);
  if (extra) return refuse({ status: 400, error: 'unknown_field', field: extra.slice(0, 40) });
  if (body.glossary !== undefined && (!Array.isArray(body.glossary) || body.glossary.length > LIMITS.glossaryTerms || body.glossary.some((t) => typeof t !== 'string'))) {
    return refuse({ status: 400, error: 'invalid_glossary', field: 'glossary' });
  }
  const recording = checkRecording(body.audio);
  if (!recording.ok) return refuse({ status: recording.error === 'audio_too_long' ? 413 : 400, error: recording.error, field: 'audio' });

  if (!deps.gemini) return refuse({ status: 503, error: 'voice_not_configured' });
  const day = dailyGuard(request, deps);
  if (day) return refuse(day);
  const budget = deps.budget.take('stt', recording.seconds);
  if (!budget.ok) return refuse({ status: 429, error: 'budget_exhausted', retryAfterS: budget.retryAfterS });

  const result = await geminiTranscribe({
    ring: deps.gemini.ring,
    root: deps.gemini.root,
    model: deps.gemini.models.stt,
    audioBase64: recording.base64,
    locale: requestLocale(body.locale),
    glossary: body.glossary ?? [],
    fetch: deps.fetch,
    signal: request.signal,
  });
  if (!result.ok) return refuse(result);
  return json(200, { text: result.text });
}

/** @param {Request} request */
export function POST(request) {
  return handleTranscribe(request, voiceRuntimeDeps());
}

function notAllowed() {
  return methodNotAllowed('POST');
}

export { notAllowed as DELETE, notAllowed as GET, notAllowed as HEAD, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as PUT };
