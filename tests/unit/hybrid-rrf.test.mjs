// Hybrid retrieval (src/js/rag/hybrid.js): reciprocal rank fusion against hand-computed scores,
// keyword plus semantic search over a small workspace, int8 vectors (src/js/rag/vectors.js) and the
// workspace probe the Auto mode routes with.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BM25Index } from '../../src/js/rag/bm25.js';
import { fuseRrf, HYBRID_DEPTH, hybridSearch, probeIndex, RRF_K } from '../../src/js/rag/hybrid.js';
import { chunkKey, cosine, dequantize, quantizeInt8, VectorIndex } from '../../src/js/rag/vectors.js';

const close = (/** @type {number} */ a, /** @type {number} */ b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

describe('fuseRrf', () => {
  it('sums 1 / (60 + rank) over the rankings (golden values)', () => {
    const fused = fuseRrf([
      ['a', 'b', 'c'],
      ['c', 'a', 'd'],
    ]);
    assert.equal(RRF_K, 60);
    assert.deepEqual(
      fused.map((f) => f.key),
      ['a', 'c', 'b', 'd'],
    );
    close(fused[0].score, 1 / 61 + 1 / 62);
    close(fused[1].score, 1 / 63 + 1 / 61);
    close(fused[2].score, 1 / 62);
    close(fused[3].score, 1 / 63);
    assert.deepEqual(fused[0].ranks, [1, 2]);
    assert.deepEqual(fused[3].ranks, [null, 3]);
  });

  it('takes k, a key function and a limit, and counts an item once per ranking', () => {
    const fused = fuseRrf(
      [
        [{ id: 'x' }, { id: 'y' }, { id: 'x' }],
        [{ id: 'y' }],
      ],
      { key: (o) => o.id, k: 0, limit: 1 },
    );
    assert.equal(fused.length, 1);
    assert.equal(fused[0].key, 'y');
    close(fused[0].score, 1 / 2 + 1 / 1);
    assert.deepEqual(fused[0].item, { id: 'y' });
  });

  it('breaks ties by the better single rank, then by first appearance', () => {
    // b: ranks 1 and 3; a: rank 2 twice. 1/61 + 1/63 > 2/62, so b leads; then exact ties.
    assert.deepEqual(
      fuseRrf([
        ['b', 'a', 'c'],
        ['d', 'a', 'b'],
      ]).map((f) => f.key),
      ['b', 'a', 'd', 'c'],
    );
    assert.deepEqual(
      fuseRrf([['p'], ['q']]).map((f) => f.key),
      ['p', 'q'],
    );
    assert.deepEqual(fuseRrf([]), []);
    assert.throws(() => fuseRrf([['a']], { k: -1 }), RangeError);
  });
});

describe('int8 vectors', () => {
  it('quantises symmetrically and keeps the cosine', () => {
    const v = Float32Array.from([0.5, -0.25, 0.125, 0, -0.5]);
    const { data, scale } = quantizeInt8(v);
    close(scale, 0.5 / 127, 1e-9);
    // -63.5 rounds towards +infinity (Math.round).
    assert.deepEqual([...data], [127, -63, 32, 0, -127]);
    const back = dequantize(data, scale);
    for (let i = 0; i < v.length; i += 1) assert.ok(Math.abs(back[i] - v[i]) <= scale / 2 + 1e-9);
    assert.ok(cosine(v, data) > 0.9999);
    assert.deepEqual(quantizeInt8([0, 0]), { data: new Int8Array(2), scale: 0 });
  });

  it('finds the nearest chunks, skips other models and refuses a wrong length', () => {
    const index = new VectorIndex('m@1/q8', 3);
    assert.equal(index.add('d1', 0, quantizeInt8([1, 0, 0]).data, 1), true);
    assert.equal(index.add('d1', 1, quantizeInt8([0, 1, 0]).data, 1), true);
    assert.equal(index.add('d2', 0, quantizeInt8([0.7, 0.7, 0]).data, 1), true);
    assert.equal(index.add('d2', 1, new Int8Array(4), 1), false);
    assert.equal(index.addRecord({ docId: 'd3', idx: 0, model: 'other@1/q8', dim: 3, data: new Int8Array(3), scale: 1 }), false);
    const hits = index.search([0.9, 0.1, 0], 2);
    assert.deepEqual(
      hits.map((h) => chunkKey(h.docId, h.idx)),
      ['d1#0', 'd2#0'],
    );
    assert.ok(hits[0].score > hits[1].score);
    assert.equal(index.remove('d1'), 2);
    assert.equal(index.size, 1);
    assert.deepEqual(index.search([0, 0, 0], 2), []);
  });
});

/** A tiny workspace: three chunks with known words, plus vectors that encode their topics. */
function workspace() {
  const index = new BM25Index();
  const texts = [
    'The quarterly budget was approved by the board in March.',
    'Staff may work remotely on two days per week after approval.',
    'The cafeteria opens at eight and serves lunch until two.',
  ];
  index.add(texts.map((text, i) => ({ docId: 'doc', docName: 'notes.md', chunkIndex: i, start: i * 100, end: i * 100 + text.length, text })));
  const vectors = new VectorIndex('m', 3);
  // Topic axes: money, working from home, food.
  [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ].forEach((v, i) => vectors.add('doc', i, quantizeInt8(v).data, 1 / 127));
  return { index, vectors };
}

describe('hybridSearch', () => {
  it('finds a chunk by meaning when no keyword matches, and keeps the keyword hits', () => {
    const { index, vectors } = workspace();
    // "home office" shares no word with chunk 1, but its vector points at the same topic.
    assert.deepEqual(index.search('home office rules', 5), []);
    const hits = hybridSearch(index, vectors, 'home office rules', [0.1, 0.95, 0], 2);
    assert.equal(hits[0].chunk.chunkIndex, 1);
    assert.equal(hits[0].keywordScore, null);
    assert.ok(hits[0].similarity !== null && hits[0].similarity > 0.9);
    close(hits[0].score, 1 / 61);
    assert.deepEqual(hits[0].matchedTerms, []);
    assert.equal(hits[0].chunk.text, 'Staff may work remotely on two days per week after approval.');
    assert.equal(hits[0].chunk.start, 100);

    const both = hybridSearch(index, vectors, 'budget approval', [1, 0.2, 0], 3);
    assert.equal(both[0].chunk.chunkIndex, 0);
    assert.ok(both[0].keywordScore !== null && both[0].keywordScore > 0);
    close(both[0].score, 1 / 61 + 1 / 61);
    assert.deepEqual(both[0].matchedTerms, ['budget']);
  });

  it('drops a vector whose chunk is no longer indexed', () => {
    const { index, vectors } = workspace();
    vectors.add('gone', 0, quantizeInt8([0, 0, 1]).data, 1 / 127);
    const hits = hybridSearch(index, vectors, 'lunch', [0, 0, 1], 5, { depth: HYBRID_DEPTH });
    assert.ok(hits.every((h) => h.chunk.docId === 'doc'));
    assert.equal(hits[0].chunk.chunkIndex, 2);
  });
});

describe('probeIndex', () => {
  it('normalises the best score by the query weight and reports term coverage', () => {
    const { index } = workspace();
    const strong = probeIndex(index, 'quarterly budget board');
    assert.equal(strong.terms, 3);
    assert.equal(strong.coverage, 1);
    assert.deepEqual(strong.matched, ['quarterly', 'budget', 'board']);
    assert.ok(strong.score > 0.9 && strong.score <= 1, String(strong.score));
    assert.equal(strong.docId, 'doc');

    const weak = probeIndex(index, 'budget for the moon landing rocket');
    assert.ok(weak.coverage > 0 && weak.coverage < 0.5, String(weak.coverage));
    assert.ok(weak.score < strong.score / 2, String(weak.score));

    assert.deepEqual(probeIndex(index, 'xylophone'), { score: 0, coverage: 0, terms: 1, matched: [], hits: 0, docId: null });
    assert.deepEqual(probeIndex(new BM25Index(), 'budget'), { score: 0, coverage: 0, terms: 1, matched: [], hits: 0, docId: null });
  });

  it("probes only the documents a conversation's scope accepts", () => {
    const { index } = workspace();
    index.add([{ docId: 'other', docName: 'other.md', chunkIndex: 0, start: 0, end: 60, text: 'The garden shed holds the lawn mower and the rakes.' }]);
    const open = probeIndex(index, 'garden shed lawn mower');
    assert.equal(open.docId, 'other');
    assert.ok(open.coverage === 1);
    // A project that holds only "doc": the shed is not there to match.
    const scoped = probeIndex(index, 'garden shed lawn mower', 5, (docId) => docId === 'doc');
    assert.deepEqual(scoped, { score: 0, coverage: 0, terms: 4, matched: [], hits: 0, docId: null });
    assert.equal(probeIndex(index, 'quarterly budget board', 5, (docId) => docId === 'doc').docId, 'doc');
  });
});
