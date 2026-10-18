// @ts-check
// Authenticated encryption for everything the vault keeps: AES-256-GCM with a fresh 96-bit nonce per
// message and associated data that binds a ciphertext to where it belongs (its namespace, item id
// and key generation), so a sealed value moved to another row or namespace no longer opens.
//
// Binary layout of a sealed message: version (1 byte, 0x01) | nonce (12) | tag (16) | ciphertext.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from '../lib/errors.js';

export const KEY_BYTES = 32;
const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = 1 + NONCE_BYTES + TAG_BYTES;

/** @param {Uint8Array} key */
function assertKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new TypeError(`a vault key is ${KEY_BYTES} bytes`);
}

/**
 * Seals bytes.
 * @param {Uint8Array} key
 * @param {Uint8Array} plain
 * @param {string} aad
 * @returns {Buffer}
 */
export function sealBytes(key, plain, aad) {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), body]);
}

/**
 * Opens bytes sealed by sealBytes; throws `vault_unreadable` for a wrong key, wrong associated data
 * or a changed byte.
 * @param {Uint8Array} key
 * @param {Uint8Array} sealed
 * @param {string} aad
 * @returns {Buffer}
 */
export function openBytes(key, sealed, aad) {
  assertKey(key);
  if (!(sealed instanceof Uint8Array) || sealed.length < HEADER || sealed[0] !== VERSION) throw fail('vault_unreadable', 'not a sealed value of a known version');
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + NONCE_BYTES));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(bytes.subarray(1 + NONCE_BYTES, HEADER));
    return Buffer.concat([decipher.update(bytes.subarray(HEADER)), decipher.final()]);
  } catch (err) {
    throw fail('vault_unreadable', 'a sealed value did not open (wrong key, wrong place or changed bytes)', { cause: err });
  }
}

/** A fresh random key. */
export const newKey = () => randomBytes(KEY_BYTES);

/**
 * A short public id of a key-encryption key (never the key itself): the first 16 hex characters of
 * a domain-separated SHA-256. It tells a wrong key from the right one without revealing it.
 * @param {Uint8Array} kek
 */
export const kekId = (kek) => createHash('sha256').update('starpi-companion/kek-id/1\n').update(kek).digest('hex').slice(0, 16);

/** @param {Uint8Array} a @param {Uint8Array} b */
export const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);
