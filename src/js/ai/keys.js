// @ts-check
// Provider keys in the browser. A key lives in one of two places:
//
// - this tab's session storage (the default): gone when the tab closes;
// - the optional key vault: one record in the app database's `keyvault` store holding every vault
//   key as AES-GCM-256 ciphertext. The AES key is derived from the user's passphrase with
//   PBKDF2-SHA-256 (600 000 iterations, 16-byte random salt) as a non-extractable CryptoKey that
//   lives in memory only. Unlocking derives it again; locking (by hand, or after 30 minutes without
//   user activity) drops it and the decrypted keys.
//
// Keys are never written in plaintext outside session storage, never exported or synced and never
// put into receipts or logs. 2.x kept "remembered" keys in plaintext in localStorage; they move to
// session storage once (migrateLegacyKeys), and the view then suggests setting a vault passphrase.
//
// Besides the model providers, the store has slots for the services the voice and research
// features call (they share the relay) and for the access code of a site that asks for one.
//
// The module's functions use one shared store; createKeyStore() builds another with injected
// storage, database, clock and timers (tests, workers).
import { STORAGE_KEYS } from '../config.js';
import { moveSecretToSession, readLocal, readSecret, removeLocal, removeSecret, writeLocal, writeSecret } from '../storage.js';
import { appDb } from '../store/schema.js';
import { PROVIDER_ORDER, PROVIDERS } from './catalog/providers.js';

/** @typedef {import('../store/idb.js').StoreDb} StoreDb */
/** @typedef {import('../store/schema.js').KeyVaultRecord} KeyVaultRecord */

/**
 * none: no vault yet; locked: a vault exists and its keys are not in memory; unlocked: its keys
 * are in memory until lock(); unavailable: this browser cannot keep a vault (no WebCrypto, or a
 * database that ends with the page).
 * @typedef {'none' | 'locked' | 'unlocked' | 'unavailable'} VaultState
 */

/** @typedef {'created' | 'unlocked' | 'wrong' | 'too_short' | 'unavailable'} UnlockResult */
/** @typedef {'session' | 'vault'} KeyLocation */
/** @typedef {{ type: 'key', slot: string } | { type: 'vault', state: VaultState, reason?: 'idle' | 'manual' | 'forgotten' | 'changed' }} KeysChange */

/**
 * invalid_slot / invalid_key: not a known slot, or not a usable key (printable ASCII without
 * spaces); locked: the vault must be unlocked first; unavailable: no vault in this browser;
 * storage: the browser refused to store it.
 * @typedef {'invalid_slot' | 'invalid_key' | 'locked' | 'unavailable' | 'storage'} KeyStoreErrorCode
 */

/**
 * @typedef {object} SecretArea  where session keys live (default: sessionStorage through storage.js)
 * @property {(name: string) => string} read
 * @property {(name: string, value: string) => boolean} write
 * @property {(name: string) => void} remove
 */

/**
 * @typedef {object} LegacyStorage  where 2.x kept plaintext keys (default: localStorage)
 * @property {(name: string) => string | null} read
 * @property {(name: string) => void} remove
 * @property {(name: string, value: string) => boolean} write
 * @property {(name: string) => boolean} move  moves a plaintext key into the session
 */

/**
 * @typedef {object} Timers
 * @property {(fn: () => void, ms: number) => unknown} set
 * @property {(handle: unknown) => void} clear
 */

/**
 * @typedef {object} KeyStoreOptions
 * @property {() => Promise<StoreDb>} [db]   the app database (default: the shared connection)
 * @property {SecretArea} [session]
 * @property {LegacyStorage} [legacy]         runs migrateLegacyKeys on first use when given (the default store always does)
 * @property {() => number} [now]
 * @property {Timers} [timers]
 * @property {number} [idleMs]                auto-lock after this long without activity
 * @property {number} [iterations]            PBKDF2 iterations of a new vault
 * @property {Crypto} [crypto]
 */

