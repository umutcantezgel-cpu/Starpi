// @ts-check
// The companion's identity: one Ed25519 key pair made at the first start. The private key is kept
// sealed in the vault (namespace `identity`); the public key is handed to the browser at pairing,
// pinned next to the audit anchors and printed by `status`. It signs the audit head carried by every
// answer, every anchor and every backup manifest.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { sha256Hex, toBase64url, fromBase64url } from '../lib/canonical.js';
import { fail } from '../lib/errors.js';

const ITEM = 'signing-key';

/**
 * @typedef {object} Identity
 * @property {string} publicKey   raw 32-byte Ed25519 public key, base64url
 * @property {string} keyId       SHA-256 of the raw public key, hex
 * @property {(message: string | Uint8Array) => string} sign  signature, base64url
 * @property {import('node:crypto').KeyObject} publicKeyObject
 */

/** @param {import('node:crypto').KeyObject} publicKey */
function rawPublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = fromBase64url(jwk.x);
  if (!raw || raw.length !== 32) throw fail('identity_invalid', 'the public key is not a 32-byte Ed25519 key');
  return raw;
}

/**
 * A public key object from its raw base64url form.
 * @param {string} raw
 */
export function publicKeyFromRaw(raw) {
  const bytes = fromBase64url(raw);
  if (!bytes || bytes.length !== 32) throw fail('identity_invalid', 'a public key is 32 bytes, base64url');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

/** The key id of a raw base64url public key. @param {string} raw */
export const keyIdOf = (raw) => {
  const bytes = fromBase64url(raw);
  if (!bytes) throw fail('identity_invalid', 'a public key is base64url');
  return sha256Hex(bytes);
};

/**
 * Checks an Ed25519 signature (base64url) over a message.
 * @param {import('node:crypto').KeyObject} publicKey
 * @param {string | Uint8Array} message
 * @param {unknown} signature
 */
export function verifySignature(publicKey, message, signature) {
  const sig = fromBase64url(signature);
  if (!sig || sig.length !== 64) return false;
  try {
    return verify(null, typeof message === 'string' ? Buffer.from(message, 'utf8') : message, publicKey, sig);
  } catch {
    return false;
  }
}

/**
 * Builds an identity from a private key object.
 * @param {import('node:crypto').KeyObject} privateKey
 * @returns {Identity}
 */
export function identityFromKey(privateKey) {
  const publicKeyObject = createPublicKey(privateKey);
  const raw = rawPublicKey(publicKeyObject);
  return {
    publicKey: toBase64url(raw),
    keyId: sha256Hex(raw),
    publicKeyObject,
    sign: (message) => toBase64url(sign(null, typeof message === 'string' ? Buffer.from(message, 'utf8') : message, privateKey)),
  };
}

/**
 * Loads the identity from the vault, or makes it when the vault has none.
 * @param {import('../vault/vault.js').Vault} vault
 * @param {{ create?: boolean }} [options]
 * @returns {Identity}
 */
export function loadIdentity(vault, { create = true } = {}) {
  const ns = vault.namespace('identity');
  const stored = ns.get(ITEM);
  if (stored) return identityFromKey(createPrivateKey({ key: stored, format: 'der', type: 'pkcs8' }));
  if (!create) throw fail('identity_missing', 'the vault holds no identity key');
  const { privateKey } = generateKeyPairSync('ed25519');
  ns.put(ITEM, privateKey.export({ format: 'der', type: 'pkcs8' }));
  return identityFromKey(privateKey);
}
