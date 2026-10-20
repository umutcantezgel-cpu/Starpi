// @ts-check
// Calls to this site's speech routes (api/voice/*), which use the site's own keys: speech output
// (Gemini voices, ElevenLabs premade voices), speech input (Gemini), the voices on offer and Live
// tokens. The site's access code travels in its header when the user entered one. A route that is
// missing (a static host without functions) or refuses answers with a VoiceRouteError; nothing of
// an answer body other than an error code is kept.
import { ACCESS_HEADER } from '../ai/transport.js';
import { ACCESS_SLOT, getKey } from '../ai/keys.js';
import { withTimeoutSignal } from '../signals.js';
import { bytesToBase64 } from './wav.js';

/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike */

export const VOICE_ROUTES = Object.freeze({
  speak: '/api/voice/speak',
  transcribe: '/api/voice/transcribe',
  voices: '/api/voice/voices',
  liveToken: '/api/voice/live-token',
});

const TIMEOUT_MS = Object.freeze({ speak: 30_000, transcribe: 45_000, voices: 8_000, liveToken: 12_000 });
const MAX_ERROR_CHARS = 2048;

/** A refused or failed call to a speech route; `code` is the route's error code or a transport code. */
export class VoiceRouteError extends Error {
  /**
   * @param {string} code
   * @param {number} status 0 when no answer arrived
   * @param {number} [retryAfterS]
   */
  constructor(code, status, retryAfterS) {
    super(code);
    this.name = 'VoiceRouteError';
    this.code = code;
    this.status = status;
    this.retryAfterS = retryAfterS ?? null;
  }
}

/**
 * @typedef {object} ClientDeps
 * @property {FetchLike} [fetch]
 * @property {() => string} [access]   the site's access code ('' for none)
 * @property {string} [origin]         prefix for the route paths (tests)
 */

/**
 * @param {ClientDeps} deps
 * @returns {FetchLike}
 */
const fetchOf = (deps) => deps.fetch ?? ((input, init) => globalThis.fetch(input, init));

/**
 * @param {ClientDeps} deps
 * @param {Record<string, string>} headers
 */
function withAccess(deps, headers) {
  const code = (deps.access ?? (() => getKey(ACCESS_SLOT)))().trim();
  if (code && /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/.test(code)) headers[ACCESS_HEADER] = code;
  return headers;
}

/**
 * @param {Response} res
 * @returns {Promise<VoiceRouteError>}
 */
