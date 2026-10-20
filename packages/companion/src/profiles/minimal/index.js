// @ts-check
// The `minimal` profile, the default: the neutral feed contract (feed.sample, feed.health), a
// projection with the latest public reading per source and series, and a demo sensor that makes
// believable readings for trying the companion without any hardware. Feeds themselves (CSV files,
// MQTT topics, simulators) are a module; this profile only declares what their readings look like.
import { FEED_EVENT_TYPES, FEED_HEALTH, FEED_SAMPLE } from '../../contracts/feed.js';

/** The demo source: a room sensor with two series. */
export const DEMO_SOURCE = Object.freeze({
  source_id: 'demo-sensor',
  series: Object.freeze([
    Object.freeze({ series: 'room.temperature', unit: '°C', base: 21, swing: 1.5 }),
    Object.freeze({ series: 'room.humidity', unit: '%', base: 45, swing: 6 }),
  ]),
});

/** @type {import('../../store/sqlite.js').Projection} */
export const feedLatestProjection = {
  name: 'feed_latest',
  version: 1,
  setup(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS feed_latest (
      source_id TEXT NOT NULL,
      series TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL,
      ts_source TEXT NOT NULL,
      quality TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (source_id, series)
    )`);
  },
  reset(db) {
    db.exec('DELETE FROM feed_latest');
  },
  apply(db, event) {
    // Readings of protected classes stay sealed in the log; the plain view holds public ones only.
    if (event.type !== FEED_SAMPLE || event.class !== 'public') return;
    const b = /** @type {{ source_id: string, series: string, value: number, unit: string, ts_source: string, quality: string }} */ (event.body);
    db.prepare(`INSERT INTO feed_latest (source_id, series, value, unit, ts_source, quality, seq) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_id, series) DO UPDATE SET value = excluded.value, unit = excluded.unit, ts_source = excluded.ts_source,
      quality = excluded.quality, seq = excluded.seq WHERE excluded.ts_source >= feed_latest.ts_source`).run(b.source_id, b.series, b.value, b.unit, b.ts_source, b.quality, event.seq);
  },
};

/**
 * Readings of the demo sensor at a time: a smooth daily curve per series, the same for the same
 * time, so tests and demos are repeatable.
 * @param {number} atMs
 * @returns {import('../../contracts/event.js').EventInput[]}
 */
export function demoReadings(atMs) {
  const at = new Date(Math.floor(atMs / 1000) * 1000).toISOString();
  const dayPhase = ((atMs / 86_400_000) % 1) * 2 * Math.PI;
  return DEMO_SOURCE.series.map((s) => ({
    type: FEED_SAMPLE,
    source: DEMO_SOURCE.source_id,
    key: `${s.series}@${at}`,
    at,
    class: /** @type {const} */ ('public'),
    body: { source_id: DEMO_SOURCE.source_id, series: s.series, value: Math.round((s.base + s.swing * Math.sin(dayPhase)) * 10) / 10, unit: s.unit, ts_source: at, quality: 'good' },
  }));
}

/**
 * The latest public readings.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function latestReadings(db) {
  return db.prepare('SELECT source_id, series, value, unit, ts_source, quality FROM feed_latest ORDER BY source_id, series').all();
}

export const minimalProfile = Object.freeze({
  id: 'minimal',
  title: 'Minimal (neutral feeds)',
  eventTypes: FEED_EVENT_TYPES,
  projections: Object.freeze([feedLatestProjection]),
  eventNames: Object.freeze([FEED_SAMPLE, FEED_HEALTH]),
});
