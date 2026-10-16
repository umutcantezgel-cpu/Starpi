// @ts-check
// Conversations: the conversation list in the sidebar (#chat-sidebar). Stub until that package lands.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'conversations',
  // Renders nothing yet.
  mount() {},
};

registerFeature('chat-sidebar', feature);