async function routeError(res) {
  const type = res.headers.get('content-type') ?? '';
  let code = res.status === 404 || res.status === 405 || /^text\/html/i.test(type) ? 'route_missing' : `http_${res.status}`;
  if (/json/i.test(type)) {
    try {
      const body = JSON.parse((await res.text()).slice(0, MAX_ERROR_CHARS));
      if (typeof body?.error === 'string' && /^[a-z_]{1,40}$/.test(body.error)) code = body.error;
    } catch {
      // keep the status code
    }
  } else void res.body?.cancel().catch(() => {});
  const retry = Number(res.headers.get('retry-after'));
  return new VoiceRouteError(code, res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
}

/**
 * @param {string} path
 * @param {RequestInit & { timeoutMs: number, signal?: AbortSignal }} init
 * @param {ClientDeps} deps
 */
async function call(path, init, deps) {
  const { timeoutMs, ...rest } = init;
  let res;
  try {
    res = await fetchOf(deps)(`${deps.origin ?? ''}${path}`, { ...rest, signal: withTimeoutSignal(init.signal, timeoutMs), credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new VoiceRouteError(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network', 0);
  }
  if (!res.ok) throw await routeError(res);
  return res;
}

/**
 * Speech output through the site: WAV bytes (PCM16 mono).
 * @param {{ text: string, source: 'gemini' | 'elevenlabs', voice: string, locale: string }} input
 * @param {ClientDeps & { signal?: AbortSignal }} [deps]
 * @returns {Promise<Uint8Array>}
 */
export async function apiSpeak(input, deps = {}) {
  const res = await call(VOICE_ROUTES.speak, { method: 'POST', headers: withAccess(deps, { 'content-type': 'application/json', accept: 'audio/wav' }), body: JSON.stringify(input), timeoutMs: TIMEOUT_MS.speak, signal: deps.signal }, deps);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Speech input through the site (Gemini with the site's keys).
 * @param {{ wav: Uint8Array, locale: string, glossary?: readonly string[] }} input
 * @param {ClientDeps & { signal?: AbortSignal }} [deps]
 * @returns {Promise<string>}
 */
export async function apiTranscribe(input, deps = {}) {
  const body = JSON.stringify({ audio: bytesToBase64(input.wav), locale: input.locale, ...(input.glossary?.length ? { glossary: input.glossary } : {}) });
  const res = await call(VOICE_ROUTES.transcribe, { method: 'POST', headers: withAccess(deps, { 'content-type': 'application/json' }), body, timeoutMs: TIMEOUT_MS.transcribe, signal: deps.signal }, deps);
  const json = await res.json();
  return typeof json?.text === 'string' ? json.text : '';
}

/**
 * @typedef {object} SiteVoices
 * @property {{ tts: boolean, stt: boolean, live: boolean, voices: string[] }} gemini
 * @property {{ tts: boolean, voices: Array<{ id: string, label: string }> }} elevenlabs
 */

/**
 * What the site offers with its own keys.
 * @param {ClientDeps & { signal?: AbortSignal }} [deps]
 * @returns {Promise<SiteVoices>}
 */
export async function apiVoices(deps = {}) {
  const res = await call(VOICE_ROUTES.voices, { method: 'GET', headers: withAccess(deps, { accept: 'application/json' }), timeoutMs: TIMEOUT_MS.voices, signal: deps.signal }, deps);
  const json = await res.json();
  const g = json?.gemini ?? {};
  const e = json?.elevenlabs ?? {};
  const strings = (/** @type {unknown} */ list) => (Array.isArray(list) ? list.filter((v) => typeof v === 'string' && v.length <= 80) : []);
  return {
    gemini: { tts: g.tts === true, stt: g.stt === true, live: g.live === true, voices: strings(g.voices) },
    elevenlabs: {
      tts: e.tts === true,
      voices: Array.isArray(e.voices) ? e.voices.filter((/** @type {any} */ v) => typeof v?.id === 'string' && typeof v?.label === 'string').map((/** @type {any} */ v) => ({ id: v.id, label: v.label })) : [],
    },
  };
}

/**
 * @typedef {object} LiveToken
 * @property {string} token
 * @property {string} wsUrl
 * @property {string} model
 * @property {Record<string, unknown>} setup     the session setup locked into the token, sent as the first message
 * @property {string} expiresAt
 * @property {string} connectBy
 */

/**
 * A single-use Live token: with the site's key, or with the user's own Gemini key, which travels in
 * its header (never in the URL) and is not kept by the site.
 * @param {{ voice: string, locale: string, camera?: boolean }} input
 * @param {ClientDeps & { signal?: AbortSignal, userKey?: string | null }} [deps]
 * @returns {Promise<LiveToken>}
 */
export async function apiLiveToken(input, deps = {}) {
  const headers = withAccess(deps, { 'content-type': 'application/json' });
  if (deps.userKey) headers['x-goog-api-key'] = deps.userKey;
  const res = await call(VOICE_ROUTES.liveToken, { method: 'POST', headers, body: JSON.stringify(input), timeoutMs: TIMEOUT_MS.liveToken, signal: deps.signal }, deps);
  const json = await res.json();
  if (typeof json?.token !== 'string' || typeof json?.wsUrl !== 'string' || !json.setup || typeof json.setup !== 'object') throw new VoiceRouteError('bad_response', res.status);
  return { token: json.token, wsUrl: json.wsUrl, model: String(json.model ?? ''), setup: json.setup, expiresAt: String(json.expiresAt ?? ''), connectBy: String(json.connectBy ?? '') };
}
