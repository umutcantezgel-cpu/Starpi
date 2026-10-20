// Extraction version 2 adds file formats without changing the text of the version 1 formats, so
// receipts written before it still verify; and passages cited from the new formats verify as well.
import './setup.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { buildReceipt, sha256Hex, validateReceipt, verifyReceipt } from '../../src/js/core/receipt.js';
import { CHUNKER, chunkText } from '../../src/js/rag/chunker.js';
import { EXTRACTOR, extractText } from '../../src/js/rag/parser.js';
import { makePdf } from '../fixtures/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (/** @type {string} */ rel) => new Uint8Array(readFileSync(path.join(ROOT, rel)));
const tools = {
  extractor: EXTRACTOR,
  extract: async (/** @type {Uint8Array} */ bytes, /** @type {string} */ name) => {
    const r = await extractText(new File([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)], name));
    return { text: r.text, pdfjs: r.pdfjs };
  },
};

/**
 * A receipt citing the first chunk of every file, with the extractor version given.
 * @param {Array<{ name: string, bytes: Uint8Array }>} files
 * @param {number} extractorVersion
 */
async function receiptOver(files, extractorVersion) {
  /** @type {Parameters<typeof buildReceipt>[0]['citations']} */
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
      document: { name, kind, bytes: bytes.length, fileSha256: await sha256Hex(bytes), textSha256: await sha256Hex(text), textChars: text.length, pages, extractor: { id: EXTRACTOR.id, version: extractorVersion, pdfjs }, chunker: { ...CHUNKER, size: 500, overlap: 50 } },
      chunk: { index: chunk.index, start: chunk.start, end: chunk.end },
    });
  }
  const answer = files.map((f) => `It is documented [Doc: ${f.name}, Chunk: 1].`).join(' ');
  const receipt = await buildReceipt({ createdAt: '2026-10-16T12:00:00.000Z', version: '2.1.0', answer: { text: answer, engine: 'cloud', locale: 'en' }, question: 'Where?', grounding: groundAnswer(blocksFromMarkdown(answer, sources), sources), citations });
  const parsed = validateReceipt(JSON.parse(JSON.stringify(receipt)));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error('invalid receipt');
  return parsed.receipt;
}

const LEGACY_FILES = [
  { name: 'nebula-plan.md', bytes: read('public/samples/en/nebula-plan.md') },
  { name: 'nebula-risks.csv', bytes: read('public/samples/en/nebula-risks.csv') },
  { name: 'nebula-kickoff.pdf', bytes: read('public/samples/en/nebula-kickoff.pdf') },
  { name: 'data.json', bytes: new TextEncoder().encode(JSON.stringify({ project: { budget: '480,000 EUR', owners: ['Ana', 'Ben'] } })) },
  { name: 'notes.txt', bytes: new TextEncoder().encode('Plain notes.\r\nSecond line.\n') },
  { name: 'fixture.pdf', bytes: makePdf(['Line one', 'Line two: 480000 EUR']) },
];

describe(`receipts and ${EXTRACTOR.id} ${EXTRACTOR.version}`, () => {
  it('is version 2', () => {
    assert.deepEqual(EXTRACTOR, { id: 'starpi-extract', version: 2 });
  });

  it('verifies receipts recorded with version 1: TXT, Markdown, CSV, JSON and PDF text is unchanged', async () => {
    const receipt = await receiptOver(LEGACY_FILES, 1);
    const report = await verifyReceipt(receipt, LEGACY_FILES, tools);
    assert.deepEqual(report.summary, { reproduced: LEGACY_FILES.length, verifiable: LEGACY_FILES.length });
    for (const c of report.citations) assert.deepEqual([c.file, c.text, c.passage, c.chunk], ['match', 'match', 'match', 'match'], c.label);
    assert.deepEqual(report.grounding?.differences, []);
    // The only note is that the rules were updated in between, not that anything differs.
    assert.ok(report.warnings.every((w) => /: extracted with starpi-extract 1( \(pdf\.js [^)]+\))?, verified with starpi-extract 2/.test(w)), report.warnings.join('\n'));
  });

  it('still verifies the receipt the released 1.3.0 code wrote, passage by passage', async () => {
    const raw = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/receipts/v1.3.0-receipt.json'), 'utf8'));
    const parsed = validateReceipt(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const files = [
      { name: 'nebula-plan.md', bytes: read('public/samples/en/nebula-plan.md') },
      { name: 'nebula-risks.csv', bytes: read('public/samples/en/nebula-risks.csv') },
    ];
    const report = await verifyReceipt(parsed.receipt, files, tools);
    assert.deepEqual(report.summary, { reproduced: 4, verifiable: 4 });
    assert.ok(report.citations.filter((c) => c.source === 'workspace').every((c) => c.text === 'match' && c.passage === 'match'));
  });

  it('verifies passages cited from DOCX, XLSX, PPTX and HTML files', async () => {
    const files = [
      { name: 'report.docx', bytes: read('tests/fixtures/formats/report.docx') },
      { name: 'budget.xlsx', bytes: read('tests/fixtures/formats/budget-lo.xlsx') },
      { name: 'status.pptx', bytes: read('tests/fixtures/formats/status.pptx') },
      { name: 'page.htm', bytes: new TextEncoder().encode('<h1>Page</h1><p>The garden opens at 9:00.</p>') },
    ];
    const receipt = await receiptOver(files, EXTRACTOR.version);
    assert.deepEqual(
      receipt.citations.map((c) => c.document?.kind),
      ['docx', 'xlsx', 'pptx', 'html'],
    );
    const report = await verifyReceipt(receipt, files, tools);
    assert.deepEqual(report.summary, { reproduced: 4, verifiable: 4 });
    assert.deepEqual(report.warnings, []);
    // A changed cell is caught.
    const edited = read('tests/fixtures/formats/budget-lo.xlsx');
    const other = { name: 'budget.xlsx', bytes: edited.map((b, i) => (i === edited.length - 30 ? b ^ 1 : b)) };
    const tampered = await verifyReceipt(receipt, [files[0], other, files[2], files[3]], tools);
    assert.equal(tampered.citations[1].file, 'missing');
  });
});
