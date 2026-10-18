// @ts-check
// What the page shows while voice works: the microphone button's state (listening, recording,
// transcribing) and the chip that names the source the speech goes to. Every state
// has a word and an icon, never colour alone. Small DOM helpers only; the controllers decide.
import { byId } from '../dom.js';
import { t } from '../i18n/index.js';

/** @typedef {'idle' | 'listening' | 'recording' | 'transcribing'} DictationState */

/** The dictionary key of each speech input source's name. */
export const SOURCE_KEYS = Object.freeze(
  /** @type {Record<string, string>} */ ({
    browser: 'voice.source.browser',
    gemini: 'voice.source.gemini',
    openai: 'voice.source.openai',
    groq: 'voice.source.groq',
    local: 'voice.source.local',
    companion: 'voice.source.companion',
    elevenlabs: 'voice.source.elevenlabs',
  }),
);

const STATE_KEYS = Object.freeze(
  /** @type {Record<DictationState, string>} */ ({
    idle: 'chat.voice_input',
    listening: 'voice.dictation.listening',
    recording: 'voice.dictation.recording',
    transcribing: 'voice.dictation.transcribing',
  }),
);

/**
 * Shows a dictation state on the microphone button (#voiceBtn) and the source chip.
 * @param {DictationState} state
 * @param {string | null} source the speech input source in use
 * @param {{ getElementById(id: string): HTMLElement | null }} [root]
 */
export function showDictation(state, source, root = { getElementById: byId }) {
  const active = state !== 'idle';
  root.getElementById('voicePulse')?.classList.toggle('hidden', !(state === 'listening' || state === 'recording'));
  const btn = root.getElementById('voiceBtn');
  if (btn) {
    const key = active ? (state === 'transcribing' ? STATE_KEYS.transcribing : 'chat.voice_stop') : STATE_KEYS.idle;
    btn.classList.toggle('text-red-700', state === 'listening' || state === 'recording');
    btn.setAttribute('aria-pressed', String(active));
    btn.setAttribute('aria-busy', String(state === 'transcribing'));
    btn.setAttribute('data-i18n-aria', key);
    btn.setAttribute('aria-label', t(key));
    btn.dataset.voiceState = state;
  }
  const chip = root.getElementById('voiceSourceChip');
  if (chip) {
    chip.classList.toggle('hidden', !active || !source);
    const text = chip.querySelector('[data-voice-chip-text]');
    if (text && source) {
      const sourceKey = SOURCE_KEYS[source] ?? 'voice.source.browser';
      const params = { source: t(sourceKey), state: t(STATE_KEYS[state]) };
      text.setAttribute('data-i18n', 'voice.dictation.chip');
      text.setAttribute('data-i18n-params', JSON.stringify(params));
      text.textContent = t('voice.dictation.chip', params);
    }
  }
}
