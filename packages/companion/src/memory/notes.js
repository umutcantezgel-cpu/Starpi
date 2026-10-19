// @ts-check
// A note as the memory keeps it: text written by a person (or saved from an answer on request),
// sealed in the vault namespace `notes`, one item per note. Besides the text it carries what the
// ranking needs: when it was written and changed, whether its owner pinned it, and how often and
// on how many different days it was recalled. A note is only ever added on purpose (a request with
// its text); nothing is collected behind the user's back.
import { isRecord } from '../contracts/check.js';
import { isDataClass } from '../contracts/data-classes.js';
import { fail } from '../lib/errors.js';

export const NOTE_TEXT_MAX = 20_000;
export const NOTE_TITLE_MAX = 200;
export const NOTE_TAGS_MAX = 16;
/** Recall days remembered per note (enough for the spread the ranking looks at). */
export const RECALL_DAYS_KEPT = 30;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,39}$/u;

/**
 * @typedef {object} Note
 * @property {string} id
 * @property {string} text
 * @property {string} title
 * @property {string[]} tags
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {boolean} pinned          a pinned note does not fade
 * @property {string} created
 * @property {string} updated
 * @property {{ count: number, last: string | null, days: string[] }} recalls  days as YYYY-MM-DD (UTC)
 */

/**
 * Problems of the editable members of a note (a new one or a change).
 * @param {Record<string, unknown>} input
 * @param {{ partial: boolean }} options
 * @returns {string[]}
 */
export function noteProblems(input, { partial }) {
  /** @type {string[]} */
  const problems = [];
  for (const key of Object.keys(input)) if (!['text', 'title', 'tags', 'dataClass', 'pinned'].includes(key)) problems.push(`${key}: not a member`);
  if (!partial || input.text !== undefined) {
    if (typeof input.text !== 'string' || input.text.trim() === '' || input.text.length > NOTE_TEXT_MAX) problems.push(`text: 1 to ${NOTE_TEXT_MAX} characters`);
  }
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > NOTE_TITLE_MAX)) problems.push(`title: at most ${NOTE_TITLE_MAX} characters`);
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > NOTE_TAGS_MAX || !input.tags.every((t) => typeof t === 'string' && TAG.test(t)))) {
    problems.push(`tags: at most ${NOTE_TAGS_MAX} words of letters, digits, _ . - (40 characters each)`);
  }
  if (input.dataClass !== undefined && !isDataClass(input.dataClass)) problems.push('dataClass: public, personal, sensitive or secret');
  if (input.pinned !== undefined && typeof input.pinned !== 'boolean') problems.push('pinned: true or false');
  return problems;
}

/** The title shown for a note: its own, or the start of its first line. @param {string} text */
export function derivedTitle(text) {
  const first = text.trim().split('\n')[0].trim();
  const chars = [...first];
  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : first;
}

/**
 * A new note.
 * @param {string} id
 * @param {Record<string, unknown>} input  checked with noteProblems
 * @param {string} at
 * @returns {Note}
 */
export function makeNote(id, input, at) {
  const text = /** @type {string} */ (input.text);
  return {
    id,
    text,
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : derivedTitle(text),
    tags: [...new Set(/** @type {string[]} */ (input.tags ?? []))],
    dataClass: /** @type {any} */ (input.dataClass) ?? 'personal',
    pinned: input.pinned === true,
    created: at,
    updated: at,
    recalls: { count: 0, last: null, days: [] },
  };
}

/**
 * A note with changes applied.
 * @param {Note} note
 * @param {Record<string, unknown>} input  checked with noteProblems (partial)
 * @param {string} at
 * @returns {Note}
 */
export function changeNote(note, input, at) {
  const text = typeof input.text === 'string' ? input.text : note.text;
  const title = typeof input.title === 'string' ? (input.title.trim() || derivedTitle(text)) : note.title;
  return {
    ...note,
    text,
    title,
    tags: input.tags !== undefined ? [...new Set(/** @type {string[]} */ (input.tags))] : note.tags,
    dataClass: /** @type {any} */ (input.dataClass) ?? note.dataClass,
    pinned: typeof input.pinned === 'boolean' ? input.pinned : note.pinned,
    updated: at,
  };
}

/**
 * The note after a recall at a time.
 * @param {Note} note
 * @param {string} at
 * @returns {Note}
 */
export function noteRecalled(note, at) {
  const day = at.slice(0, 10);
  const days = note.recalls.days.includes(day) ? note.recalls.days : [...note.recalls.days, day].slice(-RECALL_DAYS_KEPT);
  return { ...note, recalls: { count: note.recalls.count + 1, last: at, days } };
}

/**
 * A stored note read back, checked; a damaged item is reported instead of guessed at.
 * @param {unknown} value
 * @returns {Note}
 */
export function readNote(value) {
  const v = /** @type {any} */ (value);
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.text !== 'string' || !isDataClass(v.dataClass) || !isRecord(v.recalls)) throw fail('note_unreadable', 'a stored note is damaged');
  return /** @type {Note} */ (v);
}

/** What a list shows of a note (no full text). @param {Note} note */
export const noteSummary = (note) => ({
  id: note.id,
  title: note.title,
  tags: note.tags,
  dataClass: note.dataClass,
  pinned: note.pinned,
  created: note.created,
  updated: note.updated,
  recalls: note.recalls.count,
  lastRecalled: note.recalls.last,
});
