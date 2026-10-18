// @ts-check
// Live voice conversation: the button in the composer and the full-screen sheet (#liveSheet). The
// sheet and everything behind it (Live session, microphone, speech) load when the sheet is first
// opened (live/sheet.js).
import { t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { html, icon } from '../ui/kit.js';
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const sheet = {
  id: 'live',
  mount(el, ctx) {
    ctx.onAction('live-open', () => {
      import('../live/sheet.js')
        .then((m) => m.openLiveSheet(el, ctx))
        .catch((err) => console.error('[starpi] the live sheet failed to load', err));
    });
  },
};

/** @type {import('./registry.js').Feature} */
const button = {
  id: 'live-button',
  mount(el) {
    el.insertAdjacentHTML(
      'beforeend',
      html`<button type="button" id="liveOpenBtn" class="btn btn-ghost py-1 px-2 text-xs" data-action="live-open" aria-haspopup="dialog" aria-controls="liveSheet" data-i18n-title="live.open_hint" title="${t('live.open_hint')}">${icon('audio-lines', 'w-3.5 h-3.5')}<span data-i18n="live.open">${t('live.open')}</span></button>`.value,
    );
    refreshIcons(el);
  },
};

registerFeature('liveSheet', sheet);
registerFeature('composerExtras', button);
