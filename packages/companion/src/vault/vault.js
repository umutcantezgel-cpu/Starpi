// @ts-check
// The vault: everything the companion keeps about its user, sealed at rest. Each namespace (notes,
// chats, secrets, documents, a module's own data) has its own data key from the keyring; values are
// rows of the store's `vault_items` table and larger blobs are files below the data folder, both
// sealed with AES-256-GCM and bound to their namespace, id and key generation.
//
// Deleting an item removes its row (and blob) and writes a line to the deletion list; erasing a
// namespace destroys its key first (crypto-erase), then removes its rows and blobs. The kernel's own
// namespaces (the identity key, sealed event bodies) are not erased one by one, only with the whole
// vault.
import { createHash } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NAMESPACE } from '../contracts/module.js';
import { fromBase64url, toBase64url } from '../lib/canonical.js';
import { isoAt, systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';
import { ensurePrivateDir, readRegularFile, removeFile, writeFileAtomic } from '../lib/fsx.js';
import { openBytes, sealBytes } from './crypto.js';
import { ITEM_ID } from './deletions.js';

/** Namespaces of the kernel itself. */
export const KERNEL_NAMESPACES = Object.freeze(['identity', 'events', 'secrets']);
/** Namespaces the kernel only erases together with the whole vault. */
const PROTECTED = new Set(['identity', 'events']);
/** Largest value kept as a row; larger data goes to a blob. */
export const MAX_ITEM_BYTES = 1024 * 1024;
/** Largest blob. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_items (
  ns TEXT NOT NULL,
  id TEXT NOT NULL,
  gen INTEGER NOT NULL,
  sealed BLOB NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (ns, id)
);
CREATE TABLE IF NOT EXISTS vault_blobs (
  ns TEXT NOT NULL,
  id TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (ns, id)
);
`;

/** @param {string} ns */
function assertNamespace(ns) {
  if (!NAMESPACE.test(ns)) throw fail('vault_namespace', `${JSON.stringify(ns)} is not a namespace name`, { status: 400 });
}

/** @param {string} id */
function assertId(id) {
  if (typeof id !== 'string' || !ITEM_ID.test(id)) throw fail('vault_item_id', 'an item id is 1 to 128 letters, digits or ._:-', { status: 400 });
}

/** @param {string | Uint8Array} data */
const toBytes = (data) => (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength));

/**
 * @param {object} options
 * @param {import('../store/sqlite.js').Store} options.store
 * @param {import('./keyring.js').Keyring} options.keyring
 * @param {import('./deletions.js').DeletionList} options.deletions
 * @param {string} options.blobDir
 * @param {import('../lib/clock.js').Clock} [options.clock]
 */
