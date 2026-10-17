// Hybrid retrieval on the paraphrase set (tests/fixtures/grounding/paraphrases.json): every
// statement, without its citation, is a query against all source sections of its language, and the
// cited section should be among the results. The embeddings are real multilingual-e5-small vectors
// written by scripts/embed-paraphrases.mjs (paraphrase-vectors.json), so this measures the fusion,
// not a stand-in model. The statements keep the names and numbers of their sources, which keeps
// BM25 close to its ceiling here; meaning matters for the statements that reword them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EMBED_MODEL, embedModelId, embedSource } from '../../src/js/models/embed-catalog.js';
import { BM25Index } from '../../src/js/rag/bm25.js';
import { hybridSearch } from '../../src/js/rag/hybrid.js';
import { VectorIndex } from '../../src/js/rag/vectors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/grounding', name), 'utf8'));
const LABEL = /\[Doc: [^\]]+\]/g;
/** The workspace rows the chat retrieves (LIMITS.retrievalRows) and a deeper cut. */
const ROWS = 6;
const DEEP = 10;

const paraphrases = fixture('paraphrases.json');
const vectors = fixture('paraphrase-vectors.json');
/** @type {Record<string, Array<{ label: string, doc: string, text: string }>>} */
const corpora = { ...fixture('kb-sample.json'), ...fixture('sources-v2.json'), ...paraphrases.corpora };

/** @param {[number, string]} entry  scale and the int8 values as hex */
function unpack([scale, hex]) {
  return { data: new Int8Array(Buffer.from(hex, 'hex')), scale };
}

/**
 * Indexes the sections of one language and runs every statement of that language through BM25 and
 * through hybrid search.
 * @param {'en' | 'de'} lang
 */
function evaluate(lang) {
  const index = new BM25Index();
  const vectorIndex = new VectorIndex(vectors.model, vectors.dim);
  for (const [corpus, sections] of Object.entries(corpora)) {
    if (!corpus.endsWith(`_${lang}`)) continue;
    sections.forEach((s) => {
      const docId = `${corpus}|${s.label}`;
      index.add([{ docId, docName: s.doc, chunkIndex: 0, start: 0, end: s.text.length, text: s.text }]);
      const { data, scale } = unpack(vectors.passages[docId]);
      assert.ok(vectorIndex.add(docId, 0, data, scale), docId);
    });
  }
  const items = /** @type {Array<{ id: string, corpus: string, answer: string }>} */ (paraphrases.items).filter((i) => i.corpus.endsWith(`_${lang}`));
  /** @type {Array<{ id: string, keyword: number, hybrid: number }>} */
  const ranks = [];
  for (const item of items) {
    const relevant = new Set([...item.answer.matchAll(LABEL)].map((m) => `${item.corpus}|${m[0]}`));
    const query = item.answer.replace(/\s*\[Doc: [^\]]+\]/g, '').trim();
    const q = unpack(vectors.queries[item.id]);
    const vec = Float32Array.from(q.data, (v) => v * q.scale);
    const rank = (/** @type {Array<{ chunk: { docId: string } }>} */ hits) => hits.findIndex((h) => relevant.has(h.chunk.docId)) + 1 || Infinity;
    ranks.push({ id: item.id, keyword: rank(index.search(query, 50)), hybrid: rank(hybridSearch(index, vectorIndex, query, vec, 50)) });
  }
  const recall = (/** @type {'keyword' | 'hybrid'} */ side, /** @type {number} */ k) => ranks.filter((r) => r[side] <= k).length / ranks.length;
  return { chunks: index.size, ranks, recall };
}

describe('hybrid retrieval on the paraphrase set', () => {
  it('uses vectors of the default embedding model', () => {
    assert.equal(vectors.model, embedModelId(embedSource(DEFAULT_EMBED_MODEL)));
    assert.equal(vectors.dim, 384);
    assert.equal(Object.keys(vectors.queries).length, paraphrases.items.length);
  });

  for (const lang of /** @type {const} */ (['en', 'de'])) {
    it(`${lang}: recalls at least as many cited sections as BM25 alone`, () => {
      const { chunks, ranks, recall } = evaluate(lang);
      assert.ok(chunks >= 40 && ranks.length > 300, `${chunks} sections, ${ranks.length} statements`);
      assert.ok(recall('hybrid', DEEP) >= recall('keyword', DEEP), `recall@${DEEP}: hybrid ${recall('hybrid', DEEP)} < BM25 ${recall('keyword', DEEP)}`);
      assert.equal(recall('hybrid', DEEP), 1);
      // At the rows the chat uses, both stay within a statement or two of each other.
      assert.ok(recall('hybrid', ROWS) >= recall('keyword', ROWS) - 0.01, `recall@${ROWS}: hybrid ${recall('hybrid', ROWS)}, BM25 ${recall('keyword', ROWS)}`);
      assert.ok(recall('hybrid', ROWS) >= 0.99);
    });

    it(`${lang}: finds a reworded statement that shares no ranking word with its source`, () => {
      const { ranks } = evaluate(lang);
      const rescued = ranks.filter((r) => r.keyword > ROWS && r.hybrid <= ROWS);
      assert.ok(rescued.length >= 1, 'no statement found only by meaning');
      // "There was no data loss" / "Ein Datenverlust trat nicht auf"
      assert.ok(rescued.some((r) => r.id.endsWith('-c5h')), rescued.map((r) => r.id).join(', '));
    });
  }
});

describe('hybrid retrieval across languages', () => {
  it('finds the German passage for an English question, which BM25 cannot', () => {
    const ref = JSON.parse(readFileSync(path.join(ROOT, 'tools/library-publisher/publisher/tests/fixtures/e5_transformers_js.json'), 'utf8'));
    const [query, ...passages] = /** @type {string[]} */ (ref.texts).map((t) => t.replace(/^(query|passage): /, ''));
    const index = new BM25Index();
    const vectorIndex = new VectorIndex('ref', 384);
    passages.forEach((text, i) => {
      index.add([{ docId: `p${i}`, docName: `p${i}.txt`, chunkIndex: 0, start: 0, end: text.length, text }]);
      vectorIndex.add(`p${i}`, 0, Int8Array.from(ref.vectors[i + 1], (v) => Math.round(v * 400)), 1 / 400);
    });
    assert.deepEqual(
      index.search(query, 3).map((h) => h.chunk.docId),
      ['p0'],
    );
    const hits = hybridSearch(index, vectorIndex, query, ref.vectors[0], 2);
    assert.deepEqual(
      hits.map((h) => h.chunk.docId),
      ['p0', 'p1'],
    );
    assert.equal(hits[1].keywordScore, null);
  });
});
