// @ts-check
// Semantic search on this device: the opt-in setting, the embedding worker (src/js/wasm/worker.js
// through WasmEmbedClient) and the indexing loop that gives every workspace chunk a vector.
//
// Nothing downloads until the user turns "Semantic search on this device" on; the model then
// loads lazily, when the first chunk or question needs a vector. Indexing is driven from here: the
// ingest worker names the chunks without a vector, this module embeds them in batches of 16 and
// hands the vectors back, where they are quantised to int8 and stored with their document.
// Questions are embedded with the same model ("query: " prefix) for hybrid search and, with the
// default model, to rank the shared library by meaning without sending the question.
import { DEFAULT_EMBED_MODEL, EMBED_BATCH_SIZE, EMBED_CATALOG, embedModelId, embedSource, suggestSemanticSearch } from '../models/embed-catalog.js';
import { detectMobile } from '../models/device.js';
import { readLocalJson, writeLocalJson } from '../storage.js';
import { matchKnowledgeVector } from '../supabase.js';
import { QUERY_EMBED_TIMEOUT_MS, withinTimeout } from '../retrieval.js';
import { embedCacheStatus, WasmEmbedClient } from '../wasm/client.js';
import { onWorkspaceChange, pendingVectors, putVectors, setQueryEmbedder, setVectorModel, workspaceStatus } from './workspace.js';

/** Replaced at build time with the hashed worker URL (scripts/build.mjs). */
const WASM_WORKER_URL = '__STARPI_WASM_WORKER_URL__';

/** localStorage key of the setting. */
export const SEMANTIC_SETTING_KEY = 'starpi_semantic_search';
/** Chunks fetched from the ingest worker per round (embedded in batches of EMBED_BATCH_SIZE). */
const ROUND = 64;
const MEMO_SIZE = 16;

/** @typedef {import('../models/embed-catalog.js').EmbedSource} EmbedSource */
/** @typedef {import('../models/embed-catalog.js').EmbedModelKey} EmbedModelKey */
/** @typedef {import('../supabase.js').KnowledgeHit} KnowledgeHit */

/**
 * @typedef {object} SemanticState
 * @property {boolean} enabled  the user opted in
 * @property {EmbedModelKey} model
 * @property {'off' | 'idle' | 'loading' | 'indexing' | 'ready' | 'error'} phase
 *   idle: on, but nothing has needed the model yet; loading: the model downloads or starts
 * @property {number} progress  share of the model's bytes loaded, 0..1
 * @property {number} done  chunks embedded in this indexing run
 * @property {number} total  chunks of this run, known so far
 * @property {string | null} error
 */

/** @returns {{ enabled: boolean, model: EmbedModelKey }} */
function readSetting() {
  const raw = /** @type {{ enabled?: unknown, model?: unknown } | null} */ (readLocalJson(SEMANTIC_SETTING_KEY, null));
  return { enabled: raw?.enabled === true, model: embedSource(raw?.model).key };
}

const initial = readSetting();
/** @type {SemanticState} */
let state = { enabled: initial.enabled, model: initial.model, phase: initial.enabled ? 'idle' : 'off', progress: 0, done: 0, total: 0, error: null };
/** @type {Set<(state: SemanticState) => void>} */
const listeners = new Set();
/** @type {WasmEmbedClient | null} */
let client = null;
/** @type {Promise<void> | null} */
let indexing = null;
let indexAgain = false;
/** Bumped when the setting changes, so a running loop stops. */
let epoch = 0;
/** @type {Map<string, Promise<Float32Array | null>>} */
const memo = new Map();
/** @type {Map<string, number>} */
const loadedBytes = new Map();
let modelReady = false;

/** @param {Partial<SemanticState>} next */
function update(next) {
  state = { ...state, ...next };
  for (const fn of listeners) fn(state);
}

/** @returns {SemanticState} */
export function semanticState() {
  return state;
}

/** @param {(state: SemanticState) => void} fn */
export function onSemanticChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The catalog entry of the selected model. */
export function semanticModel() {
  return embedSource(state.model);
}

/** Every model the setting offers, default first. */
export function semanticModels() {
  return Object.values(EMBED_CATALOG);
}

/**
 * Whether this device gets the offer without asking (desktop-class browsers); phones, tablets and
 * devices that report little memory or few cores do not.
 */
export function semanticSuggested() {
  const nav = /** @type {Navigator & { deviceMemory?: number, userAgentData?: { mobile?: boolean } }} */ (globalThis.navigator ?? {});
  return suggestSemanticSearch({
    isMobile: detectMobile({ userAgent: nav.userAgent ?? '', userAgentDataMobile: nav.userAgentData?.mobile }),
    deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
  });
}

/** @returns {Promise<'full' | 'partial' | 'none'>} whether the selected model is already stored */
export function semanticModelStored() {
  return embedCacheStatus(semanticModel());
}

function getClient() {
  if (client) return client;
  const w = new Worker(new URL(WASM_WORKER_URL, location.href), { type: 'module', name: 'starpi-embed' });
  client = new WasmEmbedClient(w);
  return client;
}

function stopClient() {
  client?.terminate();
  client = null;
  modelReady = false;
  loadedBytes.clear();
  memo.clear();
}

/**
 * @param {string[]} texts
 * @param {'query' | 'passage'} kind
 * @returns {Promise<Float32Array[]>}
 */
