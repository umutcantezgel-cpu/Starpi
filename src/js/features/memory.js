// @ts-check
// Memory, projects, assistants and custom instructions. This module only registers: the settings
// card (#memorySettings, settings/memory-view.js), the project and assistant sections of the sidebar,
// the chip in the chat toolbar, "Remember this" on messages, and the chat hooks that add a
// conversation's context to its questions (chat/context.js). Everything else loads after the first
// paint, as its own chunks.
//
// Memory is off until the user turns it on; nothing is stored without an explicit act.
import { registerMessageAction, registerRequestNotes, registerSidebarSection, registerSystemNote, setWorkspaceScope } from '../chat/hooks.js';
import { registerFeature } from './registry.js';

/** @type {Promise<typeof import('../chat/context.js')> | null} */
let contextModule = null;
/** Set once the context module has loaded (the action bars read it synchronously). */
/** @type {typeof import('../chat/context.js') | null} */
let loaded = null;

/** The chat side of this feature, loaded on first use. */
function context() {
  contextModule ??= import('../chat/context.js').then(
    (m) => {
      loaded = m;
      return m;
    },
    (err) => {
      contextModule = null;
      throw err;
    },
  );
  return contextModule;
}

/** @type {typeof import('../ui/kit.js').toast | null} */
let toast = null;

// The saved notes go along with the request of the question being answered only, never stored with it.
registerRequestNotes(async (ctx) => (await context()).requestNotes(ctx));
registerSystemNote(async (ctx) => (await context()).systemNote(ctx));
setWorkspaceScope(async (id) => (await context()).workspaceScope(id));
registerMessageAction({
  id: 'remember',
  labelKey: 'memory.remember.action',
  icon: 'bookmark-plus',
  when: (node) => (node.role === 'user' || node.role === 'assistant') && Boolean(loaded?.memoryEnabled()),
  run: async (node, ctx) => (await context()).rememberMessage(node, ctx, (message, opts) => toast?.(message, opts) ?? (() => {})),
});
registerSidebarSection('projects', (host, ctx) => lazySection(host, (m) => m.projectsSection(host, ctx)));
registerSidebarSection('assistants', (host, ctx) => lazySection(host, (m) => m.assistantsSection(host, ctx)));

/**
 * Mounts a sidebar section once the context module has loaded.
 * @param {HTMLElement} host
 * @param {(m: typeof import('../chat/context.js')) => () => void} mount
 * @returns {() => void}
 */
function lazySection(host, mount) {
  /** @type {(() => void) | null} */
  let cleanup = null;
  let gone = false;
  void context()
    .then((m) => {
      if (!gone && host.isConnected !== false) cleanup = mount(m);
    })
    .catch((err) => console.warn('[starpi] a sidebar section could not load', err));
  return () => {
    gone = true;
    cleanup?.();
  };
}

/** @type {import('./registry.js').Feature} */
const settings = {
  id: 'memory',
  async mount(el, ctx) {
    toast = ctx.toast;
    const [m, { mountMemoryView }] = await Promise.all([context(), import('../settings/memory-view.js')]);
    void m.startContext({ toast: ctx.toast }).catch((err) => console.warn('[starpi] memory could not start', err));
    mountMemoryView(el, ctx);
  },
};

/** @type {import('./registry.js').Feature} */
const chip = {
  id: 'chat-context',
  async mount(el) {
    (await context()).mountContextChip(el);
  },
};

registerFeature('memorySettings', settings);
registerFeature('chatToolbarExtras', chip);
