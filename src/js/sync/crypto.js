// @ts-check
// End-to-end encryption of the chat sync, with WebCrypto only.
//
// Keys
// - The sync secret is 32 random bytes made in the browser that turns sync on. Two non-extractable
//   keys are derived from it with HKDF-SHA-256: an AES-GCM-256 key that encrypts the records, and an
//   HMAC-SHA-256 key that turns a conversation id into the opaque row id the server sees.
// - The secret is wrapped (AES-GCM) with a key derived from the user's passphrase: PBKDF2-SHA-256,
//   600 000 iterations, a random 16-byte salt. The wrapped secret, salt, IV and iteration count are
//   the key envelope the server keeps, so another browser of the same account can open it with the
//   passphrase. The passphrase and the secret never leave the browser; the opened keys cannot be
//   exported and are kept in the app database as CryptoKey objects.
//
// Records
// - A record is JSON, padded with spaces to a multiple of 512 bytes (the server learns sizes only
//   roughly), encrypted with AES-GCM under a fresh 12-byte IV. The additional data binds the
//   ciphertext to the key id, row id and revision, so the server cannot move a record to another
//   row or present it under another revision.
// - Everything that crosses the network is base64 text: row ids, IVs, ciphertext, the envelope.

export const SYNC_KDF = 'PBKDF2-SHA256';
export const SYNC_KDF_ITERATIONS = 600_000;
/** Highest iteration count accepted from an envelope (a hostile server cannot stall the browser). */
export const MAX_KDF_ITERATIONS = 10_000_000;
export const SYNC_SALT_BYTES = 16;
export const SYNC_IV_BYTES = 12;
export const SYNC_SECRET_BYTES = 32;
export const SYNC_KEY_ID_BYTES = 16;
/** Longer than the vault minimum: the wrapped key is stored on a server, open to offline guessing. */
export const MIN_SYNC_PASSPHRASE_CHARS = 12;
/** Largest record (plaintext bytes before padding); the database allows a little more ciphertext. */
export const MAX_RECORD_BYTES = 2_000_000;
const PAD_BYTES = 512;
const ROW_ID_BYTES = 24;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * unavailable: no WebCrypto here; too_short: the passphrase is shorter than the minimum;
 * wrong_passphrase: it does not open the envelope; bad_envelope: the envelope is not one this
 * version made; decrypt: a record does not open with these keys (another key, or changed data);
 * too_large: a record is above MAX_RECORD_BYTES.
 * @typedef {'unavailable' | 'too_short' | 'wrong_passphrase' | 'bad_envelope' | 'decrypt' | 'too_large'} SyncCryptoErrorCode
 */

export class SyncCryptoError extends Error {
  /** @param {SyncCryptoErrorCode} code */
  constructor(code) {
    super(code);
    this.name = 'SyncCryptoError';
    /** @type {SyncCryptoErrorCode} */
    this.code = code;
  }
}

/**
 * The wrapped sync key as the server keeps it. Nothing in it opens without the passphrase.
 * @typedef {object} KeyEnvelope
 * @property {string} keyId       22 characters of base64url, random
 * @property {'PBKDF2-SHA256'} kdf
 * @property {number} iterations
 * @property {string} salt        base64, 16 bytes
 * @property {string} iv          base64, 12 bytes
 * @property {string} wrappedKey  base64, the 32-byte secret plus the 16-byte tag
 */

/**
 * The opened sync key. Both keys are non-extractable.
 * @typedef {object} SyncKeys
 * @property {string} keyId
 * @property {CryptoKey} enc  AES-GCM-256, encrypts and decrypts records
 * @property {CryptoKey} ids  HMAC-SHA-256, makes row ids
 */

/** @typedef {{ iv: string, ciphertext: string }} SealedRecord */

/**
 * @param {Crypto | undefined} cryptoImpl
 * @returns {Crypto}
 */
