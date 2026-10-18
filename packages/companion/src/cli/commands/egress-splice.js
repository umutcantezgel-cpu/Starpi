// @ts-check
// `starpi-companion egress-splice --socket <path>`: the program of the egress splice unit. It reads
// the egress list of the configuration (every module's hosts) and serves CONNECT requests for
// exactly those hosts on a Unix socket only the companion can open (the unit sets the socket's
// group). See src/egress/splice.js.
import { chmodSync, rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createSpliceServer } from '../../egress/splice.js';
import { fail } from '../../lib/errors.js';

/** @type {import('../context.js').Command} */
export const egressSpliceCommand = {
  name: 'egress-splice',
  summary: 'serve the egress splice for the systemd unit',
  usage: 'egress-splice --socket <absolute path>',
  strings: ['socket'],
  async run(ctx) {
    const socket = ctx.flags.socket;
    if (typeof socket !== 'string' || !isAbsolute(socket)) throw fail('usage', this.usage);
    const config = ctx.config();
    const allow = Object.values(config.egress.allow).flat();
    const server = createSpliceServer({ allow, log: (line) => ctx.out(JSON.stringify(line)) });
    rmSync(socket, { force: true });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => resolve(undefined));
    });
    chmodSync(socket, 0o660);
    ctx.out(JSON.stringify({ event: 'egress_splice_listening', hosts: allow.length }));
    await new Promise((resolve) => {
      const stop = () => server.close(() => resolve(undefined));
      ctx.onSignal('SIGINT', stop);
      ctx.onSignal('SIGTERM', stop);
    });
    return 0;
  },
};
