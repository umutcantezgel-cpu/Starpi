// @ts-check
// Companion: Starpi Core, the local companion paired with this browser. This module only
// registers: the Companion tab (#tab-companion), its card under Settings (#companionSettings) and
// the retrieval source "Companion documents and notes" of grounded questions (chat/hooks.js).
// Pairing, the client, the tier and the views load as their own chunks after the first paint.
//
// Nothing here touches the network at boot: the stored link is read from IndexedDB, which also
// tells the voice input where the companion relays speech. The companion is asked only when the
// user opens its card or tab, pairs, or asks a grounded question while it is paired.
//
// In a build for the profile `companion` (the companion serves the app from its own loopback
// origin, Mode A), the page's origin is the companion and the Companion entry is always shown.
import { registerRetrievalSource } from '../chat/hooks.js';
import { readLocal } from '../storage.js';
import { registerFeature } from './registry.js';

/** Set while a pairing is stored (companion/pair.js LINK_MARKER): without it nothing is loaded for a question. */
export const LINK_MARKER = 'starpi_companion_linked';

/** The page's origin when the companion serves this build (Mode A), else null. */
const SELF_ORIGIN = typeof __STARPI_PROFILE__ === 'string' && __STARPI_PROFILE__ === 'companion' && typeof location !== 'undefined' ? location.origin : null;

/** @type {Promise<import('../companion/pair.js').Pairing> | null} */
let pairingPromise = null;

/** The page's pairing, loaded on first use. */
function pairing() {
  pairingPromise ??= import('../companion/pair.js').then(
    (m) => m.companionPairing({ selfOrigin: SELF_ORIGIN }),
    (err) => {
      pairingPromise = null;
      throw err;
    },
  );
  return pairingPromise;
}

registerRetrievalSource({
  id: 'companion',
  async search(query, ctx) {
    if (!SELF_ORIGIN && readLocal(LINK_MARKER) !== '1') return { hits: [], label: '' };
    const { companionSource } = await import('../companion/tier.js');
    return companionSource(pairing).search(query, ctx);
  },
});

/** Shows the Companion entry while a companion is paired (always in a companion build). */
let navWatched = false;

/** @type {import('./registry.js').Feature} */
const tab = {
  id: 'companion',
  async mount(el, ctx) {
    const [p, { mountCompanionTab }] = await Promise.all([pairing(), import('../companion/view.js')]);
    if (!navWatched) {
      navWatched = true;
      const show = () => ctx.setNavVisible('companion', SELF_ORIGIN !== null || p.state().phase === 'paired');
      p.subscribe(show);
      show();
    }
    void p.restore();
    mountCompanionTab(el, ctx, { pairing: p });
  },
};

/** @type {import('./registry.js').Feature} */
const settings = {
  id: 'companion-settings',
  async mount(el, ctx) {
    const [p, { mountCompanionSettings }] = await Promise.all([pairing(), import('../companion/view.js')]);
    void p.restore();
    mountCompanionSettings(el, ctx, { pairing: p });
  },
};

registerFeature('tab-companion', tab);
registerFeature('companionSettings', settings);
