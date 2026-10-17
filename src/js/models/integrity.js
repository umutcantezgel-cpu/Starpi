// @ts-check
// Download integrity of on-device models. Every file a model runtime stores in Cache Storage
// (WebLLM: webllm/config, webllm/model, webllm/wasm; Transformers.js: transformers-cache) is hashed
// and compared with model-lock.json, which scripts/models-lock.mjs writes from the model hosts:
// - stored files are checked before a runtime reads them, and new downloads right after the load,
//   before the model answers anything;
// - a file that matches is marked verified in the app database (store modelIntegrity, by URL and
//   size), so later loads only compare its size instead of hashing it again;
// - a file that does not match its pinned hash is deleted and the load is refused (IntegrityError
//   'mismatch'), so the next load downloads it afresh;
// - a file the lock does not name refuses the load as unverified (IntegrityError 'unverified').
// A model can change upstream after the lock was made (WebLLM downloads its presets at "main"). For
// that case the user may allow one model to load unverified (Settings › Trust): its mismatching and
// unknown files are then kept, recorded as 'override', and the load goes on with a warning.
//
// Hashing runs in a worker of its own (models/integrity.worker.js), one file at a time; where no
// worker can start it runs in the page with the same code. This module and the lock (a chunk of its
// own) load only when a model loads: webgpu/engine.js and rag/embed-client.js import them on demand.
import { fromHex } from '../core/hash.js';
import { appDb } from '../store/schema.js';
import { pinnedEmbedUrl } from './embed-catalog.js';
import { hashCacheEntry } from './integrity-hash.js';
import { allowsUnverified, forgetChecks, saveCheck } from './integrity-state.js';
import { pinnedWasmUrl, WASM_CACHE_NAME } from './wasm-catalog.js';

/** Replaced at build time with the hashed worker URL (scripts/build.mjs). */
const INTEGRITY_WORKER_URL = '__STARPI_INTEGRITY_WORKER_URL__';

/** The Cache Storage names WebLLM keeps a model in. */
export const WEBLLM_CACHES = Object.freeze({ config: 'webllm/config', model: 'webllm/model', wasm: 'webllm/wasm' });

/**
 * @typedef {{ sha256: string, size: number }} LockEntry
 * @typedef {{ format: string, files: Record<string, LockEntry> }} ModelLock
 * @typedef {import('./integrity-state.js').ModelCheck} ModelCheck
 * @typedef {import('./integrity-hash.js').HashRequest} HashRequest
 * @typedef {import('./integrity-hash.js').HashResult} HashResult
 * @typedef {import('./wasm-catalog.js').WasmSource} WasmSource
 * @typedef {import('./embed-catalog.js').EmbedSource} EmbedSource
 * @typedef {import('../store/idb.js').StoreDb} StoreDb
 *
 * Where a model's files are stored: a cache name, and for each stored URL the lock key it is
 * checked against, or null when the URL belongs to another model.
 * @typedef {{ cache: string, match: (url: string) => string | null }} CacheScope
 * @typedef {{ id: string, label: string, runtime: ModelCheck['runtime'], scopes: CacheScope[] }} ModelTarget
 *
 * @typedef {{ hash(req: HashRequest): Promise<HashResult>, close(): void }} Hasher
 * @typedef {{ keys(): Promise<ReadonlyArray<{ url: string }>>, delete(url: string): Promise<boolean> }} CacheLike
 * @typedef {import('./integrity-hash.js').CacheReader & { has(name: string): Promise<boolean>, open(name: string): Promise<CacheLike> }} CacheStorageLike
 *
 * @typedef {object} VerifyOptions
 * @property {ModelLock} [lock]  defaults to model-lock.json
 * @property {CacheStorageLike} [caches]  defaults to the browser's Cache Storage
 * @property {() => Promise<StoreDb>} [db]  defaults to the app database
 * @property {Hasher} [hasher]  defaults to the hashing worker
 * @property {boolean} [allowUnverified]  defaults to the user's override for this model
 * @property {(done: number, total: number) => void} [onProgress]
 * @property {() => boolean} [cancelled]  checked between files; true stops the check
 * @property {() => number} [now]
 */

