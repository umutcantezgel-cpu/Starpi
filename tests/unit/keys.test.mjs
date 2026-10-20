// Key store: keys stay in this tab's session storage by default; the optional vault keeps them as
// AES-GCM ciphertext under a PBKDF2-derived, non-extractable key that lives in memory only. The
// tests run real WebCrypto, a fake IndexedDB, an in-memory session area and a fake clock.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  ACCESS_SLOT,
  cleanKey,
  createKeyStore,
  isKeySlot,
  KEY_SLOTS,
  KeyStoreError,
  sessionName,
  VAULT_IDLE_MS,
  VAULT_ITERATIONS,
  VAULT_RECORD_ID,
} from '../../src/js/ai/keys.js';
import { openAppDb } from '../../src/js/store/schema.js';

let seq = 0;
const dbName = () => `keys-test-${(seq += 1)}`;
/** Fast PBKDF2 for most tests; one test checks the real default. */
const FAST = 1000;
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
const GROQ_KEY = 'gsk_abcdefghijklmnopqrstuvwxyz012345';

/** A session area backed by a Map. */
function memorySession() {
  const map = new Map();
  return {
    map,
    read: (/** @type {string} */ name) => map.get(name) ?? '',
    write: (/** @type {string} */ name, /** @type {string} */ value) => (map.set(name, value), true),
    remove: (/** @type {string} */ name) => void map.delete(name),
  };
}

