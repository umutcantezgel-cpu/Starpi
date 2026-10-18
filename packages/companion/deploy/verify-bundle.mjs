#!/usr/bin/env node
// @ts-check
// Checks an unpacked offline bundle of Starpi Core against its SHA256SUMS: every listed file is
// there with the listed hash, nothing unlisted lies next to them, no listed path leaves the bundle,
// no symbolic link is part of it, and, when a public key is given, SHA256SUMS.sig is a valid
// Ed25519 signature of SHA256SUMS by that key. The install scripts run it before they copy
// anything; scripts/companion-offline-pack.mjs uses the same functions to write and check bundles.
//
// What it protects against: a damaged, truncated or mixed-up copy. Against a copy that someone
// changed on purpose, check the signature with a tool you already trust BEFORE you run anything
// from the bundle (deploy/linux/README.md shows the openssl command); a changed bundle can carry a
// changed copy of this file too.
//
// Usage: node verify-bundle.mjs <bundle folder> [--key <Ed25519 public key, PEM>] [--json]
// Exit: 0 the bundle checks out, 1 it does not, 2 usage.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUMS = 'SHA256SUMS';
export const SIGNATURE = 'SHA256SUMS.sig';
/** sha256sum's line: the hash, a space, a space (text) or star (binary), the path. */
const SUM_LINE = /^([0-9a-f]{64}) [ *](.+)$/;

/**
 * Whether a bundle path is safe to list: relative, forward slashes, no empty, "." or ".."
 * segment, no characters sha256sum would escape.
 * @param {string} path
 */
