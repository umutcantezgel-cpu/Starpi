// @ts-check
// Images (PNG, JPEG, GIF, WebP) hold no text the extractor can read on its own. This module only
// recognises them by their bytes (not by the file name) and reads their size; the text comes from
// text recognition (OCR), which needs the user's consent for each file and a model that can see.
// Without an OCR hook imageToText returns a needsOcr marker naming the AI purpose that will do the
// work (ocr_image); with a hook it hands the image over and returns the recognised text.
import { ParseError } from './errors.js';

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** The AI purpose that turns an image into text. */
export const OCR_PURPOSE = 'ocr_image';

/**
 * @typedef {object} ImageInfo
 * @property {'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'} mime
 * @property {number} width   0 when the header does not say
 * @property {number} height
 */

/**
 * @typedef {ImageInfo & { needsOcr: true, purpose: string, name: string }} OcrRequest
 */

/**
 * Recognises text in an image. Called only after the user agreed to have this file read.
 * @typedef {(request: OcrRequest & { bytes: Uint8Array }) => Promise<string>} OcrHook
 */

/** @param {Uint8Array} b @param {number} o */
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
/** @param {Uint8Array} b @param {number} o */
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
/** @param {Uint8Array} b @param {number} o */
const le24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
/** @param {Uint8Array} b @param {number} o */
const be32 = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
/** @param {Uint8Array} b @param {number} o @param {string} s */
const ascii = (b, o, s) => [...s].every((ch, i) => b[o + i] === ch.charCodeAt(0));

/**
 * The format and pixel size of an image, from its first bytes; null when they are not a PNG, JPEG,
 * GIF or WebP image.
 * @param {Uint8Array} b
 * @returns {ImageInfo | null}
 */
export function describeImage(b) {
  if (b.length >= 24 && ascii(b, 0, '\x89PNG\r\n\x1a\n')) {
    return { mime: 'image/png', width: ascii(b, 12, 'IHDR') ? be32(b, 16) : 0, height: ascii(b, 12, 'IHDR') ? be32(b, 20) : 0 };
  }
  if (b.length >= 10 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return { mime: 'image/gif', width: le16(b, 6), height: le16(b, 8) };
  if (b.length >= 16 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    let width = 0;
    let height = 0;
    if (ascii(b, 12, 'VP8 ') && b.length >= 30) {
      width = le16(b, 26) & 0x3fff;
      height = le16(b, 28) & 0x3fff;
    } else if (ascii(b, 12, 'VP8L') && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (ascii(b, 12, 'VP8X') && b.length >= 30) {
      width = le24(b, 24) + 1;
      height = le24(b, 27) + 1;
    }
    return { mime: 'image/webp', width, height };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk the segments to the first start-of-frame marker, which carries the size.
    let o = 2;
    while (o + 9 < b.length && b[o] === 0xff) {
      const marker = b[o + 1];
      if (marker === 0xff) {
        o += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', width: be16(b, o + 7), height: be16(b, o + 5) };
      }
      if (marker === 0xd9 || marker === 0xda) break;
      o += 2 + be16(b, o + 2);
    }
    return { mime: 'image/jpeg', width: 0, height: 0 };
  }
  return null;
}

/**
 * The text of an image: through the OCR hook when one is given, else a needsOcr marker. Bytes that
 * are no supported image are refused as an unsupported type.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {OcrHook} [ocr]
 * @returns {Promise<OcrRequest | { needsOcr: false, text: string }>}
 */
export async function imageToText(bytes, name, ocr) {
  const info = describeImage(bytes);
  if (!info) throw new ParseError('unsupported_type', 'The file is not a PNG, JPEG, GIF or WebP image');
  /** @type {OcrRequest} */
  const request = { needsOcr: true, purpose: OCR_PURPOSE, name, ...info };
  if (!ocr) return request;
  const text = await ocr({ ...request, bytes });
  return { needsOcr: false, text: typeof text === 'string' ? text : '' };
}
