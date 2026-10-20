// @ts-check
// Hybrid retrieval over the workspace: the keyword ranking (BM25) and the semantic ranking (cosine
// similarity of embeddings) fused with reciprocal rank fusion, and the quick probe that tells the
// Auto mode whether the workspace can answer a question. Pure; @starpi/core exports fuseRrf.
//
//   rrf(d) = Σ over the rankings that contain d of 1 / (k + rank(d))      rank 1-based, k = 60
//
// RRF needs no score calibration between the rankings, which is why it fits BM25 scores (unbounded)
// and cosine similarities (-1..1) alike. Ties go to the item with the better single rank, then to
// the item met first.
import { tokenize } from './bm25.js';
import { chunkKey } from './vectors.js';

/** @typedef {import('./bm25.js').BM25Index} BM25Index */
/** @typedef {import('./bm25.js').IndexedChunk} IndexedChunk */
/** @typedef {import('./bm25.js').Entry} Entry */
/** @typedef {import('./vectors.js').VectorIndex} VectorIndex */

/** The RRF constant: dampens the weight of the first few ranks. */
export const RRF_K = 60;
/** How many candidates each ranking contributes before fusion. */
export const HYBRID_DEPTH = 50;

/**
 * @template T
 * @typedef {object} FusedItem
 * @property {string} key
 * @property {T} item  the item as the first ranking that contains it gave it
 * @property {number} score  the RRF score
 * @property {Array<number | null>} ranks  1-based rank in each input ranking, null where absent
 */

/**
 * Fuses rankings (best first) with reciprocal rank fusion. An item a ranking lists twice counts
 * once, at its better rank.
 * @template T
 * @param {ReadonlyArray<ReadonlyArray<T>>} lists
 * @param {{ key?: (item: T) => string, k?: number, limit?: number }} [options]
 * @returns {Array<FusedItem<T>>}
 */
export function fuseRrf(lists, options = {}) {
  const k = options.k ?? RRF_K;
  if (typeof k !== 'number' || !(k >= 0) || !Number.isFinite(k)) throw new RangeError('k must be a non-negative finite number');
  const keyOf = options.key ?? ((/** @type {T} */ item) => String(item));
  /** @type {Map<string, FusedItem<T> & { order: number, best: number }>} */
  const fused = new Map();
  let order = 0;
  lists.forEach((list, li) => {
    /** @type {Set<string>} */
    const seen = new Set();
    list.forEach((item, pos) => {
      const key = keyOf(item);
      if (seen.has(key)) return;
      seen.add(key);
      let entry = fused.get(key);
      if (!entry) {
        entry = { key, item, score: 0, ranks: lists.map(() => null), order: order++, best: Infinity };
        fused.set(key, entry);
      }
      const rank = pos + 1;
      entry.ranks[li] = rank;
      entry.score += 1 / (k + rank);
      entry.best = Math.min(entry.best, rank);
    });
  });
  const sorted = [...fused.values()].sort((a, b) => b.score - a.score || a.best - b.best || a.order - b.order);
  const limited = options.limit === undefined ? sorted : sorted.slice(0, Math.max(0, options.limit));
  return limited.map(({ key, item, score, ranks }) => ({ key, item, score, ranks }));
}

/**
 * @typedef {object} HybridHit
 * @property {IndexedChunk} chunk
 * @property {number} score  the RRF score
 * @property {number | null} keywordScore  BM25 score; null when only the semantic ranking found the chunk
 * @property {number | null} similarity  cosine similarity; null when only the keyword ranking found it
 * @property {string[]} matchedTerms  query terms present in the chunk
 */

/**
 * Keyword top `depth` plus semantic top `depth`, fused with RRF.
 * @param {BM25Index} index
 * @param {VectorIndex} vectors
 * @param {string} text  the question
 * @param {ArrayLike<number>} vec  the question's embedding (same model as `vectors`)
 * @param {number} k  results to return
 * @param {{ depth?: number, rrfK?: number, lookup?: (key: string) => Entry | undefined, accept?: (docId: string) => boolean }} [options]
 *   lookup: the index entry of a chunk key (chunkKey), when the caller keeps such a map; accept:
 *   only chunks of the documents it accepts, in both rankings
 * @returns {HybridHit[]}
 */