function webCrypto(cryptoImpl) {
  const c = cryptoImpl ?? globalThis.crypto;
  if (!c?.subtle || typeof c.getRandomValues !== 'function') throw new SyncCryptoError('unavailable');
  return c;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64 of exactly `size` bytes, or null.
 * @param {unknown} text
 * @param {number} size
 */
function bytesOf(text, size) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const bytes = fromBase64(text);
    return bytes.length === size ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Whether a passphrase is long enough (counted in characters, not UTF-16 units).
 * @param {unknown} passphrase
 * @returns {passphrase is string}
 */
export function passphraseLongEnough(passphrase) {
  return typeof passphrase === 'string' && Array.from(passphrase).length >= MIN_SYNC_PASSPHRASE_CHARS;
}

/**
 * Checks the shape of an envelope from the server.
 * @param {unknown} value
 * @returns {value is KeyEnvelope}
 */
export function isKeyEnvelope(value) {
  if (!value || typeof value !== 'object') return false;
  const e = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof e.keyId === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(e.keyId) &&
    e.kdf === SYNC_KDF &&
    Number.isInteger(e.iterations) &&
    Number(e.iterations) >= SYNC_KDF_ITERATIONS &&
    Number(e.iterations) <= MAX_KDF_ITERATIONS &&
    bytesOf(e.salt, SYNC_SALT_BYTES) !== null &&
    bytesOf(e.iv, SYNC_IV_BYTES) !== null &&
    bytesOf(e.wrappedKey, SYNC_SECRET_BYTES + 16) !== null
  );
}

/** @param {string} keyId */
const wrapAad = (keyId) => ENCODER.encode(`starpi-sync/key/v1|${keyId}`);

/**
 * @param {string} keyId
 * @param {string} rowId
 * @param {number} rev
 */
const recordAad = (keyId, rowId, rev) => ENCODER.encode(`starpi-sync/record/v1|${keyId}|${rowId}|${rev}`);

/**
 * The key that wraps the sync secret.
 * @param {Crypto} c
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {number} iterations
 */
async function wrappingKey(c, passphrase, salt, iterations) {
  const base = await c.subtle.importKey('raw', ENCODER.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return c.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: /** @type {BufferSource} */ (salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * Derives the record and row-id keys from the secret, then overwrites the secret.
 * @param {Crypto} c
 * @param {Uint8Array} secret
 * @param {string} keyId
 * @returns {Promise<SyncKeys>}
 */
async function openSecret(c, secret, keyId) {
  try {
    const root = await c.subtle.importKey('raw', /** @type {BufferSource} */ (secret), 'HKDF', false, ['deriveKey']);
    const hkdf = (/** @type {string} */ info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: ENCODER.encode(info) });
    const [enc, ids] = await Promise.all([
      c.subtle.deriveKey(hkdf('starpi-sync/enc/v1'), root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
      c.subtle.deriveKey(hkdf('starpi-sync/ids/v1'), root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
    ]);
    return { keyId, enc, ids };
  } finally {
    secret.fill(0);
  }
}

/**
 * Makes a new sync key and its envelope for a passphrase.
 * @param {string} passphrase
 * @param {{ crypto?: Crypto, iterations?: number }} [opts]
 * @returns {Promise<{ envelope: KeyEnvelope, keys: SyncKeys }>}
 */
export async function createSyncKey(passphrase, opts = {}) {
  if (!passphraseLongEnough(passphrase)) throw new SyncCryptoError('too_short');
  const c = webCrypto(opts.crypto);
  const iterations = opts.iterations ?? SYNC_KDF_ITERATIONS;
  const salt = c.getRandomValues(new Uint8Array(SYNC_SALT_BYTES));
  const iv = c.getRandomValues(new Uint8Array(SYNC_IV_BYTES));
  const secret = c.getRandomValues(new Uint8Array(SYNC_SECRET_BYTES));
  const keyId = toBase64Url(c.getRandomValues(new Uint8Array(SYNC_KEY_ID_BYTES)));
  const wrapper = await wrappingKey(c, passphrase, salt, iterations);
  const wrapped = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: wrapAad(keyId) }, wrapper, /** @type {BufferSource} */ (secret)));
  /** @type {KeyEnvelope} */
  const envelope = { keyId, kdf: SYNC_KDF, iterations, salt: toBase64(salt), iv: toBase64(iv), wrappedKey: toBase64(wrapped) };
  return { envelope, keys: await openSecret(c, secret, keyId) };
}

/**
 * Opens an envelope with a passphrase.
 * @param {string} passphrase
 * @param {KeyEnvelope} envelope
 * @param {{ crypto?: Crypto }} [opts]
 * @returns {Promise<SyncKeys>}
 */
export async function openSyncKey(passphrase, envelope, opts = {}) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new SyncCryptoError('wrong_passphrase');
  if (!isKeyEnvelope(envelope)) throw new SyncCryptoError('bad_envelope');
  const c = webCrypto(opts.crypto);
  const wrapper = await wrappingKey(c, passphrase, /** @type {Uint8Array} */ (bytesOf(envelope.salt, SYNC_SALT_BYTES)), envelope.iterations);
  let secret;
  try {
    secret = new Uint8Array(
      await c.subtle.decrypt(
        { name: 'AES-GCM', iv: /** @type {BufferSource} */ (bytesOf(envelope.iv, SYNC_IV_BYTES)), additionalData: wrapAad(envelope.keyId) },
        wrapper,
        /** @type {BufferSource} */ (bytesOf(envelope.wrappedKey, SYNC_SECRET_BYTES + 16)),
      ),
    );
  } catch {
    throw new SyncCryptoError('wrong_passphrase');
  }
  return openSecret(c, secret, envelope.keyId);
}

