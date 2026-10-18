// @ts-check
// The speech queue: everything the app says aloud goes through it, and it says only two kinds of
// things. Units a sentence gate released (isReleased of core/gate.js: a free answer through the
// free gate, a grounded answer through the source gate) and the app's own notices, which are fixed
// dictionary sentences made here from an allowlisted key (speechNotice). A string, a copy of a
// released unit or any other object is refused, so no code path can speak a model's text that did
// not pass a gate.
//
// Each item is spoken as its `spoken` form, split into pieces a speech service accepts
// (splitForSpeech). Engines (sources/*.js) turn a piece into something playable; the next piece is
// prepared while the current one plays. When an engine fails, the queue moves to the next engine of
// its list for the rest of the reading (the browser's own voices come last) and reports the step;
// when none is left the reading ends and the text stays on the screen. stop() ends a reading at once
// and starts a new epoch: a reading that streams in (read-aloud.js) and began before the stop adds
// nothing more, and items queued right after the stop are a new reading of their own.
import { isReleased } from '../core/gate.js';
import { t } from '../i18n/index.js';
import { LIMITS } from './catalog.js';

/** @typedef {import('../core/gate.js').Released} Released */

/**
 * @typedef {object} SpeechNotice
 * @property {string} text
 * @property {string} spoken
 * @property {string} key       the dictionary key it was made from
 * @property {true} notice
 */

/** @typedef {Released | SpeechNotice} SpeechItem */

/**
 * @typedef {object} SynthOptions
 * @property {string} locale
 * @property {string | null} voice   the engine's voice id (null: the engine picks)
 * @property {number} rate           0.5 to 2
 * @property {AbortSignal} signal
 */

/** @typedef {{ play: (signal: AbortSignal) => Promise<void> }} Playable */

/**
 * @typedef {object} SpeechEngine
 * @property {string} id
 * @property {(text: string, options: SynthOptions) => Promise<Playable>} prepare  rejects with a SpeechError when the source cannot speak
 */

/**
 * @typedef {'unavailable' | 'auth' | 'rate_limited' | 'network' | 'refused' | 'playback' | 'no_voice' | 'failed'} SpeechErrorCode
 */

/** A speech source that could not speak a piece. */
export class SpeechError extends Error {
  /**
   * @param {SpeechErrorCode} code
   * @param {string} [detail] a short technical note (never text that was to be spoken)
   */
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SpeechError';
    this.code = code;
  }
}

/**
 * Keys of the app's own spoken sentences. Their texts hold no model output, only the parameters
 * listed here (numbers).
 */
export const NOTICE_KEYS = Object.freeze(['voice.read.free_notice', 'voice.read.withheld', 'voice.read.nothing', 'voice.preview.sample', 'live.spoken.free', 'live.spoken.withheld', 'live.spoken.ended']);
const NOTICE_PARAMS = new Set(['count']);

/** Notices made by this module; nothing else passes isSpeechNotice(). */
const NOTICES = new WeakSet();

/**
 * The dictionary language of a locale: 'de' for 'de', 'de-DE' or 'de_AT' (the dictionaries are
 * keyed by language, speech and Intl use full tags). Undefined: the interface language.
 * @param {string | undefined} locale
 */
