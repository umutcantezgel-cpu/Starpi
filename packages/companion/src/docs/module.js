// @ts-check
// Module `docs`: documents the user hands to the companion. The original file and its extracted
// text are sealed blobs of the vault namespace `documents`; a small sealed record per document
// holds its name, kind, size, hash, data class and state. Text extraction runs in the background
// lane, one document at a time, and its passages go into the search index (collection
// `documents`).
//   POST   /v1/docs?name=<file name>&class=<data class>   member  raw body (the file) -> 202 { document }
//   GET    /v1/docs                                         member  every document, newest first
//   GET    /v1/docs/:id                                     member  one document
//   GET    /v1/docs/:id/passages/:n                         member  passage n (0-based) as it is cited
//   GET    /v1/docs/:id/file                                member  the original file, as an attachment
//   PUT    /v1/docs/:id/class                               member  { dataClass } changes the data class
//   DELETE /v1/docs/:id                                     member  deletes record, original and text
// The name and the class travel in the query, so a browser on an allowed origin needs no custom
// header. An upload whose bytes equal a stored document answers with that document.
// Configuration (`modules.docs`): { "maxDocuments": 2000, "maxBytes": 26214400 }.
import { createHash } from 'node:crypto';
import { isDataClass } from '../contracts/data-classes.js';
import { isRecord } from '../contracts/check.js';
import { isoAt } from '../lib/clock.js';
import { codeOf, fail } from '../lib/errors.js';
import { actorOf, bodyOf, checkBody, dataClassRule, idPattern, intIn, moduleConfig, newId, notFound } from '../setup/kit.js';
import { EXTRACTOR, extractDocument } from './extract.js';
import { sniffDocument } from './sniff.js';

