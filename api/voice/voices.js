// @ts-check
// GET /api/voice/voices (Vercel Function): what the site offers with its own keys, as booleans and
// fixed voice lists only: { gemini: { tts, stt, live, voices }, elevenlabs: { tts, voices } }. The
// voices are the app's own lists (prebuilt Gemini voices, ElevenLabs premade voices); no key, key
// count or account detail ever appears. Same-origin GETs carry no Origin header, so only the per-IP
// rate limit and the access code apply. Every other method gets 405.
import { ELEVENLABS_VOICES, GEMINI_VOICES } from '../../src/js/voice/catalog.js';
import { json, methodNotAllowed, refuse } from '../_lib/guards.js';
import { voiceGuard, voiceRuntimeDeps } from '../_lib/voice-routes.js';

/** @typedef {import('../_lib/voice-routes.js').VoiceDeps} VoiceDeps */

/**
 * The offer of a site.
 * @param {VoiceDeps} deps
 */
export function voiceOffer(deps) {
  const gemini = deps.gemini !== null;
  const eleven = deps.elevenlabs !== null;
  return {
    gemini: { tts: gemini, stt: gemini, live: gemini, voices: gemini ? [...GEMINI_VOICES] : [] },
    elevenlabs: { tts: eleven, voices: eleven ? ELEVENLABS_VOICES.map((v) => ({ id: v.id, label: v.label })) : [] },
  };
}

/**
 * @param {Request} request
 * @param {VoiceDeps} deps
 */
export async function handleVoices(request, deps) {
  const front = await voiceGuard(request, deps, { origin: false });
  if (front) return refuse(front);
  return json(200, voiceOffer(deps));
}

/** @param {Request} request */
export function GET(request) {
  return handleVoices(request, voiceRuntimeDeps());
}

function notAllowed() {
  return methodNotAllowed('GET');
}

export { notAllowed as DELETE, notAllowed as HEAD, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as POST, notAllowed as PUT };
