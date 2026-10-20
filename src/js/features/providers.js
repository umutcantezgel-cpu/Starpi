// @ts-check
// Providers: model providers, keys and transports in Settings (settings/providers-view.js). Mounting
// also installs the transport resolver of the AI layer (keys, site pools, relay setting, remembered
// routes) and reports clicks and key presses to the key vault, whose auto-lock counts inactivity.
import { noteActivity } from '../ai/keys.js';
import { getLlmUrl } from '../state.js';
import { registerFeature } from './registry.js';

/** Activity is reported at most this often. */
const ACTIVITY_THROTTLE_MS = 5_000;

function watchActivity() {
  let last = 0;
  const report = () => {
    const now = Date.now();
    if (now - last < ACTIVITY_THROTTLE_MS) return;
    last = now;
    noteActivity();
  };
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, report, { capture: true, passive: true });
}

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'providers',
  async mount(el, ctx) {
    watchActivity();
    // The view and the transport selection load as their own chunk, after the first paint.
    const [{ installTransportResolver }, { mountProvidersView }] = await Promise.all([import('../ai/transport-select.js'), import('../settings/providers-view.js')]);
    installTransportResolver({ localUrl: getLlmUrl });
    mountProvidersView(el, ctx);
  },
};

registerFeature('providerSettings', feature);
