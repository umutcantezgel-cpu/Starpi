import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '../src/store/sqlite.js';
import { openKeyring } from '../src/vault/keyring.js';
import { openDeletionList } from '../src/vault/deletions.js';
import { createVault } from '../src/vault/vault.js';
import { newKey, openBytes, sealBytes } from '../src/vault/crypto.js';
import { exportBundle, importBundle } from '../src/vault/bundle.js';
import { manualClock } from '../src/lib/clock.js';
import { tempDir } from './helpers.mjs';

/** Opens a vault in a folder. @param {string} dir @param {Buffer} kek @param {any} [clock] */
function open(dir, kek, clock) {
  mkdirSync(join(dir, 'data'), { recursive: true });
  const store = openStore({ path: join(dir, 'data', 'c.db') });
  const keyring = openKeyring({ file: join(dir, 'data', 'vault', 'keyring.json'), kek, provider: 'file', clock });
  const deletions = openDeletionList({ file: join(dir, 'anchors', 'deletions.log'), dataDir: join(dir, 'data') });
  const vault = createVault({ store, keyring, deletions, blobDir: join(dir, 'data', 'vault', 'blobs'), clock });
  return { store, keyring, deletions, vault };
}

/** Every file below a folder. @param {string} root @returns {string[]} */
function allFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? /** @type {any} */ (e).path, e.name));
}

test('sealed values open only with their key, place and generation', () => {
  const key = newKey();
  const sealed = sealBytes(key, Buffer.from('hello'), 'vault:notes:a:1');
  assert.equal(openBytes(key, sealed, 'vault:notes:a:1').toString(), 'hello');
  assert.throws(() => openBytes(key, sealed, 'vault:notes:b:1'), /did not open/);
  assert.throws(() => openBytes(newKey(), sealed, 'vault:notes:a:1'), /did not open/);
  const flipped = Buffer.from(sealed);
  flipped[flipped.length - 1] ^= 1;
  assert.throws(() => openBytes(key, flipped, 'vault:notes:a:1'), /did not open/);
});

test('notes, chats and secrets are sealed: no plaintext anywhere in the data folder', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { store, vault } = open(dir, newKey());
  const marker = 'zebra-crossing-7731';
  vault.namespace('notes').put('n1', `my note about ${marker}`);
  vault.namespace('chats').putJson('c1', { turns: [{ role: 'user', text: `ask ${marker}` }] });
  vault.namespace('secrets').put('openai', `sk-${marker}`);
  vault.namespace('docs').putBlob('d1', Buffer.from(`document ${marker}`));
  assert.match(vault.namespace('notes').getText('n1') ?? '', /zebra/);
  assert.equal(vault.namespace('docs').getBlob('d1')?.toString(), `document ${marker}`);
  store.checkpoint();
  store.close();
  for (const file of allFiles(join(dir, 'data'))) assert.equal(readFileSync(file).includes(Buffer.from(marker)), false, `${file} holds plaintext`);
});

test('a row moved to another id does not open', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { store, vault } = open(dir, newKey());
  vault.namespace('notes').put('a', 'alpha');
  vault.namespace('notes').put('b', 'beta');
  store.db.exec("UPDATE vault_items SET sealed = (SELECT sealed FROM vault_items WHERE id = 'a') WHERE id = 'b'");
  assert.throws(() => vault.namespace('notes').get('b'), /did not open/);
});

test('crypto-erase: after the key is gone, even an old copy of the data cannot be read', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const kek = newKey();
  const a = open(dir, kek);
  a.vault.namespace('notes').put('n1', 'remember the milk');
  a.store.checkpoint();
  cpSync(join(dir, 'data', 'c.db'), join(dir, 'old.db'));
  const result = a.vault.erase('notes');
  assert.deepEqual(result, { namespace: 'notes', hadKey: true, items: 1 });
  assert.equal(a.vault.namespace('notes').get('n1'), null);
  assert.match(readFileSync(join(dir, 'anchors', 'deletions.log'), 'utf8'), /^notes\/\* \S+ 1\n$/);
  // The old database still holds the sealed row, but its key generation is gone for good.
  const old = openStore({ path: join(dir, 'old.db') });
  const row = /** @type {any} */ (old.db.prepare("SELECT gen, sealed FROM vault_items WHERE ns = 'notes'").get());
  assert.equal(a.keyring.keyFor('notes', row.gen), null);
  // A namespace made again gets a new generation; the old value never opens with it.
  a.vault.namespace('notes').put('n2', 'new');
  assert.equal(a.keyring.generation('notes'), 2);
  const fresh = a.keyring.dataKey('notes').key;
  assert.throws(() => openBytes(fresh, row.sealed, `vault:notes:n1:${row.gen}`), /did not open/);
  old.close();
  assert.throws(() => a.vault.erase('identity'), (err) => /** @type {any} */ (err).code === 'vault_protected');
});

