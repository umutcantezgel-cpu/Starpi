// @ts-check
// The circuit breaker of the whole companion. Two signals raise its level: the share of failed
// jobs in a sliding window (once enough jobs ran) and the resident memory. Levels, mildest first:
//   steady    everything runs;
//   slowed    background work pauses;
//   paused    only interactive work runs;
//   isolated  only interactive work, and only with local models (no cloud call leaves);
//   halted    only status requests are answered.
// Raising is automatic and only ever upward; stepping down needs the owner (`reset` with a reason),
// so a companion that went wrong does not quietly resume. Every change is handed to `onChange`,
// which records it in the audit chain.
import { systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';

/** @typedef {'steady' | 'slowed' | 'paused' | 'isolated' | 'halted'} Level */
/** @type {readonly Level[]} */
export const LEVELS = Object.freeze(['steady', 'slowed', 'paused', 'isolated', 'halted']);

/** @typedef {{ errorRate?: number, rssMb?: number }} Threshold */

/** Defaults: a generous margin over an idle companion with a small local model. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  slowed: Object.freeze({ errorRate: 0.3, rssMb: 1024 }),
  paused: Object.freeze({ errorRate: 0.5, rssMb: 1536 }),
  isolated: Object.freeze({ errorRate: 0.8, rssMb: 2048 }),
  halted: Object.freeze({ rssMb: 3072 }),
});

/**
 * @param {object} [options]
 * @param {number} [options.windowMs]
 * @param {number} [options.minEvents]   jobs in the window before the error rate counts
 * @param {Partial<Record<Exclude<Level, 'steady'>, Threshold>>} [options.thresholds]
 * @param {import('../lib/clock.js').Clock} [options.clock]
 * @param {(change: { from: Level, to: Level, reason: string, actor: string }) => void} [options.onChange]
 */
export function createBreaker({ windowMs = 60_000, minEvents = 20, thresholds = DEFAULT_THRESHOLDS, clock = systemClock, onChange = () => {} } = {}) {
  /** @type {Array<{ at: number, ok: boolean }>} */
  let events = [];
  /** @type {Level} */
  let level = 'steady';
  let lastRss = 0;
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const trim = () => {
    const from = clock.now() - windowMs;
    if (events.length > 0 && events[0].at < from) events = events.filter((e) => e.at >= from);
  };

  function errorRate() {
    trim();
    if (events.length < minEvents) return 0;
    return events.filter((e) => !e.ok).length / events.length;
  }

  /** @param {Level} to @param {string} reason @param {string} actor */
  function change(to, reason, actor) {
    const from = level;
    if (from === to) return;
    level = to;
    try {
      onChange({ from, to, reason, actor });
    } catch {
      // a failing recorder never undoes a level change
    }
  }

  function evaluate() {
    const rate = errorRate();
    /** @type {Level} */
    let target = 'steady';
    let reason = '';
    for (const candidate of /** @type {const} */ (['slowed', 'paused', 'isolated', 'halted'])) {
      const t = limits[candidate];
      if (!t) continue;
      if (t.errorRate !== undefined && rate >= t.errorRate) {
        target = candidate;
        reason = `error rate ${rate.toFixed(2)}`;
      }
      if (t.rssMb !== undefined && lastRss >= t.rssMb) {
        target = candidate;
        reason = `memory ${Math.round(lastRss)} MB`;
      }
    }
    if (LEVELS.indexOf(target) > LEVELS.indexOf(level)) change(target, reason, 'companion');
  }

  return {
    level: () => level,
    /**
     * Records the outcome of one job.
     * @param {boolean} ok
     */
    record(ok) {
      events.push({ at: clock.now(), ok });
      if (events.length > 10_000) events.shift();
      evaluate();
    },
    /**
     * Records the resident memory.
     * @param {{ rssMb: number }} sample
     */
    observe({ rssMb }) {
      lastRss = rssMb;
      evaluate();
    },
    /**
     * Whether work of a lane may run at the current level.
     * @param {'interactive' | 'events' | 'background' | 'status'} lane
     * @param {{ cloud?: boolean }} [options]
     */
    allows(lane, { cloud = false } = {}) {
      if (lane === 'status') return true;
      switch (level) {
        case 'steady':
          return true;
        case 'slowed':
          return lane !== 'background';
        case 'paused':
          return lane === 'interactive';
        case 'isolated':
          return lane === 'interactive' && !cloud;
        default:
          return false;
      }
    },
    /**
     * Steps back to steady (the only way down). Needs a named actor and a reason.
     * @param {{ actor: string, reason: string }} request
     */
    reset({ actor, reason }) {
      if (typeof actor !== 'string' || actor === '' || typeof reason !== 'string' || reason.trim().length < 3) throw fail('breaker_reset_invalid', 'a reset names who resets and why', { status: 400 });
      events = [];
      change('steady', reason.trim().slice(0, 200), actor);
    },
    stats: () => ({ level, errorRate: Number(errorRate().toFixed(3)), events: events.length, rssMb: Math.round(lastRss) }),
  };
}

/** @typedef {ReturnType<typeof createBreaker>} Breaker */
