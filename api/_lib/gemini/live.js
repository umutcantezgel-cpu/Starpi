// @ts-check
// Ephemeral Live tokens (POST /api/voice/live-token). The server asks the Gemini API for a token
// that is good for one session (POST <root>/v1alpha/auth_tokens): it must open its session within
// LIMITS.tokenConnectSec seconds, expires after LIMITS.tokenTtlMin minutes, and carries the whole
// setup (live-setup.js) without a field mask, so nothing of it can be changed by the browser. The
// key is the site's (round robin over its keys) or the user's own, which arrives in the
// x-goog-api-key header and is used for this one call only. The browser gets the token, the socket
// endpoint (Google's, or a loopback fake in tests) and the setup to send as its first message; it
// never sees a key, and no key ever goes into a URL.
import { LIMITS, liveEndpoint, isLiveSocketUrl } from '../../../src/js/voice/catalog.js';
import { sendOnce, sendWithRing } from './client.js';

/**
 * @typedef {import('./client.js').KeyRing} KeyRing
 * @typedef {import('./client.js').FetchLike} FetchLike
 * @typedef {{ token: string, wsUrl: string, model: string, setup: Record<string, unknown>, expiresAt: string, connectBy: string }} LiveToken
 */

/** The API version of the token endpoint and of the constrained Live socket. */
export const LIVE_API_VERSION = 'v1alpha';
/** A token name as the service issues it ("auth_tokens/…"). */
export const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{8,2048}$/;

/**
 * The auth_tokens body: one use, the start window, the expiry and the locked setup.
 * @param {Record<string, unknown>} setup
 * @param {number} now epoch ms
 */
export function tokenBody(setup, now) {
  return {
    uses: 1,
    expireTime: new Date(now + LIMITS.tokenTtlMin * 60_000).toISOString(),
    newSessionExpireTime: new Date(now + LIMITS.tokenConnectSec * 1000).toISOString(),
    bidiGenerateContentSetup: setup,
  };
}

/**
 * The socket endpoint for an API root: Google's, or ws(s) on a loopback fake.
 * @param {string} root
 * @param {boolean} simulated
 */
export function socketEndpoint(root, simulated) {
  return simulated ? liveEndpoint(LIVE_API_VERSION, root.replace(/^http/, 'ws')) : liveEndpoint(LIVE_API_VERSION);
}

/**
 * Mints a token, with the site's keys (`ring`) or the user's key (`userKey`).
 * @param {{ root: string, simulated: boolean, setup: Record<string, unknown>, model: string, now: number, fetch: FetchLike, signal?: AbortSignal, ring?: KeyRing, userKey?: string }} options
 * @returns {Promise<{ ok: true, value: LiveToken } | { ok: false, status: number, error: string, retryAfterS?: number }>}
 */
export async function createLiveToken({ root, simulated, setup, model, now, fetch: send, signal, ring, userKey }) {
  const request = /** @type {import('./client.js').UpstreamRequest} */ ({
    url: `${root}/${LIVE_API_VERSION}/auth_tokens`,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(tokenBody(setup, now)),
  });
  let result;
  if (userKey) {
    const once = await sendOnce({ key: userKey, authHeader: 'x-goog-api-key', fetch: send, request, signal, timeoutMs: 10_000, maxBytes: 64 * 1024 });
    // The user's own key: its failures are reported as they are, nothing is parked.
    result = once.ok ? once : { ok: /** @type {const} */ (false), status: once.error === 'upstream_auth' ? 401 : once.status, error: once.error === 'upstream_auth' ? 'user_key_refused' : once.error };
  } else if (ring) {
    result = await sendWithRing({ ring, authHeader: 'x-goog-api-key', fetch: send, request, signal, timeoutMs: 10_000, maxBytes: 64 * 1024 });
  } else return { ok: false, status: 503, error: 'voice_not_configured' };
  if (!result.ok) return result;
  let name;
  try {
    name = JSON.parse(new TextDecoder().decode(result.bytes))?.name;
  } catch {
    name = null;
  }
  if (typeof name !== 'string' || !TOKEN_PATTERN.test(name)) return { ok: false, status: 502, error: 'upstream_bad_response' };
  const wsUrl = socketEndpoint(root, simulated);
  if (!isLiveSocketUrl(wsUrl)) return { ok: false, status: 500, error: 'live_endpoint_refused' };
  return {
    ok: true,
    value: {
      token: name,
      wsUrl,
      model,
      setup,
      expiresAt: new Date(now + LIMITS.tokenTtlMin * 60_000).toISOString(),
      connectBy: new Date(now + LIMITS.tokenConnectSec * 1000).toISOString(),
    },
  };
}
