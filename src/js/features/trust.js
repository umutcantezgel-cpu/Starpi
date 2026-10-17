// @ts-check
// Trust: the key this device signs answer receipts with, in Settings (trust/settings-view.js). The
// view and the signer load as their own chunk after the first paint; the receipt dialog loads the
// signer by itself when it exports or verifies a receipt (rag/receipts.js).
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'trust',
  async mount(el, ctx) {
    const { mountTrustView } = await import('../trust/settings-view.js');
    mountTrustView(el, ctx);
  },
};

registerFeature('trustSettings', feature);
