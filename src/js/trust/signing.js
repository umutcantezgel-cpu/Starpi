// @ts-check
// Receipt signing on this device. The device has one signing key at a time: Ed25519, or ECDSA on
// P-256 ("ES256") in a browser without Ed25519 in WebCrypto. WebCrypto makes it non-extractable and
// IndexedDB keeps the CryptoKey handle (store `signingKeys`), so the private key never exists as
// bytes the page could read or send. The key id is the SHA-256 of the public key's SPKI
// (core/signature.js publicKeyId), the same id a signed receipt names.
//
// - "Sign exported receipts" (on by default, store `settings`) makes every receipt the dialog
//   builds name this key as its signer and carry its signature (core/receipt.js signReceipt); the
//   key is made with the first such receipt.
// - The public key is exported as a JWK or a PEM file. Whoever has it from the user can check who
//   signed a receipt: `starpi-verify-receipt receipt.json <files> --public-key key.pem --require-signature`.
// - Rotate makes a new key; the old one is kept only so its public key can still be exported, and
//   never signs again. Delete removes a key for good.
//
// Without a persistent database (private windows) the key lasts as long as the page; the state
// says so. Without WebCrypto (an insecure origin) signing is unavailable.
import { signReceipt } from '../core/receipt.js';
import { publicKeyId } from '../core/signature.js';
import { appDb } from '../store/schema.js';

/** @typedef {import('../core/signature.js').SignatureAlg} SignatureAlg */
/** @typedef {import('../core/receipt.js').Receipt} Receipt */
/** @typedef {import('../core/receipt.js').ReceiptSigner} ReceiptSigner */
/** @typedef {import('../store/schema.js').SigningKeyRecord} SigningKeyRecord */
/** @typedef {import('../store/idb.js').StoreDb} StoreDb */

/** The settings record of "Sign exported receipts". */
export const SIGN_SETTING = 'trust.signReceipts';

/**
 * A signing key as the UI shows it: no key handles.
 * @typedef {object} SigningKeyInfo
 * @property {string} id  key id: SHA-256 (hex) of the public key's SPKI
 * @property {SignatureAlg} alg
 * @property {number} createdAt
 * @property {number | null} retiredAt  null for the key that signs
 */

/**
 * @typedef {object} SigningState
 * @property {boolean} available   WebCrypto can make and use signing keys here
 * @property {boolean} persistent  keys and the setting survive a reload
 * @property {boolean} enabled     "Sign exported receipts"
 * @property {SigningKeyInfo | null} active
 * @property {SigningKeyInfo[]} retired  newest first
 */

/**
 * What exporting needs: the signer a receipt names, and a function that signs a receipt naming it.
 * @typedef {{ signer: ReceiptSigner, sign: (receipt: Receipt) => Promise<Receipt> }} ExportSigner
 */

/**
 * @typedef {object} ReceiptSignerOptions
 * @property {() => Promise<StoreDb>} [db]  defaults to the app database
 * @property {Crypto} [crypto]
 * @property {() => number} [now]
 */

/** The error codes callers show a text for. */
export class SigningError extends Error {
  /**
   * @param {'unavailable' | 'not_found' | 'storage'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SigningError';
    this.code = code;
  }
}

/**
 * @param {SigningKeyRecord} record
 * @returns {SigningKeyInfo}
 */
const infoOf = (record) => ({ id: record.id, alg: record.alg, createdAt: record.createdAt, retiredAt: record.retiredAt });

/**
 * @param {unknown} value
 * @returns {value is SigningKeyRecord}
 */
function isRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (value);
  return typeof r.id === 'string' && (r.alg === 'Ed25519' || r.alg === 'ES256') && typeof r.privateKey === 'object' && r.privateKey !== null && typeof r.publicKey === 'object' && r.publicKey !== null && Number.isFinite(r.createdAt);
}

