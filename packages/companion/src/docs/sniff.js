// @ts-check
// What kind of file an upload is, decided by its bytes and its name together, never by the media
// type the client claims:
//   - `%PDF-` within the first kilobyte                          -> pdf
//   - a ZIP container named .docx, .xlsx or .pptx                 -> that office format
//   - any other container, image, archive or program signature    -> refused (images need text
//     recognition, which the companion does not do)
//   - otherwise text: strict UTF-8 without NUL bytes; the name's extension picks md, csv, json,
//     html (also when the text starts like an HTML page) or txt.
import { fail } from '../lib/errors.js';

/** The kinds of document the companion reads. */
export const DOCUMENT_TYPES = Object.freeze(['pdf', 'docx', 'xlsx', 'pptx', 'html', 'md', 'csv', 'json', 'txt']);

/** @typedef {'pdf' | 'docx' | 'xlsx' | 'pptx' | 'html' | 'md' | 'csv' | 'json' | 'txt'} DocumentType */

const PDF_WINDOW = 1024;
const TEXT_PROBE = 64 * 1024;

/** Signatures of files that are not documents the companion reads. */
const REFUSED = Object.freeze([
  { what: 'an image', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { what: 'an image', bytes: [0xff, 0xd8, 0xff] },
  { what: 'an image', bytes: [0x47, 0x49, 0x46, 0x38] },
  { what: 'an image', bytes: [0x52, 0x49, 0x46, 0x46] },
  { what: 'an old office file', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { what: 'an archive', bytes: [0x1f, 0x8b] },
  { what: 'an archive', bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { what: 'an archive', bytes: [0x52, 0x61, 0x72, 0x21] },
  { what: 'a program', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { what: 'a program', bytes: [0x4d, 0x5a] },
  { what: 'a program', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { what: 'a rich text file', bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66] },
]);
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** @param {Uint8Array} bytes @param {readonly number[]} sig @param {number} [at] */
const startsWith = (bytes, sig, at = 0) => sig.every((b, i) => bytes[at + i] === b);

/** The extension of a file name, lower case, without the dot. @param {string} name */
export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/**
 * The kind of an upload.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @returns {DocumentType}
 */
export function sniffDocument(bytes, name) {
  const refuse = (/** @type {string} */ why) => fail('document_type', `this file is ${why}; the companion reads PDF, Word, Excel, PowerPoint, HTML and text files`, { status: 415 });
  if (bytes.length === 0) throw fail('document_empty', 'the file is empty', { status: 400 });
  const ext = extensionOf(name);
  const head = bytes.subarray(0, PDF_WINDOW);
  for (let i = 0; i + 5 <= head.length; i += 1) if (head[i] === 0x25 && startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return 'pdf';
  if (startsWith(bytes, ZIP)) {
    if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return ext;
    throw refuse('an archive or a container format');
  }
  for (const r of REFUSED) if (startsWith(bytes, r.bytes)) throw refuse(r.what);
  const probe = bytes.subarray(0, TEXT_PROBE);
  if (probe.includes(0)) throw refuse('binary data');
  try {
    // A cut multi-byte character at the probe's end is fine; anything else must decode strictly.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.length > TEXT_PROBE ? probe.subarray(0, lastBoundary(probe)) : probe);
  } catch {
    throw refuse('not UTF-8 text');
  }
  if (ext === 'html' || ext === 'htm') return 'html';
  const start = new TextDecoder().decode(probe.subarray(0, 512)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (ext !== 'md' && ext !== 'txt' && (start.startsWith('<!doctype html') || start.startsWith('<html'))) return 'html';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'csv') return 'csv';
  if (ext === 'json') return 'json';
  return 'txt';
}

/**
 * The offset before a UTF-8 sequence that the end of a probe may cut.
 * @param {Uint8Array} probe
 */
function lastBoundary(probe) {
  const end = probe.length;
  for (let back = 1; back <= 3 && end - back >= 0; back += 1) {
    const b = probe[end - back];
    if ((b & 0xc0) === 0xc0) return end - back;
    if ((b & 0x80) === 0) break;
  }
  return end;
}