export class KeyStoreError extends Error {
  /** @param {KeyStoreErrorCode} code */
  constructor(code) {
    super(code);
    this.name = 'KeyStoreError';
    /** @type {KeyStoreErrorCode} */
    this.code = code;
  }
}

/** Services the voice and research features reach through the relay. */
export const SERVICE_SLOTS = Object.freeze(['elevenlabs', 'brave', 'tavily']);
/** The access code a site may ask for (sent as a header to the site's own endpoints). */
export const ACCESS_SLOT = 'access';

/** Every slot: providers that take a key (a local server's key is optional), services, the access code. */
export const KEY_SLOTS = Object.freeze([...PROVIDER_ORDER.filter((id) => PROVIDERS[id].auth !== 'none'), ...SERVICE_SLOTS, ACCESS_SLOT]);

export const VAULT_RECORD_ID = 'vault';
export const VAULT_ITERATIONS = 600_000;
export const VAULT_SALT_BYTES = 16;
export const VAULT_IV_BYTES = 12;
export const VAULT_IDLE_MS = 30 * 60_000;
export const MIN_PASSPHRASE_CHARS = 8;
/** localStorage flag (no secret): legacy keys were moved, so the view suggests a vault passphrase. */
export const VAULT_HINT_KEY = 'starpi_vault_hint';

/** 2.x session and localStorage names; these two providers keep them, so older readers still find a session key. */
export const LEGACY_KEY_NAMES = Object.freeze({ gemini: STORAGE_KEYS.geminiKey, openrouter: STORAGE_KEYS.openrouterKey });

/** Printable ASCII without spaces: anything else would break or inject a header. */
const KEY_PATTERN = /^[\x21-\x7e]{1,1024}$/;
/** An access code is chosen by the site's operator: printable ASCII, inner spaces allowed. */
const ACCESS_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;
const ENCODER = new TextEncoder();
/** Binds the ciphertext to its purpose and format version. */
const AAD = ENCODER.encode('starpi-keyvault/v1');
/** Highest PBKDF2 iteration count accepted from a stored record. */
const MAX_ITERATIONS = 10_000_000;

/**
 * @param {unknown} slot
 * @returns {slot is string}
 */
export function isKeySlot(slot) {
  return typeof slot === 'string' && KEY_SLOTS.includes(slot);
}

/**
 * The session storage name of a slot.
 * @param {string} slot
 */
export function sessionName(slot) {
  return Object.hasOwn(LEGACY_KEY_NAMES, slot) ? LEGACY_KEY_NAMES[/** @type {keyof typeof LEGACY_KEY_NAMES} */ (slot)] : `starpi_key_${slot}`;
}

/**
 * A key as stored: trimmed; null when it is not usable as a header value.
 * @param {unknown} key
 * @param {string} [slot]  the access code may contain inner spaces
 * @returns {string | null}
 */
export function cleanKey(key, slot) {
  const value = typeof key === 'string' ? key.trim() : '';
  return (slot === ACCESS_SLOT ? ACCESS_PATTERN : KEY_PATTERN).test(value) ? value : null;
}

/**
 * @typedef {{ moved: string[], rememberRemoved: boolean }} LegacyKeysResult
 */

/** @type {LegacyStorage} */
const LOCAL_LEGACY = { read: readLocal, remove: removeLocal, write: writeLocal, move: moveSecretToSession };

/**
 * Moves the plaintext keys 2.x remembered in localStorage into this tab's session storage, removes
 * them and the "remember keys" switch, and sets the vault hint when a key moved. Safe to repeat.
 * @param {Partial<LegacyStorage>} [storage]
 * @returns {LegacyKeysResult} the slots that moved (names only)
 */
export function migrateLegacyKeys(storage = {}) {
  const io = { ...LOCAL_LEGACY, ...storage };
  /** @type {string[]} */
  const moved = [];
  for (const [slot, name] of Object.entries(LEGACY_KEY_NAMES)) {
    const plain = io.read(name);
    if (plain === null) continue;
    io.move(name);
    if (plain.trim()) moved.push(slot);
  }
  const rememberRemoved = io.read(STORAGE_KEYS.rememberKeys) !== null;
  if (rememberRemoved) io.remove(STORAGE_KEYS.rememberKeys);
  if (moved.length > 0) io.write(VAULT_HINT_KEY, '1');
  return { moved, rememberRemoved };
}

