// @ts-check
// `starpi-companion token-revoke`: ends paired sessions (one by id, or all) and lists them.
import { openInstallation } from '../../installation.js';
import { createSessions } from '../../auth/sessions.js';
import { fail } from '../../lib/errors.js';

/** @type {import('../context.js').Command} */
export const tokenRevokeCommand = {
  name: 'token-revoke',
  summary: 'revoke paired browsers (one session, or --all); --list shows them',
  usage: 'token-revoke <session id> | token-revoke --all | token-revoke --list',
  booleans: ['all', 'list'],
  async run(ctx) {
    const config = ctx.config();
    const inst = await openInstallation({ config, env: ctx.env });
    try {
      const sessions = createSessions({ store: inst.store, chain: inst.chain, sessionDays: config.sessions.days });
      if (ctx.flags.list) {
        const list = sessions.list();
        if (ctx.flags.json) ctx.json({ sessions: list });
        else if (list.length === 0) ctx.out('no paired sessions');
        else for (const s of list) ctx.out(`${s.id}  ${s.role.padEnd(6)} ${s.kind.padEnd(6)} ${s.origin ?? 'same origin'}  ${s.label || '-'}  until ${s.expiresAt}`);
        return 0;
      }
      if (!ctx.flags.all && ctx.positional.length !== 1) throw fail('usage', 'name one session id, or --all');
      const n = ctx.flags.all ? sessions.revoke({ all: true, actor: 'cli' }) : sessions.revoke({ id: ctx.positional[0], actor: 'cli' });
      if (ctx.flags.json) ctx.json({ revoked: n });
      else ctx.out(`revoked ${n} session${n === 1 ? '' : 's'}`);
      return n > 0 || ctx.flags.all ? 0 : 1;
    } finally {
      inst.close();
    }
  },
};
