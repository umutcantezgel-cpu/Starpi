// The download check of on-device models (models/integrity.js) against a stand-in model host and
// Cache Storage: files that match the lock are marked verified and later only compared by size; a
// tampered file is found, deleted from the cache and refuses the load, and the next honest download
// passes; files the lock does not name refuse the load as unverified until the user allows the
// model to load unverified (and again once that is withdrawn). Also: which stored URLs belong to a
// model, WebLLM's own integrity hashes, the hashing helper and the results Settings shows.
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { EMBED_CATALOG } from '../../src/js/models/embed-catalog.js';
import { hashCacheEntry } from '../../src/js/models/integrity-hash.js';
import { onIntegrityChange, readChecks, setAllowUnverified, unverifiedAllowed } from '../../src/js/models/integrity-state.js';
import {
  createHasher,
  embedTarget,
  fileName,
  forgetVerified,
  IntegrityError,
  loadLock,
  verifyModel,
  wasmTarget,
  webllmAppConfig,
  webllmBase,
  webllmIntegrity,
  webllmTarget,
} from '../../src/js/models/integrity.js';
import { WASM_CACHE_NAME, WASM_CATALOG, wasmFileUrl } from '../../src/js/models/wasm-catalog.js';
import { openAppDb } from '../../src/js/store/schema.js';

// ---------------------------------------------------------------------------------------------
// Stand-ins

/** Cache Storage in memory: entries keep their bytes, every match() returns a fresh Response. */
class MemoryCache {
  /** @type {Map<string, Uint8Array>} */
  entries = new Map();
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  /** @param {string} url */
  async match(url) {
    const bytes = this.entries.get(url);
    return bytes ? new Response(bytes.slice()) : undefined;
  }
  /** @param {string} url @param {Response} res */
  async put(url, res) {
    this.entries.set(url, new Uint8Array(await res.arrayBuffer()));
  }
  /** @param {string} url */
  async delete(url) {
    return this.entries.delete(url);
  }
}

class MemoryCacheStorage {
  /** @type {Map<string, MemoryCache>} */
  caches = new Map();
  /** @param {string} name */
  async has(name) {
    return this.caches.has(name);
  }
  /** @param {string} name */
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MemoryCache());
    return /** @type {MemoryCache} */ (this.caches.get(name));
  }
  /** @param {string} url @param {{ cacheName: string }} options */
  async match(url, options) {
    return this.caches.get(options.cacheName)?.match(url);
  }
}

/** @param {string} text */
const bytes = (text) => new TextEncoder().encode(text);
/** @param {Uint8Array} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * A model host: serves the given files; `tamper` swaps one file's bytes, as a hostile mirror would.
 * @param {Record<string, Uint8Array>} files
 */
function modelHost(files) {
  /** @type {Record<string, Uint8Array>} */
  const tampered = {};
  /** @type {string[]} */
  const requests = [];
  return {
    requests,
    /** @param {string} url @param {Uint8Array} data */
    tamper(url, data) {
      tampered[url] = data;
    },
    /** @param {string} url */
    restore(url) {
      delete tampered[url];
    },
    /** @param {string} url */
    async fetch(url) {
      requests.push(url);
      const body = tampered[url] ?? files[url];
      return body ? new Response(body.slice()) : new Response('not found', { status: 404 });
    },
  };
}

/**
 * What a runtime does on a download: fetch each file and store the response under its URL.
 * @param {MemoryCacheStorage} storage
 * @param {string} cacheName
 * @param {{ fetch(url: string): Promise<Response> }} host
 * @param {string[]} urls
 */
async function download(storage, cacheName, host, urls) {
  const cache = await storage.open(cacheName);
  for (const url of urls) await cache.put(url, await host.fetch(url));
}

/**
 * A lock for the given files.
 * @param {Record<string, Uint8Array>} files
 */
function lockOf(files) {
  return { format: 'starpi.model-lock/v1', files: Object.fromEntries(Object.entries(files).map(([url, data]) => [url, { sha256: sha256(data), size: data.byteLength }])) };
}

let seq = 0;
async function freshDb() {
  const db = await openAppDb({ name: `integrity-test-${(seq += 1)}`, factory: new IDBFactory() });
  return { db, getDb: async () => db };
}

