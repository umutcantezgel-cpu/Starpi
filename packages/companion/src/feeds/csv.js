// @ts-check
// Readings from a CSV file, in one of two layouts recognised by the header row:
//   long:  one reading per row, with the columns `series` and `value`, and optionally `unit`,
//          `ts_source` (or `time`, `timestamp`), `quality` and `source_id`;
//   wide:  a time column (`ts_source`, `time` or `timestamp`) and one column per series, its unit
//          in square brackets after the name: `office.temperature [°C]`.
// The delimiter (comma, semicolon or tab) is taken from the header row. Times are ISO 8601; a time
// without a zone is read in the companion's time zone. Values are plain numbers (a single decimal
// comma is accepted). Rows that cannot be read are reported by line, never guessed at.
import { parseCsv } from '@starpi/core';
import { checkFeedSample, SERIES } from '../contracts/feed.js';
import { instantOf } from '../agenda/recurrence.js';

const TIME_COLUMNS = Object.freeze(['ts_source', 'time', 'timestamp']);
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const ZONED_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})$/;
export const MAX_ROWS = 100_000;

/**
 * A reading of the feed contract (feed.sample version 1).
 * @typedef {{ source_id: string, series: string, value: number, unit: string, ts_source: string, quality: 'good' | 'uncertain' | 'bad' }} FeedSample
 */

/**
 * A time as ISO 8601 UTC with milliseconds, or null.
 * @param {string} raw
 * @param {string} timeZone
 */
export function readTime(raw, timeZone) {
  const text = raw.trim();
  const zoned = ZONED_TIME.exec(text);
  if (zoned) {
    const ms = Date.parse(`${zoned[1]}T${zoned[2]}${zoned[3].length === 5 ? `${zoned[3].slice(0, 3)}:${zoned[3].slice(3)}` : zoned[3]}`);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  const local = LOCAL_TIME.exec(text);
  if (!local) return null;
  const [year, month, day, hour, minute] = local.slice(1, 6).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const seconds = Number(local[6] ?? 0);
  const millis = Number((local[7] ?? '0').padEnd(3, '0'));
  if (seconds > 59) return null;
  const at = instantOf({ year, month, day, hour, minute }, timeZone) + seconds * 1000 + millis;
  return new Date(at).toISOString();
}

/** A number as written in a CSV cell, or null. @param {string} raw */
export function readValue(raw) {
  const text = raw.trim().replace(/^(-?\d+),(\d+)$/, '$1.$2');
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** @param {string} name */
const seriesName = (name) => name.trim().toLowerCase().replace(/\s+/g, '_');

/**
 * Samples from CSV text.
 * @param {string} text
 * @param {{ sourceId: string, timeZone: string, now: number }} options
 * @returns {{ samples: FeedSample[], problems: Array<{ line: number, problem: string }>, layout: 'long' | 'wide' | null, rows: number }}
 */
export function samplesFromCsv(text, { sourceId, timeZone, now }) {
  const body = text.replace(/^\uFEFF/, '');
  const firstLine = body.slice(0, body.indexOf('\n') === -1 ? body.length : body.indexOf('\n'));
  const delimiter = [',', ';', '\t'].map((d) => /** @type {[string, number]} */ ([d, firstLine.split(d).length])).sort((a, b) => b[1] - a[1])[0][0];
  const rows = parseCsv(body, delimiter);
  /** @type {Array<{ line: number, problem: string }>} */
  const problems = [];
  /** @type {FeedSample[]} */
  const samples = [];
  if (rows.length < 2) return { samples, problems: [{ line: 1, problem: 'a header row and at least one row of readings are needed' }], layout: null, rows: 0 };
  if (rows.length - 1 > MAX_ROWS) return { samples, problems: [{ line: 1, problem: `at most ${MAX_ROWS} rows per import` }], layout: null, rows: rows.length - 1 };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (/** @type {string} */ name) => header.indexOf(name);
  const timeCol = header.findIndex((h) => TIME_COLUMNS.includes(h));
  const fallbackTime = new Date(now).toISOString();
  const layout = col('series') >= 0 && col('value') >= 0 ? 'long' : timeCol >= 0 ? 'wide' : null;
  if (!layout) return { samples, problems: [{ line: 1, problem: 'the header needs series and value columns, or a time column and one column per series' }], layout, rows: rows.length - 1 };

  /** @param {Record<string, unknown>} sample @param {number} line */
  const keep = (sample, line) => {
    const found = checkFeedSample(sample);
    if (found.length > 0) problems.push({ line, problem: found[0].replace(/^\./, '') });
    else samples.push(/** @type {FeedSample} */ (/** @type {unknown} */ (sample)));
  };

  /** @type {Array<{ index: number, series: string, unit: string }>} */
  const wideColumns = [];
  if (layout === 'wide') {
    rows[0].forEach((raw, index) => {
      if (index === timeCol) return;
      const m = /^\s*(.+?)\s*(?:\[([^\]]{0,32})\])?\s*$/.exec(raw);
      const series = seriesName(m?.[1] ?? '');
      if (!SERIES.test(series)) {
        problems.push({ line: 1, problem: `column ${index + 1}: "${raw.trim().slice(0, 40)}" is no series name (lower case, dotted)` });
        return;
      }
      wideColumns.push({ index, series, unit: (m?.[2] ?? '').trim() });
    });
  }

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const line = r + 1;
    const rawTime = timeCol >= 0 ? (row[timeCol] ?? '') : '';
    const ts = rawTime.trim() === '' ? (layout === 'long' ? fallbackTime : null) : readTime(rawTime, timeZone);
    if (!ts) {
      problems.push({ line, problem: 'the time is not ISO 8601' });
      continue;
    }
    if (layout === 'long') {
      const value = readValue(row[col('value')] ?? '');
      if (value === null) {
        problems.push({ line, problem: 'the value is not a number' });
        continue;
      }
      const quality = col('quality') >= 0 ? (row[col('quality')] ?? '').trim().toLowerCase() || 'good' : 'good';
      const named = col('source_id') >= 0 ? (row[col('source_id')] ?? '').trim() : '';
      if (named !== '' && named !== sourceId) {
        problems.push({ line, problem: `source_id ${named.slice(0, 64)} is not the source being imported` });
        continue;
      }
      keep(
        {
          source_id: sourceId,
          series: seriesName(row[col('series')] ?? ''),
          value,
          unit: col('unit') >= 0 ? (row[col('unit')] ?? '').trim() : '',
          ts_source: ts,
          quality,
        },
        line,
      );
      continue;
    }
    for (const c of wideColumns) {
      const cell = row[c.index] ?? '';
      if (cell.trim() === '') continue;
      const value = readValue(cell);
      if (value === null) {
        problems.push({ line, problem: `${c.series}: the value is not a number` });
        continue;
      }
      keep({ source_id: sourceId, series: c.series, value, unit: c.unit, ts_source: ts, quality: 'good' }, line);
    }
  }
  return { samples, problems, layout, rows: rows.length - 1 };
}
