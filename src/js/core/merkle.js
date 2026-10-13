// @ts-check
// Merkle tree hash and inclusion proofs as defined in RFC 6962 §2.1 (Certificate Transparency),
// with SHA-256: a leaf hash is SHA-256(0x00 ‖ data), an interior node SHA-256(0x01 ‖ left ‖ right),
// and a tree of n > 1 leaves splits at the largest power of two below n. Receipts v2 put one leaf per
// citation into such a tree (see receipt.js); each citation carries its audit path, so one citation
// can be checked against the root without the others.
//
// Hashes are lowercase hex strings. Pure: WebCrypto only.
import { fromHex, sha256Bytes, toHex } from './hash.js';

/** Identifier recorded in receipts for this tree construction. */
export const MERKLE_ALG = 'sha256-rfc6962';

/**
 * The leaf hash of some data: SHA-256(0x00 ‖ data). Strings are hashed as UTF-8.
 * @param {string | Uint8Array} data
 */
export async function merkleLeafHash(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const input = new Uint8Array(bytes.length + 1);
  input.set(bytes, 1);
  return toHex(await sha256Bytes(input));
}

/**
 * SHA-256(0x01 ‖ left ‖ right) of two hex hashes.
 * @param {string} left
 * @param {string} right
 */
async function nodeHash(left, right) {
  const l = fromHex(left);
  const r = fromHex(right);
  if (!l || !r || l.length !== 32 || r.length !== 32) throw new TypeError('merkle: hashes must be 64 lowercase hex characters');
  const input = new Uint8Array(65);
  input[0] = 1;
  input.set(l, 1);
  input.set(r, 33);
  return toHex(await sha256Bytes(input));
}

/** Largest power of two smaller than n (n > 1). @param {number} n */
function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * The tree hash of a list of leaf hashes and, for every leaf, its audit path (RFC 6962 §2.1.1),
 * ordered from the leaf's sibling up to the child of the root. The empty tree hashes to SHA-256 of
 * the empty string.
 * @param {string[]} leaves  leaf hashes from merkleLeafHash()
 * @returns {Promise<{ root: string, proofs: string[][] }>}
 */
export async function merkleTree(leaves) {
  if (leaves.length === 0) return { root: toHex(await sha256Bytes(new Uint8Array(0))), proofs: [] };
  /**
   * @param {number} from
   * @param {number} to
   * @returns {Promise<{ root: string, proofs: string[][] }>}
   */
  const build = async (from, to) => {
    if (to - from === 1) return { root: leaves[from], proofs: [[]] };
    const k = splitPoint(to - from);
    const left = await build(from, from + k);
    const right = await build(from + k, to);
    return {
      root: await nodeHash(left.root, right.root),
      proofs: [...left.proofs.map((p) => [...p, right.root]), ...right.proofs.map((p) => [...p, left.root])],
    };
  };
  return build(0, leaves.length);
}

/**
 * Checks that a leaf hash is the leaf at `index` of a tree of `size` leaves with the given root,
 * using its audit path (the verification algorithm of RFC 9162 §2.1.3.2).
 * @param {string} leaf
 * @param {number} index
 * @param {number} size
 * @param {string[]} proof
 * @param {string} root
 */
export async function verifyMerkleProof(leaf, index, size, proof, root) {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
  if (![leaf, root, ...proof].every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && r === root;
}