/** A hasher that counts what it hashes (the in-page hasher underneath). */
function countingHasher(/** @type {MemoryCacheStorage} */ storage) {
  const inner = createHasher(/** @type {any} */ (storage));
  const counts = { hashed: 0, unchanged: 0 };
  return {
    counts,
    /** @param {import('../../src/js/models/integrity-hash.js').HashRequest} req */
    async hash(req) {
      const result = await inner.hash(req);
      if (result.status === 'hashed') counts.hashed += 1;
      if (result.status === 'unchanged') counts.unchanged += 1;
      return result;
    },
    close() {},
  };
}

// The processor model of the catalog with tiny stand-in files at its pinned URLs.
const SRC = WASM_CATALOG['smollm2-135m'];
const TARGET = wasmTarget(SRC);
const FILES = {
  [wasmFileUrl(SRC, 'config.json')]: bytes('{"model_type":"llama"}'),
  [wasmFileUrl(SRC, 'tokenizer.json')]: bytes('{"version":"1.0","model":{}}'),
  [wasmFileUrl(SRC, 'onnx/model_quantized.onnx')]: bytes('weights '.repeat(512)),
};
const URLS = Object.keys(FILES);
const WEIGHTS = URLS[2];

/** A fresh device: empty caches and database, the host and the lock of the files above. */
async function device() {
  const storage = new MemoryCacheStorage();
  const { db, getDb } = await freshDb();
  const host = modelHost(FILES);
  const hasher = countingHasher(storage);
  const lock = lockOf(FILES);
  /** @param {Partial<import('../../src/js/models/integrity.js').VerifyOptions>} [extra] */
  const verify = (extra = {}) => verifyModel(TARGET, { caches: /** @type {any} */ (storage), db: getDb, lock, hasher, now: () => 1_700_000_000_000, ...extra });
  return { storage, db, getDb, host, hasher, lock, verify };
}

// ---------------------------------------------------------------------------------------------

