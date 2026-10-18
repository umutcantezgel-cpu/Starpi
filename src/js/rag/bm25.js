// @ts-check
// In-memory Okapi BM25 index over document chunks (every registered language; English + German built in,
// French, Spanish, Italian and Turkish once loaded).
//
//   score(q, d) = Σ_t idf(t) · tf(t,d)·(k1 + 1) / (tf(t,d) + k1·(1 − b + b·|d|/avgdl))
//   idf(t)      = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))      (non-negative variant)
//
// with k1 = 1.2 and b = 0.75, N = number of indexed chunks, |d| = chunk length in tokens and
// avgdl = mean chunk length. Query terms are deduplicated; ties keep insertion order. The stop words
// come from the language packs (core/lang).
import { fromPacks, languagePack } from '../core/lang/index.js';

export const BM25_PARAMS = Object.freeze({ k1: 1.2, b: 0.75 });

/** English function words that carry no retrieval signal. */
export const STOPWORDS_EN = new Set(languagePack('en')?.stopwords);

/** German function words that carry no retrieval signal. */
export const STOPWORDS_DE = new Set(languagePack('de')?.stopwords);

/**
 * Function words of the built-in languages. tokenize() also drops those of a language pack
 * registered later (registerLanguage in core/lang/index.js); register it before indexing.
 */
export const STOPWORDS = new Set([...STOPWORDS_EN, ...STOPWORDS_DE]);

/** Function words of every registered language pack. */
const stopwords = fromPacks((packs) => new Set(packs.flatMap((p) => p.stopwords)));

/**
 * Lowercases, applies Unicode NFKC, strips punctuation and drops stopwords and single characters.
 * The Turkish capital "İ" becomes "i" (toLowerCase() would add a combining dot to it).
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const words = text.normalize('NFKC').replace(/İ/g, 'i').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];
  const skip = stopwords();
  return words.filter((w) => w.length >= 2 && !skip.has(w));
}

/**
 * @typedef {object} IndexedChunk
 * @property {string} docId
 * @property {string} docName
 * @property {number} chunkIndex  0-based
 * @property {number} start
 * @property {number} end
 * @property {string} text
 */

/**
 * @typedef {object} SearchHit
 * @property {IndexedChunk} chunk
 * @property {number} score        BM25 score (unrounded)
 * @property {string[]} matchedTerms query terms present in the chunk
 */

/** @typedef {IndexedChunk & { tf: Map<string, number>, length: number }} Entry */

export class BM25Index {
  /**
   * @param {{ k1?: number, b?: number }} [params]
   */
  constructor(params = {}) {
    this.k1 = params.k1 ?? BM25_PARAMS.k1;
    this.b = params.b ?? BM25_PARAMS.b;
    /** @type {Entry[]} */
    this.entries = [];
    /** @type {Map<string, number>} term -> number of chunks containing it */
    this.df = new Map();
    this.totalLength = 0;
  }

  get size() {
    return this.entries.length;
  }

  get avgdl() {
    return this.entries.length ? this.totalLength / this.entries.length : 0;
  }

  /** @param {IndexedChunk[]} chunks */
  add(chunks) {
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      /** @type {Map<string, number>} */
      const tf = new Map();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      this.entries.push({ ...chunk, tf, length: tokens.length });
      this.totalLength += tokens.length;
    }
  }

  /**
   * Removes every chunk of a document.
   * @param {string} docId
   * @returns {number} removed chunk count
   */
  remove(docId) {
    const kept = [];
    let removed = 0;
    for (const entry of this.entries) {
      if (entry.docId !== docId) {
        kept.push(entry);
        continue;
      }
      removed += 1;
      this.totalLength -= entry.length;
      for (const term of entry.tf.keys()) {
        const n = (this.df.get(term) ?? 0) - 1;
        if (n > 0) this.df.set(term, n);
        else this.df.delete(term);
      }
    }
    this.entries = kept;
    return removed;
  }

  clear() {
    this.entries = [];
    this.df.clear();
    this.totalLength = 0;
  }

  /** @param {string} term */
  idf(term) {
    const n = this.entries.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * @param {string} query
   * @param {number} [topK]
   * @param {(docId: string) => boolean} [accept]  only chunks of the documents it accepts (the
   *   statistics stay those of the whole index)
   * @returns {SearchHit[]}
   */
  search(query, topK = 5, accept) {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.entries.length === 0 || topK <= 0) return [];
    const avgdl = this.avgdl || 1;
    const idf = new Map(terms.map((term) => [term, this.idf(term)]));

    /** @type {Array<SearchHit & { order: number }>} */
    const scored = [];
    this.entries.forEach((entry, order) => {
      if (accept && !accept(entry.docId)) return;
      let score = 0;
      /** @type {string[]} */
      const matched = [];
      for (const term of terms) {
        const tf = entry.tf.get(term);
        if (!tf) continue;
        const norm = tf + this.k1 * (1 - this.b + (this.b * entry.length) / avgdl);
        score += (idf.get(term) ?? 0) * ((tf * (this.k1 + 1)) / norm);
        matched.push(term);
      }
      if (score > 0) {
        /** @type {IndexedChunk} */
        const chunk = { docId: entry.docId, docName: entry.docName, chunkIndex: entry.chunkIndex, start: entry.start, end: entry.end, text: entry.text };
        scored.push({ chunk, score, matchedTerms: matched, order });
      }
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored.slice(0, topK).map(({ order: _order, ...hit }) => hit);
  }
}
