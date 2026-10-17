// @ts-check
// Main-thread client for the ingestion worker (src/js/rag/ingest.worker.js). The worker owns the
// documents, the BM25 index and the chunk vectors, and keeps them in the app database unless the
// user chose "memory only"; this module keeps the document list for rendering and the workspace
// state (stored or not, vectors). If the worker crashes, pending requests reject, and the next
// request starts a new worker, which restores the stored documents.
import { appDb, storeProfileName } from '../store/schema.js';
import { searchWithQueryVector } from '../retrieval.js';

/** Replaced at build time with the hashed worker URL (scripts/build.mjs). */
const INGEST_WORKER_URL = '__STARPI_INGEST_WORKER_URL__';

/**
 * A document in the workspace, as reported by the worker (DocumentInfo in workspace-core.js).
 * @typedef {object} WorkspaceDocument
 * @property {string} docId
 * @property {string} name
 * @property {string} kind
 * @property {number} chars
 * @property {number} chunks
 * @property {number | null} pages
 * @property {number} bytes
 * @property {string | null} fileSha256
 * @property {string} textSha256
 * @property {{ id: string, version: number, pdfjs: string | null }} extractor
 * @property {{ id: string, version: number, size: number, overlap: number }} chunker
 * @property {number} [addedAt]
 * @property {boolean} [stored]  kept on this device (survives a reload)
 * @property {boolean} [duplicate]  set on the reply when the same file was already in the workspace
 */
/**
 * @typedef {object} WorkspaceHit
 * @property {string} docId
 * @property {string} docName
 * @property {number} chunkIndex
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {number} score  BM25 score, or the RRF score of a hybrid search
 * @property {string[]} matchedTerms
 * @property {number | null} [keywordScore]  hybrid search: the BM25 score (null: found by meaning only)
 * @property {number | null} [similarity]  hybrid search: the cosine similarity (null: found by keywords only)
 */
/**
 * @typedef {object} WorkspaceStatus
 * @property {boolean} ready  the worker reported its state (false before the first start)
 * @property {boolean} persistent  this browser keeps the database after a reload
 * @property {boolean | null} keep  the answer to "keep files on this device"; null: not asked yet (kept)
 * @property {number} vectors  chunk vectors of the active model
 * @property {number} chunks
 * @property {string | null} model
 */
/** @typedef {import('./hybrid.js').WorkspaceProbe} WorkspaceProbe */
/** @typedef {import('./formats/image.js').OcrHook} OcrHook */
/** @typedef {{ stage: string, done: number, total: number }} Progress */
/** @typedef {{ resolve: (value: any) => void, reject: (err: Error) => void, onProgress?: (p: Progress) => void, ocr?: OcrHook }} Pending */

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
/** @type {Map<number, Pending>} */
const pending = new Map();
/** @type {WorkspaceDocument[]} */
let docs = [];
/** @type {WorkspaceStatus} */
let status = { ready: false, persistent: false, keep: null, vectors: 0, chunks: 0, model: null };
/** @type {Set<(docs: WorkspaceDocument[]) => void>} */
const listeners = new Set();
/** @type {Set<(status: WorkspaceStatus) => void>} */
const statusListeners = new Set();
/** The vector model the worker should use; sent with every (re)start. @type {{ id: string, dim: number } | null} */
let vectorModel = null;
/** Turns a question into a query vector (rag/embed-client.js), or null while semantic search is off. @type {((text: string) => Promise<Float32Array | null>) | null} */
let queryEmbedder = null;
/** @type {Promise<void> | null} */
let restoring = null;

function notify() {
  for (const fn of listeners) fn(docs);
}

/** @param {Partial<WorkspaceStatus>} next */
function setStatus(next) {
  status = { ...status, ...next };
  for (const fn of statusListeners) fn(status);
}

/** @param {Error} reason */
function failAll(reason) {
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
}

function reset() {
  worker?.terminate();
  worker = null;
  restoring = null;
  setStatus({ ready: false });
  if (docs.length) {
    docs = [];
    notify();
  }
}

/**
 * @param {{ documents: WorkspaceDocument[], persistent: boolean, keep: boolean | null, vectors: number, chunks: number, model: string | null }} state
 */
function applyState(state) {
  docs = state.documents;
  setStatus({ ready: true, persistent: state.persistent, keep: state.keep, vectors: state.vectors, chunks: state.chunks, model: state.model });
  notify();
}

/**
 * @param {Worker} w
 * @param {number} id
 * @param {Pending} entry
 * @param {{ seq: number, name: string, mime: string, width: number, height: number, purpose: string, bytes: Uint8Array }} request
 */
