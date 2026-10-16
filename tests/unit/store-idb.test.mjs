// The IndexedDB wrapper: the same behaviour on IndexedDB (fake-indexeddb) and on the in-memory
// stand-in, key order, transactions that roll back as a whole, and the fallback when IndexedDB
// is missing, throws, hangs or is blocked by an older connection.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { compareKeys, deleteDb, isValidKey, KeyRange, openDb, range, StoreError } from '../../src/js/store/idb.js';

let seq = 0;
const uniqueName = () => `test-db-${process.pid}-${(seq += 1)}`;

/** @param {import('../../src/js/store/idb.js').UpgradeContext} ctx */
function layout(ctx) {
  ctx.createStore('items', { keyPath: 'id' });
  ctx.createIndex('items', 'group', 'group');
  ctx.createIndex('items', 'flag', 'flag');
  ctx.createIndex('items', 'code', 'code', { unique: true });
  ctx.createStore('pairs', { keyPath: ['owner', 'n'] });
  ctx.createIndex('pairs', 'owner', 'owner');
  ctx.createStore('nested', { keyPath: 'meta.key' });
}

const BACKENDS = [
  { label: 'IndexedDB', persistent: true, options: () => ({ factory: new IDBFactory() }) },
  { label: 'memory stand-in', persistent: false, options: () => ({ factory: null }) },
];

/** @param {import('../../src/js/store/idb.js').StoreDb} db */
async function seed(db) {
  await db.putMany('items', [
    { id: 'c', group: 'g2', flag: 1, code: 'C', n: 3 },
    { id: 'a', group: 'g1', flag: 0, code: 'A', n: 1 },
    { id: 'b', group: 'g1', flag: 1, code: 'B', n: 2 },
    { id: 'd', group: 'g2', code: 'D', n: 4 },
  ]);
}