async function embedBatch(texts, kind) {
  const src = semanticModel();
  const sizes = new Map(src.files.map(([file, bytes]) => [file, bytes]));
  const total = src.files.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (!modelReady && state.phase !== 'loading' && state.phase !== 'indexing') update({ phase: 'loading', error: null });
  const vectors = await getClient().embed(src, texts, kind, (p) => {
    const size = sizes.get(p.file) ?? 0;
    loadedBytes.set(p.file, Math.min(p.done ? size : p.loaded, size));
    const loaded = [...loadedBytes.values()].reduce((sum, n) => sum + n, 0);
    update({ progress: total ? loaded / total : 0 });
  });
  if (!modelReady) {
    modelReady = true;
    update({ progress: 1 });
  }
  return vectors;
}

/**
 * The query vector of a question, or null while semantic search is off or the model fails. The
 * last few questions are remembered, so the workspace and the shared library share one vector.
 * @param {string} text
 * @returns {Promise<Float32Array | null>}
 */
export function embedQuery(text) {
  if (!state.enabled) return Promise.resolve(null);
  const key = `${state.model}\n${text}`;
  const known = memo.get(key);
  if (known) return known;
  const run = embedBatch([text.slice(0, 2_000)], 'query').then(
    ([vector]) => vector ?? null,
    (err) => {
      console.warn('[starpi] question embedding failed', err);
      memo.delete(key);
      return null;
    },
  );
  memo.set(key, run);
  while (memo.size > MEMO_SIZE) memo.delete(/** @type {string} */ (memo.keys().next().value));
  return run;
}

/**
 * Embeds every workspace chunk that has no vector of the selected model yet. Runs once at a time;
 * a call while it runs schedules another pass.
 * @returns {Promise<void>}
 */
export function indexWorkspace() {
  if (!state.enabled) return Promise.resolve();
  if (indexing) {
    indexAgain = true;
    return indexing;
  }
  const mine = epoch;
  indexing = (async () => {
    try {
      do {
        indexAgain = false;
        await indexPass(mine);
      } while (indexAgain && mine === epoch);
    } finally {
      indexing = null;
    }
  })();
  return indexing;
}

/** @param {number} mine */
async function indexPass(mine) {
  const src = semanticModel();
  const model = embedModelId(src);
  let done = 0;
  for (;;) {
    if (mine !== epoch || !state.enabled) return;
    const batch = await pendingVectors(ROUND);
    if (batch.length === 0) break;
    update({ phase: 'indexing', done, total: Math.max(state.total, done + batch.length), error: null });
    for (let i = 0; i < batch.length; i += EMBED_BATCH_SIZE) {
      if (mine !== epoch) return;
      const part = batch.slice(i, i + EMBED_BATCH_SIZE);
      let vectors;
      try {
        vectors = await embedBatch(
          part.map((c) => c.text),
          'passage',
        );
      } catch (err) {
        if (mine === epoch) update({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (mine !== epoch) return;
      // The vectors are views of one buffer per batch, which moves to the ingest worker.
      const items = part.map((c, k) => ({ docId: c.docId, idx: c.idx, vector: vectors[k] }));
      const result = await putVectors(model, items);
      done += part.length;
      // A chunk the worker cannot take (removed meanwhile) must not loop forever.
      if (result.added === 0 && part.length > 0) {
        update({ done });
        return finishPass();
      }
      update({ done });
    }
  }
  finishPass();
}

function finishPass() {
  update({ phase: modelReady || workspaceStatus().vectors > 0 ? 'ready' : 'idle', total: 0, done: 0 });
}

/**
 * Turns semantic search on or off (the user's explicit choice) and picks the model. On: the
 * workspace switches to the model's vectors and indexing starts, which downloads the model once.
 * Off: the worker stops; stored vectors stay until the files are forgotten.
 * @param {boolean} enabled
 * @param {EmbedModelKey} [model]
 */
export async function setSemanticSearch(enabled, model = state.model) {
  const src = embedSource(model);
  const changedModel = src.key !== state.model;
  epoch += 1;
  writeLocalJson(SEMANTIC_SETTING_KEY, { enabled, model: src.key });
  if (!enabled || changedModel) stopClient();
  update({ enabled, model: src.key, phase: enabled ? 'idle' : 'off', progress: enabled && !changedModel ? state.progress : 0, done: 0, total: 0, error: null });
  setQueryEmbedder(enabled ? embedQuery : null);
  await setVectorModel(enabled ? { id: embedModelId(src), dim: src.dim } : null);
  if (enabled) await indexWorkspace();
}

/**
 * The shared library ranked by meaning (on-device mode): the question's vector, never its text,
 * goes to match_knowledge_vector_384. Null when semantic search is off, the selected model is not
 * the one the library was embedded with, the vector is not ready within the query timeout, or the
 * database lacks the function; the caller then ranks by keywords as before.
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<KnowledgeHit[] | null>}
 */
export async function libraryHitsByMeaning(query, limit) {
  if (!state.enabled || !semanticModel().library) return null;
  const vector = await withinTimeout(embedQuery(query), QUERY_EMBED_TIMEOUT_MS);
  if (!vector) return null;
  const res = await matchKnowledgeVector(vector, limit);
  return res.ok ? res.data : null;
}

let started = false;

/**
 * Applies the stored setting at boot: with semantic search on, the workspace uses the model's
 * vectors and new or restored chunks are indexed. Call once, after the workspace was restored.
 */
export async function initSemanticSearch() {
  if (started) return;
  started = true;
  let timer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  onWorkspaceChange((docs) => {
    if (!state.enabled || docs.length === 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void indexWorkspace();
    }, 300);
  });
  if (!state.enabled) return;
  const src = semanticModel();
  setQueryEmbedder(embedQuery);
  await setVectorModel({ id: embedModelId(src), dim: src.dim });
  if (workspaceStatus().vectors > 0) update({ phase: 'ready' });
  void indexWorkspace();
}

export { DEFAULT_EMBED_MODEL };
