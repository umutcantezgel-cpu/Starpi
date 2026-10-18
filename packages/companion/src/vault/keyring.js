// @ts-check
// The keyring: one data key per vault namespace, each wrapped (AES-256-GCM) by the key-encryption
// key, in one small file of the data folder. Destroying a namespace's wrapped key is the
// crypto-erase: every sealed value of that namespace, wherever a copy of it lies (the database, its
// WAL, an old backup), can no longer be opened, because the one key that opens it is gone.
//
// A namespace created again after an erase gets a higher generation; the generation is part of
// what each sealed value is bound to, so a value of the erased generation never opens with the new
// key either.
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isoAt, systemClock } from '../lib/clock.js';
import { fromBase64url, toBase64url } from '../lib/canonical.js';
import { fail } from '../lib/errors.js';
import { ensurePrivateDir, readRegularFile, writeFileAtomic } from '../lib/fsx.js';
import { kekId, newKey, openBytes, sealBytes } from './crypto.js';

export const KEYRING_FORMAT = 'starpi-companion.keyring/1';

/** @typedef {{ gen: number, created: string, wrapped: string }} KeyEntry */
/** @typedef {{ format: string, kek: { provider: string, id: string }, keys: Record<string, KeyEntry>, erased: Record<string, { gen: number, at: string }> }} KeyringFile */

/** Size, change time and inode of a file, as one comparable text. @param {string} file */
function fileStamp(file) {
  try {
    const st = statSync(file, { bigint: true });
    return `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
  } catch {
    return 'missing';
  }
}

/** @param {string} ns @param {number} gen */
const wrapAad = (ns, gen) => `starpi-companion/dek/1\n${ns}\n${gen}`;

/**
 * Reads the keyring file; null when there is none.
 * @param {string} file
 * @returns {KeyringFile | null}
 */
export function readKeyringFile(file) {
  const raw = readRegularFile(file, 1024 * 1024);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw fail('keyring_invalid', 'the keyring file is not JSON');
  }
  if (parsed?.format !== KEYRING_FORMAT || typeof parsed.kek?.id !== 'string' || typeof parsed.keys !== 'object') throw fail('keyring_invalid', 'the keyring file has an unknown shape');
  parsed.erased ??= {};
  return parsed;
}

/**
 * Opens the keyring with the KEK, or creates an empty one for a new installation.
 * @param {object} options
 * @param {string} options.file
 * @param {Buffer} options.kek
 * @param {string} options.provider   name of the KEK provider (recorded, not trusted)
 * @param {import('../lib/clock.js').Clock} [options.clock]
 */
export function openKeyring({ file, kek, provider, clock = systemClock }) {
  const id = kekId(kek);
  let current = readKeyringFile(file);
  if (current === null) {
    current = { format: KEYRING_FORMAT, kek: { provider, id }, keys: {}, erased: {} };
    ensurePrivateDir(dirname(file));
    writeFileAtomic(file, `${JSON.stringify(current, null, 2)}\n`);
  } else if (current.kek.id !== id) {
    throw fail('kek_mismatch', `the key-encryption key does not belong to this vault (expected ${current.kek.id}, got ${id})`);
  }
  /** @type {Map<string, Buffer>} */
  const cache = new Map();
  let stamp = fileStamp(file);

  /**
   * Reads the file again when another process (a command-line tool next to the running service)
   * changed it, so an erase there is never undone here. Keys that vanished leave the cache.
   */
  function refresh() {
    const now = fileStamp(file);
    if (now === stamp) return;
    const next = readKeyringFile(file);
    if (next === null) throw fail('keyring_missing', 'the keyring file disappeared');
    if (next.kek.id !== id) throw fail('kek_mismatch', 'the keyring was re-wrapped by another process');
    current = next;
    stamp = now;
    for (const ns of [...cache.keys()]) if (!current.keys[ns]) cache.delete(ns);
  }

  const save = () => {
    writeFileAtomic(file, `${JSON.stringify(current, null, 2)}\n`);
    stamp = fileStamp(file);
  };

  /**
   * The data key and generation of a namespace; created on first use.
   * @param {string} ns
   * @returns {{ key: Buffer, gen: number }}
   */
  function dataKey(ns) {
    refresh();
    const state = /** @type {KeyringFile} */ (current);
    const entry = state.keys[ns];
    if (entry) {
      let key = cache.get(ns);
      if (!key) {
        const wrapped = fromBase64url(entry.wrapped);
        if (!wrapped) throw fail('keyring_invalid', `the wrapped key of ${ns} is not base64url`);
        key = openBytes(kek, wrapped, wrapAad(ns, entry.gen));
        cache.set(ns, key);
      }
      return { key, gen: entry.gen };
    }
    const gen = (state.erased[ns]?.gen ?? 0) + 1;
    const key = newKey();
    state.keys[ns] = { gen, created: isoAt(clock.now()), wrapped: toBase64url(sealBytes(kek, key, wrapAad(ns, gen))) };
    save();
    cache.set(ns, key);
    return { key, gen };
  }

  return {
    kekId: id,
    provider: current.kek.provider,
    dataKey,
    /** The key of a namespace and generation if it still exists, else null. @param {string} ns @param {number} gen */
    keyFor(ns, gen) {
      refresh();
      const entry = /** @type {KeyringFile} */ (current).keys[ns];
      if (!entry || entry.gen !== gen) return null;
      return dataKey(ns).key;
    },
    /** @param {string} ns */
    has: (ns) => {
      refresh();
      return /** @type {KeyringFile} */ (current).keys[ns] !== undefined;
    },
    /** The generation of a namespace's live key, or null. @param {string} ns */
    generation: (ns) => {
      refresh();
      return /** @type {KeyringFile} */ (current).keys[ns]?.gen ?? null;
    },
    namespaces: () => {
      refresh();
      return Object.keys(/** @type {KeyringFile} */ (current).keys).sort();
    },
    /**
     * Destroys the key of a namespace (the crypto-erase). Durable when it returns.
     * @param {string} ns
     * @returns {number | null} the generation erased, null when the namespace had no key
     */
    erase(ns) {
      refresh();
      const state = /** @type {KeyringFile} */ (current);
      const entry = state.keys[ns];
      if (!entry) return null;
      delete state.keys[ns];
      state.erased[ns] = { gen: entry.gen, at: isoAt(clock.now()) };
      cache.delete(ns);
      save();
      return entry.gen;
    },
    /**
     * Records an erase that happened elsewhere (a restore of an older copy): the next key of the
     * namespace gets a higher generation.
     * @param {string} ns
     * @param {number} gen
     * @param {string} at
     */
    noteErased(ns, gen, at) {
      refresh();
      const state = /** @type {KeyringFile} */ (current);
      if ((state.erased[ns]?.gen ?? 0) >= gen) return;
      state.erased[ns] = { gen, at };
      save();
    },
    /**
     * Wraps every key again under a new KEK (a change of provider or a rotated KEK).
     * @param {Buffer} nextKek
     * @param {string} nextProvider
     */
    rewrap(nextKek, nextProvider) {
      refresh();
      const state = /** @type {KeyringFile} */ (current);
      for (const [ns, entry] of Object.entries(state.keys)) {
        const key = dataKey(ns).key;
        entry.wrapped = toBase64url(sealBytes(nextKek, key, wrapAad(ns, entry.gen)));
      }
      state.kek = { provider: nextProvider, id: kekId(nextKek) };
      save();
    },
  };
}

/** @typedef {ReturnType<typeof openKeyring>} Keyring */
