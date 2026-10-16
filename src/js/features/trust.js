// @ts-check
// Trust: signing keys for answer receipts, in Settings. Stub until that package lands.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'trust',
  // Renders nothing yet.
  mount() {},
};

registerFeature('trustSettings', feature);
