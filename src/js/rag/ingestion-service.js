// @ts-check
// Client-side Ingestion and BM25 Retrieval Service.
// Manages the background worker, in-memory chunk catalog, and citation lookups.

import { BM25Index } from './bm25.js';
import { chunkText } from './chunker.js';
import { parseDocumentFile } from './parser.js';

/** Replaced at build time with the hashed worker URL (scripts/build.mjs). */
const INGEST_WORKER_URL = '__STARPI_INGEST_WORKER_URL__';

/** @type {Worker | null} */
let worker = null;
let msgSeq = 0;
/** @type {Map<number, { resolve: (val: any) => void, reject: (err: any) => void }>} */
const pendingRequests = new Map();

/** Fallback local index used in test environments without worker support or if worker errors */
const fallbackIndex = new BM25Index();

/** In-memory store of all indexed chunks for instant citation retrieval */
/** @type {Map<string, import('./bm25.js').ChunkDocument>} */
const chunkStore = new Map();

/**
 * Initializes the ingestion worker.
 */
function getWorker() {
  if (worker) return worker;
  if (typeof Worker !== 'undefined' && INGEST_WORKER_URL && !INGEST_WORKER_URL.startsWith('__')) {
    try {
      worker = new Worker(INGEST_WORKER_URL, { type: 'module' });
      worker.onmessage = (event) => {
        const { id, type, payload, error } = event.data || {};
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);

        if (type === 'ERROR' || error) {
          pending.reject(new Error(error || 'Worker error'));
        } else {
          pending.resolve(payload);
        }
      };
      worker.onerror = (err) => {
        console.warn('[ingestion-service] Worker error, falling back to main-thread execution', err);
        worker = null;
      };
      return worker;
    } catch (e) {
      console.warn('[ingestion-service] Could not spawn worker, using main-thread fallback', e);
      worker = null;
    }
  }
  return null;
}

/**
 * Sends a message to the worker or executes the fallback handler.
 * @param {string} type
 * @param {any} payload
 * @param {() => Promise<any>} fallbackHandler
 * @returns {Promise<any>}
 */
function callWorker(type, payload, fallbackHandler) {
  const w = getWorker();
  if (!w) {
    return fallbackHandler();
  }

  const id = ++msgSeq;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    w.postMessage({ id, type, payload });
  });
}

/**
 * Parses and chunks a file or text content.
 *
 * @param {File | { name: string, arrayBuffer: () => Promise<ArrayBuffer>, text: () => Promise<string> }} file
 * @param {object} [options]
 * @param {number} [options.chunkSize=500]
 * @param {number} [options.chunkOverlap=50]
 * @returns {Promise<{ title: string, rawText: string, chunks: import('./chunker.js').TextChunk[], chunkCount: number }>}
 */
export async function parseAndChunkDocument(file, options = {}) {
  const parsed = await parseDocumentFile(file);
  const chunks = chunkText(parsed.text, options);

  return {
    title: parsed.title,
    rawText: parsed.text,
    chunks,
    chunkCount: chunks.length,
  };
}

/**
 * Indexes chunks into the BM25 retrieval engine and in-memory citation store.
 *
 * @param {string} docTitle
 * @param {string} docId
 * @param {import('./chunker.js').TextChunk[]} rawChunks
 * @returns {Promise<number>} Number of indexed chunks
 */
export async function indexDocumentChunks(docTitle, docId, rawChunks) {
  /** @type {import('./bm25.js').ChunkDocument[]} */
  const chunkDocs = rawChunks.map((c) => ({
    id: `${docId}_chunk_${c.id}`,
    documentId: docId,
    documentTitle: docTitle,
    chunkIndex: c.id,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    content: c.text,
  }));

  for (const cd of chunkDocs) {
    chunkStore.set(cd.id, cd);
    // Also store by simplified reference: "docTitle:chunkIndex"
    chunkStore.set(`${docTitle}:${cd.chunkIndex}`, cd);
  }

  await callWorker(
    'INDEX_CHUNKS',
    { chunks: chunkDocs },
    async () => {
      fallbackIndex.addDocuments(chunkDocs);
      return { totalIndexedDocs: fallbackIndex.docs.length };
    },
  );

  return chunkDocs.length;
}

/**
 * Queries the BM25 index and returns Top-K scored chunks.
 *
 * @param {string} query
 * @param {number} [topK=5]
 * @param {number} [minScore=0.01]
 * @returns {Promise<import('./bm25.js').ScoredChunk[]>}
 */
export async function searchLocalBM25(query, topK = 5, minScore = 0.01) {
  const res = await callWorker(
    'SEARCH_BM25',
    { query, topK, minScore },
    async () => {
      return { results: fallbackIndex.search(query, topK, minScore) };
    },
  );

  return res.results || [];
}

/**
 * Retrieves a chunk by its document title and chunk index (for citations).
 * @param {string} docTitle
 * @param {number | string} chunkIndex
 * @returns {import('./bm25.js').ChunkDocument | undefined}
 */
export function getCitationChunk(docTitle, chunkIndex) {
  return chunkStore.get(`${docTitle}:${chunkIndex}`);
}

/**
 * Returns all stored chunks.
 * @returns {import('./bm25.js').ChunkDocument[]}
 */
export function getAllStoredChunks() {
  const seen = new Set();
  const out = [];
  for (const c of chunkStore.values()) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}
