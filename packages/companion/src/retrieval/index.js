// @ts-check
// The search index of the companion: notes and documents cut into passages, ranked by keywords
// (BM25) and, when an embedding server on this machine is configured, also by meaning; the two
// rankings are fused with reciprocal rank fusion. Chunking, BM25, the vector index and the fusion
// are those of @starpi/core, so a passage the companion cites is cut exactly like one the app
// cuts in the browser.
//
// The index lives in memory only; it is rebuilt from the sealed vault when the companion starts.
// Vectors are made in the background lane after an entry is added, a few passages at a time, and
// a search never waits for them: a passage without a vector is still found by its words. Every
// entry carries its data class, and a search names the most protected class it may return, so a
// passage of a secret note never reaches a prompt.
import { BM25Index, chunkText, fuseRrf, HYBRID_DEPTH, quantizeInt8, RRF_K, VectorIndex } from '@starpi/core';
import { classRank } from '../contracts/data-classes.js';
import { codeOf } from '../lib/errors.js';

/** The collections the standard modules fill. */
export const COLLECTIONS = Object.freeze(['documents', 'notes']);
/** Passages per embedding job, so the background lane can yield in between. */
export const EMBED_STEP = 16;
/** Longest text the index takes for one entry. */
export const MAX_ENTRY_CHARS = 5_000_000;

/** @typedef {'documents' | 'notes'} Collection */

/**
 * @typedef {object} EntryInput
 * @property {string} id                 unique over all collections
 * @property {Collection} collection
 * @property {string} title              shown with a passage (a file name, a note's title)
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {string} text
 */

/**
 * @typedef {object} Passage
 * @property {string} id
 * @property {Collection} collection
 * @property {string} title
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {number} chunk              0-based index of the passage in its entry
 * @property {number} start              offsets in the entry's text
 * @property {number} end
 * @property {string} text
 * @property {number} score              fused score (or the keyword score when only keywords ran)
 * @property {number | null} keywordScore
 * @property {number | null} similarity
 */

/**
 * @param {object} [options]
 * @param {import('./embedder.js').Embedder | null} [options.embedder]
 * @param {import('../scheduler/scheduler.js').Scheduler | null} [options.scheduler]
 * @param {import('../lib/log.js').Logger} [options.log]
 * @param {number} [options.chunkSize]
 * @param {number} [options.chunkOverlap]
 */
