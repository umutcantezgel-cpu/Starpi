// The app database layout: every store and index is created, an older database is upgraded step
// by step without losing data, and the message tree, conversation list and document chunks can be
// queried the way the chat and the workspace need.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { range } from '../../src/js/store/idb.js';
import { appDb, clearStores, configureStore, createStores, DEFAULT_DB_NAME, openAppDb, SCHEMA_STEPS, SCHEMA_VERSION, STORE_NAMES, STORES, storeProfileName } from '../../src/js/store/schema.js';

/** @typedef {import('../../src/js/store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../../src/js/store/schema.js').ConversationRecord} ConversationRecord */

let seq = 0;
const uniqueName = () => `schema-test-${(seq += 1)}`;

/**
 * Reads the stores and indexes straight from IndexedDB.
 * @param {IDBFactory} factory
 * @param {string} name
 */
function inspect(factory, name) {
  return new Promise((resolve, reject) => {
    const req = factory.open(name);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const idb = req.result;
      const names = [...idb.objectStoreNames];
      const tx = idb.transaction(names, 'readonly');
      /** @type {Record<string, { keyPath: unknown, indexes: Record<string, unknown> }>} */
      const out = {};
      for (const store of names) {
        const os = tx.objectStore(store);
        out[store] = { keyPath: os.keyPath, indexes: Object.fromEntries([...os.indexNames].map((ix) => [ix, os.index(ix).keyPath])) };
      }
      const version = idb.version;
      idb.close();
      resolve({ version, stores: out });
    };
  });
}

/**
 * @param {string} id
 * @param {string | null} parentId
 * @param {'user' | 'assistant'} role
 * @param {number} createdAt
 * @returns {NodeRecord}
 */
function node(id, parentId, role, createdAt) {
  return { id, conversationId: 'conv', parentId, role, parts: [{ type: 'text', text: id }], opaque: [], model: null, provider: null, label: null, usage: null, localOnly: false, createdAt };
}

describe('schema', () => {
  it('creates every store with its key and indexes', async () => {
    const factory = new IDBFactory();
    const name = uniqueName();
    const db = await openAppDb({ name, factory });
    assert.equal(db.persistent, true);
    assert.equal(db.version, SCHEMA_VERSION);
    db.close();
    const { version, stores } = await inspect(factory, name);
    assert.equal(version, 1);
    assert.deepEqual(Object.keys(stores).sort(), [...STORE_NAMES].sort());
    assert.deepEqual(stores.conversations, { keyPath: 'id', indexes: { updatedAt: 'updatedAt', projectId: 'projectId', pinned: 'pinned' } });
    assert.deepEqual(stores.nodes.indexes, { conversationId: 'conversationId', parentId: 'parentId' });
    assert.deepEqual(stores.chunks, { keyPath: ['docId', 'idx'], indexes: { docId: 'docId' } });
    assert.deepEqual(stores.vectors, { keyPath: ['docId', 'idx', 'model'], indexes: { docId: 'docId' } });
    assert.deepEqual(stores.docs.indexes, { sha256: 'sha256' });
    assert.deepEqual(stores.memory.indexes, { scope: 'scope' });
    assert.deepEqual(stores.research.indexes, { status: 'status', updatedAt: 'updatedAt' });
    assert.deepEqual(stores.bench.indexes, { modelId: 'modelId' });
    assert.equal(stores.modelIntegrity.keyPath, 'url');
    assert.equal(stores.settings.keyPath, 'key');
    for (const store of ['blobs', 'projects', 'assistants', 'receipts', 'signingKeys', 'keyvault']) assert.deepEqual(stores[store], { keyPath: 'id', indexes: {} });
    assert.equal(Object.isFrozen(STORES), true);
  });

  it('builds the same layout in the memory stand-in', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: null });
    assert.equal(db.persistent, false);
    assert.deepEqual(db.storeNames(), [...STORE_NAMES].sort());
    await db.put('chunks', { docId: 'd', idx: 0, start: 0, end: 4, text: 'text' });
    assert.equal(await db.countFromIndex('chunks', 'docId', 'd'), 1);
  });

  it('upgrades an older database step by step and keeps its data', async () => {
    const factory = new IDBFactory();
    const name = uniqueName();
    const v1 = await openAppDb({ name, factory });
    await v1.put('memory', { id: 'm1', text: 'Prefers short answers', scope: 'global', source: 'explicit', createdAt: 1, usedAt: null, weight: 1 });
    await v1.put('conversations', { id: 'c1', title: 'Old', createdAt: 1, updatedAt: 1, pinned: 0, archived: 0, activeLeafId: null, model: null, mode: 'free' });
    v1.close();

    let runs = 0;
    const steps = [
      ...SCHEMA_STEPS,
      {
        version: 2,
        /** @param {import('../../src/js/store/idb.js').UpgradeContext} ctx */
        apply: async (ctx) => {
          runs += 1;
          createStores(ctx, { tags: { keyPath: 'id', indexes: { label: { keyPath: 'label' } } } });
          ctx.createIndex('memory', 'source', 'source');
          // A data step: records written before version 2 gain a field.
          for (const record of await ctx.tx.getAll('memory')) await ctx.tx.put('memory', { ...record, pinned: 0 });
        },
      },
    ];
    const v2 = await openAppDb({ name, factory, steps });
    assert.equal(v2.version, 2);
    assert.equal(runs, 1);
    assert.equal((await v2.get('memory', 'm1')).pinned, 0);
    assert.equal(await v2.countFromIndex('memory', 'source', 'explicit'), 1);
    assert.equal((await v2.get('conversations', 'c1')).title, 'Old');
    await v2.put('tags', { id: 't', label: 'x' });
    v2.close();

    const again = await openAppDb({ name, factory, steps });
    assert.equal(runs, 1, 'a step runs once');
    again.close();
    const { stores } = await inspect(factory, name);
    assert.deepEqual(stores.memory.indexes, { scope: 'scope', source: 'source' });
  });

  it('runs every step on a new database', async () => {
    const order = /** @type {number[]} */ ([]);
    const steps = [
      { version: 1, apply: () => void order.push(1) },
      { version: 2, apply: () => void order.push(2) },
    ];
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory(), steps });
    assert.deepEqual(order, [1, 2]);
    db.close();
  });

  it('refuses steps out of order and bad database names', async () => {
    await assert.rejects(openAppDb({ name: uniqueName(), factory: null, steps: [{ version: 2, apply() {} }] }), (err) => err.code === 'data');
    await assert.rejects(openAppDb({ name: 'Bad Name', factory: null }), (err) => err.code === 'data');
  });
});