describe('model download check', () => {
  it('marks matching files verified, then compares sizes only', async () => {
    const d = await device();
    await download(d.storage, WASM_CACHE_NAME, d.host, URLS);
    const check = await d.verify();
    assert.equal(check.status, 'verified');
    assert.equal(check.files, 3);
    assert.equal(d.hasher.counts.hashed, 3);
    const records = await d.db.getAll('modelIntegrity');
    assert.deepEqual(records.map((r) => [r.url, r.status, r.size]).sort(), URLS.map((url) => [url, 'verified', FILES[url].byteLength]).sort());
    const [saved] = await readChecks(d.getDb);
    assert.deepEqual({ id: saved.id, status: saved.status, files: saved.files, runtime: saved.runtime, label: saved.label }, { id: `wasm:${SRC.repo}`, status: 'verified', files: 3, runtime: 'wasm', label: 'SmolLM2 135M' });

    // A later load: nothing is hashed again.
    await d.verify();
    assert.equal(d.hasher.counts.hashed, 3);
    assert.equal(d.hasher.counts.unchanged, 3);
  });

  it('finds a tampered download, deletes it and refuses the load; an honest download passes', async () => {
    const d = await device();
    d.host.tamper(WEIGHTS, bytes('evil '.repeat(512)));
    await download(d.storage, WASM_CACHE_NAME, d.host, URLS);

    const progress = /** @type {Array<[number, number]>} */ ([]);
    await assert.rejects(
      d.verify({ onProgress: (done, total) => progress.push([done, total]) }),
      (/** @type {any} */ err) => err instanceof IntegrityError && err.code === 'mismatch' && err.modelId === TARGET.id && err.files.join() === 'onnx/model_quantized.onnx' && /do not match model-lock\.json and were deleted/.test(err.message),
    );
    assert.deepEqual(progress.at(-1), [3, 3]);
    const cache = await d.storage.open(WASM_CACHE_NAME);
    assert.equal(await cache.match(WEIGHTS), undefined, 'the tampered file is evicted');
    assert.ok(await cache.match(URLS[0]), 'files that match stay');
    assert.equal((await d.db.get('modelIntegrity', WEIGHTS)).status, 'mismatch');
    const [saved] = await readChecks(d.getDb);
    assert.equal(saved.status, 'mismatch');
    assert.deepEqual(saved.mismatched, ['onnx/model_quantized.onnx']);

    // The next load downloads the missing file again, this time from an honest host.
    d.host.restore(WEIGHTS);
    await download(d.storage, WASM_CACHE_NAME, d.host, [WEIGHTS]);
    const check = await d.verify();
    assert.equal(check.status, 'verified');
    assert.equal((await d.db.get('modelIntegrity', WEIGHTS)).status, 'verified');
  });

  it('hashes a file again when its size changed since it was verified', async () => {
    const d = await device();
    await download(d.storage, WASM_CACHE_NAME, d.host, URLS);
    await d.verify();
    const cache = await d.storage.open(WASM_CACHE_NAME);
    cache.entries.set(WEIGHTS, bytes('changed in place'));
    await assert.rejects(d.verify(), (/** @type {any} */ err) => err.code === 'mismatch');
    assert.equal(await cache.match(WEIGHTS), undefined);
  });

  it('refuses files the lock does not name until the model may load unverified', async () => {
    const d = await device();
    const extra = wasmFileUrl(SRC, 'onnx/model_extra.onnx');
    await download(d.storage, WASM_CACHE_NAME, d.host, URLS);
    (await d.storage.open(WASM_CACHE_NAME)).entries.set(extra, bytes('new upstream file'));

    await assert.rejects(d.verify(), (/** @type {any} */ err) => err instanceof IntegrityError && err.code === 'unverified' && err.files.join() === 'onnx/model_extra.onnx');
    assert.ok(await (await d.storage.open(WASM_CACHE_NAME)).match(extra), 'an unverified file is kept');
    assert.equal((await readChecks(d.getDb))[0].status, 'unverified');

    /** @type {number[]} */
    const changes = [];
    const off = onIntegrityChange(() => changes.push(1));
    await setAllowUnverified(TARGET.id, true, d.getDb);
    assert.deepEqual(await unverifiedAllowed(d.getDb), [TARGET.id]);
    const allowed = await d.verify();
    assert.equal(allowed.status, 'override');
    assert.deepEqual(allowed.unverified, ['onnx/model_extra.onnx']);
    assert.equal((await d.db.get('modelIntegrity', extra)).status, 'override');
    // Still allowed on the next load, without hashing the file again.
    const hashed = d.hasher.counts.hashed;
    assert.equal((await d.verify()).status, 'override');
    assert.equal(d.hasher.counts.hashed, hashed);

    // Withdrawn: refused again.
    await setAllowUnverified(TARGET.id, false, d.getDb);
    await assert.rejects(d.verify(), (/** @type {any} */ err) => err.code === 'unverified');
    off();
    assert.ok(changes.length >= 4, 'Settings hears every result and override change');
  });

  it('keeps a mismatching file of a model allowed to load unverified', async () => {
    const d = await device();
    d.host.tamper(WEIGHTS, bytes('re-uploaded upstream '.repeat(64)));
    await download(d.storage, WASM_CACHE_NAME, d.host, URLS);
    await setAllowUnverified(TARGET.id, true, d.getDb);
    const check = await d.verify();
    assert.equal(check.status, 'override');
    assert.deepEqual(check.mismatched, ['onnx/model_quantized.onnx']);
    assert.ok(await (await d.storage.open(WASM_CACHE_NAME)).match(WEIGHTS));
  });

  it('stops between files when the load was cancelled, and has nothing to do for an empty cache', async () => {
    const d = await device();
    assert.deepEqual(await d.verify(), { id: TARGET.id, label: 'SmolLM2 135M', runtime: 'wasm', status: 'verified', files: 0, mismatched: [], unverified: [], checkedAt: 1_700_000_000_000 });
    assert.deepEqual(await readChecks(d.getDb), [], 'nothing checked, nothing saved');
    await download(d.storage, WASM_CACHE_NAME, d.host, URLS);
    let calls = 0;
    await assert.rejects(
      d.verify({ cancelled: () => (calls += 1) > 1 }),
      (/** @type {any} */ err) => err.name === 'AbortError',
    );
    assert.equal(d.hasher.counts.hashed, 1);
  });

  it('forgets the verified marks and results after the models were deleted', async () => {
    const d = await device();
    await download(d.storage, WASM_CACHE_NAME, d.host, URLS);
    await d.verify();
    await setAllowUnverified('webgpu:other', true, d.getDb);
    await forgetVerified(d.getDb);
    assert.deepEqual(await d.db.getAll('modelIntegrity'), []);
    assert.deepEqual(await readChecks(d.getDb), []);
    assert.deepEqual(await unverifiedAllowed(d.getDb), ['webgpu:other'], 'the user\'s overrides stay');
  });
});

