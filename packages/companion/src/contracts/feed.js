// @ts-check
// The neutral feed contract: readings from any source that measures something over time (a room
// thermometer, a power meter, a weather station, a build server's queue length). Version 1:
//   feed.sample  { source_id, series, value, unit, ts_source, quality }
//   feed.health  { source_id, state, checked_at, detail? }
// `series` is a dotted name chosen by whoever configures the source (`office.temperature`);
// `ts_source` is the time the source stamped on the reading; `quality` says how far the reading can
// be trusted. Feed numbers become citable sources for answers, so they are kept exactly as reported.
import { checkRecord, finiteNumber, isoTime, matches, NAME, oneOf, text } from './check.js';

export const FEED_SAMPLE = 'feed.sample';
export const FEED_HEALTH = 'feed.health';
export const FEED_CONTRACT_VERSION = 1;

/** Qualities of a reading, best first. */
export const QUALITIES = Object.freeze(['good', 'uncertain', 'bad']);
/** States of a source. */
export const SOURCE_STATES = Object.freeze(['up', 'stale', 'down']);

/** A dotted series name: lower-case parts of letters, digits and `_`. */
export const SERIES = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){0,7}$/;

/** @param {Record<string, unknown>} body @returns {string[]} */
export function checkFeedSample(body) {
  return checkRecord(
    body,
    '',
    {
      source_id: matches(NAME, 'a lower-case name'),
      series: matches(SERIES, 'a dotted lower-case series name'),
      value: finiteNumber,
      unit: (v) => (typeof v === 'string' && v.length <= 32 ? null : 'a unit of at most 32 characters (may be empty)'),
      ts_source: isoTime,
      quality: oneOf(QUALITIES),
    },
    { required: ['source_id', 'series', 'value', 'unit', 'ts_source', 'quality'] },
  );
}

/** @param {Record<string, unknown>} body @returns {string[]} */
export function checkFeedHealth(body) {
  return checkRecord(
    body,
    '',
    { source_id: matches(NAME, 'a lower-case name'), state: oneOf(SOURCE_STATES), checked_at: isoTime, detail: text(200) },
    { required: ['source_id', 'state', 'checked_at'] },
  );
}

/** Both feed types, ready for an event type registry. */
export const FEED_EVENT_TYPES = Object.freeze([
  Object.freeze({ type: FEED_SAMPLE, version: FEED_CONTRACT_VERSION, check: checkFeedSample }),
  Object.freeze({ type: FEED_HEALTH, version: FEED_CONTRACT_VERSION, check: checkFeedHealth }),
]);