export const DOCS_MODULE = 'docs';
export const DOCUMENTS_NAMESPACE = 'documents';
export const MAX_NAME_CHARS = 255;
const DOC_ID = idPattern('doc');
const UPLOAD_TYPES = Object.freeze([
  'application/octet-stream',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/**
 * @typedef {object} DocumentRecord
 * @property {string} id
 * @property {string} name
 * @property {import('./sniff.js').DocumentType} type
 * @property {number} bytes
 * @property {string} sha256
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {'stored' | 'indexed' | 'failed'} status
 * @property {string | null} reason       why extraction failed
 * @property {number | null} pages
 * @property {number} chars
 * @property {number} passages
 * @property {{ id: string, version: number }} extractor
 * @property {string} added
 * @property {string | null} indexed
 */

/**
 * What other modules may use.
 * @typedef {object} DocumentsService
 * @property {() => DocumentRecord[]} list
 * @property {(id: string) => DocumentRecord | null} get
 * @property {(id: string, chunk: number) => ({ chunk: number, start: number, end: number, text: string, total: number } | null)} passage
 * @property {() => Promise<void>} idle   resolves when no extraction is queued or running
 */

/** A file name as given: no path, no control characters. @param {unknown} raw */
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.length > 0 && name.length <= MAX_NAME_CHARS ? name : null;
}

/**
 * @param {{ hub: import('../setup/hub.js').Hub }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createDocsModule({ hub }) {
  /** @type {any} */
  let ctx = null;
  /** @type {any} */
  let ns = null;
  let settings = { maxDocuments: 2000, maxBytes: 25 * 1024 * 1024 };
  /** id -> { updated, record } */
  const mirror = new Map();
  /** @type {Promise<void>} */
  let queue = Promise.resolve();
  let pending = 0;
  let stopped = false;
  /** @type {(() => void) | null} */
  let withdraw = null;

  const index = () => hub.get('retrieval');
  const now = () => isoAt(ctx.clock.now());

  /** @param {DocumentRecord} record */
  function save(record) {
    const { updated } = ns.putJson(record.id, record);
    mirror.set(record.id, { updated, record });
  }

  /** @param {DocumentRecord} record */
  function indexRecord(record) {
    const idx = index();
    if (!idx || record.status !== 'indexed') return 0;
    const text = ns.getBlob(`${record.id}.text`);
    if (!text) return 0;
    return idx.put({ id: record.id, collection: 'documents', title: record.name, dataClass: record.dataClass, text: text.toString('utf8') }).chunks;
  }

  /** Follows the vault, like the memory does. */
  function sync() {
    if (!ns) throw fail('module_stopped', 'the document store is not running', { status: 503 });
    const stored = new Map(ns.list().map((/** @type {{ id: string, updated: string }} */ item) => [item.id, item.updated]));
    for (const id of [...mirror.keys()]) {
      if (stored.has(id)) continue;
      mirror.delete(id);
      index()?.remove(id);
    }
    for (const [id, updated] of stored) {
      if (!DOC_ID.test(id) || mirror.get(id)?.updated === updated) continue;
      const record = /** @type {DocumentRecord} */ (ns.getJson(id));
      if (!isRecord(record) || record.id !== id) continue;
      mirror.set(id, { updated, record });
      try {
        indexRecord(record);
      } catch (err) {
        ctx.log('warn', 'document_index_failed', { id, code: codeOf(err) });
      }
    }
    const idx = index();
    if (idx) for (const { record } of mirror.values()) if (record.status === 'indexed' && !idx.has(record.id)) indexRecord(record);
  }

  /** @param {string} id */
  function recordOf(id) {
    if (!DOC_ID.test(id)) throw notFound('document_unknown', 'document');
    sync();
    const record = mirror.get(id)?.record;
    if (!record) throw notFound('document_unknown', 'document');
    return record;
  }

  /**
   * Queues the extraction of a stored document.
   * @param {string} id
   */
  function extractLater(id) {
    pending += 1;
    queue = queue
      .then(() => (stopped ? undefined : ctx.scheduler.run('background', 'docs.extract', () => extract(id))))
      .catch((err) => ctx.log('warn', 'document_extract_failed', { id, code: codeOf(err) }))
      .finally(() => {
        pending -= 1;
      });
  }

  /** @param {string} id */
  async function extract(id) {
    const record = mirror.get(id)?.record;
    if (!record || record.status !== 'stored' || stopped) return;
    const original = ns.getBlob(`${id}.original`);
    if (!original) {
      save({ ...record, status: 'failed', reason: 'original_missing' });
      return;
    }
    let result;
    try {
      result = await extractDocument(new Uint8Array(original), record.type);
    } catch (err) {
      const reason = /** @type {any} */ (err)?.details?.reason ?? codeOf(err);
      if (stopped || !mirror.has(id)) return;
      save({ ...record, status: 'failed', reason });
      hub.get('notify')?.post({ kind: 'document_failed', ref: id, title: record.name, dataClass: record.dataClass });
      return;
    }
    // The document may have been deleted or reclassified while it was read.
    const current = mirror.get(id)?.record;
    if (stopped || !current) return;
    ns.putBlob(`${id}.text`, Buffer.from(result.text, 'utf8'));
    const indexed = { ...current, status: /** @type {const} */ ('indexed'), reason: null, pages: result.pages, chars: result.text.length, indexed: now() };
    save(indexed);
    const passages = indexRecord(indexed);
    if (passages !== indexed.passages) save({ ...indexed, passages });
    hub.get('notify')?.post({ kind: 'document_ready', ref: id, title: current.name, dataClass: current.dataClass });
  }

  /** @type {DocumentsService} */
  const service = {
    list() {
      sync();
      return [...mirror.values()].map((m) => m.record).sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : a.id < b.id ? -1 : 1));
    },
    get(id) {
      if (!DOC_ID.test(id)) return null;
      sync();
      return mirror.get(id)?.record ?? null;
    },
    passage(id, chunk) {
      if (!DOC_ID.test(id)) return null;
      sync();
      const p = index()?.passage(id, chunk);
      return p && p.collection === 'documents' ? { chunk: p.chunk, start: p.start, end: p.end, text: p.text, total: p.total } : null;
    },
    async idle() {
      while (pending > 0) await queue;
    },
  };

  return {
    id: DOCS_MODULE,
    version: '1.0.0',
    title: 'Documents',
    namespaces: [DOCUMENTS_NAMESPACE],
    routes: [
      {
        method: 'POST',
        path: '/',
        access: 'member',
        raw: UPLOAD_TYPES,
        maxBody: 64 * 1024 * 1024,
        handler(req) {
          const name = cleanName(req.query.get('name'));
          if (!name) throw fail('document_name', `name the file in the query (?name=, 1 to ${MAX_NAME_CHARS} characters)`, { status: 400 });
          const requested = req.query.get('class') ?? 'personal';
          if (!isDataClass(requested)) throw fail('document_class', 'class is public, personal, sensitive or secret', { status: 400 });
          const bytes = req.body instanceof Uint8Array ? req.body : new Uint8Array(0);
          if (bytes.length > settings.maxBytes) throw fail('body_too_large', `a document is at most ${settings.maxBytes} bytes`, { status: 413 });
          const type = sniffDocument(bytes, name);
          sync();
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const same = [...mirror.values()].find((m) => m.record.sha256 === sha256);
          if (same) return { body: { document: same.record, duplicate: true } };
          if (mirror.size >= settings.maxDocuments) throw fail('documents_full', `the companion holds at most ${settings.maxDocuments} documents`, { status: 409 });
          const id = newId('doc');
          ns.putBlob(`${id}.original`, bytes);
          /** @type {DocumentRecord} */
          const record = { id, name, type, bytes: bytes.length, sha256, dataClass: requested, status: 'stored', reason: null, pages: null, chars: 0, passages: 0, extractor: { id: EXTRACTOR.id, version: EXTRACTOR.version }, added: now(), indexed: null };
          save(record);
          ctx.audit.append({ kind: 'docs.added', subject: id, actor: actorOf(req), details: { type, bytes: bytes.length, sha256, dataClass: requested } });
          extractLater(id);
          return { status: 202, body: { document: record, duplicate: false } };
        },
      },
      {
        method: 'GET',
        path: '/',
        access: 'member',
        handler: () => ({ body: { documents: service.list() } }),
      },
      {
        method: 'GET',
        path: '/:id',
        access: 'member',
        handler: (req) => ({ body: { document: recordOf(req.params.id) } }),
      },
      {
        method: 'GET',
        path: '/:id/passages/:n',
        access: 'member',
        handler(req) {
          const record = recordOf(req.params.id);
          const n = Number(req.params.n);
          const passage = Number.isInteger(n) && n >= 0 ? service.passage(record.id, n) : null;
          if (!passage) throw notFound('passage_unknown', 'passage');
          return { body: { document: { id: record.id, name: record.name, dataClass: record.dataClass }, passage } };
        },
      },
      {
        method: 'GET',
        path: '/:id/file',
        access: 'member',
        handler(req) {
          const record = recordOf(req.params.id);
          const original = ns.getBlob(`${record.id}.original`);
          if (!original) throw notFound('document_file_missing', 'original file');
          // Always a download: an HTML file served as a page from the companion's origin could run.
          return { raw: { type: 'application/octet-stream', data: original, filename: record.name } };
        },
      },
      {
        method: 'PUT',
        path: '/:id/class',
        access: 'member',
        maxBody: 1024,
        handler(req) {
          const body = bodyOf(req);
          checkBody(body, { dataClass: dataClassRule }, ['dataClass']);
          const record = recordOf(req.params.id);
          const changed = { ...record, dataClass: /** @type {import('../contracts/data-classes.js').DataClass} */ (body.dataClass) };
          save(changed);
          index()?.reclassify(record.id, changed.dataClass);
          ctx.audit.append({ kind: 'docs.reclassified', subject: record.id, actor: actorOf(req), details: { from: record.dataClass, to: changed.dataClass } });
          return { body: { document: changed } };
        },
      },
      {
        method: 'DELETE',
        path: '/:id',
        access: 'member',
        handler(req) {
          const record = recordOf(req.params.id);
          ns.delete(`${record.id}.original`);
          ns.delete(`${record.id}.text`);
          ns.delete(record.id);
          mirror.delete(record.id);
          index()?.remove(record.id);
          ctx.audit.append({ kind: 'docs.deleted', subject: record.id, actor: actorOf(req) });
          return { body: { deleted: true, id: record.id } };
        },
      },
    ],
    start(context) {
      ctx = context;
      stopped = false;
      settings = moduleConfig(DOCS_MODULE, ctx.config, { maxDocuments: intIn(1, 100_000), maxBytes: intIn(1024, 64 * 1024 * 1024) }, settings);
      ns = ctx.vault.namespace(DOCUMENTS_NAMESPACE);
      sync();
      // An extraction cut off by a stop starts again.
      for (const { record } of mirror.values()) if (record.status === 'stored') extractLater(record.id);
      withdraw = hub.provide('documents', service);
    },
    stop() {
      // A running extraction notices the stop after its reader returns and writes nothing.
      stopped = true;
      withdraw?.();
      withdraw = null;
      ns = null;
      mirror.clear();
    },
  };
}
