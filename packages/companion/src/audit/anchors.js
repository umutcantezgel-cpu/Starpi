// @ts-check
// Anchors: signed checkpoints of the audit chain and the event log, written into a folder outside
// the data folder (ideally another disk or a share the companion may add to but not rewrite). They
// catch what the chain alone cannot: someone putting back an older copy of the whole data folder,
// whose chain is perfectly consistent, only shorter.
//
// Anchor n (file anchor-<n, 8 digits>.json, written once, read-only):
//   { v: 1, type: 'checkpoint' | 'restore', n, at, audit: {seq, hash}, events: {seq, link},
//     prev, key, supersedes?, sig }
// `prev` is the SHA-256 of the canonical JSON of anchor n-1 (zeros for n = 1), `key` the identity
// key id, `sig` an Ed25519 signature over "starpi-companion/anchor/1\n" + the canonical JSON of the
// other members. The public key is pinned once in identity.pub of the same folder.
//
// Start check: every anchor verifies and links to its predecessor, and the database still reaches
// the newest one: the audit record at its seq has its hash and the event row at its seq has its
// link. Otherwise the companion refuses to start with `audit_rollback`. A restore of a backup writes
// a `restore` anchor naming the restored state, so a deliberate rollback is accepted and stays on
// record.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, HEX64, sha256Hex, ZERO_HASH } from '../lib/canonical.js';
import { isoAt, systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';
import { ensurePrivateDir, isDir, readRegularFile, writeFileOnce } from '../lib/fsx.js';
import { eventsHead } from '../store/sqlite.js';
import { chainHead, recordAt } from './chain.js';
import { keyIdOf, publicKeyFromRaw, verifySignature } from './identity.js';

export const PUBLIC_KEY_FILE = 'identity.pub';
const ANCHOR_NAME = /^anchor-(\d{8})\.json$/;
const MAX_ANCHOR_BYTES = 4096;
/** Records between two anchors while the companion works. */
export const DEFAULT_ANCHOR_EVERY = 256;
/** Longest time between two anchors while records come in. */
export const DEFAULT_ANCHOR_INTERVAL_MS = 10 * 60_000;

/**
 * @typedef {object} Anchor
 * @property {1} v
 * @property {'checkpoint' | 'restore'} type
 * @property {number} n
 * @property {string} at
 * @property {{ seq: number, hash: string }} audit
 * @property {{ seq: number, link: string }} events
 * @property {string} prev
 * @property {string} key
 * @property {number} [supersedes]
 * @property {string} sig
 */

/** @typedef {{ kind: string, n?: number, reason?: string, detail?: string }} AnchorFinding */

/** @param {number} n */
export const anchorFileName = (n) => `anchor-${String(n).padStart(8, '0')}.json`;

/** @param {Omit<Anchor, 'sig'>} body */
const signingText = (body) => `starpi-companion/anchor/1\n${canonicalJson(body)}`;

/** The digest the next anchor links to. @param {Anchor} anchor */
export const anchorDigest = (anchor) => sha256Hex(canonicalJson(anchor));

/**
 * The pinned public key of an anchor folder, or null.
 * @param {string} anchorDir
 * @returns {{ publicKey: string, keyId: string } | null}
 */
export function readPinnedKey(anchorDir) {
  const raw = readRegularFile(join(anchorDir, PUBLIC_KEY_FILE), 1024);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw fail('anchor_invalid', `${PUBLIC_KEY_FILE} is not JSON`);
  }
  if (parsed?.alg !== 'Ed25519' || typeof parsed.publicKey !== 'string' || keyIdOf(parsed.publicKey) !== parsed.keyId) throw fail('anchor_invalid', `${PUBLIC_KEY_FILE} does not hold a consistent Ed25519 key`);
  return { publicKey: parsed.publicKey, keyId: parsed.keyId };
}

/**
 * Pins the identity's public key in the folder (once). A folder pinned to another key is refused.
 * @param {string} anchorDir
 * @param {import('./identity.js').Identity} identity
 */
export function pinKey(anchorDir, identity) {
  const pinned = readPinnedKey(anchorDir);
  if (pinned) {
    if (pinned.keyId !== identity.keyId) throw fail('anchor_key_mismatch', 'the anchor folder belongs to another companion identity');
    return;
  }
  ensurePrivateDir(anchorDir);
  writeFileOnce(join(anchorDir, PUBLIC_KEY_FILE), `${JSON.stringify({ alg: 'Ed25519', publicKey: identity.publicKey, keyId: identity.keyId })}\n`, { mode: 0o444 });
}

