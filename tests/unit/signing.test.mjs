// Receipt signing on the device (trust/signing.js): a non-extractable Ed25519 key (P-256 where
// WebCrypto lacks Ed25519) kept in IndexedDB across reloads, exported as JWK and PEM, rotated and
// deleted, and "Sign exported receipts" with its setting. A receipt signed this way verifies with
// the exported public key, in code and with the command-line verifier (--require-signature).
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { buildReceipt, sha256Hex, validateReceipt, verifyReceipt, verifyReceiptSignature } from '../../src/js/core/receipt.js';
import { importPublicKey, publicKeyId } from '../../src/js/core/signature.js';
import { CHUNKER, chunkText } from '../../src/js/rag/chunker.js';
import { EXTRACTOR, EXTRACTOR_COMPATIBLE, extractText } from '../../src/js/rag/parser.js';
import { openAppDb } from '../../src/js/store/schema.js';
import { createReceiptSigner, SIGN_SETTING, SigningError } from '../../src/js/trust/signing.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLAN = new Uint8Array(readFileSync(path.join(ROOT, 'public/samples/en/nebula-plan.md')));

let seq = 0;
/** A fresh database of the app layout; the same factory opens it again "after a reload". */
async function freshDb() {
  const factory = new IDBFactory();
  const name = `signing-test-${(seq += 1)}`;
  const open = () => openAppDb({ name, factory });
  return { db: await open(), reopen: open };
}

/** A receipt draft citing the first chunk of the sample plan. */
async function draft() {
  const { text, kind, pages, pdfjs } = await extractText(new File([PLAN], 'nebula-plan.md'));
  const [chunk] = chunkText(text);
  const label = '[Doc: nebula-plan.md, Chunk: 1]';
  const answer = `The approved budget for Project Nebula is 480,000 EUR ${label}.`;
  const sources = [{ label, doc: 'nebula-plan.md', heading: '', text: chunk.text, delivered: /** @type {const} */ ('full') }];
  return {
    createdAt: '2026-10-17T10:00:00.000Z',
    version: '3.0.0',
    answer: { text: answer, engine: 'cloud', locale: 'en' },
    question: 'Budget?',
    grounding: groundAnswer(blocksFromMarkdown(answer, sources), sources),
    citations: [
      {
        label,
        doc: 'nebula-plan.md',
        heading: '',
        source: /** @type {const} */ ('workspace'),
        delivered: /** @type {const} */ ('full'),
        text: chunk.text,
        truncated: false,
        document: { name: 'nebula-plan.md', kind, bytes: PLAN.length, fileSha256: await sha256Hex(PLAN), textSha256: await sha256Hex(text), textChars: text.length, pages, extractor: { ...EXTRACTOR, pdfjs }, chunker: { ...CHUNKER, size: 500, overlap: 50 } },
        chunk: { index: chunk.index, start: chunk.start, end: chunk.end },
      },
    ],
  };
}

/**
 * Exports a receipt the way the app does: built with the signer, then signed.
 * @param {ReturnType<typeof createReceiptSigner>} signer
 */
async function exportReceipt(signer) {
  const exporter = await signer.exportSigner();
  const built = await buildReceipt(await draft(), { signer: exporter?.signer });
  return exporter ? exporter.sign(built) : built;
}

const tools = {
  extractor: EXTRACTOR,
  compatible: EXTRACTOR_COMPATIBLE,
  extract: async (/** @type {Uint8Array} */ bytes, /** @type {string} */ name) => {
    const r = await extractText(new File([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)], name));
    return { text: r.text, pdfjs: r.pdfjs };
  },
};

