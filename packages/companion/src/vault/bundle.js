// @ts-check
// Sealed export and import: the content of chosen vault namespaces as one file, encrypted with a
// key derived from a passphrase (scrypt), so it can move to another machine or into cold storage
// without the key-encryption key of this installation.
//
// File (JSON): { format, created, kdf: { name: 'scrypt', N, r, p, salt }, cipher: 'aes-256-gcm',
// namespaces, sealed }. `sealed` (base64url) holds { items: [{ ns, id, data }], blobs: [...] },
// bound to every other member of the file as associated data.
//
// Import reconciles with the deletion list: an item deleted, or a namespace erased, after the
// bundle was made is not brought back.
import { randomBytes, scryptSync } from 'node:crypto';
import { canonicalJson, fromBase64url, toBase64url } from '../lib/canonical.js';
import { isoAt, systemClock } from '../lib/clock.js';
import { fail } from '../lib/errors.js';
import { NAMESPACE } from '../contracts/module.js';
import { openBytes, sealBytes } from './crypto.js';
import { KERNEL_NAMESPACES } from './vault.js';

export const BUNDLE_FORMAT = 'starpi-companion.bundle/1';
export const MIN_PASSPHRASE = 12;
const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1 });
/** Namespaces that never leave in a bundle: the identity key and sealed event bodies. */
const NEVER_EXPORTED = new Set(KERNEL_NAMESPACES.filter((ns) => ns !== 'secrets'));

/** @param {string} passphrase @param {Buffer} salt @param {{ N: number, r: number, p: number }} kdf */
const derive = (passphrase, salt, kdf) => scryptSync(passphrase.normalize('NFC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 });

/** @param {unknown} passphrase */
function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase].length < MIN_PASSPHRASE) throw fail('passphrase_weak', `a passphrase has at least ${MIN_PASSPHRASE} characters`, { status: 400 });
}

/** @param {Record<string, unknown>} header */
const headerAad = (header) => `starpi-companion/bundle/1\n${canonicalJson(header)}`;

/**
 * @param {object} options
 * @param {import('./vault.js').Vault} options.vault
 * @param {string[]} options.namespaces
 * @param {string} options.passphrase
 * @param {import('../lib/clock.js').Clock} [options.clock]
 * @returns {{ file: string, items: number, blobs: number }}
 */
export function exportBundle({ vault, namespaces, passphrase, clock = systemClock }) {
  assertPassphrase(passphrase);
  const names = [...new Set(namespaces)].sort();
  if (names.length === 0) throw fail('bundle_empty', 'name at least one namespace', { status: 400 });
  for (const ns of names) {
    if (!NAMESPACE.test(ns)) throw fail('vault_namespace', `${ns} is not a namespace name`, { status: 400 });
    if (NEVER_EXPORTED.has(ns)) throw fail('vault_protected', `${ns} never leaves the companion`, { status: 400 });
  }
  const items = [];
  const blobs = [];
  for (const ns of names) {
    const space = vault.namespace(ns);
    for (const { id } of space.list()) items.push({ ns, id, data: toBase64url(/** @type {Buffer} */ (space.get(id))) });
    for (const { id } of space.listBlobs()) {
      const data = space.getBlob(id);
      if (data) blobs.push({ ns, id, data: toBase64url(data) });
    }
  }
  const salt = randomBytes(16);
  const header = { format: BUNDLE_FORMAT, created: isoAt(clock.now()), kdf: { ...KDF, salt: toBase64url(salt) }, cipher: 'aes-256-gcm', namespaces: names };
  const sealed = sealBytes(derive(passphrase, salt, KDF), Buffer.from(JSON.stringify({ items, blobs }), 'utf8'), headerAad(header));
  return { file: `${JSON.stringify({ ...header, sealed: toBase64url(sealed) })}\n`, items: items.length, blobs: blobs.length };
}

/**
 * @param {object} options
 * @param {import('./vault.js').Vault} options.vault
 * @param {import('./deletions.js').DeletionList} options.deletions
 * @param {string | Buffer} options.file
 * @param {string} options.passphrase
 * @returns {{ namespaces: string[], items: number, blobs: number, skipped: number }}
 */
export function importBundle({ vault, deletions, file, passphrase }) {
  assertPassphrase(passphrase);
  let parsed;
  try {
    parsed = JSON.parse(typeof file === 'string' ? file : file.toString('utf8'));
  } catch {
    throw fail('bundle_invalid', 'the bundle is not JSON', { status: 400 });
  }
  const { sealed, ...header } = parsed ?? {};
  const salt = fromBase64url(header?.kdf?.salt);
  const sealedBytes = fromBase64url(sealed);
  if (header.format !== BUNDLE_FORMAT || header.kdf?.name !== 'scrypt' || !salt || !sealedBytes || !Array.isArray(header.namespaces)) throw fail('bundle_invalid', 'not a companion bundle', { status: 400 });
  if (![16384, 32768, 65536, 131072].includes(header.kdf.N) || header.kdf.r !== 8 || header.kdf.p !== 1) throw fail('bundle_invalid', 'unsupported key derivation parameters', { status: 400 });
  let payload;
  try {
    payload = JSON.parse(openBytes(derive(passphrase, salt, header.kdf), sealedBytes, headerAad(header)).toString('utf8'));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'vault_unreadable') throw fail('bundle_passphrase', 'the passphrase does not open this bundle', { status: 400 });
    throw err;
  }
  const created = String(header.created);
  const { entries } = deletions.read();
  /** @param {string} ns @param {string} id */
  const deletedSince = (ns, id) => entries.some((e) => e.ns === ns && (e.id === null || e.id === id) && e.at >= created);
  let items = 0;
  let blobs = 0;
  let skipped = 0;
  for (const item of payload.items ?? []) {
    if (NEVER_EXPORTED.has(item.ns) || !header.namespaces.includes(item.ns) || deletedSince(item.ns, item.id)) {
      skipped += 1;
      continue;
    }
    const data = fromBase64url(item.data);
    if (!data) throw fail('bundle_invalid', 'an item of the bundle is not base64url', { status: 400 });
    vault.namespace(item.ns).put(item.id, data);
    items += 1;
  }
  for (const blob of payload.blobs ?? []) {
    if (NEVER_EXPORTED.has(blob.ns) || !header.namespaces.includes(blob.ns) || deletedSince(blob.ns, blob.id)) {
      skipped += 1;
      continue;
    }
    const data = fromBase64url(blob.data);
    if (!data) throw fail('bundle_invalid', 'a blob of the bundle is not base64url', { status: 400 });
    vault.namespace(blob.ns).putBlob(blob.id, data);
    blobs += 1;
  }
  return { namespaces: header.namespaces, items, blobs, skipped };
}
