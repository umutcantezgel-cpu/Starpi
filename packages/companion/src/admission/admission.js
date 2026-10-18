// @ts-check
// Admission of local model slots against a memory budget. The companion runs no model itself; it
// asks local servers (Ollama, llama.cpp) to, and those load models into the same machine's memory.
// Before a request to a local model it takes a lease for that model's configured size: requests to
// a model that is loaded already share its lease, others wait until enough of the budget is free.
// Waiting requests are served by lane (interactive, events, background), then by arrival; background
// work must leave `reserveMb` free, so an interactive request can still load a small model.
import { systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';

const RANK = Object.freeze({ interactive: 0, events: 1, background: 2 });

/**
 * @typedef {object} Lease
 * @property {string} model
 * @property {() => void} release  idempotent
 */

/**
 * @param {object} options
 * @param {number} options.budgetMb
 * @param {number} [options.reserveMb]
 * @param {number} [options.timeoutMs]
 * @param {import('../lib/clock.js').Clock} [options.clock]
 */
export function createAdmission({ budgetMb, reserveMb = 0, timeoutMs = 30_000, clock = systemClock }) {
  if (!(budgetMb > 0)) throw new RangeError('admission: the budget must be positive');
  /** @type {Map<string, { sizeMb: number, holders: number }>} */
  const active = new Map();
  /** @type {Array<{ model: string, sizeMb: number, lane: keyof typeof RANK, seq: number, grant: (lease: Lease) => void, refuse: (err: unknown) => void }>} */
  const waiting = [];
  let seq = 0;

  const usedMb = () => [...active.values()].reduce((sum, a) => sum + a.sizeMb, 0);

  /** @param {string} model */
  function lease(model) {
    const entry = /** @type {{ sizeMb: number, holders: number }} */ (active.get(model));
    entry.holders += 1;
    let released = false;
    return {
      model,
      release() {
        if (released) return;
        released = true;
        entry.holders -= 1;
        if (entry.holders === 0) active.delete(model);
        pump();
      },
    };
  }

  /** @param {{ model: string, sizeMb: number, lane: keyof typeof RANK }} w */
  function fits(w) {
    if (active.has(w.model)) return true;
    const free = budgetMb - usedMb();
    const keep = w.lane === 'background' ? reserveMb : 0;
    return w.sizeMb <= free - keep;
  }

  function pump() {
    waiting.sort((a, b) => RANK[a.lane] - RANK[b.lane] || a.seq - b.seq);
    for (let i = 0; i < waiting.length; ) {
      const w = waiting[i];
      if (fits(w)) {
        waiting.splice(i, 1);
        if (!active.has(w.model)) active.set(w.model, { sizeMb: w.sizeMb, holders: 0 });
        w.grant(lease(w.model));
      } else {
        // A waiting request of a higher lane is never overtaken by a lower one.
        if (RANK[w.lane] < 2) break;
        i += 1;
      }
    }
  }

  return {
    /**
     * Waits for a lease.
     * @param {{ model: string, sizeMb: number, lane?: keyof typeof RANK, signal?: AbortSignal }} request
     * @returns {Promise<Lease>}
     */
    acquire({ model, sizeMb, lane = 'interactive', signal }) {
      if (!(sizeMb >= 0) || sizeMb > budgetMb) return Promise.reject(fail('admission_too_large', `${model} needs ${sizeMb} MB, the budget is ${budgetMb} MB`, { status: 503 }));
      return new Promise((resolve, reject) => {
        const entry = { model, sizeMb, lane, seq: seq++, grant: (/** @type {Lease} */ l) => settle(() => resolve(l)), refuse: (/** @type {unknown} */ e) => settle(() => reject(e)) };
        let settled = false;
        const timer = clock.setTimeout(() => entry.refuse(fail('admission_timeout', `no memory for ${model} within ${timeoutMs} ms`, { status: 503 })), timeoutMs);
        const onAbort = () => entry.refuse(signal?.reason ?? new DOMException('aborted', 'AbortError'));
        /** @param {() => void} fn */
        function settle(fn) {
          if (settled) return;
          settled = true;
          clock.clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          fn();
        }
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        waiting.push(entry);
        pump();
      });
    },
    stats: () => ({ budgetMb, usedMb: usedMb(), models: [...active.keys()].sort(), waiting: waiting.length }),
  };
}

/** @typedef {ReturnType<typeof createAdmission>} Admission */
