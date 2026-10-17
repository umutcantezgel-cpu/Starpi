// @ts-check
// /api/voice/speak (Vercel Function): text to speech for read-aloud.
// Until it is built, every method answers 501 with the JSON body { "error": "not_implemented" }, after
// the access code check when the site sets STARPI_ACCESS_CODE (api/_lib/access.js).
import { checkAccess, readAccessCode } from '../_lib/access.js';
import { readEnv } from '../_lib/env.js';
import { json, refuse } from '../_lib/guards.js';

/**
 * Whether this route serves requests; GET /api/health reports it as `voice.tts`.
 * @param {Record<string, string | undefined>} _env
 */
export const available = (_env) => false;

/** @param {Request} request */
async function notImplemented(request) {
  const denied = await checkAccess(request, readAccessCode(readEnv()));
  return denied ? refuse(denied) : json(501, { error: 'not_implemented' });
}

export {
  notImplemented as DELETE,
  notImplemented as GET,
  notImplemented as HEAD,
  notImplemented as OPTIONS,
  notImplemented as PATCH,
  notImplemented as POST,
  notImplemented as PUT,
};
