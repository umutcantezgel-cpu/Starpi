// @ts-check
// Optional access code for self-hosted sites. When STARPI_ACCESS_CODE is set, the relay, the pools,
// the voice routes and research steps answer only requests that carry the same code in the header
// x-starpi-access. The comparison hashes both values and compares the digests in constant time,
// so neither the length nor a matching prefix of the code shows in the response time. The code is
// never logged or echoed; GET /api/health only tells whether one is required.

export const ACCESS_HEADER = 'x-starpi-access';

/**
 * @typedef {import('./guards.js').Refusal} Refusal
 */

/**
 * The configured access code, or '' when the site has none.
 * @param {Record<string, string | undefined>} env
 */
export function readAccessCode(env) {
  return (env.STARPI_ACCESS_CODE ?? '').trim();
}

/** @param {string} text */
async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * Constant-time equality of two strings (over their SHA-256 digests).
 * @param {string} given
 * @param {string} expected
 */
export async function sameSecret(given, expected) {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Null when the request may pass: no code configured, or the header carries it.
 * @param {Request} request
 * @param {string} code the configured code ('' for none)
 * @returns {Promise<Refusal | null>}
 */
export async function checkAccess(request, code) {
  if (!code) return null;
  const given = request.headers.get(ACCESS_HEADER);
  if (!given) return { status: 401, error: 'access_required' };
  return (await sameSecret(given.trim(), code)) ? null : { status: 401, error: 'access_denied' };
}
