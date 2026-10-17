// @ts-check
// Trust in Settings: the key this device signs answer receipts with (trust/settings-view.js), and
// the check of downloaded model files (trust/model-integrity-view.js). Both views load as their own
// chunks after the first paint, each into its own card; the receipt dialog loads the signer by itself
// when it exports or verifies a receipt (rag/receipts.js), and the model check loads with a model.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'trust',
  async mount(el, ctx) {
    // Hosts first, so the cards keep their order whichever view loads first.
    const signing = document.createElement('div');
    const models = document.createElement('div');
    models.className = 'mt-5';
    el.append(signing, models);
    const [{ mountTrustView }, { mountModelIntegrityView }] = await Promise.all([import('../trust/settings-view.js'), import('../trust/model-integrity-view.js')]);
    mountTrustView(signing, ctx);
    mountModelIntegrityView(models, ctx);
  },
};

registerFeature('trustSettings', feature);
