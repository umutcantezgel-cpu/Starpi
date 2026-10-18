// @ts-check
// The on-device workspace itself: documents, the BM25 index, chunk vectors, and their copies in the
// app database. src/js/rag/ingest.worker.js runs it in a worker and turns messages into calls;
// keeping it free of worker plumbing lets the unit tests run it under Node (fake-indexeddb).
//
// Persistence (unless the user chose "memory only"):
//   docs     one record per document (DocRecord plus what the citation views and receipts need)
//   chunks   every chunk with its exact offsets in the extracted text
//   vectors  int8 embeddings of chunks, per model
//   files    the original bytes (id = document id) and the extracted text (id = document id + ".txt"),
//            in OPFS or, without it, in the database (store/opfs.js)
// On start the BM25 index is rebuilt from the stored chunks; the extracted text is read back only
// when a view or a receipt check needs it. A document is written files first, records last, so a
// record never points to files that are not there; a document whose files are gone is dropped.
import { sha256Hex, validateReceipt, verifyReceipt } from '../core/receipt.js';
import { importPublicKey } from '../core/signature.js';
import { range } from '../store/idb.js';
import { createFileStore } from '../store/opfs.js';
import { BM25Index } from './bm25.js';
import { CHUNKER, chunkText, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from './chunker.js';
import { hybridSearch, probeIndex } from './hybrid.js';
import { EXTRACTOR, EXTRACTOR_COMPATIBLE, extractText, MAX_FILE_BYTES, ParseError } from './parser.js';
import { chunkKey, quantizeInt8, VectorIndex } from './vectors.js';

/** @typedef {import('../store/idb.js').StoreDb} StoreDb */
/** @typedef {import('../store/opfs.js').FileStore} FileStore */
/** @typedef {import('../store/opfs.js').DirectoryLike} DirectoryLike */
/** @typedef {import('../store/schema.js').DocRecord} DocRecord */
/** @typedef {import('../store/schema.js').ChunkRecord} ChunkRecord */
/** @typedef {import('../store/schema.js').VectorRecord} VectorRecord */
/** @typedef {import('../store/schema.js').SettingsRecord} SettingsRecord */
/** @typedef {import('./bm25.js').Entry} Entry */
/** @typedef {import('./hybrid.js').WorkspaceProbe} WorkspaceProbe */
/** @typedef {import('./formats/image.js').OcrRequest} OcrRequest */
/**
 * Text recognition for one image the user agreed to have read. It may name the provider and model
 * that read it; receipts then record them, and mark the image's excerpts as not reproducible.
 * @typedef {(request: OcrRequest & { bytes: Uint8Array }) => Promise<string | { text: string, provider?: string | null, model?: string | null }>} WorkspaceOcrHook
 */

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
 * @property {{ id: string, version: number, pdfjs: string | null, ocr?: { provider: string, model: string } }} extractor
 *   ocr: text recognition made the text (an image), with the provider and model that read it
 * @property {{ id: string, version: number, size: number, overlap: number }} chunker
 * @property {number} addedAt
 * @property {boolean} stored  kept in the database (survives a reload)
 */

/**
 * A stored document: the shared DocRecord shape plus the fields the views and receipts read.
 * `extractor` is the extractor version (DocRecord); the full extractor identity is `extraction`.
 * @typedef {DocRecord & { kind: string, chars: number, chunks: number, pages: number | null, textSha256: string, extraction: DocumentInfo['extractor'], chunker: DocumentInfo['chunker'], textId: string }} WorkspaceDocRecord
 */

/**
 * @typedef {object} SearchResult
 * @property {string} docId
 * @property {string} docName
 * @property {number} chunkIndex
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {number} score  BM25 score, or the RRF score of a hybrid search
 * @property {string[]} matchedTerms
 * @property {number | null} [keywordScore]  hybrid search: the BM25 score, null when only meaning matched
 * @property {number | null} [similarity]  hybrid search: the cosine similarity, null when only keywords matched
 */

/**
 * @typedef {object} WorkspaceState
 * @property {DocumentInfo[]} documents
 * @property {boolean} persistent  the database survives a reload (false in a private window)
 * @property {boolean | null} keep  the user's answer to "keep files on this device"; null: not asked yet (kept)
 * @property {number} vectors  chunk vectors of the active model
 * @property {number} chunks
 * @property {string | null} model  the active vector model
 */

/** @typedef {{ stage: 'reading' | 'parsing' | 'chunking' | 'indexing' | 'storing', done: number, total: number }} Progress */

/** A workspace failure that is not about reading a file (ParseError covers those). */
export class WorkspaceCoreError extends Error {
  /**
   * @param {'cleared'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceCoreError';
    this.code = code;
    /** @type {Record<string, string | number>} */
    this.details = {};
  }
}

