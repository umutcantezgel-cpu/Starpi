// @ts-check
// `starpi-companion backup create|verify|restore`. Restore needs the companion stopped and an empty
// data folder; a backup older than the newest anchor is restored only with --accept-rollback, and
// then leaves a signed restore anchor behind.
import { resolve } from 'node:path';
import { openInstallation } from '../../installation.js';
import { createAnchorWriter, pinKey, readPinnedKey } from '../../audit/anchors.js';
import { backupSize, createBackup, restoreBackup, verifyBackup } from '../../vault/backup.js';
import { kekProvider } from '../../vault/kek/index.js';
import { fail } from '../../lib/errors.js';

/** @type {import('../context.js').Command} */
export const backupCommand = {
  name: 'backup',
  summary: 'create, verify or restore a sealed backup',
  usage: 'backup create --out <folder> | backup verify <folder> | backup restore <folder> [--accept-rollback]',
  booleans: ['accept-rollback'],
  strings: ['out'],
  async run(ctx) {
    const [action, folder] = ctx.positional;
    const config = ctx.config();
    if (action === 'create') {
      if (typeof ctx.flags.out !== 'string') throw fail('usage', 'backup create --out <folder>');
      const inst = await openInstallation({ config, env: ctx.env });
      try {
        const outDir = resolve(ctx.flags.out);
        const manifest = createBackup({ store: inst.store, dataDir: config.dataDir, anchorDir: config.anchorDir, outDir, identity: inst.identity });
        inst.chain.append({ kind: 'backup.created', subject: manifest.created, actor: 'cli', details: { auditSeq: manifest.audit.seq, files: manifest.files.length } });
        if (ctx.flags.json) ctx.json({ manifest: { created: manifest.created, audit: manifest.audit, files: manifest.files.length }, bytes: backupSize(outDir) });
        else ctx.out(`backup written: ${manifest.files.length} files, audit head ${manifest.audit.seq}, ${backupSize(outDir)} bytes`);
        return 0;
      } finally {
        inst.close();
      }
    }
    if (action === 'verify') {
      if (typeof folder !== 'string') throw fail('usage', 'backup verify <folder>');
      const pinned = readPinnedKey(config.anchorDir);
      const check = verifyBackup(resolve(folder), { pinnedKeyId: pinned?.keyId ?? null });
      if (ctx.flags.json) ctx.json({ ok: check.ok, findings: check.findings, created: check.manifest?.created ?? null });
      else ctx.out(check.ok ? `OK: backup of ${check.manifest?.created} verifies` : `NOT OK: ${check.findings.join(', ')}`);
      return check.ok ? 0 : 1;
    }
    if (action === 'restore') {
      if (typeof folder !== 'string') throw fail('usage', 'backup restore <folder> [--accept-rollback]');
      const provider = kekProvider({ config: config.vault.kek, configDir: config.configDir, dataDir: config.dataDir, env: ctx.env });
      const kek = await provider.load();
      const result = restoreBackup({ backupDir: resolve(folder), dataDir: config.dataDir, anchorDir: config.anchorDir, kek, acceptRollback: ctx.flags['accept-rollback'] === true });
      const inst = await openInstallation({ config, env: ctx.env });
      try {
        const reconciled = inst.vault.reconcile();
        inst.chain.append({ kind: 'backup.restored', subject: result.manifest.created, actor: 'cli', details: { rollback: result.rollback, auditSeq: result.manifest.audit.seq, reconciled } });
        pinKey(config.anchorDir, inst.identity);
        const writer = createAnchorWriter({ store: inst.store, chain: inst.chain, anchorDir: config.anchorDir, identity: inst.identity });
        const anchor = writer.write('restore', result.supersedes !== null ? { supersedes: result.supersedes } : {});
        if (ctx.flags.json) ctx.json({ restored: result.manifest.created, rollback: result.rollback, anchor: anchor?.n ?? null, reconciled });
        else {
          ctx.out(`restored the backup of ${result.manifest.created}${result.rollback ? ' (an accepted rollback, recorded by a restore anchor)' : ''}`);
          if (reconciled.namespaces + reconciled.items > 0) ctx.out(`deleted again after restore: ${reconciled.namespaces} namespaces, ${reconciled.items} items`);
        }
        return 0;
      } finally {
        inst.close();
      }
    }
    throw fail('usage', this.usage);
  },
};