/** Anchor numbers present in a folder, ascending. @param {string} anchorDir */
function anchorNumbers(anchorDir) {
  if (!isDir(anchorDir)) return [];
  return readdirSync(anchorDir)
    .map((name) => ANCHOR_NAME.exec(name))
    .filter((m) => m !== null)
    .map((m) => Number(/** @type {RegExpExecArray} */ (m)[1]))
    .sort((a, b) => a - b);
}

/** @param {unknown} a @returns {a is Anchor} */
function anchorShape(a) {
  const x = /** @type {any} */ (a);
  return (
    x !== null && typeof x === 'object' && x.v === 1 && (x.type === 'checkpoint' || x.type === 'restore') && Number.isInteger(x.n) && x.n >= 1 &&
    typeof x.at === 'string' && Number.isInteger(x.audit?.seq) && x.audit.seq >= 0 && HEX64.test(x.audit?.hash) &&
    Number.isInteger(x.events?.seq) && x.events.seq >= 0 && HEX64.test(x.events?.link) && HEX64.test(x.prev) && HEX64.test(x.key) &&
    (x.supersedes === undefined || (Number.isInteger(x.supersedes) && x.supersedes >= 1)) && typeof x.sig === 'string'
  );
}

/**
 * Reads and checks every anchor of a folder against a public key.
 * @param {string} anchorDir
 * @param {{ publicKey: string, keyId: string }} key
 * @returns {{ anchors: Anchor[], findings: AnchorFinding[] }}
 */
export function readAnchors(anchorDir, key) {
  const publicKey = publicKeyFromRaw(key.publicKey);
  /** @type {Anchor[]} */
  const anchors = [];
  /** @type {AnchorFinding[]} */
  const findings = [];
  let prev = ZERO_HASH;
  let expected = 1;
  for (const n of anchorNumbers(anchorDir)) {
    if (n !== expected) {
      findings.push({ kind: 'anchor_invalid', n: expected, reason: 'missing' });
      break;
    }
    const raw = readRegularFile(join(anchorDir, anchorFileName(n)), MAX_ANCHOR_BYTES);
    let anchor;
    try {
      anchor = JSON.parse(/** @type {Buffer} */ (raw).toString('utf8'));
    } catch {
      findings.push({ kind: 'anchor_invalid', n, reason: 'unreadable' });
      break;
    }
    if (!anchorShape(anchor) || anchor.n !== n) {
      findings.push({ kind: 'anchor_invalid', n, reason: 'shape' });
      break;
    }
    const { sig, ...body } = anchor;
    if (anchor.key !== key.keyId || !verifySignature(publicKey, signingText(body), sig)) {
      findings.push({ kind: 'anchor_invalid', n, reason: 'signature' });
      break;
    }
    if (anchor.prev !== prev) {
      findings.push({ kind: 'anchor_invalid', n, reason: 'link' });
      break;
    }
    anchors.push(anchor);
    prev = anchorDigest(anchor);
    expected += 1;
  }
  return { anchors, findings };
}

/**
 * Whether the database still reaches an anchor.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Anchor} anchor
 * @returns {AnchorFinding[]}
 */
export function rollbackFindings(db, anchor) {
  /** @type {AnchorFinding[]} */
  const findings = [];
  const head = chainHead(db);
  if (head.seq < anchor.audit.seq) findings.push({ kind: 'audit_rollback', n: anchor.n, reason: 'head_older', detail: `chain ends at ${head.seq}, anchor names ${anchor.audit.seq}` });
  else if (anchor.audit.seq > 0 && recordAt(db, anchor.audit.seq)?.hash !== anchor.audit.hash) findings.push({ kind: 'audit_rollback', n: anchor.n, reason: 'hash_mismatch', detail: `record ${anchor.audit.seq} differs` });
  const events = eventsHead(db);
  if (events.seq < anchor.events.seq) findings.push({ kind: 'audit_rollback', n: anchor.n, reason: 'events_older', detail: `log ends at ${events.seq}, anchor names ${anchor.events.seq}` });
  else if (anchor.events.seq > 0) {
    const row = /** @type {{ link: string } | undefined} */ (db.prepare('SELECT link FROM events WHERE seq = ?').get(anchor.events.seq));
    if (row?.link !== anchor.events.link) findings.push({ kind: 'audit_rollback', n: anchor.n, reason: 'events_mismatch', detail: `event ${anchor.events.seq} differs` });
  }
  return findings;
}

/**
 * The full anchor check of an installation.
 * @param {{ db: import('node:sqlite').DatabaseSync, anchorDir: string, keyId?: string }} options
 * @returns {{ pinned: { publicKey: string, keyId: string } | null, anchors: Anchor[], newest: Anchor | null, findings: AnchorFinding[] }}
 */
