// @ts-check
// Hashes one stored model file: the SHA-256 (WebCrypto) and the size of a Cache Storage entry's
// body. Shared by the hashing worker (models/integrity.worker.js) and the in-page fallback of
// models/integrity.js; it uses only globals of browsers, workers and Node, so the tests run it as is.
import { toHex } from '../core/hash.js';

/**
 * The part of CacheStorage this module uses (tests pass a stand-in).
 * @typedef {{ match(url: string, options: { cacheName: string }): Promise<Response | undefined> }} CacheReader
 *
 * @typedef {object} HashRequest
 * @property {string} cacheName
 * @property {string} url
 * @property {{ size: number } | null} [known]  a size checked before: an entry of that size is not hashed again
 *
 * @typedef {{ status: 'hashed', size: number, sha256: string } | { status: 'unchanged', size: number } | { status: 'missing' }} HashResult
 */

/**
 * @param {CacheReader} storage
 * @param {HashRequest} req
 * @returns {Promise<HashResult>}
 */
export async function hashCacheEntry(storage, req) {
  // match() with a cache name never creates the cache, unlike open().
  const res = await storage.match(req.url, { cacheName: req.cacheName });
  if (!res) return { status: 'missing' };
  // A stored body's Blob is a handle: its size is known without reading the bytes.
  const blob = await res.blob();
  if (req.known && req.known.size === blob.size) return { status: 'unchanged', size: blob.size };
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return { status: 'hashed', size: blob.size, sha256: toHex(new Uint8Array(digest)) };
}
