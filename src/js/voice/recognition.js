// @ts-check
// The browser's speech recognition (Web Speech API: Chrome, Edge, Safari). recognizeOnce() is one
// recognition run; the dictation (dictation.js) and the browser speech input source use it, and
// src/js/voice.js re-exports it for code that imports the older entry. Most browsers recognize on
// their vendor's servers; with `onDevice` a run is refused where the browser cannot recognize on
// the device (processLocally). Light on purpose: it loads with the app's first script.
import { getIntlLocale } from '../i18n/index.js';

/**
 * @typedef {{ lang: string, continuous: boolean, interimResults: boolean, processLocally?: boolean, start(): void, stop(): void, abort?(): void,
 *   onstart: (() => void) | null, onend: (() => void) | null, onerror: ((e: { error: string }) => void) | null,
 *   onresult: ((e: { resultIndex: number, results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null }} Recognition
 * @typedef {new () => Recognition} RecognitionCtor
 *
 * @typedef {object} RecognizeOptions
 * @property {string} [lang]                 BCP 47 tag; default the interface language
 * @property {boolean} [onDevice]            only on-device recognition (processLocally); refused where the browser lacks it
 * @property {boolean} [interim]             report the transcript while the user speaks (default true)
 * @property {boolean} [continuous]          listen until stop() instead of the first pause; default false
 * @property {(text: string) => void} [onInterim]
 * @property {() => void} [onStart]          the browser listens now
 * @property {AbortSignal} [signal]          aborts like abort()
 * @property {RecognitionCtor | null} [Ctor] default SpeechRecognition ?? webkitSpeechRecognition
 *
 * @typedef {{ ok: true, text: string } | { ok: false, error: { code: string } }} RecognizeResult
 *   code: unsupported, on_device_unavailable, aborted, the recognition's own error ("not-allowed",
 *   "no-speech", "network", …) or the name of the exception that kept it from starting
 *
 * @typedef {object} RecognitionRun
 * @property {Promise<RecognizeResult>} result  never rejects
 * @property {() => void} stop    stop listening; the result keeps what was recognized
 * @property {() => void} abort   drop the run (result: aborted)
 */

/**
 * The page's speech recognition constructor, or null (Firefox, Node).
 * @param {unknown} [scope]
 * @returns {RecognitionCtor | null}
 */
export function speechRecognitionCtor(scope = globalThis) {
  const w = /** @type {{ SpeechRecognition?: RecognitionCtor, webkitSpeechRecognition?: RecognitionCtor }} */ (scope);
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Recognition errors after which another source may still succeed (the service, not the microphone,
 * is the problem).
 */
export const FALLBACK_ERRORS = Object.freeze(['network', 'service-not-allowed', 'language-not-supported', 'unsupported', 'on_device_unavailable', 'bad-grammar']);

/** Recognition error codes and the dictionary keys that explain them. */
export const RECOGNITION_MESSAGES = Object.freeze(
  /** @type {Record<string, string>} */ ({
    'not-allowed': 'chat.voice_error_denied',
    'service-not-allowed': 'chat.voice_error_denied',
    'audio-capture': 'chat.voice_error_microphone',
    network: 'chat.voice_error_network',
    'no-speech': 'chat.voice_error_no_speech',
    'language-not-supported': 'chat.voice_error_language',
  }),
);

/**
 * @param {RecognizeResult} result
 * @returns {RecognitionRun}
 */
const finished = (result) => ({ result: Promise.resolve(result), stop: () => {}, abort: () => {} });

/**
 * One recognition run: listens until the speaker pauses (or until stop() when continuous) and
 * resolves with the final transcript. It sends nothing anywhere itself; the caller decides.
 * @param {RecognizeOptions} [opts]
 * @returns {RecognitionRun}
 */
export function recognizeOnce(opts = {}) {
  const Ctor = opts.Ctor === undefined ? speechRecognitionCtor() : opts.Ctor;
  if (!Ctor) return finished({ ok: false, error: { code: 'unsupported' } });
  if (opts.onDevice && !('processLocally' in Ctor.prototype)) return finished({ ok: false, error: { code: 'on_device_unavailable' } });
  if (opts.signal?.aborted) return finished({ ok: false, error: { code: 'aborted' } });
  /** @type {(result: RecognizeResult) => void} */
  let settle = () => {};
  const result = /** @type {Promise<RecognizeResult>} */ (new Promise((resolve) => (settle = resolve)));
  let settled = false;
  let heard = '';
  /** @type {Recognition | null} */
  let recognition = null;
  /** @param {RecognizeResult} value */
  const done = (value) => {
    if (settled) return;
    settled = true;
    opts.signal?.removeEventListener('abort', abort);
    settle(value);
  };
  function abort() {
    done({ ok: false, error: { code: 'aborted' } });
    try {
      if (recognition?.abort) recognition.abort();
      else recognition?.stop();
    } catch {
      // never started
    }
  }
  try {
    recognition = new Ctor();
    recognition.lang = opts.lang ?? getIntlLocale();
    recognition.continuous = opts.continuous ?? false;
    recognition.interimResults = opts.interim ?? true;
    if (opts.onDevice) recognition.processLocally = true;
    recognition.onstart = () => opts.onStart?.();
    recognition.onresult = (event) => {
      // All results of the run, final and interim, in order.
      let all = '';
      for (let i = 0; i < event.results.length; i += 1) all += event.results[i][0]?.transcript ?? '';
      heard = all;
      opts.onInterim?.(all);
    };
    recognition.onerror = (event) => done({ ok: false, error: { code: event.error } });
    recognition.onend = () => done({ ok: true, text: heard.trim() });
    opts.signal?.addEventListener('abort', abort, { once: true });
    recognition.start();
  } catch (err) {
    done({ ok: false, error: { code: err instanceof Error ? err.name : 'error' } });
  }
  return {
    result,
    stop: () => {
      try {
        recognition?.stop();
      } catch {
        // already ended
      }
    },
    abort,
  };
}
