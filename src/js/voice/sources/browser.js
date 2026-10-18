// @ts-check
// The browser's own speech services. Recognition (Web Speech API, Chrome, Edge, Safari) listens
// itself and reports interim text while the user speaks; most browsers recognize on their vendor's
// servers, so in the on-device mode it runs only where the browser offers on-device recognition
// (processLocally). Speech output uses speechSynthesis with a voice of the user's language; in the
// on-device mode only voices on this device (localService) are used, because the others send the
// text to the platform's vendor.
import { speechRecognitionCtor } from '../recognition.js';
import { pickBrowserVoice, SpeechError } from '../tts.js';

/** @typedef {import('./shared.js').SourceContext} SourceContext */
/** @typedef {import('./shared.js').SttSource} SttSource */
/** @typedef {import('./shared.js').TtsSource} TtsSource */

/**
 * Whether recognition can run under the current mode.
 * @param {SourceContext} ctx
 * @param {unknown} [scope]
 */
export function canRecognize(ctx, scope = globalThis) {
  const Ctor = speechRecognitionCtor(scope);
  if (!Ctor) return false;
  return !ctx.onDevice() || 'processLocally' in Ctor.prototype;
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
