// @ts-check
/// <reference lib="webworker" />
// Ingestion worker: parsing, chunking and BM25 search run here so the UI thread stays responsive.
// All documents live in this worker's memory only; terminating the worker discards them.
//
// Protocol (main -> worker): { id, type, payload }
//   ingest   { file: File, chunkSize?, chunkOverlap? }  -> DocumentInfo       (progress events on the way;
//            the same file again returns the existing document with duplicate: true)
//   search   { query, topK? }                             -> SearchResult[]
//   context  { docId, start, end, pad? }                  -> { before, match, after, start, end, length }
//   head     { docId, count? }                            -> SearchResult[] (first chunks, score 0)
//   text     { docId }                                    -> { name, text }
//   remove   { docId }                                    -> { removed }
//   clear    {}                                           -> { cleared: true }
//   verify-receipt { receipt, files: File[] }             -> VerifyReport | { invalid: { error, path } }
// Replies: { id, ok: true, result } | { id, ok: false, error: { code, message, details } }
// Progress: { id, progress: { stage: 'reading' | 'parsing' | 'chunking' | 'indexing', done, total } }
import { sha256Hex, validateReceipt, verifyReceipt } from '../core/receipt.js';
import { BM25Index } from './bm25.js';
import { CHUNKER, chunkText, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from './chunker.js';
import { EXTRACTOR, extractText, MAX_FILE_BYTES, ParseError } from './parser.js';

/**
 * @typedef {object} DocumentInfo
 * @property {string} docId
 * @property {string} name
 * @property {string} kind
 * @property {number} chars
 * @property {number} chunks
 * @property {number | null} pages
 * @property {number} bytes
 * @property {string | null} fileSha256  SHA-256 of the file bytes, null where WebCrypto is unavailable
 * @property {string} textSha256
 * @property {{ id: string, version: number, pdfjs: string | null }} extractor
 * @property {{ id: string, version: number, size: number, overlap: number }} chunker
 */

const MAX_VERIFY_FILES = 20;

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
 * @returns {Promise<DocumentInfo & { duplicate?: boolean }>}
 */
async function ingest(id, payload) {
  const { file } = payload;
  // The fingerprint is taken before parsing: pdf.js takes ownership of (detaches) the buffer it reads.
  progress(id, 'reading', 0, 1);
  const fileSha256 = globalThis.crypto?.subtle && file.size <= MAX_FILE_BYTES ? await sha256Hex(await file.arrayBuffer()) : null;
  const size = payload.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = payload.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  // The same file added again is not indexed twice: its chunks would crowd out other results.
  for (const doc of documents.values()) {
    if (fileSha256 && doc.fileSha256 === fileSha256 && doc.chunker.size === size && doc.chunker.overlap === overlap) {
      const info = /** @type {DocumentInfo & { text?: string, duplicate?: boolean }} */ ({ ...doc, duplicate: true });
      delete info.text;
      return info;
    }
  }
  progress(id, 'parsing', 0, 1);
  const { text, kind, pages, pdfjs } = await extractText(file, (page, total) => progress(id, 'parsing', page, total));
  const textSha256 = await sha256Hex(text);
  progress(id, 'chunking', 0, 1);
  const name = uniqueName(file.name);
  const chunks = chunkText(text, { chunkSize: size, chunkOverlap: overlap });
  const docId = `ws-${instanceId}-${nextId++}`;
  progress(id, 'indexing', 0, chunks.length);
  index.add(chunks.map((c) => ({ docId, docName: name, chunkIndex: c.index, start: c.start, end: c.end, text: c.text })));
  /** @type {DocumentInfo} */
  const info = {
    docId,
    name,
    kind,
    chars: text.length,
    chunks: chunks.length,
    pages,
    bytes: file.size,
    fileSha256,
    textSha256,
    extractor: { ...EXTRACTOR, pdfjs },
    chunker: { ...CHUNKER, size, overlap },
  };
  documents.set(docId, { ...info, text });
  progress(id, 'indexing', chunks.length, chunks.length);
  return info;
}

/**
 * A different file with the name of one already in the workspace gets a numbered name
 * ("report (2).pdf"), so every citation label names exactly one document.
 * @param {string} name
 */
function uniqueName(name) {
  const taken = new Set([...documents.values()].map((d) => d.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
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
    case 'verify-receipt': {
      const parsed = validateReceipt(payload.receipt);
      if (!parsed.ok) return { invalid: { error: parsed.error, path: parsed.path } };
      /** @type {File[]} */
      const given = Array.isArray(payload.files) ? payload.files.slice(0, MAX_VERIFY_FILES) : [];
      const files = [];
      for (const f of given) {
        if (f.size <= MAX_FILE_BYTES) files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      }
      return verifyReceipt(parsed.receipt, files, {
        extractor: EXTRACTOR,
        extract: async (bytes, name) => {
          const r = await extractText(new File([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)], name));
          return { text: r.text, pdfjs: r.pdfjs };
        },
      });
    }
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