/** A model's stored files failed the check; the load must not go on. */
export class IntegrityError extends Error {
  /**
   * @param {'mismatch' | 'unverified'} code
   * @param {ModelTarget} target
   * @param {string[]} files paths within the model
   */
  constructor(code, target, files) {
    super(
      code === 'mismatch'
        ? `${files.length} downloaded file(s) of ${target.label} do not match model-lock.json and were deleted: ${files.join(', ')}`
        : `${target.label} has ${files.length} downloaded file(s) without a pinned hash in model-lock.json: ${files.join(', ')}`,
    );
    this.name = 'IntegrityError';
    this.code = code;
    this.model = target.label;
    this.modelId = target.id;
    this.files = files;
  }
}

/**
 * The URL directory WebLLM reads a model from (as its cleanModelUrl): ".../resolve/main/" unless
 * the model record names a revision itself.
 * @param {string} model ModelRecord.model
 */
export function webllmBase(model) {
  const url = model.endsWith('/') ? model : `${model}/`;
  return new URL(/\/resolve\/.+\//.test(url) ? url : `${url}resolve/main/`).href;
}

/**
 * The stored files of a WebLLM model: config, tokenizer, tensor index and shards under its URL
 * directory, and its compiled model library.
 * @param {{ modelId: string, label: string, f16: boolean }} choice
 * @param {{ model: string, model_lib: string }} record WebLLM's model record
 * @returns {ModelTarget}
 */
export function webllmTarget(choice, record) {
  const base = webllmBase(record.model);
  const inModel = (/** @type {string} */ url) => (url.startsWith(base) ? url : null);
  return {
    id: `webgpu:${choice.modelId}`,
    label: `${choice.label} (${choice.f16 ? 'f16' : 'f32'})`,
    runtime: 'webgpu',
    scopes: [
      { cache: WEBLLM_CACHES.config, match: inModel },
      { cache: WEBLLM_CACHES.model, match: inModel },
      { cache: WEBLLM_CACHES.wasm, match: (url) => (url === record.model_lib ? url : null) },
    ],
  };
}

/**
 * The stored files of a processor (WASM) language model. Requests at "main" are answered with the
 * pinned file (wasm/worker.js), so they are checked against the pinned entry.
 * @param {WasmSource} src
 * @returns {ModelTarget}
 */
export function wasmTarget(src) {
  return { id: `wasm:${src.repo}`, label: src.label, runtime: 'wasm', scopes: [{ cache: WASM_CACHE_NAME, match: (url) => pinnedWasmUrl(src, url) }] };
}

/**
 * The stored files of an embedding model of the workspace search.
 * @param {EmbedSource} src
 * @returns {ModelTarget}
 */
export function embedTarget(src) {
  return { id: `embed:${src.repo}`, label: src.label, runtime: 'embed', scopes: [{ cache: WASM_CACHE_NAME, match: (url) => pinnedEmbedUrl(src, url) }] };
}

/**
 * A stored URL as the user reads it: the path within the model, or the file name.
 * @param {string} url
 */
export function fileName(url) {
  const at = url.indexOf('/resolve/');
  if (at >= 0) return url.slice(at + '/resolve/'.length).split('/').slice(1).join('/');
  return url.slice(url.lastIndexOf('/') + 1);
}

/** @type {Promise<ModelLock> | null} */
let lockPromise = null;

/** model-lock.json, loaded once (a chunk of its own). */
export function loadLock() {
  lockPromise ??= import('./model-lock.json', { with: { type: 'json' } }).then(
    (mod) => /** @type {ModelLock} */ (/** @type {unknown} */ (mod.default)),
    (err) => {
      lockPromise = null;
      throw err;
    },
  );
  return lockPromise;
}

/** @param {LockEntry | undefined} entry */
function sri(entry) {
  const bytes = entry && fromHex(entry.sha256);
  return bytes ? `sha256-${btoa(String.fromCharCode(...bytes))}` : undefined;
}

/**
 * Subresource-integrity hashes for WebLLM's own check (ModelRecord.integrity): it verifies the
 * config, the tokenizer and, before running it, the compiled model library. Undefined while the
 * model is allowed to load unverified or the lock has none of them.
 * @param {ModelTarget} target
 * @param {{ model: string, model_lib: string }} record
 * @param {{ lock?: ModelLock, allowUnverified?: boolean }} [options]
 * @returns {Promise<{ config?: string, model_lib?: string, tokenizer?: Record<string, string>, onFailure: 'error' } | undefined>}
 */
export async function webllmIntegrity(target, record, options = {}) {
  if (options.allowUnverified ?? (await allowsUnverified(target.id))) return undefined;
  const lock = options.lock ?? (await loadLock());
  const base = webllmBase(record.model);
  /** @type {Record<string, string>} */
  const tokenizer = {};
  for (const name of ['tokenizer.json', 'tokenizer.model']) {
    const hash = sri(lock.files[base + name]);
    if (hash) tokenizer[name] = hash;
  }
  const config = sri(lock.files[`${base}mlc-chat-config.json`]);
  const modelLib = sri(lock.files[record.model_lib]);
  if (!config && !modelLib && Object.keys(tokenizer).length === 0) return undefined;
  return { ...(config ? { config } : {}), ...(modelLib ? { model_lib: modelLib } : {}), ...(Object.keys(tokenizer).length ? { tokenizer } : {}), onFailure: 'error' };
}

/**
 * WebLLM's app config with the integrity hashes of this model, or undefined to keep WebLLM's default.
 * @template {{ model_list: ReadonlyArray<{ model_id: string }> }} T
 * @param {T} config webllm.prebuiltAppConfig
 * @param {ModelTarget} target
 * @param {{ model_id: string, model: string, model_lib: string }} record
 * @returns {Promise<T | undefined>}
 */
export async function webllmAppConfig(config, target, record) {
  const integrity = await webllmIntegrity(target, record);
  if (!integrity) return undefined;
  return /** @type {T} */ ({ ...config, model_list: config.model_list.map((m) => (m.model_id === record.model_id ? { ...m, integrity } : m)) });
}

/**
 * Forgets which stored files were verified, and the results Settings shows: after the app deleted
 * the downloaded models, a new download of the same size must be hashed again.
 * @param {() => Promise<StoreDb>} [getDb]
 */
export async function forgetVerified(getDb = appDb) {
  const db = await getDb();
  await db.clear('modelIntegrity');
  await forgetChecks(getDb);
}

/**
 * The hashing worker, or the same hashing in the page where no worker starts (or it fails to).
 * @param {CacheStorageLike} [storage]
 * @returns {Hasher}
 */
export function createHasher(storage = /** @type {CacheStorageLike} */ (globalThis.caches)) {
  /** @type {Hasher} */
  const inPage = { hash: (req) => hashCacheEntry(storage, req), close() {} };
  const WorkerCtor = globalThis.Worker;
  if (typeof WorkerCtor !== 'function' || !globalThis.location) return inPage;
  /** @type {Worker} */
  let worker;
  try {
    worker = new WorkerCtor(new URL(INTEGRITY_WORKER_URL, globalThis.location.href), { type: 'module', name: 'starpi-integrity' });
  } catch {
    return inPage;
  }
  let seq = 0;
  let broken = false;
  /** @type {Map<number, { resolve: (r: HashResult) => void, reject: (e: Error) => void, retry: () => void }>} */
  const pending = new Map();
  worker.addEventListener('message', (event) => {
    const reply = /** @type {{ id: number, ok: true, result: HashResult } | { id: number, ok: false, name: string, message: string }} */ (event.data);
    const waiting = pending.get(reply.id);
    if (!waiting) return;
    pending.delete(reply.id);
    if (reply.ok) {
      waiting.resolve(reply.result);
    } else {
      const err = new Error(reply.message);
      err.name = reply.name;
      waiting.reject(err);
    }
  });
  // A worker that cannot start (its script did not load): hash in the page instead.
  const fail = () => {
    broken = true;
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.retry();
    }
  };
  worker.addEventListener('error', fail);
  worker.addEventListener('messageerror', fail);
  return {
    hash(req) {
      if (broken) return inPage.hash(req);
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject, retry: () => void inPage.hash(req).then(resolve, reject) });
        worker.postMessage({ id, cacheName: req.cacheName, url: req.url, known: req.known ?? null });
      });
    },
    close() {
      worker.terminate();
      for (const [id, waiting] of pending) {
        pending.delete(id);
        waiting.reject(new Error('The hashing worker was stopped'));
      }
    },
  };
}

