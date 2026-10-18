// @ts-check
// The audit chain: one row per decision the companion takes on someone's behalf (a device paired, a
// secret set, a namespace erased, a model answer released, a breaker tripped). Each record holds
// the hash of the one before, so changing, removing or reordering a record breaks every later hash.
//
// The head of the chain ({seq, hash}) is signed with the identity key and travels with every
// answer as `auditHead {seq, hash, sig}`. The browser keeps the highest head it saw per companion:
// a lower head, or a different hash at a seq it already knows, means the companion's data were put
// back or forked, and the browser shows that instead of trusting it silently.
//
// Signed message of a head (UTF-8 of the canonical JSON):
//   {"hash":"<64 hex>","key":"<key id>","kind":"starpi.companion.audit-head","seq":<n>,"v":1}
import { canonicalJson, sha256Hex, ZERO_HASH } from '../lib/canonical.js';
import { isoAt, systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';

/** Kinds of records: `area.action`. */
export const RECORD_KIND = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/;
/** Longest canonical JSON of a record's details. */
export const MAX_DETAILS_BYTES = 2048;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  actor TEXT NOT NULL,
  details TEXT NOT NULL,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_append_only_u BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'the audit chain is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_append_only_d BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'the audit chain is append-only'); END;
`;

/**
 * @typedef {object} AuditRecord
 * @property {number} seq
 * @property {string} at
 * @property {string} kind
 * @property {string} subject
 * @property {string} actor
 * @property {Record<string, unknown>} details
 * @property {string} prev
 * @property {string} hash
 */

/** @typedef {{ seq: number, hash: string }} Head */
/** @typedef {{ seq: number, hash: string, sig: string }} SignedHead */

/**
 * The hash of a record over every member but the hash itself.
 * @param {Omit<AuditRecord, 'hash'>} record
 */
export const recordHash = (record) =>
  sha256Hex(`starpi-companion/audit/1\n${canonicalJson({ seq: record.seq, at: record.at, kind: record.kind, subject: record.subject, actor: record.actor, details: record.details, prev: record.prev })}`);

/**
 * The exact text an audit head signature covers.
 * @param {{ keyId: string, seq: number, hash: string }} head
 */
export const auditHeadMessage = ({ keyId, seq, hash }) => canonicalJson({ v: 1, kind: 'starpi.companion.audit-head', key: keyId, seq, hash });

/** @param {any} row @returns {AuditRecord} */
function toRecord(row) {
  return { seq: Number(row.seq), at: row.at, kind: row.kind, subject: row.subject, actor: row.actor, details: JSON.parse(row.details), prev: row.prev, hash: row.hash };
}

/** Creates the table (idempotent). @param {import('node:sqlite').DatabaseSync} db */
export function setupAuditTable(db) {
  db.exec(SCHEMA);
}

/**
 * The newest record's seq and hash, or seq 0 with the zero hash for an empty chain.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Head}
 */
export function chainHead(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get();
  if (!exists) return { seq: 0, hash: ZERO_HASH };
  const row = /** @type {any} */ (db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get());
  return row ? { seq: Number(row.seq), hash: row.hash } : { seq: 0, hash: ZERO_HASH };
}

/**
 * The record at a seq, or null.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} seq
 * @returns {AuditRecord | null}
 */
export function recordAt(db, seq) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get();
  if (!exists) return null;
  const row = db.prepare('SELECT * FROM audit_log WHERE seq = ?').get(seq);
  return row ? toRecord(row) : null;
}

/**
 * Walks the whole chain and recomputes every hash and link.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ head: Head, records: number, findings: Array<{ kind: string, seq: number }> }}
 */
export function verifyChain(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get();
  /** @type {Array<{ kind: string, seq: number }>} */
  const findings = [];
  let previous = ZERO_HASH;
  let expected = 1;
  let records = 0;
  let head = { seq: 0, hash: ZERO_HASH };
  if (!exists) return { head, records, findings };
  for (const row of db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate()) {
    let record;
    try {
      record = toRecord(row);
    } catch {
      findings.push({ kind: 'audit_record_invalid', seq: Number(/** @type {any} */ (row).seq) });
      break;
    }
    if (record.seq !== expected) {
      findings.push({ kind: 'audit_gap', seq: expected });
      break;
    }
    if (record.prev !== previous) {
      findings.push({ kind: 'audit_link_mismatch', seq: record.seq });
      break;
    }
    if (recordHash(record) !== record.hash) {
      findings.push({ kind: 'audit_hash_mismatch', seq: record.seq });
      break;
    }
    previous = record.hash;
    expected += 1;
    records += 1;
    head = { seq: record.seq, hash: record.hash };
  }
  return { head, records, findings };
}

/**
 * The chain bound to a store, with a head signer.
 * @param {object} options
 * @param {import('../store/sqlite.js').Store} options.store
 * @param {import('./identity.js').Identity | null} [options.identity]
 * @param {import('../lib/clock.js').Clock} [options.clock]
 */
export function createAuditChain({ store, identity = null, clock = systemClock }) {
  const { db } = store;
  setupAuditTable(db);
  const last = db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO audit_log (seq, at, kind, subject, actor, details, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  /** @type {Array<(record: AuditRecord) => void>} */
  const listeners = [];
  /** @type {SignedHead | null} */
  let signedCache = null;

  /**
   * Appends one record. The newest stored record is recomputed first: a changed tail refuses the
   * append with `audit_tampered`, so nothing new is chained onto a forged record.
   * @param {{ kind: string, subject?: string, actor?: string, details?: Record<string, unknown> }} entry
   * @returns {AuditRecord}
   */
  function append({ kind, subject = '', actor = 'companion', details = {} }) {
    if (!RECORD_KIND.test(kind)) throw fail('audit_kind', `${JSON.stringify(kind)} is not an audit kind of the form area.action`);
    if (subject.length > 200 || actor.length > 64) throw fail('audit_record_invalid', 'subject or actor too long');
    const detailsText = canonicalJson(details);
    if (Buffer.byteLength(detailsText, 'utf8') > MAX_DETAILS_BYTES) throw fail('audit_record_invalid', `details larger than ${MAX_DETAILS_BYTES} bytes`);
    const record = store.transaction(() => {
      const row = last.get();
      let prev = ZERO_HASH;
      let seq = 1;
      if (row) {
        let tail;
        try {
          tail = toRecord(row);
        } catch {
          throw fail('audit_tampered', 'the newest audit record does not parse');
        }
        if (recordHash(tail) !== tail.hash) throw fail('audit_tampered', `audit record ${tail.seq} was changed outside the companion`);
        prev = tail.hash;
        seq = tail.seq + 1;
      }
      /** @type {Omit<AuditRecord, 'hash'>} */
      const body = { seq, at: isoAt(clock.now()), kind, subject, actor, details: JSON.parse(detailsText), prev };
      const full = { ...body, hash: recordHash(body) };
      insert.run(full.seq, full.at, full.kind, full.subject, full.actor, detailsText, full.prev, full.hash);
      return full;
    });
    signedCache = null;
    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // a listener never undoes a committed record
      }
    }
    return record;
  }

  /**
   * Signs a head (the current one by default).
   * @param {Head} [head]
   * @returns {SignedHead}
   */
  function sign(head) {
    if (!identity) throw fail('identity_missing', 'the audit chain has no signing key');
    const h = head ?? chainHead(db);
    if (!head && signedCache && signedCache.seq === h.seq && signedCache.hash === h.hash) return signedCache;
    const signed = { seq: h.seq, hash: h.hash, sig: identity.sign(auditHeadMessage({ keyId: identity.keyId, seq: h.seq, hash: h.hash })) };
    if (!head) signedCache = signed;
    return signed;
  }

  return {
    append,
    head: () => chainHead(db),
    /** @param {number} seq */
    recordAt: (seq) => recordAt(db, seq),
    signedHead: () => sign(),
    /** The signed head of an earlier record, for the browser's fork check. @param {number} seq */
    signedHeadAt(seq) {
      const record = recordAt(db, seq);
      return record ? sign({ seq: record.seq, hash: record.hash }) : null;
    },
    verify: () => verifyChain(db),
    /** @param {(record: AuditRecord) => void} fn */
    onAppend(fn) {
      listeners.push(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createAuditChain>} AuditChain */
