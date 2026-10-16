// @ts-check
// The typed error of text extraction. It lives in its own module so the format readers and the
// parser that dispatches to them share one class without importing each other; parser.js re-exports it.

/**
 * @typedef {'unsupported_type' | 'too_large' | 'empty' | 'invalid_json' | 'invalid_pdf' | 'encrypted_pdf' | 'pdf_reader'
 *   | 'invalid_document' | 'encrypted_document' | 'zip_bomb' | 'needs_ocr'} ParseErrorCode
 */

export class ParseError extends Error {
  /**
   * @param {ParseErrorCode} code
   * @param {string} message
   * @param {Record<string, string | number>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    this.details = details ?? {};
  }
}
