// @ts-check
// Production-grade deterministic Okapi BM25 ranking engine.
// Parameters: k1 = 1.2, b = 0.75.
// Supports multilingual tokenization (EN + DE), stopword filtering,
// Robertson-Spärck Jones IDF, and term-frequency normalization.

export const BM25_PARAMS = {
  k1: 1.2,
  b: 0.75,
};

/**
 * Comprehensive bilingual stopword set (English + German).
 */
export const STOPWORDS = new Set([
  // English
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'cannot', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'isn', 'it', 'its', 'itself', 'just', 'me',
  'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or',
  'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasn',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you',
  // German
  'aber', 'alle', 'allem', 'allen', 'aller', 'alles', 'als', 'also', 'am', 'an', 'ander', 'andere',
  'anderem', 'anderen', 'anderer', 'anderes', 'anderm', 'andern', 'anderr', 'anders', 'auch', 'auf',
  'aus', 'bei', 'beide', 'beiden', 'beider', 'beides', 'beim', 'bereits', 'bin', 'bis', 'bist', 'da',
  'damit', 'dann', 'darf', 'darfst', 'darin', 'das', 'dass', 'daß', 'dein', 'deine', 'deinem', 'deinen',
  'deiner', 'deines', 'dem', 'demselben', 'den', 'denn', 'denselben', 'der', 'dere', 'derem', 'deren',
  'derer', 'derselbe', 'derselben', 'des', 'desselben', 'dessen', 'dich', 'die', 'dies', 'diese',
  'dieselbe', 'dieselben', 'diesem', 'diesen', 'dieser', 'dieses', 'dir', 'doch', 'dort', 'du', 'durch',
  'ein', 'eine', 'einem', 'einen', 'einer', 'eines', 'einig', 'einige', 'einigem', 'einigen', 'einiger',
  'einiges', 'einmal', 'er', 'es', 'etwas', 'euch', 'euer', 'eure', 'eurem', 'euren', 'eurer', 'eures',
  'für', 'gab', 'ganz', 'ganze', 'ganzem', 'ganzen', 'ganzer', 'ganzes', 'gar', 'gegen', 'gemacht',
  'gibt', 'ging', 'hab', 'habe', 'haben', 'habt', 'hat', 'hatte', 'hatten', 'hattest', 'hattet', 'hier',
  'hin', 'hinter', 'ich', 'ihm', 'ihn', 'ihr', 'ihre', 'ihrem', 'ihren', 'ihrer', 'ihres', 'im', 'immer',
  'in', 'indem', 'ins', 'ist', 'ja', 'jede', 'jedem', 'jeden', 'jeder', 'jedes', 'jedoch', 'jene',
  'jenem', 'jenen', 'jener', 'jenes', 'jetzt', 'kann', 'kannst', 'können', 'könnt', 'machen', 'man',
  'manche', 'manchem', 'manchen', 'mancher', 'manches', 'mein', 'meine', 'meinem', 'meinen', 'meiner',
  'meines', 'mich', 'mir', 'mit', 'muss', 'musst', 'nach', 'nicht', 'nichts', 'noch', 'nun', 'nur',
  'oder', 'ohne', 'sehr', 'sein', 'seine', 'seinem', 'seinen', 'seiner', 'seines', 'selbst', 'sich',
  'sie', 'sind', 'so', 'solche', 'solchem', 'solchen', 'solcher', 'solches', 'soll', 'sollte', 'sondern',
  'sonst', 'um', 'und', 'uns', 'unser', 'unsere', 'unserem', 'unseren', 'unserer', 'unseres', 'unter',
  'vom', 'von', 'vor', 'wann', 'war', 'waren', 'warst', 'was', 'weg', 'weil', 'weiter', 'weitere',
  'welche', 'welchem', 'welchen', 'welcher', 'welches', 'wenn', 'wer', 'werde', 'werden', 'werdet',
  'wie', 'wieder', 'will', 'wir', 'wird', 'wirst', 'wo', 'wolle', 'wollte', 'während', 'zu', 'zum',
  'zur', 'zwar', 'zwischen', 'über'
]);

/**
 * Tokenizes text into normalized word stems/tokens.
 * Removes punctuation, normalizes unicode (NFKC), lowercases, and strips stopwords.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeBM25(text) {
  if (!text || typeof text !== 'string') return [];
  const normalized = text.toLowerCase().normalize('NFKC');
  const rawWords = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return rawWords.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * @typedef {object} ChunkDocument
 * @property {string} id - Unique chunk ID (e.g. "doc-1_chunk-0")
 * @property {string} documentId - Parent document identifier
 * @property {string} documentTitle - Parent document filename or title
 * @property {number} chunkIndex - 0-indexed chunk sequence number
 * @property {number} startOffset - Character start index in source document
 * @property {number} endOffset - Character end index in source document
 * @property {string} content - Full text of this chunk
 * @property {string[]} [tokens] - Pre-computed tokens
 */