async function answerOcr(w, id, entry, request) {
  try {
    if (!entry.ocr) throw new Error('No text recognition was agreed for this file');
    const text = await entry.ocr({ needsOcr: true, name: request.name, mime: /** @type {any} */ (request.mime), width: request.width, height: request.height, purpose: request.purpose, bytes: request.bytes });
    w.postMessage({ type: 'ocr-reply', seq: request.seq, text: String(text ?? '') });
  } catch (err) {
    w.postMessage({ type: 'ocr-reply', seq: request.seq, error: err instanceof Error ? err.message : String(err) });
  }
  void id;
}

function getWorker() {
  if (worker) return worker;
  const w = new Worker(new URL(INGEST_WORKER_URL, location.href), { type: 'module', name: 'starpi-ingest' });
  w.addEventListener('message', (event) => {
    const msg = /** @type {{ id: number, ok?: boolean, result?: any, error?: { code: string, message: string, details?: Record<string, string | number> }, progress?: Progress, ocr?: any }} */ (event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.progress) {
      entry.onProgress?.(msg.progress);
      return;
    }
    if (msg.ocr) {
      void answerOcr(w, msg.id, entry, msg.ocr);
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
  // The first message: the database of this build and the vector model. Restores stored documents.
  restoring = send(w, 'init', { dbName: storeProfileName(), model: vectorModel }).then(applyState, (err) => {
    console.warn('[starpi] workspace did not start', err);
  });
  return w;
}

/**
 * @param {Worker} w
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {{ onProgress?: (p: Progress) => void, ocr?: OcrHook, transfer?: Transferable[] }} [options]
 * @returns {Promise<any>}
 */
function send(w, type, payload, options = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: options.onProgress, ocr: options.ocr });
    w.postMessage({ id, type, payload }, options.transfer ?? []);
  });
}

/**
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {{ onProgress?: (p: Progress) => void, ocr?: OcrHook, transfer?: Transferable[] }} [options]
 * @returns {Promise<any>}
 */
function request(type, payload, options) {
  return send(getWorker(), type, payload, options);
}

/**
 * Starts the worker at boot when the database holds documents, so files kept on this device are
 * listed again after a reload. Without stored documents no worker is started.
 * @returns {Promise<void>}
 */
