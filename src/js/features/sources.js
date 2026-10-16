// @ts-check
// Sources: the passages an answer used, in the chat side panel. Stub until that package lands.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'sources',
  // Renders nothing yet.
  mount() {},
};

registerFeature('chat-aside-sources', feature);
