// @ts-check
// The browser's own speech services. Recognition (Web Speech API, Chrome, Edge, Safari) listens
// itself and reports interim text while the user speaks; most browsers recognize on their vendor's
// servers, so in the on-device mode it runs only where the browser offers on-device recognition
// (processLocally). Speech output uses speechSynthesis with a voice of the user's language; in the
// on-device mode only voices on this device (localService) are used, because the others send the
// text to the platform's vendor.
import { pickBrowserVoice, SpeechError } from '../tts.js';
import { SttError } from './shared.js';

/** @typedef {import('./shared.js').SourceContext} SourceContext */
/** @typedef {import('./shared.js').SttSource} SttSource */
/** @typedef {import('./shared.js').TtsSource} TtsSource */

/**
 * @typedef {{ lang: string, continuous: boolean, interimResults: boolean, processLocally?: boolean, start(): void, stop(): void, abort(): void,
 *   onstart: (() => void) | null, onend: (() => void) | null, onerror: ((e: { error: string }) => void) | null,
 *   onresult: ((e: { resultIndex: number, results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null }} Recognition
 * @typedef {new () => Recognition} RecognitionCtor
 */

/**
 * The page's speech recognition constructor, if any.
 * @param {unknown} [scope]
 * @returns {RecognitionCtor | null}
 */
export function recognitionCtor(scope = globalThis) {
  const w = /** @type {{ SpeechRecognition?: RecognitionCtor, webkitSpeechRecognition?: RecognitionCtor }} */ (scope);
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Whether recognition can run under the current mode.
 * @param {SourceContext} ctx
 * @param {unknown} [scope]
 */
export function canRecognize(ctx, scope = globalThis) {
  const Ctor = recognitionCtor(scope);
  if (!Ctor) return false;
  return !ctx.onDevice() || 'processLocally' in Ctor.prototype;
}

/**
 * Recognition errors after which another source may still succeed (the service, not the microphone,
 * is the problem).
 */
export const FALLBACK_ERRORS = Object.freeze(['network', 'service-not-allowed', 'language-not-supported', 'unsupported', 'bad-grammar']);

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
 * A recognition that failed; `reason` is the Web Speech error code.
 */
export class RecognitionError extends SttError {
  /** @param {string} reason */
  constructor(reason) {
    super(FALLBACK_ERRORS.includes(reason) ? 'unavailable' : reason === 'no-speech' ? 'empty' : 'failed', reason);
    this.reason = reason;
  }
}

/**
 * Listens once: resolves with the final text when the user stops (stop()) or the service ends the
 * utterance; reports interim text. Rejects with a RecognitionError.
 * @param {{ locale: string, onDevice: boolean, onInterim?: (text: string) => void, onStart?: () => void, signal?: AbortSignal, Ctor?: RecognitionCtor | null }} options
 * @returns {{ done: Promise<string>, stop: () => void }}
 */
export function listen(options) {
  const Ctor = options.Ctor === undefined ? recognitionCtor() : options.Ctor;
  if (!Ctor) return { done: Promise.reject(new RecognitionError('unsupported')), stop: () => {} };
  const recognition = new Ctor();
  recognition.lang = options.locale;
  recognition.continuous = false;
  recognition.interimResults = true;
  if (options.onDevice) recognition.processLocally = true;
  let text = '';
  /** @type {() => void} */
  let stop = () => recognition.stop();
  const done = new Promise((resolve, reject) => {
    let failed = false;
    recognition.onstart = () => options.onStart?.();
    recognition.onresult = (event) => {
      let all = '';
      for (let i = 0; i < event.results.length; i += 1) all += event.results[i][0]?.transcript ?? '';
      text = all;
      options.onInterim?.(text);
    };
    recognition.onerror = (event) => {
      if (event.error === 'aborted' && options.signal?.aborted) return;
      failed = true;
      reject(new RecognitionError(event.error));
    };
    recognition.onend = () => {
      if (!failed) resolve(text.trim());
    };
    options.signal?.addEventListener('abort', () => recognition.abort(), { once: true });
    try {
      recognition.start();
    } catch (err) {
      failed = true;
      reject(new RecognitionError(err instanceof Error && err.name === 'NotAllowedError' ? 'not-allowed' : 'unsupported'));
    }
  });
  return { done, stop: () => stop() };
}

/** @type {SttSource} */
export const browserStt = {
  id: 'browser',
  local: false,
  available: (ctx) => canRecognize(ctx),
};

/**
 * @typedef {{ speak(u: SpeechSynthesisUtterance): void, cancel(): void, getVoices(): SpeechSynthesisVoice[] }} SynthLike
 */

/**
 * @param {unknown} [scope]
 * @returns {SynthLike | null}
 */
function synthOf(scope = globalThis) {
  const s = /** @type {{ speechSynthesis?: SynthLike, SpeechSynthesisUtterance?: unknown }} */ (scope);
  return s.speechSynthesis && typeof s.SpeechSynthesisUtterance === 'function' ? s.speechSynthesis : null;
}

/**
 * The voices of speechSynthesis; some browsers fill the list only after voiceschanged.
 * @param {SynthLike} synth
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
async function voicesOf(synth) {
  const now = synth.getVoices();
  if (now.length) return now;
  const target = /** @type {EventTarget} */ (/** @type {unknown} */ (synth));
  if (typeof target.addEventListener !== 'function') return now;
  return new Promise((resolve) => {
    const done = () => {
      target.removeEventListener('voiceschanged', done);
      resolve(synth.getVoices());
    };
    target.addEventListener('voiceschanged', done);
    setTimeout(done, 1500);
  });
}

/** @type {TtsSource} */
export const browserTts = {
  id: 'browser',
  local: true,
  available: () => synthOf() !== null,
  engine: (ctx) => ({
    id: 'browser',
    async prepare(text, opts) {
      const synth = synthOf();
      if (!synth) throw new SpeechError('unavailable');
      const voice = pickBrowserVoice(await voicesOf(synth), opts.locale, { preferred: opts.voice, onDeviceOnly: ctx.onDevice() });
      if (!voice && ctx.onDevice()) throw new SpeechError('no_voice');
      return {
        play: (signal) =>
          new Promise((resolve, reject) => {
            if (signal.aborted) return resolve(undefined);
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = voice?.lang ?? opts.locale;
            if (voice) utterance.voice = voice;
            utterance.rate = opts.rate;
            const abort = () => synth.cancel();
            signal.addEventListener('abort', abort, { once: true });
            utterance.onend = () => {
              signal.removeEventListener('abort', abort);
              resolve(undefined);
            };
            utterance.onerror = (event) => {
              signal.removeEventListener('abort', abort);
              if (signal.aborted || event.error === 'interrupted' || event.error === 'canceled') resolve(undefined);
              else reject(new SpeechError('failed', event.error));
            };
            synth.speak(utterance);
          }),
      };
    },
  }),
  async voices(ctx, locale) {
    const synth = synthOf();
    if (!synth) return [];
    const lang = String(locale).slice(0, 2).toLowerCase();
    return (await voicesOf(synth))
      .filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang) && (!ctx.onDevice() || v.localService))
      .map((v) => ({ id: v.voiceURI, label: v.name, online: !v.localService }));
  },
};
