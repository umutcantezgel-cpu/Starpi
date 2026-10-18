// @ts-check
// Module `feeds` (experimental, read-only): readings from outside the companion in the neutral
// feed contract (contracts/feed.js), as events `feed.sample` and `feed.health` of the store.
//   - CSV import: a file of readings for a configured source (csv.js);
//   - MQTT: a subscription to topics of a broker on this machine (mqtt.js); the companion never
//     publishes, it only listens.
// The latest reading per source and series is kept in memory (and, for public readings, in the
// profile's `feed_latest` view); the chat cites matching readings as sources, so their numbers pass
// the sentence gate exactly as the feed reported them.
//   GET  /v1/feeds                      member  the sources with their state and counts
//   GET  /v1/feeds/latest               member  the latest reading per source and series
//   POST /v1/feeds/import?source=<id>   member  raw text/csv body -> { stored, duplicates, problems }
// Configuration (`modules.feeds`):
//   { "sources": [
//       { "id": "home-sensor", "type": "mqtt", "url": "mqtt://127.0.0.1:1883", "protocol": 4,
//         "topics": [{ "filter": "home/+/temperature", "series": "{2}.temperature", "unit": "°C",
//                      "value": "temp", "time": "ts", "quality": "q" }],
//         "dataClass": "public", "staleAfterS": 300, "keepAliveS": 30, "minIntervalMs": 1000 },
//       { "id": "meter-export", "type": "csv", "dataClass": "personal" } ] }
// `series` may hold `{n}`, the n-th level of the topic; `value`, `time` and `quality` name members
// of a JSON payload (dotted paths); without `value` the payload is the number itself. A retained
// message without its own time counts as `uncertain`, since its age is unknown.
import { isRecord } from '../contracts/check.js';
import { classRank, isDataClass } from '../contracts/data-classes.js';
import { FEED_HEALTH, FEED_SAMPLE, QUALITIES, SERIES } from '../contracts/feed.js';
import { NAME } from '../contracts/check.js';
import { isoAt } from '../lib/clock.js';
import { codeOf, fail } from '../lib/errors.js';
import { actorOf, moduleConfig } from '../setup/kit.js';
import { parseLoopbackUrl } from '../setup/loopback.js';
import { samplesFromCsv } from './csv.js';
import { createMqttSubscriber, isTopicFilter, topicMatches } from './mqtt.js';

export const FEEDS_MODULE = 'feeds';
export const MAX_SOURCES = 32;
export const MAX_TOPICS = 64;

/**
 * @typedef {import('./csv.js').FeedSample & { dataClass: import('../contracts/data-classes.js').DataClass }} Reading
 */

/**
 * What other modules may use.
 * @typedef {object} FeedsService
 * @property {(samples: import('./csv.js').FeedSample[], options?: { dataClass?: import('../contracts/data-classes.js').DataClass }) => { stored: number, duplicates: number }} ingest
 * @property {(options?: { maxClass?: import('../contracts/data-classes.js').DataClass }) => Reading[]} latest
 * @property {(question: string, options?: { max?: number, maxClass?: import('../contracts/data-classes.js').DataClass }) => Reading[]} relevant
 * @property {() => Array<{ id: string, type: string, state: string, detail: string | null }>} health
 */

/** @param {unknown} v */
function topicRule(v) {
  if (!isRecord(v)) return 'an object { filter, series, unit?, value?, time?, quality?, qos? }';
  for (const k of Object.keys(v)) if (!['filter', 'series', 'unit', 'value', 'time', 'quality', 'qos'].includes(k)) return `${k} is not a member`;
  if (!isTopicFilter(v.filter)) return 'filter: an MQTT topic filter';
  if (typeof v.series !== 'string' || v.series.length === 0 || v.series.length > 128) return 'series: a series name, may hold {n} for the n-th topic level';
  if (v.unit !== undefined && (typeof v.unit !== 'string' || v.unit.length > 32)) return 'unit: at most 32 characters';
  for (const k of ['value', 'time', 'quality']) if (v[k] !== undefined && (typeof v[k] !== 'string' || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(/** @type {string} */ (v[k])))) return `${k}: a dotted member path`;
  if (v.qos !== undefined && v.qos !== 0 && v.qos !== 1) return 'qos: 0 or 1';
  return null;
}

