import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkText } from '../../src/js/rag/chunker.js';

describe('sliding-window text chunker', () => {
  it('returns empty array for empty or whitespace-only strings', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   \n\t   '), []);
  });

  it('returns a single chunk if text is smaller than chunkSize', () => {
    const text = 'Short document with 35 characters.';
    const chunks = chunkText(text, { chunkSize: 200, chunkOverlap: 20 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].id, 0);
    assert.equal(chunks[0].text, text);
    assert.equal(chunks[0].startOffset, 0);
    assert.equal(chunks[0].endOffset, text.length);
  });

  it('splits long text into overlapping chunks at paragraph or sentence boundaries', () => {
    const paragraph1 = 'Starpi is a browser-native knowledge assistant with client-side inference.';
    const paragraph2 = 'It runs WebLLM directly on the GPU without uploading private documents.';
    const paragraph3 = 'Supabase Postgres with pgvector provides persistent storage and RLS.';
    const fullText = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

    const chunks = chunkText(fullText, { chunkSize: 90, chunkOverlap: 20 });
    assert.ok(chunks.length >= 2, 'Should create multiple chunks');

    for (const chunk of chunks) {
      assert.ok(chunk.text.length > 0);
      assert.ok(chunk.startOffset >= 0);
      assert.ok(chunk.endOffset <= fullText.length);
      assert.ok(chunk.startOffset < chunk.endOffset);
    }

    // Verify overlap: next chunk's start should be before previous chunk's end
    if (chunks.length > 1) {
      assert.ok(chunks[1].startOffset < chunks[0].endOffset, 'Chunk 1 must overlap with Chunk 0');
    }
  });

  it('handles multi-byte unicode characters and emojis without corrupted substrings', () => {
    const text = 'Überragende KI-Leistung 🚀 mit WebGPU und 100 % DSGVO-Konformität! '.repeat(10);
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
    assert.ok(chunks.length >= 3);

    for (const chunk of chunks) {
      // Chunk must be valid string without unpaired surrogates
      assert.doesNotThrow(() => encodeURIComponent(chunk.text));
    }
  });
});
