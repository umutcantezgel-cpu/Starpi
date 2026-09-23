// @ts-check
// Voice input through the Web Speech API (Chrome, Edge, Safari).
import { byId, onAction } from './dom.js';

/**
 * @typedef {{ lang: string, continuous: boolean, interimResults: boolean, start(): void, stop(): void,
 *   onstart: (() => void) | null, onend: (() => void) | null, onerror: ((e: { error: string }) => void) | null,
 *   onresult: ((e: { resultIndex: number, results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null }} Recognition
 */

/** @type {Recognition | null} */
let recognition = null;
let recording = false;

/** @param {boolean} on */
function setRecording(on) {
  recording = on;
  byId('voicePulse')?.classList.toggle('hidden', !on);
  const btn = byId('voiceBtn');
  btn?.classList.toggle('text-red-400', on);
  btn?.classList.toggle('text-slate-400', !on);
}

function toggleVoiceInput() {
  const w = /** @type {{ SpeechRecognition?: new () => Recognition, webkitSpeechRecognition?: new () => Recognition }} */ (
    /** @type {unknown} */ (window)
  );
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) {
    window.alert('Spracherkennung wird in diesem Browser leider nicht direkt unterstützt. Bitte nutzen Sie Chrome, Edge oder Safari.');
    return;
  }
  if (recording) {
    recognition?.stop();
    setRecording(false);
    return;
  }
  const input = /** @type {HTMLTextAreaElement | null} */ (byId('chatInput'));
  try {
    recognition = new Ctor();
    recognition.lang = 'de-DE';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => setRecording(true);
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) transcript += event.results[i][0].transcript;
      if (input) input.value = transcript;
    };
    recognition.onerror = (event) => {
      console.warn('[starpi] voice error:', event.error);
      setRecording(false);
    };
    recognition.onend = () => setRecording(false);
    recognition.start();
  } catch (err) {
    console.error('[starpi] voice init error:', err);
    setRecording(false);
  }
}

export function initVoice() {
  onAction('toggle-voice', () => toggleVoiceInput());
}
