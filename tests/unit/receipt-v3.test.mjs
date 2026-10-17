// Receipts v3: the default format. The signer named inside the id, the gate, second opinions and
// relations as recorded, OCR provenance per file, extraction rules that give the same text, and
// receipts of the earlier formats that still validate and verify (in code and on the command line).
import './setup.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { canonicalJson } from '../../src/js/core/hash.js';
import {
  buildReceipt,
  RECEIPT_SCHEMA,
  RECEIPT_SCHEMA_V1,
  RECEIPT_SCHEMA_V2,
  RECEIPT_SCHEMAS,
  sha256Hex,
  signReceipt,
  validateReceipt,
  verifyReceipt,
  verifyReceiptSignature,
} from '../../src/js/core/receipt.js';
import { publicKeyId, signHead } from '../../src/js/core/signature.js';
import { CHUNKER, chunkText } from '../../src/js/rag/chunker.js';
import { EXTRACTOR, EXTRACTOR_COMPATIBLE, extractText } from '../../src/js/rag/parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/verify-receipt.mjs');
const read = (/** @type {string} */ rel) => new Uint8Array(readFileSync(path.join(ROOT, rel)));

/** @param {boolean} [compatible] */
const toolsWith = (compatible = true) => ({
  extractor: EXTRACTOR,
  ...(compatible ? { compatible: EXTRACTOR_COMPATIBLE } : {}),
  extract: async (/** @type {Uint8Array} */ bytes, /** @type {string} */ name) => {
    const r = await extractText(new File([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)], name));
    return { text: r.text, pdfjs: r.pdfjs };
  },
});
const tools = toolsWith();

const PLAN = { name: 'nebula-plan.md', bytes: read('public/samples/en/nebula-plan.md') };
const RISKS = { name: 'nebula-risks.csv', bytes: read('public/samples/en/nebula-risks.csv') };
// A PNG header (8-byte signature, IHDR of a 2 x 1 image): enough to have a fingerprint.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
const OCR_TEXT = 'Opening hours: the garden opens at 9:00 on weekdays.';

/** @typedef {Parameters<typeof buildReceipt>[0]} Draft */

/**
 * A draft over the first chunk of each file, with the extractor version given, plus a cited image
 * whose text came from OCR when `ocr` is set.
 * @param {Array<{ name: string, bytes: Uint8Array }>} files
 * @param {{ extractorVersion?: number, ocr?: boolean, extra?: Partial<Draft> }} [opts]
 * @returns {Promise<Draft>}
 */
async function draftOver(files, opts = {}) {
  /** @type {Draft['citations']} */
  const citations = [];
  /** @type {Array<{ label: string, doc: string, heading: string, text: string, delivered: 'full' }>} */
  const sources = [];
  for (const { name, bytes } of files) {
    const { text, kind, pages, pdfjs } = await extractText(new File([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)], name));
    const [chunk] = chunkText(text);
    const label = `[Doc: ${name}, Chunk: 1]`;
    sources.push({ label, doc: name, heading: '', text: chunk.text, delivered: 'full' });
    citations.push({
      label,
      doc: name,
      heading: '',
      source: 'workspace',
      delivered: 'full',
      text: chunk.text,
      truncated: false,
      document: { name, kind, bytes: bytes.length, fileSha256: await sha256Hex(bytes), textSha256: await sha256Hex(text), textChars: text.length, pages, extractor: { id: EXTRACTOR.id, version: opts.extractorVersion ?? EXTRACTOR.version, pdfjs }, chunker: { ...CHUNKER, size: 500, overlap: 50 } },
      chunk: { index: chunk.index, start: chunk.start, end: chunk.end },
    });
  }
  if (opts.ocr) {
    const label = '[Doc: sign.png, Chunk: 1]';
    sources.push({ label, doc: 'sign.png', heading: '', text: OCR_TEXT, delivered: 'full' });
    citations.push({
      label,
      doc: 'sign.png',
      heading: '',
      source: 'workspace',
      delivered: 'full',
      text: OCR_TEXT,
      truncated: false,
      document: { name: 'sign.png', kind: 'png', bytes: PNG.length, fileSha256: await sha256Hex(PNG), textSha256: await sha256Hex(OCR_TEXT), textChars: OCR_TEXT.length, pages: null, extractor: { ...EXTRACTOR, pdfjs: null, ocr: { provider: 'example-provider', model: 'example-vision-1' } }, chunker: { ...CHUNKER, size: 500, overlap: 50 } },
      chunk: { index: 0, start: 0, end: OCR_TEXT.length },
    });
  }
  const answer = [
    files.length ? `The approved budget for Project Nebula is 480,000 EUR [Doc: ${files[0].name}, Chunk: 1].` : '',
    opts.ocr ? 'The garden opens at 9:00 [Doc: sign.png, Chunk: 1].' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { createdAt: '2026-10-17T08:00:00.000Z', version: '3.0.0', answer: { text: answer, engine: 'cloud', locale: 'en' }, question: 'Budget?', grounding: groundAnswer(blocksFromMarkdown(answer, sources), sources), citations, ...opts.extra };
}

