// @ts-check
// Large binaries, such as the original bytes of workspace files (kept so a receipt can be checked
// against them again) and big attachments, live in the origin private file system: one directory
// per purpose, one file per id. Without OPFS, or when it cannot write from this context, the same
// calls keep the bytes in the database's `blobs` store instead, so callers never branch.
//
// OPFS keeps no MIME type, so the owning record (a document, a message) stores it; read() takes it
// back as an option.
import { range, StoreError, toStoreError } from './idb.js';

/** @typedef {import('./idb.js').StoreDb} StoreDb */
/** @typedef {import('./schema.js').BlobRecord} BlobRecord */
/** @typedef {Blob | ArrayBuffer | ArrayBufferView} FileData */
/** @typedef {{ id: string, size: number }} FileEntry */

/**
 * The parts of the OPFS handles used here (also what a test double provides).
 * @typedef {object} FileHandleLike
 * @property {'file'} kind
 * @property {() => Promise<File>} getFile
 * @property {() => Promise<{ write: (data: Blob) => Promise<void>, close: () => Promise<void>, abort: () => Promise<void> }>} createWritable
 */

/**
 * @typedef {object} DirectoryLike
 * @property {(name: string, options?: { create?: boolean }) => Promise<DirectoryLike>} getDirectoryHandle
 * @property {(name: string, options?: { create?: boolean }) => Promise<FileHandleLike>} getFileHandle
 * @property {(name: string) => Promise<void>} removeEntry
 * @property {() => AsyncIterable<[string, { kind: string }]>} entries
 */

/**
 * @typedef {object} FileStore
 * @property {() => Promise<'opfs' | 'idb'>} backend
 * @property {(id: string, data: FileData) => Promise<number>} write  replaces the file; resolves with its size
 * @property {(id: string, options?: { type?: string }) => Promise<Blob | null>} read
 * @property {(id: string) => Promise<boolean>} delete  false when there was no such file
 * @property {(id: string) => Promise<number | null>} size
 * @property {() => Promise<FileEntry[]>} list  sorted by id
 * @property {() => Promise<number>} totalSize
 */

/**
 * @typedef {object} FileStoreOptions
 * @property {StoreDb} db  the database whose `blobs` store is the fallback
 * @property {string} [dir]  directory (and id prefix in the fallback) for this purpose
 * @property {(() => Promise<DirectoryLike>) | null} [root]  the OPFS root; null turns OPFS off
 */

const NAME = /^[A-Za-z0-9][\w.-]{0,127}$/;

/** @param {string} id */
function assertName(id) {
  if (typeof id !== 'string' || !NAME.test(id)) throw new StoreError('data', 'A file id is 1-128 letters, digits, dots, dashes or underscores');
}

/** @param {FileData} data */
function asBlob(data) {
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([/** @type {BlobPart} */ (data)]);
  throw new StoreError('data', 'File data is a Blob, an ArrayBuffer or a typed array');
}

/** @param {Blob} blob @param {string | undefined} type */
function typed(blob, type) {
  return type && blob.type !== type ? blob.slice(0, blob.size, type) : blob;
}

/** @param {unknown} err */
function isNotFound(err) {
  return Boolean(err) && typeof err === 'object' && /** @type {{ name?: unknown }} */ (err).name === 'NotFoundError';
}

/**
 * The browser's OPFS root, when files can also be written from this context (createWritable is
 * missing in some browsers outside workers).
 * @returns {(() => Promise<DirectoryLike>) | null}
 */
function browserRoot() {
  try {
    const storage = globalThis.navigator?.storage;
    const writable = typeof globalThis.FileSystemFileHandle === 'function' && typeof globalThis.FileSystemFileHandle.prototype.createWritable === 'function';
    if (!storage?.getDirectory || !writable) return null;
    return async () => /** @type {DirectoryLike} */ (/** @type {unknown} */ (await storage.getDirectory()));
  } catch {
    return null;
  }
}

/**
 * Whether this browser offers OPFS with writable files.
 * @returns {boolean}
 */
export function opfsAvailable() {
  return browserRoot() !== null;
}

/**
 * @param {DirectoryLike} dir
 * @returns {FileStore}
 */
