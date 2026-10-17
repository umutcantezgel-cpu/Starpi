// @ts-check
/// <reference lib="webworker" />
// Ingestion worker: parsing, chunking, BM25 and vector search run here so the UI thread stays
// responsive. The workspace (rag/workspace-core.js) keeps its documents in the app database unless
// the user chose "memory only"; on start it rebuilds the index from the stored chunks.
//
// Protocol (main -> worker): { id, type, payload }
//   init      { dbName, model? }                         -> WorkspaceState (sent first; the database name of the build)
//   ingest    { file: File, chunkSize?, chunkOverlap?, ocr? } -> DocumentInfo (progress events on the way;
//             the same file again returns the existing document with duplicate: true; with ocr: true an
//             image is read through the main thread, see "OCR" below)
//   search    { query, topK? }                           -> SearchResult[]   (BM25)
//   searchHybrid { query, vector?, topK? }               -> SearchResult[]   (BM25 top 50 + cosine top 50, RRF k=60;
//             BM25 alone without a vector or without vectors of the active model)
//   probe     { question, k? }                           -> WorkspaceProbe
//   context   { docId, start, end, pad? }                -> { before, match, after, start, end, length }
//   head      { docId, count? }                          -> SearchResult[] (first chunks, score 0)
//   text      { docId }                                  -> { name, text }
//   remove    { docId }                                  -> { removed }
//   clear     {}                                         -> { cleared: true }   (memory and this device)
//   keep      { keep: boolean }                          -> { keep, stored, persistent }
//   model     { model: { id, dim } | null }              -> { vectors, model }
//   pending-vectors { limit? }                           -> Array<{ docId, idx, text }>
//   put-vectors { model, items: [{ docId, idx, vector: Float32Array }] } -> { added, total }
//   stats     {}                                         -> WorkspaceState & { storedBytes }
//   verify-receipt { receipt, files: File[], publicKey, stored? } -> VerifyReport | { invalid } | { invalidKey }
//             (no files: the originals kept on this device stand in, unless stored is false)
// Replies: { id, ok: true, result } | { id, ok: false, error: { code, message, details } }
// Progress: { id, progress: { stage: 'reading' | 'parsing' | 'chunking' | 'indexing' | 'storing', done, total } }
// OCR: { id, ocr: { seq, name, mime, width, height, purpose, bytes } } asks the main thread to read an image
//   the user agreed to have read; it answers { type: 'ocr-reply', seq, text } or { type: 'ocr-reply', seq, error }.
import { appDb, configureStore } from '../store/schema.js';
import { ParseError } from './parser.js';
import { createWorkspace, WorkspaceCoreError } from './workspace-core.js';

/** @typedef {import('./formats/image.js').OcrHook} OcrHook */

const workspace = createWorkspace({ openDb: () => appDb() });

let ocrSeq = 0;
/** @type {Map<number, { resolve: (text: string) => void, reject: (err: Error) => void }>} */
const ocrWaiting = new Map();

/**
 * An OCR hook that hands the image to the main thread (where the AI layer runs) and waits.
 * @param {number} id  the ingest request
 * @returns {OcrHook}
 */
function ocrThroughMain(id) {
  return (request) =>
    new Promise((resolve, reject) => {
      const seq = ++ocrSeq;
      ocrWaiting.set(seq, { resolve, reject });
      const { bytes, ...info } = request;
      const copy = bytes.slice();
      self.postMessage({ id, ocr: { seq, ...info, bytes: copy } }, [copy.buffer]);
    });
}

/**
 * @param {string} type
 * @param {any} payload
 * @param {number} id
 */
async function handle(type, payload, id) {
  switch (type) {
    case 'init':
      if (typeof payload.dbName === 'string' && payload.dbName) configureStore({ name: payload.dbName });
      return workspace.init({ model: payload.model ?? null });
    case 'ingest':
      return workspace.ingest(payload.file, {
        chunkSize: payload.chunkSize,
        chunkOverlap: payload.chunkOverlap,
        ocr: payload.ocr === true ? ocrThroughMain(id) : undefined,
        onProgress: (p) => self.postMessage({ id, progress: p }),
      });
    case 'search':
      await workspace.init();
      return workspace.search(payload.query, payload.topK);
    case 'searchHybrid':
      await workspace.init();
      return workspace.searchHybrid(payload.query, payload.vector ?? null, payload.topK);
    case 'probe':
      await workspace.init();
      return workspace.probe(payload.question, payload.k);
    case 'context':
      await workspace.init();
      return workspace.context(payload.docId, payload.start, payload.end, payload.pad);
    case 'head':
      await workspace.init();
      return workspace.head(payload.docId, payload.count);
    case 'text':
      await workspace.init();
      return workspace.text(payload.docId);
    case 'remove':
      return workspace.remove(payload.docId);
    case 'clear':
      return workspace.clear();
    case 'keep':
      return workspace.setKeep(payload.keep === true);
    case 'model':
      return workspace.setModel(payload.model && typeof payload.model.id === 'string' ? { id: payload.model.id, dim: Number(payload.model.dim) } : null);
    case 'pending-vectors':
      await workspace.init();
      return workspace.pendingVectors(payload.limit);
    case 'put-vectors':
      return workspace.putVectors(String(payload.model ?? ''), payload.items);
    case 'stats':
      return workspace.stats();
    case 'verify-receipt':
      return workspace.verifyReceipt(payload.receipt, payload.files, typeof payload.publicKey === 'string' ? payload.publicKey : null, { stored: payload.stored !== false });
    default:
      throw new ParseError('unsupported_type', `Unknown request: ${type}`);
  }
}

self.addEventListener('message', (event) => {
  const data = /** @type {{ id: number, type: string, payload: any, seq?: number, text?: unknown, error?: unknown }} */ (event.data ?? {});
  if (data.type === 'ocr-reply') {
    const waiting = ocrWaiting.get(Number(data.seq));
    if (!waiting) return;
    ocrWaiting.delete(Number(data.seq));
    if (typeof data.text === 'string') waiting.resolve(data.text);
    else waiting.reject(new ParseError('needs_ocr', typeof data.error === 'string' ? data.error : 'Text recognition failed'));
    return;
  }
  const { id, type, payload } = data;
  handle(type, payload ?? {}, id).then(
    (result) => self.postMessage({ id, ok: true, result }),
    (err) => {
      const known = err instanceof ParseError || err instanceof WorkspaceCoreError;
      const code = known ? err.code : 'internal';
      const details = known ? err.details : {};
      self.postMessage({ id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err), details } });
    },
  );
});
