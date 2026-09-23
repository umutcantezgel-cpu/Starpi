// Starpi service worker (generated into dist/sw.js by scripts/build.mjs).
//
// Scope of responsibility is deliberately narrow:
// - Only same-origin GET requests are handled. Supabase, model weights (Hugging Face), provider APIs
//   and every other cross-origin request bypass the worker entirely, so private API responses are
//   never written to CacheStorage and WebLLM keeps sole ownership of its own model caches.
// - The versioned app shell is precached; hashed /assets/* files are cache-first (immutable);
//   navigations are network-first with the cached shell as offline fallback.
// - Activation deletes only caches created by this worker ("starpi-" prefix).

const VERSION = '__STARPI_BUILD_VERSION__';
const PRECACHE = ['__STARPI_PRECACHE__'];
const CACHE_PREFIX = 'starpi-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const ASSET_CACHE = `${CACHE_PREFIX}assets-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      // Workers up to v1.0 ("starpi-cache-vN") cached private Supabase responses and model shards:
      // replace them immediately instead of waiting for every tab to close.
      const keys = await caches.keys();
      if (keys.some((key) => /^starpi-cache-v\d+$/.test(key))) await self.skipWaiting();
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
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** @param {Response} response */
function cacheable(response) {
  return response.ok && response.type === 'basic' && response.status === 200 && !/no-store/i.test(response.headers.get('Cache-Control') || '');
}

/** @param {FetchEvent} event */
async function networkFirstNavigation(event) {
  try {
    const response = await fetch(event.request);
    if (cacheable(response)) {
      const copy = response.clone();
      event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy)));
    }
    return response;
  } catch (err) {
    const cached = (await caches.match('/index.html', { cacheName: SHELL_CACHE })) || (await caches.match('/'));
    if (cached) return cached;
    throw err;
  }
}

/** @param {FetchEvent} event */
async function cacheFirstAsset(event) {
  const cached = await caches.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (cacheable(response)) {
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
