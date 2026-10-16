// @ts-check
// Live voice conversation: the full-screen sheet (#liveSheet). Stub until that package lands.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'live',
  // Renders nothing yet.
  mount() {},
};

registerFeature('liveSheet', feature);
