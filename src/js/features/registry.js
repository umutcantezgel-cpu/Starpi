// @ts-check
// Feature registry: the seam between the app shell and feature modules. The shell owns the markup
// and provides empty mount points (elements with data-mount); a feature registers what it renders
// into which mount point, and main.js mounts every registration once at boot. Features build their
// own DOM from there, so they never edit index.html, main.js or another feature's files.
//
//   registerFeature('tab-research', { id: 'research', mount(el, ctx) { … } });
//
// A mount may be async. A failing mount is logged and does not stop the others.

/**
 * Element ids of the mount points in index.html, by area:
 * - chat: the conversation list in the sidebar, the tool slots of the chat toolbar and the composer,
 *   and the four panels of the chat side panel (#chat-aside);
 * - tabs: the Research and Companion views (the Companion nav entry stays hidden until its feature
 *   calls ctx.setNavVisible('companion', true));
 * - settings: one section per feature (workspaceSettings: files and semantic search on this device;
 *   syncSettings: the end-to-end encrypted chat sync);
 * - overlays: the full-screen live sheet.
 */
export const MOUNT_POINTS = Object.freeze([
  'chat-sidebar',
  'chatToolbarExtras',
  'composerExtras',
  'chat-aside-canvas',
  'chat-aside-sources',
  'chat-aside-compare',
  'chat-aside-research',
  'tab-research',
  'tab-companion',
  'providerSettings',
  'voiceSettings',
  'trustSettings',
  'memorySettings',
  'companionSettings',
  'workspaceSettings',
  'syncSettings',
  'liveSheet',
]);

/**
 * Shell services a feature may use (main.js supplies them).
 * @typedef {object} ShellServices
 * @property {typeof import('../dom.js').onAction} onAction
 * @property {typeof import('../dom.js').onChange} onChange
 * @property {typeof import('../i18n/index.js').onLocaleChange} onLocaleChange
 * @property {(tab: string, hook: () => void) => void} onTabOpen
 * @property {(tab: string) => void} switchTab
 * @property {(tab: string, visible: boolean) => void} setNavVisible
 * @property {(tab?: string) => void} openChatAside
 * @property {() => void} closeChatAside
 * @property {typeof import('../dialog.js').openDialog} openDialog
 * @property {typeof import('../dialog.js').closeDialog} closeDialog
 * @property {typeof import('../ui/kit.js').toast} toast
 */

/**
 * @typedef {ShellServices & { mountId: string, featureId: string }} FeatureContext
 */

/**
 * @typedef {object} Feature
 * @property {string} id
 * @property {(el: HTMLElement, ctx: FeatureContext) => void | Promise<void>} mount
 */

/** @typedef {{ mountId: string, id: string, ok: boolean }} MountResult */

/** @type {Array<{ mountId: string, feature: Feature, mounted: boolean }>} */
const registrations = [];

/**
 * Registers a feature for a mount point. Several features may share one mount point; they mount in
 * registration order.
 * @param {string} mountId element id of the mount point
 * @param {Feature} feature
 */
export function registerFeature(mountId, feature) {
  if (!mountId || typeof feature?.mount !== 'function' || !feature.id) throw new TypeError('registerFeature(mountId, { id, mount }) needs a mount point id, a feature id and a mount function');
  registrations.push({ mountId, feature, mounted: false });
}

/** @returns {Array<{ mountId: string, id: string }>} the registrations, in order */
export function listFeatures() {
  return registrations.map((r) => ({ mountId: r.mountId, id: r.feature.id }));
}

/**
 * Mounts every registration that has not been mounted yet, all at once. A missing mount point is
 * reported and skipped. Each mount point lists its mounted features in data-mounted.
 * @param {ShellServices} services
 * @param {{ getElementById(id: string): HTMLElement | null }} [root]
 * @returns {Promise<MountResult[]>}
 */
export async function mountFeatures(services, root = document) {
  const pending = registrations.filter((r) => !r.mounted);
  for (const r of pending) r.mounted = true;
  return Promise.all(
    pending.map(async ({ mountId, feature }) => {
      const el = root.getElementById(mountId);
      if (!el) {
        console.warn(`[starpi] feature "${feature.id}": mount point #${mountId} is missing`);
        return { mountId, id: feature.id, ok: false };
      }
      try {
        await feature.mount(el, { ...services, mountId, featureId: feature.id });
        const ids = new Set((el.dataset.mounted ?? '').split(' ').filter(Boolean));
        ids.add(feature.id);
        el.dataset.mounted = [...ids].join(' ');
        return { mountId, id: feature.id, ok: true };
      } catch (err) {
        console.error(`[starpi] feature "${feature.id}" failed to mount into #${mountId}`, err);
        return { mountId, id: feature.id, ok: false };
      }
    }),
  );
}
