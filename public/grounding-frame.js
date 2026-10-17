/* global window, document, location, ResizeObserver */
// Script of the grounding frame (public/grounding-frame.html). It shows search suggestions as the
// provider delivered them and runs nothing else: no app code is bundled into this file.
//
// Message protocol (the app side is mountGroundingFrame() in src/js/render.js):
// 1. This script tells its parent { type: 'starpi-grounding-ready' }, addressed to the app's origin.
// 2. The app answers { type: 'starpi-grounding', html }. Only a message of the parent window from
//    the app's origin (location.origin, the origin of this URL) counts, and only HTML of suggestion
//    size.
// 3. The HTML is inserted unchanged. Scripts in it never run (innerHTML does not run them and the CSP
//    allows no inline script or handler), remote images are refused, and links open in a new
//    browsing context (<base target="_blank">) without a referrer.
// 4. The frame reports { type: 'starpi-grounding-height', height } (CSS pixels) whenever the height
//    of the suggestions changes.

/** Search suggestions are a few kB (MAX_SUGGESTIONS_CHARS in src/js/render.js). */
const MAX_HTML = 100_000;
const APP_ORIGIN = location.origin;
const content = /** @type {HTMLElement} */ (document.getElementById('content'));

/** @param {Record<string, unknown>} message */
const tell = (message) => window.parent.postMessage(message, APP_ORIGIN);

let reported = -1;
function reportHeight() {
  const height = Math.ceil(content.getBoundingClientRect().height);
  if (height === reported) return;
  reported = height;
  tell({ type: 'starpi-grounding-height', height });
}

window.addEventListener('message', (event) => {
  if (window.parent === window || event.source !== window.parent || event.origin !== APP_ORIGIN) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== 'starpi-grounding') return;
  if (typeof data.html !== 'string' || data.html.length > MAX_HTML) return;
  content.innerHTML = data.html;
  reportHeight();
});

if (typeof ResizeObserver === 'function') new ResizeObserver(reportHeight).observe(content);
tell({ type: 'starpi-grounding-ready' });
