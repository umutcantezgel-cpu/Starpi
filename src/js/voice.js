// @ts-check
// Voice input through the Web Speech API (Chrome, Edge, Safari). Most browsers recognize speech on
// their vendor's servers, so in the on-device mode voice input only runs where the browser offers
// on-device recognition (`processLocally`); otherwise it is switched off there.
import { byId, onAction } from './dom.js';
import { getIntlLocale, t } from './i18n/index.js';
import { appendNotice } from './messages.js';
import { getMode } from './state.js';

/**
 * @typedef {{ lang: string, continuous: boolean, interimResults: boolean, processLocally?: boolean, start(): void, stop(): void,
 *   onstart: (() => void) | null, onend: (() => void) | null, onerror: ((e: { error: string }) => void) | null,
 *   onresult: ((e: { resultIndex: number, results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null }} Recognition
 */

/** Speech recognition errors shown to the user; anything else gets a generic message. */
const ERRORS = /** @type {Record<string, string>} */ ({
  'not-allowed': 'chat.voice_error_denied',
  'service-not-allowed': 'chat.voice_error_denied',
  'audio-capture': 'chat.voice_error_microphone',
  network: 'chat.voice_error_network',
  'no-speech': 'chat.voice_error_no_speech',
  'language-not-supported': 'chat.voice_error_language',
});

/** @type {Recognition | null} */
let recognition = null;
let recording = false;

/** @param {boolean} on */
function setRecording(on) {
  recording = on;
  byId('voicePulse')?.classList.toggle('hidden', !on);
  const btn = byId('voiceBtn');
  if (!btn) return;
  const label = on ? 'chat.voice_stop' : 'chat.voice_input';
  btn.classList.toggle('text-red-700', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('data-i18n-aria', label);
  btn.setAttribute('aria-label', t(label));
}

function toggleVoiceInput() {
  const w = /** @type {{ SpeechRecognition?: new () => Recognition, webkitSpeechRecognition?: new () => Recognition }} */ (
    /** @type {unknown} */ (window)
  );
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) {
    appendNotice({ icon: 'mic', tone: 'warn', title: 'chat.voice_unsupported' });
    return;
  }
  if (recording) {
    recognition?.stop();
    setRecording(false);
    return;
  }
  const onDevice = getMode() === 'client';
  if (onDevice && !('processLocally' in Ctor.prototype)) {
    appendNotice({ icon: 'mic', tone: 'info', title: 'chat.voice_off_title', body: 'chat.voice_off_local' });
    return;
  }
  const input = /** @type {HTMLTextAreaElement | null} */ (byId('chatInput'));
  try {
    recognition = new Ctor();
    recognition.lang = getIntlLocale();
    recognition.continuous = false;
    recognition.interimResults = true;
    if (onDevice) recognition.processLocally = true;
    recognition.onstart = () => setRecording(true);
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) transcript += event.results[i][0].transcript;
      if (input) {
        input.value = transcript;
        input.dispatchEvent(new Event('input')); // grows the message box
      }
    };
    recognition.onerror = (event) => {
      setRecording(false);
      if (event.error === 'aborted') return;
      appendNotice({ icon: 'mic', tone: 'warn', title: ERRORS[event.error] ?? 'chat.voice_error_other', params: { code: event.error } });
    };
    recognition.onend = () => setRecording(false);
    recognition.start();
  } catch (err) {
    console.error('[starpi] voice init error:', err);
    setRecording(false);
    appendNotice({ icon: 'mic', tone: 'warn', title: 'chat.voice_error_other', params: { code: err instanceof Error ? err.name : 'error' } });
  }
}

export function initVoice() {
  onAction('toggle-voice', () => toggleVoiceInput());
}