/**
 * Every stored entry of the model, with the lock key it is checked against.
 * @param {CacheStorageLike} storage
 * @param {ModelTarget} target
 */
async function storedEntries(storage, target) {
  /** @type {Array<{ cache: string, url: string, key: string }>} */
  const entries = [];
  for (const scope of target.scopes) {
    if (!(await storage.has(scope.cache))) continue;
    const cache = await storage.open(scope.cache);
    for (const request of await cache.keys()) {
      const key = scope.match(request.url);
      if (key) entries.push({ cache: scope.cache, url: request.url, key });
    }
  }
  return entries;
}

/**
 * Checks every stored file of a model against the lock; see the top of this file. Resolves with
 * the result (also saved for Settings when any file was checked); rejects with IntegrityError when
 * the load must not go on.
 * @param {ModelTarget} target
 * @param {VerifyOptions} [options]
 * @returns {Promise<ModelCheck>}
 */
export async function verifyModel(target, options = {}) {
  const now = options.now ?? Date.now;
  /** @type {ModelCheck} */
  const check = { id: target.id, label: target.label, runtime: target.runtime, status: 'verified', files: 0, mismatched: [], unverified: [], checkedAt: now() };
  const storage = options.caches ?? /** @type {CacheStorageLike | undefined} */ (globalThis.caches);
  if (!storage) return check;
  const entries = await storedEntries(storage, target);
  if (entries.length === 0) return check;

  const getDb = options.db ?? appDb;
  const [lock, allow, db] = await Promise.all([options.lock ?? loadLock(), options.allowUnverified ?? allowsUnverified(target.id, getDb), getDb().catch(() => null)]);
  const hasher = options.hasher ?? createHasher(storage);
  /** @type {string[]} */
  const overridden = [];
  /**
   * @param {string} url
   * @param {number} size
   * @param {string} sha256
   * @param {'verified' | 'mismatch' | 'override'} status
   */
  const record = async (url, size, sha256, status) => {
    await db?.put('modelIntegrity', { url, size, sha256, status, checkedAt: now() }).catch(() => {});
  };

  try {
    for (const [i, entry] of entries.entries()) {
      if (options.cancelled?.()) throw new DOMException('The model check was cancelled', 'AbortError');
      options.onProgress?.(i, entries.length);
      const pinned = /** @type {LockEntry | undefined} */ (lock.files[entry.key]);
      const known = /** @type {import('../store/schema.js').ModelIntegrityRecord | undefined} */ (db ? await db.get('modelIntegrity', entry.url).catch(() => undefined) : undefined);
      // Checked before: verified against the same pinned hash, or loaded under the override that is still given.
      const trusted = known && ((known.status === 'verified' && pinned && known.sha256 === pinned.sha256 && known.size === pinned.size) || (known.status === 'override' && allow));
      const result = await hasher.hash({ cacheName: entry.cache, url: entry.url, known: trusted ? { size: known.size } : null });
      if (result.status === 'missing') continue;
      check.files += 1;
      const name = fileName(entry.url);
      if (result.status === 'unchanged') {
        if (known?.status === 'override') overridden.push(name);
        continue;
      }
      if (pinned && pinned.sha256 === result.sha256 && pinned.size === result.size) {
        await record(entry.url, result.size, result.sha256, 'verified');
      } else if (!pinned) {
        check.unverified.push(name);
        if (allow) await record(entry.url, result.size, result.sha256, 'override');
      } else {
        check.mismatched.push(name);
        if (allow) {
          await record(entry.url, result.size, result.sha256, 'override');
        } else {
          const cache = await storage.open(entry.cache);
          await cache.delete(entry.url);
          await record(entry.url, result.size, result.sha256, 'mismatch');
        }
      }
    }
  } finally {
    if (!options.hasher) hasher.close();
  }
  options.onProgress?.(entries.length, entries.length);

  const problems = check.mismatched.length + check.unverified.length + overridden.length;
  check.status = check.mismatched.length && !allow ? 'mismatch' : check.unverified.length && !allow ? 'unverified' : problems ? 'override' : 'verified';
  check.checkedAt = now();
  if (check.files > 0) await saveCheck(check, getDb).catch(() => {});
  if (check.status === 'mismatch') throw new IntegrityError('mismatch', target, check.mismatched);
  if (check.status === 'unverified') throw new IntegrityError('unverified', target, check.unverified);
  return check;
}
