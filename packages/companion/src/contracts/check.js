// @ts-check
// Tiny field checkers for the contracts. Each returns a list of problems ("path: what is wrong"), so
// a caller can refuse a value with every reason at once. No schema library: the contracts are small
// and their rules read better as code.

/** @param {unknown} v @returns {v is Record<string, unknown>} */
export const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** ISO 8601 UTC timestamp with optional milliseconds. */
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** A lower-case name: a letter, then letters, digits, `_`, `-` or `.` (2 to 64 characters). */
export const NAME = /^[a-z][a-z0-9_.-]{1,63}$/;

/**
 * Collects problems of a record against simple field rules.
 * @param {unknown} value
 * @param {string} where
 * @param {Record<string, (v: unknown) => string | null>} fields  rule per member; returns a problem or null
 * @param {{ required?: readonly string[], closed?: boolean }} [options]
 * @returns {string[]}
 */
export function checkRecord(value, where, fields, { required = [], closed = true } = {}) {
  if (!isRecord(value)) return [`${where}: an object`];
  /** @type {string[]} */
  const problems = [];
  for (const name of required) if (value[name] === undefined) problems.push(`${where}.${name}: required`);
  for (const [name, member] of Object.entries(value)) {
    const rule = fields[name];
    if (!rule) {
      if (closed) problems.push(`${where}.${name}: not a member`);
      continue;
    }
    if (member === undefined) continue;
    const problem = rule(member);
    if (problem) problems.push(`${where}.${name}: ${problem}`);
  }
  return problems;
}

/** @param {RegExp} pattern @param {string} label */
export const matches = (pattern, label) => (/** @type {unknown} */ v) => (typeof v === 'string' && pattern.test(v) ? null : label);

/** @param {readonly unknown[]} values */
export const oneOf = (values) => (/** @type {unknown} */ v) => (values.includes(v) ? null : `one of ${values.join(', ')}`);

/** @param {number} max */
export const text = (max) => (/** @type {unknown} */ v) => (typeof v === 'string' && v.length > 0 && v.length <= max ? null : `a string of 1 to ${max} characters`);

/** @param {unknown} v */
export const finiteNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? null : 'a finite number');

/** @param {number} min @param {number} max */
export const integer = (min, max) => (/** @type {unknown} */ v) => (Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max ? null : `an integer from ${min} to ${max}`);

/** @param {unknown} v */
export const isoTime = (v) => (typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) ? null : 'an ISO 8601 UTC time');
