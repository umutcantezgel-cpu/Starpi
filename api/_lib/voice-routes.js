// @ts-check
// What the speech routes (api/voice/*) share: their dependencies from the environment and the
// checks every request passes. The site's Gemini keys are GEMINI_API_KEYS (the same keys as its
// Gemini pool, used for speech only while that pool is enabled, see STARPI_POOL_PROVIDERS, and not
// switched off with STARPI_VOICE_POOL=off), its ElevenLabs keys ELEVENLABS_API_KEYS. Models come
// from STARPI_GEMINI_TTS_MODEL, STARPI_GEMINI_STT_MODEL, STARPI_GEMINI_LIVE_MODEL and
// STARPI_ELEVENLABS_MODEL, API roots from STARPI_GEMINI_BASE_URL / STARPI_ELEVENLABS_BASE_URL (a
// loopback fake only). Limits: see gemini/budget.js. The dependencies are rebuilt only when one of
// these variables changes, so parked keys and counts carry over on a warm instance.
//
// No line of these routes logs a request body, a transcript, audio or a key.
import { SPEECH_MODELS } from '../../src/js/voice/catalog.js';
import { checkAccess, readAccessCode } from './access.js';
import { createElevenLabsAccount, ELEVENLABS_ROOT, parseElevenLabsKeys } from './elevenlabs/client.js';
import { readEnv } from './env.js';
import { createVoiceBudget, readVoiceLimits } from './gemini/budget.js';
import { createKeyRing } from './gemini/client.js';
import { clientIp, createRateLimiter } from './guards.js';
import { allowedOrigins, createDailyLimiter, guardRequest } from './origins.js';
import { enabledPoolIds, findPoolSpec, parsePoolKeys } from './pool/allowlist.js';
import { resolveRoot } from './relay/upstreams.js';
import { scrubSecrets } from './relay/scrub.js';

/**
 * @typedef {import('./gemini/client.js').KeyRing} KeyRing
 * @typedef {import('./gemini/client.js').FetchLike} FetchLike
 * @typedef {import('./guards.js').Refusal} Refusal
 * @typedef {import('./origins.js').Limiter} Limiter
 * @typedef {import('./gemini/budget.js').VoiceBudget} VoiceBudget
 * @typedef {import('./elevenlabs/client.js').ElevenLabsAccount} ElevenLabsAccount
 *
 * @typedef {object} VoiceDeps
 * @property {{ ring: KeyRing, root: string, simulated: boolean, models: { tts: string, stt: string, live: string } } | null} gemini  null without keys
 * @property {{ account: ElevenLabsAccount, model: string } | null} elevenlabs
 * @property {{ root: string, simulated: boolean }} geminiRoot  for Live tokens with the user's own key
 * @property {Limiter} limiter        per-IP requests a minute
 * @property {Limiter} daily          per-IP requests a day that use the site's keys
 * @property {VoiceBudget} budget
 * @property {readonly string[]} extraOrigins
 * @property {string} accessCode
 * @property {() => number} now
 * @property {FetchLike} fetch
 */

/** The variables the dependencies are built from. */
const VARIABLES = Object.freeze([
  'GEMINI_API_KEYS',
  'ELEVENLABS_API_KEYS',
  'STARPI_POOL_PROVIDERS',
  'STARPI_VOICE_POOL',
  'STARPI_GEMINI_TTS_MODEL',
  'STARPI_GEMINI_STT_MODEL',
  'STARPI_GEMINI_LIVE_MODEL',
  'STARPI_ELEVENLABS_MODEL',
  'STARPI_GEMINI_BASE_URL',
  'STARPI_ELEVENLABS_BASE_URL',
  'STARPI_VOICE_RPM_PER_IP',
  'STARPI_VOICE_DAILY_PER_IP',
  'STARPI_VOICE_DAILY_TTS_CHARS',
  'STARPI_VOICE_DAILY_STT_SECONDS',
  'STARPI_VOICE_DAILY_LIVE',
  'STARPI_ALLOWED_ORIGINS',
  'NVIDIA_ALLOWED_ORIGINS',
  'RELAY_ALLOWED_ORIGINS',
  'STARPI_ACCESS_CODE',
]);

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * @param {string | undefined} raw
 * @param {string} fallback
 */
const modelOr = (raw, fallback) => (MODEL_ID.test((raw ?? '').trim()) ? /** @type {string} */ (raw).trim() : fallback);

/**
 * The site's Gemini keys for speech, when its Gemini pool is enabled and speech is not switched off.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function geminiVoiceKeys(env) {
  if (/^(?:off|0|false|no)$/i.test((env.STARPI_VOICE_POOL ?? '').trim())) return [];
  if (!enabledPoolIds(env.STARPI_POOL_PROVIDERS).includes('gemini')) return [];
  const spec = findPoolSpec('gemini');
  return spec ? parsePoolKeys(spec, env[spec.keysVariable]).keys : [];
}

/**
 * The site's ElevenLabs keys (speech must not be switched off).
 * @param {Record<string, string | undefined>} env
 */
