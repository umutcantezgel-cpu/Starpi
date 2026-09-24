import './setup.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { buildReceipt, canonicalJson, RECEIPT_SCHEMA, sha256Hex, validateReceipt, verifyReceipt } from '../../src/js/core/receipt.js';
import { CHUNKER, chunkText } from '../../src/js/rag/chunker.js';
import { EXTRACTOR, extractText } from '../../src/js/rag/parser.js';
import { makePdf } from '../fixtures/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/verify-receipt.mjs');

const tools = {
  extractor: EXTRACTOR,
  extract: async (/** @type {Uint8Array} */ bytes, /** @type {string} */ name) => {
    const r = await extractText(new File([bytes], name));
    return { text: r.text, pdfjs: r.pdfjs };
  },
};

/**
 * A receipt for an answer about one file, built the way the app builds it.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {string} answer  may contain {label}
 */
async function receiptFor(bytes, name, answer) {
  const { text, pages, pdfjs } = await extractText(new File([bytes], name));
  const chunk = chunkText(text)[0];
  const label = `[Doc: ${name}, Chunk: 1]`;
  const answerText = answer.replaceAll('{label}', label);
  const sources = [{ label, doc: name, heading: '', text: chunk.text, delivered: /** @type {const} */ ('full') }];
  return buildReceipt({
    createdAt: '2026-09-24T01:00:00.000Z',
    version: '1.1.0',
    answer: { text: answerText, engine: 'cloud', locale: 'en' },
    question: 'When does the beta start?',
    grounding: groundAnswer(blocksFromMarkdown(answerText, sources), sources),
    citations: [
      {
        label,
        doc: name,
        heading: '',
        source: 'workspace',
        delivered: 'full',
        text: chunk.text,
        truncated: false,
        document: {
          name,
          kind: name.split('.').pop() ?? '',
          bytes: bytes.length,
          fileSha256: await sha256Hex(bytes),
          textSha256: await sha256Hex(text),
          textChars: text.length,
          pages,
          extractor: { ...EXTRACTOR, pdfjs },
          chunker: { ...CHUNKER, size: 500, overlap: 50 },
        },
        chunk: { index: 0, start: chunk.start, end: chunk.end },
      },
      { label: '[Doc: Handbook, Chunk: 1]', doc: 'Handbook', heading: 'Travel', source: 'knowledge', delivered: 'full', text: 'Trains are booked in second class.', truncated: false, documentId: 'kb-1' },
    ],
  });
}

const PDF = makePdf(['Kickoff notes', 'The beta starts at the Hamburg depot on 1 February 2027.', 'The steering group meets every Tuesday at 10:00.']);
const MD = new TextEncoder().encode('# Plan\n\nThe approved budget is 480,000 EUR.\n');

describe('receipt building', () => {
  it('hashes with SHA-256 over UTF-8 and serializes canonically', async () => {
    assert.equal(await sha256Hex('Größe'), createHash('sha256').update('Größe', 'utf8').digest('hex'));
    assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, 'ä': { z: 2, y: 1 } }), '{"a":[true,null,"x"],"b":1,"ä":{"y":1,"z":2}}');
    assert.throws(() => canonicalJson({ n: Number.NaN }));
  });

  it('records file and text fingerprints, offsets and verdicts, and an id over the rest', async () => {
    const r = await receiptFor(PDF, 'kickoff.pdf', 'The beta starts on 1 February 2027 {label}. The group meets every Friday {label}.');
    assert.equal(r.schema, RECEIPT_SCHEMA);
    assert.equal(r.citations[0].document?.fileSha256, createHash('sha256').update(PDF).digest('hex'));
    assert.equal(r.citations[0].verifiable, true);
    assert.equal(r.citations[1].verifiable, false);
    assert.deepEqual(r.grounding?.sentences.map((s) => s.verdict), ['supported', 'unsupported']);
    const { id, ...body } = r;
    assert.equal(id, await sha256Hex(canonicalJson(body)));
    assert.deepEqual(validateReceipt(JSON.parse(JSON.stringify(r))).ok, true);
  });

  it('leaves the question and excerpt texts out on request, keeping their fingerprints', async () => {
    const full = await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.');
    const { buildReceipt: build } = await import('../../src/js/core/receipt.js');
    assert.ok(full.question);
    const lean = await build(
      {
        createdAt: full.createdAt,
        version: '1.1.0',
        answer: { text: full.answer.text, engine: 'cloud', locale: 'en' },
        question: 'q',
        grounding: null,
        citations: [{ label: 'l', doc: 'd', heading: '', source: 'knowledge', delivered: 'full', text: 'excerpt', truncated: false }],
      },
      { includeQuestion: false, includeExcerpts: false },
    );
    assert.equal(lean.question, null);
    assert.equal(lean.citations[0].excerpt.text, null);
    assert.equal(lean.citations[0].excerpt.sha256, await sha256Hex('excerpt'));
  });
});