describe('device signing key', () => {
  it('starts without a key, signing on, and makes one non-extractable Ed25519 key on first export', async () => {
    const { db } = await freshDb();
    const signer = createReceiptSigner({ db: async () => db, now: () => 1_700_000_000_000 });
    await signer.ready();
    assert.deepEqual(signer.state(), { available: true, persistent: true, enabled: true, active: null, retired: [] });
    // Two exports at once still make a single key.
    const [a, b] = await Promise.all([signer.exportSigner(), signer.exportSigner()]);
    assert.equal(a?.signer.keyId, b?.signer.keyId);
    const records = await db.getAll('signingKeys');
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.alg, 'Ed25519');
    assert.equal(record.privateKey.extractable, false);
    assert.equal(record.privateKey.type, 'private');
    assert.equal(record.id, await publicKeyId(record.publicKey));
    assert.equal(record.id, a?.signer.keyId);
    assert.deepEqual(Object.keys(record.publicJwk).sort(), ['crv', 'kty', 'x']);
    assert.deepEqual(signer.state().active, { id: record.id, alg: 'Ed25519', createdAt: 1_700_000_000_000, retiredAt: null });
  });

  it('keeps the key across a reload and signs receipts that verify with its exported public key', async () => {
    const { db, reopen } = await freshDb();
    const first = createReceiptSigner({ db: async () => db });
    const keyId = (await first.createKey()).id;
    db.close();
    const again = await reopen();
    const signer = createReceiptSigner({ db: async () => again });
    await signer.ready();
    assert.equal(signer.state().active?.id, keyId, 'the same key after a reload');

    const receipt = await exportReceipt(signer);
    assert.deepEqual(receipt.signer, { keyId, alg: 'Ed25519' });
    const valid = validateReceipt(JSON.parse(JSON.stringify(receipt)));
    assert.equal(valid.ok, true);
    const pem = await signer.exportPublicKey(keyId, 'pem');
    const jwk = await signer.exportPublicKey(keyId, 'jwk');
    assert.match(pem.name, /^starpi-signing-key-[0-9a-f]{12}\.pem$/);
    assert.match(pem.text, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n$/);
    assert.equal(jwk.name.replace('.jwk', '.pem'), pem.name);
    const jwkObject = JSON.parse(jwk.text);
    assert.equal(jwkObject.kid, keyId);
    assert.equal(jwkObject.use, 'sig');
    assert.ok(!('d' in jwkObject), 'never a private member');
    for (const key of [pem.text, jwk.text]) {
      assert.equal(await publicKeyId(key), keyId);
      assert.deepEqual(await verifyReceiptSignature(receipt, key), { status: 'valid', alg: 'Ed25519', keyId, trusted: true });
    }
    const report = await verifyReceipt(receipt, [{ name: 'plan.md', bytes: PLAN }], tools, { publicKey: await importPublicKey(pem.text) });
    assert.deepEqual(report.summary, { reproduced: 1, verifiable: 1 });
    assert.equal(report.signature?.trusted, true);
    assert.equal(await signer.ownsKey(keyId), true);
    assert.equal(await signer.ownsKey('0'.repeat(64)), false);
  });

  it('verifies on the command line with --public-key and --require-signature', async () => {
    const { db } = await freshDb();
    const signer = createReceiptSigner({ db: async () => db });
    const receipt = await exportReceipt(signer);
    const keyId = /** @type {string} */ (receipt.signer?.keyId);
    const dir = mkdtempSync(path.join(tmpdir(), 'starpi-signing-'));
    const receiptPath = path.join(dir, 'receipt.json');
    const filePath = path.join(dir, 'nebula-plan.md');
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(filePath, PLAN);
    for (const format of /** @type {const} */ (['pem', 'jwk'])) {
      const file = await signer.exportPublicKey(keyId, format);
      const keyPath = path.join(dir, file.name);
      writeFileSync(keyPath, file.text);
      const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-receipt.mjs'), receiptPath, filePath, '--public-key', keyPath, '--require-signature'], { encoding: 'utf8' });
      assert.equal(out.status, 0, out.stdout + out.stderr);
      assert.match(out.stdout, /signature valid \(Ed25519, key [0-9a-f]{16}…, the public key you gave\)/);
    }
  });

  it('rotates to a new key that signs from then on; the old one never signs again but stays exportable', async () => {
    const { db, reopen } = await freshDb();
    let clock = 1_000;
    const signer = createReceiptSigner({ db: async () => db, now: () => (clock += 1_000) });
    const before = await exportReceipt(signer);
    const oldId = /** @type {string} */ (before.signer?.keyId);
    const oldPem = (await signer.exportPublicKey(oldId, 'pem')).text;
    /** @type {unknown[]} */
    const changes = [];
    signer.onChange((s) => changes.push(s));
    const fresh = await signer.rotate();
    assert.notEqual(fresh.id, oldId);
    assert.equal(changes.length, 1);
    const state = signer.state();
    assert.equal(state.active?.id, fresh.id);
    assert.deepEqual(state.retired.map((k) => k.id), [oldId]);
    assert.equal(state.retired[0].retiredAt, fresh.createdAt);
    const after = await exportReceipt(signer);
    assert.equal(after.signer?.keyId, fresh.id);
    assert.equal((await verifyReceiptSignature(before, oldPem)).trusted, true, 'old receipts still verify with the old public key');
    assert.equal((await verifyReceiptSignature(after, oldPem)).status, 'key_mismatch');
    // The retirement is stored.
    db.close();
    const reloaded = createReceiptSigner({ db: reopen });
    await reloaded.ready();
    assert.equal(reloaded.state().active?.id, fresh.id);
    assert.deepEqual(reloaded.state().retired.map((k) => k.id), [oldId]);
    assert.equal((await reloaded.exportPublicKey(oldId, 'pem')).text, oldPem);
  });

  it('deletes keys for good; the next signed export makes a new one', async () => {
    const { db } = await freshDb();
    const signer = createReceiptSigner({ db: async () => db });
    const first = await signer.createKey();
    await signer.rotate();
    await signer.deleteKey(first.id);
    assert.deepEqual(signer.state().retired, []);
    const active = /** @type {NonNullable<ReturnType<typeof signer.state>['active']>} */ (signer.state().active);
    await signer.deleteKey(active.id);
    assert.equal(signer.state().active, null);
    assert.deepEqual(await db.getAll('signingKeys'), []);
    await assert.rejects(signer.deleteKey(active.id), (err) => err instanceof SigningError && err.code === 'not_found');
    await assert.rejects(signer.exportPublicKey(active.id, 'pem'), (err) => err instanceof SigningError && err.code === 'not_found');
    const receipt = await exportReceipt(signer);
    assert.ok(receipt.signer && receipt.signer.keyId !== active.id && receipt.signer.keyId !== first.id);
  });

  it('stores "Sign exported receipts"; off, exports carry neither signer nor signature', async () => {
    const { db, reopen } = await freshDb();
    const signer = createReceiptSigner({ db: async () => db });
    assert.equal(await signer.setEnabled(false), true);
    assert.equal(signer.state().enabled, false);
    assert.equal((await db.get('settings', SIGN_SETTING))?.value, false);
    assert.equal(await signer.exportSigner(), null);
    const receipt = await exportReceipt(signer);
    assert.equal(receipt.signer, undefined);
    assert.equal(receipt.signature, undefined);
    assert.equal(signer.state().active, null, 'no key is made while signing is off');
    db.close();
    const reloaded = createReceiptSigner({ db: reopen });
    await reloaded.ready();
    assert.equal(reloaded.state().enabled, false);
  });

  it('falls back to ECDSA P-256 where WebCrypto has no Ed25519', async () => {
    const { db } = await freshDb();
    const subtle = globalThis.crypto.subtle;
    const noEd25519 = /** @type {Crypto} */ ({
      subtle: new Proxy(subtle, {
        get(target, prop) {
          if (prop === 'generateKey') {
            return (/** @type {any} */ alg, /** @type {boolean} */ extractable, /** @type {KeyUsage[]} */ usages) =>
              alg === 'Ed25519' || alg?.name === 'Ed25519' ? Promise.reject(new DOMException('Unrecognized name', 'NotSupportedError')) : target.generateKey(alg, extractable, usages);
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    const signer = createReceiptSigner({ db: async () => db, crypto: noEd25519 });
    const receipt = await exportReceipt(signer);
    assert.equal(receipt.signer?.alg, 'ES256');
    assert.equal(receipt.signature?.alg, 'ES256');
    const pem = (await signer.exportPublicKey(/** @type {string} */ (receipt.signer?.keyId), 'pem')).text;
    assert.deepEqual(await verifyReceiptSignature(receipt, pem), { status: 'valid', alg: 'ES256', keyId: receipt.signer?.keyId, trusted: true });
    const jwk = JSON.parse((await signer.exportPublicKey(/** @type {string} */ (receipt.signer?.keyId), 'jwk')).text);
    assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'kid', 'kty', 'use', 'x', 'y']);
  });

  it('is unavailable without WebCrypto, and keeps keys for the page only without a persistent database', async () => {
    const plain = createReceiptSigner({ crypto: /** @type {Crypto} */ ({}), db: async () => (await freshDb()).db });
    await plain.ready();
    assert.equal(plain.state().available, false);
    assert.equal(await plain.exportSigner(), null);
    await assert.rejects(plain.createKey(), (err) => err instanceof SigningError && err.code === 'unavailable');

    const memory = await openAppDb({ name: `signing-memory-${(seq += 1)}`, factory: null });
    assert.equal(memory.persistent, false);
    const pageOnly = createReceiptSigner({ db: async () => memory });
    await pageOnly.ready();
    assert.equal(pageOnly.state().persistent, false);
    assert.equal(await pageOnly.setEnabled(true), false, 'the choice holds for this page only');
    assert.ok((await exportReceipt(pageOnly)).signature, 'it still signs');

    const broken = createReceiptSigner({ db: async () => Promise.reject(new Error('blocked')) });
    await broken.ready();
    assert.equal(broken.state().persistent, false);
    assert.ok((await exportReceipt(broken)).signature, 'a key in memory still signs');
  });
});
