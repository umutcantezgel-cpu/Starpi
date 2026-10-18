// @ts-check
// `starpi-companion pair`: prints a one-time pairing code for a browser (valid 10 minutes).
import { openInstallation } from '../../installation.js';
import { createSessions } from '../../auth/sessions.js';
import { isRole } from '../../contracts/roles.js';
import { fail } from '../../lib/errors.js';

/** @type {import('../context.js').Command} */
export const pairCommand = {
  name: 'pair',
  summary: 'print a one-time code to pair a browser',
  usage: 'pair [--role member|owner] [--label <name>]',
  strings: ['role', 'label'],
  async run(ctx) {
    const role = typeof ctx.flags.role === 'string' ? ctx.flags.role : 'owner';
    if (!isRole(role)) throw fail('usage', '--role is member or owner');
    const config = ctx.config();
    const inst = await openInstallation({ config, env: ctx.env });
    try {
      const sessions = createSessions({ store: inst.store, chain: inst.chain, sessionDays: config.sessions.days });
      const issued = sessions.issueCode({ role, label: typeof ctx.flags.label === 'string' ? ctx.flags.label : '', actor: 'cli' });
      if (ctx.flags.json) ctx.json({ code: issued.code, role: issued.role, expiresAt: issued.expiresAt });
      else {
        ctx.out(`Pairing code: ${issued.code.slice(0, 4)}-${issued.code.slice(4)}`);
        ctx.out(`Role ${issued.role}, valid until ${issued.expiresAt}.`);
        ctx.out(`Enter it in Starpi under Settings > Companion, or open http://127.0.0.1:${config.port}/ .`);
      }
      return 0;
    } finally {
      inst.close();
    }
  },
};
