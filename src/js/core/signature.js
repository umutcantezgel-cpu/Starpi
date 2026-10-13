// @ts-check
// Signatures for receipts v2, with WebCrypto only: Ed25519 (RFC 8032) or ECDSA on P-256 with
// SHA-256 ("ES256", signature as r ‖ s, IEEE P1363). The signature covers the receipt's head: its id
// (the hash of everything else in the receipt) and its Merkle root over the citations, together
// with the algorithm and the key id, so neither can be swapped without breaking the signature:
//
//   UTF-8("starpi.receipt/v2 signature\n" + canonicalJson({ alg, id, keyId, merkle }))
//
// The key id is the SHA-256 of the public key's SubjectPublicKeyInfo (DER). A signed receipt
// carries the public key as a JWK, so anyone can check that it was not changed after signing; only a
// public key obtained from the signer (not the one in the receipt) shows who signed it.
import { canonicalJson, fromBase64url, sha256Hex, toBase64url } from './hash.js';

/** @typedef {'Ed25519' | 'ES256'} SignatureAlg */

/** @type {readonly SignatureAlg[]} */
export const SIGNATURE_ALGS = Object.freeze(['Ed25519', 'ES256']);

/**
 * @typedef {object} ReceiptSignature
 * @property {SignatureAlg} alg
 * @property {string} keyId  SHA-256 (hex) of the public key's SPKI
 * @property {{ kty: 'OKP', crv: 'Ed25519', x: string } | { kty: 'EC', crv: 'P-256', x: string, y: string }} publicKey
 * @property {string} value  the signature, base64url without padding (64 bytes)
 */

/**
 * @typedef {object} SignatureCheck
 * @property {'valid' | 'invalid' | 'unsigned' | 'key_mismatch' | 'unsupported_algorithm'} status
 * @property {SignatureAlg | null} alg
 * @property {string | null} keyId
 * @property {boolean} trusted  valid for a public key the caller supplied (not only the embedded one)
 */

const PARAMS = {
  Ed25519: { key: { name: 'Ed25519' }, sign: { name: 'Ed25519' }, kty: 'OKP', crv: 'Ed25519' },
  ES256: { key: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' }, kty: 'EC', crv: 'P-256' },
};

/**
 * The signature algorithm a key is for, or null.
 * @param {CryptoKey} key
 * @returns {SignatureAlg | null}
 */
function algOf(key) {
  const a = /** @type {{ name: string, namedCurve?: string }} */ (key.algorithm);
  if (a.name === 'Ed25519') return 'Ed25519';
  if (a.name === 'ECDSA' && a.namedCurve === 'P-256') return 'ES256';
  return null;
}

/** @param {unknown} v */
const isCryptoKey = (v) => typeof CryptoKey !== 'undefined' && v instanceof CryptoKey;

/**
 * Imports a public key for signature checks: a CryptoKey (returned as it is), a JWK (object or JSON
 * text) for Ed25519 or P-256, or SPKI in PEM ("-----BEGIN PUBLIC KEY-----"). A JWK with private
 * parts is refused, so a private key is not passed around by mistake.
 * @param {CryptoKey | JsonWebKey | string} input
 * @returns {Promise<CryptoKey>}
 */
export async function importPublicKey(input) {
  if (isCryptoKey(input)) {
    const key = /** @type {CryptoKey} */ (input);
    if (key.type !== 'public' || !algOf(key)) throw new TypeError('not an Ed25519 or P-256 public key');
    return key;
  }
  if (typeof input === 'string') {
    const text = input.trim();
    const pem = /^-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----$/.exec(text);
    if (pem) {
      const der = Uint8Array.from(atob(pem[1].replace(/\s+/g, '')), (ch) => ch.charCodeAt(0));
      for (const alg of SIGNATURE_ALGS) {
        try {
          return await crypto.subtle.importKey('spki', der, PARAMS[alg].key, true, ['verify']);
        } catch (err) {
          if (alg === SIGNATURE_ALGS[SIGNATURE_ALGS.length - 1]) throw err;
        }
      }
    }
    if (text.startsWith('-----BEGIN')) throw new TypeError('not a PEM public key (expected -----BEGIN PUBLIC KEY-----)');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TypeError('not a JWK or a PEM public key');
    }
    return importPublicKey(parsed);
  }
  if (typeof input !== 'object' || input === null) throw new TypeError('not a public key');
  const jwk = /** @type {Record<string, unknown>} */ (input);
  if ('d' in jwk) throw new TypeError('this JWK contains a private key; give the public key only');
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string') {
    return crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, PARAMS.Ed25519.key, true, ['verify']);
  }
  if (jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string') {
    return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, PARAMS.ES256.key, true, ['verify']);
  }
  throw new TypeError('not an Ed25519 (OKP) or P-256 (EC) public JWK');
}