function opfsFiles(dir) {
  /** @param {string} id */
  const handle = async (id) => {
    try {
      return await dir.getFileHandle(id);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw toStoreError(err);
    }
  };
  /** @type {FileStore} */
  const files = {
    backend: async () => 'opfs',
    write: async (id, data) => {
      assertName(id);
      const blob = asBlob(data);
      try {
        const file = await dir.getFileHandle(id, { create: true });
        const writable = await file.createWritable();
        try {
          await writable.write(blob);
          await writable.close();
        } catch (err) {
          // A failed write leaves the previous content in place.
          await writable.abort().catch(() => {});
          throw err;
        }
      } catch (err) {
        throw toStoreError(err);
      }
      return blob.size;
    },
    read: async (id, options) => {
      assertName(id);
      const file = await handle(id);
      if (!file) return null;
      try {
        return typed(await file.getFile(), options?.type);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw toStoreError(err);
      }
    },
    delete: async (id) => {
      assertName(id);
      try {
        await dir.removeEntry(id);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw toStoreError(err);
      }
    },
    size: async (id) => {
      assertName(id);
      const file = await handle(id);
      return file ? (await file.getFile()).size : null;
    },
    list: async () => {
      /** @type {FileEntry[]} */
      const out = [];
      try {
        for await (const [name, entry] of dir.entries()) {
          if (entry.kind !== 'file') continue;
          const file = await /** @type {FileHandleLike} */ (/** @type {unknown} */ (entry)).getFile();
          out.push({ id: name, size: file.size });
        }
      } catch (err) {
        throw toStoreError(err);
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    totalSize: async () => (await files.list()).reduce((sum, f) => sum + f.size, 0),
  };
  return files;
}

/**
 * @param {StoreDb} db
 * @param {string} dir
 * @param {() => number} now
 * @returns {FileStore}
 */
function blobFiles(db, dir, now) {
  /** @param {string} id */
  const keyOf = (id) => `${dir}/${id}`;
  const prefix = range.startsWith(`${dir}/`);
  /** @type {FileStore} */
  const files = {
    backend: async () => 'idb',
    write: async (id, data) => {
      assertName(id);
      const blob = asBlob(data);
      /** @type {BlobRecord} */
      const record = { id: keyOf(id), data: blob, type: blob.type, size: blob.size, kind: 'file', createdAt: now() };
      await db.put('blobs', record);
      return blob.size;
    },
    read: async (id, options) => {
      assertName(id);
      const record = /** @type {BlobRecord | undefined} */ (await db.get('blobs', keyOf(id)));
      return record ? typed(record.data, options?.type) : null;
    },
    delete: async (id) => {
      assertName(id);
      return db.transaction('blobs', 'readwrite', async (tx) => {
        if ((await tx.count('blobs', keyOf(id))) === 0) return false;
        await tx.delete('blobs', keyOf(id));
        return true;
      });
    },
    size: async (id) => {
      assertName(id);
      const record = /** @type {BlobRecord | undefined} */ (await db.get('blobs', keyOf(id)));
      return record ? record.size : null;
    },
    list: async () => {
      /** @type {FileEntry[]} */
      const out = [];
      await db.iterate('blobs', { query: prefix }, (record) => {
        out.push({ id: String(record.id).slice(dir.length + 1), size: record.size });
      });
      return out;
    },
    totalSize: async () => (await files.list()).reduce((sum, f) => sum + f.size, 0),
  };
  return files;
}

/**
 * A file store for one purpose. The backend is chosen on first use: OPFS when it opens, otherwise
 * the database's blobs. When the database itself is the memory stand-in, the files stay there
 * too, so no file outlives the records that point to it.
 * @param {FileStoreOptions} options
 * @returns {FileStore}
 */
export function createFileStore(options) {
  const { db, dir = 'files' } = options;
  assertName(dir);
  const root = options.root === undefined ? browserRoot() : options.root;
  /** @type {Promise<FileStore> | null} */
  let chosen = null;
  const pick = () => {
    chosen ??= (async () => {
      if (root && db.persistent) {
        try {
          return opfsFiles(await (await root()).getDirectoryHandle(dir, { create: true }));
        } catch (err) {
          console.warn('[store] OPFS is not usable, keeping files in the database:', err);
        }
      }
      return blobFiles(db, dir, Date.now);
    })();
    return chosen;
  };
  return {
    backend: async () => (await pick()).backend(),
    write: async (id, data) => (await pick()).write(id, data),
    read: async (id, opts) => (await pick()).read(id, opts),
    delete: async (id) => (await pick()).delete(id),
    size: async (id) => (await pick()).size(id),
    list: async () => (await pick()).list(),
    totalSize: async () => (await pick()).totalSize(),
  };
}
