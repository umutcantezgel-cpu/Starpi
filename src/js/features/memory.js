// @ts-check
// Memory: opt-in facts the assistant may remember, managed in Settings. Stub until that package lands.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'memory',
  // Renders nothing yet.
  mount() {},
};

registerFeature('memorySettings', feature);