/** @param {AlgorithmIdentifier | EcKeyGenParams} [params] */
const keyPair = async (params = { name: 'Ed25519' }) => /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(params, false, ['sign', 'verify']));

/** @param {CryptoKey} key */
const pemOf = async (key) => {
  const der = Buffer.from(await crypto.subtle.exportKey('spki', key)).toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----\n`;
};

/**
 * A signed v3 receipt naming its signer, as the app exports it.
 * @param {Draft} draft
 * @param {CryptoKeyPair} keys
 */
async function signedV3(draft, keys) {
  const alg = keys.publicKey.algorithm.name === 'Ed25519' ? 'Ed25519' : 'ES256';
  const receipt = await buildReceipt(draft, { signer: { keyId: await publicKeyId(keys.publicKey), alg } });
  return signReceipt(receipt, keys.privateKey, { publicKey: keys.publicKey });
}

/** A JSON round trip through validateReceipt, as a verifier reads a file. @param {unknown} value */
function parsed(value) {
  const result = validateReceipt(JSON.parse(JSON.stringify(value)));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('invalid');
  return result.receipt;
}

describe('receipts v3: format', () => {
  it('is the default, reads every earlier format, and puts the signer next to the generator', async () => {
    assert.equal(RECEIPT_SCHEMA, 'starpi.receipt/v3');
    assert.deepEqual(RECEIPT_SCHEMAS, [RECEIPT_SCHEMA_V1, RECEIPT_SCHEMA_V2, RECEIPT_SCHEMA]);
    const keys = await keyPair();
    const keyId = await publicKeyId(keys.publicKey);
    const r = await buildReceipt(await draftOver([PLAN]), { signer: { keyId, alg: 'Ed25519' } });
    assert.equal(r.schema, RECEIPT_SCHEMA);
    assert.deepEqual(Object.keys(r).slice(0, 5), ['schema', 'id', 'createdAt', 'generator', 'signer']);
    assert.deepEqual(r.signer, { keyId, alg: 'Ed25519' });
    assert.equal(r.merkle?.size, 1);
    // The id covers the signer (and everything but itself and a signature).
    const { id, ...body } = r;
    assert.equal(id, await sha256Hex(canonicalJson(body)));
    assert.notEqual(id, (await buildReceipt(await draftOver([PLAN]))).id);
    parsed(r);
  });

  it('records the gate, second opinions and relations, and the verifier reports them as recorded', async () => {
    const extra = {
      gate: /** @type {const} */ ({ mode: 'sources', released: 1, withheld: 2 }),
      secondOpinion: [{ sentence: 0, cites: [0], engine: /** @type {const} */ ('nli'), model: 'example-nli-small', result: /** @type {const} */ ('contradicted') }],
      relations: [{ kind: /** @type {const} */ ('comparative'), sentences: [0], cites: [0], verdict: /** @type {const} */ ('inverted'), text: 'higher than' }],
    };
    const r = parsed(await buildReceipt(await draftOver([PLAN], { extra })));
    assert.deepEqual(r.gate, extra.gate);
    assert.deepEqual(r.secondOpinion, extra.secondOpinion);
    assert.deepEqual(r.relations, extra.relations);
    const report = await verifyReceipt(r, [PLAN], tools);
    assert.deepEqual(report.gate, extra.gate);
    assert.deepEqual(report.advisory, { secondOpinions: 1, contradicted: 1, relations: 1, flagged: 1 });
    assert.deepEqual(report.summary, { reproduced: 1, verifiable: 1 });
    // A second opinion never changes the recorded verdict, and the verdict is recomputed as before.
    assert.deepEqual(report.grounding?.differences, []);
    // Empty lists and no gate leave the members out.
    const plain = await buildReceipt(await draftOver([PLAN], { extra: { gate: null, secondOpinion: [], relations: [] } }));
    assert.ok(!('gate' in plain) && !('secondOpinion' in plain) && !('relations' in plain));
    const plainReport = await verifyReceipt(plain, [PLAN], tools);
    assert.equal(plainReport.gate, null);
    assert.deepEqual(plainReport.advisory, { secondOpinions: 0, contradicted: 0, relations: 0, flagged: 0 });
  });

  it('refuses malformed v3 members, and v3 members in v2 and v1 receipts', async () => {
    const keys = await keyPair();
    const extra = { gate: /** @type {const} */ ({ mode: 'web', released: 0, withheld: 1 }), secondOpinion: [{ sentence: 0, cites: [0], engine: /** @type {const} */ ('judge'), model: 'm', result: /** @type {const} */ ('neutral') }], relations: [{ kind: /** @type {const} */ ('temporal'), sentences: [0, 0], cites: [], verdict: /** @type {const} */ ('supported'), text: 'before' }] };
    const base = JSON.parse(JSON.stringify(await signedV3(await draftOver([PLAN], { extra, ocr: true }), keys)));
    const fails = (/** @type {(r: any) => void} */ edit, /** @type {any} */ from = base) => {
      const r = structuredClone(from);
      edit(r);
      return validateReceipt(r);
    };
    assert.equal(validateReceipt(base).ok, true);
    assert.deepEqual(fails((r) => (r.signer.alg = 'RS256')), { ok: false, error: 'one of Ed25519|ES256', path: 'signer.alg' });
    assert.deepEqual(fails((r) => (r.signer.keyId = 'abc')), { ok: false, error: 'sha256', path: 'signer.keyId' });
    assert.deepEqual(fails((r) => (r.signer.publicKey = {})), { ok: false, error: 'unknown member', path: 'signer.publicKey' });
    assert.deepEqual(fails((r) => (r.gate.mode = 'strict')), { ok: false, error: 'one of sources|web|free', path: 'gate.mode' });
    assert.deepEqual(fails((r) => (r.gate.released = -1)), { ok: false, error: 'integer', path: 'gate.released' });
    assert.deepEqual(fails((r) => (r.secondOpinion[0].sentence = 5)), { ok: false, error: 'statement index', path: 'secondOpinion[0].sentence' });
    assert.deepEqual(fails((r) => (r.secondOpinion[0].cites = [7])), { ok: false, error: 'citation indexes', path: 'secondOpinion[0].cites' });
    assert.deepEqual(fails((r) => (r.secondOpinion[0].result = 'supported')), { ok: false, error: 'one of entailed|neutral|contradicted', path: 'secondOpinion[0].result' });
    assert.deepEqual(fails((r) => (r.secondOpinion[0].model = 'x'.repeat(101))), { ok: false, error: 'string', path: 'secondOpinion[0].model' });
    assert.deepEqual(fails((r) => (r.relations[0].sentences = [])), { ok: false, error: 'one or two statement indexes', path: 'relations[0].sentences' });
    assert.deepEqual(fails((r) => (r.relations[0].sentences = [0, 0, 0])), { ok: false, error: 'one or two statement indexes', path: 'relations[0].sentences' });
    assert.deepEqual(fails((r) => (r.relations[0].verdict = 'contradicted')), { ok: false, error: 'one of supported|inverted|unsupported', path: 'relations[0].verdict' });
    assert.deepEqual(fails((r) => (r.relations[0].note = 'x')), { ok: false, error: 'unknown member', path: 'relations[0].note' });
    assert.deepEqual(fails((r) => (r.relations = 'none')), { ok: false, error: 'array', path: 'relations' });
    assert.deepEqual(fails((r) => (r.citations[1].document.extractor.ocr.engine = 'x')), { ok: false, error: 'unknown member', path: 'citations[1].document.extractor.ocr.engine' });
    assert.deepEqual(fails((r) => (r.citations[1].document.extractor.ocr = 'yes')), { ok: false, error: 'object', path: 'citations[1].document.extractor.ocr' });
    // Without a grounding record there are no statements to point at.
    assert.deepEqual(fails((r) => (r.grounding = null)), { ok: false, error: 'statement index', path: 'secondOpinion[0].sentence' });
    // The v2 and v1 allowlists do not have the v3 members.
    const v2 = JSON.parse(JSON.stringify(await buildReceipt(await draftOver([PLAN]), { schema: RECEIPT_SCHEMA_V2 })));
    const v1 = JSON.parse(JSON.stringify(await buildReceipt(await draftOver([PLAN]), { schema: RECEIPT_SCHEMA_V1 })));
    for (const [member, value] of Object.entries({ signer: base.signer, gate: base.gate, secondOpinion: base.secondOpinion, relations: base.relations })) {
      assert.deepEqual(fails((r) => (r[member] = value), v2), { ok: false, error: 'unknown member', path: member });
      assert.deepEqual(fails((r) => (r[member] = value), v1), { ok: false, error: 'unknown member', path: member });
    }
    assert.deepEqual(fails((r) => (r.citations[0].document.extractor.ocr = { provider: 'p', model: 'm' }), v2), { ok: false, error: 'unknown member', path: 'citations[0].document.extractor.ocr' });
  });

  it('will not write v3 content in an older format', async () => {
    const keys = await keyPair();
    const signer = { keyId: await publicKeyId(keys.publicKey), alg: /** @type {const} */ ('Ed25519') };
    for (const schema of [RECEIPT_SCHEMA_V2, RECEIPT_SCHEMA_V1]) {
      await assert.rejects(buildReceipt(await draftOver([PLAN]), { schema, signer }), /signer needs starpi\.receipt\/v3/);
      await assert.rejects(buildReceipt(await draftOver([PLAN], { extra: { gate: { mode: 'free', released: 1, withheld: 0 } } }), { schema }), /gate needs/);
      await assert.rejects(buildReceipt(await draftOver([PLAN], { ocr: true }), { schema }), /OCR text needs/);
    }
    // @ts-expect-error -- an unknown format is refused
    await assert.rejects(buildReceipt(await draftOver([PLAN]), { schema: 'starpi.receipt/v4' }), /unknown schema/);
  });
});

describe('receipts v3: the named signer', () => {
  for (const params of [{ name: 'Ed25519' }, { name: 'ECDSA', namedCurve: 'P-256' }]) {
    it(`verifies a receipt signed by the key it names (${params.name}), trusted only with that public key`, async () => {
      const keys = await keyPair(params);
      const r = parsed(await signedV3(await draftOver([PLAN, RISKS]), keys));
      const alg = params.name === 'Ed25519' ? 'Ed25519' : 'ES256';
      assert.equal(r.signature?.keyId, r.signer?.keyId);
      assert.deepEqual(await verifyReceiptSignature(r), { status: 'valid', alg, keyId: r.signer?.keyId, trusted: false });
      assert.deepEqual(await verifyReceiptSignature(r, await pemOf(keys.publicKey)), { status: 'valid', alg, keyId: r.signer?.keyId, trusted: true });
      const report = await verifyReceipt(r, [PLAN, RISKS], tools, { publicKey: keys.publicKey });
      assert.deepEqual(report.signer, r.signer);
      assert.equal(report.signature?.trusted, true);
      assert.deepEqual(report.summary, { reproduced: 2, verifiable: 2 });
      assert.deepEqual(report.warnings, []);
    });
  }

  it('detects a removed signature and a signature by another key', async () => {
    const keys = await keyPair();
    const other = await keyPair();
    const signed = await signedV3(await draftOver([PLAN]), keys);
    const stripped = structuredClone(signed);
    delete stripped.signature;
    assert.deepEqual(await verifyReceiptSignature(parsed(stripped)), { status: 'missing', alg: 'Ed25519', keyId: signed.signer?.keyId, trusted: false });
    // signReceipt will not sign with another key than the named one...
    await assert.rejects(signReceipt(stripped, other.privateKey, { publicKey: other.publicKey }), /names another signer key/);
    // ...and a signature made by hand with that key over the same head does not count either.
    const forged = { ...stripped, signature: await signHead({ id: stripped.id, merkle: stripped.merkle }, other.privateKey, other.publicKey) };
    assert.equal((await verifyReceiptSignature(parsed(forged))).status, 'invalid');
    // Removing the signer as well changes the id: the receipt no longer matches itself.
    const unnamed = structuredClone(forged);
    delete unnamed.signer;
    const check = await verifyReceiptSignature(parsed(unnamed));
    assert.equal(check.status, 'invalid');
    assert.equal((await verifyReceipt(parsed(unnamed), [PLAN], tools)).idMatches, false);
    // A v3 receipt without a signer may be signed by anyone, as in v2.
    const free = await signReceipt(await buildReceipt(await draftOver([PLAN])), other.privateKey, { publicKey: other.publicKey });
    assert.equal((await verifyReceiptSignature(parsed(free))).status, 'valid');
    assert.equal((await verifyReceiptSignature(parsed({ ...free, signature: undefined }))).status, 'unsigned');
  });
});

describe('receipts v3: OCR text', () => {
  it('records where OCR text came from, checks only the image fingerprint and does not count it as reproduced', async () => {
    const r = parsed(await buildReceipt(await draftOver([PLAN], { ocr: true })));
    const image = r.citations[1];
    assert.deepEqual(image.document?.extractor.ocr, { provider: 'example-provider', model: 'example-vision-1' });
    assert.equal(image.verifiable, false);
    assert.equal(r.citations[0].verifiable, true);
    let extracted = 0;
    const counting = { ...tools, extract: async (/** @type {Uint8Array} */ b, /** @type {string} */ n) => (extracted++, tools.extract(b, n)) };
    const report = await verifyReceipt(r, [PLAN, { name: 'renamed.png', bytes: PNG }], counting);
    assert.equal(extracted, 1, 'the image is not extracted again');
    assert.deepEqual([report.citations[1].file, report.citations[1].text, report.citations[1].passage, report.citations[1].chunk], ['match', 'ocr', null, null]);
    assert.deepEqual(report.summary, { reproduced: 1, verifiable: 1 });
    assert.deepEqual(report.warnings, ['renamed.png: text recognised by OCR (example-provider, example-vision-1); it cannot be extracted again, only the file fingerprint was checked']);
    // The statement citing the OCR text is recomputed on the excerpt recorded in the receipt.
    assert.deepEqual(report.grounding?.differences, []);
    const missing = await verifyReceipt(r, [PLAN], tools);
    assert.equal(missing.citations[1].file, 'missing');
  });
});

describe('extraction rules that give the same text', () => {
  const legacy = [PLAN, RISKS, { name: 'data.json', bytes: new TextEncoder().encode(JSON.stringify({ budget: '480,000 EUR' })) }, { name: 'notes.txt', bytes: new TextEncoder().encode('Plain notes.\r\nSecond line.\n') }];

  it('verify a version 1 text without a note when it matches, and note other rules once per file', async () => {
    const draft = await draftOver(legacy, { extractorVersion: 1 });
    // Two citations of the same file: still one note per file.
    draft.citations.push({ ...draft.citations[0], label: '[Doc: nebula-plan.md, Chunk: 1] (again)' });
    const r = await buildReceipt(draft);
    const quiet = await verifyReceipt(r, legacy, tools);
    assert.deepEqual(quiet.warnings, []);
    assert.ok(quiet.citations.every((c) => c.text === 'match' && c.passage === 'match'));
    const noisy = await verifyReceipt(r, legacy, toolsWith(false));
    assert.equal(noisy.warnings.length, legacy.length);
    assert.ok(noisy.warnings.every((w) => /: extracted with starpi-extract 1, verified with starpi-extract 2$/.test(w)), noisy.warnings.join('\n'));
  });

  it('keep the note for a kind version 1 did not read, and call a different text a mismatch under compatible rules', async () => {
    const docx = { name: 'report.docx', bytes: read('tests/fixtures/formats/report.docx') };
    const r = await buildReceipt(await draftOver([docx, PLAN], { extractorVersion: 1 }));
    const report = await verifyReceipt(r, [docx, PLAN], tools);
    assert.deepEqual(report.warnings, ['report.docx: extracted with starpi-extract 1, verified with starpi-extract 2']);
    const changed = structuredClone(r);
    const doc = /** @type {NonNullable<typeof changed.citations[0]['document']>} */ (changed.citations[1].document);
    doc.textSha256 = '0'.repeat(64);
    assert.equal((await verifyReceipt(changed, [docx, PLAN], tools)).citations[1].text, 'mismatch');
    assert.equal((await verifyReceipt(changed, [docx, PLAN], toolsWith(false))).citations[1].text, 'version_differs');
  });

  it('cover exactly the kinds whose text version 2 left unchanged', () => {
    assert.deepEqual(Object.keys(EXTRACTOR_COMPATIBLE), ['1']);
    assert.deepEqual([...EXTRACTOR_COMPATIBLE[1]].sort(), ['csv', 'json', 'log', 'md', 'pdf', 'txt']);
  });
});

describe('receipts of the earlier formats', () => {
  it('the 1.3.0 receipt (v1) verifies passage by passage, now without notes', async () => {
    const r = parsed(JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/receipts/v1.3.0-receipt.json'), 'utf8')));
    const report = await verifyReceipt(r, [PLAN, RISKS], tools);
    assert.deepEqual(report.summary, { reproduced: 4, verifiable: 4 });
    assert.deepEqual(report.warnings, []);
    assert.equal(report.signature, null);
    assert.equal(report.signer, null);
  });

  it('a signed v2 receipt written before v3 verifies, trusted with its public key', async () => {
    const r = parsed(JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/receipts/v2.1-signed-receipt.json'), 'utf8')));
    assert.equal(r.schema, RECEIPT_SCHEMA_V2);
    const pem = readFileSync(path.join(ROOT, 'tests/fixtures/receipts/v2.1-signer.pem'), 'utf8');
    const report = await verifyReceipt(r, [PLAN, RISKS], tools, { publicKey: pem });
    assert.equal(report.idMatches, true);
    assert.deepEqual(report.merkle, { size: 4, rootMatches: true, validProofs: 4 });
    assert.deepEqual(report.signature, { status: 'valid', alg: 'Ed25519', keyId: r.signature?.keyId, trusted: true });
    assert.deepEqual(report.summary, { reproduced: 4, verifiable: 4 });
    assert.deepEqual(report.grounding?.differences, []);
    assert.equal(report.signer, null);
  });
});

describe('scripts/verify-receipt.mjs with v3 receipts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'starpi-receipt-v3-'));
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const write = (/** @type {string} */ name, /** @type {string | Uint8Array} */ data) => {
    const p = path.join(dir, name);
    writeFileSync(p, data);
    return p;
  };
  const files = [write(PLAN.name, PLAN.bytes), write(RISKS.name, RISKS.bytes)];

  it('verifies an exported receipt with --public-key --require-signature, and fails what is not signed by that key', async () => {
    const keys = await keyPair();
    const extra = { gate: /** @type {const} */ ({ mode: 'sources', released: 2, withheld: 1 }), relations: [{ kind: /** @type {const} */ ('reference'), sentences: [0], cites: [0], verdict: /** @type {const} */ ('supported'), text: 'it' }] };
    const signed = await signedV3(await draftOver([PLAN, RISKS], { extra }), keys);
    const receiptPath = write('signed.json', JSON.stringify(signed));
    const keyPath = write('device.pem', await pemOf(keys.publicKey));

    const ok = run([receiptPath, ...files, '--public-key', keyPath, '--require-signature']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /n\/a {2}names its signer: Ed25519, key [0-9a-f]{16}…/);
    assert.match(ok.stdout, /ok {3}signature valid \(Ed25519, key [0-9a-f]{16}…, the public key you gave\)/);
    assert.match(ok.stdout, /sentence gate \(sources mode, as recorded\): 2 released, 1 withheld/);
    assert.match(ok.stdout, /relations between statements recorded: 1, 0 inverted or unsupported/);
    assert.doesNotMatch(ok.stdout, /warn/);
    const json = JSON.parse(run([receiptPath, ...files, '--public-key', keyPath, '--require-signature', '--json']).stdout);
    assert.equal(json.ok, true);
    assert.equal(json.schema, RECEIPT_SCHEMA);
    assert.deepEqual(json.signer, signed.signer);
    assert.deepEqual(json.signature, { status: 'valid', alg: 'Ed25519', keyId: signed.signer?.keyId, trusted: true });

    // Without a key the embedded one is used; --require-signature accepts that.
    assert.equal(run([receiptPath, ...files, '--require-signature']).status, 0);
    const other = await keyPair();
    const otherPath = write('other.pem', await pemOf(other.publicKey));
    assert.equal(run([receiptPath, ...files, '--public-key', otherPath, '--require-signature']).status, 1);

    const stripped = structuredClone(signed);
    delete stripped.signature;
    const strippedPath = write('stripped.json', JSON.stringify(stripped));
    const removed = run([strippedPath, ...files]);
    assert.equal(removed.status, 1, 'a named signer without a signature fails even without --require-signature');
    assert.match(removed.stdout, /FAIL the receipt names signer key [0-9a-f]{16}…, but its signature was removed/);

    const unsignedPath = write('unsigned.json', JSON.stringify(await buildReceipt(await draftOver([PLAN, RISKS]))));
    assert.equal(run([unsignedPath, ...files]).status, 0);
    const required = run([unsignedPath, ...files, '--require-signature']);
    assert.equal(required.status, 1);
    assert.match(required.stdout, /FAIL not signed, but a signature is required/);
    const v1 = run([path.join(ROOT, 'tests/fixtures/receipts/v1.3.0-receipt.json'), ...files, '--require-signature']);
    assert.equal(v1.status, 1);
    assert.match(v1.stdout, /FAIL receipt format v1: no Merkle tree, not signed, but a signature is required/);
  });

  it('passes OCR text on its file fingerprint, and still verifies the v1 and v2 fixtures', async () => {
    const receiptPath = write('ocr.json', JSON.stringify(await buildReceipt(await draftOver([PLAN], { ocr: true }))));
    const image = write('sign.png', PNG);
    const ok = run([receiptPath, files[0], image]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /n\/a {2}\[Doc: sign\.png, Chunk: 1\]: file match \(sign\.png\), text from OCR, not extracted again/);
    assert.match(ok.stdout, /warn sign\.png: text recognised by OCR/);
    assert.equal(run([receiptPath, files[0]]).status, 1, 'the image itself must be given');

    const v2 = run([path.join(ROOT, 'tests/fixtures/receipts/v2.1-signed-receipt.json'), ...files, '--public-key', path.join(ROOT, 'tests/fixtures/receipts/v2.1-signer.pem'), '--require-signature']);
    assert.equal(v2.status, 0, v2.stdout + v2.stderr);
    assert.match(v2.stdout, /4\/4 workspace excerpts reproduced/);
    const v1 = run([path.join(ROOT, 'tests/fixtures/receipts/v1.3.0-receipt.json'), ...files]);
    assert.equal(v1.status, 0, v1.stdout + v1.stderr);
    assert.doesNotMatch(v1.stdout, /warn/, 'version 1 text of Markdown and CSV gives no note');
  });
});
