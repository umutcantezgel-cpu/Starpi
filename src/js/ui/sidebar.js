// @ts-check
// The app sidebar. From md up it is a column that collapses to an icon rail; the choice is kept in
// this browser and theme-boot.js applies it before the first paint. Below md it is an off-canvas
// drawer opened from the header, next to the bottom navigation. Features show or hide their nav
// entries with setNavVisible() instead of editing the markup.
import { byId, onAction } from '../dom.js';
import { t } from '../i18n/index.js';
import { readLocal, removeLocal, writeLocal } from '../storage.js';

/** localStorage key; 'collapsed' is the only stored value (expanded is the default). */
export const SIDEBAR_KEY = 'starpi_sidebar';

const desktop = globalThis.matchMedia?.('(min-width: 768px)');

/** @returns {boolean} the stored choice; missing, other values and blocked storage mean expanded */
export function readSidebarCollapsed() {
  return readLocal(SIDEBAR_KEY) === 'collapsed';
}

/** @returns {boolean} whether the page shows the rail right now (<html data-sidebar>) */
export function isSidebarCollapsed() {
  return document.documentElement.dataset.sidebar === 'collapsed';
}

/**
 * Shows the rail or the full sidebar without storing anything. The toggle is named after what it
 * does next; while the labels are hidden, every nav entry gets its label as a tooltip that follows
 * the label's i18n key.
 * @param {boolean} collapsed
 */
export function applySidebarCollapsed(collapsed) {
  const root = document.documentElement;
  if (collapsed) root.dataset.sidebar = 'collapsed';
  else delete root.dataset.sidebar;
  const toggle = byId('sidebarCollapseBtn');
  if (toggle) {
    const key = collapsed ? 'shell.sidebar.expand' : 'shell.sidebar.collapse';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('data-i18n-aria', key);
    toggle.setAttribute('data-i18n-title', key);
    toggle.setAttribute('aria-label', t(key));
    toggle.setAttribute('title', t(key));
  }
  for (const item of document.querySelectorAll('#sidebar .nav-item')) {
    const key = item.querySelector('.nav-label')?.getAttribute('data-i18n');
    if (collapsed && key) {
      item.setAttribute('data-i18n-title', key);
      item.setAttribute('title', t(key));
    } else {
      item.removeAttribute('data-i18n-title');
      item.removeAttribute('title');
    }
  }
}

/**
 * Collapses or expands the sidebar and remembers the choice. When the browser refuses to store it,
 * the choice still holds for this page.
 * @param {boolean} collapsed
 * @returns {boolean} false when the choice could not be stored
 */
export function setSidebarCollapsed(collapsed) {
  applySidebarCollapsed(collapsed);
  if (collapsed) return writeLocal(SIDEBAR_KEY, 'collapsed');
  removeLocal(SIDEBAR_KEY);
  return readLocal(SIDEBAR_KEY) === null;
}

/**
 * Opens or closes the drawer on phones (the desktop sidebar is always shown).
 * @param {boolean} [forcedState]
 */
export function toggleSidebar(forcedState) {
  const sidebar = byId('sidebar');
  const backdrop = byId('mobileBackdrop');
  if (!sidebar || !backdrop) return;
  const isVisible = !sidebar.classList.contains('-translate-x-full');
  const shouldOpen = forcedState ?? !isVisible;
  sidebar.classList.toggle('-translate-x-full', !shouldOpen);
  backdrop.classList.toggle('hidden', !shouldOpen);
  syncSidebarAccess(shouldOpen);
  if (shouldOpen && !desktop?.matches) /** @type {HTMLElement | null} */ (sidebar.querySelector('nav button, a'))?.focus();
}

/**
 * On phones the closed drawer is only moved off screen; `inert` keeps it out of the tab order and
 * away from screen readers until it is opened.
 * @param {boolean} [open]
 */
export function syncSidebarAccess(open = false) {
  const sidebar = byId('sidebar');
  const closed = !desktop?.matches && !open;
  if (sidebar) sidebar.inert = closed;
  byId('menuButton')?.setAttribute('aria-expanded', String(!closed && !desktop?.matches));
}

/**
 * Shows or hides a tab's entries in the sidebar and in the bottom navigation.
 * @param {string} tab e.g. 'companion'
 * @param {boolean} visible
 */
export function setNavVisible(tab, visible) {
  for (const id of [`nav-${tab}`, `mobile-nav-${tab}`]) byId(id)?.classList.toggle('hidden', !visible);
}

/** @param {string} tab @returns {boolean} */
export function isNavVisible(tab) {
  const item = byId(`nav-${tab}`);
  return Boolean(item && !item.classList.contains('hidden'));
}

/** Boot step: shows the stored rail state and wires the toggles. */
export function initSidebar() {
  applySidebarCollapsed(readSidebarCollapsed());
  onAction('toggle-rail', () => setSidebarCollapsed(!isSidebarCollapsed()));
  onAction('toggle-sidebar', () => toggleSidebar());
  syncSidebarAccess(false);
  // A layout change keeps the drawer's real state: it may still be open on the phone layout.
  desktop?.addEventListener?.('change', () => syncSidebarAccess(!byId('sidebar')?.classList.contains('-translate-x-full')));
}
