// @ts-check
// Companion: the local companion service paired with this browser (its tab and its settings).
// Stub until that package lands; the Companion nav entry stays hidden until it calls
// ctx.setNavVisible('companion', true).
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'companion',
  // Renders nothing yet.
  mount() {},
};

registerFeature('tab-companion', feature);
registerFeature('companionSettings', feature);