for (const backend of BACKENDS) {
  describe(`store on ${backend.label}`, () => {
    const open = (name = uniqueName(), options = backend.options()) => openDb(name, 1, layout, options);

    it('reports where data lives', async () => {
      const db = await open();
      assert.equal(db.backend, backend.persistent ? 'indexeddb' : 'memory');
      assert.equal(db.persistent, backend.persistent);
      assert.equal(db.fallbackReason, backend.persistent ? null : 'unsupported');
      assert.equal(db.version, 1);
      assert.deepEqual(db.storeNames().sort(), ['items', 'nested', 'pairs']);
      db.close();
    });

    it('puts, gets, replaces, adds, counts and deletes records', async () => {
      const db = await open();
      assert.equal(await db.put('items', { id: 'x', group: 'g', code: 'X', n: 1 }), 'x');
      assert.deepEqual(await db.get('items', 'x'), { id: 'x', group: 'g', code: 'X', n: 1 });
      await db.put('items', { id: 'x', group: 'g', code: 'X', n: 2 });
      assert.equal((await db.get('items', 'x')).n, 2);
      assert.equal(await db.get('items', 'missing'), undefined);
      await assert.rejects(db.add('items', { id: 'x', code: 'Y' }), (err) => err instanceof StoreError && err.code === 'constraint');
      assert.equal(await db.add('items', { id: 'y', code: 'Y' }), 'y');
      assert.equal(await db.count('items'), 2);
      await db.delete('items', 'x');
      assert.deepEqual(await db.getAllKeys('items'), ['y']);
      await db.clear('items');
      assert.equal(await db.count('items'), 0);
      db.close();
    });

    it('returns copies, so changing a result never changes the store', async () => {
      const db = await open();
      const record = { id: 'k', code: 'K', list: [1, 2] };
      await db.put('items', record);
      record.list.push(3);
      const read = await db.get('items', 'k');
      read.list.push(4);
      assert.deepEqual((await db.get('items', 'k')).list, [1, 2]);
      db.close();
    });

    it('reads in key order with ranges and limits', async () => {
      const db = await open();
      await seed(db);
      assert.deepEqual(await db.getAllKeys('items'), ['a', 'b', 'c', 'd']);
      assert.deepEqual((await db.getAll('items', range.bound('b', 'c'))).map((r) => r.id), ['b', 'c']);
      assert.deepEqual(await db.getAllKeys('items', range.bound('a', 'c', true, true)), ['b']);
      assert.deepEqual(await db.getAllKeys('items', range.lowerBound('c')), ['c', 'd']);
      assert.deepEqual(await db.getAllKeys('items', range.upperBound('b', true)), ['a']);
      assert.deepEqual(await db.getAllKeys('items', null, 2), ['a', 'b']);
      assert.equal(await db.count('items', range.only('b')), 1);
      assert.equal((await db.get('items', range.lowerBound('b', true))).id, 'c');
      db.close();
    });

    it('queries indexes, skipping records without a valid index key', async () => {
      const db = await open();
      await seed(db);
      assert.deepEqual((await db.getAllFromIndex('items', 'group', 'g1')).map((r) => r.id), ['a', 'b']);
      assert.deepEqual(await db.getAllKeysFromIndex('items', 'group', 'g2'), ['c', 'd']);
      assert.equal(await db.countFromIndex('items', 'group'), 4);
      assert.equal((await db.getFromIndex('items', 'code', 'C')).id, 'c');
      // 'd' has no flag and is not part of that index.
      assert.equal(await db.countFromIndex('items', 'flag'), 3);
      assert.deepEqual(await db.getAllKeysFromIndex('items', 'flag', 1), ['b', 'c']);
      await assert.rejects(db.put('items', { id: 'e', code: 'A' }), (err) => err.code === 'constraint');
      db.close();
    });

    it('keeps compound keys in order and finds them by prefix', async () => {
      const db = await open();
      await db.putMany('pairs', [
        { owner: 'q', n: 10 },
        { owner: 'p', n: 2 },
        { owner: 'p', n: 10 },
        { owner: 'p', n: 1 },
        { owner: 'pp', n: 0 },
      ]);
      assert.deepEqual(await db.getAllKeys('pairs', range.prefix(['p'])), [
        ['p', 1],
        ['p', 2],
        ['p', 10],
      ]);
      assert.equal(await db.countFromIndex('pairs', 'owner', 'p'), 3);
      await db.delete('pairs', range.prefix(['p']));
      assert.deepEqual(await db.getAllKeys('pairs'), [
        ['pp', 0],
        ['q', 10],
      ]);
      db.close();
    });

    it('reads dotted key paths', async () => {
      const db = await open();
      await db.put('nested', { meta: { key: 7 }, v: 'x' });
      assert.equal((await db.get('nested', 7)).v, 'x');
      await assert.rejects(db.put('nested', { meta: {} }), (err) => err.code === 'data');
      db.close();
    });

    it('walks a cursor forwards, backwards, over an index and stops on request', async () => {
      const db = await open();
      await seed(db);
      /** @type {string[]} */
      const seen = [];
      assert.equal(await db.iterate('items', {}, (r) => void seen.push(r.id)), 4);
      assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
      seen.length = 0;
      await db.iterate('items', { direction: 'prev', limit: 2 }, (r) => void seen.push(r.id));
      assert.deepEqual(seen, ['d', 'c']);
      /** @type {Array<[unknown, unknown]>} */
      const keys = [];
      await db.iterate('items', { index: 'group', query: 'g2', direction: 'prev' }, (_r, key, primaryKey) => void keys.push([key, primaryKey]));
      assert.deepEqual(keys, [
        ['g2', 'd'],
        ['g2', 'c'],
      ]);
      seen.length = 0;
      const visited = await db.iterate('items', {}, (r) => {
        seen.push(r.id);
        return r.id !== 'b';
      });
      assert.equal(visited, 2);
      assert.deepEqual(seen, ['a', 'b']);
      await assert.rejects(
        db.iterate('items', {}, () => {
          throw new Error('visitor failed');
        }),
        /visitor failed/,
      );
      db.close();
    });

    it('commits a transaction over several stores as a whole', async () => {
      const db = await open();
      const result = await db.transaction(['items', 'pairs'], 'readwrite', async (tx) => {
        await tx.put('items', { id: 'm', code: 'M' });
        await tx.put('pairs', { owner: 'm', n: 1 });
        return tx.count('items');
      });
      assert.equal(result, 1);
      assert.equal(await db.count('pairs'), 1);
      db.close();
    });

    it('rolls a transaction back when its function throws', async () => {
      const db = await open();
      await db.put('items', { id: 'keep', code: 'K', n: 1 });
      await assert.rejects(
        db.transaction(['items', 'pairs'], 'readwrite', async (tx) => {
          await tx.put('items', { id: 'keep', code: 'K', n: 2 });
          await tx.put('pairs', { owner: 'x', n: 1 });
          await tx.clear('items');
          throw new Error('stop');
        }),
        /stop/,
      );
      assert.deepEqual(await db.getAll('items'), [{ id: 'keep', code: 'K', n: 1 }]);
      assert.equal(await db.count('pairs'), 0);
      db.close();
    });

    it('aborts the whole transaction when a write fails, even if the caller catches it', async () => {
      const db = await open();
      await db.put('items', { id: 'one', code: 'O' });
      await assert.rejects(
        db.transaction('items', 'readwrite', async (tx) => {
          await tx.put('items', { id: 'two', code: 'T' });
          await tx.add('items', { id: 'one', code: 'Z' }).catch(() => {});
          return 'finished';
        }),
        (err) => err instanceof StoreError && err.code === 'constraint',
      );
      assert.deepEqual(await db.getAllKeys('items'), ['one']);
      db.close();
    });

    it('rejects a bad call without aborting the transaction', async () => {
      const db = await open();
      await db.transaction('items', 'readwrite', async (tx) => {
        await assert.rejects(tx.put('items', { code: 'no id' }), (err) => err.code === 'data');
        await tx.put('items', { id: 'ok', code: 'OK' });
      });
      assert.deepEqual(await db.getAllKeys('items'), ['ok']);
      await assert.rejects(db.get('nope', 'x'), (err) => err.code === 'not_found');
      await assert.rejects(
        db.transaction('items', 'readonly', (tx) => tx.put('items', { id: 'r', code: 'R' })),
        (err) => err.code === 'read_only',
      );
      await assert.rejects(db.get('items', undefined), (err) => err.code === 'data');
      db.close();
    });

    it('cannot index booleans, which is why flags are stored as 0 or 1', async () => {
      const db = await open();
      await db.put('items', { id: 't', code: 'T', flag: true });
      assert.equal(await db.countFromIndex('items', 'flag'), 0);
      db.close();
    });

    it('stores binary data, dates and blobs', async () => {
      const db = await open();
      const at = new Date('2026-10-01T00:00:00Z');
      await db.put('items', { id: 'bin', code: 'BIN', bytes: new Int8Array([1, -2, 3]), at, blob: new Blob(['hello'], { type: 'text/plain' }) });
      const read = await db.get('items', 'bin');
      assert.deepEqual([...read.bytes], [1, -2, 3]);
      assert.equal(read.at.getTime(), at.getTime());
      assert.equal(await read.blob.text(), 'hello');
      db.close();
    });

    it('keeps the data when the database is closed and opened again', async () => {
      const name = uniqueName();
      const options = backend.options();
      const first = await open(name, options);
      await first.put('items', { id: 'stay', code: 'S' });
      first.close();
      await assert.rejects(first.get('items', 'stay'), (err) => err.code === 'closed');
      const second = await open(name, options);
      assert.equal((await second.get('items', 'stay')).code, 'S');
      second.close();
      await deleteDb(name, options);
    });

    it('closes an older connection when the database is upgraded', async () => {
      const name = uniqueName();
      const options = backend.options();
      let notified = 0;
      const first = await openDb(name, 1, layout, { ...options, onVersionChange: () => (notified += 1) });
      await first.put('items', { id: 'a', code: 'A' });
      const second = await openDb(name, 2, (ctx) => {
        assert.equal(ctx.oldVersion, 1);
        assert.equal(ctx.newVersion, 2);
        ctx.createStore('extra', { keyPath: 'id' });
      }, options);
      assert.equal(notified, 1);
      assert.equal(first.isClosed(), true);
      await assert.rejects(first.get('items', 'a'), (err) => err.code === 'closed');
      assert.equal((await second.get('items', 'a')).code, 'A');
      assert.ok(second.storeNames().includes('extra'));
      second.close();
    });

    it('leaves the database unchanged when an upgrade fails', async () => {
      const name = uniqueName();
      // On IndexedDB, a failed upgrade must not hide behind the memory fallback here.
      const options = backend.persistent ? { ...backend.options(), fallback: false } : backend.options();
      const first = await openDb(name, 1, layout, options);
      await first.put('items', { id: 'a', code: 'A' });
      first.close();
      await assert.rejects(
        openDb(name, 2, async (ctx) => {
          ctx.createStore('extra', { keyPath: 'id' });
          await ctx.tx.put('items', { id: 'b', code: 'B' });
          throw new Error('step failed');
        }, options),
        (err) => err instanceof StoreError,
      );
      const again = await openDb(name, 1, layout, options);
      assert.deepEqual(await again.getAllKeys('items'), ['a']);
      assert.ok(!again.storeNames().includes('extra'));
      again.close();
    });
  });
}

