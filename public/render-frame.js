/* global window, document, location, DOMParser, Element, ResizeObserver */
// Script of the render frame (public/render-frame.html). scripts/build.mjs bundles it with everything
// it imports into one classic file: the frame's opaque origin can load nothing but its own
// exact-path script. The diagram library is part of that file but only evaluated when a diagram
// arrives.
//
// Message protocol (the app side is mountRenderFrame() in src/js/render.js):
// 1. This script tells its parent { type: 'starpi-render-ready' }, addressed to the app's origin.
// 2. The app answers { type: 'starpi-render', kind, source, theme, run } with kind 'html', 'svg' or
//    'mermaid' and theme 'light' or 'dark'. Only a message of the parent window from the app's origin
//    counts (location.origin is the origin of this URL, the app's; the document's own is opaque).
// 3. html without run: sanitized (no scripts, event handlers, frames, forms or remote resources) and
//    shown; links do not navigate. html with run, after the user clicked "Run preview": inserted as
//    written, its inline scripts run, here, in the opaque origin without network. svg: sanitized.
//    mermaid: drawn with securityLevel strict, sanitized again, and on failure the frame reports
//    { type: 'starpi-render-error', code: 'diagram' }.
// 4. The frame reports { type: 'starpi-render-height', height } (CSS pixels) whenever its content
//    height changes. The app takes the height only from this frame's window and caps it.
import DOMPurify from 'dompurify';

/** The app refuses longer sources too (MAX_PREVIEW_CHARS in src/js/render.js). */
const MAX_SOURCE = 512_000;
const KINDS = new Set(['html', 'svg', 'mermaid']);
const APP_ORIGIN = location.origin;
const SVG_NS = 'http://www.w3.org/2000/svg';
const root = /** @type {HTMLElement} */ (document.getElementById('preview'));

// Remote resources cannot load here (default-src 'none'); dropping their URLs keeps the console quiet.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  const name = data.attrName;
  const resource = name === 'src' || name === 'srcset' || name === 'poster' || name === 'background' || ((name === 'href' || name === 'xlink:href') && node.namespaceURI === SVG_NS && node.tagName.toLowerCase() !== 'a');
  if (resource && !/^(?:data:|blob:|#)/i.test(data.attrValue.trim())) data.keepAttr = false;
});

const STATIC_HTML = {
  FORCE_BODY: true,
  FORBID_TAGS: ['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'base', 'link', 'meta'],
};
const STATIC_SVG = { USE_PROFILES: { svg: true, svgFilters: true } };
// Mermaid's labels are HTML inside <foreignObject>.
const DIAGRAM = { USE_PROFILES: { svg: true, svgFilters: true, html: true }, ADD_TAGS: ['foreignObject'], HTML_INTEGRATION_POINTS: { foreignobject: true } };

/** @type {'empty' | 'html' | 'html-run' | 'svg' | 'mermaid'} */
let mode = 'empty';
/** Counts renders, so a slow diagram never replaces a newer one. */
let generation = 0;

/** @param {Record<string, unknown>} message */
const tell = (message) => window.parent.postMessage(message, APP_ORIGIN);

let reported = -1;
function reportHeight() {
  const height = Math.ceil(Math.max(document.body.scrollHeight, root.getBoundingClientRect().height));
  if (height === reported) return;
  reported = height;
  tell({ type: 'starpi-render-height', height });
}

/**
 * @param {string} html  sanitized markup
 * @param {string} className
 */
function show(html, className) {
  root.className = className;
  root.innerHTML = html;
}

/**
 * Inserts an HTML document as written and runs its inline scripts in order (scripts parsed by
 * DOMParser never run by themselves, so each is recreated). Script URLs are dropped: nothing outside
 * this file may load here.
 * @param {string} source
 */
function runHtml(source) {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  root.className = '';
  root.replaceChildren(...[...parsed.head.querySelectorAll('style, script'), ...parsed.body.childNodes].map((node) => document.importNode(node, true)));
  for (const name of ['class', 'style']) {
    const value = parsed.body.getAttribute(name);
    if (value !== null) document.body.setAttribute(name, value);
  }
  for (const old of [...root.querySelectorAll('script')]) {
    if (old.hasAttribute('src')) {
      old.remove();
      continue;
    }
    const script = document.createElement('script');
    for (const { name, value } of [...old.attributes]) script.setAttribute(name, value);
    script.textContent = old.textContent;
    old.replaceWith(script);
  }
}

/**
 * @param {string} source
 * @param {'light' | 'dark'} theme
 * @param {number} current
 */
async function drawDiagram(source, theme, current) {
  const id = `diagram-${current}`;
  try {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: theme === 'dark' ? 'dark' : 'default',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    });
    const { svg } = await mermaid.render(id, source);
    if (current !== generation) return;
    show(/** @type {string} */ (/** @type {unknown} */ (DOMPurify.sanitize(svg, DIAGRAM))), 'diagram');
  } catch {
    if (current !== generation) return;
    show('', '');
    tell({ type: 'starpi-render-error', code: 'diagram' });
  } finally {
    // Mermaid measures in a scratch element of its own, which a failed render can leave behind.
    for (const scratch of [document.getElementById(id), document.getElementById(`d${id}`)]) if (scratch && !root.contains(scratch)) scratch.remove();
    reportHeight();
  }
}

/**
 * @param {string} kind
 * @param {string} source
 * @param {'light' | 'dark'} theme
 * @param {boolean} run
 */
function render(kind, source, theme, run) {
  generation += 1;
  document.body.removeAttribute('class');
  document.body.removeAttribute('style');
  if (kind === 'mermaid') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  if (kind === 'html' && run) {
    mode = 'html-run';
    runHtml(source);
  } else if (kind === 'html') {
    mode = 'html';
    show(/** @type {string} */ (/** @type {unknown} */ (DOMPurify.sanitize(source, STATIC_HTML))), '');
  } else if (kind === 'svg') {
    mode = 'svg';
    show(/** @type {string} */ (/** @type {unknown} */ (DOMPurify.sanitize(source, STATIC_SVG))), 'vector');
  } else {
    mode = 'mermaid';
    void drawDiagram(source, theme, generation);
  }
  reportHeight();
}

// Without scripts a link would navigate the frame away from its preview.
root.addEventListener('click', (event) => {
  if (mode === 'html-run') return;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (link && !(link.getAttribute('href') ?? '').startsWith('#')) event.preventDefault();
});

window.addEventListener('message', (event) => {
  if (window.parent === window || event.source !== window.parent || event.origin !== APP_ORIGIN) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== 'starpi-render') return;
  if (!KINDS.has(data.kind) || typeof data.source !== 'string' || data.source.length > MAX_SOURCE) return;
  render(data.kind, data.source, data.theme === 'dark' ? 'dark' : 'light', data.run === true);
});

if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(reportHeight);
  observer.observe(document.body);
  observer.observe(root);
}
tell({ type: 'starpi-render-ready' });
