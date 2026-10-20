// @ts-check
// Speech input: which sources may turn speech into text, in which order, and the fallback from one
// to the next. The order is STT_SOURCES (browser, Gemini, OpenAI, Groq, local voice server,
// companion); a source the user picks moves to the front. A source counts only when it can run
// now (a key, the site's offer, a server address, a pairing); in the on-device mode only sources
// that keep audio on the user's machines count, plus the browser where it recognizes on the device.
//
// The browser listens itself; every other source takes the recorded utterance (a 16 kHz WAV).
// transcribeWithFallback() tries the recording sources in order: a source that is not configured,
// refuses, is rate limited or unreachable hands over to the next, and every attempt is reported.
// The glossary is the user's own list of names and terms (Settings -> Voice).
import { STT_SOURCES } from './catalog.js';
import { parseGlossary } from './gemini-wire.js';
import { SttError } from './sources/shared.js';

/** @typedef {import('./sources/shared.js').SttSource} SttSource */
/** @typedef {import('./sources/shared.js').SourceContext} SourceContext */
/** @typedef {import('./catalog.js').SttSourceId} SttSourceId */

/**
 * The sources to try, in order: the user's pick first, then STT_SOURCES; only available ones.
 * @param {Readonly<Record<SttSourceId, SttSource>>} sources
 * @param {SourceContext} ctx
 * @returns {SttSource[]}
 */
export function sttChain(sources, ctx) {
  const chosen = ctx.settings().stt;
  const order = chosen === 'auto' ? [...STT_SOURCES] : [chosen, ...STT_SOURCES.filter((id) => id !== chosen)];
  return order
    .map((id) => sources[id])
    .filter((source) => {
      if (!source) return false;
      if (ctx.onDevice() && !source.local && source.id !== 'browser') return false;
      try {
        return source.available(ctx);
      } catch {
        return false;
      }
    });
}

/**
 * @typedef {object} SttAttempt
 * @property {SttSourceId} source
 * @property {'ok' | 'empty' | string} outcome   'ok', 'empty' or an SttErrorCode
 */

/**
 * @typedef {object} TranscribeResult
 * @property {string} text          '' when no source heard anything
 * @property {SttSourceId | null} source  the source that answered
 * @property {SttAttempt[]} attempts
 */

/** Codes after which the next source is tried; anything else ends the attempt (an abort). */
const HAND_OVER = new Set(['unavailable', 'auth', 'rate_limited', 'network', 'refused', 'failed', 'unsupported']);

/**
 * Transcribes a recording with the first source that answers.
 * @param {Uint8Array} wav
 * @param {{ chain: readonly SttSource[], ctx: SourceContext, locale: string, signal?: AbortSignal }} options
 * @returns {Promise<TranscribeResult>}
 */
export async function transcribeWithFallback(wav, { chain, ctx, locale, signal }) {
  const glossary = parseGlossary(ctx.settings().glossary);
  const run = signal ?? new AbortController().signal;
  /** @type {SttAttempt[]} */
  const attempts = [];
  let heardNothing = false;
  for (const source of chain) {
    if (!source.transcribe) continue;
    if (run.aborted) break;
    try {
      const text = (await source.transcribe(wav, { locale, glossary, signal: run }, ctx)).trim();
      if (text) {
        attempts.push({ source: source.id, outcome: 'ok' });
        return { text, source: source.id, attempts };
      }
      // Silence is silence: another source would not hear more.
      attempts.push({ source: source.id, outcome: 'empty' });
      heardNothing = true;
      break;
    } catch (err) {
      if (run.aborted) break;
      const code = err instanceof SttError ? err.code : 'failed';
      attempts.push({ source: source.id, outcome: code });
      if (code === 'empty') {
        heardNothing = true;
        break;
      }
      if (!HAND_OVER.has(code)) break;
    }
  }
  if (run.aborted) throw new DOMException('Transcription stopped', 'AbortError');
  return { text: '', source: heardNothing ? (attempts.at(-1)?.source ?? null) : null, attempts };
}
