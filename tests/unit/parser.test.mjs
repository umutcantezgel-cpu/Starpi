import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodePdfString, extractPdfTextOperators, parseJsonDocument } from '../../src/js/rag/parser.js';

describe('client-side document parser', () => {
  it('parses structured JSON into readable key-value text', () => {
    const json = JSON.stringify({
      title: 'Quarterly Review',
      budget: 50000,
      lead: 'Dr. Jane Smith',
      tags: ['ai', 'webgpu'],
    });

    const parsed = parseJsonDocument(json);
    assert.ok(parsed.includes('title:'));
    assert.ok(parsed.includes('Quarterly Review'));
    assert.ok(parsed.includes('budget:'));
    assert.ok(parsed.includes('50000'));
    assert.ok(parsed.includes('Dr. Jane Smith'));
  });

  it('decodes PDF string escapes properly', () => {
    const raw = 'Hello\\nWorld\\t\\(Test\\)\\r';
    const decoded = decodePdfString(raw);
    assert.equal(decoded, 'Hello\nWorld\t(Test)\r');
  });

  it('extracts text from PDF BT ... ET operators (Tj and TJ)', () => {
    const pdfStream = `
      /F1 12 Tf
      BT
      (Confidential Enterprise Plan) Tj
      ET
      BT
      [(Project Alpha) 20 (Q4 Roadmap)] TJ
      ET
    `;

    const extracted = extractPdfTextOperators(pdfStream);
    assert.ok(extracted.includes('Confidential Enterprise Plan'));
    assert.ok(extracted.includes('Project Alpha'));
    assert.ok(extracted.includes('Q4 Roadmap'));
  });
});
