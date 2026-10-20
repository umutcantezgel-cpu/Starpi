// @ts-check
// The voice actions of the page, registered at start (main.js calls initVoice through
// src/js/voice.js): the microphone button (toggle-voice), the speaker button of an answer
// (voice-read-aloud) and stop (voice-stop-speaking). The voice code itself loads on the first press.
import { onAction, reportUnexpected } from '../dom.js';
import { toast } from '../ui/kit.js';
import { voiceUi } from './hooks.js';

/** @type {Promise<typeof import('./dictation.js')> | null} */
let dictation = null;
/** @type {Promise<typeof import('./speech.js')> | null} */
let speech = null;

const loadDictation = () => (dictation ??= import('./dictation.js'));
const loadSpeech = () => (speech ??= import('./speech.js'));

/** Registers the voice actions. */
export function initVoice() {
  onAction('toggle-voice', () => {
    loadDictation()
      .then((m) => m.pageDictationControl().toggle())
      .catch(reportUnexpected);
  });
  onAction('voice-read-aloud', (el) => {
    const id = el.dataset.arg ?? '';
    const answer = id ? (voiceUi().getAnswer?.(id) ?? null) : null;
    if (!answer) {
      toast('voice.read.unavailable', { tone: 'warn' });
      return;
    }
    loadSpeech()
      .then((m) => m.readAnswerAloud(answer, { id }))
      .catch(reportUnexpected);
  });
  onAction('voice-stop-speaking', () => {
    if (speech) void speech.then((m) => m.stopSpeaking());
  });
}