describe('model targets', () => {
  it('checks requests at "main" against the pinned file and ignores other models', async () => {
    const storage = new MemoryCacheStorage();
    const { getDb } = await freshDb();
    const cache = await storage.open(WASM_CACHE_NAME);
    const main = `https://huggingface.co/${SRC.repo}/resolve/main/config.json`;
    cache.entries.set(main, FILES[URLS[0]]);
    const other = WASM_CATALOG['qwen-0.5b'];
    cache.entries.set(wasmFileUrl(other, 'config.json'), bytes('another model'));
    const check = await verifyModel(TARGET, { caches: /** @type {any} */ (storage), db: getDb, lock: lockOf(FILES) });
    assert.equal(check.status, 'verified');
    assert.equal(check.files, 1);
    assert.equal(TARGET.scopes[0].match(`https://huggingface.co/${SRC.repo}/resolve/0123abc/config.json`), null, 'other revisions are not this model');
  });

  it('covers the WebLLM caches: files under the model directory and its model library', async () => {
    const record = { model_id: 'Tiny-q4f16_1-MLC', model: 'https://huggingface.co/mlc-ai/Tiny-q4f16_1-MLC', model_lib: 'https://raw.githubusercontent.com/mlc-ai/libs/main/Tiny-webgpu.wasm' };
    const target = webllmTarget({ modelId: record.model_id, label: 'Tiny', f16: true }, record);
    assert.equal(target.id, 'webgpu:Tiny-q4f16_1-MLC');
    assert.equal(target.label, 'Tiny (f16)');
    const base = webllmBase(record.model);
    assert.equal(base, 'https://huggingface.co/mlc-ai/Tiny-q4f16_1-MLC/resolve/main/');
    assert.equal(webllmBase('https://huggingface.co/x/y/resolve/abc/'), 'https://huggingface.co/x/y/resolve/abc/');

    const files = {
      [`${base}mlc-chat-config.json`]: bytes('{"tokenizer_files":["tokenizer.json"]}'),
      [`${base}tokenizer.json`]: bytes('{}'),
      [`${base}tensor-cache.json`]: bytes('{"records":[]}'),
      [`${base}params_shard_0.bin`]: bytes('shard'.repeat(100)),
      [record.model_lib]: bytes('\0asm-lib'),
    };
    const storage = new MemoryCacheStorage();
    const { getDb } = await freshDb();
    const host = modelHost(files);
    await download(storage, 'webllm/config', host, [`${base}mlc-chat-config.json`]);
    await download(storage, 'webllm/model', host, [`${base}tokenizer.json`, `${base}tensor-cache.json`, `${base}params_shard_0.bin`]);
    await download(storage, 'webllm/wasm', host, [record.model_lib]);
    // Another preset's files share the caches.
    (await storage.open('webllm/model')).entries.set('https://huggingface.co/mlc-ai/Tiny-q4f32_1-MLC/resolve/main/params_shard_0.bin', bytes('x'));
    (await storage.open('webllm/wasm')).entries.set('https://raw.githubusercontent.com/mlc-ai/libs/main/Other-webgpu.wasm', bytes('y'));
    const lock = lockOf(files);
    const check = await verifyModel(target, { caches: /** @type {any} */ (storage), db: getDb, lock });
    assert.deepEqual([check.status, check.files], ['verified', 5]);

    // WebLLM's own check gets the same hashes as SRI strings, unless the model may load unverified.
    const integrity = await webllmIntegrity(target, record, { lock, allowUnverified: false });
    const sri = (/** @type {Uint8Array} */ data) => `sha256-${createHash('sha256').update(data).digest('base64')}`;
    assert.deepEqual(integrity, { config: sri(files[`${base}mlc-chat-config.json`]), model_lib: sri(files[record.model_lib]), tokenizer: { 'tokenizer.json': sri(files[`${base}tokenizer.json`]) }, onFailure: 'error' });
    assert.equal(await webllmIntegrity(target, record, { lock, allowUnverified: true }), undefined);
    assert.equal(await webllmIntegrity(target, record, { lock: { format: 'starpi.model-lock/v1', files: {} }, allowUnverified: false }), undefined);
  });

  it('puts the hashes into the record of the loading model only', async () => {
    const lock = await loadLock();
    const id = 'SmolLM2-360M-Instruct-q4f16_1-MLC';
    const config = {
      model_list: [
        { model_id: id, model: `https://huggingface.co/mlc-ai/${id}`, model_lib: Object.keys(lock.files).find((k) => k.includes('SmolLM2-360M-Instruct-q4f16_1_cs1k')) ?? '' },
        { model_id: 'Other', model: 'https://huggingface.co/mlc-ai/Other', model_lib: 'x' },
      ],
    };
    const target = webllmTarget({ modelId: id, label: 'SmolLM2 360M', f16: true }, config.model_list[0]);
    // The override is read from the app database, which has none here.
    const out = /** @type {any} */ (await webllmAppConfig(config, target, config.model_list[0]));
    assert.ok(out.model_list[0].integrity.config.startsWith('sha256-'));
    assert.ok(out.model_list[0].integrity.model_lib.startsWith('sha256-'));
    assert.equal(out.model_list[1].integrity, undefined);
    assert.equal(/** @type {any} */ (config.model_list[0]).integrity, undefined, 'the prebuilt list is not changed');
  });

  it('covers the embedding models of the workspace search', () => {
    const src = EMBED_CATALOG['e5-small'];
    const target = embedTarget(src);
    assert.equal(target.id, `embed:${src.repo}`);
    assert.equal(target.runtime, 'embed');
    assert.equal(target.scopes[0].cache, WASM_CACHE_NAME);
    const url = `https://huggingface.co/${src.repo}/resolve/main/onnx/model_quantized.onnx`;
    assert.equal(target.scopes[0].match(url), `https://huggingface.co/${src.repo}/resolve/${src.revision}/onnx/model_quantized.onnx`);
    assert.equal(target.scopes[0].match(wasmFileUrl(SRC, 'config.json')), null);
  });

  it('names files by their path within the model', () => {
    assert.equal(fileName('https://huggingface.co/a/b/resolve/main/onnx/model.onnx'), 'onnx/model.onnx');
    assert.equal(fileName('https://raw.githubusercontent.com/mlc-ai/libs/main/x/Model-webgpu.wasm'), 'Model-webgpu.wasm');
  });
});

