// Receipts v2: the Merkle tree over the citations, inclusion proofs, signatures, and verification
// of v1 receipts made by the released 1.3.0 code.
import './setup.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { canonicalJson } from '../../src/js/core/hash.js';
import {
  buildReceipt,
  citationLeafHash,
  RECEIPT_LIMITS,
  RECEIPT_SCHEMA,
  RECEIPT_SCHEMA_V1,
  sha256Hex,
  signReceipt,
  validateReceipt,
  verifyCitationProof,
  verifyReceipt,
  verifyReceiptSignature,
} from '../../src/js/core/receipt.js';
import { importPublicKey, publicKeyId } from '../../src/js/core/signature.js';
import { CHUNKER, chunkText } from '../../src/js/rag/chunker.js';
import { EXTRACTOR, extractText } from '../../src/js/rag/parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tools = {
  extractor: EXTRACTOR,
  extract: async (/** @type {Uint8Array} */ bytes, /** @type {string} */ name) => {
    const r = await extractText(new File([bytes], name));
    return { text: r.text, pdfjs: r.pdfjs };
  },
};

const PLAN = new Uint8Array(readFileSync(path.join(ROOT, 'public/samples/en/nebula-plan.md')));
const RISKS = new Uint8Array(readFileSync(path.join(ROOT, 'public/samples/en/nebula-risks.csv')));
const FILES = [
  { name: 'nebula-plan.md', bytes: PLAN },
  { name: 'nebula-risks.csv', bytes: RISKS },
];

/**
 * A receipt over the first chunks of the two sample files plus one knowledge-base excerpt.
 * @param {Parameters<typeof buildReceipt>[1]} [options]
 */
async function sampleReceipt(options) {
  /** @type {Parameters<typeof buildReceipt>[0]['citations']} */
  const citations = [];
  /** @type {Array<{ label: string, doc: string, heading: string, text: string, delivered: 'full' }>} */
  const sources = [];
  for (const { name, bytes } of FILES) {
    const { text, kind, pages, pdfjs } = await extractText(new File([bytes], name));
    for (const chunk of chunkText(text).slice(0, 2)) {
      const label = `[Doc: ${name}, Chunk: ${chunk.index + 1}]`;
      sources.push({ label, doc: name, heading: '', text: chunk.text, delivered: 'full' });
      citations.push({
        label,
        doc: name,
        heading: '',
        source: 'workspace',
        delivered: 'full',
        text: chunk.text,
        truncated: false,
        document: { name, kind, bytes: bytes.length, fileSha256: await sha256Hex(bytes), textSha256: await sha256Hex(text), textChars: text.length, pages, extractor: { ...EXTRACTOR, pdfjs }, chunker: { ...CHUNKER, size: 500, overlap: 50 } },
        chunk: { index: chunk.index, start: chunk.start, end: chunk.end },
      });
    }
  }
  const kb = { label: '[Doc: Handbook, Chunk: 1]', doc: 'Handbook', heading: 'Travel', text: 'Trains are booked in second class.' };
  sources.push({ ...kb, delivered: 'full' });
  citations.push({ ...kb, source: 'knowledge', delivered: 'full', truncated: false, documentId: 'kb-1' });
  const answer = 'The approved budget for Project Nebula is 480,000 EUR [Doc: nebula-plan.md, Chunk: 1]. The public launch is planned for 12 June 2027 [Doc: nebula-plan.md, Chunk: 1].';
  return buildReceipt(
    { createdAt: '2026-10-13T12:00:00.000Z', version: '2.0.0', answer: { text: answer, engine: 'cloud', locale: 'en' }, question: 'Budget and launch?', grounding: groundAnswer(blocksFromMarkdown(answer, sources), sources), citations },
    options,
  );
}

/** Independent leaf hash: SHA-256(0x00 ‖ canonical JSON of the citation without proof and excerpt text). @param {any} c */
const independentLeaf = (c) => {
  const { proof: _proof, ...rest } = c;
  void _proof;
  const json = canonicalJson({ ...rest, excerpt: { sha256: c.excerpt.sha256, truncated: c.excerpt.truncated } });
  return createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(json, 'utf8')])).digest('hex');
};

const ALGORITHMS = /** @type {const} */ ([
  ['Ed25519', { name: 'Ed25519' }],
  ['ES256', { name: 'ECDSA', namedCurve: 'P-256' }],
]);

/** @param {AlgorithmIdentifier | EcKeyGenParams} params */
const keyPair = async (params) => /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(params, true, ['sign', 'verify']));