export function dictionaryLocale(locale) {
  const lang = String(locale ?? '').trim().split(/[-_]/)[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(lang) ? lang : undefined;
}

/**
 * One of the app's own spoken sentences, from an allowlisted dictionary key.
 * @param {string} key one of NOTICE_KEYS
 * @param {Record<string, number>} [params] numbers only
 * @param {string} [locale] a language ('de') or a BCP 47 tag ('de-DE'); the interface language when left out
 * @returns {SpeechNotice}
 */
export function speechNotice(key, params = {}, locale) {
  if (!NOTICE_KEYS.includes(key)) throw new TypeError(`speechNotice: ${String(key).slice(0, 60)} is not a notice key`);
  for (const [name, value] of Object.entries(params)) {
    if (!NOTICE_PARAMS.has(name) || typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('speechNotice: parameters must be known numbers');
  }
  const text = t(key, params, dictionaryLocale(locale));
  const notice = /** @type {SpeechNotice} */ (Object.freeze({ text, spoken: text, key, notice: true }));
  NOTICES.add(notice);
  return notice;
}

/**
 * @param {unknown} value
 * @returns {value is SpeechNotice}
 */
export function isSpeechNotice(value) {
  return typeof value === 'object' && value !== null && NOTICES.has(value);
}

/**
 * Whether the queue may speak a value: a released unit or one of the app's notices.
 * @param {unknown} value
 * @returns {value is SpeechItem}
 */
export function isSpeakable(value) {
  return isReleased(value) || isSpeechNotice(value);
}

/**
 * Pieces of a text of at most `max` characters: whole when it fits, else cut after a clause mark
 * (, ; : – —), else at a space, else hard.
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitForSpeech(text, max = LIMITS.speakChars) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  /** @type {string[]} */
  const out = [];
  let rest = clean;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = -1;
    for (const re of [/[,;:](?= )|\s[–—](?= )/g, / /g]) {
      for (const m of window.matchAll(re)) if (m.index > max * 0.3) cut = m.index + (m[0].trim() ? m[0].length : 0);
      if (cut > 0) break;
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * @typedef {{ voiceURI: string, name: string, lang: string, localService: boolean, default?: boolean }} VoiceLike
 */

/**
 * The browser voice for a language: the stored one when it is offered, else one whose language
 * matches exactly, else the same base language; voices on this device first, the platform's
 * default next. With `onDeviceOnly` voices that send text to a vendor are never chosen.
 * @template {VoiceLike} V
 * @param {readonly V[]} voices
 * @param {string} locale
 * @param {{ preferred?: string | null, onDeviceOnly?: boolean }} [options]
 * @returns {V | null}
 */
export function pickBrowserVoice(voices, locale, options = {}) {
  const usable = voices.filter((v) => !options.onDeviceOnly || v.localService);
  if (options.preferred) {
    const chosen = usable.find((v) => v.voiceURI === options.preferred);
    if (chosen) return chosen;
  }
  const norm = (/** @type {string} */ tag) => String(tag ?? '').replace('_', '-').toLowerCase();
  const wanted = norm(locale);
  const base = wanted.split('-')[0];
  const match = (/** @type {V} */ v) => (norm(v.lang) === wanted ? 0 : norm(v.lang).split('-')[0] === base ? 2 : null);
  const rank = (/** @type {V} */ v) => /** @type {number} */ (match(v)) + (v.localService ? 0 : 1) - (v.default ? 0.5 : 0);
  const fitting = usable.filter((v) => match(v) !== null).sort((a, b) => rank(a) - rank(b));
  return fitting[0] ?? null;
}

/**
 * @typedef {object} QueueDeps
 * @property {() => SpeechEngine[]} engines   the chosen engine first, then its fallbacks (read when a reading starts)
 * @property {() => string} locale
 * @property {(engineId: string, locale: string) => string | null} [voice]
 * @property {() => number} [rate]
 * @property {(value: unknown) => boolean} [speakable]  default isSpeakable (tests may only narrow it)
 * @property {(step: { from: string, to: string | null, code: string }) => void} [onFallback]
 * @property {number} [maxChars]
 */

/**
 * @typedef {object} SpeechQueue
 * @property {(item: unknown) => boolean} enqueue   false: refused (not speakable) or empty
 * @property {() => void} stop
 * @property {() => boolean} speaking
 * @property {() => Promise<void>} idle             resolves when nothing is queued or playing
 * @property {(fn: (speaking: boolean) => void) => () => void} onState
 * @property {() => string | null} engine           the engine of the current reading
 * @property {() => number} epoch                    counts stop() calls; a stream that began in an earlier epoch is over
 */

/**
 * @param {QueueDeps} deps
 * @returns {SpeechQueue}
 */
export function createSpeechQueue(deps) {
  const speakable = deps.speakable ?? isSpeakable;
  const maxChars = deps.maxChars ?? LIMITS.speakChars;
  /** @typedef {{ playable: Playable, index: number }} Ready */
  /** @typedef {Array<{ text: string, prepared: Promise<Ready | null> | null }>} Pieces */
  /** What is queued; stop() replaces the list, so a reading that is still ending keeps its own. */
  /** @type {Pieces} */
  let pieces = [];
  let running = false;
  let epoch = 0;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {SpeechEngine[]} */
  let engines = [];
  let engineIndex = 0;
  /** @type {Set<(speaking: boolean) => void>} */
  const listeners = new Set();
  /** @type {Array<() => void>} */
  let waiters = [];

  /** @param {boolean} on */
  const notify = (on) => {
    for (const fn of listeners) {
      try {
        fn(on);
      } catch (err) {
        console.error('[starpi] speech listener failed', err);
      }
    }
  };

  /**
   * Moves to the next engine after `index` failed (a failure of an engine already left is ignored).
   * @param {number} index
   * @param {unknown} err
   */
  const stepDown = (index, err) => {
    if (index !== engineIndex) return;
    engineIndex += 1;
    const code = err instanceof SpeechError ? err.code : 'failed';
    deps.onFallback?.({ from: engines[index].id, to: engines[engineIndex]?.id ?? null, code });
  };

  /**
   * Prepares a piece with the current engine, stepping down on failure; null when none is left.
   * @param {string} text
   * @param {AbortSignal} signal
   * @returns {Promise<Ready | null>}
   */
  const prepare = async (text, signal) => {
    while (engineIndex < engines.length && !signal.aborted) {
      const index = engineIndex;
      const engine = engines[index];
      const locale = deps.locale();
      try {
        const playable = await engine.prepare(text, { locale, voice: deps.voice?.(engine.id, locale) ?? null, rate: deps.rate?.() ?? 1, signal });
        return { playable, index };
      } catch (err) {
        if (signal.aborted) return null;
        stepDown(index, err);
      }
    }
    return null;
  };

  const run = async () => {
    running = true;
    controller = new AbortController();
    const { signal } = controller;
    // This reading's pieces: items queued after a stop() go to a new list and wait for the next run.
    const list = pieces;
    engines = deps.engines();
    engineIndex = 0;
    notify(true);
    try {
      while (list.length && !signal.aborted) {
        const piece = list[0];
        let ready = await (piece.prepared ??= prepare(piece.text, signal));
        while (ready && !signal.aborted) {
          // The next piece is prepared while this one plays.
          const following = list[1];
          if (following && !following.prepared) following.prepared = prepare(following.text, signal);
          try {
            await ready.playable.play(signal);
            break;
          } catch (err) {
            if (signal.aborted) break;
            stepDown(ready.index, err);
            ready = await prepare(piece.text, signal);
          }
        }
        list.shift();
        // No engine is left: the rest of the reading stays on the screen only.
        if (!ready) list.length = 0;
      }
    } finally {
      running = false;
      controller = null;
      notify(false);
      if (pieces.length) {
        // Queued after a stop() while the old reading was still ending: a new reading.
        for (const p of pieces) p.prepared = null;
        void run();
      } else {
        const done = waiters;
        waiters = [];
        for (const fn of done) fn();
      }
    }
  };

  return {
    enqueue(item) {
      if (!speakable(item)) return false;
      const parts = splitForSpeech(/** @type {SpeechItem} */ (item).spoken, maxChars);
      if (parts.length === 0) return false;
      pieces.push(...parts.map((text) => ({ text, prepared: null })));
      if (!running) void run();
      return true;
    },
    stop() {
      epoch += 1;
      pieces = [];
      controller?.abort();
    },
    speaking: () => running,
    idle: () => (running ? new Promise((resolve) => waiters.push(() => resolve(undefined))) : Promise.resolve()),
    onState(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    engine: () => (running ? (engines[engineIndex]?.id ?? null) : null),
    epoch: () => epoch,
  };
}
