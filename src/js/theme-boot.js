// @ts-check
// Pre-paint preferences. Loaded from <head> as a classic, blocking script before the stylesheet (the
// CSP allows no inline script), so the first frame already has the stored colour theme and the
// sidebar rail: no light flash on a dark page, no jump of the sidebar width.
//
// - Theme: 'light' or 'dark' as stored by ui/theme.js; anything else (also 'system' or no entry)
//   follows prefers-color-scheme. Sets <html class="dark|light">, data-theme and the color-scheme
//   meta tag, which colours the canvas and form controls before CSS arrives.
// - Sidebar: 'collapsed' as stored by ui/sidebar.js marks <html data-sidebar="collapsed">.
//
// The storage keys are duplicated from those modules on purpose: this file must stay tiny and import
// nothing. Blocked storage (private mode, disabled site data) means the defaults.
(() => {
  const root = document.documentElement;
  /** @param {string} key */
  const read = (key) => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const stored = read('starpi_theme');
  const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
  const dark = stored === 'dark' || (stored !== 'light' && prefersDark);
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  root.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light');
  if (read('starpi_sidebar') === 'collapsed') root.dataset.sidebar = 'collapsed';
})();
