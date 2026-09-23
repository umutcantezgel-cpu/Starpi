import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BM25Index, tokenizeBM25 } from '../../src/js/rag/bm25.js';

describe('BM25 tokenization', () => {
  it('lowercases and normalizes unicode text', () => {
    const tokens = tokenizeBM25('Über-Größe & Café Läuft!');
    assert.ok(tokens.includes('über-größe') || tokens.includes('größe'));
    assert.ok(tokens.includes('café'));
    assert.ok(tokens.includes('läuft'));
  });

  it('filters out both English and German stop words', () => {
    const text = 'This is the launch and das ist der Beginn für das Projekt';
    const tokens = tokenizeBM25(text);
    // Should keep content words: 'launch', 'beginn', 'projekt'
    assert.ok(tokens.includes('launch'));
    assert.ok(tokens.includes('beginn'));
    assert.ok(tokens.includes('projekt'));
    // Should drop stop words
    assert.ok(!tokens.includes('the'));
    assert.ok(!tokens.includes('und'));
    assert.ok(!tokens.includes('das'));
    assert.ok(!tokens.includes('ist'));
  });

  it('handles empty strings and punctuation cleanly', () => {
    assert.deepEqual(tokenizeBM25(''), []);
    assert.deepEqual(tokenizeBM25('   ... ,,, !!! ???   '), []);
  });
});

describe('BM25 ranking algorithm', () => {
  it('correctly ranks the most relevant document highest based on term frequency and length', () => {
    const index = new BM25Index();

    index.addDocuments([
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        documentTitle: 'WebGPU Architecture',
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 120,
        content: 'WebGPU allows browser-native shader execution. WebGPU kernels run high throughput inference.',
      },
      {
        id: 'chunk-2',
        documentId: 'doc-2',
        documentTitle: 'Supabase Guide',
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 100,
        content: 'Supabase Postgres with pgvector stores document embeddings and provides Row Level Security.',
      },
      {
        id: 'chunk-3',
        documentId: 'doc-3',
        documentTitle: 'Hybrid Inference',
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 150,
        content: 'A hybrid setup uses WebGPU for local privacy and Supabase for cloud vector storage.',
      },
    ]);

    const results = index.search('WebGPU browser inference', 3);
    assert.ok(results.length >= 2, 'Should find at least 2 matching chunks');
    assert.equal(results[0].chunk.id, 'chunk-1', 'Chunk 1 has highest density of WebGPU and inference');
    assert.ok(results[0].score > results[1].score, 'Top score must be strictly higher');
    assert.ok(results[0].matchedTerms.includes('webgpu'));
  });

  it('returns empty array when query terms have zero matches', () => {
    const index = new BM25Index();
    index.addDocuments([
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        documentTitle: 'Title',
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 50,
        content: 'Alpha Beta Gamma Delta',
      },
    ]);

    const results = index.search('Zeta Epsilon Omega', 5);
    assert.deepEqual(results, []);
  });

  it('respects topK parameter and minimum score threshold', () => {
    const index = new BM25Index();
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `chunk-${i}`,
      documentId: `doc-${i}`,
      documentTitle: `Doc ${i}`,
      chunkIndex: 0,
      startOffset: 0,
      endOffset: 100,
      content: `Kernel matrix multiplication benchmark pass ${i} for WebGPU device testing`,
    }));
    index.addDocuments(docs);

    const top2 = index.search('matrix multiplication benchmark', 2);
    assert.equal(top2.length, 2);
  });
});
