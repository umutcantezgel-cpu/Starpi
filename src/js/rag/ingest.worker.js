// @ts-check
/// <reference lib="webworker" />
// Ingestion worker: parsing, chunking and BM25 search run here so the UI thread stays responsive.
// All documents live in this worker's memory only; terminating the worker discards them.
//
// Protocol (main -> worker): { id, type, payload }
//   ingest   { file: File, chunkSize?, chunkOverlap? }  -> DocumentInfo       (progress events on the way)
//   search   { query, topK? }                             -> SearchResult[]
//   context  { docId, start, end, pad? }                  -> { before, match, after, start, end, length }
//   head     { docId, count? }                            -> SearchResult[] (first chunks, score 0)
//   text     { docId }                                    -> { name, text }
//   remove   { docId }                                    -> { removed }
//   clear    {}                                           -> { cleared: true }
// Replies: { id, ok: true, result } | { id, ok: false, error: { code, message, details } }
// Progress: { id, progress: { stage: 'reading' | 'parsing' | 'chunking' | 'indexing', done, total } }
import { BM25Index } from './bm25.js';
import { chunkText } from './chunker.js';
import { extractText, ParseError } from './parser.js';

/** @typedef {{ docId: string, name: string, kind: string, chars: number, chunks: number, pages: number | null }} DocumentInfo */

const index = new BM25Index();
/** @type {Map<string, DocumentInfo & { text: string }>} */
const documents = new Map();
// Document ids must stay unique across worker instances: Clear workspace and a crash replace the
// worker, and an earlier citation must never resolve to a file added afterwards.
const instanceId = crypto.randomUUID();
let nextId = 1;

/**
 * @param {number} id
 * @param {string} stage
 * @param {number} done
 * @param {number} total
 */
function progress(id, stage, done, total) {
  self.postMessage({ id, progress: { stage, done, total } });
}

/**
 * @param {number} id
 * @param {{ file: File, chunkSize?: number, chunkOverlap?: number }} payload
 * @returns {Promise<DocumentInfo>}
 */
async function ingest(id, payload) {
  const { file } = payload;
  progress(id, 'parsing', 0, 1);
  const { text, kind, pages } = await extractText(file, (page, total) => progress(id, 'parsing', page, total));
  progress(id, 'chunking', 0, 1);
  const chunks = chunkText(text, { chunkSize: payload.chunkSize, chunkOverlap: payload.chunkOverlap });
  const docId = `ws-${instanceId}-${nextId++}`;
  progress(id, 'indexing', 0, chunks.length);
  index.add(chunks.map((c) => ({ docId, docName: file.name, chunkIndex: c.index, start: c.start, end: c.end, text: c.text })));
  const info = { docId, name: file.name, kind, chars: text.length, chunks: chunks.length, pages };
  documents.set(docId, { ...info, text });
  progress(id, 'indexing', chunks.length, chunks.length);
  return info;
}

/** @param {string} docId */
function requireDoc(docId) {
  const doc = documents.get(docId);
  if (!doc) throw new ParseError('empty', 'Document is no longer in the workspace');
  return doc;
}

/**
 * @param {string} type
 * @param {any} payload
 * @param {number} id
 */
async function handle(type, payload, id) {
  switch (type) {
    case 'ingest':
      return ingest(id, payload);
    case 'search': {
      const topK = Math.min(Math.max(Number(payload.topK) || 5, 1), 50);
      return index.search(String(payload.query ?? ''), topK).map((hit) => ({
        docId: hit.chunk.docId,
        docName: hit.chunk.docName,
        chunkIndex: hit.chunk.chunkIndex,
        start: hit.chunk.start,
        end: hit.chunk.end,
        text: hit.chunk.text,
        score: hit.score,
        matchedTerms: hit.matchedTerms,
      }));
    }
    case 'context': {
      const doc = requireDoc(payload.docId);
      const start = Math.max(0, Math.min(Number(payload.start) || 0, doc.text.length));
      const end = Math.max(start, Math.min(Number(payload.end) || 0, doc.text.length));
      const pad = Math.min(Math.max(Number(payload.pad) || 300, 0), 2_000);
      const from = Math.max(0, start - pad);
      const to = Math.min(doc.text.length, end + pad);
      return {
        before: doc.text.slice(from, start),
        match: doc.text.slice(start, end),
        after: doc.text.slice(end, to),
        start,
        end,
        length: doc.text.length,
      };
    }
    case 'head': {
      const count = Math.min(Math.max(Number(payload.count) || 3, 1), 10);
      return index.entries
        .filter((e) => e.docId === payload.docId)
        .slice(0, count)
        .map((e) => ({ docId: e.docId, docName: e.docName, chunkIndex: e.chunkIndex, start: e.start, end: e.end, text: e.text, score: 0, matchedTerms: [] }));
    }
    case 'text': {
      const doc = requireDoc(payload.docId);
      return { name: doc.name, text: doc.text };
    }
    case 'remove': {
      const removed = index.remove(payload.docId);
      documents.delete(payload.docId);
      return { removed };
    }
    case 'clear':
      index.clear();
      documents.clear();
      return { cleared: true };
    default:
      throw new ParseError('unsupported_type', `Unknown request: ${type}`);
  }
}

self.addEventListener('message', (event) => {
  const { id, type, payload } = /** @type {{ id: number, type: string, payload: any }} */ (event.data ?? {});
  handle(type, payload ?? {}, id).then(
    (result) => self.postMessage({ id, ok: true, result }),
    (err) => {
      const code = err instanceof ParseError ? err.code : 'internal';
      const details = err instanceof ParseError ? err.details : {};
      self.postMessage({ id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err), details } });
    },
  );
});