/** A clock and timers the test moves by hand. */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  /** @type {Array<{ fn: () => void, at: number, id: number }>} */
  let pending = [];
  let ids = 0;
  return {
    now: () => now,
    timers: {
      set(/** @type {() => void} */ fn, /** @type {number} */ ms) {
        const id = (ids += 1);
        pending.push({ fn, at: now + ms, id });
        return id;
      },
      clear(/** @type {unknown} */ id) {
        pending = pending.filter((t) => t.id !== id);
      },
    },
    get pending() {
      return pending.length;
    },
    /** @param {number} ms */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = pending.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        pending = pending.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

/**
 * @param {{ factory?: IDBFactory | null, name?: string, session?: ReturnType<typeof memorySession>, clock?: ReturnType<typeof fakeClock>, iterations?: number }} [opts]
 */
async function setup(opts = {}) {
  const name = opts.name ?? dbName();
  const factory = opts.factory === undefined ? new IDBFactory() : opts.factory;
  const db = await openAppDb({ name, factory });
  const session = opts.session ?? memorySession();
  const clock = opts.clock ?? fakeClock();
  const store = createKeyStore({ db: async () => db, session, now: clock.now, timers: clock.timers, iterations: opts.iterations ?? FAST });
  return { db, session, clock, store, factory, name };
}

describe('key slots', () => {
  it('cover the providers that take a key, the services and the access code', () => {
    for (const id of ['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'minimax', 'openrouter', 'nvidia', 'local', 'elevenlabs', 'brave', 'tavily', ACCESS_SLOT]) assert.ok(isKeySlot(id), id);
    for (const id of ['webgpu', 'wasm', 'nope', '', 42]) assert.equal(isKeySlot(id), false, String(id));
    assert.equal(new Set(KEY_SLOTS).size, KEY_SLOTS.length);
  });

  it('keep the 2.x session names for the two providers 2.x knew', () => {
    assert.equal(sessionName('gemini'), 'starpi_gemini_key');
    assert.equal(sessionName('openrouter'), 'starpi_openrouter_key');
    assert.equal(sessionName('groq'), 'starpi_key_groq');
  });

  it('accept printable keys without spaces only', () => {
    assert.equal(cleanKey('  abc-123  '), 'abc-123');
    for (const bad of ['', 'two words', 'line\nbreak', 'ümlaut', 'x'.repeat(1025), null, 7]) assert.equal(cleanKey(bad), null, String(bad));
    assert.equal(cleanKey(' open sesame ', ACCESS_SLOT), 'open sesame', 'the access code may contain inner spaces');
    assert.equal(cleanKey('line\nbreak', ACCESS_SLOT), null);
  });
});

describe('session keys', () => {
  it('are kept in the session area by default and read back', async () => {
    const { store, session } = await setup();
    assert.equal(store.getKey('groq'), '');
    await store.setKey('groq', `  ${GROQ_KEY} `);
    assert.equal(session.map.get('starpi_key_groq'), GROQ_KEY);
    assert.equal(store.getKey('groq'), GROQ_KEY);
    assert.equal(store.hasKey('groq'), true);
    assert.equal(store.keyLocation('groq'), 'session');
    await store.removeKey('groq');
    assert.equal(store.hasKey('groq'), false);
    assert.equal(store.keyLocation('groq'), null);
  });

  it('refuse unknown slots and unusable keys', async () => {
    const { store } = await setup();
    assert.throws(() => store.setKey('webgpu', 'k'), (/** @type {any} */ err) => err instanceof KeyStoreError && err.code === 'invalid_slot');
    await assert.rejects(store.setKey('groq', 'has space'), (/** @type {any} */ err) => err.code === 'invalid_key');
    assert.equal(store.getKey('unknown'), '');
  });

  it('report a session area that refuses to store', async () => {
    const session = { ...memorySession(), write: () => false };
    const { store } = await setup({ session: /** @type {any} */ (session) });
    await assert.rejects(store.setKey('groq', GROQ_KEY), (/** @type {any} */ err) => err.code === 'storage');
  });

  it('tell listeners which slot changed', async () => {
    const { store } = await setup();
    /** @type {unknown[]} */
    const seen = [];
    const off = store.onKeysChange((c) => seen.push(c));
    await store.setKey('openai', 'sk-abcdefghijklmnopqrstuvwxyz');
    off();
    await store.removeKey('openai');
    assert.deepEqual(seen, [{ type: 'key', slot: 'openai' }]);
  });
});

describe('vault', () => {
  it('starts without a vault, and creating one moves the session keys into it', async () => {
    const { store, session, db } = await setup();
    await store.ready();
    assert.equal(store.vaultState(), 'none');
    await store.setKey('anthropic', ANTHROPIC_KEY);
    assert.equal(await store.unlock('short'), 'too_short');
    assert.equal(await store.unlock('correct horse battery'), 'created');
    assert.equal(store.vaultState(), 'unlocked');
    assert.equal(session.map.size, 0, 'the session copy moved into the vault');
    assert.equal(store.getKey('anthropic'), ANTHROPIC_KEY);
    assert.equal(store.keyLocation('anthropic'), 'vault');

    const record = await db.get('keyvault', VAULT_RECORD_ID);
    assert.deepEqual(Object.keys(record).sort(), ['ct', 'id', 'iv', 'kdf', 'salt', 'updatedAt', 'v']);
    assert.equal(record.v, 1);
    assert.deepEqual(record.kdf, { name: 'PBKDF2', hash: 'SHA-256', iterations: FAST });
    assert.ok(record.salt instanceof Uint8Array && record.salt.length === 16);
    assert.ok(record.iv instanceof Uint8Array && record.iv.length === 12);
    assert.ok(record.ct instanceof Uint8Array);
    // Nothing of the key is readable in the stored record.
    const stored = JSON.stringify({ ...record, salt: [...record.salt], iv: [...record.iv], ct: [...record.ct] });
    assert.equal(stored.includes(ANTHROPIC_KEY), false);
    assert.equal(Buffer.from(record.ct).toString('latin1').includes('sk-ant'), false);
  });

  it('round-trips: lock drops the keys, unlock with the passphrase brings them back, a wrong one does not', async () => {
    const { store, db, factory, name } = await setup();
    await store.ready();
    assert.equal(await store.unlock('a good passphrase'), 'created');
    await store.setKey('anthropic', ANTHROPIC_KEY, { remember: true });
    await store.setKey('groq', GROQ_KEY, { remember: true });
    store.lock();
    assert.equal(store.vaultState(), 'locked');
    assert.equal(store.getKey('anthropic'), '');
    assert.equal(await store.unlock('the wrong passphrase'), 'wrong');
    assert.equal(store.vaultState(), 'locked');
    assert.equal(await store.unlock('a good passphrase'), 'unlocked');
    assert.equal(store.getKey('anthropic'), ANTHROPIC_KEY);
    assert.equal(store.getKey('groq'), GROQ_KEY);

    // Another page (a reload) with the same database finds the vault locked and opens it.
    db.close();
    const again = await setup({ factory, name });
    await again.store.ready();
    assert.equal(again.store.vaultState(), 'locked');
    assert.equal(again.store.getKey('groq'), '');
    assert.equal(await again.store.unlock('a good passphrase'), 'unlocked');
    assert.equal(again.store.getKey('groq'), GROQ_KEY);
  });

  it('keeps the derived key non-extractable', async () => {
    /** @type {CryptoKey[]} */
    const derived = [];
    const subtle = globalThis.crypto.subtle;
    const spy = /** @type {Crypto} */ (
      /** @type {unknown} */ ({
        getRandomValues: (/** @type {Uint8Array} */ a) => globalThis.crypto.getRandomValues(a),
        subtle: {
          importKey: subtle.importKey.bind(subtle),
          encrypt: subtle.encrypt.bind(subtle),
          decrypt: subtle.decrypt.bind(subtle),
          deriveKey: async (/** @type {any[]} */ ...args) => {
            const key = await subtle.deriveKey(.../** @type {[any, any, any, any, any]} */ (args));
            derived.push(key);
            return key;
          },
        },
      })
    );
    const db = await openAppDb({ name: dbName(), factory: new IDBFactory() });
    const store = createKeyStore({ db: async () => db, session: memorySession(), iterations: FAST, crypto: spy });
    assert.equal(await store.unlock('long enough pass'), 'created');
    assert.equal(derived.length, 1);
    assert.equal(derived[0].extractable, false);
    assert.deepEqual(derived[0].algorithm, { name: 'AES-GCM', length: 256 });
    await assert.rejects(subtle.exportKey('raw', derived[0]));
  });

  it('uses 600 000 PBKDF2 iterations by default', async () => {
    const db = await openAppDb({ name: dbName(), factory: new IDBFactory() });
    const store = createKeyStore({ db: async () => db, session: memorySession() });
    assert.equal(VAULT_ITERATIONS, 600_000);
    assert.equal(await store.unlock('default iterations'), 'created');
    assert.equal((await db.get('keyvault', VAULT_RECORD_ID)).kdf.iterations, 600_000);
  });

  it('needs an unlocked vault to remember a key; a session key replaces a vault copy', async () => {
    const { store, session } = await setup();
    await store.ready();
    await assert.rejects(store.setKey('groq', GROQ_KEY, { remember: true }), (/** @type {any} */ err) => err.code === 'locked');
    await store.unlock('passphrase one');
    await store.setKey('groq', GROQ_KEY, { remember: true });
    assert.equal(store.keyLocation('groq'), 'vault');
    await store.setKey('groq', 'gsk_sessiononlykey0123456789abcdef');
    assert.equal(store.keyLocation('groq'), 'session');
    store.lock();
    await store.unlock('passphrase one');
    session.map.clear();
    assert.equal(store.getKey('groq'), '', 'the vault copy was removed');
  });

  it('keeps a change another tab wrote in the meantime', async () => {
    const shared = await setup();
    await shared.store.ready();
    await shared.store.unlock('shared passphrase');
    const other = createKeyStore({ db: async () => shared.db, session: memorySession(), iterations: FAST, now: shared.clock.now, timers: shared.clock.timers });
    await other.ready();
    assert.equal(await other.unlock('shared passphrase'), 'unlocked');
    await other.setKey('groq', GROQ_KEY, { remember: true });
    await shared.store.setKey('anthropic', ANTHROPIC_KEY, { remember: true });
    shared.store.lock();
    await shared.store.unlock('shared passphrase');
    assert.equal(shared.store.getKey('groq'), GROQ_KEY);
    assert.equal(shared.store.getKey('anthropic'), ANTHROPIC_KEY);
  });

  it('forget all deletes the session keys and the vault', async () => {
    const { store, session, db } = await setup();
    await store.ready();
    await store.unlock('forget me please');
    await store.setKey('groq', GROQ_KEY, { remember: true });
    await store.setKey(ACCESS_SLOT, 'site-code');
    await store.forgetAll();
    assert.equal(store.vaultState(), 'none');
    assert.equal(session.map.size, 0);
    assert.equal(await db.get('keyvault', VAULT_RECORD_ID), undefined);
    assert.equal(store.getKey('groq'), '');
    assert.equal(store.getKey(ACCESS_SLOT), '');
  });

  it('is unavailable when the database ends with the page', async () => {
    const { store } = await setup({ factory: null });
    await store.ready();
    assert.equal(store.vaultState(), 'unavailable');
    assert.equal(await store.unlock('whatever passphrase'), 'unavailable');
    await assert.rejects(store.setKey('groq', GROQ_KEY, { remember: true }), (/** @type {any} */ err) => err.code === 'unavailable');
    await store.setKey('groq', GROQ_KEY);
    assert.equal(store.getKey('groq'), GROQ_KEY, 'session keys still work');
  });
});

describe('auto-lock', () => {
  it('locks after 30 minutes without activity, and activity postpones it', async () => {
    const { store, clock } = await setup();
    await store.ready();
    await store.unlock('idle passphrase');
    await store.setKey('groq', GROQ_KEY, { remember: true });
    /** @type {unknown[]} */
    const changes = [];
    store.onKeysChange((c) => changes.push(c));
    assert.equal(VAULT_IDLE_MS, 30 * 60_000);

    clock.advance(20 * 60_000);
    store.noteActivity();
    clock.advance(20 * 60_000);
    assert.equal(store.vaultState(), 'unlocked', '20 minutes after the last activity');
    assert.equal(store.getKey('groq'), GROQ_KEY);
    clock.advance(10 * 60_000);
    assert.equal(store.vaultState(), 'locked');
    assert.equal(store.getKey('groq'), '');
    assert.deepEqual(changes, [{ type: 'vault', state: 'locked', reason: 'idle' }]);
    assert.equal(clock.pending, 0, 'no timer left behind');
  });

  it('reading a key is not activity; lock now stops the timer', async () => {
    const { store, clock } = await setup();
    await store.ready();
    await store.unlock('idle passphrase');
    clock.advance(29 * 60_000);
    store.getKey('groq');
    clock.advance(60_000);
    assert.equal(store.vaultState(), 'locked');

    await store.unlock('idle passphrase');
    store.lock();
    assert.equal(clock.pending, 0);
  });
});
