// The ZIP reader behind the Office formats: stored, deflated and ZIP64 archives, CRC checks, entry
// name sanitising, and refusal of archives built to exhaust memory (ZIP bombs).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { ParseError } from '../../src/js/rag/formats/errors.js';
import { crc32, isZip, openZip, sanitizeEntryName, ZIP_LIMITS } from '../../src/js/rag/formats/zip.js';
import { makeZip } from '../fixtures/formats/build.mjs';

const text = (/** @type {Uint8Array} */ b) => new TextDecoder().decode(b);
/** @param {string} code */
const code = (code) => (/** @type {unknown} */ err) => err instanceof ParseError && err.code === code;

describe('ZIP reader', () => {
  it('reads stored and deflated entries, by name without case, with their CRC-32 checked', async () => {
    const zip = openZip(
      makeZip([
        { name: 'word/document.xml', data: '<doc>Grüße</doc>' },
        { name: 'media/raw.bin', data: 'stored bytes', method: 0 },
        { name: 'folder/', data: '' },
      ]),
    );
    assert.deepEqual(
      zip.entries.map((e) => [e.name, e.method]),
      [
        ['word/document.xml', 8],
        ['media/raw.bin', 0],
      ],
    );
    assert.equal(text(await zip.read('word/document.xml')), '<doc>Grüße</doc>');
    assert.equal(text(await zip.read('/WORD/Document.XML')), '<doc>Grüße</doc>');
    assert.equal(text(await zip.read('media/raw.bin')), 'stored bytes');
    assert.equal(zip.get('missing.xml'), null);
    await assert.rejects(zip.read('missing.xml'), code('invalid_document'));
  });

  it('reads ZIP64 archives, entries with data descriptors and archives with a comment', async () => {
    const zip64 = openZip(makeZip([{ name: 'a.txt', data: 'alpha' }, { name: 'b.txt', data: 'beta'.repeat(100) }], { zip64: true }));
    assert.equal(text(await zip64.read('b.txt')), 'beta'.repeat(100));
    const described = openZip(makeZip([{ name: 'a.txt', data: 'with descriptor', flags: 0x8 }], { comment: 'PK\u0005\u0006 inside a comment' }));
    assert.equal(text(await described.read('a.txt')), 'with descriptor');
  });

  it('computes the standard CRC-32 and recognises ZIP signatures', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    assert.equal(crc32(new Uint8Array()), 0);
    assert.equal(isZip(makeZip([{ name: 'a', data: 'x' }])), true);
    assert.equal(isZip(makeZip([])), true);
    assert.equal(isZip(new TextEncoder().encode('%PDF-1.7')), false);
  });

  it('sanitises entry names and leaves unsafe ones unreadable', async () => {
    assert.equal(sanitizeEntryName('word\\media\\image1.png'), 'word/media/image1.png');
    assert.equal(sanitizeEntryName('./xl//worksheets/./sheet1.xml'), 'xl/worksheets/sheet1.xml');
    for (const bad of ['../evil.xml', 'word/../../evil.xml', '/etc/passwd', '\\\\server\\share', 'C:\\temp\\x.xml', 'c:x.xml', 'a\u0000b', 'tab\tname', '', './']) {
      assert.equal(sanitizeEntryName(bad), null, JSON.stringify(bad));
    }
    const zip = openZip(makeZip([{ name: '../outside.xml', data: 'x' }, { name: '/abs.xml', data: 'y' }, { name: 'ok.xml', data: 'z' }]));
    assert.deepEqual(
      zip.entries.map((e) => e.name),
      ['ok.xml'],
    );
    assert.equal(zip.skipped, 2);
    assert.equal(zip.get('../outside.xml'), null);
  });

  it('refuses broken archives: truncation, duplicates, CRC mismatch, bad deflate data, unknown methods', async () => {
    const good = makeZip([{ name: 'a.txt', data: 'hello world' }]);
    assert.throws(() => openZip(good.subarray(0, good.length - 5)), code('invalid_document'));
    assert.throws(() => openZip(good.subarray(10)), code('invalid_document'));
    assert.throws(() => openZip(new TextEncoder().encode('not a zip at all, not even close')), code('invalid_document'));
    assert.throws(() => openZip(makeZip([{ name: 'a.txt', data: '1' }, { name: 'A.TXT', data: '2' }])), code('invalid_document'));
    await assert.rejects(openZip(makeZip([{ name: 'a.txt', data: 'hello', crc: 1234 }])).read('a.txt'), code('invalid_document'));
    await assert.rejects(openZip(makeZip([{ name: 'a.txt', data: 'hello', payload: new Uint8Array([0xff, 0xff, 0xff, 0x00]) }])).read('a.txt'), code('invalid_document'));
    await assert.rejects(openZip(makeZip([{ name: 'a.txt', data: 'hello', size: 50 }])).read('a.txt'), code('invalid_document'));
    await assert.rejects(openZip(makeZip([{ name: 'a.bz2', data: 'hello', method: 12, payload: new TextEncoder().encode('hello') }])).read('a.bz2'), code('invalid_document'));
    await assert.rejects(openZip(makeZip([{ name: 'a.txt', data: 'hello', method: 0, size: 3 }])).read('a.txt'), code('invalid_document'));
  });

  it('reports encrypted entries as encrypted documents', async () => {
    const zip = openZip(makeZip([{ name: 'word/document.xml', data: 'secret', flags: 0x1 }]));
    await assert.rejects(zip.read('word/document.xml'), code('encrypted_document'));
  });
});