/** @param {CryptoKey} key */
const pemOf = async (key) => {
  const der = Buffer.from(await crypto.subtle.exportKey('spki', key)).toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----\n`;
};

describe('receipts v2: Merkle tree', () => {
  it('writes v2 by default, with a root over one leaf per citation and a proof in every citation', async () => {
    const r = await sampleReceipt();
    assert.equal(r.schema, RECEIPT_SCHEMA);
    assert.equal(RECEIPT_SCHEMA, 'starpi.receipt/v2');
    assert.deepEqual(Object.keys(r).slice(0, 2), ['schema', 'id']);
    assert.equal(r.citations.length, 5);
    assert.deepEqual({ alg: r.merkle?.alg, size: r.merkle?.size }, { alg: 'sha256-rfc6962', size: 5 });
    // Leaves recomputed independently; the root of 5 leaves is H(1 ‖ H(1 ‖ H(1 ‖ l0 ‖ l1) ‖ H(1 ‖ l2 ‖ l3)) ‖ l4).
    const l = r.citations.map(independentLeaf);
    const node = (/** @type {string} */ a, /** @type {string} */ b) => createHash('sha256').update(Buffer.concat([Buffer.from([1]), Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])).digest('hex');
    assert.equal(r.merkle?.root, node(node(node(l[0], l[1]), node(l[2], l[3])), l[4]));
    assert.deepEqual(r.citations[4].proof, [node(node(l[0], l[1]), node(l[2], l[3]))]);
    assert.deepEqual(r.citations[0].proof, [l[1], node(l[2], l[3]), l[4]]);
    for (const [i, c] of r.citations.entries()) assert.equal(await citationLeafHash(c), l[i]);
    // The id covers everything but itself (and a signature): the tree and the proofs included.
    const { id, ...body } = r;
    assert.equal(id, await sha256Hex(canonicalJson(body)));
    assert.deepEqual(validateReceipt(JSON.parse(JSON.stringify(r))).ok, true);
  });

  it('checks a single citation against the root, without the others', async () => {
    const r = await sampleReceipt();
    const merkle = /** @type {NonNullable<typeof r.merkle>} */ (r.merkle);
    for (const [i, c] of r.citations.entries()) assert.equal(await verifyCitationProof(c, i, merkle), true, `citation ${i}`);
    const disclosed = JSON.parse(JSON.stringify(r.citations[2]));
    assert.equal(await verifyCitationProof(disclosed, 2, merkle), true, 'a copy taken out of the receipt');
    assert.equal(await verifyCitationProof({ ...disclosed, excerpt: { ...disclosed.excerpt, text: null } }, 2, merkle), true, 'without its text');
    assert.equal(await verifyCitationProof(disclosed, 1, merkle), false, 'at another position');
    assert.equal(await verifyCitationProof({ ...disclosed, label: '[Doc: other.md, Chunk: 1]' }, 2, merkle), false, 'a changed label');
    assert.equal(await verifyCitationProof({ ...disclosed, chunk: { ...disclosed.chunk, start: disclosed.chunk.start + 1 } }, 2, merkle), false, 'changed offsets');
    assert.equal(await verifyCitationProof({ ...disclosed, excerpt: { ...disclosed.excerpt, sha256: '0'.repeat(64) } }, 2, merkle), false, 'another excerpt');
  });

  it('gives the same root without the excerpt texts and the question, and builds v1 on request', async () => {
    const full = await sampleReceipt();
    const lean = await sampleReceipt({ includeExcerpts: false, includeQuestion: false });
    assert.equal(lean.merkle?.root, full.merkle?.root);
    assert.notEqual(lean.id, full.id);
    const v1 = await sampleReceipt({ schema: RECEIPT_SCHEMA_V1 });
    assert.equal(v1.schema, 'starpi.receipt/v1');
    assert.equal(v1.merkle, undefined);
    assert.ok(v1.citations.every((c) => c.proof === undefined));
    assert.equal(validateReceipt(JSON.parse(JSON.stringify(v1))).ok, true);
    // @ts-expect-error -- an unknown schema is refused
    await assert.rejects(sampleReceipt({ schema: 'starpi.receipt/v3' }), /unknown schema/);
  });

  it('reports the root, every proof and an edited citation in verifyReceipt', async () => {
    const r = await sampleReceipt();
    const report = await verifyReceipt(r, FILES, tools);
    assert.equal(report.schema, RECEIPT_SCHEMA);
    assert.equal(report.idMatches, true);
    assert.deepEqual(report.merkle, { size: 5, rootMatches: true, validProofs: 5 });
    assert.deepEqual(report.citations.map((c) => c.proof), [true, true, true, true, true]);
    assert.deepEqual(report.summary, { reproduced: 4, verifiable: 4 });
    assert.deepEqual(report.signature, { status: 'unsigned', alg: null, keyId: null, trusted: false });

    const edited = structuredClone(r);
    edited.citations[3].heading = 'Moved';
    const bad = await verifyReceipt(edited, FILES, tools);
    assert.equal(bad.idMatches, false);
    assert.equal(bad.merkle?.rootMatches, false);
    assert.deepEqual(bad.citations.map((c) => c.proof), [true, true, true, false, true]);

    const badProof = structuredClone(r);
    badProof.citations[1].proof = [...(badProof.citations[1].proof ?? [])].reverse();
    const proofReport = await verifyReceipt(badProof, FILES, tools);
    assert.deepEqual({ ...proofReport.merkle }, { size: 5, rootMatches: true, validProofs: 4 });
    assert.equal(proofReport.citations[1].proof, false);
  });
});

describe('receipts v2: signatures', () => {
  for (const [alg, params] of ALGORITHMS) {
    it(`signs with ${alg} and verifies with the embedded key, the signer's key in every form, and outside Starpi`, async () => {
      const keys = await keyPair(params);
      const signed = await signReceipt(await sampleReceipt(), keys.privateKey, { publicKey: keys.publicKey });
      const sig = /** @type {NonNullable<typeof signed.signature>} */ (signed.signature);
      assert.equal(sig.alg, alg);
      assert.match(sig.value, /^[A-Za-z0-9_-]{86}$/);
      assert.deepEqual(Object.keys(sig.publicKey).sort(), alg === 'Ed25519' ? ['crv', 'kty', 'x'] : ['crv', 'kty', 'x', 'y']);
      // The key id is the SHA-256 of the SPKI, the same as openssl and node:crypto compute it.
      const spki = createPublicKey({ key: /** @type {import('node:crypto').JsonWebKey} */ (sig.publicKey), format: 'jwk' }).export({ type: 'spki', format: 'der' });
      assert.equal(sig.keyId, createHash('sha256').update(spki).digest('hex'));
      assert.equal(await publicKeyId(keys.publicKey), sig.keyId);
      // The id does not cover the signature.
      assert.equal(signed.id, (await sampleReceipt()).id);

      const roundTrip = validateReceipt(JSON.parse(JSON.stringify(signed)));
      assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip));
      const parsed = /** @type {typeof signed} */ (roundTrip.ok ? roundTrip.receipt : signed);
      assert.deepEqual(await verifyReceiptSignature(parsed), { status: 'valid', alg, keyId: sig.keyId, trusted: false });
      const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
      for (const key of [keys.publicKey, jwk, JSON.stringify(jwk), await pemOf(keys.publicKey)]) {
        assert.deepEqual(await verifyReceiptSignature(parsed, key), { status: 'valid', alg, keyId: sig.keyId, trusted: true });
      }
      const report = await verifyReceipt(parsed, FILES, tools, { publicKey: keys.publicKey });
      assert.equal(report.signature?.status, 'valid');
      assert.equal(report.signature?.trusted, true);

      // Any verifier that implements the documented signing input accepts it: here node:crypto.
      const input = Buffer.from(`starpi.receipt/v2 signature\n${canonicalJson({ alg, id: signed.id, keyId: sig.keyId, merkle: signed.merkle })}`, 'utf8');
      const nodeKey = createPublicKey({ key: /** @type {import('node:crypto').JsonWebKey} */ (sig.publicKey), format: 'jwk' });
      const value = Buffer.from(sig.value, 'base64url');
      assert.equal(alg === 'Ed25519' ? nodeVerify(null, input, nodeKey, value) : nodeVerify('sha256', input, { key: nodeKey, dsaEncoding: 'ieee-p1363' }, value), true);
    });
  }

  it('detects every edit after signing, and tells a re-signed receipt from the signer\'s', async () => {
    const keys = await keyPair({ name: 'Ed25519' });
    const other = await keyPair({ name: 'Ed25519' });
    const signed = await signReceipt(await sampleReceipt(), keys.privateKey);
    const status = async (/** @type {typeof signed} */ r) => (await verifyReceiptSignature(r)).status;

    const answer = structuredClone(signed);
    answer.answer.text = answer.answer.text.replace('480,000', '520,000');
    assert.equal(await status(answer), 'invalid', 'an edited answer: the id no longer matches');

    // An attacker who edits a citation and recomputes the leaf, root and id still cannot sign them.
    const rehashed = structuredClone(signed);
    rehashed.citations[0].heading = 'Forged';
    const rebuilt = await sampleReceipt();
    rebuilt.citations[0].heading = 'Forged';
    const { merkleTree } = await import('../../src/js/core/merkle.js');
    const tree = await merkleTree(await Promise.all(rebuilt.citations.map(citationLeafHash)));
    rehashed.citations.forEach((c, i) => {
      c.proof = tree.proofs[i];
    });
    rehashed.merkle = { alg: 'sha256-rfc6962', size: rebuilt.citations.length, root: tree.root };
    const { id: _id, signature: _sig, ...body } = rehashed;
    void _id;
    void _sig;
    rehashed.id = await sha256Hex(canonicalJson(body));
    assert.equal(await status(rehashed), 'invalid', 'recomputed hashes, old signature');

    const root = structuredClone(signed);
    if (root.merkle) root.merkle.root = '0'.repeat(64);
    assert.equal(await status(root), 'invalid', 'a changed root');

    const swappedKey = structuredClone(signed);
    if (swappedKey.signature) swappedKey.signature.publicKey = /** @type {any} */ ({ kty: 'OKP', crv: 'Ed25519', x: (await crypto.subtle.exportKey('jwk', other.publicKey)).x });
    assert.equal(await status(swappedKey), 'invalid', 'an embedded key that does not have the key id');

    const flipped = structuredClone(signed);
    if (flipped.signature) flipped.signature.value = `${flipped.signature.value[0] === 'A' ? 'B' : 'A'}${flipped.signature.value.slice(1)}`;
    assert.equal(await status(flipped), 'invalid', 'a changed signature value');

    // Re-signed with another key: intact, but not by the signer.
    const resigned = await signReceipt(await sampleReceipt(), other.privateKey);
    assert.deepEqual(await verifyReceiptSignature(resigned), { status: 'valid', alg: 'Ed25519', keyId: resigned.signature?.keyId, trusted: false });
    assert.equal((await verifyReceiptSignature(resigned, keys.publicKey)).status, 'key_mismatch');
    assert.equal((await verifyReceiptSignature(signed, (await keyPair({ name: 'ECDSA', namedCurve: 'P-256' })).publicKey)).status, 'key_mismatch', 'a key for another algorithm');
  });

  it('signs only consistent v2 receipts and refuses private keys where a public key belongs', async () => {
    const keys = await keyPair({ name: 'Ed25519' });
    await assert.rejects(signReceipt(await sampleReceipt({ schema: RECEIPT_SCHEMA_V1 }), keys.privateKey), /only starpi\.receipt\/v2/);
    const edited = await sampleReceipt();
    edited.answer.text += ' Edited.';
    await assert.rejects(signReceipt(edited, keys.privateKey), /id does not match/);
    await assert.rejects(signReceipt(await sampleReceipt(), keys.publicKey), /private key/);
    const pair = await keyPair({ name: 'Ed25519' });
    await assert.rejects(signReceipt(await sampleReceipt(), keys.privateKey, { publicKey: pair.publicKey }), /does not belong/);
    const privateJwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
    await assert.rejects(importPublicKey(privateJwk), /private key/);
    await assert.rejects(importPublicKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'), /PEM public key/);
    await assert.rejects(importPublicKey('not a key'), /JWK or a PEM/);
    const unextractable = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']));
    await assert.rejects(signReceipt(await sampleReceipt(), unextractable.privateKey), /give the public key/);
    assert.equal((await signReceipt(await sampleReceipt(), unextractable.privateKey, { publicKey: unextractable.publicKey })).signature?.alg, 'Ed25519');
    assert.equal((await verifyReceiptSignature(await sampleReceipt({ schema: RECEIPT_SCHEMA_V1 }))).status, 'unsigned');
  });
});