export function createVault({ store, keyring, deletions, blobDir, clock = systemClock }) {
  const { db } = store;
  db.exec(SCHEMA);
  const putRow = db.prepare(`INSERT INTO vault_items (ns, id, gen, sealed, updated) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (ns, id) DO UPDATE SET gen = excluded.gen, sealed = excluded.sealed, updated = excluded.updated`);
  const getRow = db.prepare('SELECT gen, sealed, updated FROM vault_items WHERE ns = ? AND id = ?');
  const deleteRow = db.prepare('DELETE FROM vault_items WHERE ns = ? AND id = ?');
  const deleteNs = db.prepare('DELETE FROM vault_items WHERE ns = ?');
  const listRows = db.prepare('SELECT id, updated, length(sealed) AS bytes FROM vault_items WHERE ns = ? ORDER BY id');
  const countRows = db.prepare('SELECT ns, COUNT(*) AS n FROM vault_items GROUP BY ns');
  const putBlobRow = db.prepare('INSERT INTO vault_blobs (ns, id, updated) VALUES (?, ?, ?) ON CONFLICT (ns, id) DO UPDATE SET updated = excluded.updated');
  const deleteBlobRow = db.prepare('DELETE FROM vault_blobs WHERE ns = ? AND id = ?');
  const listBlobRows = db.prepare('SELECT id, updated FROM vault_blobs WHERE ns = ? ORDER BY id');

  /** @param {string} ns @param {string} id */
  const blobFile = (ns, id) => join(blobDir, ns, `${createHash('sha256').update(id).digest('hex')}.sealed`);

  /**
   * One namespace.
   * @param {string} ns
   */
  function namespace(ns) {
    assertNamespace(ns);
    /** @param {string} id @param {number} gen */
    const aad = (id, gen) => `vault:${ns}:${id}:${gen}`;
    /** @param {string} id @param {number} gen */
    const blobAad = (id, gen) => `blob:${ns}:${id}:${gen}`;

    /** @param {string} id @returns {Buffer | null} */
    function get(id) {
      assertId(id);
      const row = /** @type {{ gen: number, sealed: Uint8Array } | undefined} */ (getRow.get(ns, id));
      if (!row) return null;
      const key = keyring.keyFor(ns, Number(row.gen));
      if (!key) throw fail('vault_erased', `${ns}/${id} belongs to an erased key`);
      return openBytes(key, row.sealed, aad(id, Number(row.gen)));
    }

    return {
      name: ns,
      /**
       * Seals and stores a value.
       * @param {string} id
       * @param {string | Uint8Array} data
       */
      put(id, data) {
        assertId(id);
        const bytes = toBytes(data);
        if (bytes.length > MAX_ITEM_BYTES) throw fail('vault_too_large', `a vault item holds at most ${MAX_ITEM_BYTES} bytes; use a blob`, { status: 413 });
        const { key, gen } = keyring.dataKey(ns);
        const updated = isoAt(clock.now());
        putRow.run(ns, id, gen, sealBytes(key, bytes, aad(id, gen)), updated);
        return { id, updated };
      },
      get,
      /** @param {string} id */
      getText: (id) => get(id)?.toString('utf8') ?? null,
      /** @param {string} id @param {unknown} value */
      putJson(id, value) {
        return this.put(id, JSON.stringify(value));
      },
      /** @param {string} id @returns {unknown} */
      getJson(id) {
        const text = get(id)?.toString('utf8');
        return text === undefined ? null : JSON.parse(text);
      },
      /** @param {string} id */
      has: (id) => getRow.get(ns, id) !== undefined,
      /**
       * Deletes an item (row and blob) and records the deletion.
       * @param {string} id
       */
      delete(id) {
        assertId(id);
        const removedRow = Number(deleteRow.run(ns, id).changes) > 0;
        deleteBlobRow.run(ns, id);
        const removedBlob = removeFile(blobFile(ns, id));
        if (removedRow || removedBlob) deletions.append(ns, id, isoAt(clock.now()));
        return removedRow || removedBlob;
      },
      /** Ids with their times and sealed sizes (no content). */
      list: () => /** @type {Array<{ id: string, updated: string, bytes: number }>} */ (listRows.all(ns)).map((r) => ({ id: r.id, updated: r.updated, bytes: Number(r.bytes) })),
      /**
       * Seals and stores a blob file.
       * @param {string} id
       * @param {Uint8Array} data
       */
      putBlob(id, data) {
        assertId(id);
        if (data.length > MAX_BLOB_BYTES) throw fail('vault_too_large', `a blob holds at most ${MAX_BLOB_BYTES} bytes`, { status: 413 });
        const { key, gen } = keyring.dataKey(ns);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(gen);
        ensurePrivateDir(join(blobDir, ns));
        writeFileAtomic(blobFile(ns, id), Buffer.concat([header, sealBytes(key, data, blobAad(id, gen))]));
        putBlobRow.run(ns, id, isoAt(clock.now()));
      },
      /** Blob ids with their times (no content). */
      listBlobs: () => /** @type {Array<{ id: string, updated: string }>} */ (listBlobRows.all(ns)).map((r) => ({ id: r.id, updated: r.updated })),
      /** @param {string} id @returns {Buffer | null} */
      getBlob(id) {
        assertId(id);
        const raw = readRegularFile(blobFile(ns, id), MAX_BLOB_BYTES + 64);
        if (raw === null) return null;
        if (raw.length < 4) throw fail('vault_unreadable', `the blob ${ns}/${id} is cut short`);
        const gen = raw.readUInt32BE(0);
        const key = keyring.keyFor(ns, gen);
        if (!key) throw fail('vault_erased', `${ns}/${id} belongs to an erased key`);
        return openBytes(key, raw.subarray(4), blobAad(id, gen));
      },
    };
  }

  /** @param {string} ns */
  const codec = (ns) => namespaceCodec(keyring, ns);

  /** True when a blob file exists and was last written at or before `at`. @param {string} file @param {string} at */
  function blobWrittenBy(file, at) {
    try {
      return statSync(file).mtimeMs <= Date.parse(at);
    } catch {
      return false;
    }
  }

  /** @param {string} ns */
  function dropContent(ns) {
    const items = Number(deleteNs.run(ns).changes);
    db.prepare('DELETE FROM vault_blobs WHERE ns = ?').run(ns);
    rmSync(join(blobDir, ns), { recursive: true, force: true });
    return items;
  }

  /**
   * Crypto-erases a namespace: its key first, then its rows and blobs, then a line in the deletion
   * list. A protected kernel namespace is refused.
   * @param {string} ns
   */
  function erase(ns) {
    assertNamespace(ns);
    if (PROTECTED.has(ns)) throw fail('vault_protected', `${ns} belongs to the kernel and is erased only with the whole vault`, { status: 400 });
    const gen = keyring.erase(ns);
    const items = dropContent(ns);
    deletions.append(ns, null, isoAt(clock.now()), gen);
    return { namespace: ns, hadKey: gen !== null, items };
  }

  /**
   * Applies the deletion list: erases a namespace whose live key generation is one the list erased,
   * removes items not written again since their delete line. Run at start and after a restore.
   */
  function reconcile() {
    const { entries, invalid } = deletions.read();
    let namespaces = 0;
    let items = 0;
    for (const entry of entries) {
      if (PROTECTED.has(entry.ns)) continue;
      if (entry.id === null) {
        const gen = keyring.generation(entry.ns);
        const erasedGen = entry.gen ?? gen;
        if (gen !== null && erasedGen !== null && gen <= erasedGen) {
          keyring.erase(entry.ns);
          namespaces += 1;
        }
        if (erasedGen !== null) keyring.noteErased(entry.ns, erasedGen, entry.at);
        if (!keyring.has(entry.ns)) items += dropContent(entry.ns);
        continue;
      }
      const removed = Number(db.prepare('DELETE FROM vault_items WHERE ns = ? AND id = ? AND updated <= ?').run(entry.ns, entry.id, entry.at).changes);
      const file = blobFile(entry.ns, entry.id);
      const blob = blobWrittenBy(file, entry.at) && removeFile(file);
      if (blob) deleteBlobRow.run(entry.ns, entry.id);
      items += removed > 0 || blob ? 1 : 0;
    }
    return { namespaces, items, invalid };
  }

  return {
    namespace,
    codec,
    erase,
    reconcile,
    /**
     * Crypto-erases every namespace that holds user data (everything but the kernel's identity key
     * and sealed event bodies): the companion keeps its identity and its audit trail, the content
     * is gone.
     */
    eraseAll() {
      const names = new Set([...keyring.namespaces(), ...(/** @type {Array<{ ns: string }>} */ (countRows.all())).map((r) => r.ns)]);
      const erased = [];
      for (const ns of [...names].sort()) {
        if (PROTECTED.has(ns)) continue;
        erase(ns);
        erased.push(ns);
      }
      return { namespaces: erased };
    },
    /** Namespaces with their item counts (no content). */
    stats() {
      /** @type {Record<string, number>} */
      const counts = {};
      for (const ns of keyring.namespaces()) counts[ns] = 0;
      for (const row of /** @type {Array<{ ns: string, n: number }>} */ (countRows.all())) counts[row.ns] = Number(row.n);
      return counts;
    },
    keyring,
  };
}

