// @ts-check
// Module `agenda`: reminders the user schedules, each with a rule (recurrence.js) and a time zone,
// sealed in the vault namespace `agenda`. One timer wakes the module at the earliest due item; a
// due reminder becomes a notification in the inbox (module `notify`), which the app reads over its
// event stream while it is open. There is no push service and no planned work runs a model here.
//   GET    /v1/agenda                     member  the items, the next due first
//   GET    /v1/agenda/upcoming?days=7     member  occurrences in the coming days
//   POST   /v1/agenda                     member  { title, note?, rule, timeZone?, dataClass? }
//   GET    /v1/agenda/:id                 member  one item
//   PUT    /v1/agenda/:id                 member  changes members (and plans the item anew)
//   DELETE /v1/agenda/:id                 member  deletes it
// The time zone of an item is its own `timeZone`, else `modules.agenda.timeZone`, else the
// companion's (the configured `timeZone`, or the machine's as Intl reports it).
// After a stop, a reminder that fell due at most `catchUpMinutes` ago (default 120) still fires
// once, late; an older one is reported as missed and planned anew.
// Configuration (`modules.agenda`): { "timeZone": null, "catchUpMinutes": 120, "maxItems": 500 }.
import { isRecord } from '../contracts/check.js';
import { classRank, isDataClass } from '../contracts/data-classes.js';
import { isoAt } from '../lib/clock.js';
import { codeOf, fail } from '../lib/errors.js';
import { actorOf, bodyOf, idPattern, intIn, moduleConfig, newId, notFound } from '../setup/kit.js';
import { checkRule, isTimeZone, localText, nextRun, ruleProblems } from './recurrence.js';

export const AGENDA_MODULE = 'agenda';
export const AGENDA_NAMESPACE = 'agenda';
/** The timer is never armed further ahead than this; it then looks again (sleep, clock changes). */
export const MAX_SLEEP_MS = 3_600_000;
const ITEM_ID = idPattern('agd');

/**
 * @typedef {object} AgendaItem
 * @property {string} id
 * @property {string} title
 * @property {string} note
 * @property {import('./recurrence.js').Rule} rule
 * @property {string | null} timeZone
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {boolean} active
 * @property {string | null} next        the next time it is due (ISO), null when it never is again
 * @property {string | null} lastRun
 * @property {number} runs
 * @property {string} created
 * @property {string} updated
 */

/**
 * What other modules may use.
 * @typedef {object} AgendaService
 * @property {(options?: { days?: number, max?: number, maxClass?: import('../contracts/data-classes.js').DataClass }) => Array<{ id: string, title: string, at: string, local: string, timeZone: string, dataClass: import('../contracts/data-classes.js').DataClass }>} upcoming
 * @property {() => AgendaItem[]} list
 */

/**
 * Problems of the editable members of an item.
 * @param {Record<string, unknown>} body
 * @param {boolean} partial
 */
function itemProblems(body, partial) {
  /** @type {string[]} */
  const problems = [];
  for (const k of Object.keys(body)) if (!['title', 'note', 'rule', 'timeZone', 'dataClass', 'active'].includes(k)) problems.push(`${k}: not a member`);
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '' || body.title.length > 200) problems.push('title: 1 to 200 characters');
  }
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 4000)) problems.push('note: at most 4000 characters');
  if (!partial || body.rule !== undefined) problems.push(...ruleProblems(body.rule));
  if (body.timeZone !== undefined && body.timeZone !== null && !isTimeZone(body.timeZone)) problems.push('timeZone: an IANA time zone such as America/New_York');
  if (body.dataClass !== undefined && !isDataClass(body.dataClass)) problems.push('dataClass: public, personal, sensitive or secret');
  if (body.active !== undefined && typeof body.active !== 'boolean') problems.push('active: true or false');
  return problems;
}

