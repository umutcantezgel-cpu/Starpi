// @ts-check
// Voice: speech input and read-aloud (Settings section and composer controls). Stub until that
// package lands.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'voice',
  // Renders nothing yet.
  mount() {},
};

registerFeature('voiceSettings', feature);
registerFeature('composerExtras', feature);