describe('validateReceipt', () => {
  it('rejects other schemas, bad hashes, out-of-range citation indexes and oversized text', async () => {
    const r = JSON.parse(JSON.stringify(await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.')));
    assert.deepEqual(validateReceipt({ schema: 'x' }), { ok: false, error: 'not_a_receipt', path: 'schema' });
    assert.deepEqual(validateReceipt({ ...r, schema: 'starpi.receipt/v2' }), { ok: false, error: 'unsupported_version', path: 'schema' });
    assert.equal(validateReceipt({ ...r, id: 'abc' }).ok, false);
    const badCite = structuredClone(r);
    badCite.grounding.sentences[0].cites = [9];
    assert.deepEqual(validateReceipt(badCite), { ok: false, error: 'citation indexes', path: 'grounding.sentences[0].cites' });
    const huge = structuredClone(r);
    huge.citations[0].excerpt.text = 'x'.repeat(30_000);
    assert.equal(validateReceipt(huge).ok, false);
    const negative = structuredClone(r);
    negative.citations[0].chunk.start = -1;
    assert.equal(validateReceipt(negative).ok, false);
  });
});

describe('verifyReceipt', () => {
  it('reproduces every workspace passage from the original files and recomputes the verdicts', async () => {
    const r = await receiptFor(PDF, 'kickoff.pdf', 'The beta starts on 1 February 2027 {label}. The group meets every Friday {label}.');
    const report = await verifyReceipt(r, [{ name: 'renamed.pdf', bytes: PDF }], tools);
    assert.equal(report.idMatches, true);
    assert.equal(report.answerMatches, true);
    assert.deepEqual(report.citations.map((c) => [c.file, c.text, c.passage, c.chunk]), [
      ['match', 'match', 'match', 'match'],
      ['not_verifiable', null, null, null],
    ]);
    assert.deepEqual(report.summary, { reproduced: 1, verifiable: 1 });
    assert.deepEqual(report.grounding?.differences, []);
  });

  it('reports a missing or modified file', async () => {
    const r = await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.');
    const changed = new TextEncoder().encode('# Plan\n\nThe approved budget is 520,000 EUR.\n');
    const report = await verifyReceipt(r, [{ name: 'plan.md', bytes: changed }], tools);
    assert.equal(report.citations[0].file, 'missing');
    assert.deepEqual(report.summary, { reproduced: 0, verifiable: 1 });
  });

  it('detects an edited receipt: answer, excerpt and id', async () => {
    const r = await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.');
    const edited = structuredClone(r);
    edited.answer.text = edited.answer.text.replace('480,000', '520,000');
    edited.citations[0].excerpt.text = edited.citations[0].excerpt.text?.replace('480,000', '520,000') ?? null;
    const report = await verifyReceipt(edited, [{ name: 'plan.md', bytes: MD }], tools);
    assert.equal(report.idMatches, false);
    assert.equal(report.answerMatches, false);
    assert.equal(report.citations[0].excerptConsistent, false);
    assert.equal(report.citations[0].passage, 'match', 'the file passage itself is still genuine');
  });

  it('keeps passages verifiable when the chunking rules change', async () => {
    const r = structuredClone(await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.'));
    const doc = /** @type {NonNullable<typeof r.citations[0]['document']>} */ (r.citations[0].document);
    doc.chunker = { ...doc.chunker, version: 0, size: 10, overlap: 2 };
    const report = await verifyReceipt(r, [{ name: 'plan.md', bytes: MD }], tools);
    assert.equal(report.citations[0].passage, 'match');
    assert.equal(report.citations[0].chunk, 'version_differs');
  });
});

describe('scripts/verify-receipt.mjs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'starpi-receipt-'));
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  it('exits 0 when every passage is reproduced, 1 on a mismatch and 2 on invalid input', async () => {
    const r = await receiptFor(PDF, 'kickoff.pdf', 'The beta starts on 1 February 2027 {label}.');
    const receiptPath = path.join(dir, 'receipt.json');
    const pdfPath = path.join(dir, 'kickoff.pdf');
    writeFileSync(receiptPath, JSON.stringify(r));
    writeFileSync(pdfPath, PDF);

    const ok = run([receiptPath, pdfPath, '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    const json = JSON.parse(ok.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.summary.reproduced, 1);

    const missing = run([receiptPath]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /0\/1 workspace excerpts reproduced/);

    writeFileSync(path.join(dir, 'bad.json'), '{"schema":"other"}');
    assert.equal(run([path.join(dir, 'bad.json')]).status, 2);
    assert.equal(run([]).status, 2);
    assert.ok(readFileSync(receiptPath, 'utf8').includes(RECEIPT_SCHEMA));
  });
});