/** @typedef {ReturnType<typeof createVault>} Vault */

/**
 * A codec for the store: seals texts (event bodies of protected classes) with a namespace key. The
 * text form is `s1.<generation>.<base64url>`. It needs only the keyring, so the store can use it
 * before the vault exists.
 * @param {import('./keyring.js').Keyring} keyring
 * @param {string} ns
 * @returns {import('../store/sqlite.js').BodyCodec}
 */
export function namespaceCodec(keyring, ns) {
  assertNamespace(ns);
  return {
    seal(plain, aad) {
      const { key, gen } = keyring.dataKey(ns);
      return `s1.${gen}.${toBase64url(sealBytes(key, Buffer.from(plain, 'utf8'), `${ns}:${aad}:${gen}`))}`;
    },
    open(sealed, aad) {
      const m = /^s1\.(\d{1,9})\.([A-Za-z0-9_-]+)$/.exec(sealed);
      const bytes = m ? fromBase64url(m[2]) : null;
      if (!m || !bytes) throw fail('vault_unreadable', 'not a sealed text');
      const gen = Number(m[1]);
      const key = keyring.keyFor(ns, gen);
      if (!key) throw fail('vault_erased', `a sealed text of ${ns} belongs to an erased key`);
      return openBytes(key, bytes, `${ns}:${aad}:${gen}`).toString('utf8');
    },
  };
}
