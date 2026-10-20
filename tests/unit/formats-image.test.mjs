// Images are recognised by their bytes and flagged for text recognition; the OCR itself only runs
// through a hook the caller passes once the user agreed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeImage, IMAGE_EXTENSIONS, imageToText, OCR_PURPOSE } from '../../src/js/rag/formats/image.js';
import { extractText, ParseError, SUPPORTED_EXTENSIONS } from '../../src/js/rag/parser.js';

/** @param {number} w @param {number} h */
function png(w, h) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

/** @param {number} w @param {number} h */
function jpeg(w, h) {
  // SOI, an APP0 segment of 16 bytes, then SOF0 with height and width.
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, ...new Array(9).fill(0)]);
  return b;
}

/** @param {number} w @param {number} h */
function gif(w, h) {
  return new Uint8Array([...new TextEncoder().encode('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
}

/** @param {string} chunk @param {number[]} payload */
function webp(chunk, payload) {
  return new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP'), ...new TextEncoder().encode(chunk), 0, 0, 0, 0, ...payload]);
}

describe('images', () => {
  it('recognises PNG, JPEG, GIF and WebP by their bytes and reads the pixel size', () => {
    assert.deepEqual(describeImage(png(640, 480)), { mime: 'image/png', width: 640, height: 480 });
    assert.deepEqual(describeImage(jpeg(1024, 768)), { mime: 'image/jpeg', width: 1024, height: 768 });
    assert.deepEqual(describeImage(gif(32, 16)), { mime: 'image/gif', width: 32, height: 16 });
    // VP8X stores width-1 and height-1 in 24 bits.
    assert.deepEqual(describeImage(webp('VP8X', [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00])), { mime: 'image/webp', width: 640, height: 480 });
    // VP8L packs (width-1) and (height-1) in 14 bits each after the signature byte.
    const bits = 99 | (49 << 14);
    assert.deepEqual(describeImage(webp('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255])), { mime: 'image/webp', width: 100, height: 50 });
    assert.equal(describeImage(new TextEncoder().encode('not an image at all')), null);
    assert.equal(describeImage(new Uint8Array()), null);
  });

  it('returns a needsOcr marker without a hook, and the recognised text with one', async () => {
    assert.deepEqual(await imageToText(png(10, 20), 'scan.png'), { needsOcr: true, purpose: OCR_PURPOSE, name: 'scan.png', mime: 'image/png', width: 10, height: 20 });
    /** @type {any[]} */
    const seen = [];
    const result = await imageToText(png(10, 20), 'scan.png', async (request) => {
      seen.push(request);
      return 'Invoice total: 120 EUR';
    });
    assert.deepEqual(result, { needsOcr: false, text: 'Invoice total: 120 EUR' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].purpose, 'ocr_image');
    assert.equal(seen[0].bytes.length, 33);
    await assert.rejects(imageToText(new Uint8Array([1, 2, 3]), 'x.png'), (err) => err instanceof ParseError && err.code === 'unsupported_type');
  });

  it('extractText flags images for OCR and reads them only through the hook', async () => {
    assert.ok(IMAGE_EXTENSIONS.has('jpeg'));
    assert.ok(!SUPPORTED_EXTENSIONS.has('png'), 'images are not text files the workspace can read by itself');
    await assert.rejects(extractText(new File([png(800, 600)], 'Photo.PNG')), (err) => {
      assert.ok(err instanceof ParseError);
      assert.equal(err.code, 'needs_ocr');
      assert.deepEqual(err.details, { purpose: 'ocr_image', mime: 'image/png', width: 800, height: 600 });
      return true;
    });
    const res = await extractText(new File([jpeg(20, 10)], 'receipt.jpeg'), undefined, { ocr: async () => 'Line one\r\nLine two\u0000' });
    assert.deepEqual(res, { text: 'Line one\nLine two', kind: 'jpg', pages: null, pdfjs: null });
    await assert.rejects(extractText(new File([gif(1, 1)], 'blank.gif'), undefined, { ocr: async () => '   ' }), (err) => err instanceof ParseError && err.code === 'empty');
    await assert.rejects(extractText(new File(['x'], 'fake.webp')), (err) => err instanceof ParseError && err.code === 'unsupported_type');
  });
});
