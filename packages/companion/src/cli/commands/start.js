// @ts-check
// `starpi-companion start`: runs the companion in the foreground until SIGINT or SIGTERM (the
// systemd and launchd units run exactly this), with the standard modules. The egress guard is
// always installed here.
import { startCompanion } from '../../service.js';
import { standardModules } from '../../setup/standard.js';
import { experimentalModules } from '../../computer/module.js';
import { createLogger } from '../../lib/log.js';
import { configFrom } from '../context.js';
import { fail } from '../../lib/errors.js';

/** @type {import('../context.js').Command} */
export const startCommand = {
  name: 'start',
  summary: 'run the companion in the foreground',
  usage: 'start [--port <n>] [--app-dir <folder>] [--accept-new-anchors]',
  booleans: ['accept-new-anchors'],
  strings: ['port', 'app-dir'],
  async run(ctx) {
    const port = typeof ctx.flags.port === 'string' ? Number(ctx.flags.port) : undefined;
    if (port !== undefined && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) throw fail('usage', '--port is 1024 to 65535');
    const config = configFrom(ctx.flags, ctx.env, { port, appDir: typeof ctx.flags['app-dir'] === 'string' ? ctx.flags['app-dir'] : undefined });
    const log = createLogger({ level: config.log.level });
    // The standard modules always run; experimental ones (computer control) only when the config turns them on.
    const modules = [...standardModules({ brains: config.brains }), ...experimentalModules(config)];
    const companion = await startCompanion({ config, modules, guard: true, acceptNewAnchors: ctx.flags['accept-new-anchors'] === true, log, env: ctx.env });
    ctx.out(`Starpi Core (local companion) listening on ${companion.url}`);
    ctx.out(`identity ${companion.installation.identity.keyId.slice(0, 16)}  data ${config.dataDir}`);
    await new Promise((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        companion.stop().then(resolve, (err) => {
          log('error', 'stop_failed', { error: err });
          resolve(undefined);
        });
      };
      ctx.onSignal('SIGINT', stop);
      ctx.onSignal('SIGTERM', stop);
    });
    return 0;
  },
};
