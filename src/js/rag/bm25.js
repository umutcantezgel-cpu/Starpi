// @ts-check
// In-memory Okapi BM25 index over document chunks (English + German).
//
//   score(q, d) = Σ_t idf(t) · tf(t,d)·(k1 + 1) / (tf(t,d) + k1·(1 − b + b·|d|/avgdl))
//   idf(t)      = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))      (non-negative variant)
//
// with k1 = 1.2 and b = 0.75, N = number of indexed chunks, |d| = chunk length in tokens and
// avgdl = mean chunk length. Query terms are deduplicated; ties keep insertion order.

export const BM25_PARAMS = Object.freeze({ k1: 1.2, b: 0.75 });

/** English and German function words that carry no retrieval signal. */
export const STOPWORDS = new Set([
  // English
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be',
  'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me',
  'more', 'most', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours',
  'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your', 'yours',
  // German
  'aber', 'alle', 'allem', 'allen', 'aller', 'alles', 'als', 'also', 'an', 'andere', 'anderen', 'auch', 'auf',
  'aus', 'bei', 'beim', 'bin', 'bis', 'bist', 'da', 'damit', 'dann', 'das', 'dass', 'dein', 'deine', 'dem', 'den',
  'denn', 'der', 'des', 'dessen', 'dich', 'die', 'dies', 'diese', 'diesem', 'diesen', 'dieser', 'dieses', 'dir',
  'doch', 'dort', 'du', 'durch', 'ein', 'eine', 'einem', 'einen', 'einer', 'eines', 'er', 'es', 'etwas', 'euch',
  'euer', 'eure', 'für', 'gegen', 'gibt', 'hab', 'habe', 'haben', 'hat', 'hatte', 'hatten', 'hier', 'hin',
  'ich', 'ihm', 'ihn', 'ihr', 'ihre', 'ihrem', 'ihren', 'ihrer', 'im', 'in', 'ins', 'ist', 'ja', 'jede', 'jedem',
  'jeden', 'jeder', 'jedes', 'jetzt', 'kann', 'kein', 'keine', 'können', 'man', 'mein', 'meine', 'mich', 'mir',
  'mit', 'muss', 'nach', 'nicht', 'nichts', 'noch', 'nun', 'nur', 'ob', 'oder', 'ohne', 'sehr', 'sein', 'seine',
  'sich', 'sie', 'sind', 'so', 'soll', 'sollte', 'sondern', 'um', 'und', 'uns', 'unser', 'unsere', 'unter', 'vom',
  'von', 'vor', 'wann', 'war', 'waren', 'warum', 'was', 'weil', 'welche', 'welchem', 'welchen', 'welcher',
  'welches', 'wenn', 'wer', 'werde', 'werden', 'wie', 'wieder', 'will', 'wir', 'wird', 'wo', 'wurde', 'wurden',
  'zu', 'zum', 'zur', 'über',
]);

/**
 * Lowercases, applies Unicode NFKC, strips punctuation and drops stopwords and single characters.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
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
   * @returns {SearchHit[]}
   */
  search(query, topK = 5) {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.entries.length === 0 || topK <= 0) return [];
    const avgdl = this.avgdl || 1;
    const idf = new Map(terms.map((term) => [term, this.idf(term)]));

    /** @type {Array<SearchHit & { order: number }>} */
    const scored = [];
    this.entries.forEach((entry, order) => {
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