/**
 * @typedef {object} ScoredChunk
 * @property {ChunkDocument} chunk
 * @property {number} score - Real BM25 relevance score
 * @property {string[]} matchedTerms - Query terms present in this chunk
 */

export class BM25Index {
  /**
   * @param {number} [k1]
   * @param {number} [b]
   */
  constructor(k1 = BM25_PARAMS.k1, b = BM25_PARAMS.b) {
    this.k1 = k1;
    this.b = b;

    /** @type {ChunkDocument[]} */
    this.docs = [];
    /** @type {number[]} Document lengths in token count */
    this.docLengths = [];
    /** @type {number} */
    this.avgDocLength = 0;
    /** @type {Map<string, number>} Document Frequency (df): term -> number of docs containing term */
    this.df = new Map();
    /** @type {Map<string, number>} Precomputed Inverse Document Frequency (IDF) */
    this.idf = new Map();
    /** @type {Array<Map<string, number>>} Term frequencies per document */
    this.termFreqs = [];
  }

  /**
   * Clears the index.
   */
  clear() {
    this.docs = [];
    this.docLengths = [];
    this.avgDocLength = 0;
    this.df.clear();
    this.idf.clear();
    this.termFreqs = [];
  }

  /**
   * Adds an array of chunk documents and builds/rebuilds the index.
   * @param {ChunkDocument[]} chunks
   */
  addDocuments(chunks) {
    for (const chunk of chunks) {
      const tokens = chunk.tokens ?? tokenizeBM25(chunk.content);
      const tfMap = new Map();
      const uniqueTerms = new Set();

      for (const t of tokens) {
        tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
        uniqueTerms.add(t);
      }

      this.docs.push({ ...chunk, tokens });
      this.docLengths.push(tokens.length);
      this.termFreqs.push(tfMap);

      for (const term of uniqueTerms) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }

    this._recomputeStats();
  }

  /**
   * Recomputes average document length and IDF values.
   * Uses standard Robertson-Spärck Jones formula:
   * idf(t) = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
   * @private
   */
  _recomputeStats() {
    const N = this.docs.length;
    if (N === 0) {
      this.avgDocLength = 0;
      this.idf.clear();
      return;
    }

    const totalLength = this.docLengths.reduce((acc, len) => acc + len, 0);
    this.avgDocLength = totalLength / N;

    this.idf.clear();
    for (const [term, freq] of this.df.entries()) {
      // Standard Okapi BM25 IDF with +1 smoothing so IDF >= 0
      const score = Math.log((N - freq + 0.5) / (freq + 0.5) + 1.0);
      this.idf.set(term, Math.max(0, score));
    }
  }

  /**
   * Computes BM25 score of a single term in a document.
   * @param {string} term
   * @param {number} docIndex
   * @returns {number}
   */
  scoreTerm(term, docIndex) {
    const idfVal = this.idf.get(term) ?? 0;
    if (idfVal <= 0) return 0;

    const tfMap = this.termFreqs[docIndex];
    const tf = tfMap?.get(term) ?? 0;
    if (tf <= 0) return 0;

    const docLen = this.docLengths[docIndex];
    const avgdl = this.avgDocLength || 1;
    const numerator = tf * (this.k1 + 1);
    const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / avgdl));

    return idfVal * (numerator / denominator);
  }

  /**
   * Searches the index with a text query and returns Top-K scored chunks.
   *
   * @param {string} query
   * @param {number} [topK=5]
   * @param {number} [minScore=0.01]
   * @returns {ScoredChunk[]}
   */
  search(query, topK = 5, minScore = 0.01) {
    const queryTerms = tokenizeBM25(query);
    if (queryTerms.length === 0 || this.docs.length === 0) return [];

    /** @type {ScoredChunk[]} */
    const results = [];

    for (let i = 0; i < this.docs.length; i++) {
      let totalScore = 0;
      const matchedTerms = [];

      for (const term of queryTerms) {
        const score = this.scoreTerm(term, i);
        if (score > 0) {
          totalScore += score;
          matchedTerms.push(term);
        }
      }

      if (totalScore >= minScore) {
        // Round to 4 decimal places for clean numerical representation
        const roundedScore = Math.round(totalScore * 10000) / 10000;
        results.push({
          chunk: this.docs[i],
          score: roundedScore,
          matchedTerms: [...new Set(matchedTerms)],
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}