export function createRetrieval({ embedder = null, scheduler = null, log = () => {}, chunkSize, chunkOverlap } = {}) {
  const keywords = new BM25Index();
  /** @type {VectorIndex | null} */
  let vectors = null;
  /** @type {Map<string, { id: string, collection: Collection, title: string, dataClass: import('../contracts/data-classes.js').DataClass, chunks: Array<{ index: number, start: number, end: number, text: string }>, generation: number }>} */
  const entries = new Map();
  /** Entries whose passages still need vectors: id -> generation. */
  const waiting = new Map();
  let generation = 0;
  let embedding = false;
  let stopped = false;
  /** @type {'off' | 'ready' | 'failing'} */
  let denseState = embedder ? 'ready' : 'off';

  /** Runs the vector jobs one after another in the background lane. */
  function pumpVectors() {
    if (!embedder || !scheduler || embedding || stopped || waiting.size === 0) return;
    embedding = true;
    scheduler
      .run('background', 'retrieval.embed', async (job) => {
        const embed = /** @type {import('./embedder.js').Embedder} */ (embedder);
        for (const [id, gen] of [...waiting]) {
          if (job.signal.aborted || stopped) return;
          const entry = entries.get(id);
          if (!entry || entry.generation !== gen) {
            waiting.delete(id);
            continue;
          }
          for (let i = 0; i < entry.chunks.length; i += EMBED_STEP) {
            const part = entry.chunks.slice(i, i + EMBED_STEP);
            const found = await embed.embedPassages(part.map((c) => c.text), { signal: job.signal });
            if (entries.get(id)?.generation !== gen) break;
            for (const [k, vec] of found.entries()) {
              vectors ??= new VectorIndex(embed.model, vec.length);
              const { data, scale } = quantizeInt8(vec);
              vectors.add(id, part[k].index, data, scale);
            }
            if (job.shouldYield()) await new Promise((resolve) => setImmediate(resolve));
          }
          waiting.delete(id);
        }
        denseState = 'ready';
      })
      .catch((err) => {
        denseState = 'failing';
        log('warn', 'embed_failed', { code: codeOf(err) });
      })
      .finally(() => {
        embedding = false;
        // A failing server is tried again only when new entries arrive.
        if (denseState === 'ready') pumpVectors();
      });
  }

  /** @param {string} id */
  function remove(id) {
    if (!entries.has(id)) return false;
    keywords.remove(id);
    vectors?.remove(id);
    entries.delete(id);
    waiting.delete(id);
    return true;
  }

  /**
   * Adds an entry, or replaces the one with its id.
   * @param {EntryInput} input
   */
  function put(input) {
    remove(input.id);
    const text = input.text.length > MAX_ENTRY_CHARS ? input.text.slice(0, MAX_ENTRY_CHARS) : input.text;
    const chunks = chunkText(text, { chunkSize, chunkOverlap }).map((c) => ({ index: c.index, start: c.start, end: c.end, text: c.text }));
    generation += 1;
    entries.set(input.id, { id: input.id, collection: input.collection, title: input.title, dataClass: input.dataClass, chunks, generation });
    keywords.add(chunks.map((c) => ({ docId: input.id, docName: input.title, chunkIndex: c.index, start: c.start, end: c.end, text: c.text })));
    if (embedder && chunks.length > 0) {
      waiting.set(input.id, generation);
      if (denseState === 'failing') denseState = 'ready';
      pumpVectors();
    }
    return { chunks: chunks.length };
  }

  /**
   * Changes the data class of an entry without cutting it again.
   * @param {string} id
   * @param {import('../contracts/data-classes.js').DataClass} dataClass
   */
  function reclassify(id, dataClass) {
    const entry = entries.get(id);
    if (entry) entry.dataClass = dataClass;
    return Boolean(entry);
  }

  /**
   * Passages for a question, best first.
   * @param {string} query
   * @param {{ k?: number, collections?: readonly Collection[], maxClass?: import('../contracts/data-classes.js').DataClass, ids?: ReadonlySet<string>, signal?: AbortSignal }} [options]
   * @returns {Promise<{ passages: Passage[], dense: 'used' | 'off' | 'unavailable' }>}
   */
  async function search(query, { k = 6, collections = COLLECTIONS, maxClass = 'sensitive', ids, signal } = {}) {
    const allowed = (/** @type {string} */ id) => {
      const entry = entries.get(id);
      return Boolean(entry && collections.includes(entry.collection) && classRank(entry.dataClass) <= classRank(maxClass) && (!ids || ids.has(id)));
    };
    const keyOf = (/** @type {string} */ id, /** @type {number} */ chunk) => `${id}#${chunk}`;
    const depth = Math.max(HYBRID_DEPTH, k * 4);
    const keywordHits = keywords.search(query, depth * 4).filter((h) => allowed(h.chunk.docId)).slice(0, depth);
    /** @type {Map<string, number>} */
    const keywordScore = new Map(keywordHits.map((h) => [keyOf(h.chunk.docId, h.chunk.chunkIndex), h.score]));
    /** @type {Map<string, number>} */
    const similarity = new Map();
    /** @type {'used' | 'off' | 'unavailable'} */
    let dense = 'off';
    /** @type {string[][]} */
    const rankings = [keywordHits.map((h) => keyOf(h.chunk.docId, h.chunk.chunkIndex))];
    if (embedder && vectors && vectors.size > 0) {
      try {
        const vec = await embedder.embedQuery(query, { signal });
        const semantic = vectors.search(vec, depth * 4).filter((h) => allowed(h.docId)).slice(0, depth);
        for (const h of semantic) similarity.set(keyOf(h.docId, h.idx), h.score);
        rankings.push(semantic.map((h) => keyOf(h.docId, h.idx)));
        dense = 'used';
      } catch (err) {
        dense = 'unavailable';
        log('info', 'dense_skipped', { code: codeOf(err) });
      }
    }
    const fused = rankings.length > 1 ? fuseRrf(rankings, { k: RRF_K }) : rankings[0].map((key) => ({ key, score: keywordScore.get(key) ?? 0 }));
    /** @type {Passage[]} */
    const passages = [];
    for (const f of fused) {
      if (passages.length >= k) break;
      const cut = f.key.lastIndexOf('#');
      const entry = entries.get(f.key.slice(0, cut));
      const chunk = entry?.chunks[Number(f.key.slice(cut + 1))];
      if (!entry || !chunk) continue;
      passages.push({
        id: entry.id,
        collection: entry.collection,
        title: entry.title,
        dataClass: entry.dataClass,
        chunk: chunk.index,
        start: chunk.start,
        end: chunk.end,
        text: chunk.text,
        score: f.score,
        keywordScore: keywordScore.get(f.key) ?? null,
        similarity: similarity.get(f.key) ?? null,
      });
    }
    return { passages, dense };
  }

  return {
    put,
    remove,
    reclassify,
    search,
    /** @param {string} id */
    has: (id) => entries.has(id),
    /**
     * One passage of an entry, as it would be cited.
     * @param {string} id
     * @param {number} chunk
     */
    passage(id, chunk) {
      const entry = entries.get(id);
      const c = entry?.chunks[chunk];
      return entry && c ? { id, collection: entry.collection, title: entry.title, dataClass: entry.dataClass, chunk: c.index, start: c.start, end: c.end, text: c.text, total: entry.chunks.length } : null;
    },
    /** Ids of the entries of a collection. @param {Collection} collection */
    ids: (collection) => [...entries.values()].filter((e) => e.collection === collection).map((e) => e.id),
    stats() {
      /** @type {Record<string, number>} */
      const byCollection = {};
      for (const e of entries.values()) byCollection[e.collection] = (byCollection[e.collection] ?? 0) + 1;
      return { entries: entries.size, passages: keywords.size, vectors: vectors?.size ?? 0, waiting: waiting.size, collections: byCollection, dense: embedder ? { ...embedder.describe(), state: denseState } : null };
    },
    /** Waits until no vector job is queued or running (tests, shutdown). */
    async settle() {
      for (let i = 0; i < 2000 && (embedding || (waiting.size > 0 && denseState === 'ready')); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    },
    stop() {
      stopped = true;
      waiting.clear();
    },
  };
}

/** @typedef {ReturnType<typeof createRetrieval>} Retrieval */
