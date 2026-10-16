// @ts-check
// Color theme: 'system' (the default, follows prefers-color-scheme), 'light' or 'dark'.
// theme-boot.js applies the stored choice before the first paint; this module keeps the page in step
// afterwards (a change of the system setting, the choice in Settings → Appearance) and renders that
// control. The theme itself is the `dark` class on <html> plus the color tokens in app.css.
import { byId, onAction, setHtml } from '../dom.js';
import { readLocal, removeLocal, writeLocal } from '../storage.js';
import { card, html, label, segmented, setSegmentedValue, toast } from './kit.js';

/** @typedef {'system' | 'light' | 'dark'} ThemePreference */
/** @typedef {'light' | 'dark'} Theme */

/** localStorage key, shared with theme-boot.js. 'system' is stored as no entry. */
export const THEME_KEY = 'starpi_theme';
export const THEME_PREFERENCES = /** @type {readonly ThemePreference[]} */ (Object.freeze(['system', 'light', 'dark']));

const darkQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');

/** @type {Set<(theme: Theme) => void>} */
const listeners = new Set();

/**
 * @param {unknown} value
 * @returns {ThemePreference}
 */
export function normalizeThemePreference(value) {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * @param {ThemePreference} preference
 * @param {boolean} systemPrefersDark
 * @returns {Theme}
 */
export function resolveTheme(preference, systemPrefersDark) {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/** @returns {ThemePreference} */
export function readThemePreference() {
  return normalizeThemePreference(readLocal(THEME_KEY));
}

/** @returns {Theme} the theme the page shows */
export function currentTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Shows a theme: the class and data-theme on <html> and the color-scheme meta tag, then tells the
 * subscribers (views that draw with colors of their own).
 * @param {Theme} theme
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  const changed = currentTheme() !== theme || root.dataset.theme !== theme;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme !== 'dark');
  root.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  if (!changed) return;
  for (const fn of listeners) {
    try {
      fn(theme);
    } catch (err) {
      console.error('[starpi] theme listener failed', err);
    }
  }
}

/** The choice made on this page when the browser refused to store it. @type {ThemePreference | null} */
let preferenceOverride = null;

/** @returns {ThemePreference} */
function activePreference() {
  return preferenceOverride ?? readThemePreference();
}

/**
 * Stores and applies a preference.
 * @param {ThemePreference} preference
 * @returns {boolean} false when the browser did not store it (it still applies to this page)
 */
export function setThemePreference(preference) {
  const next = normalizeThemePreference(preference);
  if (next === 'system') removeLocal(THEME_KEY);
  const stored = next === 'system' ? readLocal(THEME_KEY) === null : writeLocal(THEME_KEY, next);
  // Without storage the page still follows the choice until it is reloaded.
  preferenceOverride = stored ? null : next;
  applyTheme(resolveTheme(next, darkQuery?.matches === true));
  setSegmentedValue(byId('themeControl'), next);
  return stored;
}

/**
 * @param {(theme: Theme) => void} fn
 * @returns {() => void}
 */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Renders Settings → Appearance (a card with the segmented control) into #appearanceSettings. */
export function renderAppearanceSettings() {
  const host = byId('appearanceSettings');
  if (!host) return;
  setHtml(
    host,
    card({
      title: 'shell.theme.title',
      icon: 'sun',
      body: html`${segmented({
        id: 'themeControl',
        action: 'set-theme',
        label: 'shell.theme.label',
        value: activePreference(),
        options: [
          { value: 'system', label: 'shell.theme.system', icon: 'monitor' },
          { value: 'light', label: 'shell.theme.light', icon: 'sun' },
          { value: 'dark', label: 'shell.theme.dark', icon: 'moon' },
        ],
      })}${label('shell.theme.hint', { tag: 'p', className: 'text-[11px] text-slate-500' })}`,
    }).value,
  );
}

/** Boot step: confirms the theme theme-boot.js chose, follows system changes and wires the control. */
export function initTheme() {
  applyTheme(resolveTheme(activePreference(), darkQuery?.matches === true));
  darkQuery?.addEventListener?.('change', (event) => {
    if (activePreference() === 'system') applyTheme(event.matches ? 'dark' : 'light');
  });
  // Another tab changed the choice.
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_KEY && event.key !== null) return;
    preferenceOverride = null;
    const preference = readThemePreference();
    applyTheme(resolveTheme(preference, darkQuery?.matches === true));
    setSegmentedValue(byId('themeControl'), preference);
  });
  onAction('set-theme', (el) => {
    if (!setThemePreference(normalizeThemePreference(el.dataset.arg))) toast('shell.theme.not_saved', { tone: 'warn' });
  });
  renderAppearanceSettings();
}
