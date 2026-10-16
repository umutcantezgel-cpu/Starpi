// @ts-check
// Storage quota and persistence. Browsers may evict an origin's data under storage pressure unless
// it is marked persistent; requestPersistence() asks for that once per page, at the moments the
// user starts keeping data (the first project, the first file kept on the device), and never
// again after an answer. "Persisted" here is the browser's eviction protection; whether data
// survives a reload at all is the database's `persistent` flag (idb.js).
import { formatBytes } from '../bench/diagnostics.js';

/**
 * @typedef {object} StorageUsage
 * @property {boolean} supported  false when the browser cannot estimate (all numbers are then 0)
 * @property {number} usage  bytes used by this origin
 * @property {number} quota  bytes this origin may use
 * @property {number} free
 * @property {number} ratio  usage / quota, 0..1
 */

/**
 * @typedef {object} PersistenceResult
 * @property {boolean} supported  the browser offers persistent storage at all
 * @property {boolean} persisted  the origin's data is protected from eviction
 * @property {boolean} asked  this call asked the browser (which may have shown a prompt)
 */

/** @typedef {Pick<StorageManager, 'estimate'> & Partial<Pick<StorageManager, 'persist' | 'persisted'>>} StorageLike */

/** @returns {StorageLike | null} */
function defaultStorage() {
  try {
    return globalThis.navigator?.storage ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {StorageLike | null} [storage]
 * @returns {Promise<StorageUsage>}
 */
export async function estimateStorage(storage = defaultStorage()) {
  if (!storage?.estimate) return { supported: false, usage: 0, quota: 0, free: 0, ratio: 0 };
  try {
    const { usage = 0, quota = 0 } = await storage.estimate();
    return { supported: quota > 0, usage, quota, free: Math.max(0, quota - usage), ratio: quota > 0 ? Math.min(1, usage / quota) : 0 };
  } catch {
    return { supported: false, usage: 0, quota: 0, free: 0, ratio: 0 };
  }
}

/**
 * Usage as display values: byte sizes with their unit and a whole percentage. The sentence around
 * them ("{usage} of {quota} used") belongs to the view and its translations.
 * @param {StorageUsage} usage
 * @param {(value: number, options?: Intl.NumberFormatOptions) => string} [format]  the locale's number format
 * @returns {{ usage: string, quota: string, free: string, percent: number }}
 */
export function describeUsage(usage, format) {
  return {
    usage: formatBytes(usage.usage, format),
    quota: formatBytes(usage.quota, format),
    free: formatBytes(usage.free, format),
    percent: Math.round(usage.ratio * 100),
  };
}

/**
 * Whether `bytes` more fit, with a safety margin. True when the browser cannot tell, so an
 * unknown quota never blocks the user; the write itself then reports a full disk.
 * @param {number} bytes
 * @param {{ margin?: number, storage?: StorageLike | null }} [options]
 * @returns {Promise<boolean>}
 */
export async function hasRoomFor(bytes, options = {}) {
  const usage = await estimateStorage(options.storage === undefined ? defaultStorage() : options.storage);
  if (!usage.supported) return true;
  return usage.free >= bytes * (options.margin ?? 1.2);
}

/**
 * @param {StorageLike | null} [storage]
 * @returns {Promise<boolean | null>} null when the browser cannot tell
 */
export async function isPersisted(storage = defaultStorage()) {
  if (!storage?.persisted) return null;
  try {
    return await storage.persisted();
  } catch {
    return null;
  }
}

/** One request per storage manager and page; a denial is not asked again until reload. */
/** @type {WeakMap<object, Promise<PersistenceResult>>} */
const requests = new WeakMap();

/**
 * Asks the browser to protect this origin's data from eviction. Cheap to call often: it asks
 * only when the data is not yet persisted, and at most once per page unless `force` is set.
 * @param {{ storage?: StorageLike | null, force?: boolean }} [options]
 * @returns {Promise<PersistenceResult>}
 */
export function requestPersistence(options = {}) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage?.persist) return Promise.resolve({ supported: false, persisted: false, asked: false });
  const earlier = requests.get(storage);
  if (earlier && !options.force) return earlier.then((r) => ({ ...r, asked: false }));
  const pending = askPersistence(storage);
  requests.set(storage, pending);
  return pending;
}

/**
 * @param {StorageLike} storage
 * @returns {Promise<PersistenceResult>}
 */
async function askPersistence(storage) {
  if ((await isPersisted(storage)) === true) return { supported: true, persisted: true, asked: false };
  try {
    const persisted = Boolean(await storage.persist?.());
    return { supported: true, persisted, asked: true };
  } catch {
    // Persistence is best effort; the browser may still keep the data.
    return { supported: true, persisted: false, asked: true };
  }
}
