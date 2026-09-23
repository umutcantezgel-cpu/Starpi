// @ts-check
// Text extraction for the on-device workspace. Runs inside the ingestion worker; nothing is uploaded.
// Plain text is decoded from a Web Stream, JSON is flattened into "path: value" lines, and PDFs are
// read with pdf.js (loaded on first use, in-thread, without eval or font loading).

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARS = 5_000_000;
export const MAX_PDF_PAGES = 2_000;

export const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'log']);
export const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, 'json', 'pdf']);

/** @typedef {'unsupported_type' | 'too_large' | 'empty' | 'invalid_json' | 'invalid_pdf' | 'encrypted_pdf'} ParseErrorCode */

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

/** @param {string} name */
export function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * Normalizes extracted text: strips a BOM, unifies line breaks and removes NUL/control characters
 * that would only add noise to the index. Tabs and newlines are kept.
 * @param {string} text
 */
export function normalizeText(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Flattens JSON into one "path: value" line per scalar, in document order.
 * @param {unknown} value
 * @param {string} [path]
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function flattenJson(value, path = '', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => flattenJson(item, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) flattenJson(child, path ? `${path}.${key}` : key, out);
  } else if (value !== null && value !== undefined && value !== '') {
    out.push(path ? `${path}: ${String(value)}` : String(value));
  }
  return out;
}

/** @param {string} raw */
export function jsonToText(raw) {
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ParseError('invalid_json', err instanceof Error ? err.message : 'Invalid JSON');
  }
  return flattenJson(data).join('\n');
}

/**
 * Decodes a UTF-8 byte stream incrementally (large files never exist as one byte array in JS).
 * @param {ReadableStream<Uint8Array>} stream
 */
export async function streamToText(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream('utf-8')).getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += value;
    if (text.length > MAX_TEXT_CHARS) {
      await reader.cancel();
      throw new ParseError('too_large', 'Extracted text is too long', { max: MAX_TEXT_CHARS });
    }
  }
  return text;
}

/** @type {Promise<typeof import('pdfjs-dist')> | null} */
let pdfjsPromise = null;

function loadPdfjs() {
  // The legacy build carries polyfills for the newest built-ins pdf.js uses (Map.getOrInsertComputed,
  // Math.sumPrecise, Promise.try, ...), so PDFs also parse in browsers older than the latest release;
  // the polyfills only exist in this worker. Importing the worker module first registers
  // globalThis.pdfjsWorker, so pdf.js parses in this thread instead of spawning another worker.
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.worker.mjs').then(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
  return pdfjsPromise;
}

/**
 * @param {ArrayBuffer} buffer
 * @param {(page: number, pages: number) => void} [onPage]
 */
export async function pdfToText(buffer, onPage) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'PasswordException') throw new ParseError('encrypted_pdf', 'The PDF is password protected');
    throw new ParseError('invalid_pdf', err instanceof Error ? err.message : 'Invalid PDF');
  }
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    /** @type {string[]} */
    const out = [];
    let length = 0;
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        pageText += item.str;
        if (item.hasEOL) pageText += '\n';
        else if (item.str && !/\s$/.test(item.str)) pageText += ' ';
      }
      page.cleanup();
      pageText = pageText.replace(/[ \t]+\n/g, '\n').trim();
      if (pageText) {
        out.push(pageText);
        length += pageText.length;
      }
      if (length > MAX_TEXT_CHARS) throw new ParseError('too_large', 'Extracted text is too long', { max: MAX_TEXT_CHARS });
      onPage?.(i, pages);
    }
    return { text: out.join('\n\n'), pages };
  } finally {
    await task.destroy();
  }
}

/**
 * Extracts plain text from a file.
 * @param {Blob & { name: string }} file
 * @param {(page: number, pages: number) => void} [onPage]
 * @returns {Promise<{ text: string, kind: string, pages: number | null }>}
 */
export async function extractText(file, onPage) {
  const ext = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.has(ext)) throw new ParseError('unsupported_type', 'Unsupported file type', { ext: ext || '?' });
  if (file.size > MAX_FILE_BYTES) {
    throw new ParseError('too_large', 'File is too large', { max: Math.round(MAX_FILE_BYTES / (1024 * 1024)) });
  }

  let text;
  let pages = null;
  if (ext === 'pdf') {
    const result = await pdfToText(await file.arrayBuffer(), onPage);
    text = result.text;
    pages = result.pages;
  } else if (ext === 'json') {
    text = jsonToText(await streamToText(file.stream()));
  } else {
    text = await streamToText(file.stream());
  }
  text = normalizeText(text);
  if (!text.trim()) throw new ParseError('empty', 'No extractable text');
  return { text, kind: ext === 'markdown' ? 'md' : ext, pages };
}
