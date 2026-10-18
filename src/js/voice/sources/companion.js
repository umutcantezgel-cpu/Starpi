// @ts-check
// The paired companion (Starpi Core, the local companion) as a speech input source: it relays the
// voice server routes of local.js below <companion origin>/v1/voice, with the pairing token as a
// Bearer token, so speech stays on the user's machines. The companion's client code tells this
// module where the companion is (setCompanionVoiceLink); until then the source is unavailable.
import { serverTranscribe } from './local.js';
import { SttError } from './shared.js';

/** @typedef {import('./shared.js').CompanionLink} CompanionLink */

/** @type {CompanionLink | null} */
let link = null;

/**
 * Where the paired companion relays voice requests; null when it is not paired (or unpaired).
 * Only loopback http(s) origins are accepted.
 * @param {CompanionLink | null} next
 * @returns {boolean} whether the link was taken
 */
export function setCompanionVoiceLink(next) {
  if (!next) {
    link = null;
    return true;
  }
  let url;
  try {
    url = new URL(next.origin);
  } catch {
    return false;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:') || typeof next.token !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(next.token)) return false;
  link = Object.freeze({ origin: url.origin, token: next.token });
  return true;
}

/** The current companion link. */
export const companionVoiceLink = () => link;

/**
 * @param {import('./shared.js').SourceContext} ctx
 * @returns {import('./local.js').VoiceServer | null}
 */
const companionServer = (ctx) => {
  const current = ctx.companion();
  return current ? { base: `${current.origin}/v1/voice`, headers: { authorization: `Bearer ${current.token}` } } : null;
};

/** @type {import('./shared.js').SttSource} */
export const companionStt = {
  id: 'companion',
  local: true,
  available: (ctx) => companionServer(ctx) !== null,
  transcribe(wav, options, ctx) {
    const server = companionServer(ctx);
    if (!server) return Promise.reject(new SttError('unavailable'));
    return serverTranscribe(ctx, server, wav, options);
  },
};