describe('hashing one stored file', () => {
  it('hashes, skips a known size, and reports a missing entry', async () => {
    const storage = new MemoryCacheStorage();
    const data = bytes('hello model');
    (await storage.open('c')).entries.set('https://example.test/f', data);
    assert.deepEqual(await hashCacheEntry(storage, { cacheName: 'c', url: 'https://example.test/f' }), { status: 'hashed', size: data.byteLength, sha256: sha256(data) });
    assert.deepEqual(await hashCacheEntry(storage, { cacheName: 'c', url: 'https://example.test/f', known: { size: data.byteLength } }), { status: 'unchanged', size: data.byteLength });
    assert.equal((await hashCacheEntry(storage, { cacheName: 'c', url: 'https://example.test/f', known: { size: 1 } })).status, 'hashed');
    assert.deepEqual(await hashCacheEntry(storage, { cacheName: 'c', url: 'https://example.test/none' }), { status: 'missing' });
    assert.deepEqual(await hashCacheEntry(storage, { cacheName: 'none', url: 'https://example.test/f' }), { status: 'missing' });
    assert.equal(await storage.has('none'), false, 'looking does not create a cache');
  });

  it('hashes in the page where no worker can start', async () => {
    const storage = new MemoryCacheStorage();
    (await storage.open('c')).entries.set('https://example.test/f', bytes('x'));
    const hasher = createHasher(/** @type {any} */ (storage));
    assert.equal((await hasher.hash({ cacheName: 'c', url: 'https://example.test/f' })).status, 'hashed');
    hasher.close();
  });
});
