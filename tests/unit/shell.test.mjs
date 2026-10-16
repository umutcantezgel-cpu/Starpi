// The app shell: the pre-paint script, the theme choice, the sidebar rail, the feature registry
// and the mount points of index.html.
/* global document, window */
import './setup.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX_HTML = readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
const THEME_BOOT = readFileSync(path.join(ROOT, 'src/js/theme-boot.js'), 'utf8');

/**
 * A matchMedia stub whose prefers-color-scheme answer can be changed (and announced) by the test.
 * @param {{ dark: boolean }} state
 */
function mediaStub(state) {
  /** @type {Set<(event: { matches: boolean }) => void>} */
  const listeners = new Set();
  const query = (/** @type {string} */ q) => ({
    media: q,
    get matches() {
      return q.includes('dark') ? state.dark : q.includes('min-width: 768px');
    },
    addEventListener: (/** @type {string} */ _type, /** @type {(event: { matches: boolean }) => void} */ fn) => listeners.add(fn),
    removeEventListener: (/** @type {string} */ _type, /** @type {(event: { matches: boolean }) => void} */ fn) => listeners.delete(fn),
  });
  return {
    query,
    /** @param {boolean} dark */
    flip(dark) {
      state.dark = dark;
      for (const fn of listeners) fn({ matches: dark });
    },
  };
}

/**
 * Runs theme-boot.js in a fresh page, as the browser does in <head>.
 * @param {{ theme?: string, sidebar?: string, systemDark?: boolean, blockStorage?: boolean }} opts
 */
function boot(opts) {
  const dom = new JSDOM('<!doctype html><html><head><meta name="color-scheme" content="light dark"></head><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window;
  if (opts.theme) win.localStorage.setItem('starpi_theme', opts.theme);
  if (opts.sidebar) win.localStorage.setItem('starpi_sidebar', opts.sidebar);
  win.matchMedia = /** @type {any} */ (mediaStub({ dark: Boolean(opts.systemDark) }).query);
  if (opts.blockStorage) {
    Object.defineProperty(win, 'localStorage', {
      get() {
        throw new win.DOMException('blocked', 'SecurityError');
      },
    });
  }
  win.eval(THEME_BOOT);
  const root = win.document.documentElement;
  return { classes: [...root.classList].sort().join(' '), theme: root.dataset.theme, sidebar: root.dataset.sidebar ?? null, scheme: win.document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') };
}

describe('theme-boot.js (before the first paint)', () => {
  it('follows the system setting without a stored choice', () => {
    assert.deepEqual(boot({ systemDark: true }), { classes: 'dark', theme: 'dark', sidebar: null, scheme: 'dark' });
    assert.deepEqual(boot({ systemDark: false }), { classes: 'light', theme: 'light', sidebar: null, scheme: 'light' });
    assert.equal(boot({ theme: 'system', systemDark: true }).theme, 'dark');
  });

  it('applies a stored choice over the system setting', () => {
    assert.equal(boot({ theme: 'dark', systemDark: false }).theme, 'dark');
    assert.equal(boot({ theme: 'light', systemDark: true }).theme, 'light');
  });

  it('restores the collapsed sidebar rail', () => {
    assert.equal(boot({ sidebar: 'collapsed' }).sidebar, 'collapsed');
    assert.equal(boot({ sidebar: 'other' }).sidebar, null);
  });

  it('keeps the defaults when storage is blocked', () => {
    assert.deepEqual(boot({ blockStorage: true, systemDark: true }), { classes: 'dark', theme: 'dark', sidebar: null, scheme: 'dark' });
  });

  it('stays a classic script: no import or export', () => {
    assert.doesNotMatch(THEME_BOOT, /^\s*(import|export)\b/m);
  });
});

/** @type {typeof import('../../src/js/ui/theme.js')} */
let theme;
/** @type {typeof import('../../src/js/ui/sidebar.js')} */
let sidebar;
/** @type {typeof import('../../src/js/features/registry.js')} */
let registry;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;
/** @type {ReturnType<typeof mediaStub>} */
let media;
/** @type {JSDOM} */
let page;

before(async () => {
  page = new JSDOM(INDEX_HTML, { url: 'http://localhost/' });
  const win = page.window;
  media = mediaStub({ dark: false });
  win.matchMedia = /** @type {any} */ (media.query);
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'NodeFilter', 'Text', 'localStorage', 'matchMedia', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? win : key === 'document' ? win.document : win[key], configurable: true, writable: true });
  }
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  theme = await import('../../src/js/ui/theme.js');
  sidebar = await import('../../src/js/ui/sidebar.js');
  registry = await import('../../src/js/features/registry.js');
  theme.initTheme();
  sidebar.initSidebar();
});