/** @param {unknown} v */
function sourceRule(v) {
  if (!isRecord(v)) return 'an object';
  if (typeof v.id !== 'string' || !NAME.test(v.id)) return 'id: a lower-case name';
  if (v.type === 'csv') {
    for (const k of Object.keys(v)) if (!['id', 'type', 'dataClass', 'title'].includes(k)) return `${v.id}: ${k} is not a member of a csv source`;
  } else if (v.type === 'mqtt') {
    for (const k of Object.keys(v)) if (!['id', 'type', 'dataClass', 'title', 'url', 'protocol', 'clientId', 'topics', 'staleAfterS', 'keepAliveS', 'minIntervalMs'].includes(k)) return `${v.id}: ${k} is not a member of an mqtt source`;
    try {
      parseLoopbackUrl(v.url, `${v.id}.url`, { schemes: ['mqtt'] });
    } catch (err) {
      return /** @type {Error} */ (err).message;
    }
    if (v.protocol !== undefined && v.protocol !== 4 && v.protocol !== 5) return `${v.id}: protocol is 4 (3.1.1) or 5`;
    if (v.clientId !== undefined && (typeof v.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,23}$/.test(v.clientId))) return `${v.id}: clientId is 1 to 23 letters, digits, _ or -`;
    if (!Array.isArray(v.topics) || v.topics.length === 0 || v.topics.length > MAX_TOPICS) return `${v.id}: topics is a list of 1 to ${MAX_TOPICS}`;
    for (const [i, t] of v.topics.entries()) {
      const problem = topicRule(t);
      if (problem) return `${v.id}.topics[${i}]: ${problem}`;
    }
    for (const [k, min, max] of /** @type {Array<[string, number, number]>} */ ([['staleAfterS', 5, 86_400], ['keepAliveS', 1, 3600], ['minIntervalMs', 0, 3_600_000]])) {
      if (v[k] !== undefined && !(Number.isInteger(v[k]) && /** @type {number} */ (v[k]) >= min && /** @type {number} */ (v[k]) <= max)) return `${v.id}: ${k} is ${min} to ${max}`;
    }
  } else return `${v.id ?? 'a source'}: type is csv or mqtt`;
  if (v.dataClass !== undefined && !isDataClass(v.dataClass)) return `${v.id}: dataClass is public, personal, sensitive or secret`;
  return null;
}

/** @param {unknown} v */
const sourcesRule = (v) => {
  if (!Array.isArray(v) || v.length > MAX_SOURCES) return `a list of at most ${MAX_SOURCES} sources`;
  for (const [i, s] of v.entries()) {
    const problem = sourceRule(s);
    if (problem) return `[${i}] ${problem}`;
  }
  return new Set(v.map((s) => s.id)).size === v.length ? null : 'source ids must be unique';
};

