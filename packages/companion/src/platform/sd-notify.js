// @ts-check
// systemd readiness and watchdog. Under the user unit (Type=notify) systemd sets NOTIFY_SOCKET; the
// companion reports READY=1 once its API listens and, when WatchdogSec is set (WATCHDOG_USEC), pings
// every third of that time while its own health check holds. Node has no Unix datagram sockets, so
// the messages go through `systemd-notify` (the kernel runner: fixed path, argument list, no shell;
// the unit needs NotifyAccess=all). The variables are taken out of the environment at start, so no
// other code can talk to systemd for the companion. Without NOTIFY_SOCKET everything is a no-op.
import { runProgram } from '../vault/kek/runner.js';

const CANDIDATES = Object.freeze(['/usr/bin/systemd-notify', '/bin/systemd-notify']);

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]           taken from and cleaned (default process.env)
 * @param {import('../vault/kek/runner.js').ProgramRunner} [options.run]
 * @param {(path: string) => boolean} [options.exists]
 * @param {() => boolean} [options.healthy]
 * @param {import('../lib/clock.js').Clock} [options.clock]
 */
export function createNotifier({ env = process.env, run = runProgram, exists, healthy = () => true, clock } = {}) {
  const socket = env.NOTIFY_SOCKET ?? null;
  const watchdogUsec = Number(env.WATCHDOG_USEC ?? '0');
  delete env.NOTIFY_SOCKET;
  delete env.WATCHDOG_USEC;
  delete env.WATCHDOG_PID;
  /** @type {unknown} */
  let timer = null;
  const program = socket ? (CANDIDATES.find((p) => (exists ? exists(p) : true)) ?? null) : null;

  /** @param {string[]} args */
  async function send(args) {
    if (!socket || !program) return false;
    try {
      const out = await run(program, args, { env: { NOTIFY_SOCKET: socket }, timeoutMs: 5000 });
      return out.code === 0;
    } catch {
      return false;
    }
  }

  return {
    enabled: socket !== null,
    /** @param {string} status */
    async ready(status) {
      const ok = await send(['--ready', `--status=${status.slice(0, 200)}`]);
      if (ok && watchdogUsec > 0 && clock) {
        const every = Math.max(1000, Math.floor(watchdogUsec / 3000));
        const tick = () => {
          timer = clock.setTimeout(() => {
            if (healthy()) send(['WATCHDOG=1']).finally(tick);
            else tick();
          }, every);
        };
        tick();
      }
      return ok;
    },
    /** @param {string} status */
    status: (status) => send([`--status=${status.slice(0, 200)}`]),
    async stopping() {
      if (timer !== null && clock) clock.clearTimeout(timer);
      timer = null;
      return send(['STOPPING=1']);
    },
  };
}
