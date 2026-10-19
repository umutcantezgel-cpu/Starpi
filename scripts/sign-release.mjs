#!/usr/bin/env node
// @ts-check
// The Ed25519 signature of a release's SHA256SUMS. The release workflow writes SHA256SUMS over the
// assets of a release (the @starpi/core and @starpi/companion tarballs, the SBOMs, the companion's
// offline bundle); this script signs that file with the project's release key and writes
// SHA256SUMS.sig next to it: the raw 64-byte signature over the file's bytes, the same format and key
// id as the offline bundle's own signature (packages/companion/deploy/verify-bundle.mjs), so one
// public key checks both. Anyone can check it without Node:
//
//   openssl pkeyutl -verify -pubin -inkey starpi-release.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
//
// The private key (PEM, PKCS#8) comes from the environment variable STARPI_RELEASE_SIGNING_KEY,
// never from an argument or a file in the checkout, and is never printed. Only Node's built-in
// modules are used, so the signing job installs nothing.
//
// Usage:
//   node scripts/sign-release.mjs sign <dir>                      writes <dir>/SHA256SUMS.sig
//   node scripts/sign-release.mjs verify <dir> --key <public PEM>  checks it
//   node scripts/sign-release.mjs public-key                       the public key of the environment's key, as PEM
//   node scripts/sign-release.mjs keygen --out <dir>               a new key pair (private key 0600)
// Exit: 0 done, 1 the signature or the key is not right, 2 usage.
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyId, signSums, SIGNATURE, SUMS } from '../packages/companion/deploy/verify-bundle.mjs';

export const KEY_ENV = 'STARPI_RELEASE_SIGNING_KEY';

/**
 * Signs <dir>/SHA256SUMS and writes <dir>/SHA256SUMS.sig.
 * @param {string} dir
 * @param {string | Buffer} privateKeyPem
 * @returns {{ keyId: string, file: string }}
 */
export function signRelease(dir, privateKeyPem) {
  const sumsFile = path.join(dir, SUMS);
  if (!existsSync(sumsFile)) throw new Error(`${sumsFile} does not exist`);
  const sums = readFileSync(sumsFile);
  if (sums.length === 0) throw new Error(`${sumsFile} is empty`);
  const { signature, keyId: id } = signSums(sums, privateKeyPem);
  const file = path.join(dir, SIGNATURE);
  writeFileSync(file, signature);
  return { keyId: id, file };
}

/**
 * Checks <dir>/SHA256SUMS.sig against <dir>/SHA256SUMS with an Ed25519 public key.
 * @param {string} dir
 * @param {string | Buffer} publicKeyPem
 * @returns {{ ok: boolean, keyId: string, problem?: string }}
 */
export function verifyRelease(dir, publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, keyId: '', problem: 'the public key is not an Ed25519 key' };
  const id = keyId(key);
  const sumsFile = path.join(dir, SUMS);
  const sigFile = path.join(dir, SIGNATURE);
  if (!existsSync(sumsFile)) return { ok: false, keyId: id, problem: `${SUMS} is missing` };
  if (!existsSync(sigFile)) return { ok: false, keyId: id, problem: `${SIGNATURE} is missing` };
  const ok = verify(null, readFileSync(sumsFile), key, readFileSync(sigFile));
  return ok ? { ok, keyId: id } : { ok, keyId: id, problem: `${SIGNATURE} is not a signature of ${SUMS} by key ${id}` };
}

/**
 * The public key of a private key, as SPKI PEM.
 * @param {string | Buffer} privateKeyPem
 */
export function publicKeyOf(privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key is not an Ed25519 key');
  const pub = createPublicKey(key);
  return { pem: /** @type {string} */ (pub.export({ type: 'spki', format: 'pem' })), keyId: keyId(pub) };
}

/**
 * @param {string[]} argv
 * @param {string} name
 */
function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv, { env = process.env, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`) } = {}) {
  const [command, ...rest] = argv;
  const usage = () => {
    err('usage: node scripts/sign-release.mjs sign <dir> | verify <dir> --key <public PEM> | public-key | keygen --out <dir>');
    return 2;
  };
  try {
    if (command === 'sign' && rest[0]) {
      const pem = env[KEY_ENV];
      if (!pem) {
        err(`${KEY_ENV} is not set`);
        return 1;
      }
      const result = signRelease(rest[0], pem);
      out(`signed ${SUMS}: ${result.file} (key ${result.keyId})`);
      return 0;
    }
    if (command === 'verify' && rest[0] && !rest[0].startsWith('--')) {
      const keyFile = option(rest, '--key');
      if (!keyFile) return usage();
      const result = verifyRelease(rest[0], readFileSync(keyFile));
      if (!result.ok) {
        err(`not verified: ${result.problem}`);
        return 1;
      }
      out(`${SIGNATURE} is valid (key ${result.keyId})`);
      return 0;
    }
    if (command === 'public-key') {
      const pem = env[KEY_ENV];
      if (!pem) {
        err(`${KEY_ENV} is not set`);
        return 1;
      }
      const { pem: pub, keyId: id } = publicKeyOf(pem);
      out(pub.trimEnd());
      err(`key id ${id}`);
      return 0;
    }
    if (command === 'keygen') {
      const dir = option(rest, '--out');
      if (!dir) return usage();
      mkdirSync(dir, { recursive: true });
      const priv = path.join(dir, 'starpi-release.key');
      const pubFile = path.join(dir, 'starpi-release.pub');
      if (existsSync(priv)) {
        err(`${priv} exists; refusing to overwrite a key`);
        return 1;
      }
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));
      out(`private key ${priv} (store it as the secret ${KEY_ENV}, then delete this file)`);
      out(`public key  ${pubFile} (key ${keyId(publicKey)}; publish it with the release notes)`);
      return 0;
    }
  } catch (e) {
    err(`sign-release: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return usage();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
