// scripts/sign-release.mjs: the Ed25519 signature of a release's SHA256SUMS, in the format of the
// offline bundle's signature (raw signature over the file's bytes, the same key id).
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { keyId } from '../../packages/companion/deploy/verify-bundle.mjs';
import { KEY_ENV, main, publicKeyOf, signRelease, verifyRelease } from '../../scripts/sign-release.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'starpi-sign-release-'));
after(() => rmSync(work, { recursive: true, force: true }));

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PRIV = /** @type {string} */ (privateKey.export({ type: 'pkcs8', format: 'pem' }));
const PUB = /** @type {string} */ (publicKey.export({ type: 'spki', format: 'pem' }));
const SUMS = `${'a'.repeat(64)}  starpi-core-3.0.0.tgz\n${'b'.repeat(64)}  SHA256SUMS-is-not-listed\n`;

/** @param {string} name */
function release(name) {
  const dir = path.join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SHA256SUMS'), SUMS);
  return dir;
}

describe('sign-release', () => {
  it('signs SHA256SUMS so the public key verifies it, with the bundle key id', () => {
    const dir = release('ok');
    const signed = signRelease(dir, PRIV);
    assert.equal(signed.keyId, keyId(publicKey));
    assert.equal(readFileSync(signed.file).length, 64);
    assert.deepEqual(verifyRelease(dir, PUB), { ok: true, keyId: keyId(publicKey) });
  });

  it('refuses a changed SHA256SUMS, another key and a missing signature', () => {
    const dir = release('changed');
    signRelease(dir, PRIV);
    writeFileSync(path.join(dir, 'SHA256SUMS'), SUMS.replace('a', 'c'));
    assert.equal(verifyRelease(dir, PUB).ok, false);

    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    const dir2 = release('other-key');
    signRelease(dir2, PRIV);
    assert.match(String(verifyRelease(dir2, other).problem), /not a signature/);

    assert.match(String(verifyRelease(release('unsigned'), PUB).problem), /SHA256SUMS\.sig is missing/);
  });

  it('accepts only Ed25519 keys', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => signRelease(release('rsa'), rsa), /not an Ed25519 key/);
    assert.throws(() => publicKeyOf(rsa), /not an Ed25519 key/);
  });

  it('reads the private key from the environment only and never prints it', () => {
    const dir = release('cli');
    /** @type {string[]} */
    const lines = [];
    const io = { env: { [KEY_ENV]: PRIV }, out: (/** @type {string} */ l) => lines.push(l), err: (/** @type {string} */ l) => lines.push(l) };
    assert.equal(main(['sign', dir], io), 0);
    assert.equal(main(['sign', dir], { ...io, env: {} }), 1);
    const pubFile = path.join(work, 'release.pub');
    writeFileSync(pubFile, PUB);
    assert.equal(main(['verify', dir, '--key', pubFile], io), 0);
    assert.equal(main(['public-key'], io), 0);
    assert.ok(lines.includes(PUB.trimEnd()));
    assert.ok(!lines.join('\n').includes('PRIVATE KEY'), 'the private key never appears in the output');
    assert.equal(main(['verify', dir], io), 2);
    assert.equal(main([], io), 2);
  });

  it('writes a new key pair with a private file only its owner can read, and never overwrites one', () => {
    const dir = path.join(work, 'keys');
    /** @type {string[]} */
    const lines = [];
    const io = { env: {}, out: (/** @type {string} */ l) => lines.push(l), err: (/** @type {string} */ l) => lines.push(l) };
    assert.equal(main(['keygen', '--out', dir], io), 0);
    assert.equal(statSync(path.join(dir, 'starpi-release.key')).mode & 0o777, 0o600);
    assert.equal(main(['keygen', '--out', dir], io), 1);
    const signedDir = release('generated');
    signRelease(signedDir, readFileSync(path.join(dir, 'starpi-release.key')));
    assert.equal(verifyRelease(signedDir, readFileSync(path.join(dir, 'starpi-release.pub'))).ok, true);
  });
});
