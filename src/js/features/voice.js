// @ts-check
// Voice: Settings -> Voice and the composer's voice controls (the chip that names the speech input
// source while dictating, and a button that stops a reading). The microphone button and the speaker
// buttons are delegated actions (voice/entry.js); the chat wires its side through registerVoiceUi
// (voice/hooks.js), re-exported here. The settings view loads after the first paint.
import { t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { html, icon } from '../ui/kit.js';
import { registerFeature } from './registry.js';

export { readAloudStream, registerVoiceUi, speakerButton } from '../voice/hooks.js';

/** @type {import('./registry.js').Feature} */
const settings = {
  id: 'voice',
  async mount(el, ctx) {
    const { mountVoiceSettings } = await import('../voice/settings-view.js');
    mountVoiceSettings(el, ctx);
  },
};

/** @type {import('./registry.js').Feature} */
const composer = {
  id: 'voice-controls',
  mount(el) {
    el.insertAdjacentHTML(
      'beforeend',
      html`<span id="voiceSourceChip" class="hidden chip chip-info text-[11px]" role="status" aria-live="polite">${icon('mic', '')}<span data-voice-chip-text></span></span><button type="button" id="voiceStopBtn" class="hidden btn btn-ghost btn-icon" data-action="voice-stop-speaking" data-i18n-aria="voice.read.stop" aria-label="${t('voice.read.stop')}" data-i18n-title="voice.read.stop" title="${t('voice.read.stop')}">${icon('square', 'w-4 h-4')}</button>`.value,
    );
    refreshIcons(el);
  },
};

registerFeature('voiceSettings', settings);
registerFeature('composerExtras', composer);
