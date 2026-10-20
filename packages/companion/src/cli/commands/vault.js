// @ts-check
// `starpi-companion export|import|erase`: sealed bundles of chosen namespaces (with a passphrase
// from standard input or STARPI_COMPANION_PASSPHRASE) and the crypto-erase of a namespace.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openInstallation } from '../../installation.js';
import { exportBundle, importBundle } from '../../vault/bundle.js';
import { fail } from '../../lib/errors.js';
import { writeFileOnce } from '../../lib/fsx.js';
import { readSecret } from '../args.js';
import { NAMESPACE } from '../../contracts/module.js';

/** @param {import('../context.js').CommandContext} ctx */
const passphrase = async (ctx) => ctx.env.STARPI_COMPANION_PASSPHRASE ?? (await readSecret('passphrase: ', ctx.stdin));

/** @type {import('../context.js').Command} */
export const exportCommand = {
  name: 'export',
  summary: 'write a passphrase-sealed bundle of vault namespaces',
  usage: 'export --out <file> --namespaces notes,chats',
  strings: ['out', 'namespaces'],
  async run(ctx) {
    if (typeof ctx.flags.out !== 'string' || typeof ctx.flags.namespaces !== 'string') throw fail('usage', this.usage);
    const inst = await openInstallation({ config: ctx.config(), env: ctx.env });
    try {
      const namespaces = ctx.flags.namespaces.split(',').map((s) => s.trim()).filter(Boolean);
      const result = exportBundle({ vault: inst.vault, namespaces, passphrase: await passphrase(ctx) });
      writeFileOnce(resolve(ctx.flags.out), result.file, { mode: 0o600 });
      inst.chain.append({ kind: 'vault.exported', subject: namespaces.join(','), actor: 'cli', details: { items: result.items, blobs: result.blobs } });
      ctx.out(`exported ${result.items} items and ${result.blobs} blobs`);
      return 0;
    } finally {
      inst.close();
    }
  },
};

/** @type {import('../context.js').Command} */
export const importCommand = {
  name: 'import',
  summary: 'read a passphrase-sealed bundle into the vault',
  usage: 'import <file>',
  async run(ctx) {
    const [file] = ctx.positional;
    if (typeof file !== 'string') throw fail('usage', this.usage);
    const bytes = readFileSync(resolve(file));
    const inst = await openInstallation({ config: ctx.config(), env: ctx.env });
    try {
      const result = importBundle({ vault: inst.vault, deletions: inst.deletions, file: bytes, passphrase: await passphrase(ctx) });
      inst.chain.append({ kind: 'vault.imported', subject: result.namespaces.join(','), actor: 'cli', details: { items: result.items, blobs: result.blobs, skipped: result.skipped } });
      ctx.out(`imported ${result.items} items and ${result.blobs} blobs${result.skipped ? `, skipped ${result.skipped} deleted since the export` : ''}`);
      return 0;
    } finally {
      inst.close();
    }
  },
};

/** @type {import('../context.js').Command} */
export const eraseCommand = {
  name: 'erase',
  summary: 'crypto-erase a vault namespace (or --all user data)',
  usage: 'erase <namespace> --yes | erase --all --yes',
  booleans: ['all', 'yes'],
  async run(ctx) {
    const [ns] = ctx.positional;
    if (!ctx.flags.yes) throw fail('usage', 'erasing cannot be undone; add --yes');
    if (!ctx.flags.all && (typeof ns !== 'string' || !NAMESPACE.test(ns))) throw fail('usage', this.usage);
    const inst = await openInstallation({ config: ctx.config(), env: ctx.env });
    try {
      if (ctx.flags.all) {
        const result = inst.vault.eraseAll();
        inst.chain.append({ kind: 'vault.erased', subject: 'all', actor: 'cli', details: { namespaces: result.namespaces } });
        ctx.out(`erased ${result.namespaces.length} namespaces: ${result.namespaces.join(', ') || '-'}`);
        return 0;
      }
      const result = inst.vault.erase(/** @type {string} */ (ns));
      inst.chain.append({ kind: 'vault.erased', subject: /** @type {string} */ (ns), actor: 'cli', details: { items: result.items } });
      ctx.out(`erased ${ns}: its key is destroyed, ${result.items} items removed`);
      return 0;
    } finally {
      inst.close();
    }
  },
};
