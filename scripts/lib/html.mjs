// The page of the build (dist/index.html): where scripts/build.mjs puts the theme script, and which
// scripts the page loads before it can run (scripts/verify-dist.mjs budgets their size).

/** In src/index.html: replaced by the URL of the theme script, or its tag removed without one. */
export const THEME_BOOT_PLACEHOLDER = '%STARPI_THEME_BOOT_JS%';

/**
 * Puts the theme script into the page as a classic, render-blocking script: at the placeholder when
 * the page has one, else as the first script in <head>, before the stylesheet, so it runs before the
 * first paint. Without a theme script (null) a placeholder tag is removed, and a page without a
 * placeholder stays as it is.
 * @param {string} html
 * @param {string | null} url
 */
export function injectThemeBoot(html, url) {
  if (html.includes(THEME_BOOT_PLACEHOLDER)) {
    if (url) return html.replaceAll(THEME_BOOT_PLACEHOLDER, url);
    return html.replace(/[ \t]*<script\b[^>]*%STARPI_THEME_BOOT_JS%[^>]*>\s*<\/script>[ \t]*\r?\n?/g, '');
  }
  if (!url) return html;
  const stylesheet = html.search(/<link\b[^>]*\brel="stylesheet"/i);
  const headEnd = html.search(/<\/head>/i);
  if (headEnd < 0) throw new Error('the page has no </head> to put the theme script in');
  const at = stylesheet >= 0 && stylesheet < headEnd ? stylesheet : headEnd;
  return `${html.slice(0, at)}<script src="${url}"></script>\n  ${html.slice(at)}`;
}

/**
 * The URLs of the external scripts a page loads, in document order.
 * @param {string} html
 * @returns {string[]}
 */
export function pageScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1].match(/\bsrc="([^"]+)"/)?.[1]).filter((src) => typeof src === 'string');
}

/**
 * The relative static imports of a bundled ES module ("import ... from './x.js'", "import './x.js'",
 * "export ... from './x.js'"), resolved against the module's own URL. Dynamic import() is left out:
 * it loads later, on demand. The bundles are minified, so the patterns allow missing spaces.
 * @param {string} code
 * @param {string} url the module's URL path, e.g. /assets/main-ABC.js
 * @returns {string[]}
 */
export function staticImports(code, url) {
  const base = new URL(url, 'https://build.invalid');
  /** @type {Set<string>} */
  const found = new Set();
  for (const m of code.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"'\s]+\.js)["']/g)) found.add(new URL(m[1], base).pathname);
  return [...found];
}
