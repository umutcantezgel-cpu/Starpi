import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { cpSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInstallation } from '../src/installation.js';
import { checkBeforeStart, startCompanion } from '../src/service.js';
import { auditHeadMessage, recordHash } from '../src/audit/chain.js';
import { anchorFileName, checkAnchors, createAnchorWriter } from '../src/audit/anchors.js';
import { verifyInstallation } from '../src/audit/verify.js';
import { publicKeyFromRaw, verifySignature } from '../src/audit/identity.js';
import { fromBase64url } from '../src/lib/canonical.js';
import { tempDir, testConfig } from './helpers.mjs';

/** @param {string} root */
async function install(root) {
  const config = testConfig(root);
  const inst = await openInstallation({ config, create: true, env: {} });
  return { config, inst };
}

test('records chain by hash; a changed tail refuses the next append', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { inst } = await install(dir);
  const a = inst.chain.append({ kind: 'test.first', subject: 'one', details: { n: 1 } });
  const b = inst.chain.append({ kind: 'test.second', subject: 'two' });
  assert.equal(b.prev, a.hash);
  assert.equal(recordHash(b), b.hash);
  assert.deepEqual(inst.chain.verify().findings, []);
  assert.throws(() => inst.chain.append({ kind: 'Bad Kind' }), /audit kind/);
  inst.store.db.exec('DROP TRIGGER audit_append_only_u');
  inst.store.db.exec(`UPDATE audit_log SET subject = 'forged' WHERE seq = 2`);
  assert.throws(() => inst.chain.append({ kind: 'test.third' }), (err) => /** @type {any} */ (err).code === 'audit_tampered');
  assert.deepEqual(inst.chain.verify().findings, [{ kind: 'audit_hash_mismatch', seq: 2 }]);
  inst.close();
});

test('the signed head verifies with the public key, in Node and through WebCrypto as a browser would', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { inst } = await install(dir);
  inst.chain.append({ kind: 'test.thing' });
  const head = inst.chain.signedHead();
  const message = auditHeadMessage({ keyId: inst.identity.keyId, seq: head.seq, hash: head.hash });
  assert.equal(message, `{"hash":"${head.hash}","key":"${inst.identity.keyId}","kind":"starpi.companion.audit-head","seq":${head.seq},"v":1}`);
  assert.equal(verifySignature(publicKeyFromRaw(inst.identity.publicKey), message, head.sig), true);
  assert.equal(verifySignature(publicKeyFromRaw(inst.identity.publicKey), message.replace(`"seq":${head.seq}`, `"seq":${head.seq + 1}`), head.sig), false);
  const key = await webcrypto.subtle.importKey('raw', /** @type {Buffer} */ (fromBase64url(inst.identity.publicKey)), { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'Ed25519' }, key, /** @type {Buffer} */ (fromBase64url(head.sig)), new TextEncoder().encode(message)), true);
  const earlier = inst.chain.signedHeadAt(1);
  assert.equal(earlier?.seq, 1);
  assert.equal(inst.chain.signedHeadAt(99), null);
  inst.close();
});

test('rollback detection: an older copy of the data folder is refused at start', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { config, inst } = await install(dir);
  checkBeforeStart(inst);
  const writer = createAnchorWriter({ store: inst.store, chain: inst.chain, anchorDir: config.anchorDir, identity: inst.identity, every: 2 });
  writer.start();
  inst.chain.append({ kind: 'test.before' });
  inst.store.checkpoint();
  inst.close();
  cpSync(config.dataDir, join(dir, 'copy'), { recursive: true });

  const again = await openInstallation({ config, env: {} });
  for (let i = 0; i < 4; i += 1) again.chain.append({ kind: 'test.after', subject: String(i) });
  createAnchorWriter({ store: again.store, chain: again.chain, anchorDir: config.anchorDir, identity: again.identity }).write('checkpoint');
  again.close();

  rmSync(config.dataDir, { recursive: true });
  cpSync(join(dir, 'copy'), config.dataDir, { recursive: true });
  const rolledBack = await openInstallation({ config, env: {} });
  assert.throws(() => checkBeforeStart(rolledBack), (err) => /** @type {any} */ (err).code === 'audit_rollback');
  const report = verifyInstallation({ db: rolledBack.store.db, anchorDir: config.anchorDir, keyId: rolledBack.identity.keyId });
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].reason, 'head_older');
  rolledBack.close();
  await assert.rejects(startCompanion({ config, env: {} }), (err) => /** @type {any} */ (err).code === 'audit_rollback');
});

test('a forged event log behind a valid audit chain is caught by the anchored event link', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { config, inst } = await install(dir);
  checkBeforeStart(inst);
  inst.store.append([{ type: 'feed.sample', source: 'demo-sensor', key: 'k', at: '2026-01-01T00:00:00Z', class: 'public', body: { source_id: 'demo-sensor', series: 'room.temperature', value: 20, unit: '°C', ts_source: '2026-01-01T00:00:00Z', quality: 'good' } }]);
  createAnchorWriter({ store: inst.store, chain: inst.chain, anchorDir: config.anchorDir, identity: inst.identity }).write('checkpoint');
  inst.store.db.exec('DROP TRIGGER event_log_no_update');
  inst.store.db.exec(`UPDATE event_log SET link = '${'1'.repeat(64)}' WHERE seq = 1`);
  const found = checkAnchors({ db: inst.store.db, anchorDir: config.anchorDir, keyId: inst.identity.keyId }).findings;
  assert.deepEqual(found.map((f) => f.reason), ['events_mismatch']);
  inst.close();
});

test('anchors: a changed anchor, a foreign anchor folder and a missing folder are refused', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { config, inst } = await install(dir);
  checkBeforeStart(inst);
  const writer = createAnchorWriter({ store: inst.store, chain: inst.chain, anchorDir: config.anchorDir, identity: inst.identity });
  writer.start();
  inst.chain.append({ kind: 'test.more' });
  writer.write('checkpoint');
  const file = join(config.anchorDir, anchorFileName(1));
  const original = readFileSync(file, 'utf8');
  chmodSync(file, 0o644);
  writeFileSync(file, original.replace('"type":"checkpoint"', '"type":"restore"'));
  assert.throws(() => checkBeforeStart(inst), (err) => /** @type {any} */ (err).code === 'anchor_invalid');
  writeFileSync(file, original);
  checkBeforeStart(inst);
  inst.close();

  // Another installation pointed at this anchor folder.
  const other = testConfig(join(dir, 'other'));
  const foreign = await openInstallation({ config: { ...other, anchorDir: config.anchorDir }, create: true, env: {} });
  assert.throws(() => checkBeforeStart(foreign), (err) => /** @type {any} */ (err).code === 'anchor_key_mismatch');
  foreign.close();

  // The anchor folder is gone (an unmounted share): refused unless a new line is started on purpose.
  rmSync(config.anchorDir, { recursive: true });
  const again = await openInstallation({ config, env: {} });
  assert.throws(() => checkBeforeStart(again), (err) => /** @type {any} */ (err).code === 'anchor_dir_missing');
  assert.deepEqual(checkBeforeStart(again, { acceptNewAnchors: true }), { newLine: true });
  again.close();
});