describe('receipts v2: validation', () => {
  it('refuses malformed trees, proofs and signatures, and v2 members in a v1 receipt', async () => {
    const keys = await keyPair({ name: 'Ed25519' });
    const signed = JSON.parse(JSON.stringify(await signReceipt(await sampleReceipt(), keys.privateKey)));
    const v1 = JSON.parse(JSON.stringify(await sampleReceipt({ schema: RECEIPT_SCHEMA_V1 })));
    const fails = (/** @type {(r: any) => void} */ edit, /** @type {any} */ base = signed) => {
      const r = structuredClone(base);
      edit(r);
      return validateReceipt(r);
    };
    assert.deepEqual(validateReceipt({ ...signed, schema: 'starpi.receipt/v3' }), { ok: false, error: 'unsupported_version', path: 'schema' });
    assert.deepEqual(fails((r) => delete r.merkle), { ok: false, error: 'object', path: 'merkle' });
    assert.deepEqual(fails((r) => (r.merkle.size = 4)), { ok: false, error: 'number of citations', path: 'merkle.size' });
    assert.deepEqual(fails((r) => (r.merkle.alg = 'sha1')), { ok: false, error: 'one of sha256-rfc6962', path: 'merkle.alg' });
    assert.deepEqual(fails((r) => (r.merkle.extra = 1)), { ok: false, error: 'unknown member', path: 'merkle.extra' });
    assert.deepEqual(fails((r) => delete r.citations[0].proof), { ok: false, error: 'array', path: 'citations[0].proof' });
    assert.deepEqual(fails((r) => (r.citations[0].proof = Array(RECEIPT_LIMITS.proof + 1).fill('a'.repeat(64)))), { ok: false, error: 'array', path: 'citations[0].proof' });
    assert.deepEqual(fails((r) => (r.citations[0].proof[0] = 'XYZ')), { ok: false, error: 'sha256', path: 'citations[0].proof[0]' });
    assert.deepEqual(fails((r) => (r.signature = 'trust me')), { ok: false, error: 'object', path: 'signature' });
    assert.deepEqual(fails((r) => (r.signature.alg = 'RS256')), { ok: false, error: 'one of Ed25519|ES256', path: 'signature.alg' });
    assert.deepEqual(fails((r) => (r.signature.value = r.signature.value.slice(1))), { ok: false, error: 'base64url signature', path: 'signature.value' });
    assert.deepEqual(fails((r) => (r.signature.publicKey.d = 'secret')), { ok: false, error: 'unknown member', path: 'signature.publicKey.d' });
    assert.deepEqual(fails((r) => (r.signature.alg = 'ES256')), { ok: false, error: 'one of EC', path: 'signature.publicKey.kty' });
    assert.deepEqual(fails((r) => (r.signature.publicKey.x = 'short')), { ok: false, error: 'base64url coordinate', path: 'signature.publicKey.x' });
    assert.equal(fails((r) => delete r.signature).ok, true, 'a v2 receipt need not be signed');
    // v1 keeps its own allowlist: no tree, no proofs, no signature.
    assert.deepEqual(fails((r) => (r.merkle = signed.merkle), v1), { ok: false, error: 'unknown member', path: 'merkle' });
    assert.deepEqual(fails((r) => (r.citations[0].proof = []), v1), { ok: false, error: 'unknown member', path: 'citations[0].proof' });
    assert.deepEqual(fails((r) => (r.signature = signed.signature), v1), { ok: false, error: 'unknown member', path: 'signature' });
  });
});

