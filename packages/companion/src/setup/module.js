// @ts-check
// Module `setup`: what the owner should see on the first start, and later whenever something
// stops working.
//   GET /v1/setup           owner  the checks (setup/checks.js), from the last run; ?fresh=1 runs them now
//   GET /v1/setup/models    owner  the models the local model servers list, and the sizes the machine holds
// The checks run once in the background after the start; a missing model or an unreachable local
// server is written to the log as well.
import { isoAt } from '../lib/clock.js';
import { codeOf } from '../lib/errors.js';
import { runChecks } from './checks.js';
import { listServerModels, memoryMb, sizeHint } from './models.js';
import { isLoopbackUrl } from './loopback.js';

export const SETUP_MODULE = 'setup';

/**
 * @param {{ hub: import('./hub.js').Hub, brains?: Array<Record<string, any>>, fetchImpl?: typeof fetch }} deps
 *   brains: the configured brain entries (the `brains` member of the configuration)
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createSetupModule({ hub, brains = [], fetchImpl }) {
  /** @type {any} */
  let ctx = null;
  /** @type {{ at: string, checks: import('./checks.js').Check[], ready: boolean } | null} */
  let last = null;
  /** @type {Promise<void> | null} */
  let running = null;

  /** @param {AbortSignal} [signal] */
  function check(signal) {
    running ??= runChecks({ hub, brains, timeZone: ctx.timeZone, now: ctx.clock.now(), fetchImpl, signal })
      .then((result) => {
        last = { at: isoAt(ctx.clock.now()), ...result };
        for (const c of result.checks) if (c.state === 'warn' || c.state === 'fail') ctx.log('warn', 'setup_check', { check: c.id, code: c.code });
      })
      .catch((err) => ctx.log('warn', 'setup_failed', { code: codeOf(err) }))
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    id: SETUP_MODULE,
    version: '1.0.0',
    title: 'Setup checks',
    routes: [
      {
        method: 'GET',
        path: '/',
        access: 'owner',
        lane: 'status',
        async handler(req) {
          if (!last || req.query.get('fresh') === '1') await check(req.signal);
          return { body: last ?? { at: null, checks: [], ready: false } };
        },
      },
      {
        method: 'GET',
        path: '/models',
        access: 'owner',
        lane: 'status',
        async handler(req) {
          const memory = memoryMb();
          const servers = [];
          for (const brain of brains) {
            if (typeof brain.baseUrl !== 'string' || !isLoopbackUrl(brain.baseUrl)) continue;
            servers.push({ brain: brain.id, url: brain.baseUrl, configured: brain.model ?? null, ...(await listServerModels(brain.baseUrl, { fetchImpl, signal: req.signal })) });
          }
          return { body: { memory, suggestion: sizeHint(memory.totalMb), servers } };
        },
      },
    ],
    start(context) {
      ctx = context;
      void ctx.scheduler.run('background', 'setup.checks', () => check()).catch(() => {});
    },
    stop() {
      last = null;
    },
  };
}