export function checkAnchors({ db, anchorDir, keyId }) {
  const pinned = readPinnedKey(anchorDir);
  if (!pinned) {
    const stray = anchorNumbers(anchorDir).length > 0;
    return { pinned, anchors: [], newest: null, findings: stray ? [{ kind: 'anchor_invalid', reason: 'unpinned' }] : [] };
  }
  if (keyId !== undefined && pinned.keyId !== keyId) return { pinned, anchors: [], newest: null, findings: [{ kind: 'anchor_key_mismatch' }] };
  const { anchors, findings } = readAnchors(anchorDir, pinned);
  const newest = anchors.at(-1) ?? null;
  if (findings.length === 0 && newest) findings.push(...rollbackFindings(db, newest));
  return { pinned, anchors, newest, findings };
}

/**
 * Writes anchors for a running companion: at start, every `every` records, after `intervalMs` when
 * records came in, and at stop.
 * @param {object} options
 * @param {import('../store/sqlite.js').Store} options.store
 * @param {import('./chain.js').AuditChain} options.chain
 * @param {string} options.anchorDir
 * @param {import('./identity.js').Identity} options.identity
 * @param {import('../lib/clock.js').Clock} [options.clock]
 * @param {number} [options.every]
 * @param {number} [options.intervalMs]
 * @param {import('../lib/log.js').Logger} [options.log]
 */
export function createAnchorWriter({ store, chain, anchorDir, identity, clock = systemClock, every = DEFAULT_ANCHOR_EVERY, intervalMs = DEFAULT_ANCHOR_INTERVAL_MS, log = () => {} }) {
  pinKey(anchorDir, identity);
  let since = 0;
  /** @type {unknown} */
  let timer = null;
  let stopped = false;
  /** The newest anchor this writer verified or wrote; the folder is read again only when it moved on. @type {Anchor | null | undefined} */
  let known;

  /** @returns {Anchor | null} */
  function newestAnchor() {
    if (known !== undefined && readRegularFile(join(anchorDir, anchorFileName((known?.n ?? 0) + 1)), MAX_ANCHOR_BYTES) === null) return known;
    const { anchors, findings } = readAnchors(anchorDir, { publicKey: identity.publicKey, keyId: identity.keyId });
    if (findings.length > 0) throw fail('anchor_invalid', `the anchor folder does not verify (${findings[0].reason ?? findings[0].kind})`);
    known = anchors.at(-1) ?? null;
    return known;
  }

  chain.onAppend(() => {
    since += 1;
    if (since >= every) write('checkpoint');
  });

  /**
   * Writes the next anchor. A checkpoint whose state equals the newest anchor is skipped.
   * @param {'checkpoint' | 'restore'} type
   * @param {{ supersedes?: number }} [extra]
   * @returns {Anchor | null}
   */
  function write(type, extra = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const newest = newestAnchor();
      const audit = chainHead(store.db);
      const events = eventsHead(store.db);
      if (type === 'checkpoint' && newest && newest.audit.seq === audit.seq && newest.audit.hash === audit.hash && newest.events.seq === events.seq) {
        since = 0;
        return null;
      }
      /** @type {Omit<Anchor, 'sig'>} */
      const body = { v: 1, type, n: (newest?.n ?? 0) + 1, at: isoAt(clock.now()), audit, events, prev: newest ? anchorDigest(newest) : ZERO_HASH, key: identity.keyId };
      if (extra.supersedes !== undefined) body.supersedes = extra.supersedes;
      const anchor = /** @type {Anchor} */ ({ ...body, sig: identity.sign(signingText(body)) });
      try {
        writeFileOnce(join(anchorDir, anchorFileName(anchor.n)), `${JSON.stringify(anchor)}\n`, { mode: 0o444 });
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 'file_exists') {
          known = undefined;
          continue;
        }
        throw err;
      }
      since = 0;
      known = anchor;
      log('info', 'audit_anchor', { n: anchor.n, type, auditSeq: audit.seq, eventsSeq: events.seq });
      return anchor;
    }
    throw fail('anchor_busy', 'another process kept writing anchors');
  }

  function arm() {
    if (stopped) return;
    timer = clock.setTimeout(() => {
      timer = null;
      try {
        if (since > 0) write('checkpoint');
      } catch (err) {
        log('error', 'audit_anchor_failed', { error: err });
      }
      arm();
    }, intervalMs);
  }

  return {
    write,
    start() {
      write('checkpoint');
      arm();
    },
    stop() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      write('checkpoint');
    },
  };
}
