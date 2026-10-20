// @ts-check
// The scheduler runs the companion's asynchronous work in three lanes:
//   interactive  a person waits (an answer, a status page): highest priority, slots reserved;
//   events       facts coming in (a feed reading, a module's timer);
//   background   work nobody waits for (re-indexing, sweeps): runs only when the lanes above are
//                idle and is asked to yield between small steps as soon as they are not.
// Concurrency counts jobs in flight (model calls, file reads), not threads. Periodic jobs are
// scheduled with the injected clock, so tests can drive them.
import { systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';

/** @typedef {'interactive' | 'events' | 'background'} Lane */
/** @type {readonly Lane[]} */
export const LANES = Object.freeze(['interactive', 'events', 'background']);

/**
 * @typedef {object} JobContext
 * @property {AbortSignal} signal       aborted when the scheduler stops
 * @property {() => boolean} shouldYield true while work of a higher lane waits
 * @property {Lane} lane
 */

/**
 * @param {object} [options]
 * @param {number} [options.concurrency]         jobs in flight at most (default 4)
 * @param {number} [options.interactiveReserve]  slots only the interactive lane may use (default 1)
 * @param {import('../lib/clock.js').Clock} [options.clock]
 * @param {(err: unknown, lane: Lane, name: string) => void} [options.onError]
 */
export function createScheduler({ concurrency = 4, interactiveReserve = 1, clock = systemClock, onError = () => {} } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 2) throw new RangeError('scheduler: concurrency is at least 2');
  if (!Number.isInteger(interactiveReserve) || interactiveReserve < 0 || interactiveReserve >= concurrency) throw new RangeError('scheduler: the reserve must be below the concurrency');
  /** @type {Record<Lane, Array<{ name: string, run: (ctx: JobContext) => Promise<unknown>, resolve: (v: unknown) => void, reject: (e: unknown) => void }>>} */
  const queues = { interactive: [], events: [], background: [] };
  /** @type {Record<Lane, number>} */
  const running = { interactive: 0, events: 0, background: 0 };
  const paused = new Set();
  const controller = new AbortController();
  /** @type {Set<() => void>} */
  const periodic = new Set();
  let done = 0;
  let failed = 0;
  let stopped = false;

  const inFlight = () => running.interactive + running.events + running.background;
  /** @param {Lane} lane */
  const higherWaiting = (lane) => (lane === 'background' ? queues.interactive.length + queues.events.length > 0 : lane === 'events' && queues.interactive.length > 0);

  /** @param {Lane} lane */
  function canStart(lane) {
    if (paused.has(lane) || queues[lane].length === 0) return false;
    if (lane === 'interactive') return inFlight() < concurrency;
    if (running.events + running.background >= concurrency - interactiveReserve || inFlight() >= concurrency) return false;
    if (lane === 'background') return queues.interactive.length === 0 && queues.events.length === 0;
    return true;
  }

  function pump() {
    for (const lane of LANES) {
      while (canStart(lane)) {
        const job = /** @type {(typeof queues)[Lane][number]} */ (queues[lane].shift());
        running[lane] += 1;
        const ctx = { signal: controller.signal, shouldYield: () => higherWaiting(lane), lane };
        Promise.resolve()
          .then(() => job.run(ctx))
          .then(
            (value) => {
              done += 1;
              job.resolve(value);
            },
            (err) => {
              failed += 1;
              try {
                onError(err, lane, job.name);
              } catch {
                // the reporter must not break the queue
              }
              job.reject(err);
            },
          )
          .finally(() => {
            running[lane] -= 1;
            pump();
          });
      }
    }
  }

  return {
    /**
     * Runs a job in a lane; resolves with its result.
     * @template T
     * @param {Lane} lane
     * @param {string} name
     * @param {(ctx: JobContext) => Promise<T> | T} run
     * @returns {Promise<T>}
     */
    run(lane, name, run) {
      if (!LANES.includes(lane)) return Promise.reject(new TypeError(`unknown lane ${lane}`));
      if (stopped) return Promise.reject(fail('scheduler_stopped', 'the companion is stopping', { status: 503 }));
      return new Promise((resolve, reject) => {
        queues[lane].push({ name, run: async (ctx) => run(ctx), resolve: /** @type {(v: unknown) => void} */ (resolve), reject });
        pump();
      });
    },
    /**
     * Runs a job every `ms` in a lane (the first run after `ms`). A run that fails is reported and
     * the next one is scheduled anyway; runs never overlap.
     * @param {string} name
     * @param {number} ms
     * @param {(ctx: JobContext) => Promise<unknown> | unknown} run
     * @param {Lane} [lane]
     * @returns {() => void} cancels the job
     */
    every(name, ms, run, lane = 'background') {
      /** @type {unknown} */
      let timer = null;
      let cancelled = false;
      const arm = () => {
        if (cancelled || stopped) return;
        timer = clock.setTimeout(() => {
          this.run(lane, name, run).catch(() => {}).finally(arm);
        }, ms);
      };
      const cancel = () => {
        cancelled = true;
        if (timer !== null) clock.clearTimeout(timer);
        periodic.delete(cancel);
      };
      periodic.add(cancel);
      arm();
      return cancel;
    },
    /** @param {readonly Lane[]} lanes */
    pause(lanes) {
      for (const lane of lanes) paused.add(lane);
    },
    /** @param {readonly Lane[]} lanes */
    resume(lanes) {
      for (const lane of lanes) paused.delete(lane);
      pump();
    },
    stats: () => ({
      running: { ...running },
      queued: { interactive: queues.interactive.length, events: queues.events.length, background: queues.background.length },
      paused: [...paused].sort(),
      done,
      failed,
    }),
    /** Stops: cancels periodic jobs, refuses queued work, signals running jobs to abort. */
    stop() {
      stopped = true;
      for (const cancel of [...periodic]) cancel();
      for (const lane of LANES) for (const job of queues[lane].splice(0)) job.reject(fail('scheduler_stopped', 'the companion is stopping', { status: 503 }));
      controller.abort(fail('scheduler_stopped', 'the companion is stopping'));
    },
  };
}

/** @typedef {ReturnType<typeof createScheduler>} Scheduler */
