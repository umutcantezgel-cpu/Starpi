import './setup.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { canonicalJson, fromBase64url, fromHex, sha256Hex, toBase64url, toHex } from '../../src/js/core/hash.js';
import { MERKLE_ALG, merkleLeafHash, merkleTree, verifyMerkleProof } from '../../src/js/core/merkle.js';

// An independent RFC 6962 implementation on node:crypto, written from §2.1 of the RFC: the tree hash
// MTH and the audit path PATH, both recursive.
const H = (/** @type {Buffer[]} */ ...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const leafOf = (/** @type {Buffer} */ d) => H(Buffer.from([0]), d);
/** @param {number} n */
const split = (n) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};
/** @param {Buffer[]} d @returns {Buffer} */
const mth = (d) => (d.length === 0 ? H(Buffer.alloc(0)) : d.length === 1 ? leafOf(d[0]) : H(Buffer.from([1]), mth(d.slice(0, split(d.length))), mth(d.slice(split(d.length)))));
/** @param {number} m @param {Buffer[]} d @returns {Buffer[]} */
const path = (m, d) => {
  if (d.length <= 1) return [];
  const k = split(d.length);
  return m < k ? [...path(m, d.slice(0, k)), mth(d.slice(k))] : [...path(m - k, d.slice(k)), mth(d.slice(0, k))];
};

// The leaf inputs and tree hashes of the Certificate Transparency test vectors (as used by
// implementations such as Google Trillian) for trees of 1 to 8 leaves.
const CT_LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'];
const CT_ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

describe('Merkle tree (RFC 6962)', () => {
  it('reproduces the Certificate Transparency test vectors', async () => {
    const leaves = await Promise.all(CT_LEAVES.map((h) => merkleLeafHash(/** @type {Uint8Array} */ (fromHex(h)))));
    for (let n = 1; n <= 8; n++) assert.equal((await merkleTree(leaves.slice(0, n))).root, CT_ROOTS[n - 1], `${n} leaves`);
    assert.equal((await merkleTree([])).root, createHash('sha256').digest('hex'), 'the empty tree hashes the empty string');
    assert.equal(MERKLE_ALG, 'sha256-rfc6962');
  });

  it('matches an independent implementation for 0 to 64 leaves, root and every audit path', async () => {
    for (let n = 0; n <= 64; n++) {
      const data = Array.from({ length: n }, (_, i) => Buffer.from(`leaf ${i} of ${n}`));
      const leaves = await Promise.all(data.map((d) => merkleLeafHash(new Uint8Array(d))));
      const tree = await merkleTree(leaves);
      assert.equal(tree.root, mth(data).toString('hex'), `root of ${n}`);
      assert.equal(tree.proofs.length, n);
      for (let m = 0; m < n; m++) {
        assert.deepEqual(tree.proofs[m], path(m, data).map((b) => b.toString('hex')), `path of leaf ${m} of ${n}`);
        assert.ok(tree.proofs[m].length <= 6);
        assert.equal(await verifyMerkleProof(leaves[m], m, n, tree.proofs[m], tree.root), true, `proof of leaf ${m} of ${n}`);
      }
    }
  });

  it('rejects a proof for another leaf, position, size or root, and a changed path', async () => {
    const leaves = await Promise.all(Array.from({ length: 11 }, (_, i) => merkleLeafHash(`citation ${i}`)));
    const { root, proofs } = await merkleTree(leaves);
    const ok = (/** @type {string} */ leaf, /** @type {number} */ index, /** @type {number} */ size, /** @type {string[]} */ proof, /** @type {string} */ r) => verifyMerkleProof(leaf, index, size, proof, r);
    assert.equal(await ok(leaves[4], 4, 11, proofs[4], root), true);
    assert.equal(await ok(leaves[5], 4, 11, proofs[4], root), false, 'another leaf');
    assert.equal(await ok(leaves[4], 5, 11, proofs[4], root), false, 'another position');
    // A size that changes the shape of the path fails. (Sizes with the same shape for this leaf, such as
    // 12, give the same root; that is why receipts record the size next to the root and sign both.)
    assert.equal(await ok(leaves[4], 4, 5, proofs[4], root), false, 'another size');
    assert.equal(await ok(leaves[4], 4, 7, proofs[4], root), false, 'another size');
    assert.equal(await ok(leaves[4], 4, 11, proofs[4], leaves[0]), false, 'another root');
    assert.equal(await ok(leaves[4], 4, 11, proofs[4].slice(1), root), false, 'a shortened path');
    assert.equal(await ok(leaves[4], 4, 11, [...proofs[4], leaves[0]], root), false, 'a lengthened path');
    assert.equal(await ok(leaves[4], 4, 11, proofs[4].map((h, i) => (i === 1 ? leaves[9] : h)), root), false, 'a changed hash');
    assert.equal(await ok(leaves[10], 10, 11, proofs[10], root), true, 'the last, unbalanced leaf');
    assert.equal(await ok(leaves[4], 11, 11, proofs[4], root), false, 'index outside the tree');
    assert.equal(await ok(leaves[4], -1, 11, proofs[4], root), false);
    assert.equal(await ok('ab', 4, 11, proofs[4], root), false, 'not a hash');
    assert.equal(await ok(leaves[4].toUpperCase(), 4, 11, proofs[4], root), false, 'upper-case hex');
    // A leaf hash is not accepted as an interior node and vice versa (domain separation).
    assert.notEqual(await merkleLeafHash(fromHex(leaves[0] + leaves[1]) ?? new Uint8Array()), (await merkleTree(leaves.slice(0, 2))).root);
  });
});

describe('hash helpers', () => {
  it('encodes hex and base64url canonically', async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
    assert.equal(toHex(bytes), Buffer.from(bytes).toString('hex'));
    assert.deepEqual(fromHex(toHex(bytes)), bytes);
    assert.equal(fromHex('abc'), null);
    assert.equal(fromHex('AB'), null);
    const b64 = toBase64url(bytes);
    assert.equal(b64, Buffer.from(bytes).toString('base64url'));
    assert.equal(b64.length, 86);
    assert.deepEqual(fromBase64url(b64), bytes);
    // The last character of 64 bytes carries 2 unused bits: only the spelling with them zero is accepted.
    const last = b64.at(-1) ?? '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const sibling = alphabet[alphabet.indexOf(last) ^ 1];
    assert.equal(fromBase64url(b64.slice(0, -1) + sibling), null);
    assert.equal(fromBase64url(`${b64}=`), null, 'padding');
    assert.equal(fromBase64url('ab+c'), null, 'standard base64 characters');
    assert.equal(fromBase64url('a'), null);
    assert.equal(await sha256Hex('Größe'), createHash('sha256').update('Größe', 'utf8').digest('hex'));
    assert.equal(canonicalJson({ b: [1, { d: 2, c: 3 }], a: 'x' }), '{"a":"x","b":[1,{"c":3,"d":2}]}');
  });
});