export function isBundlePath(path) {
  if (path === '' || path.startsWith('/') || /[\\\n\r\0]/.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** @param {string} file @returns {string} hex SHA-256 of the file's bytes */
export function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Every entry below a folder, as sorted slash-separated relative paths.
 * @param {string} dir
 * @returns {{ files: string[], links: string[], others: string[] }}
 */
export function listTree(dir) {
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const links = [];
  /** @type {string[]} */ const others = [];
  /** @param {string} rel */
  const visit = (rel) => {
    for (const entry of readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) links.push(path);
      else if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else others.push(path);
    }
  };
  visit('');
  return { files: files.sort(), links: links.sort(), others: others.sort() };
}

/**
 * The SHA256SUMS text of a folder (every regular file but SHA256SUMS and its signature).
 * @param {string} dir
 * @returns {string}
 */
export function sumsOf(dir) {
  const { files, links, others } = listTree(dir);
  if (links.length > 0 || others.length > 0) throw new Error(`the bundle holds links or special files: ${[...links, ...others].join(', ')}`);
  const lines = [];
  for (const path of files) {
    if (path === SUMS || path === SIGNATURE) continue;
    if (!isBundlePath(path)) throw new Error(`${JSON.stringify(path)} cannot be listed in ${SUMS}`);
    lines.push(`${sha256Of(join(dir, path))}  ${path}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parses SHA256SUMS text.
 * @param {string} text
 * @returns {{ entries: Map<string, string>, problems: string[] }}
 */
export function parseSums(text) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  /** @type {string[]} */
  const problems = [];
  text.split('\n').forEach((line, index) => {
    if (line === '') return;
    const match = SUM_LINE.exec(line);
    if (!match) return void problems.push(`${SUMS} line ${index + 1} is malformed`);
    const [, hash, path] = match;
    if (!isBundlePath(path)) return void problems.push(`${SUMS} line ${index + 1}: ${JSON.stringify(path)} leaves the bundle`);
    if (entries.has(path)) return void problems.push(`${SUMS} lists ${path} twice`);
    entries.set(path, hash);
  });
  return { entries, problems };
}

/**
 * The id people compare with the release notes: the first 16 hex digits of the SHA-256 of the raw
 * 32-byte public key.
 * @param {import('node:crypto').KeyObject} key
 */
export function keyId(key) {
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der.subarray(der.length - 32)).digest('hex').slice(0, 16);
}

/**
 * Signs SHA256SUMS text with an Ed25519 private key (PEM, PKCS#8).
 * @param {string | Buffer} sums
 * @param {string | Buffer} privateKeyPem
 * @returns {{ signature: Buffer, keyId: string }}
 */
export function signSums(sums, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key is not an Ed25519 key');
  return { signature: sign(null, Buffer.from(sums), key), keyId: keyId(createPublicKey(key)) };
}

/**
 * Checks an unpacked bundle.
 * @param {string} dir
 * @param {{ publicKey?: string | Buffer }} [options]  PEM of the Ed25519 public key; without it the signature is not checked
 * @returns {{ ok: boolean, problems: string[], files: number, signed: boolean, keyId: string | null }}
 */
export function verifyBundle(dir, { publicKey } = {}) {
  /** @type {string[]} */
  const problems = [];
  const root = realpathSync(resolve(dir));
  let sumsText;
  try {
    if (lstatSync(join(root, SUMS)).isSymbolicLink()) throw new Error('link');
    sumsText = readFileSync(join(root, SUMS));
  } catch {
    return { ok: false, problems: [`${SUMS} is missing`], files: 0, signed: false, keyId: null };
  }
  const { entries, problems: parsed } = parseSums(sumsText.toString('utf8'));
  problems.push(...parsed);
  const tree = listTree(root);
  for (const link of tree.links) problems.push(`${link} is a symbolic link`);
  for (const other of tree.others) problems.push(`${other} is not a regular file`);
  const present = new Set(tree.files);
  for (const [path, hash] of entries) {
    if (!present.has(path)) problems.push(`${path} is missing`);
    else if (sha256Of(join(root, path)) !== hash) problems.push(`${path} does not match its checksum`);
  }
  for (const path of tree.files) {
    if (path !== SUMS && path !== SIGNATURE && !entries.has(path)) problems.push(`${path} is not listed in ${SUMS}`);
  }
  const signed = present.has(SIGNATURE);
  /** @type {string | null} */
  let id = null;
  if (publicKey !== undefined) {
    try {
      const key = createPublicKey(publicKey);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
      id = keyId(key);
      if (!signed) problems.push(`${SIGNATURE} is missing, so the bundle cannot be checked against the key`);
      else if (!verify(null, sumsText, key, readFileSync(join(root, SIGNATURE)))) problems.push(`${SIGNATURE} is not a valid signature of ${SUMS} by key ${id}`);
    } catch (err) {
      problems.push(`the public key cannot be used: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: problems.length === 0, problems, files: entries.size, signed, keyId: id };
}

/**
 * Command line.
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {number}
 */
export function main(argv, { out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`) } = {}) {
  const args = [...argv];
  const json = args.includes('--json');
  const keyAt = args.indexOf('--key');
  const keyFile = keyAt >= 0 ? args[keyAt + 1] : undefined;
  const rest = args.filter((a, i) => a !== '--json' && i !== keyAt && i !== keyAt + 1);
  if (rest.length !== 1 || (keyAt >= 0 && !keyFile)) {
    err('usage: node verify-bundle.mjs <bundle folder> [--key <public key PEM>] [--json]');
    return 2;
  }
  let publicKey;
  if (keyFile) {
    try {
      publicKey = readFileSync(keyFile);
    } catch {
      err(`the key file ${keyFile} cannot be read`);
      return 1;
    }
  }
  const report = verifyBundle(rest[0], { publicKey });
  if (json) out(JSON.stringify(report, null, 2));
  else if (report.ok) {
    out(`bundle ok: ${report.files} files match ${SUMS}${report.keyId ? `, signature valid (key ${report.keyId})` : report.signed ? `; ${SIGNATURE} present but not checked (no --key)` : ', not signed'}`);
  } else {
    err(`bundle NOT ok:\n - ${report.problems.join('\n - ')}`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
