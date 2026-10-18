// @ts-check
// Text of a document, with the readers of @starpi/core: the PDF text layer (pdf.js, an optional
// peer dependency), Word, Excel and PowerPoint files (its own ZIP reader with limits on size, entry
// count and compression ratio), HTML pages, Markdown, CSV and JSON. The readers run in this
// process; the file is handed over under a name with the extension sniff.js decided, so a
// misnamed file is read as what it is. A failure becomes a short code the app can translate.
import { EXTRACTOR, extractText, ParseError } from '@starpi/core';
import { fail } from '../lib/errors.js';

export { EXTRACTOR };

/** Codes of a failed extraction, as the document list shows them. */
export const EXTRACT_FAILURES = Object.freeze(['too_large', 'empty', 'invalid_json', 'invalid_pdf', 'encrypted_pdf', 'pdf_reader', 'invalid_document', 'encrypted_document', 'zip_bomb', 'unsupported_type', 'no_text', 'reader_failed']);

/**
 * @param {Uint8Array} bytes
 * @param {import('./sniff.js').DocumentType} type
 * @returns {Promise<{ text: string, pages: number | null }>}
 */
export async function extractDocument(bytes, type) {
  const file = new File([new Uint8Array(bytes)], `document.${type}`);
  try {
    const result = await extractText(file);
    return { text: result.text, pages: result.pages ?? null };
  } catch (err) {
    const code = err instanceof ParseError ? (err.code === 'empty' ? 'no_text' : err.code) : isMissingReader(err) ? 'pdf_reader' : 'reader_failed';
    throw fail('document_unreadable', `the document could not be read (${code})`, { status: 422, details: { reason: code } });
  }
}

/** pdf.js is an optional peer dependency; without it a PDF cannot be read. @param {unknown} err */
function isMissingReader(err) {
  const code = /** @type {any} */ (err)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}