export function elevenlabsVoiceKeys(env) {
  if (/^(?:off|0|false|no)$/i.test((env.STARPI_VOICE_POOL ?? '').trim())) return [];
  return parseElevenLabsKeys(env.ELEVENLABS_API_KEYS).keys;
}

/**
 * Builds the dependencies from an environment.
 * @param {Record<string, string | undefined>} env
 * @param {{ fetch: FetchLike, now: () => number }} io
 * @returns {VoiceDeps}
 */
export function buildVoiceDeps(env, { fetch: send, now }) {
  const limits = readVoiceLimits(env);
  const geminiRoot = resolveRoot('gemini', 'https://generativelanguage.googleapis.com', env);
  const elevenRoot = resolveRoot('elevenlabs', ELEVENLABS_ROOT, env);
  const geminiKeys = geminiVoiceKeys(env);
  const { invalid } = parseElevenLabsKeys(env.ELEVENLABS_API_KEYS);
  if (invalid > 0) console.warn(scrubSecrets(`voice: ignored ${invalid} malformed entries in ELEVENLABS_API_KEYS`));
  const elevenKeys = elevenlabsVoiceKeys(env);
  return {
    gemini: geminiKeys.length
      ? {
          ring: createKeyRing(geminiKeys, now),
          root: geminiRoot.root,
          simulated: geminiRoot.simulated,
          models: {
            tts: modelOr(env.STARPI_GEMINI_TTS_MODEL, SPEECH_MODELS.geminiTts),
            stt: modelOr(env.STARPI_GEMINI_STT_MODEL, SPEECH_MODELS.geminiStt),
            live: modelOr(env.STARPI_GEMINI_LIVE_MODEL, SPEECH_MODELS.geminiLive),
          },
        }
      : null,
    elevenlabs: elevenKeys.length ? { account: createElevenLabsAccount({ keys: elevenKeys, root: elevenRoot.root, now }), model: modelOr(env.STARPI_ELEVENLABS_MODEL, SPEECH_MODELS.elevenlabsTts) } : null,
    geminiRoot,
    limiter: createRateLimiter({ limit: limits.rpmPerIp, windowMs: 60_000, now }),
    daily: createDailyLimiter({ limit: limits.dailyPerIp, now }),
    budget: createVoiceBudget({ ttsChars: limits.ttsChars, sttSeconds: limits.sttSeconds, liveSessions: limits.liveSessions, now }),
    extraOrigins: allowedOrigins(env),
    accessCode: readAccessCode(env),
    now,
    fetch: send,
  };
}

/** @type {{ signature: string, deps: VoiceDeps } | null} */
let cached = null;

/**
 * The dependencies of this instance, rebuilt when a relevant variable changes.
 * @returns {VoiceDeps}
 */
export function voiceRuntimeDeps() {
  const env = readEnv();
  const signature = VARIABLES.map((name) => env[name] ?? '').join('\n');
  if (cached?.signature !== signature) cached = { signature, deps: buildVoiceDeps(env, { fetch: (input, init) => fetch(input, init), now: () => Date.now() }) };
  return cached.deps;
}

/**
 * The front checks of a speech route: origin (POST only), per-IP rate limit, access code.
 * @param {Request} request
 * @param {VoiceDeps} deps
 * @param {{ origin?: boolean }} [options]
 * @returns {Promise<Refusal | null>}
 */
export async function voiceGuard(request, deps, options = {}) {
  if (options.origin !== false) return guardRequest(request, { extraOrigins: deps.extraOrigins, limiter: deps.limiter, accessCode: deps.accessCode });
  // A same-origin GET carries no Origin header; the rate limit and the access code still apply.
  const rate = deps.limiter.hit(clientIp(request));
  if (!rate.ok) return { status: 429, error: 'rate_limited', retryAfterS: rate.retryAfterS };
  return checkAccess(request, deps.accessCode);
}

/**
 * Counts a request that uses the site's keys against the client's daily budget.
 * @param {Request} request
 * @param {VoiceDeps} deps
 * @returns {Refusal | null}
 */
export function dailyGuard(request, deps) {
  const day = deps.daily.hit(clientIp(request));
  return day.ok ? null : { status: 429, error: 'daily_limit_reached', retryAfterS: day.retryAfterS };
}

/**
 * Whether a request body has only the given fields.
 * @param {Record<string, unknown>} body
 * @param {readonly string[]} fields
 * @returns {string | null} the first unknown field
 */
export function unknownField(body, fields) {
  return Object.keys(body).find((k) => !fields.includes(k)) ?? null;
}

/** @typedef {'en' | 'de' | 'fr' | 'es' | 'it' | 'tr'} VoiceLocale */

/** The interface languages (src/locales SHIPPED_LOCALES) a speech request may name. */
export const VOICE_LOCALES = /** @type {readonly VoiceLocale[]} */ (Object.freeze(['en', 'de', 'fr', 'es', 'it', 'tr']));

/** Interface languages a request may name ("fr-FR" is French); anything else counts as English. */
export function requestLocale(/** @type {unknown} */ value) {
  const lang = typeof value === 'string' ? value.slice(0, 2).toLowerCase() : '';
  return /** @type {VoiceLocale} */ (VOICE_LOCALES.find((l) => l === lang) ?? 'en');
}
