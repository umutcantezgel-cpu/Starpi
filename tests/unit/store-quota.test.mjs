// Storage quota and persistence: estimates for display and for "does this file fit", and a
// persistence request that asks the browser at most once per page.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeUsage, estimateStorage, hasRoomFor, isPersisted, requestPersistence } from '../../src/js/store/quota.js';

const MB = 1024 * 1024;

/**
 * @param {{ usage?: number, quota?: number, persisted?: boolean, grant?: boolean }} [state]
 */
function fakeStorage(state = {}) {
  let persisted = state.persisted ?? false;
  const calls = { persist: 0 };
  return {
    calls,
    estimate: async () => ({ usage: state.usage ?? 0, quota: state.quota ?? 0 }),
    persisted: async () => persisted,
    persist: async () => {
      calls.persist += 1;
      persisted = state.grant ?? false;
      return persisted;
    },
  };
}

describe('estimateStorage', () => {
  it('reports usage, quota, free space and the used share', async () => {
    assert.deepEqual(await estimateStorage(fakeStorage({ usage: 25 * MB, quota: 100 * MB })), { supported: true, usage: 25 * MB, quota: 100 * MB, free: 75 * MB, ratio: 0.25 });
  });

  it('says so when the browser cannot estimate', async () => {
    assert.equal((await estimateStorage(null)).supported, false);
    assert.equal((await estimateStorage({ estimate: async () => ({}) })).supported, false);
    const failing = { estimate: async () => Promise.reject(new Error('denied')) };
    assert.deepEqual(await estimateStorage(failing), { supported: false, usage: 0, quota: 0, free: 0, ratio: 0 });
  });

  it('gives display values in the locale number format', async () => {
    const usage = await estimateStorage(fakeStorage({ usage: 1.5 * MB, quota: 2048 * MB }));
    assert.deepEqual(describeUsage(usage), { usage: '1.5 MB', quota: '2 GB', free: '2 GB', percent: 0 });
    const german = describeUsage(usage, (v, o) => v.toLocaleString('de-DE', o));
    assert.equal(german.usage, '1,5 MB');
  });

  it('checks whether a file fits with a margin, and never blocks when the quota is unknown', async () => {
    const storage = fakeStorage({ usage: 90 * MB, quota: 100 * MB });
    assert.equal(await hasRoomFor(8 * MB, { storage }), true);
    assert.equal(await hasRoomFor(9 * MB, { storage }), false);
    assert.equal(await hasRoomFor(9 * MB, { storage, margin: 1 }), true);
    assert.equal(await hasRoomFor(10 ** 12, { storage: null }), true);
  });
});

describe('requestPersistence', () => {
  it('asks once per page and remembers a denial', async () => {
    const storage = fakeStorage({ grant: false });
    assert.deepEqual(await requestPersistence({ storage }), { supported: true, persisted: false, asked: true });
    assert.deepEqual(await requestPersistence({ storage }), { supported: true, persisted: false, asked: false });
    assert.equal(storage.calls.persist, 1);
    assert.deepEqual(await requestPersistence({ storage, force: true }), { supported: true, persisted: false, asked: true });
    assert.equal(storage.calls.persist, 2);
  });

  it('does not ask when the data is already persisted', async () => {
    const storage = fakeStorage({ persisted: true });
    assert.deepEqual(await requestPersistence({ storage }), { supported: true, persisted: true, asked: false });
    assert.equal(storage.calls.persist, 0);
    assert.equal(await isPersisted(storage), true);
  });

  it('reports a granted request', async () => {
    const storage = fakeStorage({ grant: true });
    assert.equal((await requestPersistence({ storage })).persisted, true);
    assert.equal(await isPersisted(storage), true);
  });

  it('handles browsers without persistence and failing requests', async () => {
    assert.deepEqual(await requestPersistence({ storage: null }), { supported: false, persisted: false, asked: false });
    assert.equal(await isPersisted(null), null);
    const failing = { ...fakeStorage(), persist: async () => Promise.reject(new Error('blocked')) };
    assert.deepEqual(await requestPersistence({ storage: failing }), { supported: true, persisted: false, asked: true });
  });
});
