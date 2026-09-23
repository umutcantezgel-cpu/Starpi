import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BM25_PARAMS, BM25Index, tokenize } from '../../src/js/rag/bm25.js';

/**
 * @param {string} docId
 * @param {number} chunkIndex
 * @param {string} text
 */
const chunk = (docId, chunkIndex, text) => ({ docId, docName: `${docId}.txt`, chunkIndex, start: 0, end: text.length, text });

/** Reference implementation of one BM25 term score, written out from the textbook formula. */
function termScore({ tf, dl, avgdl, n, df, k1 = 1.2, b = 0.75 }) {
  const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
  return idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl))));
}

const close = (/** @type {number} */ actual, /** @type {number} */ expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

describe('tokenize', () => {
  it('lowercases, applies NFKC and strips punctuation', () => {
    assert.deepEqual(tokenize('The ﬁle, the FILE; the File!'), ['file', 'file', 'file']);
    assert.deepEqual(tokenize('Straße, Größen-Übersicht'), ['straße', 'größen', 'übersicht']);
  });

  it('keeps combining marks attached to their letter', () => {
    assert.deepEqual(tokenize('cafe\u0301 café'), ['café', 'café']);
  });

  it('drops English and German stopwords and single characters', () => {
    assert.deepEqual(tokenize('What is the launch date und wann ist der Beginn? x'), ['launch', 'date', 'beginn']);
  });

  it('returns nothing for empty or punctuation-only input', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(' ... ,,, !!! '), []);
  });
});

describe('BM25Index', () => {
  // d1: apple banana apple (3 tokens), d2: banana cherry (2), d3: cherry durian elder fig (4)
  const build = (params) => {
    const index = new BM25Index(params);
    index.add([chunk('d1', 0, 'apple banana apple'), chunk('d2', 0, 'banana cherry'), chunk('d3', 0, 'cherry durian elder fig')]);
    return index;
  };

  it('uses k1 = 1.2 and b = 0.75 by default', () => {
    assert.deepEqual({ ...BM25_PARAMS }, { k1: 1.2, b: 0.75 });
    const index = build();
    assert.equal(index.size, 3);
    assert.equal(index.avgdl, 3);
  });

  it('computes Okapi BM25 scores exactly', () => {
    const index = build();
    const [top] = index.search('apple');
    assert.equal(top.chunk.docId, 'd1');
    close(top.score, termScore({ tf: 2, dl: 3, avgdl: 3, n: 3, df: 1 }));

    const banana = index.search('banana');
    assert.deepEqual(banana.map((h) => h.chunk.docId), ['d2', 'd1']);
    close(banana[0].score, termScore({ tf: 1, dl: 2, avgdl: 3, n: 3, df: 2 }));
    close(banana[1].score, termScore({ tf: 1, dl: 3, avgdl: 3, n: 3, df: 2 }));
  });

  it('sums term scores for multi-term queries and reports matched terms', () => {
    const index = build();
    const [top, second] = index.search('apple cherry');
    assert.equal(top.chunk.docId, 'd1');
    assert.deepEqual(top.matchedTerms, ['apple']);
    const expectedD2 = termScore({ tf: 1, dl: 2, avgdl: 3, n: 3, df: 2 });
    assert.equal(second.chunk.docId, 'd2');
    close(second.score, expectedD2);
  });

  it('gives rare terms a higher idf than common ones', () => {
    const index = build();
    assert.ok(index.idf('apple') > index.idf('banana'));
    assert.ok(index.idf('banana') > 0);
    assert.ok(index.idf('unknown') > index.idf('apple'));
  });

  it('normalizes by length only through b', () => {
    const flat = build({ b: 0 }).search('banana');
    close(flat[0].score, flat[1].score);
    const normalized = build().search('banana');
    assert.ok(normalized[0].score > normalized[1].score);
  });

  it('saturates term frequency through k1', () => {
    const scores = [1, 2, 4, 8, 16].map((tf) => termScore({ tf, dl: 10, avgdl: 10, n: 10, df: 1 }));
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] > scores[i - 1]);
      assert.ok(scores[i] - scores[i - 1] < scores[i - 1] - (scores[i - 2] ?? 0));
    }
    const idf = Math.log(1 + 9.5 / 1.5);
    assert.ok(scores.at(-1) < idf * (1.2 + 1));
  });

  it('breaks ties by insertion order', () => {
    const index = new BM25Index();
    index.add([chunk('a', 0, 'budget plan'), chunk('b', 0, 'budget plan'), chunk('c', 0, 'budget plan')]);
    assert.deepEqual(index.search('budget').map((h) => h.chunk.docId), ['a', 'b', 'c']);
  });

  it('returns nothing for stopword-only queries or an empty index', () => {
    assert.deepEqual(build().search('the and der die das'), []);
    assert.deepEqual(new BM25Index().search('apple'), []);
  });

  it('limits results to topK and keeps chunk offsets', () => {
    const index = new BM25Index();
    index.add(Array.from({ length: 20 }, (_, i) => ({ ...chunk('doc', i, `alpha beta ${'x'.repeat(i + 2)}`), start: i * 100, end: i * 100 + 50 })));
    const hits = index.search('alpha', 5);
    assert.equal(hits.length, 5);
    assert.deepEqual(Object.keys(hits[0].chunk).sort(), ['chunkIndex', 'docId', 'docName', 'end', 'start', 'text']);
    assert.equal(hits[0].chunk.end - hits[0].chunk.start, 50);
  });

  it('removing a document gives the same scores as never adding it', () => {
    const index = build();
    assert.equal(index.remove('d1'), 1);
    const fresh = new BM25Index();
    fresh.add([chunk('d2', 0, 'banana cherry'), chunk('d3', 0, 'cherry durian elder fig')]);
    assert.deepEqual(index.search('banana cherry'), fresh.search('banana cherry'));
    assert.equal(index.df.has('apple'), false);
    index.clear();
    assert.equal(index.size, 0);
    assert.equal(index.avgdl, 0);
  });
});
