// @ts-check
// What every speech source shares: the context the sources consult (keys, settings, the site's
// offer, the playback), the error type of speech input, and helpers that turn HTTP answers into
// error codes and audio into something the speech queue can play.
import { SpeechError } from '../tts.js';
import { decodeWav } from '../wav.js';

/** @typedef {import('../settings.js').VoiceSettings} VoiceSettings */
/** @typedef {import('../playback.js').Playback} Playback */
/** @typedef {import('../tts.js').SpeechEngine} SpeechEngine */
/** @typedef {import('../tts.js').Playable} Playable */
/** @typedef {import('../catalog.js').SttSourceId} SttSourceId */
/** @typedef {import('../catalog.js').TtsSourceId} TtsSourceId */
/** @typedef {import('../catalog.js').VoiceEntry} VoiceEntry */
/** @typedef {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} FetchLike */

/**
 * What the site offers with its own keys (GET /api/voice/voices), or null while unknown.
 * @typedef {{ geminiTts: boolean, geminiStt: boolean, live: boolean, elevenlabsTts: boolean }} SiteVoice
 */

/**
 * @typedef {object} CompanionLink
 * @property {string} origin   the companion's loopback origin
 * @property {string} token    the pairing token, sent as a Bearer token
 */

/**
 * @typedef {object} SourceContext
 * @property {(slot: string) => string} getKey      the user's keys (ai/keys.js)
 * @property {() => VoiceSettings} settings
 * @property {() => boolean} onDevice               the on-device mode: nothing may leave this device
 * @property {() => SiteVoice | null} site
 * @property {() => CompanionLink | null} companion
 * @property {() => Playback} playback
 * @property {FetchLike} [fetch]                    replaces fetch for the sources' own calls and transports (tests)
 * @property {string} [origin]                      this site's origin for its routes (tests)
 * @property {() => string} [access]                the site's access code
 */

/**
 * @typedef {'unavailable' | 'auth' | 'rate_limited' | 'network' | 'refused' | 'empty' | 'unsupported' | 'failed'} SttErrorCode
 */

/** A speech input source that could not transcribe. */
export class SttError extends Error {
  /**
   * @param {SttErrorCode} code
   * @param {string} [detail]
   */
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SttError';
    this.code = code;
  }
}

/**
 * @typedef {object} TranscribeOptions
 * @property {string} locale
 * @property {string[]} glossary
 * @property {AbortSignal} signal
 */

/**
 * @typedef {object} SttSource
 * @property {SttSourceId} id
 * @property {boolean} local        audio stays on this device or a machine of the user's
 * @property {(ctx: SourceContext) => boolean} available
 * @property {(wav: Uint8Array, options: TranscribeOptions, ctx: SourceContext) => Promise<string>} [transcribe]  record sources; the browser listens itself
 */

/**
 * @typedef {object} TtsSource
 * @property {TtsSourceId} id
 * @property {boolean} local
 * @property {(ctx: SourceContext) => boolean} available
 * @property {(ctx: SourceContext) => SpeechEngine} engine
 * @property {(ctx: SourceContext, locale: string) => Promise<VoiceEntry[]>} voices
 */

/**
 * The error code of an HTTP status.
 * @param {number} status
 * @returns {'auth' | 'rate_limited' | 'refused' | 'unavailable' | 'failed'}
 */
export function codeOfStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'refused';
  if (status === 404 || status === 405 || status === 501 || status === 503) return 'unavailable';
  return 'failed';
}

/**
 * The response, or a SpeechError / SttError with the code of its status (its body is not read).
 * @param {Response} res
 * @param {'speech' | 'stt'} kind
 */
export function checkResponse(res, kind) {
  if (res.ok) return res;
  void res.body?.cancel().catch(() => {});
  const code = codeOfStatus(res.status);
  throw kind === 'speech' ? new SpeechError(code, `http ${res.status}`) : new SttError(code, `http ${res.status}`);
}

/**
 * A rejected call as an error of the right kind (an abort stays an abort).
 * @param {unknown} err
 * @param {'speech' | 'stt'} kind
 * @param {AbortSignal} [signal]
 */
export function asSourceError(err, kind, signal) {
  if (signal?.aborted || err instanceof SpeechError || err instanceof SttError) return err;
  const raw = /** @type {{ code?: unknown, name?: unknown }} */ (err ?? {});
  const known = typeof raw.code === 'string' ? raw.code : '';
  /** @type {string} */
  let code = 'network';
  if (['auth', 'quota'].includes(known) || known === 'access_required' || known === 'access_denied') code = 'auth';
  else if (known === 'rate_limited' || known === 'daily_limit_reached' || known === 'budget_exhausted') code = 'rate_limited';
  else if (known === 'route_missing' || known === 'not_configured' || known === 'voice_not_configured') code = 'unavailable';
  else if (known === 'bad_request' || known === 'invalid_audio' || known === 'unknown_voice' || known === 'refused') code = 'refused';
  return kind === 'speech' ? new SpeechError(/** @type {any} */ (code), known || String(raw.name ?? '')) : new SttError(/** @type {any} */ (code), known || String(raw.name ?? ''));
}

/**
 * A playable PCM chunk on the app's playback; it fails when the output cannot play.
 * @param {Playback} playback
 * @param {Int16Array} samples
 * @param {number} rate
 * @returns {Playable}
 */
export function pcmPlayable(playback, samples, rate) {
  return {
    async play(signal) {
      if (signal.aborted) return;
      const stop = () => playback.flush();
      signal.addEventListener('abort', stop, { once: true });
      try {
        const played = await playback.play(samples, rate);
        if (!played && !signal.aborted) throw new SpeechError('playback');
      } finally {
        signal.removeEventListener('abort', stop);
      }
    },
  };
}

/**
 * A playable WAV file.
 * @param {Playback} playback
 * @param {Uint8Array} bytes
 * @returns {Playable}
 */
export function wavPlayable(playback, bytes) {
  const wav = decodeWav(bytes);
  if (!wav || wav.samples.length === 0) throw new SpeechError('failed', 'unreadable audio');
  return pcmPlayable(playback, wav.samples, wav.rate);
}

/**
 * The fetch the sources use.
 * @param {SourceContext} ctx
 * @returns {FetchLike}
 */
export function fetchFor(ctx) {
  return ctx.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

/**
 * Two-letter language of a locale ("de-AT" -> "de").
 * @param {string} locale
 */
export const langOf = (locale) => String(locale ?? 'en').slice(0, 2).toLowerCase();