/** A member of a JSON value by dotted path. @param {unknown} value @param {string} path */
function pick(value, path) {
  let cur = /** @type {any} */ (value);
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * The series name of a message: the template with its {n} levels filled in, cleaned.
 * @param {string} template
 * @param {string} topic
 */
export function seriesFor(template, topic) {
  const levels = topic.split('/');
  const name = template.replace(/\{(\d+)\}/g, (_, n) => levels[Number(n) - 1] ?? '').toLowerCase().replace(/[^a-z0-9_.]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[._]+|[._]+$/g, '');
  return SERIES.test(name) ? name : null;
}

/**
 * @param {{ hub: import('../setup/hub.js').Hub }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createFeedsModule({ hub }) {
  /** @type {any} */
  let ctx = null;
  /** @type {Array<Record<string, any>>} */
  let sources = [];
  /** @type {Map<string, Reading>} */
  const latest = new Map();
  /** @type {Map<string, { type: string, state: string, detail: string | null, samples: number, duplicates: number, dropped: number, problems: number, lastSample: string | null, lastMessage: number, subscriber: ReturnType<typeof createMqttSubscriber> | null }>} */
  const status = new Map();
  /** @type {Map<string, number>} last stored time per source and series, for minIntervalMs */
  const lastStored = new Map();
  /** @type {Array<() => void>} */
  const undo = [];
  /** @type {(() => void) | null} */
  let withdraw = null;

  /** @param {Reading} r */
  const keyOf = (r) => `${r.source_id}\n${r.series}`;

  /**
   * Stores samples as feed.sample events and updates the latest readings.
   * @param {import('./csv.js').FeedSample[]} samples
   * @param {import('../contracts/data-classes.js').DataClass} dataClass
   */
  function store(samples, dataClass) {
    if (samples.length === 0) return { stored: 0, duplicates: 0 };
    let stored = 0;
    let duplicates = 0;
    for (let i = 0; i < samples.length; i += 500) {
      const batch = samples.slice(i, i + 500);
      const result = ctx.events.append(batch.map((s) => ({ type: FEED_SAMPLE, source: s.source_id, key: `${s.series}@${s.ts_source}`, at: s.ts_source, class: dataClass, body: { ...s } })));
      stored += result.inserted.length;
      duplicates += result.duplicates;
    }
    for (const s of samples) {
      const reading = { ...s, dataClass };
      const current = latest.get(keyOf(reading));
      if (!current || current.ts_source <= s.ts_source) latest.set(keyOf(reading), reading);
      const st = status.get(s.source_id);
      if (st && (!st.lastSample || st.lastSample < s.ts_source)) st.lastSample = s.ts_source;
    }
    return { stored, duplicates };
  }

  /**
   * Records a change of a source's state as a feed.health event.
   * @param {string} id
   * @param {'up' | 'stale' | 'down'} state
   * @param {string | null} detail
   */
  function health(id, state, detail) {
    const st = status.get(id);
    if (!st || (st.state === state && st.detail === detail)) return;
    const was = st.state;
    st.state = state;
    st.detail = detail;
    const at = isoAt(ctx.clock.now());
    const body = { source_id: id, state, checked_at: at, ...(detail ? { detail: detail.slice(0, 200) } : {}) };
    try {
      ctx.events.append([{ type: FEED_HEALTH, source: id, key: `health@${at}@${state}`, at, class: 'public', body }]);
    } catch (err) {
      ctx.log('warn', 'health_not_stored', { source: id, code: codeOf(err) });
    }
    if (state === 'down' && was === 'up') hub.get('notify')?.post({ kind: 'feed_down', ref: id, title: id, dataClass: 'public' });
  }

  /**
   * A message of a subscribed topic as a sample, or null.
   * @param {Record<string, any>} source
   * @param {string} topic
   * @param {Buffer} payload
   * @param {boolean} retain
   */
  function sampleOf(source, topic, payload, retain) {
    const rule = source.topics.find((/** @type {any} */ t) => topicMatches(t.filter, topic));
    if (!rule) return null;
    const series = seriesFor(rule.series, topic);
    if (!series) return null;
    const text = payload.toString('utf8').trim();
    let value;
    let ts = null;
    let quality = retain ? 'uncertain' : 'good';
    if (rule.value) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return null;
      }
      value = pick(json, rule.value);
      if (rule.time) {
        const t = pick(json, rule.time);
        const ms = typeof t === 'number' ? (t < 1e11 ? t * 1000 : t) : typeof t === 'string' ? Date.parse(t) : NaN;
        if (Number.isFinite(ms)) {
          ts = isoAt(ms);
          if (retain) quality = 'good';
        }
      }
      if (rule.quality) {
        const q = String(pick(json, rule.quality) ?? '').toLowerCase();
        if (QUALITIES.includes(q)) quality = q;
      }
    } else value = text === '' ? NaN : Number(text);
    if (typeof value === 'string' && value.trim() !== '') value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return { source_id: source.id, series, value, unit: rule.unit ?? '', ts_source: ts ?? isoAt(ctx.clock.now()), quality: /** @type {any} */ (quality) };
  }

  /** @param {Record<string, any>} source */
  function startMqtt(source) {
    const target = parseLoopbackUrl(source.url, `${source.id}.url`, { schemes: ['mqtt'] });
    const st = /** @type {NonNullable<ReturnType<typeof status.get>>} */ (status.get(source.id));
    const minInterval = source.minIntervalMs ?? 1000;
    const subscriber = createMqttSubscriber({
      host: target.host,
      port: target.port,
      protocol: source.protocol ?? 4,
      clientId: source.clientId,
      keepAliveS: source.keepAliveS ?? 30,
      topics: source.topics.map((/** @type {any} */ t) => ({ filter: t.filter, qos: t.qos ?? 0 })),
      onState(state, detail) {
        if (state === 'up') health(source.id, 'up', detail ?? null);
        else if (state === 'down') health(source.id, 'down', detail ?? null);
      },
      onMessage(topic, payload, info) {
        st.lastMessage = ctx.clock.now();
        if (st.state === 'stale') health(source.id, 'up', null);
        const sample = sampleOf(source, topic, payload, info.retain);
        if (!sample) {
          st.problems += 1;
          return;
        }
        const key = `${sample.source_id}\n${sample.series}`;
        const now = ctx.clock.now();
        if (minInterval > 0 && now - (lastStored.get(key) ?? -Infinity) < minInterval) {
          st.dropped += 1;
          return;
        }
        lastStored.set(key, now);
        try {
          const result = store([sample], source.dataClass ?? 'public');
          st.samples += result.stored;
          st.duplicates += result.duplicates;
        } catch (err) {
          st.problems += 1;
          ctx.log('warn', 'sample_refused', { source: source.id, code: codeOf(err) });
        }
      },
    });
    st.subscriber = subscriber;
    subscriber.start();
    undo.push(() => subscriber.stop());
    // A source that stays connected but quiet is stale.
    const staleMs = (source.staleAfterS ?? 300) * 1000;
    undo.push(
      ctx.scheduler.every(`feeds.stale.${source.id}`, Math.max(1000, Math.min(staleMs / 2, 60_000)), () => {
        if (st.state === 'up' && ctx.clock.now() - (st.lastMessage || 0) > staleMs) health(source.id, 'stale', 'no message within the stale time');
      }, 'events'),
    );
  }

  /** @type {FeedsService} */
  const service = {
    ingest(samples, { dataClass = 'personal' } = {}) {
      return store(samples, dataClass);
    },
    latest({ maxClass = 'secret' } = {}) {
      return [...latest.values()].filter((r) => classRank(r.dataClass) <= classRank(maxClass)).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    },
    relevant(question, { max = 6, maxClass = 'sensitive' } = {}) {
      const words = new Set((question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) => w.replace(/s$/, '')));
      if (words.size === 0) return [];
      const scored = [];
      for (const r of service.latest({ maxClass })) {
        const parts = [...r.series.split(/[._]/), ...r.source_id.split(/[._-]/)].filter((p) => p.length >= 3).map((p) => p.replace(/s$/, ''));
        const score = new Set(parts.filter((p) => words.has(p))).size;
        if (score > 0) scored.push({ r, score });
      }
      return scored.sort((a, b) => b.score - a.score || (a.r.ts_source < b.r.ts_source ? 1 : -1)).slice(0, max).map((x) => x.r);
    },
    health: () => [...status.entries()].map(([id, s]) => ({ id, type: s.type, state: s.state, detail: s.detail })),
  };

  return {
    id: FEEDS_MODULE,
    version: '0.9.0',
    title: 'Feeds (experimental, read-only)',
    routes: [
      {
        method: 'GET',
        path: '/',
        access: 'member',
        lane: 'status',
        handler: () => ({
          body: {
            sources: [...status.entries()].map(([id, s]) => ({ id, type: s.type, state: s.state, detail: s.detail, samples: s.samples, duplicates: s.duplicates, dropped: s.dropped, problems: s.problems, lastSample: s.lastSample, mqtt: s.subscriber?.stats() ?? null })),
          },
        }),
      },
      {
        method: 'GET',
        path: '/latest',
        access: 'member',
        lane: 'status',
        handler: () => ({ body: { readings: service.latest() } }),
      },
      {
        method: 'POST',
        path: '/import',
        access: 'member',
        lane: 'events',
        raw: ['text/csv', 'text/plain', 'application/octet-stream'],
        maxBody: 16 * 1024 * 1024,
        handler(req) {
          const id = req.query.get('source') ?? '';
          const source = sources.find((s) => s.id === id && s.type === 'csv');
          if (!source) throw fail('feed_source_unknown', 'name a configured csv source (?source=)', { status: 404 });
          let text;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(req.body);
          } catch {
            throw fail('feed_csv_encoding', 'the file is not UTF-8 text', { status: 415 });
          }
          const parsed = samplesFromCsv(text, { sourceId: id, timeZone: ctx.timeZone, now: ctx.clock.now() });
          const st = /** @type {NonNullable<ReturnType<typeof status.get>>} */ (status.get(id));
          const result = store(parsed.samples, source.dataClass ?? 'personal');
          st.samples += result.stored;
          st.duplicates += result.duplicates;
          st.problems += parsed.problems.length;
          if (result.stored > 0) health(id, 'up', null);
          ctx.audit.append({ kind: 'feeds.imported', subject: id, actor: actorOf(req), details: { rows: parsed.rows, stored: result.stored, duplicates: result.duplicates, problems: parsed.problems.length, layout: parsed.layout } });
          return { body: { source: id, layout: parsed.layout, rows: parsed.rows, ...result, problems: parsed.problems.slice(0, 50), moreProblems: Math.max(0, parsed.problems.length - 50) } };
        },
      },
    ],
    start(context) {
      ctx = context;
      const config = moduleConfig(FEEDS_MODULE, ctx.config, { sources: sourcesRule }, /** @type {{ sources: Array<Record<string, any>> }} */ ({ sources: [] }));
      sources = config.sources;
      // The public readings the profile kept survive a restart.
      try {
        for (const row of /** @type {any[]} */ (ctx.db.prepare('SELECT source_id, series, value, unit, ts_source, quality FROM feed_latest').all())) {
          const r = { source_id: row.source_id, series: row.series, value: Number(row.value), unit: row.unit, ts_source: row.ts_source, quality: row.quality, dataClass: /** @type {const} */ ('public') };
          latest.set(keyOf(r), r);
        }
      } catch {
        // another profile without that view
      }
      for (const s of sources) status.set(s.id, { type: s.type, state: 'down', detail: s.type === 'csv' ? 'waiting for an import' : null, samples: 0, duplicates: 0, dropped: 0, problems: 0, lastSample: null, lastMessage: 0, subscriber: null });
      for (const s of sources) if (s.type === 'mqtt') startMqtt(s);
      withdraw = hub.provide('feeds', service);
    },
    stop() {
      withdraw?.();
      withdraw = null;
      for (const step of undo.splice(0).reverse()) step();
      status.clear();
    },
  };
}