/** @param {string} action @param {string} [arg] */
function click(action, arg) {
  const selector = `[data-action="${action}"]${arg === undefined ? '' : `[data-arg="${arg}"]`}`;
  const el = document.querySelector(selector);
  assert.ok(el, selector);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

describe('theme', () => {
  beforeEach(() => localStorage.clear());

  it('resolves preferences', () => {
    assert.equal(theme.resolveTheme('system', true), 'dark');
    assert.equal(theme.resolveTheme('system', false), 'light');
    assert.equal(theme.resolveTheme('dark', false), 'dark');
    assert.equal(theme.normalizeThemePreference('sepia'), 'system');
  });

  it('renders the Appearance control and applies and stores a choice from it', () => {
    const group = document.getElementById('themeControl');
    assert.equal(group?.querySelector('[aria-pressed="true"]')?.getAttribute('data-arg'), 'system');
    click('set-theme', 'dark');
    assert.equal(document.documentElement.classList.contains('dark'), true);
    assert.equal(document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'), 'dark');
    assert.equal(localStorage.getItem(theme.THEME_KEY), 'dark');
    assert.equal(group?.querySelector('[aria-pressed="true"]')?.getAttribute('data-arg'), 'dark');
    click('set-theme', 'system');
    assert.equal(localStorage.getItem(theme.THEME_KEY), null);
    assert.equal(theme.currentTheme(), 'light');
  });

  it('follows a change of the system setting only while the choice is "system"', () => {
    /** @type {string[]} */
    const seen = [];
    const off = theme.onThemeChange((t) => seen.push(t));
    media.flip(true);
    assert.equal(theme.currentTheme(), 'dark');
    theme.setThemePreference('light');
    media.flip(false);
    media.flip(true);
    assert.equal(theme.currentTheme(), 'light');
    theme.setThemePreference('system');
    assert.equal(theme.currentTheme(), 'dark');
    media.flip(false);
    off();
    assert.deepEqual(seen, ['dark', 'light', 'dark', 'light']);
  });
});

describe('sidebar rail', () => {
  beforeEach(() => {
    localStorage.clear();
    sidebar.applySidebarCollapsed(false);
  });

  it('collapses from its toggle, stores the choice and names the toggle after its next step', () => {
    click('toggle-rail');
    assert.equal(sidebar.isSidebarCollapsed(), true);
    assert.equal(localStorage.getItem(sidebar.SIDEBAR_KEY), 'collapsed');
    const toggle = document.getElementById('sidebarCollapseBtn');
    assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle?.getAttribute('aria-label'), 'Expand sidebar');
    // Hidden labels become tooltips that follow the label's i18n key.
    const nav = document.getElementById('nav-library');
    assert.equal(nav?.getAttribute('title'), 'Knowledge base');
    assert.equal(nav?.getAttribute('data-i18n-title'), 'nav.library');
    click('toggle-rail');
    assert.equal(sidebar.isSidebarCollapsed(), false);
    assert.equal(localStorage.getItem(sidebar.SIDEBAR_KEY), null);
    assert.equal(nav?.hasAttribute('title'), false);
    assert.equal(toggle?.getAttribute('aria-label'), 'Collapse sidebar');
  });

  it('still collapses for this page when the browser refuses to store it', () => {
    const setItem = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = () => {
      throw new window.DOMException('full', 'QuotaExceededError');
    };
    try {
      assert.equal(sidebar.setSidebarCollapsed(true), false);
      assert.equal(sidebar.isSidebarCollapsed(), true);
    } finally {
      window.Storage.prototype.setItem = setItem;
    }
  });

  it('reads only "collapsed" as collapsed', () => {
    localStorage.setItem(sidebar.SIDEBAR_KEY, 'yes');
    assert.equal(sidebar.readSidebarCollapsed(), false);
    localStorage.setItem(sidebar.SIDEBAR_KEY, 'collapsed');
    assert.equal(sidebar.readSidebarCollapsed(), true);
  });

  it('shows and hides nav entries in the sidebar and the bottom bar', () => {
    assert.equal(sidebar.isNavVisible('companion'), false);
    assert.equal(document.getElementById('mobile-nav-companion')?.classList.contains('hidden'), true);
    sidebar.setNavVisible('companion', true);
    assert.equal(sidebar.isNavVisible('companion'), true);
    assert.equal(document.getElementById('mobile-nav-companion')?.classList.contains('hidden'), false);
    sidebar.setNavVisible('companion', false);
    assert.equal(sidebar.isNavVisible('companion'), false);
  });
});

describe('mount points', () => {
  it('exist in index.html as empty data-mount elements', () => {
    const doc = new JSDOM(INDEX_HTML).window.document;
    for (const id of registry.MOUNT_POINTS) {
      const el = doc.getElementById(id);
      assert.ok(el, `#${id} missing`);
      assert.ok(el.hasAttribute('data-mount'), `#${id} lacks data-mount`);
      assert.equal(el.innerHTML, '', `#${id} is not empty`);
    }
    // The side panel with its four tabs, and every tab of the navigation in both navigations.
    assert.ok(doc.getElementById('chat-aside'));
    for (const tab of ['canvas', 'sources', 'compare', 'research']) assert.equal(doc.getElementById(`chat-aside-tab-${tab}`)?.getAttribute('role'), 'tab');
    for (const tab of ['chat', 'research', 'library', 'ingest', 'graph', 'bench', 'companion', 'settings']) {
      assert.ok(doc.getElementById(`tab-${tab}`), `#tab-${tab}`);
      assert.ok(doc.getElementById(`nav-${tab}`), `#nav-${tab}`);
      assert.ok(doc.getElementById(`mobile-nav-${tab}`), `#mobile-nav-${tab}`);
    }
  });

  it('have their feature stubs registered against known mount points', async () => {
    const features = await import('../../src/js/features/index.js');
    const listed = features.listFeatures();
    assert.ok(listed.length >= 10);
    for (const { mountId, id } of listed) assert.ok(registry.MOUNT_POINTS.includes(mountId), `${id} → #${mountId}`);
    for (const id of ['research', 'voice', 'live', 'companion', 'memory', 'providers', 'trust']) assert.ok(listed.some((f) => f.id === id), id);
  });
});

describe('feature registry', () => {
  /** @type {any} */
  const services = { toast() {} };

  it('mounts each registration once, isolates failures and skips missing mount points', async () => {
    const doc = new JSDOM('<div id="a" data-mount></div><div id="b" data-mount></div>').window.document;
    /** @type {string[]} */
    const calls = [];
    const errors = console.error;
    const warns = console.warn;
    /** @type {unknown[]} */
    const logged = [];
    console.error = (...args) => logged.push(args[0]);
    console.warn = (...args) => logged.push(args[0]);
    try {
      registry.registerFeature('a', { id: 'one', mount: (el, ctx) => void calls.push(`${ctx.featureId}@${el.id}:${ctx.mountId}:${typeof ctx.toast}`) });
      registry.registerFeature('a', { id: 'two', mount: async (el) => void calls.push(`two@${el.id}`) });
      registry.registerFeature('b', { id: 'broken', mount: () => { throw new Error('boom'); } });
      registry.registerFeature('nowhere', { id: 'lost', mount: () => void calls.push('lost') });
      const results = (await registry.mountFeatures(services, doc)).filter((r) => ['one', 'two', 'broken', 'lost'].includes(r.id));
      assert.deepEqual(results, [
        { mountId: 'a', id: 'one', ok: true },
        { mountId: 'a', id: 'two', ok: true },
        { mountId: 'b', id: 'broken', ok: false },
        { mountId: 'nowhere', id: 'lost', ok: false },
      ]);
      assert.deepEqual(calls, ['one@a:a:function', 'two@a']);
      assert.equal(doc.getElementById('a')?.dataset.mounted, 'one two');
      assert.equal(doc.getElementById('b')?.dataset.mounted, undefined);
      assert.equal(logged.filter((m) => /"(broken|lost)"/.test(String(m))).length, 2);
      // A second boot step mounts nothing twice.
      assert.deepEqual((await registry.mountFeatures(services, doc)).filter((r) => r.id === 'one'), []);
    } finally {
      console.error = errors;
      console.warn = warns;
    }
  });

  it('refuses registrations without an id or a mount function', () => {
    assert.throws(() => registry.registerFeature('a', /** @type {any} */ ({ id: 'x' })), TypeError);
    assert.throws(() => registry.registerFeature('', { id: 'x', mount() {} }), TypeError);
  });
});