/**
 * @param {Uint8Array | undefined} a
 * @param {Uint8Array | undefined} b
 */
function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {unknown} record
 * @returns {record is KeyVaultRecord}
 */
function isVaultRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const r = /** @type {Record<string, any>} */ (record);
  const iterations = r.kdf?.iterations;
  return (
    r.v === 1 &&
    r.kdf?.name === 'PBKDF2' &&
    r.kdf?.hash === 'SHA-256' &&
    Number.isInteger(iterations) &&
    iterations > 0 &&
    iterations <= MAX_ITERATIONS &&
    r.salt instanceof Uint8Array &&
    r.iv instanceof Uint8Array &&
    r.ct instanceof Uint8Array
  );
}

/**
 * Builds a key store.
 * @param {KeyStoreOptions} [options]
 */
export function createKeyStore(options = {}) {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? VAULT_IDLE_MS;
  const iterations = options.iterations ?? VAULT_ITERATIONS;
  const cryptoImpl = options.crypto ?? globalThis.crypto;
  const getDb = options.db ?? appDb;
  /** @type {SecretArea} */
  const session = options.session ?? { read: readSecret, write: writeSecret, remove: removeSecret };
  /** @type {Timers} */
  const timers = options.timers ?? {
    set(fn, ms) {
      const handle = setTimeout(fn, ms);
      // Node keeps running for a pending timer; a browser has no unref.
      /** @type {{ unref?: () => void }} */ (/** @type {unknown} */ (handle)).unref?.();
      return handle;
    },
    clear: (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
  };

  /** @type {VaultState} */
  let state = 'none';
  /** @type {KeyVaultRecord | null} */
  let record = null;
  /** @type {CryptoKey | null} */
  let aesKey = null;
  /** @type {Map<string, string> | null} */
  let vaultKeys = null;
  let lastActivity = now();
  /** @type {unknown} */
  let timer = null;
  let migrated = !options.legacy;
  /** @type {Promise<void> | null} */
  let loading = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {Set<(change: KeysChange) => void>} */
  const listeners = new Set();

  /** @param {KeysChange} change */
  const notify = (change) => {
    for (const fn of listeners) {
      try {
        fn(change);
      } catch {
        // one listener must not stop the others
      }
    }
  };

  const ensureMigrated = () => {
    if (migrated || !options.legacy) return;
    migrated = true;
    migrateLegacyKeys(options.legacy);
  };

  /**
   * Runs vault work one call at a time.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const subtle = () => cryptoImpl?.subtle ?? null;

  /** @returns {Promise<StoreDb | null>} */
  const database = async () => {
    try {
      const db = await getDb();
      return db.persistent ? db : null;
    } catch {
      return null;
    }
  };

  /** Reads whether a vault exists. Runs once; later calls share it. */
  const load = () => {
    loading ??= (async () => {
      const db = subtle() ? await database() : null;
      if (!db) {
        state = 'unavailable';
        return;
      }
      try {
        const found = await db.get('keyvault', VAULT_RECORD_ID);
        record = isVaultRecord(found) ? found : null;
      } catch {
        record = null;
      }
      if (state !== 'unlocked') state = record ? 'locked' : 'none';
    })();
    return loading;
  };

  /**
   * @param {string} passphrase
   * @param {Uint8Array} salt
   * @param {number} rounds
   */
  const deriveKey = async (passphrase, salt, rounds) => {
    const api = /** @type {SubtleCrypto} */ (subtle());
    const base = await api.importKey('raw', ENCODER.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return api.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: /** @type {BufferSource} */ (salt), iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  };

  /**
   * @param {CryptoKey} key
   * @param {KeyVaultRecord} rec
   * @returns {Promise<Map<string, string> | null>} null when the key does not open the record
   */
  const decrypt = async (key, rec) => {
    try {
      const plain = await /** @type {SubtleCrypto} */ (subtle()).decrypt({ name: 'AES-GCM', iv: /** @type {BufferSource} */ (rec.iv), additionalData: AAD }, key, /** @type {BufferSource} */ (rec.ct));
      const data = JSON.parse(new TextDecoder().decode(plain));
      /** @type {Map<string, string>} */
      const keys = new Map();
      for (const [slot, value] of Object.entries(data?.keys ?? {})) {
        const clean = cleanKey(value, slot);
        if (isKeySlot(slot) && clean) keys.set(slot, clean);
      }
      return keys;
    } catch {
      return null;
    }
  };

  /**
   * Encrypts a key map into a new record (fresh IV) under the current salt and settings.
   * @param {CryptoKey} key
   * @param {Map<string, string>} keys
   * @param {{ salt: Uint8Array, kdf: KeyVaultRecord['kdf'] }} params
   * @returns {Promise<KeyVaultRecord>}
   */
  const encrypt = async (key, keys, params) => {
    const iv = cryptoImpl.getRandomValues(new Uint8Array(VAULT_IV_BYTES));
    const plain = ENCODER.encode(JSON.stringify({ keys: Object.fromEntries(keys) }));
    const ct = new Uint8Array(await /** @type {SubtleCrypto} */ (subtle()).encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plain));
    return { id: VAULT_RECORD_ID, v: 1, kdf: params.kdf, salt: params.salt, iv, ct, updatedAt: now() };
  };

  const clearTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  const schedule = () => {
    clearTimer();
    if (state !== 'unlocked') return;
    timer = timers.set(checkIdle, Math.max(0, lastActivity + idleMs - now()));
  };

  function checkIdle() {
    timer = null;
    if (state !== 'unlocked') return;
    if (now() - lastActivity >= idleMs) drop('locked', 'idle');
    else schedule();
  }

  /**
   * Forgets the AES key and the decrypted keys.
   * @param {VaultState} next
   * @param {'idle' | 'manual' | 'forgotten' | 'changed'} reason
   */
  function drop(next, reason) {
    clearTimer();
    aesKey = null;
    vaultKeys = null;
    state = next;
    notify({ type: 'vault', state: next, reason });
  }

  const touch = () => {
    lastActivity = now();
    if (state === 'unlocked') schedule();
  };

  /**
   * Changes the vault's keys: reads the stored record first, so a change another tab made in the
   * meantime is kept, then writes the result under a fresh IV.
   * @param {(keys: Map<string, string>) => void} change
   */
  const mutateVault = async (change) => {
    const db = await database();
    if (!db) throw new KeyStoreError('unavailable');
    if (state !== 'unlocked' || !aesKey || !vaultKeys || !record) throw new KeyStoreError('locked');
    let base = vaultKeys;
    let stored;
    try {
      stored = await db.get('keyvault', VAULT_RECORD_ID);
    } catch {
      throw new KeyStoreError('storage');
    }
    if (!isVaultRecord(stored)) {
      // Forgotten in another tab.
      record = null;
      drop('none', 'forgotten');
      throw new KeyStoreError('locked');
    }
    if (!sameBytes(stored.iv, record.iv)) {
      const fresh = sameBytes(stored.salt, record.salt) && stored.kdf.iterations === record.kdf.iterations ? await decrypt(aesKey, stored) : null;
      if (!fresh) {
        // Replaced by a vault with another passphrase.
        record = stored;
        drop('locked', 'changed');
        throw new KeyStoreError('locked');
      }
      base = fresh;
    }
    const next = new Map(base);
    change(next);
    const written = await encrypt(aesKey, next, { salt: record.salt, kdf: record.kdf });
    try {
      await db.put('keyvault', written);
    } catch {
      throw new KeyStoreError('storage');
    }
    record = written;
    vaultKeys = next;
  };

  /** @param {string} slot */
  const assertSlot = (slot) => {
    if (!isKeySlot(slot)) throw new KeyStoreError('invalid_slot');
  };

  const store = {
    /** Resolves once the store knows whether a vault exists. */
    ready() {
      ensureMigrated();
      return load();
    },

    /**
     * The key of a slot: this tab's copy first, then the unlocked vault; '' when there is none.
     * @param {string} slot
     * @returns {string}
     */
    getKey(slot) {
      if (!isKeySlot(slot)) return '';
      ensureMigrated();
      const own = cleanKey(session.read(sessionName(slot)), slot);
      if (own) return own;
      return vaultKeys?.get(slot) ?? '';
    },

    /**
     * @param {string} slot
     * @returns {boolean}
     */
    hasKey(slot) {
      return store.getKey(slot) !== '';
    },

    /**
     * Where a slot's key is kept; null when it has none (or it sits in a locked vault).
     * @param {string} slot
     * @returns {KeyLocation | null}
     */
    keyLocation(slot) {
      if (!isKeySlot(slot)) return null;
      ensureMigrated();
      if (cleanKey(session.read(sessionName(slot)), slot)) return 'session';
      return vaultKeys?.has(slot) ? 'vault' : null;
    },

    /**
     * Stores a key: for this tab, or with `remember` in the vault (which must be unlocked). Either
     * way the other place no longer holds a copy, except a vault that is locked.
     * @param {string} slot
     * @param {string} key
     * @param {{ remember?: boolean }} [opts]
     * @returns {Promise<void>}
     */
    setKey(slot, key, opts = {}) {
      assertSlot(slot);
      const value = cleanKey(key, slot);
      if (!value) return Promise.reject(new KeyStoreError('invalid_key'));
      ensureMigrated();
      return serial(async () => {
        await load();
        if (opts.remember) {
          if (state === 'unavailable') throw new KeyStoreError('unavailable');
          await mutateVault((keys) => void keys.set(slot, value));
          session.remove(sessionName(slot));
        } else {
          if (!session.write(sessionName(slot), value)) throw new KeyStoreError('storage');
          if (vaultKeys?.has(slot)) await mutateVault((keys) => void keys.delete(slot));
        }
        touch();
        notify({ type: 'key', slot });
      });
    },

    /**
     * Removes a slot's key from this tab and from the vault when it is unlocked.
     * @param {string} slot
     * @returns {Promise<void>}
     */
    removeKey(slot) {
      assertSlot(slot);
      ensureMigrated();
      return serial(async () => {
        session.remove(sessionName(slot));
        if (vaultKeys?.has(slot)) await mutateVault((keys) => void keys.delete(slot));
        touch();
        notify({ type: 'key', slot });
      });
    },

    /** @returns {VaultState} */
    vaultState() {
      return state;
    },

    /**
     * Opens the vault with its passphrase. Without a vault this creates one with the passphrase
     * and moves every key of this tab into it.
     * @param {string} passphrase
     * @returns {Promise<UnlockResult>}
     */
    unlock(passphrase) {
      ensureMigrated();
      return serial(async () => {
        await load();
        if (state === 'unavailable') return 'unavailable';
        if (state === 'unlocked') {
          touch();
          return 'unlocked';
        }
        const pass = typeof passphrase === 'string' ? passphrase : '';
        if (state === 'none') {
          if (Array.from(pass).length < MIN_PASSPHRASE_CHARS) return 'too_short';
          const db = await database();
          if (!db) return 'unavailable';
          const salt = cryptoImpl.getRandomValues(new Uint8Array(VAULT_SALT_BYTES));
          const kdf = /** @type {KeyVaultRecord['kdf']} */ ({ name: 'PBKDF2', hash: 'SHA-256', iterations });
          const key = await deriveKey(pass, salt, iterations);
          /** @type {Map<string, string>} */
          const keys = new Map();
          for (const slot of KEY_SLOTS) {
            const own = cleanKey(session.read(sessionName(slot)), slot);
            if (own) keys.set(slot, own);
          }
          const written = await encrypt(key, keys, { salt, kdf });
          try {
            await db.put('keyvault', written);
          } catch {
            throw new KeyStoreError('storage');
          }
          for (const slot of keys.keys()) session.remove(sessionName(slot));
          record = written;
          aesKey = key;
          vaultKeys = keys;
          state = 'unlocked';
          options.legacy?.remove(VAULT_HINT_KEY);
          touch();
          notify({ type: 'vault', state });
          return 'created';
        }
        // Locked: read the record again, another tab may have replaced it.
        const db = await database();
        if (!db) return 'unavailable';
        const stored = await db.get('keyvault', VAULT_RECORD_ID).catch(() => null);
        if (!isVaultRecord(stored)) {
          record = null;
          state = 'none';
          notify({ type: 'vault', state, reason: 'forgotten' });
          return 'wrong';
        }
        const key = await deriveKey(pass, stored.salt, stored.kdf.iterations);
        const keys = await decrypt(key, stored);
        if (!keys) return 'wrong';
        record = stored;
        aesKey = key;
        vaultKeys = keys;
        state = 'unlocked';
        touch();
        notify({ type: 'vault', state });
        return 'unlocked';
      });
    },

    /** Locks the vault now ("Lock now"): its keys leave memory until the next unlock. */
    lock() {
      if (state === 'unlocked') drop('locked', 'manual');
    },

    /**
     * Deletes every key: this tab's copies and the whole vault ("Forget all keys").
     * @returns {Promise<void>}
     */
    forgetAll() {
      ensureMigrated();
      return serial(async () => {
        for (const slot of KEY_SLOTS) session.remove(sessionName(slot));
        await load();
        if (state !== 'unavailable') {
          const db = await database();
          try {
            await db?.delete('keyvault', VAULT_RECORD_ID);
          } catch {
            throw new KeyStoreError('storage');
          }
          record = null;
          drop('none', 'forgotten');
        }
        options.legacy?.remove(VAULT_HINT_KEY);
        for (const slot of KEY_SLOTS) notify({ type: 'key', slot });
      });
    },

    /** Counts as user activity for the auto-lock (the view reports clicks and key presses). */
    noteActivity() {
      lastActivity = now();
      if (state === 'unlocked' && timer === null) schedule();
    },

    /** Whether the view should suggest a vault passphrase (keys were moved out of plaintext). */
    vaultSuggested() {
      ensureMigrated();
      return state === 'none' && options.legacy?.read(VAULT_HINT_KEY) === '1';
    },

    dismissVaultSuggestion() {
      options.legacy?.remove(VAULT_HINT_KEY);
    },

    /**
     * @param {(change: KeysChange) => void} fn
     * @returns {() => void} unsubscribe
     */
    onKeysChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return store;
}

/** @typedef {ReturnType<typeof createKeyStore>} KeyStore */

/** The store this page shares. Plaintext 2.x keys move to the session on its first use. */
export const keyStore = createKeyStore({ legacy: LOCAL_LEGACY });

/** @param {string} slot */
export const getKey = (slot) => keyStore.getKey(slot);
/** @param {string} slot @param {string} key @param {{ remember?: boolean }} [opts] */
export const setKey = (slot, key, opts) => keyStore.setKey(slot, key, opts);
/** @param {string} slot */
export const removeKey = (slot) => keyStore.removeKey(slot);
/** @param {string} slot */
export const hasKey = (slot) => keyStore.hasKey(slot);
/** @param {string} slot */
export const keyLocation = (slot) => keyStore.keyLocation(slot);
export const vaultState = () => keyStore.vaultState();
/** @param {string} passphrase */
export const unlock = (passphrase) => keyStore.unlock(passphrase);
export const lock = () => keyStore.lock();
export const forgetAllKeys = () => keyStore.forgetAll();
export const keysReady = () => keyStore.ready();
export const noteActivity = () => keyStore.noteActivity();
/** @param {(change: KeysChange) => void} fn */
export const onKeysChange = (fn) => keyStore.onKeysChange(fn);