/**
 * The key id of a public key: SHA-256 (hex) of its SubjectPublicKeyInfo. The same for the key in
 * PEM, JWK or CryptoKey form (`openssl pkey -pubin -outform DER | sha256sum` gives it, too).
 * @param {CryptoKey | JsonWebKey | string} publicKey
 */
export async function publicKeyId(publicKey) {
  const key = await importPublicKey(publicKey);
  return sha256Hex(new Uint8Array(await crypto.subtle.exportKey('spki', key)));
}

/**
 * The public members of a public key as a JWK.
 * @param {CryptoKey} key
 * @returns {Promise<ReceiptSignature['publicKey']>}
 */
async function publicJwk(key) {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (algOf(key) === 'Ed25519') return { kty: 'OKP', crv: 'Ed25519', x: /** @type {string} */ (jwk.x) };
  return { kty: 'EC', crv: 'P-256', x: /** @type {string} */ (jwk.x), y: /** @type {string} */ (jwk.y) };
}

/**
 * The bytes a signature covers.
 * @param {SignatureAlg} alg
 * @param {string} keyId
 * @param {{ id: string, merkle: unknown }} head
 */
function signingInput(alg, keyId, head) {
  return new TextEncoder().encode(`starpi.receipt/v2 signature\n${canonicalJson({ alg, id: head.id, keyId, merkle: head.merkle })}`);
}

/**
 * Signs a receipt head with a private key. The public key is needed for the key id; it can be left
 * out when the private key is extractable (its JWK holds the public part).
 * @param {{ id: string, merkle: unknown }} head
 * @param {CryptoKey} privateKey  Ed25519, or ECDSA P-256, with the "sign" usage
 * @param {CryptoKey | JsonWebKey | string} [publicKey]
 * @returns {Promise<ReceiptSignature>}
 */
export async function signHead(head, privateKey, publicKey) {
  const alg = isCryptoKey(privateKey) && privateKey.type === 'private' ? algOf(privateKey) : null;
  if (!alg) throw new TypeError('signReceipt: the private key must be an Ed25519 or ECDSA P-256 CryptoKey');
  let pub;
  if (publicKey !== undefined) pub = await importPublicKey(publicKey);
  else if (privateKey.extractable) {
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', privateKey);
    pub = await importPublicKey(/** @type {JsonWebKey} */ ({ kty, crv, x, y }));
  } else throw new TypeError('signReceipt: give the public key, the private key is not extractable');
  if (algOf(pub) !== alg) throw new TypeError('signReceipt: the public key is for a different algorithm');
  const keyId = await publicKeyId(pub);
  const input = signingInput(alg, keyId, head);
  const value = new Uint8Array(await crypto.subtle.sign(PARAMS[alg].sign, privateKey, input));
  // A signature the public key does not accept would make a receipt that fails every check.
  if (!(await crypto.subtle.verify(PARAMS[alg].sign, pub, value, input))) throw new Error('signReceipt: the public key does not belong to the private key');
  return { alg, keyId, publicKey: await publicJwk(pub), value: toBase64url(value) };
}

/**
 * Checks a signature over a receipt head. With a public key from the caller, the signature must be
 * by that key (`trusted`); without one, the key embedded in the signature is used, which shows the
 * head is unchanged since signing but not who signed it.
 * @param {{ id: string, merkle: unknown }} head
 * @param {ReceiptSignature} signature
 * @param {CryptoKey | JsonWebKey | string} [publicKey]
 * @returns {Promise<SignatureCheck>}
 */
export async function verifyHead(head, signature, publicKey) {
  const alg = SIGNATURE_ALGS.includes(signature.alg) ? signature.alg : null;
  /** @type {SignatureCheck} */
  const result = { status: 'invalid', alg, keyId: signature.keyId, trusted: false };
  if (!alg) return { ...result, status: 'unsupported_algorithm' };
  /** @type {CryptoKey} */
  let key;
  try {
    key = await importPublicKey(publicKey ?? signature.publicKey);
  } catch (err) {
    // A runtime without Ed25519 in WebCrypto (older browsers) cannot check such a signature.
    if (err instanceof Error && err.name === 'NotSupportedError') return { ...result, status: 'unsupported_algorithm' };
    if (publicKey !== undefined) throw err;
    return result;
  }
  const keyId = await publicKeyId(key);
  if (publicKey !== undefined && (algOf(key) !== alg || keyId !== signature.keyId)) return { ...result, status: 'key_mismatch' };
  if (algOf(key) !== alg || keyId !== signature.keyId) return result;
  const value = fromBase64url(signature.value);
  if (!value || value.length !== 64) return result;
  const ok = await crypto.subtle.verify(PARAMS[alg].sign, key, value, signingInput(alg, keyId, head));
  return { ...result, status: ok ? 'valid' : 'invalid', trusted: ok && publicKey !== undefined };
}
