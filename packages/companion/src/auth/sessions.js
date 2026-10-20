// @ts-check
// Pairing and sessions. `starpi-companion pair` prints a one-time code (8 characters without
// look-alikes, valid for 10 minutes); the store keeps only its salted scrypt hash. The browser
// sends the code to POST /v1/session/pair and gets one of two kinds of session:
//   Mode A (the app served by the companion itself, same origin): an HttpOnly, SameSite=Strict
//     cookie plus a second random value the app must send in X-Companion-CSRF on every call;
//   Mode B (the hosted app, an allowed cross origin): a bearer token bound to that origin.
// Only SHA-256 hashes of cookie, CSRF value and token are stored. Five wrong codes in a row make
// every open code invalid. Pairing, revoking and code issuing are audited; codes and tokens never
// reach a log line or the audit chain.
import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { isoAt, systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';
import { isRole } from '../contracts/roles.js';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_FAILURES = 5;
export const DEFAULT_SESSION_DAYS = 30;
export const CSRF_HEADER = 'x-companion-csrf';
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT NOT NULL,
  created TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT,
  role TEXT NOT NULL,
  origin TEXT,
  label TEXT NOT NULL,
  created TEXT NOT NULL,
  expires INTEGER NOT NULL,
  last_used INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
`;

/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Constant-time comparison of two hex digests of equal length. @param {string} a @param {string} b */
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** A fresh pairing code. */
export function newPairingCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** What a person typed, reduced to the code alphabet (spaces and dashes dropped, upper case). @param {unknown} input */
export function normalizeCode(input) {
  if (typeof input !== 'string') return '';
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** @param {unknown} label */
const cleanLabel = (label) => (typeof label === 'string' ? label.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) : '');

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {'cookie' | 'bearer'} kind
 * @property {import('../contracts/roles.js').Role} role
 * @property {string | null} origin
 * @property {string} label
 * @property {string} created
 * @property {number} expires
 */

/**
 * @param {object} options
 * @param {import('../store/sqlite.js').Store} options.store
 * @param {import('../audit/chain.js').AuditChain} [options.chain]
 * @param {import('../lib/clock.js').Clock} [options.clock]
 * @param {number} [options.codeTtlMs]
 * @param {number} [options.sessionDays]
 */
export function createSessions({ store, chain, clock = systemClock, codeTtlMs = CODE_TTL_MS, sessionDays = DEFAULT_SESSION_DAYS }) {
  const { db } = store;
  db.exec(SCHEMA);
  const audit = (/** @type {string} */ kind, /** @type {string} */ subject, /** @type {Record<string, unknown>} */ details, actor = 'companion') => chain?.append({ kind, subject, actor, details });

  /**
   * Issues a pairing code.
   * @param {{ role?: import('../contracts/roles.js').Role, label?: string, actor?: string }} [options]
   */
  function issueCode({ role = 'member', label = '', actor = 'cli' } = {}) {
    if (!isRole(role)) throw fail('role_invalid', 'role is owner or member', { status: 400 });
    const code = newPairingCode();
    const salt = randomBytes(16).toString('hex');
    const id = randomUUID();
    const expires = clock.now() + codeTtlMs;
    const name = cleanLabel(label);
    db.prepare('INSERT INTO auth_codes (id, salt, hash, role, label, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, salt, scryptSync(code, Buffer.from(salt, 'hex'), 32, SCRYPT).toString('hex'), role, name, isoAt(clock.now()), expires,
    );
    audit('session.code_issued', id, { role, label: name, expires: isoAt(expires) }, actor);
    return { id, code, role, expiresAt: isoAt(expires) };
  }

  /**
   * Turns a valid code into a session.
   * @param {{ code: unknown, kind: 'cookie' | 'bearer', origin: string | null, label?: unknown }} request
   */
  function pair({ code, kind, origin, label }) {
    const typed = normalizeCode(code);
    const now = clock.now();
    const open = /** @type {Array<{ id: string, salt: string, hash: string, role: string, label: string }>} */ (
      db.prepare('SELECT id, salt, hash, role, label FROM auth_codes WHERE used = 0 AND expires > ?').all(now)
    );
    let match = null;
    if (typed.length === CODE_LENGTH && [...typed].every((c) => CODE_ALPHABET.includes(c))) {
      for (const entry of open) {
        if (sameHex(scryptSync(typed, Buffer.from(entry.salt, 'hex'), 32, SCRYPT).toString('hex'), entry.hash)) match = entry;
      }
    }
    if (!match) {
      const failures = Number(store.meta.get('auth_failures') ?? '0') + 1;
      if (failures >= MAX_FAILURES) {
        db.prepare('UPDATE auth_codes SET used = 1 WHERE used = 0').run();
        store.meta.set('auth_failures', '0');
        audit('session.codes_invalidated', 'all', { reason: 'failures', failures });
      } else {
        store.meta.set('auth_failures', String(failures));
      }
      throw fail('pairing_failed', 'the pairing code is wrong or expired', { status: 401 });
    }
    store.meta.set('auth_failures', '0');
    const token = randomBytes(32).toString('base64url');
    const csrf = kind === 'cookie' ? randomBytes(32).toString('base64url') : null;
    const id = randomUUID();
    const expires = now + sessionDays * 86_400_000;
    const name = cleanLabel(label) || match.label;
    store.transaction(() => {
      const claimed = db.prepare('UPDATE auth_codes SET used = 1 WHERE id = ? AND used = 0').run(match.id);
      if (Number(claimed.changes) !== 1) throw fail('pairing_failed', 'the pairing code was used already', { status: 401 });
      db.prepare('INSERT INTO auth_sessions (id, kind, token_hash, csrf_hash, role, origin, label, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, kind, sha256(token), csrf === null ? null : sha256(csrf), match.role, origin, name, isoAt(now), expires,
      );
    });
    audit('session.paired', id, { role: match.role, kind, origin, label: name });
    return { session: id, token, csrf, role: /** @type {import('../contracts/roles.js').Role} */ (match.role), expiresAt: isoAt(expires) };
  }

  /**
   * The session a request presents, checked by its kind's rules; null when none holds.
   * @param {{ bearer?: string | null, cookie?: string | null, csrf?: string | null, origin: string | null, sameOrigin: boolean }} presented
   * @returns {Session | null}
   */
  function authenticate({ bearer = null, cookie = null, csrf = null, origin, sameOrigin }) {
    const now = clock.now();
    /** @param {string} token */
    const find = (token) => /** @type {any} */ (db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ? AND revoked = 0 AND expires > ?').get(sha256(token), now));
    let row = null;
    if (bearer) {
      const candidate = find(bearer);
      // A bearer token works from the origin it was paired from, or from a client that sends no
      // Origin at all (a script on this machine); never from another web origin.
      if (candidate?.kind === 'bearer' && (origin === null || origin === candidate.origin)) row = candidate;
    } else if (cookie) {
      const candidate = find(cookie);
      if (candidate?.kind === 'cookie' && sameOrigin && typeof csrf === 'string' && candidate.csrf_hash && sameHex(sha256(csrf), candidate.csrf_hash)) row = candidate;
    }
    if (!row) return null;
    if (!row.last_used || now - Number(row.last_used) > 60_000) db.prepare('UPDATE auth_sessions SET last_used = ? WHERE id = ?').run(now, row.id);
    return { id: row.id, kind: row.kind, role: row.role, origin: row.origin, label: row.label, created: row.created, expires: Number(row.expires) };
  }

  /**
   * Revokes one session by id, or every session.
   * @param {{ id?: string, all?: boolean, actor?: string }} target
   */
  function revoke({ id, all = false, actor = 'cli' }) {
    if (all) {
      const n = Number(db.prepare('UPDATE auth_sessions SET revoked = 1 WHERE revoked = 0').run().changes);
      db.prepare('UPDATE auth_codes SET used = 1 WHERE used = 0').run();
      audit('session.revoked', 'all', { sessions: n }, actor);
      return n;
    }
    if (typeof id !== 'string') throw fail('session_unknown', 'name a session id or all', { status: 400 });
    const n = Number(db.prepare('UPDATE auth_sessions SET revoked = 1 WHERE id = ? AND revoked = 0').run(id).changes);
    if (n > 0) audit('session.revoked', id, { sessions: n }, actor);
    return n;
  }

  return {
    issueCode,
    pair,
    authenticate,
    revoke,
    /** Active sessions without any secret. */
    list() {
      return /** @type {any[]} */ (db.prepare('SELECT id, kind, role, origin, label, created, expires, last_used FROM auth_sessions WHERE revoked = 0 AND expires > ? ORDER BY created').all(clock.now())).map((r) => ({
        id: r.id, kind: r.kind, role: r.role, origin: r.origin, label: r.label, created: r.created, expiresAt: isoAt(Number(r.expires)), lastUsed: r.last_used ? isoAt(Number(r.last_used)) : null,
      }));
    },
    /** Removes used or expired codes and ended sessions. */
    sweep() {
      const now = clock.now();
      const codes = Number(db.prepare('DELETE FROM auth_codes WHERE used = 1 OR expires <= ?').run(now).changes);
      const sessions = Number(db.prepare('DELETE FROM auth_sessions WHERE revoked = 1 OR expires <= ?').run(now).changes);
      return { codes, sessions };
    },
  };
}

/** @typedef {ReturnType<typeof createSessions>} Sessions */
