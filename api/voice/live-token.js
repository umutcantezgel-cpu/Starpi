// @ts-check
// POST /api/voice/live-token (Vercel Function): a single-use ephemeral token for one free Live
// conversation (api/_lib/gemini/live.js). Body: { voice: a prebuilt Gemini voice, locale,
// camera?: boolean }. With the header x-goog-api-key the token is minted from the user's own key,
// which is used for this one call and kept nowhere (stateless); without it the site's Gemini keys
// are used, within the client's daily count and the site's daily Live budget. A key is never taken
// from the URL: a request with one in its query is refused before anything else. Checks in this
// order: key in the URL, origin, per-IP rate limit, access code, body, then the key source.
// Answer: { token, wsUrl, model, setup, expiresAt, connectBy }.
import { isGeminiVoice, SPEECH_MODELS } from '../../src/js/voice/catalog.js';
import { createLiveToken } from '../_lib/gemini/live.js';
import { buildLiveSetup } from '../_lib/gemini/live-setup.js';
import { json, methodNotAllowed, readJsonBody, refuse } from '../_lib/guards.js';
import { dailyGuard, geminiVoiceKeys, requestLocale, unknownField, voiceGuard, voiceRuntimeDeps } from '../_lib/voice-routes.js';

/** @typedef {import('../_lib/voice-routes.js').VoiceDeps} VoiceDeps */

export const LIVE_TOKEN_BODY_BYTES = 1024;
const FIELDS = Object.freeze(['voice', 'locale', 'camera']);
/** A Gemini key as the user pastes it: one token of URL-safe characters. */
const USER_KEY = /^[A-Za-z0-9_-]{20,128}$/;
const KEY_IN_QUERY = /[?&](?:key|api[_-]?key|access[_-]?token)=/i;

/**
 * Whether the site can mint Live tokens with its own keys; GET /api/health reports it as
 * `voice.live`. (Tokens from a user's own key work on any site that serves this route.)
 * @param {Record<string, string | undefined>} env
 */
export const available = (env) => geminiVoiceKeys(env).length > 0;

/**
 * @param {Request} request
 * @param {VoiceDeps} deps
 * @returns {Promise<Response>}
 */
export async function handleLiveToken(request, deps) {
  if (KEY_IN_QUERY.test(new URL(request.url).search)) return refuse({ status: 400, error: 'key_in_query' });
  const front = await voiceGuard(request, deps);
  if (front) return refuse(front);
  const read = await readJsonBody(request, LIVE_TOKEN_BODY_BYTES);
  if (!read.ok) return refuse(read);
  const body = read.data;
  const extra = unknownField(body, FIELDS);
  if (extra) return refuse({ status: 400, error: 'unknown_field', field: extra.slice(0, 40) });
  if (!isGeminiVoice(body.voice)) return refuse({ status: 400, error: 'unknown_voice', field: 'voice' });
  if (body.camera !== undefined && typeof body.camera !== 'boolean') return refuse({ status: 400, error: 'invalid_camera', field: 'camera' });

  const userKey = (request.headers.get('x-goog-api-key') ?? '').trim();
  if (userKey && !USER_KEY.test(userKey)) return refuse({ status: 400, error: 'invalid_user_key' });
  if (!userKey) {
    if (!deps.gemini) return refuse({ status: 503, error: 'voice_not_configured' });
    const day = dailyGuard(request, deps);
    if (day) return refuse(day);
    const budget = deps.budget.take('live', 1);
    if (!budget.ok) return refuse({ status: 429, error: 'budget_exhausted', retryAfterS: budget.retryAfterS });
  }
  const model = deps.gemini?.models.live ?? SPEECH_MODELS.geminiLive;
  const root = deps.gemini && !userKey ? { root: deps.gemini.root, simulated: deps.gemini.simulated } : deps.geminiRoot;
  const setup = buildLiveSetup({ model, voice: /** @type {string} */ (body.voice), locale: requestLocale(body.locale) });
  const result = await createLiveToken({
    root: root.root,
    simulated: root.simulated,
    setup,
    model,
    now: deps.now(),
    fetch: deps.fetch,
    signal: request.signal,
    ...(userKey ? { userKey } : { ring: deps.gemini?.ring }),
  });
  if (!result.ok) return refuse(result);
  return json(200, result.value);
}

/** @param {Request} request */
export function POST(request) {
  return handleLiveToken(request, voiceRuntimeDeps());
}

function notAllowed() {
  return methodNotAllowed('POST');
}

export { notAllowed as DELETE, notAllowed as GET, notAllowed as HEAD, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as PUT };