describe('ZIP bomb refusal', () => {
  it('refuses an entry whose declared compression ratio no document reaches, before inflating it', () => {
    // 32 MiB of zeros deflate to about 32 KiB: a ratio near 1000.
    const zeros = new Uint8Array(32 * 1024 * 1024);
    const archive = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: zeros }]);
    assert.ok(archive.length < 100_000);
    assert.throws(() => openZip(archive), code('zip_bomb'));
    // Small entries may compress far better without harm.
    assert.doesNotThrow(() => openZip(makeZip([{ name: 'small.xml', data: new Uint8Array(512 * 1024) }])));
  });

  it('stops inflating as soon as an entry produces more than it declares', async () => {
    const zeros = new Uint8Array(4 * 1024 * 1024);
    const archive = makeZip([{ name: 'a.xml', data: zeros, size: 1000 }]);
    const zip = openZip(archive);
    await assert.rejects(zip.read('a.xml'), code('zip_bomb'));
  });

  it('refuses too many entries, oversized entries and too much in total', () => {
    const many = makeZip(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: `f${i}.txt`, data: '', method: 0 })));
    assert.throws(() => openZip(many), code('zip_bomb'));
    assert.throws(() => openZip(makeZip([{ name: 'a', data: 'x'.repeat(200), method: 0 }]), { entryBytes: 100 }), code('zip_bomb'));
    const pair = makeZip([{ name: 'a', data: 'x'.repeat(600), method: 0 }, { name: 'b', data: 'y'.repeat(600), method: 0 }]);
    assert.throws(() => openZip(pair, { totalBytes: 1000 }), code('zip_bomb'));
    assert.throws(() => openZip(makeZip([{ name: 'a', data: 'x', size: ZIP_LIMITS.totalBytes + 1, method: 0 }])), code('zip_bomb'));
  });

  it('refuses overlapping entries that reuse one compressed stream', () => {
    const payload = new Uint8Array(512 * 1024).fill(0x41);
    const archive = makeZip([{ name: 'kernel.xml', data: payload }, ...Array.from({ length: 50 }, (_, i) => ({ name: `copy${i}.xml`, aliasOf: 0 }))]);
    assert.throws(() => openZip(archive), code('zip_bomb'));
  });

  it('keeps the inflated total of all reads within the limit', async () => {
    const zip = openZip(makeZip([{ name: 'a', data: 'x'.repeat(800) }, { name: 'b', data: 'y'.repeat(800) }]), { totalBytes: 2000 });
    await zip.read('a');
    await zip.read('a');
    await assert.rejects(zip.read('b'), code('zip_bomb'));
  });

  it('accepts what real documents look like: XML compressing about 10 to 50 times', async () => {
    const row = (/** @type {number} */ i) => `<row r="${i}"><c r="A${i}" t="s"><v>${i % 7}</v></c><c r="B${i}"><v>${i * 3}</v></c></row>`;
    const xml = `<sheetData>${Array.from({ length: 60_000 }, (_, i) => row(i + 1)).join('')}</sheetData>`;
    const bytes = new TextEncoder().encode(xml);
    assert.ok(bytes.length / deflateRawSync(bytes).length < ZIP_LIMITS.ratio);
    const zip = openZip(makeZip([{ name: 'sheet.xml', data: bytes }]));
    assert.equal((await zip.read('sheet.xml')).length, bytes.length);
  });
});