describe('falling back to memory', () => {
  it('uses memory when there is no IndexedDB', async () => {
    const db = await openDb(uniqueName(), 1, layout, { factory: null });
    assert.equal(db.persistent, false);
    assert.equal(db.fallbackReason, 'unsupported');
    await db.put('items', { id: 'a', code: 'A' });
    assert.equal(await db.count('items'), 1);
  });

  it('uses memory when opening throws, e.g. with site data blocked', async () => {
    const factory = /** @type {IDBFactory} */ (
      /** @type {unknown} */ ({
        open() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      })
    );
    const db = await openDb(uniqueName(), 1, layout, { factory });
    assert.equal(db.backend, 'memory');
    assert.equal(db.fallbackReason, 'unavailable');
  });

  it('uses memory when opening fails asynchronously', async () => {
    const factory = /** @type {IDBFactory} */ (
      /** @type {unknown} */ ({
        open() {
          const req = /** @type {any} */ ({ error: new DOMException('Disk failure', 'UnknownError') });
          setTimeout(() => req.onerror?.({ preventDefault() {} }), 0);
          return req;
        },
      })
    );
    const db = await openDb(uniqueName(), 1, layout, { factory });
    assert.equal(db.fallbackReason, 'error');
  });

  it('uses memory when opening never answers', async () => {
    const factory = /** @type {IDBFactory} */ (/** @type {unknown} */ ({ open: () => ({}) }));
    const db = await openDb(uniqueName(), 1, layout, { factory, timeoutMs: 20 });
    assert.equal(db.fallbackReason, 'timeout');
  });

  it('uses memory while an older connection blocks the upgrade, and closes the late connection', async () => {
    const factory = new IDBFactory();
    const name = uniqueName();
    const old = await new Promise((resolve, reject) => {
      const req = factory.open(name, 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // This raw connection ignores versionchange, as a tab running an older build might.
    let blockedCalls = 0;
    const db = await openDb(name, 2, layout, { factory, timeoutMs: 30, onBlocked: () => (blockedCalls += 1) });
    assert.equal(db.fallbackReason, 'blocked');
    assert.equal(blockedCalls, 1);
    old.close();
    // The upgrade now runs on disk; its connection is closed right away, so a later open works.
    const later = await openDb(name, 2, layout, { factory, fallback: false });
    assert.equal(later.backend, 'indexeddb');
    later.close();
  });

  it('rejects instead when the fallback is turned off', async () => {
    await assert.rejects(openDb(uniqueName(), 1, layout, { factory: null, fallback: false }), (err) => err.code === 'unavailable');
    const factory = new IDBFactory();
    const name = uniqueName();
    (await openDb(name, 3, layout, { factory })).close();
    await assert.rejects(openDb(name, 2, layout, { factory, fallback: false }), (err) => err.code === 'version');
  });

  it('checks its arguments', async () => {
    await assert.rejects(openDb('', 1, layout), (err) => err.code === 'data');
    await assert.rejects(openDb(uniqueName(), 0, layout), (err) => err.code === 'data');
    await assert.rejects(openDb(uniqueName(), 1, (ctx) => ctx.createStore('bad', { keyPath: 'no spaces' }), { factory: null }), (err) => err.code === 'data');
  });
});

describe('keys', () => {
  it('orders keys like IndexedDB: numbers, dates, strings, binary, arrays', () => {
    const keys = [[1], new Uint8Array([2]), 'b', 'a', new Date(5), 10, -1, [0, 'x'], [0]];
    const sorted = [...keys].sort(compareKeys);
    assert.deepEqual(sorted, [-1, 10, new Date(5), 'a', 'b', new Uint8Array([2]), [0], [0, 'x'], [1]]);
  });

  it('accepts only valid keys', () => {
    assert.equal(isValidKey('x'), true);
    assert.equal(isValidKey([1, ['a']]), true);
    for (const bad of [true, null, undefined, Number.NaN, { a: 1 }, new Date(Number.NaN), [1, null]]) assert.equal(isValidKey(bad), false);
  });

  it('builds closed and open ranges, and refuses empty ones', () => {
    assert.ok(range.prefix(['doc']).includes(['doc', 0]));
    assert.ok(range.prefix(['doc']).includes(['doc', 'z']));
    assert.ok(!range.prefix(['doc']).includes(['doc2', 0]));
    assert.ok(range.startsWith('files/').includes('files/a'));
    assert.ok(!range.startsWith('files/').includes('filesx'));
    assert.ok(range.only(3) instanceof KeyRange);
    assert.throws(() => range.bound(2, 1), (err) => err.code === 'data');
    assert.throws(() => range.bound(1, 1, true), (err) => err.code === 'data');
  });
});
