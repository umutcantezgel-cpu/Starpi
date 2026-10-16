// @ts-check
// Providers: model providers, keys and transports in Settings. Stub until that package lands.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'providers',
  // Renders nothing yet.
  mount() {},
};

registerFeature('providerSettings', feature);
