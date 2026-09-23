// @ts-check
// Main-thread client for the ingestion worker (src/js/rag/ingest.worker.js). The worker owns the
// documents and the BM25 index; this module keeps only the document list for rendering. If the
// worker crashes, pending requests reject and the workspace is reported empty (its memory is gone).

/** Replaced at build time with the hashed worker URL (scripts/build.mjs). */
const INGEST_WORKER_URL = '__STARPI_INGEST_WORKER_URL__';

/** @typedef {{ docId: string, name: string, kind: string, chars: number, chunks: number, pages: number | null }} WorkspaceDocument */
/**
 * @typedef {object} WorkspaceHit
 * @property {string} docId
 * @property {string} docName
 * @property {number} chunkIndex
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {number} score
 * @property {string[]} matchedTerms
 */
/** @typedef {{ stage: string, done: number, total: number }} Progress */

export class WorkspaceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string | number>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.details = details ?? {};
  }
}

/** @type {Worker | null} */
let worker = null;
let seq = 0;
/** @type {Map<number, { resolve: (value: any) => void, reject: (err: Error) => void, onProgress?: (p: Progress) => void }>} */
const pending = new Map();
/** @type {WorkspaceDocument[]} */
let docs = [];
/** @type {Set<(docs: WorkspaceDocument[]) => void>} */
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(docs);
}

/** @param {Error} reason */
function failAll(reason) {
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
}

function reset() {
  worker?.terminate();
  worker = null;
  if (docs.length) {
    docs = [];
    notify();
  }
}

function getWorker() {
  if (worker) return worker;
  const w = new Worker(new URL(INGEST_WORKER_URL, location.href), { type: 'module', name: 'starpi-ingest' });
  w.addEventListener('message', (event) => {
    const msg = /** @type {{ id: number, ok?: boolean, result?: any, error?: { code: string, message: string, details?: Record<string, string | number> }, progress?: Progress }} */ (event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.progress) {
      entry.onProgress?.(msg.progress);
      return;
    }
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new WorkspaceError(msg.error?.code ?? 'internal', msg.error?.message ?? 'Worker error', msg.error?.details));
  });
  const crash = (/** @type {Event} */ event) => {
    console.error('[starpi] ingestion worker failed', event);
    failAll(new WorkspaceError('worker_crashed', 'The document worker stopped'));
    reset();
  };
  w.addEventListener('error', crash);
  w.addEventListener('messageerror', crash);
  worker = w;
  return w;
}

/**
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {(p: Progress) => void} [onProgress]
 * @returns {Promise<any>}
 */
function request(type, payload, onProgress) {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, type, payload });
  });
}

/** @returns {WorkspaceDocument[]} */
export function listWorkspace() {
  return docs;
}

export function hasWorkspaceDocuments() {
  return docs.length > 0;
}

/** @param {(docs: WorkspaceDocument[]) => void} fn */
export function onWorkspaceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Parses, chunks and indexes a file in the worker. The File is structured-cloned (no copy of its
 * bytes on this thread).
 * @param {File} file
 * @param {{ chunkSize?: number, chunkOverlap?: number, onProgress?: (p: Progress) => void }} [options]
 * @returns {Promise<WorkspaceDocument>}
 */
export async function addToWorkspace(file, options = {}) {
  const doc = /** @type {WorkspaceDocument} */ (
    await request('ingest', { file, chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap }, options.onProgress)
  );
  docs = [...docs, doc];
  notify();
  return doc;
}

/**
 * Top-K BM25 search. Resolves to [] when the workspace is empty (no worker is started for that).
 * @param {string} query
 * @param {number} [topK]
 * @returns {Promise<WorkspaceHit[]>}
 */
export async function searchWorkspace(query, topK = 5) {
  if (!docs.length || !query.trim()) return [];
  return request('search', { query, topK });
}

/**
 * The first chunks of a document (used when a freshly attached file does not match the question).
 * @param {string} docId
 * @param {number} [count]
 * @returns {Promise<WorkspaceHit[]>}
 */
export function firstChunks(docId, count = 3) {
  return request('head', { docId, count });
}

/**
 * Source text around a chunk, for the citation drawer.
 * @param {string} docId
 * @param {number} start
 * @param {number} end
 * @returns {Promise<{ before: string, match: string, after: string, start: number, end: number, length: number }>}
 */
export function getChunkContext(docId, start, end) {
  return request('context', { docId, start, end, pad: 400 });
}

/**
 * @param {string} docId
 * @returns {Promise<{ name: string, text: string }>}
 */
export function getDocumentText(docId) {
  return request('text', { docId });
}

/** @param {string} docId */
export async function removeFromWorkspace(docId) {
  await request('remove', { docId });
  docs = docs.filter((d) => d.docId !== docId);
  notify();
}

/** Discards every document: the worker (and its memory) is terminated. */
export function clearWorkspace() {
  failAll(new WorkspaceError('cleared', 'Workspace cleared'));
  reset();
}