describe('receipts v1 made by Starpi 1.3.0', () => {
  it('still validate and verify: every passage reproduced, the same verdicts, no tree and no signature', async () => {
    // tests/fixtures/receipts/v1.3.0-receipt.json was written by the released v1.3.0 code (the tag)
    // for the English sample files.
    const raw = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/receipts/v1.3.0-receipt.json'), 'utf8'));
    const valid = validateReceipt(raw);
    assert.equal(valid.ok, true, JSON.stringify(valid));
    if (!valid.ok) return;
    assert.equal(valid.receipt.schema, 'starpi.receipt/v1');
    assert.equal(valid.receipt.generator.version, '1.3.0');
    const report = await verifyReceipt(valid.receipt, FILES, tools);
    assert.equal(report.schema, 'starpi.receipt/v1');
    assert.equal(report.idMatches, true);
    assert.equal(report.answerMatches, true);
    assert.deepEqual(report.summary, { reproduced: 4, verifiable: 4 });
    assert.equal(report.merkle, null);
    assert.equal(report.signature, null);
    assert.ok(report.citations.every((c) => c.proof === null));
    assert.deepEqual(report.grounding?.differences, []);
    assert.deepEqual(valid.receipt.grounding?.counts, { supported: 2, weak: 0, unsupported: 1, unchecked: 0 });
  });
});

