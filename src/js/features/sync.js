// @ts-check
// Chat sync in Settings: the end-to-end encrypted sync of conversations (sync/*). The engine starts
// at boot, so a browser that syncs keeps syncing without the Settings tab being opened; it stays
// idle until sync is turned on. The card and the engine load as their own chunks after the first
// paint.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'sync',
  async mount(el, ctx) {
    const [{ startChatSync }, { mountSyncView }, api] = await Promise.all([import('../sync/service.js'), import('../sync/settings-view.js'), import('../supabase.js')]);
    const sync = await startChatSync();
    mountSyncView(el, ctx, { sync, api });
  },
};

registerFeature('syncSettings', feature);
