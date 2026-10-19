// @ts-check
// Module `notify`: the inbox (inbox.js) on the hub for the other modules, and its routes:
//   GET    /v1/notify?after=<n>&unread=1      member  notifications after number n (oldest first)
//   GET    /v1/notify/stream?after=<n>        member  server-sent events: what came after n, then each
//                                                    new one as `notification`
//   POST   /v1/notify/:id/read                member  marks one as read
//   POST   /v1/notify/read-all                member  marks all as read
//   DELETE /v1/notify/:id                     member  removes one
// Numbers are never reused, also after the newest notification was removed. When `after` is higher
// than any number handed out (the inbox was erased or restored), the answer says `reset: true` and
// starts from the beginning, so the app never waits for numbers that will not come. Configuration (`modules.notify`): { "keepDays": 30, "maxItems": 1000, "streams": 8 }.
import { fail } from '../lib/errors.js';
import { intIn, moduleConfig, notFound, pushStream } from '../setup/kit.js';
import { createInbox } from './inbox.js';

export const NOTIFY_MODULE = 'notify';
export const INBOX_NAMESPACE = 'inbox';

/** @param {string | null} raw */
function afterOf(raw) {
  if (raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw fail('notify_after', 'after is a whole number', { status: 400 });
  return n;
}

/**
 * @param {{ hub: import('../setup/hub.js').Hub }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createNotifyModule({ hub }) {
  /** @type {import('./inbox.js').Inbox | null} */
  let inbox = null;
  let settings = { keepDays: 30, maxItems: 1000, streams: 8 };
  let streams = 0;
  /** @type {Set<() => void>} */
  const closers = new Set();
  /** @type {Array<() => void>} */
  const undo = [];
  const live = () => {
    if (!inbox) throw fail('module_stopped', 'the inbox is not running', { status: 503 });
    return inbox;
  };

  /** @param {number} after */
  function since(after) {
    const box = live();
    const first = box.list({ after });
    if (after > first.latest) return { ...box.list({ after: 0 }), reset: true };
    return { ...first, reset: false };
  }

  return {
    id: NOTIFY_MODULE,
    version: '1.0.0',
    title: 'Notifications',
    namespaces: [INBOX_NAMESPACE],
    routes: [
      {
        method: 'GET',
        path: '/',
        access: 'member',
        lane: 'status',
        handler(req) {
          const result = since(afterOf(req.query.get('after')));
          if (req.query.get('unread') === '1') result.notifications = result.notifications.filter((n) => !n.read);
          return { body: result };
        },
      },
      {
        method: 'GET',
        path: '/stream',
        access: 'member',
        lane: 'status',
        handler(req) {
          const box = live();
          if (streams >= settings.streams) throw fail('notify_streams', `at most ${settings.streams} notification streams at a time`, { status: 429 });
          const start = since(afterOf(req.query.get('after')));
          const out = pushStream({ signal: req.signal, max: 200 });
          streams += 1;
          out.push('hello', { latest: start.latest, reset: start.reset, unread: start.unread });
          for (const n of start.notifications) out.push('notification', n);
          const unsubscribe = box.subscribe((n) => out.push('notification', n));
          const close = () => {
            unsubscribe();
            out.end();
          };
          closers.add(close);
          req.signal.addEventListener(
            'abort',
            () => {
              closers.delete(close);
              unsubscribe();
              streams -= 1;
            },
            { once: true },
          );
          return { stream: out.iterable };
        },
      },
      {
        method: 'POST',
        path: '/read-all',
        access: 'member',
        lane: 'status',
        handler: () => ({ body: { read: live().markAllRead() } }),
      },
      {
        method: 'POST',
        path: '/:id/read',
        access: 'member',
        lane: 'status',
        handler(req) {
          const n = live().markRead(req.params.id);
          if (!n) throw notFound('notification_unknown', 'notification');
          return { body: { notification: n } };
        },
      },
      {
        method: 'DELETE',
        path: '/:id',
        access: 'member',
        handler(req) {
          if (!live().remove(req.params.id)) throw notFound('notification_unknown', 'notification');
          return { body: { deleted: true } };
        },
      },
    ],
    start(ctx) {
      settings = moduleConfig(NOTIFY_MODULE, ctx.config, { keepDays: intIn(1, 3650), maxItems: intIn(10, 100_000), streams: intIn(1, 64) }, settings);
      inbox = createInbox({ namespace: ctx.vault.namespace(INBOX_NAMESPACE), clock: ctx.clock, keepDays: settings.keepDays, maxItems: settings.maxItems });
      inbox.prune();
      undo.push(hub.provide('notify', inbox));
      undo.push(ctx.scheduler.every('notify.prune', 6 * 3_600_000, () => inbox?.prune()));
    },
    stop() {
      for (const close of [...closers]) close();
      closers.clear();
      for (const step of undo.splice(0).reverse()) step();
      inbox = null;
    },
  };
}