describe('scripts/verify-receipt.mjs with v2 receipts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'starpi-receipt-v2-'));
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-receipt.mjs'), ...args], { encoding: 'utf8' });
  const files = FILES.map((f) => {
    const p = path.join(dir, f.name);
    writeFileSync(p, f.bytes);
    return p;
  });

  it('checks the tree and the signature, against a given public key when there is one', async () => {
    const keys = await keyPair({ name: 'Ed25519' });
    const other = await keyPair({ name: 'ECDSA', namedCurve: 'P-256' });
    const signedPath = path.join(dir, 'signed.json');
    const unsignedPath = path.join(dir, 'unsigned.json');
    const keyPath = path.join(dir, 'signer.pem');
    const jwkPath = path.join(dir, 'signer.jwk');
    const otherPath = path.join(dir, 'other.pem');
    const signed = await signReceipt(await sampleReceipt(), keys.privateKey);
    writeFileSync(signedPath, JSON.stringify(signed));
    writeFileSync(unsignedPath, JSON.stringify(await sampleReceipt()));
    writeFileSync(keyPath, await pemOf(keys.publicKey));
    writeFileSync(jwkPath, JSON.stringify(await crypto.subtle.exportKey('jwk', keys.publicKey)));
    writeFileSync(otherPath, await pemOf(other.publicKey));

    const embedded = run([signedPath, ...files]);
    assert.equal(embedded.status, 0, embedded.stdout + embedded.stderr);
    assert.match(embedded.stdout, /ok {3}Merkle root over 5 citations matches, 5\/5 inclusion proofs valid/);
    assert.match(embedded.stdout, /signature valid for the key in the receipt \(Ed25519, key [0-9a-f]{16}…\); give --public-key/);

    for (const key of [keyPath, jwkPath]) {
      const trusted = run([signedPath, ...files, '--public-key', key, '--json']);
      assert.equal(trusted.status, 0, trusted.stderr);
      const json = JSON.parse(trusted.stdout);
      assert.equal(json.schema, 'starpi.receipt/v2');
      assert.deepEqual(json.signature, { status: 'valid', alg: 'Ed25519', keyId: signed.signature?.keyId, trusted: true });
      assert.deepEqual(json.merkle, { size: 5, rootMatches: true, validProofs: 5 });
    }
    const mismatch = run([signedPath, ...files, `--public-key=${otherPath}`]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stdout, /FAIL signed with key [0-9a-f]{16}…, not with the public key you gave/);
    const unsigned = run([unsignedPath, ...files, '--public-key', keyPath]);
    assert.equal(unsigned.status, 1);
    assert.match(unsigned.stdout, /FAIL not signed, but a public key was given/);
    assert.equal(run([unsignedPath, ...files]).status, 0, 'an unsigned receipt passes when no key is asked for');

    const tampered = structuredClone(signed);
    tampered.answer.text = tampered.answer.text.replace('480,000', '520,000');
    tampered.answer.sha256 = await sha256Hex(tampered.answer.text);
    writeFileSync(path.join(dir, 'tampered.json'), JSON.stringify(tampered));
    const forged = run([path.join(dir, 'tampered.json'), ...files]);
    assert.equal(forged.status, 1);
    assert.match(forged.stdout, /FAIL signature invalid/);

    writeFileSync(path.join(dir, 'private.jwk'), JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey)));
    assert.equal(run([signedPath, '--public-key', path.join(dir, 'private.jwk')]).status, 2, 'a private key is refused');
    assert.equal(run([signedPath, '--public-key']).status, 2);
    assert.equal(run([signedPath, '--frobnicate']).status, 2);
  });

  it('marks a citation whose inclusion proof does not lead to the root', async () => {
    const r = await sampleReceipt();
    r.citations[4].proof = [r.citations[0].proof?.[0] ?? ''];
    writeFileSync(path.join(dir, 'proof.json'), JSON.stringify(r));
    const out = run([path.join(dir, 'proof.json'), ...files]);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /FAIL Merkle root over 5 citations matches, 4\/5 inclusion proofs valid/);
    assert.match(out.stdout, /FAIL \[Doc: Handbook, Chunk: 1\]: knowledge-base excerpt, not independently verifiable, inclusion proof invalid/);
  });

  it('still verifies the receipt written by Starpi 1.3.0', () => {
    const out = run([path.join(ROOT, 'tests/fixtures/receipts/v1.3.0-receipt.json'), ...files]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /n\/a {2}receipt format v1: no Merkle tree, not signed/);
    assert.match(out.stdout, /4\/4 workspace excerpts reproduced/);
  });
});
