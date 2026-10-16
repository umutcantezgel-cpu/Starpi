// @ts-check
// Research jobs: the Research tab and the per-chat research panel. Stub until that package lands.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'research',
  // Renders nothing yet.
  mount() {},
};

registerFeature('tab-research', feature);
registerFeature('chat-aside-research', feature);