export async function restoreWorkspace() {
  if (worker) return restoring ?? undefined;
  try {
    const db = await appDb();
    if (!db.persistent || (await db.count('docs')) === 0) return;
  } catch {
    return;
  }
  getWorker();
  await restoring;
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

/** @returns {WorkspaceStatus} */
export function workspaceStatus() {
  return status;
}

/** @param {(status: WorkspaceStatus) => void} fn */
export function onWorkspaceStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/**
 * Parses, chunks and indexes a file in the worker, and keeps it on this device unless the user
 * chose "memory only". The File is structured-cloned (no copy of its bytes on this thread). An
 * image is read only when `ocr` is given: the caller passes it once the user agreed to have this
 * file recognised.
 * @param {File} file
 * @param {{ chunkSize?: number, chunkOverlap?: number, onProgress?: (p: Progress) => void, ocr?: OcrHook }} [options]
 * @returns {Promise<WorkspaceDocument>}
 */
export async function addToWorkspace(file, options = {}) {
  const doc = /** @type {WorkspaceDocument} */ (
    await request('ingest', { file, chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap, ocr: Boolean(options.ocr) }, { onProgress: options.onProgress, ocr: options.ocr })
  );
  await restoring;
  if (doc.duplicate) return doc;
  if (!docs.some((d) => d.docId === doc.docId)) docs = [...docs, doc];
  setStatus({ chunks: status.chunks + doc.chunks });
  notify();
  return doc;
}

/**
 * Sets the function that embeds a question for hybrid search (null: keyword search only).
 * @param {((text: string) => Promise<Float32Array | null>) | null} fn
 */
export function setQueryEmbedder(fn) {
  queryEmbedder = fn;
}

/**
 * Top-K search: hybrid (BM25 plus vectors, fused with RRF) when the workspace holds vectors and the
 * question's vector arrives in time, BM25 alone otherwise. Resolves to [] when the workspace is
 * empty (no worker is started for that).
 * @param {string} query
 * @param {number} [topK]
 * @returns {Promise<WorkspaceHit[]>}
 */
export async function searchWorkspace(query, topK = 5) {
  if (!docs.length || !query.trim()) return [];
  return searchWithQueryVector(query, topK, {
    hasVectors: () => status.vectors > 0,
    embed: queryEmbedder,
    search: (q, k, vector) => (vector ? request('searchHybrid', { query: q, vector, topK: k }) : request('search', { query: q, topK: k })),
  });
}

/**
 * How well the workspace matches a question (BM25 only, milliseconds): the normalised best score
 * and the share of the question's terms in the best chunk. Zero for an empty workspace.
 * @param {string} question
 * @param {number} [k]
 * @returns {Promise<WorkspaceProbe>}
 */
export async function workspaceProbe(question, k = 5) {
  if (!docs.length || !question.trim()) return { score: 0, coverage: 0, terms: 0, matched: [], hits: 0, docId: null };
  return request('probe', { question, k });
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
  const removed = docs.find((d) => d.docId === docId);
  docs = docs.filter((d) => d.docId !== docId);
  if (removed) setStatus({ chunks: Math.max(0, status.chunks - removed.chunks) });
  notify();
}

/**
 * Re-checks an answer receipt against original files, in the worker (extraction and chunking are
 * too heavy for the UI thread). Originals kept on this device stand in for files not given. Adds
 * nothing to the workspace.
 * @param {unknown} receipt  parsed JSON
 * @param {File[]} files
 * @param {string | null} [publicKey]  the signer's public key (JWK or PEM text), to check who signed
 * @returns {Promise<import('../core/receipt.js').VerifyReport | { invalid: { error: string, path: string } } | { invalidKey: string }>}
 */
export function verifyReceiptFiles(receipt, files, publicKey = null) {
  return request('verify-receipt', { receipt, files, publicKey });
}

/**
 * Removes every document from memory and from this device ("Forget all"). Requests still running
 * are cancelled.
 * @returns {Promise<void>}
 */
export async function clearWorkspace() {
  failAll(new WorkspaceError('cleared', 'Workspace cleared'));
  if (!worker && !(await hasStoredDocuments())) {
    if (docs.length) {
      docs = [];
      notify();
    }
    return;
  }
  try {
    await request('clear', {});
  } finally {
    docs = [];
    setStatus({ vectors: 0, chunks: 0 });
    notify();
  }
}

async function hasStoredDocuments() {
  try {
    const db = await appDb();
    return db.persistent && (await db.count('docs')) > 0;
  } catch {
    return false;
  }
}

/**
 * Records the answer to "keep files on this device after reload". No deletes the stored copies
 * (the documents stay until the page closes); yes stores the documents now.
 * @param {boolean} keep
 * @returns {Promise<{ keep: boolean | null, stored: number, persistent: boolean }>}
 */
export async function setKeepFiles(keep) {
  const result = await request('keep', { keep });
  setStatus({ keep: result.keep, persistent: result.persistent });
  docs = docs.map((d) => ({ ...d, stored: result.keep === true && result.persistent }));
  notify();
  return result;
}

/**
 * Selects the model whose vectors the workspace searches (null: semantic search off). Starts no
 * worker when the workspace is empty; the model is passed on at the next start.
 * @param {{ id: string, dim: number } | null} model
 * @returns {Promise<number>} vectors of that model already in the workspace
 */
export async function setVectorModel(model) {
  vectorModel = model;
  if (!worker) return 0;
  const result = await request('model', { model });
  setStatus({ vectors: result.vectors, model: result.model });
  return result.vectors;
}

/**
 * Chunks that have no vector of the active model yet.
 * @param {number} [limit]
 * @returns {Promise<Array<{ docId: string, idx: number, text: string }>>}
 */
export async function pendingVectors(limit = 64) {
  if (!docs.length || !vectorModel) return [];
  return request('pending-vectors', { limit });
}

/**
 * Hands embeddings to the worker, which quantises and stores them. The vectors' buffers are
 * transferred.
 * @param {string} model
 * @param {Array<{ docId: string, idx: number, vector: Float32Array }>} items
 * @returns {Promise<{ added: number, total: number }>}
 */
export async function putVectors(model, items) {
  const transfer = items.map((i) => i.vector.buffer).filter((b, i, all) => all.indexOf(b) === i);
  const result = await request('put-vectors', { model, items }, { transfer: /** @type {Transferable[]} */ (transfer) });
  setStatus({ vectors: result.total });
  return result;
}

/**
 * What the workspace keeps on this device.
 * @returns {Promise<WorkspaceStatus & { storedBytes: number, documents: number }>}
 */
export async function workspaceStats() {
  if (!worker && !(await hasStoredDocuments())) return { ...status, storedBytes: 0, documents: 0 };
  const s = await request('stats', {});
  setStatus({ ready: true, persistent: s.persistent, keep: s.keep, vectors: s.vectors, chunks: s.chunks, model: s.model });
  return { ...status, storedBytes: s.storedBytes, documents: s.documents.length };
}
