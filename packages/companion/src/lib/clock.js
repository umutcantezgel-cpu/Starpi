// @ts-check
// Time for the whole companion comes through one small interface, so tests can drive it: `now()` in
// epoch milliseconds and timers that a fake clock can fire on demand.

/**
 * @typedef {object} Clock
 * @property {() => number} now                                    epoch milliseconds
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/** The real clock. @type {Clock} */
export const systemClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // A periodic job of the companion never keeps the process alive on its own.
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
});

/**
 * A clock for tests: time moves only through `advance(ms)`, which fires every timer that falls due,
 * in order of their due time.
 * @param {number} [start]
 */
export function manualClock(start = Date.UTC(2026, 0, 1)) {
  let current = start;
  let nextId = 1;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  return {
    now: () => current,
    /** @param {() => void} fn @param {number} ms */
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return id;
    },
    /** @param {unknown} handle */
    clearTimeout(handle) {
      timers.delete(/** @type {number} */ (handle));
    },
    /** @param {number} ms */
    advance(ms) {
      const until = current + ms;
      // A callback may add or clear timers, so the earliest one is looked up afresh each round.
      const earliest = () => {
        let pick = 0;
        let pickAt = Infinity;
        timers.forEach((entry, id) => {
          if (entry.at <= until && entry.at < pickAt) [pick, pickAt] = [id, entry.at];
        });
        return pick;
      };
      let id = earliest();
      while (id !== 0) {
        const entry = /** @type {{ at: number, fn: () => void }} */ (timers.get(id));
        timers.delete(id);
        if (entry.at > current) current = entry.at;
        entry.fn();
        id = earliest();
      }
      current = until;
    },
    pending: () => timers.size,
  };
}

/** ISO 8601 text of an epoch time in milliseconds. @param {number} ms */
export const isoAt = (ms) => new Date(ms).toISOString();

/**
 * The time zone the companion reports dates in: the configured IANA name when it is valid, else the
 * zone of the machine as Intl knows it, else UTC.
 * @param {string | null | undefined} [configured]
 */
export function resolveTimeZone(configured) {
  if (typeof configured === 'string' && configured !== '') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: configured });
      return configured;
    } catch {
      // fall through to the machine's zone
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
