// Starpi service worker (generated into dist/sw.js by scripts/build.mjs).
//
// Scope of responsibility is deliberately narrow:
// - Only same-origin GET requests are handled. Supabase, model weights (Hugging Face), provider APIs
//   and every other cross-origin request bypass the worker entirely, so private API responses are
//   never written to CacheStorage and WebLLM keeps sole ownership of its own model caches.
// - The app shell ("/", its CSS and JS, the ingest worker, the Latin font and the public files) is
//   precached per build. Hashed /assets/* files are immutable: they live in one unversioned cache,
//   are served cache-first and are pruned on activation when no longer part of the build.
// - Navigations are network-first with a short deadline; the cached shell answers when the network
//   fails or stalls. Only the HTML of "/" is ever stored as the shell.
// - Activation deletes only caches created by this worker ("starpi-" prefix).

const VERSION = '__STARPI_BUILD_VERSION__';
const PRECACHE = ['__STARPI_PRECACHE__'];
const ASSETS = ['__STARPI_ASSETS__'];
const CACHE_PREFIX = 'starpi-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const ASSET_CACHE = `${CACHE_PREFIX}assets`;
const NAVIGATION_DEADLINE_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Only the page itself must bypass the HTTP cache; hashed assets it just loaded are reused.
      await cache.addAll(PRECACHE.map((url) => (url === '/' ? new Request(url, { cache: 'reload' }) : url)));
      // Take over right away only when no page is open. An open page may run an older build whose
      // code reloads itself when the worker changes, which would clear its in-memory workspace.
      // Otherwise the new worker waits until those pages close (pages load network-first and assets
      // are content-hashed, so they do not need it) or until a page asks for it.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (!windows.length) await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      );
      // Keep hashed assets that the new build still uses (e.g. an unchanged 6 MB WebLLM chunk).
      const assets = await caches.open(ASSET_CACHE);
      const current = new Set(ASSETS);
      for (const request of await assets.keys()) {
        if (!current.has(new URL(request.url).pathname)) await assets.delete(request);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting();
});

/** @param {Response} response */
function cacheable(response) {
  return response.ok && response.type === 'basic' && response.status === 200 && !/no-store/i.test(response.headers.get('Cache-Control') || '');
}

/** @param {Response} response */
function isShellHtml(response) {
  return cacheable(response) && !response.redirected && (response.headers.get('Content-Type') || '').startsWith('text/html');
}

/** @param {FetchEvent} event */
async function networkFirstNavigation(event) {
  const url = new URL(event.request.url);
  let servedCache = false;
  const network = fetch(event.request).then((response) => {
    // Store the page only; a direct visit to a PDF, an icon or a redirect must never become the shell.
    // After the deadline served the cached shell, a later response is not stored: its assets were
    // never loaded, so an offline start could get HTML whose scripts are in no cache.
    if (!servedCache && url.pathname === '/' && isShellHtml(response)) {
      const copy = response.clone();
      event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy)));
    }
    return response;
  });
  const cachedShell = () => caches.match('/', { cacheName: SHELL_CACHE });
  // A stalled connection (weak signal, captive portal) falls back to the cached shell after a
  // short deadline instead of showing a blank page.
  const deadline = new Promise((resolve) => setTimeout(resolve, NAVIGATION_DEADLINE_MS, 'deadline'));
  try {
    const first = await Promise.race([network, deadline]);
    if (first !== 'deadline') return /** @type {Response} */ (first);
    const cached = await cachedShell();
    if (cached) {
      servedCache = true;
      event.waitUntil(network.catch(() => undefined));
      return cached;
    }
    return await network;
  } catch (err) {
    const cached = await cachedShell();
    if (cached) return cached;
    throw err;
  }
}

/** @param {FetchEvent} event */
async function cacheFirstAsset(event) {
  const cached = await caches.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (cacheable(response) && new URL(event.request.url).pathname.startsWith('/assets/')) {
    const copy = response.clone();
    event.waitUntil(caches.open(ASSET_CACHE).then((cache) => cache.put(event.request, copy)));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirstAsset(event));
  }
  // Everything else (e.g. /sw.js, /build-manifest.json) goes straight to the network.
});
