import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkText, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from '../../src/js/rag/chunker.js';

/**
 * Invariants every chunking must satisfy.
 * @param {string} text
 * @param {ReturnType<typeof chunkText>} chunks
 * @param {number} size
 */
function assertInvariants(text, chunks, size) {
  chunks.forEach((c, i) => {
    assert.equal(c.index, i);
    assert.equal(c.text, text.slice(c.start, c.end), `chunk ${i} text must equal its source span`);
    assert.ok(c.end - c.start <= size + 1, `chunk ${i} longer than the window`);
    assert.ok(c.text.length > 0 && c.text.trim() === c.text, `chunk ${i} must be trimmed and non-empty`);
    if (i > 0) assert.ok(c.start > chunks[i - 1].start, 'windows move forward');
    const first = c.text.charCodeAt(0);
    const last = c.text.charCodeAt(c.text.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), `chunk ${i} starts with a low surrogate`);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `chunk ${i} ends with a high surrogate`);
    assert.doesNotMatch(c.text, /^\p{M}/u, `chunk ${i} starts with a combining mark`);
  });
  // Every non-whitespace character is covered by at least one chunk.
  const covered = new Uint8Array(text.length);
  for (const c of chunks) covered.fill(1, c.start, c.end);
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) assert.equal(covered[i], 1, `character ${i} not covered`);
}

describe('chunkText', () => {
  it('defaults to 500-character windows with 50 characters of overlap', () => {
    assert.equal(DEFAULT_CHUNK_SIZE, 500);
    assert.equal(DEFAULT_CHUNK_OVERLAP, 50);
  });

  it('returns no chunks for empty or whitespace-only text', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText(' \n\t  \n'), []);
  });

  it('returns one trimmed chunk with exact offsets for short text', () => {
    const text = '\n  Hello world.  \n';
    assert.deepEqual(chunkText(text), [{ index: 0, start: 3, end: 15, text: 'Hello world.' }]);
  });

  it('cuts text without break points at exact window multiples with the requested overlap', () => {
    const text = 'a'.repeat(1000);
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 10 });
    assertInvariants(text, chunks, 100);
    assert.deepEqual(
      chunks.slice(0, 3).map((c) => [c.start, c.end]),
      [
        [0, 100],
        [90, 190],
        [180, 280],
      ],
    );
    assert.equal(chunks.at(-1)?.end, 1000);
  });

  it('prefers paragraph, then sentence, then word boundaries', () => {
    const para = `${'word '.repeat(15)}end.\n\n${'next '.repeat(30)}`;
    const [first] = chunkText(para, { chunkSize: 100, chunkOverlap: 0 });
    assert.ok(first.text.endsWith('end.'), first.text);

    const sentences = `${'This is a sentence. '.repeat(10)}`;
    for (const c of chunkText(sentences, { chunkSize: 90, chunkOverlap: 0 }).slice(0, -1)) assert.ok(c.text.endsWith('.'), c.text);

    const words = 'lorem ipsum dolor sit amet '.repeat(20);
    for (const c of chunkText(words, { chunkSize: 60, chunkOverlap: 0 })) assert.match(c.text, /^\S.*\S$/);
  });

  it('never splits surrogate pairs (emoji, rare CJK) or detaches combining marks', () => {
    const face = String.fromCodePoint(0x1f600);
    const rare = String.fromCodePoint(0x20bb7);
    const emoji = face.repeat(300);
    assertInvariants(emoji, chunkText(emoji, { chunkSize: 51, chunkOverlap: 7 }), 51);
    const cjk = `漢字${rare}`.repeat(200);
    assertInvariants(cjk, chunkText(cjk, { chunkSize: 37, chunkOverlap: 5 }), 37);
    const accents = 'e\u0301'.repeat(400);
    assertInvariants(accents, chunkText(accents, { chunkSize: 25, chunkOverlap: 3 }), 25);
  });

  it('handles large documents in linear time', () => {
    const text = 'The quarterly budget for Project Alpha is 120,000 EUR. '.repeat(20_000);
    const started = performance.now();
    const chunks = chunkText(text);
    assert.ok(performance.now() - started < 2_000);
    assert.ok(chunks.length > text.length / 500 && chunks.length < text.length / 400, `${chunks.length} chunks`);
    assertInvariants(text.slice(0, 20_000), chunkText(text.slice(0, 20_000)), 500);
  });

  it('rejects invalid options', () => {
    assert.throws(() => chunkText('abc', { chunkSize: 10, chunkOverlap: 10 }), RangeError);
    assert.throws(() => chunkText('abc', { chunkSize: 0 }), RangeError);
    assert.throws(() => chunkText('abc', { chunkSize: -5 }), RangeError);
    assert.throws(() => chunkText('abc', { chunkSize: 10.5 }), RangeError);
    assert.throws(() => chunkText('abc', { chunkOverlap: -1 }), RangeError);
  });
});
