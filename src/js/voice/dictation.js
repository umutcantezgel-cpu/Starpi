// @ts-check
// Dictation into the message box: the microphone button. A press starts the first speech input
// source of the chain (stt.js). The browser's own recognition writes while the user speaks and ends
// at the pause; when it is missing, refused or its service fails, dictation records instead and the
// next sources transcribe the recording, each handing over to the next on failure. Other sources
// record from the start: a second press (or the time limit) ends the recording. The text lands
// after what the box already holds. Audio is never stored.
import { getIntlLocale } from '../i18n/index.js';
import { toast } from '../ui/kit.js';
import { CaptureError, createCapture } from './capture.js';
import { LIMITS } from './catalog.js';
import { composerInput } from './hooks.js';
import { showDictation } from './indicators.js';
import { getPlayback } from './playback.js';
import { FALLBACK_ERRORS, RECOGNITION_MESSAGES, recognizeOnce } from './recognition.js';
import { loadSiteOffer, pageContext, STT } from './sources/index.js';
import { speechQueue } from './speech.js';
import { sttChain, transcribeWithFallback } from './stt.js';

/** @typedef {import('./indicators.js').DictationState} DictationState */
/** @typedef {import('./sources/shared.js').SourceContext} SourceContext */
/** @typedef {import('./sources/shared.js').SttSource} SttSource */
/** @typedef {import('./capture.js').Capture} Capture */
/** @typedef {import('./recognition.js').RecognitionRun} RecognitionRun */

/**
 * @typedef {object} DictationDeps
 * @property {SourceContext} ctx
 * @property {Readonly<Record<string, SttSource>>} sources
 * @property {() => Capture} capture
 * @property {typeof recognizeOnce} recognize
 * @property {() => HTMLTextAreaElement | HTMLInputElement | null} input
 * @property {() => string} locale
 * @property {(state: DictationState, source: string | null) => void} show
 * @property {(label: import('../ui/kit.js').Label, tone: 'info' | 'warn') => void} notify
 * @property {() => Promise<unknown>} [ready]  resolves once the sources know what the site offers
 */

/**
 * @typedef {object} Dictation
 * @property {() => Promise<void>} toggle
 * @property {() => void} cancel
 * @property {() => DictationState} state
 */

/**
 * Writes text after what the box holds and lets it grow.
 * @param {HTMLTextAreaElement | HTMLInputElement | null} input
 * @param {string} prefix what the box held when dictation started
 * @param {string} text
 */
function write(input, prefix, text) {
  if (!input) return;
  input.value = prefix && text ? `${prefix} ${text}` : prefix || text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * @param {DictationDeps} deps
 * @returns {Dictation}
 */
export function createDictation(deps) {
  /** @type {DictationState} */
  let state = 'idle';
  /** @type {string | null} */
  let source = null;
  /** @type {RecognitionRun | null} */
  let run = null;
  /** @type {Capture | null} */
  let capture = null;
  /** @type {SttSource[]} */
  let rest = [];
  let prefix = '';
  /** @type {AbortController | null} */
  let transcription = null;

  /**
   * @param {DictationState} next
   * @param {string | null} [by]
   */
  const set = (next, by = source) => {
    state = next;
    source = next === 'idle' ? null : by;
    deps.show(state, source);
  };

  /** Starts recording for the sources that transcribe a recording. */
  const record = async () => {
    const first = rest.find((s) => s.transcribe);
    if (!first) {
      set('idle');
      deps.notify('voice.dictation.no_source', 'warn');
      return;
    }
    capture = deps.capture();
    capture.onEvent((event) => {
      if (event === 'limit') void finishRecording();
      if (event === 'hidden') {
        capture = null;
        set('idle');
      }
    });
    set('recording', first.id);
    try {
      await capture.start();
    } catch (err) {
      capture = null;
      set('idle');
      deps.notify(`voice.capture.${err instanceof CaptureError ? err.code : 'unsupported'}`, 'warn');
    }
  };

  const finishRecording = async () => {
    const current = capture;
    if (!current || state !== 'recording') return;
    capture = null;
    const length = current.durationMs();
    const wav = await current.stopWav();
    if (length < LIMITS.minUtteranceMs) {
      set('idle');
      deps.notify('voice.dictation.too_short', 'info');
      return;
    }
    set('transcribing');
    transcription = new AbortController();
    try {
      const result = await transcribeWithFallback(wav, { chain: rest, ctx: deps.ctx, locale: deps.locale(), signal: transcription.signal });
      if (result.text) write(deps.input(), prefix, result.text);
      else deps.notify(result.attempts.some((a) => a.outcome === 'empty') ? 'chat.voice_error_no_speech' : 'voice.dictation.failed', 'warn');
    } catch {
      // stopped by cancel()
    } finally {
      transcription = null;
      // cancel() may have reset the state meanwhile.
      if (/** @type {DictationState} */ (state) === 'transcribing') set('idle');
    }
  };

  const start = async () => {
    await deps.ready?.();
    const chain = sttChain(deps.sources, deps.ctx);
    if (chain.length === 0) {
      deps.notify(deps.ctx.onDevice() ? 'chat.voice_off_local' : 'voice.dictation.no_source', 'warn');
      return;
    }
    const input = deps.input();
    prefix = input?.value.trim() ?? '';
    rest = chain.filter((s) => s.id !== 'browser');
    if (chain[0].id !== 'browser') {
      await record();
      return;
    }
    set('listening', 'browser');
    run = deps.recognize({ lang: deps.locale(), onDevice: deps.ctx.onDevice(), onInterim: (text) => write(deps.input(), prefix, text.trim()) });
    const result = await run.result;
    run = null;
    if (state !== 'listening') return;
    if (result.ok) {
      write(deps.input(), prefix, result.text);
      set('idle');
      if (!result.text) deps.notify('chat.voice_error_no_speech', 'info');
      return;
    }
    const code = result.error.code;
    if (code === 'aborted') {
      set('idle');
      return;
    }
    if (FALLBACK_ERRORS.includes(code) && rest.some((s) => s.transcribe)) {
      // The browser's service is out of reach: record and let the next sources transcribe.
      deps.notify({ key: 'voice.dictation.fallback', params: { code } }, 'info');
      await record();
      return;
    }
    set('idle');
    deps.notify(RECOGNITION_MESSAGES[code] ? RECOGNITION_MESSAGES[code] : { key: 'chat.voice_error_other', params: { code } }, 'warn');
  };

  return {
    async toggle() {
      if (state === 'listening') return run?.stop();
      if (state === 'recording') return finishRecording();
      if (state === 'transcribing') return;
      await start();
    },
    cancel() {
      run?.abort();
      run = null;
      capture?.cancel();
      capture = null;
      transcription?.abort();
      set('idle');
    },
    state: () => state,
  };
}

/** @type {Dictation | null} */
let pageDictation = null;

/** The microphone button of this page. */
export function pageDictationControl() {
  pageDictation ??= createDictation({
    ctx: pageContext,
    sources: STT,
    capture: () => createCapture({ context: () => getPlayback().context(), activity: [getPlayback(), { isPlaying: () => speechQueue().speaking(), onStateChange: (fn) => speechQueue().onState(fn) }] }),
    recognize: recognizeOnce,
    input: composerInput,
    locale: getIntlLocale,
    show: (state, source) => showDictation(state, source),
    notify: (label, tone) => toast(label, { tone }),
    ready: () => Promise.race([loadSiteOffer(), new Promise((resolve) => setTimeout(resolve, 1500))]),
  });
  return pageDictation;
}