/**
 * The public key as PEM (SubjectPublicKeyInfo, base64 in lines of 64).
 * @param {SubtleCrypto} subtle
 * @param {CryptoKey} publicKey
 */
async function pemOf(subtle, publicKey) {
  const der = new Uint8Array(await subtle.exportKey('spki', publicKey));
  let binary = '';
  for (const b of der) binary += String.fromCharCode(b);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Builds a receipt signer over a database.
 * @param {ReceiptSignerOptions} [options]
 */
export function createReceiptSigner(options = {}) {
  const getDb = options.db ?? appDb;
  const cryptoImpl = options.crypto ?? globalThis.crypto;
  const now = options.now ?? Date.now;
  const subtle = () => cryptoImpl?.subtle ?? null;

  /** @type {SigningKeyRecord[]} */
  let records = [];
  let enabled = true;
  let persistent = false;
  /** @type {StoreDb | null} */
  let db = null;
  /** @type {Promise<void> | null} */
  let loading = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {Set<(state: SigningState) => void>} */
  const listeners = new Set();

  /** @returns {SigningState} */
  const state = () => {
    const active = records.find((r) => r.retiredAt === null) ?? null;
    return {
      available: subtle() !== null,
      persistent,
      enabled,
      active: active ? infoOf(active) : null,
      retired: records
        .filter((r) => r.retiredAt !== null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(infoOf),
    };
  };

  const notify = () => {
    const snapshot = state();
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch {
        // one listener must not stop the others
      }
    }
  };

  /**
   * Runs key changes one at a time, so two exports at once cannot make two keys.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  /** Reads the keys and the setting. Runs once; later calls share it. */
  const load = () => {
    loading ??= (async () => {
      try {
        db = await getDb();
        persistent = db.persistent;
        const [found, setting] = await Promise.all([db.getAll('signingKeys'), db.get('settings', SIGN_SETTING)]);
        records = found.filter(isRecord);
        if (typeof setting?.value === 'boolean') enabled = setting.value;
      } catch {
        // Keys then live in memory for this page only.
        db = null;
        persistent = false;
      }
    })();
    return loading;
  };

  /** @param {SigningKeyRecord[]} changed */
  const save = async (changed) => {
    if (!db) return;
    try {
      await db.putMany('signingKeys', changed);
    } catch {
      throw new SigningError('storage', 'The signing key could not be stored');
    }
  };

  /** Makes a key pair: Ed25519, or ECDSA P-256 where WebCrypto has no Ed25519. */
  const generate = async () => {
    const api = subtle();
    if (!api) throw new SigningError('unavailable', 'WebCrypto is not available here');
    /** @type {CryptoKeyPair} */
    let pair;
    /** @type {SignatureAlg} */
    let alg = 'Ed25519';
    try {
      pair = /** @type {CryptoKeyPair} */ (await api.generateKey('Ed25519', false, ['sign', 'verify']));
    } catch {
      alg = 'ES256';
      try {
        pair = await api.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      } catch {
        throw new SigningError('unavailable', 'This browser cannot make Ed25519 or P-256 signing keys');
      }
    }
    const jwk = await api.exportKey('jwk', pair.publicKey);
    /** @type {JsonWebKey} */
    const publicJwk = alg === 'Ed25519' ? { kty: 'OKP', crv: 'Ed25519', x: jwk.x } : { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
    /** @type {SigningKeyRecord} */
    const record = { id: await publicKeyId(pair.publicKey), alg, privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk, createdAt: now(), retiredAt: null };
    return record;
  };

  /**
   * Retires the signing key, if any, and makes a new one.
   * @returns {Promise<SigningKeyInfo>}
   */
  const replaceActive = async () => {
    const fresh = await generate();
    const retired = records.filter((r) => r.retiredAt === null).map((r) => ({ ...r, retiredAt: fresh.createdAt }));
    await save([...retired, fresh]);
    records = [...records.filter((r) => r.retiredAt !== null), ...retired, fresh];
    notify();
    return infoOf(fresh);
  };

  /** @returns {Promise<SigningKeyRecord>} the key that signs, made first when there is none */
  const ensureActive = () =>
    serial(async () => {
      await load();
      const active = records.find((r) => r.retiredAt === null);
      if (active) return active;
      await replaceActive();
      return /** @type {SigningKeyRecord} */ (records.find((r) => r.retiredAt === null));
    });

  /** @param {string} id */
  const recordOf = (id) => {
    const record = records.find((r) => r.id === id);
    if (!record) throw new SigningError('not_found', 'No signing key with this id');
    return record;
  };

  return {
    /** Resolves when the keys and the setting have been read. */
    ready: () => load(),
    state,

    /**
     * Calls fn with the new state after every change. Returns an unsubscribe function.
     * @param {(state: SigningState) => void} fn
     */
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    /**
     * Turns "Sign exported receipts" on or off.
     * @param {boolean} on
     * @returns {Promise<boolean>} false when the choice holds for this page only
     */
    async setEnabled(on) {
      await load();
      enabled = on;
      notify();
      if (!db) return false;
      try {
        await db.put('settings', { key: SIGN_SETTING, value: on, updatedAt: now() });
        return persistent;
      } catch {
        return false;
      }
    },

    /** Makes the first key (or returns the one that signs). */
    createKey: () => ensureActive().then(infoOf),

    /** Makes a new key that signs from now on; the old one stays only for exporting its public key. */
    rotate: () =>
      serial(async () => {
        await load();
        return replaceActive();
      }),

    /**
     * Deletes a key for good. Receipts it signed still verify with its public key, where someone kept it.
     * @param {string} id
     */
    deleteKey: (id) =>
      serial(async () => {
        await load();
        recordOf(id);
        if (db) {
          try {
            await db.delete('signingKeys', id);
          } catch {
            throw new SigningError('storage', 'The signing key could not be deleted');
          }
        }
        records = records.filter((r) => r.id !== id);
        notify();
      }),

    /**
     * The public key of a key as a file: JWK (with its key id as `kid`) or PEM.
     * @param {string} id
     * @param {'jwk' | 'pem'} format
     * @returns {Promise<{ name: string, text: string, type: string }>}
     */
    async exportPublicKey(id, format) {
      await load();
      const record = recordOf(id);
      const name = `starpi-signing-key-${id.slice(0, 12)}`;
      if (format === 'jwk') {
        const jwk = { ...record.publicJwk, use: 'sig', kid: record.id };
        return { name: `${name}.jwk`, text: `${JSON.stringify(jwk, null, 2)}\n`, type: 'application/jwk+json' };
      }
      const api = subtle();
      if (!api) throw new SigningError('unavailable', 'WebCrypto is not available here');
      return { name: `${name}.pem`, text: await pemOf(api, record.publicKey), type: 'application/x-pem-file' };
    },

    /**
     * The signer for an export: null when signing is off or unavailable; otherwise the key that
     * signs (made on first use) as the receipt's `signer`, and a function that signs a receipt
     * built with it.
     * @returns {Promise<ExportSigner | null>}
     */
    async exportSigner() {
      await load();
      if (!enabled || !subtle()) return null;
      const record = await ensureActive();
      return {
        signer: { keyId: record.id, alg: record.alg },
        sign: (receipt) => signReceipt(receipt, record.privateKey, { publicKey: record.publicKey }),
      };
    },

    /**
     * Whether a key id belongs to a key of this device (the one that signs, or a retired one).
     * @param {string} id
     */
    async ownsKey(id) {
      await load();
      return records.some((r) => r.id === id);
    },
  };
}

/** @typedef {ReturnType<typeof createReceiptSigner>} ReceiptSignerApi */

/** The app's signer, over the app database. */
export const receiptSigner = createReceiptSigner();
