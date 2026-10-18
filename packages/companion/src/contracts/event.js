// @ts-check
// The event contract. An event is a fact that happened somewhere (a sensor sent a value, a module
// noticed something) and is kept in the append-only event log of the store:
//   { type, source, key, at, class, body }
// `type` names the kind of fact and has a registered body check; `source` names who reported it;
// `key` makes a report idempotent (the same source and key are stored once); `at` is when it
// happened (the store adds when it was recorded); `class` is its data class; `body` holds ids,
// numbers and short labels only. Free text written by people (notes, chats, documents) never goes
// in an event: it lives sealed in the vault, and an event may point to it by id.
import { checkRecord, isRecord, isoTime, matches, NAME, text } from './check.js';
import { DATA_CLASSES, isDataClass } from './data-classes.js';
import { canonicalJson } from '../lib/canonical.js';

/** Longest canonical JSON of an event body. */
export const MAX_BODY_BYTES = 8 * 1024;

/** `area.fact` with one to three dotted parts after the first. */
export const EVENT_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/;

/**
 * @typedef {object} EventInput
 * @property {string} type
 * @property {string} source
 * @property {string} key
 * @property {string} at
 * @property {import('./data-classes.js').DataClass} class
 * @property {Record<string, unknown>} body
 */

/**
 * @typedef {object} EventType
 * @property {string} type
 * @property {number} version
 * @property {(body: Record<string, unknown>) => string[]} check  problems of a body, empty when valid
 */

/**
 * A registry of event types. Profiles and modules register theirs; the store refuses an event of a
 * type nobody registered.
 */
export function createEventTypes() {
  /** @type {Map<string, EventType>} */
  const types = new Map();
  return {
    /** @param {EventType} entry */
    register(entry) {
      if (!EVENT_TYPE.test(entry.type)) throw new TypeError(`event type ${JSON.stringify(entry.type)} is not of the form area.fact`);
      if (types.has(entry.type)) throw new TypeError(`event type ${entry.type} is registered already`);
      if (!Number.isInteger(entry.version) || entry.version < 1) throw new TypeError(`event type ${entry.type}: version must be a positive integer`);
      types.set(entry.type, Object.freeze({ ...entry }));
    },
    /** @param {string} type */
    get: (type) => types.get(type),
    list: () => [...types.keys()].sort(),
  };
}

/** @typedef {ReturnType<typeof createEventTypes>} EventTypes */

/**
 * Problems of an event against the envelope and its registered body check.
 * @param {unknown} event
 * @param {EventTypes} types
 * @returns {string[]}
 */
export function checkEvent(event, types) {
  const problems = checkRecord(
    event,
    'event',
    {
      type: matches(EVENT_TYPE, 'area.fact in lower case'),
      source: matches(NAME, 'a lower-case name'),
      key: text(200),
      at: isoTime,
      class: (v) => (isDataClass(v) ? null : `one of ${DATA_CLASSES.join(', ')}`),
      body: (v) => (isRecord(v) ? null : 'an object'),
    },
    { required: ['type', 'source', 'key', 'at', 'class', 'body'] },
  );
  if (problems.length > 0) return problems;
  const e = /** @type {EventInput} */ (event);
  const entry = types.get(e.type);
  if (!entry) return [`event.type: ${e.type} is not registered`];
  if (Buffer.byteLength(canonicalJson(e.body), 'utf8') > MAX_BODY_BYTES) return [`event.body: larger than ${MAX_BODY_BYTES} bytes`];
  return entry.check(e.body).map((p) => `event.body${p.startsWith('.') ? '' : ': '}${p}`);
}