describe('queries the app relies on', () => {
  it('walks the message tree: children, siblings after an edit, and the path to the root', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    // u1 -> a1, then u1 was edited into u1b (a sibling under the same parent) -> a2.
    await db.putMany('nodes', [node('u1', null, 'user', 1), node('a1', 'u1', 'assistant', 2), node('u1b', null, 'user', 3), node('a2', 'u1b', 'assistant', 4), node('a1r', 'u1', 'assistant', 5)]);
    await db.put('nodes', { ...node('other', null, 'user', 1), conversationId: 'conv2' });

    const all = /** @type {NodeRecord[]} */ (await db.getAllFromIndex('nodes', 'conversationId', 'conv'));
    assert.equal(all.length, 5);
    const roots = all.filter((n) => n.parentId === null).sort((a, b) => a.createdAt - b.createdAt);
    assert.deepEqual(roots.map((n) => n.id), ['u1', 'u1b']);

    const regenerated = /** @type {NodeRecord[]} */ (await db.getAllFromIndex('nodes', 'parentId', 'u1'));
    assert.deepEqual(regenerated.map((n) => n.id).sort(), ['a1', 'a1r']);

    /** @param {string} leafId */
    const pathTo = async (leafId) => {
      const path = [];
      for (let id = /** @type {string | null} */ (leafId); id; ) {
        const n = /** @type {NodeRecord} */ (await db.get('nodes', id));
        path.unshift(n.id);
        id = n.parentId;
      }
      return path;
    };
    assert.deepEqual(await pathTo('a2'), ['u1b', 'a2']);
    assert.deepEqual(await pathTo('a1r'), ['u1', 'a1r']);
    db.close();
  });

  it('lists conversations newest first, pinned ones, and those of a project', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    /** @param {string} id @param {number} updatedAt @param {Partial<ConversationRecord>} [extra] @returns {ConversationRecord} */
    const conv = (id, updatedAt, extra = {}) => ({ id, title: id, createdAt: 0, updatedAt, pinned: 0, archived: 0, activeLeafId: null, model: null, mode: 'free', ...extra });
    await db.putMany('conversations', [conv('old', 10), conv('new', 30, { pinned: 1 }), conv('mid', 20, { projectId: 'p1' })]);
    /** @type {string[]} */
    const newest = [];
    await db.iterate('conversations', { index: 'updatedAt', direction: 'prev', limit: 2 }, (c) => void newest.push(c.id));
    assert.deepEqual(newest, ['new', 'mid']);
    assert.deepEqual(await db.getAllKeysFromIndex('conversations', 'pinned', 1), ['new']);
    assert.deepEqual(await db.getAllKeysFromIndex('conversations', 'projectId', 'p1'), ['mid']);
    db.close();
  });

  it('removes a document with its chunks and vectors in one transaction', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const data = new Int8Array([1, -1, 0, 127]);
    await db.transaction(['docs', 'chunks', 'vectors'], 'readwrite', async (tx) => {
      for (const docId of ['d1', 'd2']) {
        await tx.put('docs', { id: docId, name: `${docId}.txt`, sha256: `hash-${docId}`, extractor: 1, bytes: 10, addedAt: 0 });
        await tx.putMany('chunks', [0, 1, 2].map((idx) => ({ docId, idx, start: idx * 5, end: idx * 5 + 5, text: `${docId}-${idx}` })));
        await tx.putMany('vectors', [0, 1, 2].map((idx) => ({ docId, idx, model: 'embed-small', dim: 4, data, scale: 0.01 })));
      }
    });
    assert.equal((await db.getFromIndex('docs', 'sha256', 'hash-d2')).id, 'd2');
    assert.deepEqual((await db.getAll('chunks', range.prefix(['d1']))).map((c) => c.text), ['d1-0', 'd1-1', 'd1-2']);
    assert.deepEqual([...(await db.get('vectors', ['d1', 1, 'embed-small'])).data], [1, -1, 0, 127]);

    await db.transaction(['docs', 'chunks', 'vectors'], 'readwrite', async (tx) => {
      await tx.delete('docs', 'd1');
      await tx.delete('chunks', range.prefix(['d1']));
      await tx.delete('vectors', range.prefix(['d1']));
    });
    assert.deepEqual(await db.getAllKeys('docs'), ['d2']);
    assert.equal(await db.count('chunks'), 3);
    assert.equal(await db.countFromIndex('vectors', 'docId', 'd1'), 0);
    db.close();
  });

  it('keeps a non-extractable signing key usable after a round trip', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']));
    await db.put('signingKeys', { id: 'k1', alg: 'Ed25519', privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk: {}, createdAt: 0, retiredAt: null });
    const stored = await db.get('signingKeys', 'k1');
    assert.equal(stored.privateKey.extractable, false);
    const message = new TextEncoder().encode('receipt');
    const signature = await crypto.subtle.sign('Ed25519', stored.privateKey, message);
    assert.equal(await crypto.subtle.verify('Ed25519', stored.publicKey, signature, message), true);
    db.close();
  });

  it('forgets everything in one call', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    await db.put('settings', { key: 'a', value: 1, updatedAt: 0 });
    await db.put('blobs', { id: 'b', data: new Blob(['x']), type: '', size: 1, kind: 'attachment', createdAt: 0 });
    await clearStores(db);
    for (const store of STORE_NAMES) assert.equal(await db.count(store), 0, store);
    db.close();
  });
});

describe('the shared connection', () => {
  it('uses the profile name and reopens after another tab upgraded the database', async () => {
    assert.equal(storeProfileName(), DEFAULT_DB_NAME);
    let versionChanges = 0;
    configureStore({ name: 'schema-shared-test', onVersionChange: () => (versionChanges += 1) });
    try {
      const first = await appDb();
      assert.equal(first.name, 'schema-shared-test');
      assert.equal(await appDb(), first, 'one connection per page');
      // Another tab opens a newer version: this connection closes, the next call reopens.
      const newer = await openAppDb({ name: 'schema-shared-test', steps: [...SCHEMA_STEPS, { version: 2, apply() {} }], onVersionChange: undefined });
      assert.equal(versionChanges, 1);
      assert.equal(first.isClosed(), true);
      newer.close();
      // The page still runs the older build, which now meets a newer database and falls back.
      const reopened = await appDb();
      assert.notEqual(reopened, first);
      assert.equal(reopened.persistent, false);
      assert.equal(reopened.fallbackReason, 'version');
    } finally {
      configureStore({ name: DEFAULT_DB_NAME, onVersionChange: undefined });
    }
  });
});
