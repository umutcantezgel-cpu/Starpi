// @ts-check
// Hashing and encoding helpers shared by the audit chain, the anchors, the vault and the backups.
// canonicalJson produces the same text as the canonical JSON of @starpi/core (sorted keys, no
// whitespace, undefined members dropped; RFC 8785 for strings, integers, booleans and null), so the
// browser app can recompute what the companion signs with the library it already has.
import { createHash, createHmac } from 'node:crypto';

/**
 * The canonical text of a JSON value.
 * @param {unknown} value  a JSON value; undefined members of objects are left out
 * @returns {string} the same text for equal data, whatever the order of keys
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: a number must be finite');
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new TypeError(`canonicalJson: ${typeof value} has no JSON form`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const record = /** @type {Record<string, unknown>} */ (value);
  const names = Object.keys(record).filter((name) => record[name] !== undefined).sort();
  return `{${names.map((name) => `${JSON.stringify(name)}:${canonicalJson(record[name])}`).join(',')}}`;
}

/**
 * SHA-256 as 64 lower-case hex characters. Strings are hashed as UTF-8.
 * @param {string | Uint8Array} data
 */
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/**
 * HMAC-SHA256 as 64 lower-case hex characters.
 * @param {Uint8Array} key
 * @param {string | Uint8Array} data
 */
export const hmacHex = (key, data) => createHmac('sha256', key).update(data).digest('hex');

/** @param {Uint8Array} bytes */
export const toBase64url = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');

/**
 * Strict base64url (no padding, canonical form); null for anything else.
 * @param {unknown} text
 * @returns {Buffer | null}
 */
export function fromBase64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/** 64 lower-case hex characters. */
export const HEX64 = /^[0-9a-f]{64}$/;

/** The hash that stands before the first record of a chain. */
export const ZERO_HASH = '0'.repeat(64);
