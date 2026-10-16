// @ts-check
// Canvas and compare: the editable artifact view and the side-by-side model answers in the chat
// side panel (#chat-aside). Stub until that package lands.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'canvas',
  // Renders nothing yet.
  mount() {},
};

registerFeature('chat-aside-canvas', feature);
registerFeature('chat-aside-compare', feature);
