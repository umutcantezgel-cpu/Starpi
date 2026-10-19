// @ts-check
// The inbox: short notifications the companion has for its user (a reminder is due, a document
// is ready, a tool waits for an approval, a feed went quiet). There is no push service: while the
// app is open it reads them over a server-sent event stream and, after a gap, asks for everything
// after the last number it saw. Notifications are sealed in the vault namespace `inbox`; each has a
// rising number, a kind code the app translates, an optional reference (the id of what it is about)
// and an optional title. The title of something secret is never kept. A number is never handed out
// twice: the highest one is kept as a mark of its own, so removing or pruning the newest
// notification does not free its number for the next (which an app catching up after it would miss).
import { isRecord } from '../contracts/check.js';
import { isDataClass } from '../contracts/data-classes.js';
import { isoAt, systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';
import { clip } from '../setup/kit.js';

export const KIND = /^[a-z][a-z0-9_]{1,39}$/;
export const REF = /^[A-Za-z0-9_.:-]{1,128}$/;
export const TITLE_MAX = 200;
const ITEM = /^n-(\d{12})$/;
/** The item that keeps the highest number handed out so far. */
const MARK = 'mark';

/**
 * @typedef {object} Notification
 * @property {string} id
 * @property {number} seq
 * @property {string} kind
 * @property {string | null} ref
 * @property {string | null} title
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {string} at
 * @property {boolean} read
 */

/**
 * @param {object} options
 * @param {{ list(): Array<{ id: string }>, getJson(id: string): unknown, putJson(id: string, value: unknown): unknown, delete(id: string): boolean }} options.namespace
 * @param {import('../lib/clock.js').Clock} [options.clock]
 * @param {number} [options.keepDays]
 * @param {number} [options.maxItems]
 */
export function createInbox({ namespace, clock = systemClock, keepDays = 30, maxItems = 1000 }) {
  /** @type {Set<(n: Notification) => void>} */
  const listeners = new Set();
  /** @param {number} seq */
  const idOf = (seq) => `n-${String(seq).padStart(12, '0')}`;

  /** Stored notifications, oldest first. @returns {Notification[]} */
  function all() {
    /** @type {Notification[]} */
    const out = [];
    for (const { id } of namespace.list()) {
      if (!ITEM.test(id)) continue;
      const value = namespace.getJson(id);
      if (isRecord(value) && typeof value.seq === 'number') out.push(/** @type {Notification} */ (/** @type {unknown} */ (value)));
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /**
   * The highest number handed out so far: the mark, or the newest stored number when that is
   * higher (a mark that was never written or a write that did not finish).
   * @param {Notification[]} items  stored notifications, oldest first
   */
  function highest(items) {
    const mark = namespace.getJson(MARK);
    const kept = isRecord(mark) && Number.isSafeInteger(mark.seq) ? /** @type {number} */ (mark.seq) : 0;
    return Math.max(kept, items.at(-1)?.seq ?? 0);
  }

  /** Drops notifications older than keepDays, then the oldest read ones above maxItems. */
  function prune() {
    const items = all();
    const cutoff = clock.now() - keepDays * 86_400_000;
    let removed = 0;
    for (const n of items) {
      if (Date.parse(n.at) < cutoff) {
        namespace.delete(n.id);
        removed += 1;
      }
    }
    let left = items.filter((n) => Date.parse(n.at) >= cutoff);
    for (const n of [...left.filter((x) => x.read), ...left.filter((x) => !x.read)]) {
      if (left.length <= maxItems) break;
      namespace.delete(n.id);
      left = left.filter((x) => x.id !== n.id);
      removed += 1;
    }
    return removed;
  }

  return {
    /**
     * Adds a notification and tells every listener.
     * @param {{ kind: string, ref?: string | null, title?: string | null, dataClass?: import('../contracts/data-classes.js').DataClass }} input
     * @returns {Notification}
     */
    post(input) {
      if (!KIND.test(input.kind)) throw fail('notification_kind', 'a kind is a lower-case code', { status: 400 });
      if (input.ref !== undefined && input.ref !== null && !REF.test(input.ref)) throw fail('notification_ref', 'a reference is an id', { status: 400 });
      const dataClass = isDataClass(input.dataClass) ? input.dataClass : 'personal';
      const items = all();
      const seq = highest(items) + 1;
      /** @type {Notification} */
      const n = {
        id: idOf(seq),
        seq,
        kind: input.kind,
        ref: input.ref ?? null,
        title: dataClass === 'secret' || typeof input.title !== 'string' || input.title.trim() === '' ? null : clip(input.title.trim().replace(/\s+/g, ' '), TITLE_MAX),
        dataClass,
        at: isoAt(clock.now()),
        read: false,
      };
      namespace.putJson(n.id, n);
      namespace.putJson(MARK, { seq });
      if (items.length + 1 > maxItems) prune();
      for (const listener of listeners) {
        try {
          listener(n);
        } catch {
          // a listener's failure never stops the others
        }
      }
      return n;
    },
    /**
     * Notifications after a number, oldest first; `latest` is the highest number handed out so far
     * (also when that notification is gone).
     * @param {{ after?: number, limit?: number, unread?: boolean }} [query]
     */
    list({ after = 0, limit = 200, unread = false } = {}) {
      const stored = all();
      const items = stored.filter((n) => n.seq > after && (!unread || !n.read));
      return { notifications: items.slice(0, limit), latest: highest(stored), unread: items.filter((n) => !n.read).length };
    },
    /** @param {string} id */
    markRead(id) {
      if (!ITEM.test(id)) return null;
      const value = namespace.getJson(id);
      if (!isRecord(value)) return null;
      const n = { .../** @type {Notification} */ (/** @type {unknown} */ (value)), read: true };
      namespace.putJson(id, n);
      return n;
    },
    markAllRead() {
      let count = 0;
      for (const n of all()) {
        if (n.read) continue;
        namespace.putJson(n.id, { ...n, read: true });
        count += 1;
      }
      return count;
    },
    /** @param {string} id */
    remove: (id) => ITEM.test(id) && namespace.delete(id),
    prune,
    /**
     * Calls `listener` for every new notification; returns the function that stops it.
     * @param {(n: Notification) => void} listener
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listeners: () => listeners.size,
  };
}

/** @typedef {ReturnType<typeof createInbox>} Inbox */
