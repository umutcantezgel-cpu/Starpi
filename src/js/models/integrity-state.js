// @ts-check
// What the model download check (models/integrity.js) found per model, and the models the user
// allowed to load unverified. Both live in the app database's `settings` store, one record per
// model, so Settings › Trust can show them without loading the check or its lock file:
//   models.integrity.check/<model id>  -> ModelCheck (the result of the last check)
//   models.integrity.allow/<model id>  -> true (the "Load unverified (upstream changed)" override)
// A model id names exactly what was downloaded: 'webgpu:<WebLLM model id>', 'wasm:<repository>',
// 'embed:<repository>' or 'nli:<repository>' (the entailment model of the second opinion).
import { appDb } from '../store/schema.js';

/** @typedef {import('../store/idb.js').StoreDb} StoreDb */

/**
 * @typedef {'verified' | 'override' | 'mismatch' | 'unverified'} CheckStatus
 *   verified: every stored file matches its pinned hash; override: loaded with files that do not
 *   (allowed by the user); mismatch: a file differed and was deleted; unverified: a file has no
 *   pinned hash and the model was not loaded
 *
 * @typedef {object} ModelCheck
 * @property {string} id
 * @property {string} label  model name as the picker shows it
 * @property {'webgpu' | 'wasm' | 'embed' | 'nli'} runtime
 * @property {CheckStatus} status
 * @property {number} files  stored files checked
 * @property {string[]} mismatched  files that differ from their pinned hash (paths within the model)
 * @property {string[]} unverified  files without a pinned hash
 * @property {number} checkedAt
 */

const CHECK_PREFIX = 'models.integrity.check/';
const ALLOW_PREFIX = 'models.integrity.allow/';

/** @type {Set<() => void>} */
const listeners = new Set();

/** Calls `fn` after a check result or an override changed. Returns the unsubscribe function. */
export function onIntegrityChange(/** @type {() => void} */ fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A failing view must not stop the check or the other listeners.
    }
  }
}

/**
 * The last check of every model, newest first.
 * @param {() => Promise<StoreDb>} [getDb]
 * @returns {Promise<ModelCheck[]>}
 */
export async function readChecks(getDb = appDb) {
  const db = await getDb();
  /** @type {Array<{ key: string, value: unknown }>} */
  const records = await db.getAll('settings');
  return records
    .filter((r) => typeof r.key === 'string' && r.key.startsWith(CHECK_PREFIX) && r.value && typeof r.value === 'object')
    .map((r) => /** @type {ModelCheck} */ (r.value))
    .sort((a, b) => b.checkedAt - a.checkedAt);
}

/**
 * @param {ModelCheck} check
 * @param {() => Promise<StoreDb>} [getDb]
 */
export async function saveCheck(check, getDb = appDb) {
  const db = await getDb();
  await db.put('settings', { key: CHECK_PREFIX + check.id, value: check, updatedAt: check.checkedAt });
  notify();
}

/**
 * Whether the user allowed this model to load with files that do not match the lock.
 * @param {string} id
 * @param {() => Promise<StoreDb>} [getDb]
 */
export async function allowsUnverified(id, getDb = appDb) {
  try {
    const db = await getDb();
    const record = await db.get('settings', ALLOW_PREFIX + id);
    return record?.value === true;
  } catch {
    return false;
  }
}

/**
 * The ids of every model allowed to load unverified.
 * @param {() => Promise<StoreDb>} [getDb]
 * @returns {Promise<string[]>}
 */
export async function unverifiedAllowed(getDb = appDb) {
  const db = await getDb();
  /** @type {Array<{ key: string, value: unknown }>} */
  const records = await db.getAll('settings');
  return records.filter((r) => typeof r.key === 'string' && r.key.startsWith(ALLOW_PREFIX) && r.value === true).map((r) => r.key.slice(ALLOW_PREFIX.length));
}

/**
 * Sets or clears the "Load unverified (upstream changed)" override of one model.
 * @param {string} id
 * @param {boolean} allow
 * @param {() => Promise<StoreDb>} [getDb]
 */
export async function setAllowUnverified(id, allow, getDb = appDb) {
  const db = await getDb();
  if (allow) await db.put('settings', { key: ALLOW_PREFIX + id, value: true, updatedAt: Date.now() });
  else await db.delete('settings', ALLOW_PREFIX + id);
  notify();
}

/**
 * Removes every saved check result (the overrides stay: they are the user's choice).
 * @param {() => Promise<StoreDb>} [getDb]
 */
export async function forgetChecks(getDb = appDb) {
  const db = await getDb();
  /** @type {Array<{ key: string }>} */
  const records = await db.getAll('settings');
  const keys = records.map((r) => r.key).filter((key) => typeof key === 'string' && key.startsWith(CHECK_PREFIX));
  if (keys.length === 0) return;
  await db.transaction('settings', 'readwrite', async (tx) => {
    await Promise.all(keys.map((key) => tx.delete('settings', key)));
  });
  notify();
}
