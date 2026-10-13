// @ts-check
// Hashing and encodings shared by receipts, their Merkle tree and their signatures. Pure: WebCrypto
// (crypto.subtle) only, so it runs in the browser, in workers and in Node 20+.

/**
 * SHA-256 of bytes or of a string (hashed as UTF-8).
 * @param {string | ArrayBuffer | Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function sha256Bytes(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', /** @type {Uint8Array<ArrayBuffer>} */ (bytes)));
}

/**
 * SHA-256 as lowercase hex. Strings are hashed as UTF-8.
 * @param {string | ArrayBuffer | Uint8Array} data
 */
export async function sha256Hex(data) {
  return toHex(await sha256Bytes(data));
}

/** @param {Uint8Array} bytes */
export function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Lowercase hex to bytes; null for anything else (odd length, other characters).
 * @param {string} hex
 * @returns {Uint8Array<ArrayBuffer> | null}
 */
export function fromHex(hex) {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * Base64url without padding (RFC 4648 §5).
 * @param {Uint8Array} bytes
 */
export function toBase64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64url without padding to bytes. Only the canonical encoding is accepted (the one
 * toBase64url writes), so one byte string has exactly one accepted spelling; null otherwise.
 * @param {string} text
 * @returns {Uint8Array<ArrayBuffer> | null}
 */
export function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  let binary;
  try {
    binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return toBase64url(bytes) === text ? bytes : null;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace, `undefined` members
 * dropped. For values made of strings, integers, booleans, null, arrays and objects this equals
 * RFC 8785 (JCS).
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const obj = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
