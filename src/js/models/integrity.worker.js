// @ts-check
// Hashing worker of the model download check (models/integrity.js). Hashing a model shard reads up
// to a few hundred MB; here that happens away from the page, which only sends URLs and gets digests
// back. Requests come one at a time.
//
// Protocol: { id, cacheName, url, known } -> { id, ok: true, result } | { id, ok: false, name, message }
// (result as hashCacheEntry returns it; no stack traces).
import { hashCacheEntry } from './integrity-hash.js';

/** @typedef {import('./integrity-hash.js').HashRequest & { id: number }} WorkerRequest */

const scope = /** @type {{ caches: CacheStorage, postMessage(message: unknown): void, onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null }} */ (
  /** @type {unknown} */ (globalThis)
);

scope.onmessage = async (event) => {
  const { id, cacheName, url, known } = event.data;
  try {
    scope.postMessage({ id, ok: true, result: await hashCacheEntry(scope.caches, { cacheName, url, known }) });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    scope.postMessage({ id, ok: false, name: e.name, message: e.message });
  }
};
