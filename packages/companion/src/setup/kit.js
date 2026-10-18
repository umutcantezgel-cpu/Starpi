// @ts-check
// Small helpers the standard modules share: their configuration (`modules.<id>` of config.json)
// checked with every problem at once, request bodies, ids and the actor of a request as the audit
// chain names it.
import { randomUUID } from 'node:crypto';
import { checkRecord, isRecord } from '../contracts/check.js';
import { DATA_CLASSES, isDataClass } from '../contracts/data-classes.js';
import { fail } from '../lib/errors.js';

/**
 * Checks the configuration of a module and fills in the defaults; a problem stops the start.
 * @template {Record<string, unknown>} T
 * @param {string} moduleId
 * @param {unknown} value                                   `modules.<id>`, `{}` when absent
 * @param {Record<string, (v: unknown) => string | null>} fields
 * @param {T} defaults
 * @returns {T}
 */
export function moduleConfig(moduleId, value, fields, defaults) {
  const problems = checkRecord(value ?? {}, `modules.${moduleId}`, fields);
  if (problems.length > 0) throw fail('module_config', `the configuration of ${moduleId} is invalid: ${problems.join('; ')}`, { details: { problems } });
  return /** @type {T} */ ({ ...defaults, ...Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (value ?? {})).filter(([, v]) => v !== undefined)) });
}

/** @param {number} min @param {number} max */
export const intIn = (min, max) => (/** @type {unknown} */ v) => (Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max ? null : `a whole number from ${min} to ${max}`);

/** @param {unknown} v */
export const bool = (v) => (typeof v === 'boolean' ? null : 'true or false');

/** @param {unknown} v */
export const dataClassRule = (v) => (isDataClass(v) ? null : `one of ${DATA_CLASSES.join(', ')}`);

/**
 * The JSON body of a request as an object, or a 400.
 * @param {{ body: unknown }} req
 * @returns {Record<string, unknown>}
 */
export function bodyOf(req) {
  if (!isRecord(req.body)) throw fail('body_invalid', 'the body is a JSON object', { status: 400 });
  return req.body;
}

/**
 * Refuses a body with members a route does not know, or with problems of its rules.
 * @param {Record<string, unknown>} body
 * @param {Record<string, (v: unknown) => string | null>} fields
 * @param {readonly string[]} [required]
 */
export function checkBody(body, fields, required = []) {
  const problems = checkRecord(body, 'body', fields, { required });
  if (problems.length > 0) throw fail('body_invalid', problems.join('; '), { status: 400, details: { problems } });
}

/** A new id with a prefix: `note-<uuid>`. @param {string} prefix */
export const newId = (prefix) => `${prefix}-${randomUUID()}`;

/** An id the standard modules hand out: a prefix, a dash and a UUID. @param {string} prefix */
export const idPattern = (prefix) => new RegExp(`^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);

/**
 * Who did something, as the audit chain records it: the paired session (its first 8 characters),
 * or the companion itself.
 * @param {{ session?: { id: string } | null } | null | undefined} req
 */
export const actorOf = (req) => (req?.session ? `session:${req.session.id.slice(0, 8)}` : 'companion');

/**
 * A 404 with a module's own code.
 * @param {string} code
 * @param {string} what
 */
export const notFound = (code, what) => fail(code, `no such ${what}`, { status: 404 });

/**
 * Text cut to a length on a character boundary, with an ellipsis when it was longer.
 * @param {string} text
 * @param {number} max
 */
export function clip(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * A stream of server-sent events fed by pushes: what a route hands the kernel as `stream`. It ends
 * when `end()` is called, when the signal aborts (the client went away, the companion stops) or,
 * for a reader that does not keep up, when more than `max` events wait (the oldest go first and the
 * stream says so with an `overflow` event).
 * @param {{ signal?: AbortSignal, max?: number }} [options]
 */
export function pushStream({ signal, max = 500 } = {}) {
  /** @type {Array<{ event: string, data: unknown }>} */
  const waiting = [];
  /** @type {((value: IteratorResult<{ event: string, data: unknown }>) => void) | null} */
  let wake = null;
  let ended = false;
  let dropped = 0;
  const flush = () => {
    if (!wake) return;
    const resolve = wake;
    if (dropped > 0) {
      wake = null;
      resolve({ value: { event: 'overflow', data: { dropped } }, done: false });
      dropped = 0;
      return;
    }
    if (waiting.length > 0) {
      wake = null;
      resolve({ value: /** @type {{ event: string, data: unknown }} */ (waiting.shift()), done: false });
    } else if (ended) {
      wake = null;
      resolve({ value: undefined, done: true });
    }
  };
  const end = () => {
    ended = true;
    flush();
  };
  signal?.addEventListener('abort', end, { once: true });
  if (signal?.aborted) ended = true;
  return {
    /** @param {string} event @param {unknown} data */
    push(event, data) {
      if (ended) return false;
      waiting.push({ event, data });
      if (waiting.length > max) {
        waiting.shift();
        dropped += 1;
      }
      flush();
      return true;
    },
    end,
    get ended() {
      return ended;
    },
    /** @type {AsyncIterable<{ event: string, data: unknown }>} */
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise((resolve) => {
            wake = resolve;
            flush();
          }),
          return: async () => {
            end();
            waiting.length = 0;
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}
