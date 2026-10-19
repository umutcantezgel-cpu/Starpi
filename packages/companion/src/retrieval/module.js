// @ts-check
// Module `retrieval`: the search index over notes and documents (index.js), published on the hub
// for the other modules, and two routes for the app's source mode:
//   POST /v1/retrieval/search   member  { query, k?, collections?, maxClass? } -> passages with their data class
//   GET  /v1/retrieval/status   member  entries, passages, vectors, the embedding server's state
// Configuration (`modules.retrieval`, all optional):
//   { "embeddings": { "baseUrl": "http://127.0.0.1:11434/v1", "model": "nomic-embed-text",
//                     "queryPrefix": "", "passagePrefix": "" },
//     "chunkSize": 500, "chunkOverlap": 50 }
// Without `embeddings` the index ranks by keywords alone. A search returns passages up to the
// class `sensitive` unless the caller names another ceiling; secret entries only on request.
import { isRecord, text } from '../contracts/check.js';
import { DATA_CLASSES } from '../contracts/data-classes.js';
import { fail } from '../lib/errors.js';
import { bodyOf, checkBody, dataClassRule, intIn, moduleConfig } from '../setup/kit.js';
import { createEmbedder } from './embedder.js';
import { COLLECTIONS, createRetrieval } from './index.js';

export const RETRIEVAL_MODULE = 'retrieval';
export const MAX_QUERY_CHARS = 2000;

/** @param {unknown} v */
const embeddingsRule = (v) => {
  if (!isRecord(v)) return 'an object { baseUrl, model, queryPrefix?, passagePrefix? }';
  for (const key of Object.keys(v)) if (!['baseUrl', 'model', 'queryPrefix', 'passagePrefix'].includes(key)) return `${key} is not a member`;
  if (typeof v.baseUrl !== 'string' || typeof v.model !== 'string') return 'baseUrl and model are required';
  for (const key of ['queryPrefix', 'passagePrefix']) if (v[key] !== undefined && (typeof v[key] !== 'string' || /** @type {string} */ (v[key]).length > 64)) return `${key}: a string of at most 64 characters`;
  return null;
};

/** @param {unknown} v */
const collectionsRule = (v) => (Array.isArray(v) && v.length > 0 && v.every((c) => COLLECTIONS.includes(/** @type {any} */ (c))) ? null : `a list of ${COLLECTIONS.join(', ')}`);

/**
 * @param {{ hub: import('../setup/hub.js').Hub, fetchImpl?: typeof fetch }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createRetrievalModule({ hub, fetchImpl }) {
  /** @type {import('./index.js').Retrieval | null} */
  let index = null;
  /** @type {(() => void) | null} */
  let withdraw = null;
  const live = () => {
    if (!index) throw fail('module_stopped', 'the search index is not running', { status: 503 });
    return index;
  };

  return {
    id: RETRIEVAL_MODULE,
    version: '1.0.0',
    title: 'Search over notes and documents',
    routes: [
      {
        method: 'POST',
        path: '/search',
        access: 'member',
        maxBody: 8 * 1024,
        async handler(req) {
          const body = bodyOf(req);
          checkBody(body, { query: text(MAX_QUERY_CHARS), k: intIn(1, 50), collections: collectionsRule, maxClass: dataClassRule }, ['query']);
          const result = await live().search(/** @type {string} */ (body.query), {
            k: /** @type {number | undefined} */ (body.k) ?? 8,
            collections: /** @type {any} */ (body.collections) ?? COLLECTIONS,
            maxClass: /** @type {any} */ (body.maxClass) ?? 'sensitive',
            signal: req.signal,
          });
          return { body: { passages: result.passages, dense: result.dense } };
        },
      },
      {
        method: 'GET',
        path: '/status',
        access: 'member',
        lane: 'status',
        handler: () => ({ body: { index: live().stats(), classes: DATA_CLASSES } }),
      },
    ],
    start(ctx) {
      const config = moduleConfig(RETRIEVAL_MODULE, ctx.config, { embeddings: embeddingsRule, chunkSize: intIn(100, 4000), chunkOverlap: intIn(0, 1000) }, /** @type {{ embeddings?: any, chunkSize: number, chunkOverlap: number }} */ ({ chunkSize: 500, chunkOverlap: 50 }));
      if (config.chunkOverlap >= config.chunkSize) throw fail('module_config', 'modules.retrieval.chunkOverlap must be smaller than chunkSize');
      const embedder = config.embeddings ? createEmbedder(config.embeddings, { fetchImpl }) : null;
      index = createRetrieval({ embedder, scheduler: ctx.scheduler, log: ctx.log, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap });
      withdraw = hub.provide('retrieval', index);
    },
    stop() {
      index?.stop();
      withdraw?.();
      withdraw = null;
      index = null;
    },
  };
}
