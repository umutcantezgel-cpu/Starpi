// @ts-check
// `starpi-companion secret set|list|remove`: API keys and other secrets, sealed in the vault. A
// value is read from standard input (a hidden prompt on a terminal), never from an argument.
import { openInstallation } from '../../installation.js';
import { NAME } from '../../contracts/check.js';
import { fail } from '../../lib/errors.js';
import { readSecret } from '../args.js';

/** @type {import('../context.js').Command} */
export const secretCommand = {
  name: 'secret',
  summary: 'set, list or remove a sealed secret (API keys)',
  usage: 'secret set <name> | secret list | secret remove <name>',
  async run(ctx) {
    const [action, name] = ctx.positional;
    if (!['set', 'list', 'remove'].includes(action ?? '')) throw fail('usage', 'secret set <name> | secret list | secret remove <name>');
    if (action !== 'list' && (typeof name !== 'string' || !NAME.test(name))) throw fail('usage', 'a secret name is lower case: letters, digits, _ . -');
    const inst = await openInstallation({ config: ctx.config(), env: ctx.env });
    try {
      const secrets = inst.vault.namespace('secrets');
      if (action === 'list') {
        const list = secrets.list().map((s) => ({ name: s.id, updated: s.updated }));
        if (ctx.flags.json) ctx.json({ secrets: list });
        else if (list.length === 0) ctx.out('no secrets');
        else for (const s of list) ctx.out(`${s.name}  (set ${s.updated})`);
        return 0;
      }
      if (action === 'remove') {
        const removed = secrets.delete(/** @type {string} */ (name));
        if (removed) inst.chain.append({ kind: 'secret.removed', subject: /** @type {string} */ (name), actor: 'cli' });
        ctx.out(removed ? `removed ${name}` : `no secret ${name}`);
        return removed ? 0 : 1;
      }
      const value = await readSecret(`value for ${name}: `, ctx.stdin);
      if (value.length === 0 || value.length > 8192) throw fail('secret_value', 'a secret value is 1 to 8192 characters');
      secrets.put(/** @type {string} */ (name), value);
      inst.chain.append({ kind: 'secret.set', subject: /** @type {string} */ (name), actor: 'cli' });
      ctx.out(`stored ${name}`);
      return 0;
    } finally {
      inst.close();
    }
  },
};