export function hybridSearch(index, vectors, text, vec, k, options = {}) {
  const depth = options.depth ?? HYBRID_DEPTH;
  const keyword = index.search(text, depth, options.accept);
  const semantic = vectors.search(vec, depth, options.accept);
  /** @type {(key: string) => Entry | undefined} */
  let lookup = options.lookup ?? (() => undefined);
  if (!options.lookup && semantic.length) {
    const byKey = new Map(index.entries.map((e) => [chunkKey(e.docId, e.chunkIndex), e]));
    lookup = (key) => byKey.get(key);
  }
  const terms = [...new Set(tokenize(text))];
  /** @type {Map<string, number>} */
  const similarity = new Map(semantic.map((h) => [chunkKey(h.docId, h.idx), h.score]));
  /** @type {Map<string, import('./bm25.js').SearchHit>} */
  const byKeyword = new Map(keyword.map((h) => [chunkKey(h.chunk.docId, h.chunk.chunkIndex), h]));
  const fused = fuseRrf([keyword.map((h) => chunkKey(h.chunk.docId, h.chunk.chunkIndex)), semantic.map((h) => chunkKey(h.docId, h.idx))], { k: options.rrfK ?? RRF_K });
  /** @type {HybridHit[]} */
  const out = [];
  for (const f of fused) {
    if (out.length >= k) break;
    const kw = byKeyword.get(f.key);
    if (kw) {
      out.push({ chunk: kw.chunk, score: f.score, keywordScore: kw.score, similarity: similarity.get(f.key) ?? null, matchedTerms: kw.matchedTerms });
      continue;
    }
    // Found by meaning only: the chunk must still be in the keyword index (a vector can outlive a
    // removed document for a moment while the worker deletes it).
    const entry = lookup(f.key);
    if (!entry) continue;
    out.push({
      chunk: { docId: entry.docId, docName: entry.docName, chunkIndex: entry.chunkIndex, start: entry.start, end: entry.end, text: entry.text },
      score: f.score,
      keywordScore: null,
      similarity: similarity.get(f.key) ?? null,
      matchedTerms: terms.filter((t) => entry.tf.has(t)),
    });
  }
  return out;
}

/**
 * @typedef {object} WorkspaceProbe
 * @property {number} score  best BM25 score over the score a chunk of average length gets with every query term once, capped at 1
 * @property {number} coverage  share of the query terms present in the best chunk, 0..1
 * @property {number} terms  distinct query terms (after stop words)
 * @property {string[]} matched  query terms present in the best chunk
 * @property {number} hits  chunks with at least one query term, up to `k`
 * @property {string | null} docId  document of the best chunk
 */

/** @type {Readonly<WorkspaceProbe>} */
const NO_PROBE = Object.freeze({ score: 0, coverage: 0, terms: 0, matched: [], hits: 0, docId: null });

/**
 * How well the workspace matches a question, in milliseconds and without a model: the Auto mode
 * routes to the documents on a strong match. The normalised score is 1 when the best chunk holds
 * every query term at the density of an average chunk; query terms the workspace does not contain
 * at all lower it, because their weight (idf) is the highest.
 * @param {BM25Index} index
 * @param {string} question
 * @param {number} [k]
 * @param {(docId: string) => boolean} [accept]  only chunks of the documents it accepts (a
 *   conversation's workspace scope; the statistics stay those of the whole index)
 * @returns {WorkspaceProbe}
 */
export function probeIndex(index, question, k = 5, accept) {
  const terms = [...new Set(tokenize(question))];
  if (terms.length === 0 || index.size === 0) return { ...NO_PROBE, matched: [], terms: terms.length };
  const hits = index.search(question, k, accept);
  if (hits.length === 0) return { ...NO_PROBE, matched: [], terms: terms.length };
  const ideal = terms.reduce((sum, term) => sum + index.idf(term), 0);
  const [best] = hits;
  return {
    score: ideal > 0 ? Math.min(1, best.score / ideal) : 0,
    coverage: best.matchedTerms.length / terms.length,
    terms: terms.length,
    matched: best.matchedTerms,
    hits: hits.length,
    docId: best.chunk.docId,
  };
}