test('a wrong key-encryption key is refused at open', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  open(dir, newKey()).vault.namespace('notes').put('x', 'y');
  assert.throws(() => openKeyring({ file: join(dir, 'data', 'vault', 'keyring.json'), kek: newKey(), provider: 'file' }), (err) => /** @type {any} */ (err).code === 'kek_mismatch');
});

test('an erase by another process is never undone by a stale keyring', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const kek = newKey();
  const server = open(dir, kek);
  server.vault.namespace('notes').put('n', 'v');
  const cli = open(dir, kek);
  cli.vault.erase('notes');
  // The "server" now creates another namespace; its save must not bring the erased key back.
  server.vault.namespace('chats').put('c', 'v');
  const file = JSON.parse(readFileSync(join(dir, 'data', 'vault', 'keyring.json'), 'utf8'));
  assert.equal(file.keys.notes, undefined);
  assert.ok(file.keys.chats);
});

test('reconcile applies the deletion list to an older copy', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const kek = newKey();
  const clock = manualClock(Date.UTC(2026, 4, 1));
  const a = open(dir, kek, clock);
  a.vault.namespace('notes').put('keep', 'k');
  a.vault.namespace('notes').put('drop', 'd');
  a.vault.namespace('chats').put('c1', 'chat');
  a.store.checkpoint();
  a.store.close();
  cpSync(join(dir, 'data'), join(dir, 'snapshot'), { recursive: true });
  clock.advance(1000);
  const b = open(dir, kek, clock);
  b.vault.namespace('notes').delete('drop');
  b.vault.erase('chats');
  b.store.close();
  // Put the older data folder back (as a restore would) and reconcile.
  cpSync(join(dir, 'snapshot'), join(dir, 'data'), { recursive: true });
  clock.advance(1000);
  const c = open(dir, kek, clock);
  assert.equal(c.vault.namespace('notes').getText('drop'), 'd', 'the old copy still has it');
  const result = c.vault.reconcile();
  assert.deepEqual({ namespaces: result.namespaces, items: result.items }, { namespaces: 1, items: 2 });
  assert.equal(c.vault.namespace('notes').get('drop'), null);
  assert.equal(c.vault.namespace('notes').getText('keep'), 'k');
  assert.equal(c.keyring.has('chats'), false);
  c.vault.namespace('chats').put('c2', 'later');
  assert.equal(c.vault.reconcile().namespaces, 0, 'a namespace made after the erase stays');
});

test('bundles: export with a passphrase, import elsewhere, skip what was deleted since', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const clock = manualClock(Date.UTC(2026, 5, 1));
  const src = open(join(dir, 'a'), newKey(), clock);
  src.vault.namespace('notes').put('n1', 'one');
  src.vault.namespace('notes').put('n2', 'two');
  src.vault.namespace('docs').putBlob('d1', Buffer.from('blob'));
  const { file, items, blobs } = exportBundle({ vault: src.vault, namespaces: ['notes', 'docs'], passphrase: 'correct horse battery', clock });
  assert.deepEqual({ items, blobs }, { items: 2, blobs: 1 });
  assert.equal(file.includes('one'), false);
  assert.throws(() => exportBundle({ vault: src.vault, namespaces: ['identity'], passphrase: 'correct horse battery' }), (err) => /** @type {any} */ (err).code === 'vault_protected');
  assert.throws(() => exportBundle({ vault: src.vault, namespaces: ['notes'], passphrase: 'short' }), (err) => /** @type {any} */ (err).code === 'passphrase_weak');

  clock.advance(1000);
  const dst = open(join(dir, 'b'), newKey(), clock);
  dst.deletions.append('notes', 'n2', new Date(clock.now()).toISOString());
  assert.throws(() => importBundle({ vault: dst.vault, deletions: dst.deletions, file, passphrase: 'wrong horse battery' }), (err) => /** @type {any} */ (err).code === 'bundle_passphrase');
  const result = importBundle({ vault: dst.vault, deletions: dst.deletions, file, passphrase: 'correct horse battery' });
  assert.deepEqual({ items: result.items, blobs: result.blobs, skipped: result.skipped }, { items: 1, blobs: 1, skipped: 1 });
  assert.equal(dst.vault.namespace('notes').getText('n1'), 'one');
  assert.equal(dst.vault.namespace('notes').get('n2'), null);
  assert.equal(dst.vault.namespace('docs').getBlob('d1')?.toString(), 'blob');
});

test('the deletion list must live outside the data folder', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  assert.throws(() => openDeletionList({ file: join(dir, 'data', 'deletions.log'), dataDir: join(dir, 'data') }), (err) => /** @type {any} */ (err).code === 'deletions_path');
  const list = openDeletionList({ file: join(dir, 'anchors', 'deletions.log'), dataDir: join(dir, 'data') });
  list.append('notes', 'a1', '2026-01-01T00:00:00.000Z');
  assert.equal(statSync(join(dir, 'anchors', 'deletions.log')).mode & 0o777, 0o600);
  assert.deepEqual(list.read().entries, [{ ns: 'notes', id: 'a1', at: '2026-01-01T00:00:00.000Z', gen: null }]);
});
