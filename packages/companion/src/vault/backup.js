// @ts-check
// Backup and restore of an installation.
//
// create: into a new or empty folder outside the data and anchor folders (0700, files 0600):
//   data/companion.db      a consistent copy of the database (VACUUM INTO; the companion may run)
//   data/vault/...         the keyring (keys wrapped by the KEK; the KEK itself is never copied)
//                          and the sealed blobs
//   manifest.json          format, time, the audit head and event head of the copy, the KEK id,
//                          the SHA-256 and size of every file, signed with the identity key
// A backup is as sealed as the installation: without the KEK it opens nothing.
//
// restore: into an empty data folder, with the companion stopped. Every check runs before anything
// is written: the manifest's signature (against the key pinned in the anchor folder when there is
// one) and every file hash, the KEK, and the copy's audit chain. A copy older than the newest anchor
// is a rollback and is refused unless the owner accepts it; then the restored state is pinned by a
// signed `restore` anchor, so the rollback stays on record. After the files are in place, the
// deletion list is applied again: nothing the owner deleted after the backup comes back.
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { canonicalJson, sha256Hex } from '../lib/canonical.js';
import { isoAt, systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';
import { ensurePrivateDir, exists, isDir, listDir, pathsOverlap, readRegularFile, writeFileAtomic } from '../lib/fsx.js';
import { openDatabase, eventsHead, verifyEventLinks } from '../store/sqlite.js';
import { chainHead, verifyChain } from '../audit/chain.js';
import { checkAnchors, readPinnedKey } from '../audit/anchors.js';
import { keyIdOf, publicKeyFromRaw, verifySignature } from '../audit/identity.js';
import { readKeyringFile } from './keyring.js';
import { kekId } from './crypto.js';

export const BACKUP_FORMAT = 'starpi-companion.backup/1';
export const DB_FILE = 'companion.db';
const MANIFEST = 'manifest.json';

/**
 * @typedef {object} Manifest
 * @property {string} format
 * @property {string} created
 * @property {{ keyId: string, publicKey: string }} companion
 * @property {{ seq: number, hash: string }} audit
 * @property {{ seq: number, link: string }} events
 * @property {{ provider: string, id: string }} kek
 * @property {Array<{ path: string, sha256: string, bytes: number }>} files
 * @property {string} sig
 */

/** @param {Omit<Manifest, 'sig'>} body */
const signingText = (body) => `starpi-companion/backup/1\n${canonicalJson(body)}`;

/** Every regular file below a folder, as forward-slash relative paths. @param {string} root */
function filesBelow(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of listDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !entry.name.endsWith('.tmp')) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/** @param {string} file */
const hashFile = (file) => {
  const bytes = readRegularFile(file, 4 * 1024 * 1024 * 1024);
  if (bytes === null) throw fail('backup_changed', `${basename(file)} vanished`);
  return { sha256: sha256Hex(bytes), bytes: bytes.length };
};

/** @param {string} dir */
function assertEmptyTarget(dir) {
  if (exists(dir) && (!isDir(dir) || readdirSync(dir).length > 0)) throw fail('backup_target_not_empty', 'the target folder must be new or empty', { status: 400 });
}

/**
 * @param {object} options
 * @param {import('../store/sqlite.js').Store} options.store
 * @param {string} options.dataDir
 * @param {string} options.anchorDir
 * @param {string} options.outDir
 * @param {import('../audit/identity.js').Identity} options.identity
 * @param {import('../lib/clock.js').Clock} [options.clock]
 * @returns {Manifest}
 */
export function createBackup({ store, dataDir, anchorDir, outDir, identity, clock = systemClock }) {
  if (pathsOverlap(outDir, dataDir) || pathsOverlap(outDir, anchorDir)) throw fail('backup_target_overlaps', 'the backup folder must lie outside the data and anchor folders', { status: 400 });
  assertEmptyTarget(outDir);
  ensurePrivateDir(outDir, { tighten: true });
  const dataOut = join(outDir, 'data');
  try {
    ensurePrivateDir(join(dataOut, 'vault'));
    store.db.prepare('VACUUM INTO ?').run(join(dataOut, DB_FILE));
    const vaultDir = join(dataDir, 'vault');
    for (const rel of filesBelow(vaultDir)) {
      const target = join(dataOut, 'vault', ...rel.split('/'));
      ensurePrivateDir(dirname(target));
      copyFileSync(join(vaultDir, ...rel.split('/')), target);
    }
    const keyring = readKeyringFile(join(dataOut, 'vault', 'keyring.json'));
    if (!keyring) throw fail('backup_failed', 'the keyring is missing');
    const copy = openDatabase(join(dataOut, DB_FILE));
    let audit;
    let events;
    try {
      audit = chainHead(copy);
      events = eventsHead(copy);
    } finally {
      copy.close();
    }
    const files = filesBelow(dataOut).map((rel) => ({ path: `data/${rel}`, ...hashFile(join(dataOut, ...rel.split('/'))) }));
    /** @type {Omit<Manifest, 'sig'>} */
    const body = { format: BACKUP_FORMAT, created: isoAt(clock.now()), companion: { keyId: identity.keyId, publicKey: identity.publicKey }, audit, events, kek: keyring.kek, files };
    const manifest = { ...body, sig: identity.sign(signingText(body)) };
    writeFileAtomic(join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (err) {
    rmSync(dataOut, { recursive: true, force: true });
    rmSync(join(outDir, MANIFEST), { force: true });
    throw err;
  }
}

/**
 * Checks a backup folder: manifest shape, signature, and every file's hash.
 * @param {string} dir
 * @param {{ pinnedKeyId?: string | null }} [options]
 * @returns {{ ok: boolean, manifest: Manifest | null, findings: string[] }}
 */
export function verifyBackup(dir, { pinnedKeyId = null } = {}) {
  const raw = readRegularFile(join(dir, MANIFEST), 16 * 1024 * 1024);
  if (raw === null) return { ok: false, manifest: null, findings: ['manifest_missing'] };
  /** @type {Manifest} */
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, manifest: null, findings: ['manifest_invalid'] };
  }
  if (manifest?.format !== BACKUP_FORMAT || !Array.isArray(manifest.files) || typeof manifest.companion?.publicKey !== 'string') return { ok: false, manifest: null, findings: ['manifest_invalid'] };
  /** @type {string[]} */
  const findings = [];
  const { sig, ...body } = manifest;
  let keyOk;
  try {
    keyOk = keyIdOf(manifest.companion.publicKey) === manifest.companion.keyId && verifySignature(publicKeyFromRaw(manifest.companion.publicKey), signingText(body), sig);
  } catch {
    keyOk = false;
  }
  if (!keyOk) findings.push('manifest_signature');
  if (pinnedKeyId !== null && manifest.companion.keyId !== pinnedKeyId) findings.push('backup_other_companion');
  const listed = new Set();
  for (const f of manifest.files) {
    if (typeof f?.path !== 'string' || !/^data\/[A-Za-z0-9._/-]+$/.test(f.path) || f.path.split('/').some((s) => s === '..' || s === '.')) {
      findings.push('manifest_invalid');
      continue;
    }
    listed.add(f.path);
    const bytes = readRegularFile(join(dir, ...f.path.split('/')), 4 * 1024 * 1024 * 1024);
    if (bytes === null) findings.push(`file_missing:${f.path}`);
    else if (bytes.length !== f.bytes || sha256Hex(bytes) !== f.sha256) findings.push(`file_changed:${f.path}`);
  }
  for (const rel of filesBelow(join(dir, 'data'))) if (!listed.has(`data/${rel}`)) findings.push(`file_unlisted:data/${rel}`);
  if (!listed.has(`data/${DB_FILE}`) || !listed.has('data/vault/keyring.json')) findings.push('manifest_incomplete');
  return { ok: findings.length === 0, manifest, findings };
}

/**
 * Restores a backup into an empty data folder. Returns what the caller must finish once the
 * restored installation is open: whether this was a rollback past the newest anchor.
 * @param {object} options
 * @param {string} options.backupDir
 * @param {string} options.dataDir
 * @param {string} options.anchorDir
 * @param {Buffer} options.kek
 * @param {boolean} [options.acceptRollback]
 * @returns {{ manifest: Manifest, rollback: boolean, supersedes: number | null }}
 */
export function restoreBackup({ backupDir, dataDir, anchorDir, kek, acceptRollback = false }) {
  if (pathsOverlap(backupDir, dataDir)) throw fail('restore_overlaps', 'the backup folder must lie outside the data folder', { status: 400 });
  const pinned = readPinnedKey(anchorDir);
  const check = verifyBackup(backupDir, { pinnedKeyId: pinned?.keyId ?? null });
  if (!check.ok || !check.manifest) throw fail('backup_invalid', `the backup does not verify (${check.findings.slice(0, 3).join(', ')})`, { status: 400, details: { findings: check.findings } });
  const manifest = check.manifest;
  if (kekId(kek) !== manifest.kek.id) throw fail('kek_mismatch', 'the configured key-encryption key does not open this backup', { status: 400 });
  if (exists(dataDir) && (!isDir(dataDir) || readdirSync(dataDir).length > 0)) throw fail('restore_target_not_empty', 'restore into an empty data folder (move the current one aside first)', { status: 400 });
  const staging = join(dirname(dataDir), `.${basename(dataDir)}.restore-${process.pid}-${Date.now()}`);
  ensurePrivateDir(staging);
  try {
    for (const f of manifest.files) {
      const target = join(staging, ...f.path.split('/').slice(1));
      ensurePrivateDir(dirname(target));
      copyFileSync(join(backupDir, ...f.path.split('/')), target);
    }
    const db = openDatabase(join(staging, DB_FILE));
    let rollback = false;
    let supersedes = null;
    try {
      const chain = verifyChain(db);
      const links = verifyEventLinks(db);
      if (chain.findings.length > 0 || links.length > 0) throw fail('restore_not_verified', 'the audit chain or the event log of the backup does not verify', { status: 400 });
      if (chain.head.seq !== manifest.audit.seq || chain.head.hash !== manifest.audit.hash) throw fail('restore_not_verified', 'the database does not end where the manifest says', { status: 400 });
      if (pinned) {
        const anchors = checkAnchors({ db, anchorDir, keyId: manifest.companion.keyId });
        const invalid = anchors.findings.filter((f) => f.kind !== 'audit_rollback');
        if (invalid.length > 0) throw fail('anchor_invalid', 'the anchor folder does not verify', { status: 400, details: { findings: invalid } });
        if (anchors.findings.length > 0) {
          if (!acceptRollback) throw fail('audit_rollback', 'the backup is older than the newest anchor; restore it only on purpose (accept the rollback)', { status: 409, details: { findings: anchors.findings } });
          rollback = true;
          supersedes = anchors.newest?.n ?? null;
        }
      }
    } finally {
      db.close();
    }
    mkdirSync(dirname(dataDir), { recursive: true });
    if (exists(dataDir)) rmSync(dataDir, { recursive: true });
    renameSync(staging, dataDir);
    return { manifest, rollback, supersedes };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/** Size of a backup folder in bytes (for the CLI's summary). @param {string} dir */
export function backupSize(dir) {
  return filesBelow(dir).reduce((sum, rel) => sum + statSync(join(dir, ...rel.split('/'))).size, 0);
}