/** Settings record that holds the "keep files on this device" answer. */
export const KEEP_SETTING = 'workspace.keep';
/** File store directory of the workspace. */
export const WORKSPACE_FILES_DIR = 'workspace';
/**
 * Settings records that hold what was found in one document (key: prefix + document id; the
 * knowledge graph's results). They are deleted with the document's stored copy.
 */
export const DERIVED_SETTINGS = Object.freeze(['graph.auto:']);
const MAX_VERIFY_FILES = 20;

/**
 * @param {string} docId
 */
const textIdOf = (docId) => `${docId}.txt`;

/**
 * @typedef {object} WorkspaceOptions
 * @property {() => Promise<StoreDb>} [openDb]  the app database; without it nothing is stored
 * @property {(() => Promise<DirectoryLike>) | null} [fileRoot]  the OPFS root for the file store (default: the browser's; null: keep files in the database)
 * @property {() => number} [now]
 * @property {string} [idPrefix]  unique per instance, so a citation never resolves to a later file
 */

/**
 * @param {WorkspaceOptions} [options]
 */
export function createWorkspace(options = {}) {
  const now = options.now ?? Date.now;
  const idPrefix = options.idPrefix ?? `ws-${crypto.randomUUID()}`;
  const index = new BM25Index();
  /** @type {Map<string, DocumentInfo & { text: string | null }>} */
  const documents = new Map();
  /** @type {VectorIndex | null} */
  let vectors = null;
  /** @type {Map<string, Entry> | null} */
  let lookup = null;
  /** @type {{ db: StoreDb, files: FileStore } | null} */
  let store = null;
  /** @type {boolean | null} */
  let keep = null;
  let persistent = false;
  let nextId = 1;
  /** Bumped by clear(): an ingest that started before must not add its document afterwards. */
  let generation = 0;
  /** @type {Promise<WorkspaceState> | null} */
  let ready = null;

  const keeping = () => Boolean(store) && keep !== false;

  function invalidate() {
    lookup = null;
  }

  /** @param {string} key */
  function entryOf(key) {
    lookup ??= new Map(index.entries.map((e) => [chunkKey(e.docId, e.chunkIndex), e]));
    return lookup.get(key);
  }

  /** @returns {WorkspaceState} */
  function state() {
    return {
      documents: [...documents.values()].map(publicInfo),
      persistent,
      keep,
      vectors: vectors?.size ?? 0,
      chunks: index.size,
      model: vectors?.model ?? null,
    };
  }

  /**
   * @param {DocumentInfo & { text?: string | null }} doc
   * @returns {DocumentInfo}
   */
  function publicInfo(doc) {
    const info = { ...doc };
    delete info.text;
    return info;
  }

  /**
   * Opens the database, restores the stored documents and rebuilds the index. Safe to call more
   * than once; later calls return the first result.
   * @param {{ model?: { id: string, dim: number } | null }} [init]
   * @returns {Promise<WorkspaceState>}
   */
  function init(init = {}) {
    ready ??= (async () => {
      if (init.model) vectors = new VectorIndex(init.model.id, init.model.dim);
      if (!options.openDb) return state();
      /** @type {StoreDb} */
      let db;
      try {
        db = await options.openDb();
      } catch (err) {
        console.warn('[workspace] the database did not open; files stay in memory', err);
        return state();
      }
      persistent = db.persistent;
      // The stand-in database of a private window lives in memory too: storing there would only
      // keep a second copy until the page closes.
      if (!persistent) return state();
      store = { db, files: createFileStore({ db, dir: WORKSPACE_FILES_DIR, root: options.fileRoot }) };
      const setting = /** @type {SettingsRecord | undefined} */ (await db.get('settings', KEEP_SETTING).catch(() => undefined));
      keep = typeof setting?.value === 'boolean' ? setting.value : null;
      if (keep !== false) await restore(store);
      return state();
    })();
    return ready;
  }

  /** @param {{ db: StoreDb, files: FileStore }} s */
  async function restore(s) {
    const records = /** @type {WorkspaceDocRecord[]} */ (await s.db.getAll('docs'));
    if (records.length === 0) return;
    const chunks = /** @type {ChunkRecord[]} */ (await s.db.getAll('chunks'));
    /** @type {Map<string, ChunkRecord[]>} */
    const byDoc = new Map();
    for (const c of chunks) {
      const list = byDoc.get(c.docId);
      if (list) list.push(c);
      else byDoc.set(c.docId, [c]);
    }
    const stored = new Set((await s.files.list()).map((f) => f.id));
    /** @type {string[]} */
    const broken = [];
    for (const r of records.sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1))) {
      const list = (byDoc.get(r.id) ?? []).sort((a, b) => a.idx - b.idx);
      if (list.length !== r.chunks || !stored.has(r.textId)) {
        broken.push(r.id);
        continue;
      }
      index.add(list.map((c) => ({ docId: r.id, docName: r.name, chunkIndex: c.idx, start: c.start, end: c.end, text: c.text })));
      documents.set(r.id, {
        docId: r.id,
        name: r.name,
        kind: r.kind,
        chars: r.chars,
        chunks: r.chunks,
        pages: r.pages,
        bytes: r.bytes,
        fileSha256: r.sha256 || null,
        textSha256: r.textSha256,
        extractor: r.extraction,
        chunker: r.chunker,
        addedAt: r.addedAt,
        stored: true,
        text: null,
      });
    }
    invalidate();
    for (const id of broken) await deleteStored(s, id).catch(() => {});
    if (vectors) await loadVectors(s, vectors);
  }

  /**
   * @param {{ db: StoreDb }} s
   * @param {VectorIndex} target
   */
  async function loadVectors(s, target) {
    await s.db.iterate('vectors', {}, (record) => {
      const r = /** @type {VectorRecord} */ (record);
      if (documents.has(r.docId)) target.addRecord(r);
    });
  }

  /**
   * @param {{ db: StoreDb, files: FileStore }} s
   * @param {string} docId
   */
  async function deleteStored(s, docId) {
    await s.db.transaction(['docs', 'chunks', 'vectors', 'settings'], 'readwrite', async (tx) => {
      await tx.delete('docs', docId);
      const chunkKeys = await tx.getAllKeysFromIndex('chunks', 'docId', docId);
      const vectorKeys = await tx.getAllKeysFromIndex('vectors', 'docId', docId);
      await Promise.all([...chunkKeys.map((k) => tx.delete('chunks', k)), ...vectorKeys.map((k) => tx.delete('vectors', k)), ...DERIVED_SETTINGS.map((p) => tx.delete('settings', p + docId))]);
    });
    await s.files.delete(docId).catch(() => false);
    await s.files.delete(textIdOf(docId)).catch(() => false);
  }

  /** @param {{ db: StoreDb, files: FileStore }} s */
  async function deleteAllStored(s) {
    await s.db.transaction(['docs', 'chunks', 'vectors', 'settings'], 'readwrite', async (tx) => {
      await Promise.all([tx.clear('docs'), tx.clear('chunks'), tx.clear('vectors'), ...DERIVED_SETTINGS.map((p) => tx.delete('settings', range.startsWith(p)))]);
    });
    for (const f of await s.files.list()) await s.files.delete(f.id).catch(() => false);
  }

  /**
   * Writes one document: files first, then its record, chunks and any vectors in one transaction.
   * @param {{ db: StoreDb, files: FileStore }} s
   * @param {DocumentInfo} info
   * @param {string} text
   * @param {Blob | null} original
   */
  async function writeStored(s, info, text, original) {
    const textId = textIdOf(info.docId);
    try {
      if (original) await s.files.write(info.docId, original);
      await s.files.write(textId, new Blob([text], { type: 'text/plain;charset=utf-8' }));
      /** @type {WorkspaceDocRecord} */
      const record = {
        id: info.docId,
        name: info.name,
        sha256: info.fileSha256 ?? '',
        extractor: info.extractor.version,
        bytes: info.bytes,
        addedAt: info.addedAt,
        ...(original ? { fileId: info.docId, mime: original.type || undefined } : {}),
        kind: info.kind,
        chars: info.chars,
        chunks: info.chunks,
        pages: info.pages,
        textSha256: info.textSha256,
        extraction: info.extractor,
        chunker: info.chunker,
        textId,
      };
      if (!record.mime) delete record.mime;
      /** @type {ChunkRecord[]} */
      const chunks = index.entries
        .filter((e) => e.docId === info.docId)
        .map((e) => ({ docId: info.docId, idx: e.chunkIndex, start: e.start, end: e.end, text: e.text }));
      /** @type {VectorRecord[]} */
      const vecs = vectors ? [...vectors.entries.values()].filter((v) => v.docId === info.docId).map((v) => vectorRecord(/** @type {VectorIndex} */ (vectors), v.docId, v.idx, v.data, v.scale)) : [];
      await s.db.transaction(['docs', 'chunks', 'vectors'], 'readwrite', async (tx) => {
        await tx.put('docs', record);
        await Promise.all(chunks.map((c) => tx.put('chunks', c)));
        await Promise.all(vecs.map((v) => tx.put('vectors', v)));
      });
      return true;
    } catch (err) {
      console.warn('[workspace] could not keep the document on this device', err);
      await s.files.delete(info.docId).catch(() => false);
      await s.files.delete(textId).catch(() => false);
      return false;
    }
  }

  /**
   * @param {VectorIndex} target
   * @param {string} docId
   * @param {number} idx
   * @param {Int8Array} data
   * @param {number} scale
   * @returns {VectorRecord}
   */
  function vectorRecord(target, docId, idx, data, scale) {
    return { docId, idx, model: target.model, dim: target.dim, data, scale };
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
   * The extracted text of a document, read back from the file store after a reload.
   * @param {DocumentInfo & { text: string | null }} doc
   */
  async function textOf(doc) {
    if (doc.text !== null) return doc.text;
    const blob = store ? await store.files.read(textIdOf(doc.docId)) : null;
    if (!blob) throw new ParseError('empty', 'Document is no longer in the workspace');
    doc.text = await blob.text();
    return doc.text;
  }

  /**
   * @param {File} file
   * @param {{ chunkSize?: number, chunkOverlap?: number, ocr?: WorkspaceOcrHook, onProgress?: (p: Progress) => void }} [opts]
   * @returns {Promise<DocumentInfo & { duplicate?: boolean }>}
   */
  async function ingest(file, opts = {}) {
    await init();
    const started = generation;
    const progress = opts.onProgress ?? (() => {});
    // The fingerprint is taken before parsing: pdf.js takes ownership of (detaches) the buffer it reads.
    progress({ stage: 'reading', done: 0, total: 1 });
    const fileSha256 = globalThis.crypto?.subtle && file.size <= MAX_FILE_BYTES ? await sha256Hex(await file.arrayBuffer()) : null;
    const size = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const overlap = opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    // The same file added again is not indexed twice: its chunks would crowd out other results.
    for (const doc of documents.values()) {
      if (fileSha256 && doc.fileSha256 === fileSha256 && doc.chunker.size === size && doc.chunker.overlap === overlap) return { ...publicInfo(doc), duplicate: true };
    }
    progress({ stage: 'parsing', done: 0, total: 1 });
    /** @type {{ provider: string, model: string } | null} */
    let recognised = null;
    const userOcr = opts.ocr;
    const ocr = userOcr
      ? async (/** @type {OcrRequest & { bytes: Uint8Array }} */ request) => {
          const answer = await userOcr(request);
          const reply = typeof answer === 'string' ? { text: answer } : answer;
          recognised = { provider: String(reply.provider || 'unknown').slice(0, 40), model: String(reply.model || 'unknown').slice(0, 200) };
          return String(reply.text ?? '');
        }
      : undefined;
    const { text, kind, pages, pdfjs } = await extractText(file, (page, total) => progress({ stage: 'parsing', done: page, total }), { ocr });
    const textSha256 = await sha256Hex(text);
    progress({ stage: 'chunking', done: 0, total: 1 });
    const chunks = chunkText(text, { chunkSize: size, chunkOverlap: overlap });
    if (generation !== started) throw new WorkspaceCoreError('cleared', 'Workspace cleared');
    const name = uniqueName(file.name);
    const docId = `${idPrefix}-${nextId++}`;
    progress({ stage: 'indexing', done: 0, total: chunks.length });
    index.add(chunks.map((c) => ({ docId, docName: name, chunkIndex: c.index, start: c.start, end: c.end, text: c.text })));
    invalidate();
    /** @type {DocumentInfo & { text: string | null }} */
    const doc = {
      docId,
      name,
      kind,
      chars: text.length,
      chunks: chunks.length,
      pages,
      bytes: file.size,
      fileSha256,
      textSha256,
      extractor: { ...EXTRACTOR, pdfjs, ...(recognised ? { ocr: recognised } : {}) },
      chunker: { ...CHUNKER, size, overlap },
      addedAt: now(),
      stored: false,
      text,
    };
    documents.set(docId, doc);
    progress({ stage: 'indexing', done: chunks.length, total: chunks.length });
    if (store && keeping()) {
      progress({ stage: 'storing', done: 0, total: 1 });
      doc.stored = await writeStored(store, doc, text, file);
      // Cleared or removed while it was written: take the copy back out.
      if (doc.stored && !documents.has(docId)) await deleteStored(store, docId).catch(() => {});
      progress({ stage: 'storing', done: 1, total: 1 });
    }
    return publicInfo(doc);
  }

  /**
   * @param {import('./bm25.js').SearchHit | import('./hybrid.js').HybridHit} hit
   * @returns {SearchResult}
   */
  function toResult(hit) {
    const { chunk } = hit;
    /** @type {SearchResult} */
    const out = { docId: chunk.docId, docName: chunk.docName, chunkIndex: chunk.chunkIndex, start: chunk.start, end: chunk.end, text: chunk.text, score: hit.score, matchedTerms: hit.matchedTerms };
    if ('similarity' in hit) {
      out.keywordScore = hit.keywordScore;
      out.similarity = hit.similarity;
    }
    return out;
  }

  /** @param {unknown} topK */
  const clampK = (topK) => Math.min(Math.max(Number(topK) || 5, 1), 50);

  /**
   * @param {string} query
   * @param {number} [topK]
   * @returns {SearchResult[]}
   */
  function search(query, topK) {
    return index.search(String(query ?? ''), clampK(topK)).map(toResult);
  }

  /**
   * BM25 top 50 and cosine top 50 fused with RRF; BM25 alone without a query vector or without
   * vectors of the active model.
   * @param {string} query
   * @param {ArrayLike<number> | null | undefined} vector
   * @param {number} [topK]
   * @returns {SearchResult[]}
   */
  function searchHybrid(query, vector, topK) {
    if (!vector || !vectors || vectors.size === 0 || vector.length !== vectors.dim) return search(query, topK);
    return hybridSearch(index, vectors, String(query ?? ''), vector, clampK(topK), { lookup: entryOf }).map(toResult);
  }

  /**
   * @param {string} question
   * @param {number} [k]
   * @returns {WorkspaceProbe}
   */
  function probe(question, k) {
    return probeIndex(index, String(question ?? ''), Math.min(Math.max(Number(k) || 5, 1), 20));
  }

  /**
   * @param {string} docId
   * @param {number} start
   * @param {number} end
   * @param {number} [pad]
   */
  async function context(docId, start, end, pad) {
    const text = await textOf(requireDoc(docId));
    const s = Math.max(0, Math.min(Number(start) || 0, text.length));
    const e = Math.max(s, Math.min(Number(end) || 0, text.length));
    const p = Math.min(Math.max(Number(pad) || 300, 0), 2_000);
    const from = Math.max(0, s - p);
    const to = Math.min(text.length, e + p);
    return { before: text.slice(from, s), match: text.slice(s, e), after: text.slice(e, to), start: s, end: e, length: text.length };
  }

  /**
   * @param {string} docId
   * @param {number} [count]
   * @returns {SearchResult[]}
   */
  function head(docId, count) {
    const n = Math.min(Math.max(Number(count) || 3, 1), 10);
    return index.entries
      .filter((e) => e.docId === docId)
      .slice(0, n)
      .map((e) => ({ docId: e.docId, docName: e.docName, chunkIndex: e.chunkIndex, start: e.start, end: e.end, text: e.text, score: 0, matchedTerms: [] }));
  }

  /** @param {string} docId */
  async function documentText(docId) {
    const doc = requireDoc(docId);
    return { name: doc.name, text: await textOf(doc) };
  }

  /** @param {string} docId */
  async function remove(docId) {
    await init();
    const removed = index.remove(docId);
    invalidate();
    vectors?.remove(docId);
    const doc = documents.get(docId);
    documents.delete(docId);
    if (store && doc?.stored) await deleteStored(store, docId);
    else if (store) {
      // Kept in memory only: what was found in it may still be stored.
      const { db } = store;
      await Promise.all(DERIVED_SETTINGS.map((p) => db.delete('settings', p + docId))).catch(() => {});
    }
    return { removed };
  }

  /** Removes every document, from memory and from this device ("Forget all"). */
  async function clear() {
    await init();
    generation += 1;
    index.clear();
    invalidate();
    vectors?.clear();
    documents.clear();
    if (store) await deleteAllStored(store);
    return { cleared: true };
  }

  /**
   * Records the answer to "keep files on this device". No: the stored copies are deleted and the
   * documents stay in memory until the page closes. Yes: the documents in memory are stored now
   * (their original bytes only when they were stored before, so receipts of those still verify).
   * @param {boolean} value
   */
  async function setKeep(value) {
    await init();
    if (!store) return { keep, stored: 0, persistent };
    const s = store;
    keep = Boolean(value);
    await s.db.put('settings', /** @type {SettingsRecord} */ ({ key: KEEP_SETTING, value: keep, updatedAt: now() }));
    let stored = 0;
    if (!keep) {
      await deleteAllStored(s);
      for (const doc of documents.values()) doc.stored = false;
    } else {
      for (const doc of documents.values()) {
        if (doc.stored) {
          stored += 1;
          continue;
        }
        doc.stored = await writeStored(s, doc, await textOf(doc), null);
        if (doc.stored) stored += 1;
      }
    }
    return { keep, stored, persistent };
  }

  /**
   * Switches the vector model (null turns semantic search off). Vectors of the new model are
   * loaded from the database; stored vectors of other models are deleted, they can never be
   * compared with the new ones.
   * @param {{ id: string, dim: number } | null} model
   */
  async function setModel(model) {
    await init();
    if (!model) {
      vectors = null;
      return { vectors: 0, model: null };
    }
    if (vectors?.model === model.id && vectors.dim === model.dim) return { vectors: vectors.size, model: model.id };
    vectors = new VectorIndex(model.id, model.dim);
    if (store) {
      const s = store;
      await loadVectors(s, vectors);
      await s.db.transaction('vectors', 'readwrite', async (tx) => {
        /** @type {import('../store/idb.js').Key[]} */
        const stale = [];
        await tx.iterate('vectors', {}, (record, key) => {
          if (/** @type {VectorRecord} */ (record).model !== model.id) stale.push(key);
        });
        await Promise.all(stale.map((key) => tx.delete('vectors', key)));
      });
    }
    return { vectors: vectors.size, model: model.id };
  }

  /**
   * Chunks without a vector of the active model, in document order.
   * @param {number} [limit]
   * @returns {Array<{ docId: string, idx: number, text: string }>}
   */
  function pendingVectors(limit) {
    if (!vectors) return [];
    const n = Math.min(Math.max(Number(limit) || 64, 1), 512);
    /** @type {Array<{ docId: string, idx: number, text: string }>} */
    const out = [];
    for (const e of index.entries) {
      if (out.length >= n) break;
      if (!vectors.has(e.docId, e.chunkIndex)) out.push({ docId: e.docId, idx: e.chunkIndex, text: e.text });
    }
    return out;
  }

  /**
   * Adds embeddings of the active model: quantised to int8, indexed and stored with their document.
   * Vectors of another model, of a wrong length or of chunks that are gone are skipped.
   * @param {string} model
   * @param {Array<{ docId: string, idx: number, vector: ArrayLike<number> }>} items
   */
  async function putVectors(model, items) {
    await init();
    const target = vectors;
    if (!target || target.model !== model) return { added: 0, total: target?.size ?? 0 };
    /** @type {VectorRecord[]} */
    const records = [];
    let added = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.vector?.length !== target.dim || !entryOf(chunkKey(item.docId, item.idx))) continue;
      const { data, scale } = quantizeInt8(item.vector);
      if (!target.add(item.docId, item.idx, data, scale)) continue;
      added += 1;
      if (documents.get(item.docId)?.stored) records.push(vectorRecord(target, item.docId, item.idx, data, scale));
    }
    if (store && records.length) {
      const s = store;
      await s.db
        .transaction('vectors', 'readwrite', async (tx) => {
          await Promise.all(records.map((r) => tx.put('vectors', r)));
        })
        .catch((err) => console.warn('[workspace] could not store vectors', err));
    }
    return { added, total: target.size };
  }

  /**
   * Re-checks an answer receipt against original files. When the user picks no files, the
   * originals kept on this device stand in, so a receipt of a stored document verifies without
   * picking the file again; picked files are checked on their own (a changed copy must not be
   * covered up by the stored one).
   * @param {unknown} receipt
   * @param {File[]} given
   * @param {string | null} publicKeyText
   * @param {{ stored?: boolean }} [opts]
   */
  async function checkReceipt(receipt, given, publicKeyText, opts = {}) {
    await init();
    const parsed = validateReceipt(receipt);
    if (!parsed.ok) return { invalid: { error: parsed.error, path: parsed.path } };
    /** @type {CryptoKey | undefined} */
    let publicKey;
    if (typeof publicKeyText === 'string') {
      try {
        publicKey = await importPublicKey(publicKeyText);
      } catch (err) {
        return { invalidKey: err instanceof Error ? err.message : String(err) };
      }
    }
    /** @type {Array<{ name: string, bytes: Uint8Array }>} */
    const files = [];
    const picked = (Array.isArray(given) ? given : []).slice(0, MAX_VERIFY_FILES);
    for (const f of picked) {
      if (f.size > MAX_FILE_BYTES) continue;
      files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    if (opts.stored !== false && store && picked.length === 0) {
      const wanted = new Set(parsed.receipt.citations.map((c) => c.document?.fileSha256).filter((h) => typeof h === 'string'));
      for (const doc of documents.values()) {
        if (!doc.stored || !doc.fileSha256 || !wanted.has(doc.fileSha256)) continue;
        const blob = await store.files.read(doc.docId);
        if (!blob) continue;
        files.push({ name: doc.name, bytes: new Uint8Array(await blob.arrayBuffer()) });
        wanted.delete(doc.fileSha256);
      }
    }
    return verifyReceipt(
      parsed.receipt,
      files,
      {
        extractor: EXTRACTOR,
        compatible: EXTRACTOR_COMPATIBLE,
        extract: async (bytes, name) => {
          const r = await extractText(new File([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)], name));
          return { text: r.text, pdfjs: r.pdfjs };
        },
      },
      { publicKey },
    );
  }

  /** How much the workspace keeps on this device. */
  async function stats() {
    await init();
    const files = store ? await store.files.totalSize().catch(() => 0) : 0;
    return { ...state(), storedBytes: files };
  }

  return {
    init,
    ingest,
    search,
    searchHybrid,
    probe,
    context,
    head,
    text: documentText,
    remove,
    clear,
    setKeep,
    setModel,
    pendingVectors,
    putVectors,
    verifyReceipt: checkReceipt,
    stats,
    state,
  };
}

/** @typedef {ReturnType<typeof createWorkspace>} Workspace */