/**
 * The opaque row id of a conversation: the same on every browser with the same sync key, and
 * meaningless without it.
 * @param {SyncKeys} keys
 * @param {string} conversationId
 * @param {{ crypto?: Crypto }} [opts]
 */
export async function rowIdFor(keys, conversationId, opts = {}) {
  const c = webCrypto(opts.crypto);
  const mac = new Uint8Array(await c.subtle.sign('HMAC', keys.ids, ENCODER.encode(`conversation|${conversationId}`)));
  return toBase64Url(mac.subarray(0, ROW_ID_BYTES));
}

/**
 * Encrypts a record for a row and revision.
 * @param {SyncKeys} keys
 * @param {{ rowId: string, rev: number }} where
 * @param {unknown} value  JSON-serialisable
 * @param {{ crypto?: Crypto }} [opts]
 * @returns {Promise<SealedRecord>}
 */
export async function sealRecord(keys, where, value, opts = {}) {
  const c = webCrypto(opts.crypto);
  const json = ENCODER.encode(JSON.stringify(value));
  if (json.length > MAX_RECORD_BYTES) throw new SyncCryptoError('too_large');
  // Trailing spaces are valid JSON whitespace, so the padding needs no length field.
  const padded = new Uint8Array(Math.ceil((json.length + 1) / PAD_BYTES) * PAD_BYTES).fill(0x20);
  padded.set(json);
  const iv = c.getRandomValues(new Uint8Array(SYNC_IV_BYTES));
  const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: recordAad(keys.keyId, where.rowId, where.rev) }, keys.enc, padded));
  return { iv: toBase64(iv), ciphertext: toBase64(ct) };
}

/**
 * Decrypts a record of a row and revision.
 * @param {SyncKeys} keys
 * @param {{ rowId: string, rev: number, iv: string, ciphertext: string }} row
 * @param {{ crypto?: Crypto }} [opts]
 * @returns {Promise<unknown>}
 */
export async function openRecord(keys, row, opts = {}) {
  const c = webCrypto(opts.crypto);
  const iv = bytesOf(row.iv, SYNC_IV_BYTES);
  if (!iv || typeof row.ciphertext !== 'string') throw new SyncCryptoError('decrypt');
  try {
    const plain = await c.subtle.decrypt({ name: 'AES-GCM', iv: /** @type {BufferSource} */ (iv), additionalData: recordAad(keys.keyId, row.rowId, row.rev) }, keys.enc, /** @type {BufferSource} */ (fromBase64(row.ciphertext)));
    return JSON.parse(DECODER.decode(plain));
  } catch {
    throw new SyncCryptoError('decrypt');
  }
}

/**
 * SHA-256 of a text as hex (change detection; not a secret).
 * @param {string} text
 * @param {{ crypto?: Crypto }} [opts]
 */
export async function digestText(text, opts = {}) {
  const c = webCrypto(opts.crypto);
  const hash = new Uint8Array(await c.subtle.digest('SHA-256', ENCODER.encode(text)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}
