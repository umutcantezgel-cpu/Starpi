// The file store: original bytes in the origin private file system (a test double here), and the
// same calls on the database's blobs store when OPFS is missing, broken or would outlive a
// database that only lives in memory.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createFileStore } from '../../src/js/store/opfs.js';
import { openAppDb } from '../../src/js/store/schema.js';

let seq = 0;
const uniqueName = () => `opfs-test-${(seq += 1)}`;

const notFound = () => new DOMException('A requested file or directory could not be found.', 'NotFoundError');

/** An in-memory directory with the OPFS calls the file store uses. */
class FakeDirectory {
  constructor() {
    /** @type {Map<string, FakeDirectory | FakeFile>} */
    this.children = new Map();
  }

  /** @param {string} name @param {{ create?: boolean }} [options] */
  async getDirectoryHandle(name, options) {
    let dir = this.children.get(name);
    if (!dir && options?.create) this.children.set(name, (dir = new FakeDirectory()));
    if (!(dir instanceof FakeDirectory)) throw notFound();
    return dir;
  }

  /** @param {string} name @param {{ create?: boolean }} [options] */
  async getFileHandle(name, options) {
    let file = this.children.get(name);
    if (!file && options?.create) this.children.set(name, (file = new FakeFile(name)));
    if (!(file instanceof FakeFile)) throw notFound();
    return file;
  }

  /** @param {string} name */
  async removeEntry(name) {
    if (!this.children.delete(name)) throw notFound();
  }

  async *entries() {
    for (const entry of this.children) yield entry;
  }
}

class FakeFile {
  /** @param {string} name */
  constructor(name) {
    this.kind = /** @type {const} */ ('file');
    this.name = name;
    this.bytes = new Uint8Array(0);
    this.failNextWrite = false;
  }

  async getFile() {
    return new File([this.bytes], this.name);
  }

  async createWritable() {
    /** @type {Blob | null} */
    let pending = null;
    return {
      write: async (/** @type {Blob} */ data) => {
        if (this.failNextWrite) {
          this.failNextWrite = false;
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        pending = data;
      },
      // Like OPFS, the new content replaces the old one only on close.
      close: async () => {
        if (pending) this.bytes = new Uint8Array(await pending.arrayBuffer());
      },
      abort: async () => {
        pending = null;
      },
    };
  }
}

/**
 * Runs the shared file-store checks.
 * @param {import('../../src/js/store/opfs.js').FileStore} files
 */
async function exercise(files) {
  assert.equal(await files.write('doc-1.pdf', new TextEncoder().encode('%PDF-1.7 sample')), 15);
  assert.equal(await files.write('b-2', new Blob(['second'], { type: 'text/plain' })), 6);
  assert.equal(await (await files.read('doc-1.pdf'))?.text(), '%PDF-1.7 sample');
  assert.equal((await files.read('doc-1.pdf', { type: 'application/pdf' }))?.type, 'application/pdf');
  assert.equal(await files.size('b-2'), 6);
  assert.equal(await files.read('missing'), null);
  assert.equal(await files.size('missing'), null);
  assert.deepEqual(await files.list(), [
    { id: 'b-2', size: 6 },
    { id: 'doc-1.pdf', size: 15 },
  ]);
  assert.equal(await files.totalSize(), 21);
  await files.write('b-2', new ArrayBuffer(3));
  assert.equal(await files.size('b-2'), 3);
  assert.equal(await files.delete('b-2'), true);
  assert.equal(await files.delete('b-2'), false);
  assert.deepEqual(await files.list(), [{ id: 'doc-1.pdf', size: 15 }]);
  await assert.rejects(files.write('../escape', new Blob(['x'])), (err) => err.code === 'data');
  await assert.rejects(files.write('a/b', new Blob(['x'])), (err) => err.code === 'data');
}

describe('file store on OPFS', () => {
  it('writes, reads, sizes, lists and deletes files in its own directory', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const root = new FakeDirectory();
    const files = createFileStore({ db, dir: 'originals', root: async () => root });
    assert.equal(await files.backend(), 'opfs');
    await exercise(files);
    assert.deepEqual([...root.children.keys()], ['originals']);
    assert.equal(await db.count('blobs'), 0, 'nothing went to the database');
    db.close();
  });

  it('keeps the previous content when a write fails', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const root = new FakeDirectory();
    const files = createFileStore({ db, root: async () => root });
    await files.write('f', new Blob(['old']));
    const dir = await root.getDirectoryHandle('files');
    (await dir.getFileHandle('f')).failNextWrite = true;
    await assert.rejects(files.write('f', new Blob(['new content'])), (err) => err.code === 'quota');
    assert.equal(await (await files.read('f'))?.text(), 'old');
    db.close();
  });
});

describe('file store without OPFS', () => {
  it('keeps the files in the blobs store of the database', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const files = createFileStore({ db, dir: 'originals', root: null });
    assert.equal(await files.backend(), 'idb');
    await exercise(files);
    const [record] = await db.getAll('blobs');
    assert.equal(record.id, 'originals/doc-1.pdf');
    assert.equal(record.kind, 'file');
    // Another purpose's files stay apart.
    const other = createFileStore({ db, dir: 'attachments', root: null });
    await other.write('doc-1.pdf', new Blob(['other']));
    assert.deepEqual(await files.list(), [{ id: 'doc-1.pdf', size: 15 }]);
    db.close();
  });

  it('falls back when the OPFS root cannot be opened', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const files = createFileStore({
      db,
      root: async () => {
        throw new DOMException('Security error when calling GetDirectory', 'SecurityError');
      },
    });
    assert.equal(await files.backend(), 'idb');
    await files.write('x', new Blob(['ok']));
    assert.equal(await files.size('x'), 2);
    db.close();
  });

  it('does not write files to OPFS while the database lives only in memory', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: null });
    const root = new FakeDirectory();
    const files = createFileStore({ db, root: async () => root });
    assert.equal(await files.backend(), 'idb');
    await files.write('x', new Blob(['ok']));
    assert.equal(root.children.size, 0);
  });

  it('is off in Node, where there is no OPFS', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    assert.equal(await createFileStore({ db }).backend(), 'idb');
    db.close();
  });
});
