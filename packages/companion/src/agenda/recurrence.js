// @ts-check
// When an agenda item is due next, in the local time of an IANA time zone, computed with Intl
// alone (no date library). Rules:
//   { type: 'once',    date: 'YYYY-MM-DD', time: 'HH:MM' }
//   { type: 'daily',   time }
//   { type: 'weekly',  days: [1..7] (Monday = 1), time }
//   { type: 'monthly', day: 1..31 | 'last', time }   a day the month does not have means its last day
// Daylight saving time, where a local time and an instant part ways:
//   - a local time that does not exist that day (the clock jumps forward over it) is moved to the
//     first minute after the jump;
//   - a local time that happens twice (the clock goes back) is taken at its first occurrence.
// Pure: the instant to start from is a parameter.
import { fail } from '../lib/errors.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** How far ahead a rule is searched. */
const HORIZON_DAYS = 800;

/** @typedef {{ type: 'once', date: string, time: string } | { type: 'daily', time: string } | { type: 'weekly', days: number[], time: string } | { type: 'monthly', day: number | 'last', time: string }} Rule */

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/** @param {string} zone */
function format(zone) {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(zone, f);
  }
  return f;
}

/** Whether Intl knows a zone. @param {unknown} zone */
export function isTimeZone(zone) {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  try {
    return format(zone).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}

/**
 * The local calendar fields of an instant.
 * @param {number} ms
 * @param {string} zone
 */
export function localFields(ms, zone) {
  /** @type {Record<string, number>} */
  const f = {};
  for (const part of format(zone).formatToParts(new Date(ms))) if (part.type !== 'literal') f[part.type] = Number(part.value);
  return { year: f.year, month: f.month, day: f.day, hour: f.hour, minute: f.minute, second: f.second };
}

/** Minutes since 0000-01-01 of local fields, for comparisons. @param {{ year: number, month: number, day: number, hour: number, minute: number }} f */
const stamp = (f) => Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) / MINUTE;

/** The zone's offset from UTC at an instant, in ms. @param {number} ms @param {string} zone */
function offsetAt(ms, zone) {
  const f = localFields(ms, zone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of a local date and time in a zone, by the daylight saving rules above.
 * @param {{ year: number, month: number, day: number, hour: number, minute: number }} local
 * @param {string} zone
 */
export function instantOf(local, zone) {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const want = stamp(local);
  const candidates = [...new Set([naive - offsetAt(naive - 12 * 3_600_000, zone), naive - offsetAt(naive + 12 * 3_600_000, zone), naive - offsetAt(naive, zone)])].sort((a, b) => a - b);
  const exact = candidates.filter((c) => stamp(localFields(c, zone)) === want);
  if (exact.length > 0) return exact[0];
  // The local time falls into a jump: the first instant whose local time is at or after it.
  let lo = candidates[0] - 3 * 3_600_000;
  let hi = candidates[candidates.length - 1] + 3 * 3_600_000;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (stamp(localFields(mid, zone)) >= want) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Problems of a rule, empty when it is valid.
 * @param {unknown} rule
 * @returns {string[]}
 */
export function ruleProblems(rule) {
  const r = /** @type {any} */ (rule);
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return ['rule: an object'];
  const keys = { once: ['type', 'date', 'time'], daily: ['type', 'time'], weekly: ['type', 'days', 'time'], monthly: ['type', 'day', 'time'] };
  if (!Object.hasOwn(keys, r.type)) return ['rule.type: once, daily, weekly or monthly'];
  /** @type {string[]} */
  const problems = [];
  for (const k of Object.keys(r)) if (!keys[/** @type {keyof typeof keys} */ (r.type)].includes(k)) problems.push(`rule.${k}: not a member of a ${r.type} rule`);
  if (typeof r.time !== 'string' || !TIME.test(r.time)) problems.push('rule.time: HH:MM (24 hours)');
  if (r.type === 'once') {
    const m = typeof r.date === 'string' ? DATE.exec(r.date) : null;
    const valid = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === r.date;
    if (!valid) problems.push('rule.date: a date YYYY-MM-DD');
  }
  if (r.type === 'weekly' && (!Array.isArray(r.days) || r.days.length === 0 || r.days.length > 7 || new Set(r.days).size !== r.days.length || !r.days.every((/** @type {unknown} */ d) => Number.isInteger(d) && /** @type {number} */ (d) >= 1 && /** @type {number} */ (d) <= 7))) {
    problems.push('rule.days: distinct weekdays 1 (Monday) to 7 (Sunday)');
  }
  if (r.type === 'monthly' && r.day !== 'last' && !(Number.isInteger(r.day) && r.day >= 1 && r.day <= 31)) problems.push("rule.day: 1 to 31 or 'last'");
  return problems;
}

/**
 * Throws a 400 for an invalid rule.
 * @param {unknown} rule
 * @returns {Rule}
 */
export function checkRule(rule) {
  const problems = ruleProblems(rule);
  if (problems.length > 0) throw fail('agenda_rule', problems.join('; '), { status: 400, details: { problems } });
  return /** @type {Rule} */ (rule);
}

/** @param {number} year @param {number} month */
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The first time a rule is due strictly after an instant, or null when it never is again.
 * @param {Rule} rule
 * @param {number} afterMs
 * @param {string} zone
 * @returns {number | null}
 */
export function nextRun(rule, afterMs, zone) {
  const [hour, minute] = rule.time.split(':').map(Number);
  if (rule.type === 'once') {
    const [year, month, day] = rule.date.split('-').map(Number);
    const at = instantOf({ year, month, day, hour, minute }, zone);
    return at > afterMs ? at : null;
  }
  const start = localFields(afterMs, zone);
  const base = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i <= HORIZON_DAYS; i += 1) {
    const d = new Date(base + i * DAY);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const weekday = ((d.getUTCDay() + 6) % 7) + 1;
    if (rule.type === 'weekly' && !rule.days.includes(weekday)) continue;
    if (rule.type === 'monthly') {
      const last = daysIn(year, month);
      const target = rule.day === 'last' ? last : Math.min(rule.day, last);
      if (day !== target) continue;
    }
    const at = instantOf({ year, month, day, hour, minute }, zone);
    if (at > afterMs) return at;
  }
  return null;
}

/**
 * An instant as local text: "2026-03-08 03:00" in the zone.
 * @param {number} ms
 * @param {string} zone
 */
export function localText(ms, zone) {
  const f = localFields(ms, zone);
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${f.year}-${two(f.month)}-${two(f.day)} ${two(f.hour)}:${two(f.minute)}`;
}
