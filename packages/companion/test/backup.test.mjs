import assert from 'node:assert/strict';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInstallation } from '../src/installation.js';
import { checkBeforeStart } from '../src/service.js';
import { createAnchorWriter, checkAnchors } from '../src/audit/anchors.js';
import { createBackup, restoreBackup, verifyBackup } from '../src/vault/backup.js';
import { tempDir, testConfig } from './helpers.mjs';

/** @param {string} root */
async function installed(root) {
  const config = testConfig(root);
  const inst = await openInstallation({ config, create: true, env: {} });
  checkBeforeStart(inst);
  const writer = createAnchorWriter({ store: inst.store, chain: inst.chain, anchorDir: config.anchorDir, identity: inst.identity });
  writer.start();
  return { config, inst, writer };
}

test('a backup verifies, holds no KEK and no plaintext, and a changed file is caught', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { config, inst } = await installed(dir);
  inst.vault.namespace('notes').put('n1', 'quiet lighthouse');
  const out = join(dir, 'backup');
  const manifest = createBackup({ store: inst.store, dataDir: config.dataDir, anchorDir: config.anchorDir, outDir: out, identity: inst.identity });
  assert.equal(manifest.audit.seq, inst.chain.head().seq);
  assert.ok(manifest.files.some((f) => f.path === 'data/companion.db'));
  assert.equal(manifest.files.some((f) => f.path.includes('kek')), false);
  for (const f of manifest.files) assert.equal(readFileSync(join(out, ...f.path.split('/'))).includes(Buffer.from('quiet lighthouse')), false, f.path);
  assert.deepEqual(verifyBackup(out, { pinnedKeyId: inst.identity.keyId }), { ok: true, manifest, findings: [] });
  assert.equal(verifyBackup(out, { pinnedKeyId: 'f'.repeat(64) }).findings.includes('backup_other_companion'), true);
  assert.throws(() => createBackup({ store: inst.store, dataDir: config.dataDir, anchorDir: config.anchorDir, outDir: out, identity: inst.identity }), (err) => /** @type {any} */ (err).code === 'backup_target_not_empty');
  assert.throws(() => createBackup({ store: inst.store, dataDir: config.dataDir, anchorDir: config.anchorDir, outDir: join(config.dataDir, 'b'), identity: inst.identity }), (err) => /** @type {any} */ (err).code === 'backup_target_overlaps');
  const keyring = join(out, 'data', 'vault', 'keyring.json');
  chmodSync(keyring, 0o600);
  writeFileSync(keyring, '{}');
  assert.ok(verifyBackup(out).findings.some((f) => f.startsWith('file_changed:')));
  inst.close();
});

test('restore: refused into a used folder, an older backup only as an accepted rollback, deletions win', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { config, inst, writer } = await installed(dir);
  inst.vault.namespace('notes').put('kept', 'k');
  inst.vault.namespace('notes').put('gone', 'g');
  inst.vault.namespace('chats').put('c', 'chat');
  const out = join(dir, 'backup');
  createBackup({ store: inst.store, dataDir: config.dataDir, anchorDir: config.anchorDir, outDir: out, identity: inst.identity });
  // After the backup: an item is deleted, a namespace erased, and more records are anchored.
  inst.vault.namespace('notes').delete('gone');
  inst.vault.erase('chats');
  for (let i = 0; i < 3; i += 1) inst.chain.append({ kind: 'test.after', subject: String(i) });
  writer.stop();
  inst.close();

  assert.throws(() => restoreBackup({ backupDir: out, dataDir: config.dataDir, anchorDir: config.anchorDir, kek: inst.kek }), (err) => /** @type {any} */ (err).code === 'restore_target_not_empty');
  renameSync(config.dataDir, join(dir, 'moved-aside'));
  assert.throws(() => restoreBackup({ backupDir: out, dataDir: config.dataDir, anchorDir: config.anchorDir, kek: Buffer.alloc(32, 7) }), (err) => /** @type {any} */ (err).code === 'kek_mismatch');
  assert.throws(() => restoreBackup({ backupDir: out, dataDir: config.dataDir, anchorDir: config.anchorDir, kek: inst.kek }), (err) => /** @type {any} */ (err).code === 'audit_rollback');
  const result = restoreBackup({ backupDir: out, dataDir: config.dataDir, anchorDir: config.anchorDir, kek: inst.kek, acceptRollback: true });
  assert.equal(result.rollback, true);

  const restored = await openInstallation({ config, env: {} });
  assert.equal(restored.vault.namespace('notes').getText('gone'), 'g', 'the old copy still holds it before reconciliation');
  const reconciled = restored.vault.reconcile();
  assert.equal(reconciled.namespaces, 1);
  assert.equal(restored.vault.namespace('notes').get('gone'), null);
  assert.equal(restored.vault.namespace('notes').getText('kept'), 'k');
  assert.equal(restored.keyring.has('chats'), false, 'an erased namespace stays erased');
  // Without a restore anchor the start would refuse; the CLI writes one, as here.
  assert.throws(() => checkBeforeStart(restored), (err) => /** @type {any} */ (err).code === 'audit_rollback');
  restored.chain.append({ kind: 'backup.restored', subject: result.manifest.created });
  const anchor = createAnchorWriter({ store: restored.store, chain: restored.chain, anchorDir: config.anchorDir, identity: restored.identity }).write('restore', { supersedes: /** @type {number} */ (result.supersedes) });
  assert.equal(anchor?.type, 'restore');
  checkBeforeStart(restored);
  assert.deepEqual(checkAnchors({ db: restored.store.db, anchorDir: config.anchorDir, keyId: restored.identity.keyId }).findings, []);
  restored.close();
});
