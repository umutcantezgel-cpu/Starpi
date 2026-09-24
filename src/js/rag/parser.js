// @ts-check
// Text extraction for the on-device workspace. Runs inside the ingestion worker; nothing is uploaded.
// Plain text is decoded from a Web Stream, JSON is flattened into "path: value" lines, and PDFs are
// read with pdf.js (loaded on first use, in-thread, without eval or font loading).

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARS = 5_000_000;
export const MAX_PDF_PAGES = 2_000;

/**
 * Identifies the extraction rules in answer receipts. Bump the version whenever the same file would
 * produce different text (tests/unit/golden.test.mjs pins the output); the pdf.js version is
 * recorded separately for PDFs.
 */
export const EXTRACTOR = Object.freeze({ id: 'starpi-extract', version: 1 });

export const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'log']);
export const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, 'json', 'pdf']);

/** @typedef {'unsupported_type' | 'too_large' | 'empty' | 'invalid_json' | 'invalid_pdf' | 'encrypted_pdf' | 'pdf_reader'} ParseErrorCode */

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
 * Splits CSV text into rows of fields (RFC 4180 quoting: "a ""b""", fields may contain the
 * delimiter and line breaks).
 * @param {string} text
 * @param {string} delimiter
 * @returns {string[][]}
 */
export function parseCsv(text, delimiter) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/**
 * Turns a CSV table with a header row into one "column: value; column: value" line per row, so
 * each line reads as a statement ("risk: …; rating: High; owner: …"). Files without a usable header
 * (numeric or duplicate column names, ragged rows) are kept as they are.
 * @param {string} text
 */
export function csvToText(text) {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const delimiter = [',', ';', '\t'].map((d) => /** @type {[string, number]} */ ([d, firstLine.split(d).length - 1])).sort((a, b) => b[1] - a[1])[0];
  if (delimiter[1] === 0) return text;
  const rows = parseCsv(text, delimiter[0]);
  if (rows.length < 2) return text;
  const header = rows[0].map((h) => h.trim());
  const usable =
    header.every((h) => h !== '' && !/^[\d.,\s-]+$/.test(h)) &&
    new Set(header.map((h) => h.toLowerCase())).size === header.length &&
    rows.every((r) => r.length === header.length);
  if (!usable) return text;
  return rows
    .slice(1)
    .map((r) =>
      r
        .map((v, i) => [header[i], v.replace(/\s+/g, ' ').trim()])
        .filter(([, v]) => v !== '')
        .map(([h, v]) => `${h}: ${v}`)
        .join('; '),
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * Decodes a UTF-8 byte stream incrementally (large files never exist as one byte array in JS).
 * @param {ReadableStream<Uint8Array>} stream
 */
export async function streamToText(stream) {
  const decoder = /** @type {TransformStream<Uint8Array, string>} */ (/** @type {unknown} */ (new TextDecoderStream('utf-8')));
  const reader = stream.pipeThrough(decoder).getReader();
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
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    .then(() => import('pdfjs-dist/legacy/build/pdf.mjs'))
    .catch((err) => {
      // Do not keep a failed download; the next PDF tries again.
      pdfjsPromise = null;
      throw new ParseError('pdf_reader', err instanceof Error ? err.message : 'The PDF reader could not be loaded');
    });
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
    return { text: out.join('\n\n'), pages, pdfjs: String(pdfjs.version ?? '') };
  } finally {
    await task.destroy();
  }
}

/**
 * Extracts plain text from a file.
 * @param {Blob & { name: string }} file
 * @param {(page: number, pages: number) => void} [onPage]
 * @returns {Promise<{ text: string, kind: string, pages: number | null, pdfjs: string | null }>}
 */
export async function extractText(file, onPage) {
  const ext = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.has(ext)) throw new ParseError('unsupported_type', 'Unsupported file type', { ext: ext || '?' });
  if (file.size > MAX_FILE_BYTES) {
    throw new ParseError('too_large', 'File is too large', { max: Math.round(MAX_FILE_BYTES / (1024 * 1024)) });
  }

  let text;
  let pages = null;
  /** @type {string | null} */
  let pdfjs = null;
  if (ext === 'pdf') {
    const result = await pdfToText(await file.arrayBuffer(), onPage);
    text = result.text;
    pages = result.pages;
    pdfjs = result.pdfjs;
  } else if (ext === 'json') {
    text = jsonToText(await streamToText(file.stream()));
  } else if (ext === 'csv') {
    text = csvToText(normalizeText(await streamToText(file.stream())));
  } else {
    text = await streamToText(file.stream());
  }
  text = normalizeText(text);
  if (!text.trim()) throw new ParseError('empty', 'No extractable text');
  return { text, kind: ext === 'markdown' ? 'md' : ext, pages, pdfjs };
}