/**
 * @param {{ hub: import('../setup/hub.js').Hub }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createAgendaModule({ hub }) {
  /** @type {any} */
  let ctx = null;
  /** @type {any} */
  let ns = null;
  let settings = { timeZone: /** @type {string | null} */ (null), catchUpMinutes: 120, maxItems: 500 };
  let zone = 'UTC';
  /** @type {unknown} */
  let timer = null;
  let running = false;
  /** @type {(() => void) | null} */
  let withdraw = null;

  const now = () => ctx.clock.now();
  /** @param {AgendaItem} item */
  const zoneOf = (item) => item.timeZone ?? zone;

  /** @returns {AgendaItem[]} */
  function all() {
    if (!ns) throw fail('module_stopped', 'the agenda is not running', { status: 503 });
    /** @type {AgendaItem[]} */
    const out = [];
    for (const { id } of ns.list()) {
      if (!ITEM_ID.test(id)) continue;
      const value = ns.getJson(id);
      if (isRecord(value) && value.id === id) out.push(/** @type {AgendaItem} */ (/** @type {unknown} */ (value)));
    }
    return out;
  }

  /** @param {AgendaItem} item */
  const save = (item) => ns.putJson(item.id, item);

  /** @param {string} id */
  function itemOf(id) {
    if (!ITEM_ID.test(id) || !ns) throw notFound('agenda_unknown', 'agenda item');
    const value = ns.getJson(id);
    if (!isRecord(value)) throw notFound('agenda_unknown', 'agenda item');
    return /** @type {AgendaItem} */ (/** @type {unknown} */ (value));
  }

  /**
   * The item planned from an instant on.
   * @param {AgendaItem} item
   * @param {number} from
   * @returns {AgendaItem}
   */
  function plan(item, from) {
    const next = item.active ? nextRun(item.rule, from, zoneOf(item)) : null;
    return { ...item, next: next === null ? null : isoAt(next), active: item.active && next !== null };
  }

  /** Arms the one timer for the earliest due item. */
  function arm() {
    if (timer !== null) ctx.clock.clearTimeout(timer);
    timer = null;
    if (!ns) return;
    const due = all().filter((i) => i.active && i.next !== null).map((i) => Date.parse(/** @type {string} */ (i.next)));
    if (due.length === 0) return;
    const wait = Math.max(0, Math.min(Math.min(...due) - now(), MAX_SLEEP_MS));
    timer = ctx.clock.setTimeout(() => {
      timer = null;
      fire();
    }, wait);
  }

  /** Fires every item that is due now. */
  function fire() {
    if (running || !ns) return;
    running = true;
    try {
      const at = now();
      const inbox = hub.get('notify');
      for (const item of all()) {
        if (!item.active || item.next === null || Date.parse(item.next) > at) continue;
        const late = at - Date.parse(item.next);
        const missed = late > settings.catchUpMinutes * 60_000;
        try {
          inbox?.post({ kind: missed ? 'reminder_missed' : 'reminder', ref: item.id, title: item.title, dataClass: item.dataClass });
        } catch (err) {
          ctx.log('warn', 'reminder_not_posted', { id: item.id, code: codeOf(err) });
        }
        save(plan({ ...item, lastRun: isoAt(at), runs: item.runs + (missed ? 0 : 1) }, at));
      }
    } finally {
      running = false;
      arm();
    }
  }

  /** @param {AgendaItem} item */
  const view = (item) => ({ ...item, timeZoneUsed: zoneOf(item), nextLocal: item.next ? localText(Date.parse(item.next), zoneOf(item)) : null });

  /** @type {AgendaService} */
  const service = {
    upcoming({ days = 7, max = 50, maxClass = 'secret' } = {}) {
      const from = now();
      const until = from + days * 86_400_000;
      /** @type {Array<{ id: string, title: string, at: string, local: string, timeZone: string, dataClass: import('../contracts/data-classes.js').DataClass }>} */
      const out = [];
      for (const item of all()) {
        if (!item.active || classRank(item.dataClass) > classRank(maxClass)) continue;
        let t = item.next ? Date.parse(item.next) : null;
        // Occurrences inside the window; `next` may be overdue by a moment.
        for (let i = 0; t !== null && t <= until && i < max; i += 1) {
          out.push({ id: item.id, title: item.title, at: isoAt(t), local: localText(t, zoneOf(item)), timeZone: zoneOf(item), dataClass: item.dataClass });
          t = nextRun(item.rule, t, zoneOf(item));
        }
      }
      return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1)).slice(0, max);
    },
    list: () => all().sort((a, b) => (a.next ?? '~').localeCompare(b.next ?? '~')),
  };

  return {
    id: AGENDA_MODULE,
    version: '1.0.0',
    title: 'Agenda',
    namespaces: [AGENDA_NAMESPACE],
    routes: [
      {
        method: 'GET',
        path: '/',
        access: 'member',
        handler: () => ({ body: { timeZone: zone, items: service.list().map(view) } }),
      },
      {
        method: 'GET',
        path: '/upcoming',
        access: 'member',
        handler(req) {
          const days = Number(req.query.get('days') ?? '7');
          if (!Number.isInteger(days) || days < 1 || days > 366) throw fail('agenda_days', 'days is 1 to 366', { status: 400 });
          return { body: { timeZone: zone, occurrences: service.upcoming({ days, max: 500 }) } };
        },
      },
      {
        method: 'POST',
        path: '/',
        access: 'member',
        maxBody: 16 * 1024,
        handler(req) {
          const body = bodyOf(req);
          const problems = itemProblems(body, false);
          if (problems.length > 0) throw fail('agenda_invalid', problems.join('; '), { status: 400, details: { problems } });
          if (all().length >= settings.maxItems) throw fail('agenda_full', `the agenda holds at most ${settings.maxItems} items`, { status: 409 });
          const at = isoAt(now());
          /** @type {AgendaItem} */
          const draft = {
            id: newId('agd'),
            title: /** @type {string} */ (body.title).trim(),
            note: /** @type {string | undefined} */ (body.note) ?? '',
            rule: checkRule(body.rule),
            timeZone: /** @type {string | null | undefined} */ (body.timeZone) ?? null,
            dataClass: /** @type {any} */ (body.dataClass) ?? 'personal',
            active: body.active !== false,
            next: null,
            lastRun: null,
            runs: 0,
            created: at,
            updated: at,
          };
          const item = plan(draft, now());
          save(item);
          ctx.audit.append({ kind: 'agenda.added', subject: item.id, actor: actorOf(req), details: { rule: item.rule.type, dataClass: item.dataClass } });
          arm();
          return { status: 201, body: { item: view(item) } };
        },
      },
      {
        method: 'GET',
        path: '/:id',
        access: 'member',
        handler: (req) => ({ body: { item: view(itemOf(req.params.id)) } }),
      },
      {
        method: 'PUT',
        path: '/:id',
        access: 'member',
        maxBody: 16 * 1024,
        handler(req) {
          const body = bodyOf(req);
          const problems = itemProblems(body, true);
          if (problems.length > 0) throw fail('agenda_invalid', problems.join('; '), { status: 400, details: { problems } });
          const before = itemOf(req.params.id);
          /** @type {AgendaItem} */
          const changed = {
            ...before,
            title: typeof body.title === 'string' ? body.title.trim() : before.title,
            note: typeof body.note === 'string' ? body.note : before.note,
            rule: body.rule !== undefined ? checkRule(body.rule) : before.rule,
            timeZone: body.timeZone !== undefined ? /** @type {string | null} */ (body.timeZone) : before.timeZone,
            dataClass: /** @type {any} */ (body.dataClass) ?? before.dataClass,
            active: typeof body.active === 'boolean' ? body.active : before.active,
            updated: isoAt(now()),
          };
          const item = plan(changed, now());
          save(item);
          ctx.audit.append({ kind: 'agenda.changed', subject: item.id, actor: actorOf(req), details: { rule: item.rule.type, active: item.active } });
          arm();
          return { body: { item: view(item) } };
        },
      },
      {
        method: 'DELETE',
        path: '/:id',
        access: 'member',
        handler(req) {
          const item = itemOf(req.params.id);
          ns.delete(item.id);
          ctx.audit.append({ kind: 'agenda.deleted', subject: item.id, actor: actorOf(req) });
          arm();
          return { body: { deleted: true, id: item.id } };
        },
      },
    ],
    start(context) {
      ctx = context;
      settings = moduleConfig(
        AGENDA_MODULE,
        ctx.config,
        { timeZone: (v) => (v === null || isTimeZone(v) ? null : 'an IANA time zone or null'), catchUpMinutes: intIn(0, 10_080), maxItems: intIn(1, 10_000) },
        settings,
      );
      zone = settings.timeZone ?? ctx.timeZone;
      ns = ctx.vault.namespace(AGENDA_NAMESPACE);
      // Items whose time passed while the companion was stopped fire now (late) or are reported missed.
      fire();
      withdraw = hub.provide('agenda', service);
    },
    stop() {
      if (timer !== null) ctx.clock.clearTimeout(timer);
      timer = null;
      withdraw?.();
      withdraw = null;
      ns = null;
    },
  };
}

