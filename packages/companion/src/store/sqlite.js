// @ts-check
// The store: one node:sqlite database in WAL mode (synchronous FULL) that holds the append-only
// event log, the projections built from it, ingest positions and small metadata. The kernel parts
// (audit chain, vault items, sessions) keep their own tables in the same file, so one transaction
// can cover an event, its projections and the position that produced it.
//
// Every event row carries `link`, a running SHA-256 over all rows before it and itself. An anchor
// written outside the data folder names the newest seq and its link, which pins the whole log: a
// row changed, removed or put back from an older copy breaks the link of every later row.
//
// Bodies of events whose data class is not `public` are sealed by the codec the vault provides, so
// the database file holds no readable personal content.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256Hex, ZERO_HASH } from '../lib/canonical.js';
import { isoAt, systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';
import { checkEvent, createEventTypes } from '../contracts/event.js';

/** Schema generation of the kernel tables; a database of a newer generation is not opened. */
export const STORE_SCHEMA = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  dedupe TEXT NOT NULL,
  type TEXT NOT NULL,
  class TEXT NOT NULL,
  happened TEXT NOT NULL,
  recorded TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT NOT NULL,
  UNIQUE (source, dedupe)
);
CREATE INDEX IF NOT EXISTS event_log_type ON event_log (type, seq);
CREATE TRIGGER IF NOT EXISTS event_log_no_update BEFORE UPDATE ON event_log BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS event_log_no_delete BEFORE DELETE ON event_log BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
CREATE TABLE IF NOT EXISTS positions (source TEXT PRIMARY KEY, value TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projection_state (name TEXT PRIMARY KEY, version INTEGER NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * An event as stored and read back (its body opened when it was sealed).
 * @typedef {object} StoredEvent
 * @property {number} seq                 position in the log, from 1
 * @property {string} type
 * @property {import('../contracts/data-classes.js').DataClass} class
 * @property {string} source
 * @property {string} key                 the source's idempotency key
 * @property {string} at                  when it happened
 * @property {string} recorded            when the store took it
 * @property {string} id                  a random UUID
 * @property {Record<string, unknown>} body
 */

/**
 * A projection: a derived view of the log. `apply` must be deterministic; raising `version` makes
 * the store reset the view and replay the whole log into it.
 * @typedef {object} Projection
 * @property {string} name
 * @property {number} version
 * @property {(db: DatabaseSync) => void} setup   creates its tables (idempotent)
 * @property {(db: DatabaseSync) => void} reset   empties its tables
 * @property {(db: DatabaseSync, event: StoredEvent) => void} apply
 */

/**
 * Seals and opens event bodies of protected classes (provided by the vault).
 * @typedef {object} BodyCodec
 * @property {(plain: string, aad: string) => string} seal
 * @property {(sealed: string, aad: string) => string} open
 */

/** @typedef {{ seq: number, event_id: string, source: string, dedupe: string, type: string, class: string, happened: string, recorded: string, body: string, link: string }} EventRow */

/**
 * Hash of one event row as stored (sealed body included), the input of the running link.
 * @param {Omit<EventRow, 'link'>} row
 */
export const eventRowHash = (row) =>
  sha256Hex(`starpi-companion/event/1\n${canonicalJson({ seq: Number(row.seq), event_id: row.event_id, source: row.source, dedupe: row.dedupe, type: row.type, class: row.class, happened: row.happened, recorded: row.recorded, body: row.body })}`);

/**
 * The link of a row: SHA-256 over the previous link and the row hash.
 * @param {string} previous
 * @param {Omit<EventRow, 'link'>} row
 */
export const nextLink = (previous, row) => sha256Hex(`${previous}${eventRowHash(row)}`);

/**
 * Opens a database file with the pragmas every connection of the companion uses.
 * @param {string} path  file path or ':memory:'
 */
export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
  return db;
}

/** @param {DatabaseSync} db */
const hasLog = (db) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_log'").get() !== undefined;

/**
 * The link stored at a seq of the log, or null.
 * @param {DatabaseSync} db
 * @param {number} seq
 * @returns {string | null}
 */
export function linkAt(db, seq) {
  if (!hasLog(db)) return null;
  const row = /** @type {{ link: string } | undefined} */ (db.prepare('SELECT link FROM event_log WHERE seq = ?').get(seq));
  return row?.link ?? null;
}

/**
 * The newest event row's seq and link (seq 0 and the zero hash for an empty log).
 * @param {DatabaseSync} db
 */
export function eventsHead(db) {
  if (!hasLog(db)) return { seq: 0, link: ZERO_HASH };
  const row = /** @type {{ seq: number, link: string } | undefined} */ (db.prepare('SELECT seq, link FROM event_log ORDER BY seq DESC LIMIT 1').get());
  return row ? { seq: Number(row.seq), link: row.link } : { seq: 0, link: ZERO_HASH };
}

/**
 * Recomputes the links of the whole log. Findings name the first row that does not hold.
 * @param {DatabaseSync} db
 * @returns {Array<{ kind: string, seq: number }>}
 */
export function verifyEventLinks(db) {
  if (!hasLog(db)) return [];
  let previous = ZERO_HASH;
  let expectedSeq = null;
  for (const raw of db.prepare('SELECT * FROM event_log ORDER BY seq').iterate()) {
    const row = /** @type {EventRow} */ (/** @type {unknown} */ (raw));
    const seq = Number(row.seq);
    if (expectedSeq !== null && seq !== expectedSeq) return [{ kind: 'events_gap', seq: expectedSeq }];
    if (nextLink(previous, row) !== row.link) return [{ kind: 'events_link_mismatch', seq }];
    previous = row.link;
    expectedSeq = seq + 1;
  }
  return [];
}

/**
 * Opens (or creates) the store.
 * @param {object} options
 * @param {string} options.path
 * @param {import('../lib/clock.js').Clock} [options.clock]
 * @param {import('../contracts/event.js').EventTypes} [options.types]
 * @param {Projection[]} [options.projections]
 * @param {BodyCodec | null} [options.codec]
 */
export function openStore({ path, clock = systemClock, types = createEventTypes(), projections = [], codec = null }) {
  const db = openDatabase(path);
  const generation = Number(/** @type {{ user_version: number }} */ (db.prepare('PRAGMA user_version').get()).user_version);
  if (generation > STORE_SCHEMA) {
    db.close();
    throw fail('store_too_new', `the database was written by a newer companion (schema ${generation}, this one knows ${STORE_SCHEMA})`);
  }
  db.exec(SCHEMA);
  if (generation < STORE_SCHEMA) db.exec(`PRAGMA user_version = ${STORE_SCHEMA}`);

  const insert = db.prepare(`INSERT INTO event_log (event_id, source, dedupe, type, class, happened, recorded, body, link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, dedupe) DO NOTHING`);
  const lastRow = db.prepare('SELECT seq, link FROM event_log ORDER BY seq DESC LIMIT 1');
  const nextSeqOf = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'event_log'");
  const putPosition = db.prepare(`INSERT INTO positions (source, value, updated) VALUES (?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET value = excluded.value, updated = excluded.updated`);
  const getPositionRow = db.prepare('SELECT value FROM positions WHERE source = ?');
  const getState = db.prepare('SELECT version, seq FROM projection_state WHERE name = ?');
  const putState = db.prepare(`INSERT INTO projection_state (name, version, seq) VALUES (?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET version = excluded.version, seq = excluded.seq`);
  const getMeta = db.prepare('SELECT value FROM meta WHERE name = ?');
  const putMeta = db.prepare('INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value');

  let inTransaction = false;
  /**
   * Runs `fn` as one write transaction (taken at once, so writers queue instead of failing later);
   * a call from inside a transaction simply joins it.
   * @template T
   * @param {() => T} work   the statements to run
   * @returns {T} what `work` returns
   */
  function transaction(work) {
    if (inTransaction) return work();
    inTransaction = true;
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const value = work();
      db.exec('COMMIT');
      committed = true;
      return value;
    } finally {
      if (!committed) db.exec('ROLLBACK');
      inTransaction = false;
    }
  }

  /** @param {EventRow} row @returns {StoredEvent} */
  function decode(row) {
    let text = row.body;
    if (row.class !== 'public') {
      if (!codec) throw fail('store_codec_missing', 'a sealed event body cannot be read without the vault');
      text = codec.open(row.body, `event:${row.event_id}`);
    }
    const dataClass = /** @type {StoredEvent['class']} */ (row.class);
    return { seq: Number(row.seq), type: row.type, class: dataClass, source: row.source, key: row.dedupe, at: row.happened, recorded: row.recorded, id: row.event_id, body: JSON.parse(text) };
  }

  /** @param {Projection} p @param {StoredEvent} event */
  function applyOne(p, event) {
    p.apply(db, event);
    putState.run(p.name, p.version, event.seq);
  }

  /** Brings every projection up to the newest event; a changed version resets and replays it. */
  function catchUp() {
    const newest = eventsHead(db).seq;
    for (const p of projections) {
      p.setup(db);
      const state = /** @type {{ version: number, seq: number } | undefined} */ (getState.get(p.name));
      let from = state ? Number(state.seq) : 0;
      if (!state || Number(state.version) !== p.version) {
        transaction(() => {
          p.reset(db);
          putState.run(p.name, p.version, 0);
        });
        from = 0;
      }
      while (from < newest) {
        transaction(() => {
          const rows = db.prepare('SELECT * FROM event_log WHERE seq > ? ORDER BY seq LIMIT 500').all(from);
          for (const raw of rows) {
            const event = decode(/** @type {EventRow} */ (/** @type {unknown} */ (raw)));
            applyOne(p, event);
            from = event.seq;
          }
        });
      }
    }
  }

  /**
   * Appends events in one transaction. One invalid event refuses the whole batch; an event whose
   * source and key are stored already is skipped and counted as a duplicate.
   * @param {import('../contracts/event.js').EventInput[]} events
   * @param {{ position?: { source: string, value: unknown } }} [options]
   * @returns {{ inserted: StoredEvent[], duplicates: number }}
   */
  function append(events, options = {}) {
    for (const event of events) {
      const problems = checkEvent(event, types);
      if (problems.length > 0) throw fail('event_invalid', `event refused: ${problems.slice(0, 3).join('; ')}`, { status: 400, details: { problems } });
      if (event.class !== 'public' && !codec) throw fail('store_codec_missing', `an event of class ${event.class} needs the vault to seal its body`);
    }
    const recorded = isoAt(clock.now());
    /** @type {StoredEvent[]} */
    const fresh = [];
    let skipped = 0;
    transaction(() => {
      for (const event of events) {
        const id = randomUUID();
        const plain = canonicalJson(event.body);
        const body = event.class === 'public' ? plain : /** @type {BodyCodec} */ (codec).seal(plain, `event:${id}`);
        const last = /** @type {{ seq: number, link: string } | undefined} */ (lastRow.get());
        const seq = Number(/** @type {{ seq: number } | undefined} */ (nextSeqOf.get())?.seq ?? 0) + 1;
        const row = { seq, event_id: id, source: event.source, dedupe: event.key, type: event.type, class: event.class, happened: event.at, recorded, body };
        const link = nextLink(last ? last.link : ZERO_HASH, row);
        const result = insert.run(id, event.source, event.key, event.type, event.class, event.at, recorded, body, link);
        if (Number(result.changes) === 0) {
          skipped += 1;
          continue;
        }
        if (Number(result.lastInsertRowid) !== seq) throw fail('store_sequence', `event stored at seq ${result.lastInsertRowid}, expected ${seq}`);
        const stored = { seq, type: event.type, class: event.class, source: event.source, key: event.key, at: event.at, recorded, id, body: event.body };
        for (const p of projections) applyOne(p, stored);
        fresh.push(stored);
      }
      if (options.position) putPosition.run(options.position.source, JSON.stringify(options.position.value), recorded);
    });
    return { inserted: fresh, duplicates: skipped };
  }

  /**
   * Reads events in order.
   * @param {{ afterSeq?: number, types?: string[], limit?: number }} [query]
   * @returns {StoredEvent[]}
   */
  function read({ afterSeq = 0, types: only = [], limit = 1000 } = {}) {
    const cap = Math.max(1, Math.min(limit, 10_000));
    const rows = only.length > 0
      ? db.prepare(`SELECT * FROM event_log WHERE seq > ? AND type IN (${only.map(() => '?').join(',')}) ORDER BY seq LIMIT ?`).all(afterSeq, ...only, cap)
      : db.prepare('SELECT * FROM event_log WHERE seq > ? ORDER BY seq LIMIT ?').all(afterSeq, cap);
    return rows.map((raw) => decode(/** @type {EventRow} */ (/** @type {unknown} */ (raw))));
  }

  catchUp();

  return {
    db,
    path,
    types,
    head: () => eventsHead(db),
    append,
    read,
    transaction,
    verifyLinks: () => verifyEventLinks(db),
    /** @param {string} source @returns {unknown} */
    position(source) {
      const row = /** @type {{ value: string } | undefined} */ (getPositionRow.get(source));
      return row ? JSON.parse(row.value) : null;
    },
    meta: {
      /** @param {string} name @returns {string | null} */
      get: (name) => /** @type {{ value: string } | undefined} */ (getMeta.get(name))?.value ?? null,
      /** @param {string} name @param {string} value */
      set: (name, value) => {
        putMeta.run(name, value);
      },
    },
    /** Folds the WAL into the main file (before a copy of the file is taken). */
    checkpoint() {
      if (path !== ':memory:') db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },
    close: () => db.close(),
  };
}

/** @typedef {ReturnType<typeof openStore>} Store */
