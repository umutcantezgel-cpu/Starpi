import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extensionOf, extractText, flattenJson, jsonToText, normalizeText, ParseError, streamToText } from '../../src/js/rag/parser.js';
import { makePdf } from '../fixtures/pdf.mjs';

/** @param {BlobPart[]} parts @param {string} name */
const file = (parts, name) => new File(parts, name);

describe('text helpers', () => {
  it('detects extensions case-insensitively', () => {
    assert.equal(extensionOf('Report.PDF'), 'pdf');
    assert.equal(extensionOf('notes.tar.md'), 'md');
    assert.equal(extensionOf('README'), '');
  });

  it('normalizes BOM, line endings and control characters', () => {
    assert.equal(normalizeText('﻿a\r\nb\rc\u0000d\te'), 'a\nb\ncd\te');
  });

  it('flattens JSON into path: value lines in document order', () => {
    const lines = flattenJson({ project: { name: 'Alpha', budget: 120000, owners: ['Ana', 'Ben'] }, empty: '', none: null });
    assert.deepEqual(lines, ['project.name: Alpha', 'project.budget: 120000', 'project.owners[0]: Ana', 'project.owners[1]: Ben']);
  });

  it('rejects invalid JSON with a typed error', () => {
    assert.throws(() => jsonToText('{ nope'), (err) => err instanceof ParseError && err.code === 'invalid_json');
  });

  it('decodes UTF-8 streams even when a character is split across chunks', async () => {
    const bytes = new TextEncoder().encode('Grüße aus München');
    const split = 3; // inside the two-byte "ü"
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    assert.equal(await streamToText(stream), 'Grüße aus München');
  });
});

describe('extractText', () => {
  it('reads Markdown and plain text', async () => {
    const res = await extractText(file(['# Title\r\n\r\nBody text.'], 'notes.md'));
    assert.deepEqual(res, { text: '# Title\n\nBody text.', kind: 'md', pages: null });
  });

  it('reads JSON as flattened text', async () => {
    const res = await extractText(file([JSON.stringify({ launch: '2026-03-03', lead: 'Anna' })], 'data.json'));
    assert.equal(res.text, 'launch: 2026-03-03\nlead: Anna');
  });

  it('extracts text from a PDF with pdf.js', async () => {
    const pdf = makePdf(['Project Alpha launches on March 3.', 'Budget: 120000 EUR (approved)']);
    const pages = [];
    const res = await extractText(file([pdf], 'plan.pdf'), (page, total) => pages.push([page, total]));
    assert.equal(res.kind, 'pdf');
    assert.equal(res.pages, 1);
    assert.deepEqual(pages, [[1, 1]]);
    assert.match(res.text, /Project Alpha launches on March 3\./);
    assert.match(res.text, /Budget: 120000 EUR \(approved\)/);
  });

  it('reports unsupported, empty and broken files with error codes', async () => {
    await assert.rejects(extractText(file(['x'], 'image.png')), (err) => err instanceof ParseError && err.code === 'unsupported_type');
    await assert.rejects(extractText(file([' \n '], 'blank.txt')), (err) => err instanceof ParseError && err.code === 'empty');
    await assert.rejects(extractText(file(['%PDF-1.4 garbage'], 'broken.pdf')), (err) => err instanceof ParseError && err.code === 'invalid_pdf');
  });
});
