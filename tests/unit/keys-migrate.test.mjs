// Plaintext keys of 2.x: "remembered" keys in localStorage move once into this tab's session
// storage, the plaintext copies and the switch disappear, and the vault hint is set. The default
// key store does it on first use; the app migration runner records it once.
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createKeyStore, migrateLegacyKeys, VAULT_HINT_KEY } from '../../src/js/ai/keys.js';
import { moveSecretToSession, readSecret, removeSecret, writeSecret } from '../../src/js/storage.js';
import { APP_MIGRATIONS, isMigrationDone, LEGACY_KEYS_MIGRATION_ID, legacyKeysMigration, runMigrations } from '../../src/js/store/migrate.js';
import { openAppDb } from '../../src/js/store/schema.js';

/** A Web Storage stand-in. */
class MemoryStorage {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map();
  }
  /** @param {string} key */
  getItem(key) {
    return this.map.has(key) ? /** @type {string} */ (this.map.get(key)) : null;
  }
  /** @param {string} key @param {string} value */
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  /** @param {string} key */
  removeItem(key) {
    this.map.delete(key);
  }
}

const GEMINI = 'AIzaSyA-legacy-key-0123456789abcdefghijk';
const OPENROUTER = 'sk-or-v1-0123456789abcdef0123456789abcdef';

/** @type {MemoryStorage} */
let local;
/** @type {MemoryStorage} */
let session;

beforeEach(() => {
  local = new MemoryStorage();
  session = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: session, configurable: true, writable: true });
});

afterEach(() => {
  delete (/** @type {any} */ (globalThis).localStorage);
  delete (/** @type {any} */ (globalThis).sessionStorage);
});

/** The 2.x state with "remember keys" ticked. */
function remembered() {
  local.setItem('starpi_gemini_key', GEMINI);
  local.setItem('starpi_openrouter_key', OPENROUTER);
  local.setItem('starpi_remember_keys', '1');
}

describe('secret helpers', () => {
  it('write to the session only, whatever the old remember flag says, and drop a plaintext copy', () => {
    local.setItem('starpi_gemini_key', 'old');
    assert.equal(writeSecret('starpi_gemini_key', 'new', true), true);
    assert.equal(local.getItem('starpi_gemini_key'), null);
    assert.equal(session.getItem('starpi_gemini_key'), 'new');
    assert.equal(readSecret('starpi_gemini_key'), 'new');
    removeSecret('starpi_gemini_key');
    assert.equal(readSecret('starpi_gemini_key'), '');
  });

  it('move a plaintext copy into the session; a session copy wins', () => {
    local.setItem('a', 'from-local');
    assert.equal(moveSecretToSession('a'), true);
    assert.equal(session.getItem('a'), 'from-local');
    assert.equal(local.getItem('a'), null);
    local.setItem('b', 'from-local');
    session.setItem('b', 'from-session');
    moveSecretToSession('b');
    assert.equal(session.getItem('b'), 'from-session');
    assert.equal(local.getItem('b'), null);
    assert.equal(moveSecretToSession('missing'), false);
  });
});

describe('migrateLegacyKeys', () => {
  it('moves remembered keys into the session, removes the plaintext and the switch, and sets the hint', () => {
    remembered();
    assert.deepEqual(migrateLegacyKeys(), { moved: ['gemini', 'openrouter'], rememberRemoved: true });
    assert.equal(local.getItem('starpi_gemini_key'), null);
    assert.equal(local.getItem('starpi_openrouter_key'), null);
    assert.equal(local.getItem('starpi_remember_keys'), null);
    assert.equal(session.getItem('starpi_gemini_key'), GEMINI);
    assert.equal(session.getItem('starpi_openrouter_key'), OPENROUTER);
    assert.equal(local.getItem(VAULT_HINT_KEY), '1');
    // Nothing of a key stays in localStorage.
    for (const value of local.map.values()) assert.ok(!value.includes(GEMINI) && !value.includes(OPENROUTER));
  });

  it('is safe to repeat and leaves session-only 2.x keys alone', () => {
    session.setItem('starpi_gemini_key', GEMINI);
    local.setItem('starpi_remember_keys', '0');
    assert.deepEqual(migrateLegacyKeys(), { moved: [], rememberRemoved: true });
    assert.deepEqual(migrateLegacyKeys(), { moved: [], rememberRemoved: false });
    assert.equal(session.getItem('starpi_gemini_key'), GEMINI);
    assert.equal(local.getItem(VAULT_HINT_KEY), null, 'no hint without a moved key');
  });

  it('runs on the first use of a key store with legacy storage', async () => {
    remembered();
    const db = await openAppDb({ name: 'keys-migrate-store', factory: new IDBFactory() });
    const store = createKeyStore({
      db: async () => db,
      legacy: { read: (k) => local.getItem(k), remove: (k) => local.removeItem(k), write: (k, v) => (local.setItem(k, v), true), move: moveSecretToSession },
    });
    assert.equal(store.getKey('gemini'), GEMINI);
    assert.equal(local.getItem('starpi_gemini_key'), null);
    await store.ready();
    assert.equal(store.vaultSuggested(), true);
    assert.equal(await store.unlock('a new passphrase'), 'created');
    assert.equal(store.vaultSuggested(), false);
    assert.equal(local.getItem(VAULT_HINT_KEY), null, 'creating the vault clears the hint');
    assert.equal(session.getItem('starpi_gemini_key'), null, 'the key moved on into the vault');
    assert.equal(store.keyLocation('gemini'), 'vault');
  });
});

describe('app migration', () => {
  it('is appended to the app migrations and recorded once, with provider names only', async () => {
    assert.deepEqual(
      APP_MIGRATIONS.map((m) => m.id),
      ['local-chats-v1', LEGACY_KEYS_MIGRATION_ID],
    );
    remembered();
    const db = await openAppDb({ name: 'keys-migrate-app', factory: new IDBFactory() });
    const [first] = await runMigrations(db, [legacyKeysMigration()]);
    assert.equal(first.status, 'done');
    assert.deepEqual(first.result, { moved: ['gemini', 'openrouter'], rememberRemoved: true });
    assert.equal(await isMigrationDone(db, LEGACY_KEYS_MIGRATION_ID), true);
    const marker = await db.get('settings', `migration:${LEGACY_KEYS_MIGRATION_ID}`);
    assert.equal(JSON.stringify(marker).includes(GEMINI), false);
    local.setItem('starpi_gemini_key', 'written-later');
    const [second] = await runMigrations(db, [legacyKeysMigration()]);
    assert.equal(second.status, 'skipped');
  });
});
