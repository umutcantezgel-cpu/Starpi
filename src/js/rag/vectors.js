// @ts-check
// Embedding vectors of workspace chunks: int8 quantisation for storage and an in-memory index for
// cosine search. Pure, so the ingest worker and the unit tests share it.
//
// Quantisation is symmetric per vector: scale = max|v| / 127 and data[i] = round(v[i] / scale), so
// v[i] ≈ data[i] * scale. Cosine similarity does not depend on the scale (it cancels), so the index
// compares a float query with the int8 data directly; the scale is kept for anyone who needs the
// values back (dequantize).

/** @typedef {import('../store/schema.js').VectorRecord} VectorRecord */

/**
 * @typedef {object} VectorHit
 * @property {string} docId
 * @property {number} idx  chunk index within the document
 * @property {number} score  cosine similarity, -1..1
 */

/**
 * @param {ArrayLike<number>} vec
 * @returns {{ data: Int8Array, scale: number }}
 */
export function quantizeInt8(vec) {
  let max = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const a = Math.abs(vec[i]);
    if (a > max) max = a;
  }
  const data = new Int8Array(vec.length);
  if (!(max > 0) || !Number.isFinite(max)) return { data, scale: 0 };
  const scale = max / 127;
  for (let i = 0; i < vec.length; i += 1) data[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)));
  return { data, scale };
}

/**
 * @param {Int8Array} data
 * @param {number} scale
 * @returns {Float32Array}
 */
export function dequantize(data, scale) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data[i] * scale;
  return out;
}

/**
 * @param {ArrayLike<number>} vec
 * @returns {number}
 */
export function norm(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  return Math.sqrt(sum);
}

/**
 * Cosine similarity; 0 when either vector is all zeros or the lengths differ.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  const n = norm(a) * norm(b);
  return n > 0 ? dot / n : 0;
}

/** @param {string} docId @param {number} idx */
export const chunkKey = (docId, idx) => `${docId}#${idx}`;

/**
 * The vectors of one model, in insertion order. Search is exhaustive (a few tens of thousands of
 * 384-dimensional int8 vectors take milliseconds); ties keep insertion order.
 */
export class VectorIndex {
  /**
   * @param {string} model  the model id every vector of this index belongs to
   * @param {number} dim
   */
  constructor(model, dim) {
    this.model = model;
    this.dim = dim;
    /** @type {Map<string, { docId: string, idx: number, data: Int8Array, scale: number, norm: number }>} */
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  /**
   * Adds or replaces the vector of one chunk. A vector of the wrong length is refused.
   * @param {string} docId
   * @param {number} idx
   * @param {Int8Array} data
   * @param {number} scale
   * @returns {boolean} whether it was added
   */
  add(docId, idx, data, scale) {
    if (!(data instanceof Int8Array) || data.length !== this.dim) return false;
    this.entries.set(chunkKey(docId, idx), { docId, idx, data, scale, norm: norm(data) });
    return true;
  }

  /**
   * @param {VectorRecord} record
   * @returns {boolean} whether it was added (records of other models are skipped)
   */
  addRecord(record) {
    if (record.model !== this.model || record.dim !== this.dim) return false;
    return this.add(record.docId, record.idx, record.data, record.scale);
  }

  /** @param {string} docId @param {number} idx */
  has(docId, idx) {
    return this.entries.has(chunkKey(docId, idx));
  }

  /**
   * Removes every vector of a document.
   * @param {string} docId
   * @returns {number} removed count
   */
  remove(docId) {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.docId !== docId) continue;
      this.entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  clear() {
    this.entries.clear();
  }

  /**
   * The k chunks most similar to the query, best first.
   * @param {ArrayLike<number>} query
   * @param {number} k
   * @param {(docId: string) => boolean} [accept]  only chunks of the documents it accepts
   * @returns {VectorHit[]}
   */
  search(query, k, accept) {
    if (query.length !== this.dim || k <= 0 || this.entries.size === 0) return [];
    const qn = norm(query);
    if (!(qn > 0)) return [];
    /** @type {Array<VectorHit & { order: number }>} */
    const scored = [];
    let order = 0;
    for (const entry of this.entries.values()) {
      if (accept && !accept(entry.docId)) continue;
      const { data } = entry;
      let dot = 0;
      for (let i = 0; i < data.length; i += 1) dot += query[i] * data[i];
      const score = entry.norm > 0 ? dot / (qn * entry.norm) : 0;
      scored.push({ docId: entry.docId, idx: entry.idx, score, order: order++ });
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored.slice(0, k).map(({ order: _order, ...hit }) => hit);
  }
}
