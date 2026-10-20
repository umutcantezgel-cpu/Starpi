// @ts-check
// On-device entailment ("does this excerpt support this statement?") for the advisory second
// opinion of the source check (core/entail.js). The main-thread side of the NLI requests to
// src/js/wasm/worker.js: a worker of its own (named starpi-nli, so it never drops the chat or the
// search model), requests of up to NLI_BATCH_SIZE premise/hypothesis pairs, the probabilities of
// entailment, neutral and contradiction back per pair.
//
// Nothing downloads before the user asks for a second opinion on this device: a request for a
// model that is not stored completely is refused unless the caller passes `consent` (the click on
// "Check on this device", which names the download size). The model's stored files are checked
// against model-lock.json before the worker reads them, and new downloads before the first result
// is used (models/integrity.js); a file that does not match stops the worker and the request fails.
// A second opinion is advisory only: it never releases a statement and never upgrades a verdict.
import { nliResult } from '../core/entail.js';
import { DEFAULT_NLI_MODEL, embedFileUrl, NLI_BATCH_SIZE, NLI_CATALOG, nliModelId, pinnedEmbedUrl } from '../models/embed-catalog.js';
import { WASM_CACHE_NAME } from '../models/wasm-catalog.js';

/**
 * @typedef {import('../core/entail.js').NliLabel} NliLabel
 * @typedef {import('../core/entail.js').OpinionEngine} OpinionEngine
 * @typedef {import('../models/embed-catalog.js').NliSource} NliSource
 * @typedef {import('./client.js').WorkerReply} WorkerReply
 * @typedef {import('./client.js').WorkerRequest} WorkerRequest
 * @typedef {Record<NliLabel, number>} NliScores
 * @typedef {{ label: NliLabel, scores: NliScores }} NliResult
 * @typedef {{ phase: 'idle' | 'loading' | 'ready' | 'error', progress: number, error: string | null }} NliState
 */

/** Replaced at build time with the hashed worker URL (scripts/build.mjs). */
const WASM_WORKER_URL = '__STARPI_WASM_WORKER_URL__';

/** The model of a request whose files are not all stored and that has no consent to download them. */
export class NliConsentError extends Error {
  /** @param {NliSource} src */
  constructor(src) {
    super(`${src.label} is not stored on this device; downloading it (about ${src.approxDownloadMB} MB) needs the user's consent`);
    this.name = 'NliConsentError';
  }
}

/** The entailment model the second opinion uses. */
export function nliModel() {
  return NLI_CATALOG[DEFAULT_NLI_MODEL];
}

/** Whether on-device entailment can run in this browser (a module worker and WebAssembly). */
export function nliAvailable() {
  return typeof Worker === 'function' && typeof WebAssembly === 'object' && typeof location !== 'undefined';
}

/**
 * Whether the model's files are in the Transformers.js cache: 'none' also when the Cache API is
 * unavailable or unreadable.
 * @param {NliSource} [src]
 * @returns {Promise<'full' | 'partial' | 'none'>}
 */
export async function nliModelStored(src = nliModel()) {
  try {
    if (!globalThis.caches || !(await caches.has(WASM_CACHE_NAME))) return 'none';
    const cache = await caches.open(WASM_CACHE_NAME);
    const hits = await Promise.all(src.cacheProbe.map((file) => cache.match(embedFileUrl(src, file))));
    return hits.every(Boolean) ? 'full' : hits.some(Boolean) ? 'partial' : 'none';
  } catch {
    return 'none';
  }
}

/**
 * The model's stored files for the download check (models/integrity.js): its cache entries at the
 * pinned revision.
 * @param {NliSource} src
 * @returns {import('../models/integrity.js').ModelTarget}
 */
export function nliTarget(src) {
  return { id: `nli:${src.repo}`, label: src.label, runtime: 'nli', scopes: [{ cache: WASM_CACHE_NAME, match: (url) => pinnedEmbedUrl(src, url) }] };
}

/**
 * An Error that keeps the worker's name and message.
 * @param {{ name: string, message: string }} reply
 */
function workerError(reply) {
  const err = new Error(reply.message);
  err.name = reply.name;
  return err;
}

/** The NLI side of the processor runtime: one worker, one request per batch of pairs. */
export class NliClient {
  /** @type {Worker} */
  #worker;
  #seq = 0;
  /** @type {Map<number, (reply: WorkerReply) => void>} */
  #handlers = new Map();

  /** @param {Worker} worker */
  constructor(worker) {
    this.#worker = worker;
    worker.addEventListener('message', (event) => {
      const reply = /** @type {WorkerReply} */ (event.data);
      this.#handlers.get(reply.id)?.(reply);
    });
    const crash = (/** @type {Event} */ event) => {
      const message = event instanceof ErrorEvent && event.message ? event.message : 'Importing a module script failed';
      for (const [id, handler] of this.#handlers) handler({ id, type: 'error', name: 'Error', message });
    };
    worker.addEventListener('error', crash);
    worker.addEventListener('messageerror', crash);
  }

  /**
   * Classifies up to NLI_BATCH_SIZE pairs; the first call downloads or loads the model.
   * @param {NliSource} src
   * @param {Array<{ premise: string, hypothesis: string }>} pairs
   * @param {(p: { file: string, loaded: number, done: boolean }) => void} [onProgress]
   * @returns {Promise<NliScores[]>}
   */
  classify(src, pairs, onProgress) {
    if (pairs.length === 0 || pairs.length > NLI_BATCH_SIZE) return Promise.reject(new RangeError(`An entailment request holds 1 to ${NLI_BATCH_SIZE} pairs`));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#handlers.set(id, (reply) => {
        if (reply.type === 'progress') {
          onProgress?.({ file: reply.file, loaded: reply.loaded, done: reply.done });
          return;
        }
        this.#handlers.delete(id);
        if (reply.type === 'error') reject(workerError(reply));
        else if (reply.type !== 'classified' || reply.scores.length !== pairs.length) reject(new Error(`Unexpected reply: ${reply.type}`));
        else resolve(reply.scores);
      });
      /** @type {WorkerRequest} */
      const request = { id, type: 'nli', source: { repo: src.repo, revision: src.revision, dtype: src.dtype }, pairs };
      this.#worker.postMessage(request);
    });
  }

  terminate() {
    for (const [id, handler] of this.#handlers) handler({ id, type: 'error', name: 'AbortError', message: 'The entailment worker was stopped' });
    this.#handlers.clear();
    this.#worker.terminate();
  }
}

/** @type {NliClient | null} */
let client = null;
let modelReady = false;
/** @type {NliState} */
let state = { phase: 'idle', progress: 0, error: null };
/** @type {Set<(state: NliState) => void>} */
const listeners = new Set();
/** @type {Map<string, number>} */
const loadedBytes = new Map();

/** @param {Partial<NliState>} next */
function update(next) {
  state = { ...state, ...next };
  for (const fn of listeners) fn(state);
}

/** @returns {NliState} */
export function nliState() {
  return state;
}

/** @param {(state: NliState) => void} fn */
export function onNliChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @type {() => Worker} */
let createWorker = () => new Worker(new URL(WASM_WORKER_URL, location.href), { type: 'module', name: 'starpi-nli' });
/** @type {(target: import('../models/integrity.js').ModelTarget) => Promise<unknown>} */
let verify = async (target) => {
  const { verifyModel } = await import('../models/integrity.js');
  return verifyModel(target);
};
/** @type {(src: NliSource) => Promise<'full' | 'partial' | 'none'>} */
let stored = nliModelStored;

/**
 * Replaces the worker, the download check and the cache probe (tests).
 * @param {{ worker?: () => Worker, verify?: (target: import('../models/integrity.js').ModelTarget) => Promise<unknown>, stored?: (src: NliSource) => Promise<'full' | 'partial' | 'none'> }} parts
 */
export function setNliRuntime(parts) {
  stopNli();
  if (parts.worker) createWorker = parts.worker;
  if (parts.verify) verify = parts.verify;
  if (parts.stored) stored = parts.stored;
}

/** Stops the worker; the next request starts a new one (the model then loads from the cache). */
export function stopNli() {
  client?.terminate();
  client = null;
  modelReady = false;
  loadedBytes.clear();
  update({ phase: 'idle', progress: 0, error: null });
}

/**
 * Probabilities of entailment, neutral and contradiction for each premise/hypothesis pair, in
 * batches of NLI_BATCH_SIZE. Refused with NliConsentError while the model is not stored and
 * `consent` is not given.
 * @param {Array<{ premise: string, hypothesis: string }>} pairs
 * @param {{ consent?: boolean, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<NliScores[]>}
 */
export async function classifyPairs(pairs, options = {}) {
  const src = nliModel();
  if (!pairs.length) return [];
  if (!modelReady && !options.consent && (await stored(src)) !== 'full') throw new NliConsentError(src);
  const sizes = new Map(src.files.map(([file, bytes]) => [file, bytes]));
  const total = src.files.reduce((sum, [, bytes]) => sum + bytes, 0);
  try {
    if (!modelReady) {
      update({ phase: 'loading', error: null });
      // Stored files are checked before the worker reads them.
      await verify(nliTarget(src));
    }
    client ??= new NliClient(createWorker());
    /** @type {NliScores[]} */
    const out = [];
    for (let i = 0; i < pairs.length; i += NLI_BATCH_SIZE) {
      const batch = pairs.slice(i, i + NLI_BATCH_SIZE);
      out.push(
        ...(await client.classify(src, batch, (p) => {
          const size = sizes.get(p.file) ?? 0;
          loadedBytes.set(p.file, Math.min(p.done ? size : p.loaded, size));
          const loaded = [...loadedBytes.values()].reduce((sum, n) => sum + n, 0);
          update({ progress: total ? loaded / total : 0 });
        })),
      );
      if (!modelReady) {
        // New downloads are checked before the first result is used; a failed check stops the worker.
        await verify(nliTarget(src));
        modelReady = true;
        update({ phase: 'ready', progress: 1 });
      }
      options.onProgress?.(out.length, pairs.length);
    }
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    client?.terminate();
    client = null;
    modelReady = false;
    update({ phase: 'error', error: message });
    throw err;
  }
}

/**
 * Classifies whether `premise` entails `hypothesis`: the most probable label and all probabilities.
 * @param {string} premise
 * @param {string} hypothesis
 * @param {{ consent?: boolean }} [options]
 * @returns {Promise<NliResult>}
 */
export async function nli(premise, hypothesis, options = {}) {
  const [scores] = await classifyPairs([{ premise, hypothesis }], options);
  const label = /** @type {NliLabel} */ (Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0]);
  return { label, scores };
}

/**
 * The second-opinion engine on this device (core/entail.js OpinionEngine).
 * @param {{ consent?: boolean }} [options]  the user agreed to download the model
 * @returns {OpinionEngine}
 */
export function nliEngine(options = {}) {
  const src = nliModel();
  return {
    id: 'nli',
    model: nliModelId(src),
    classify: async (pairs, onProgress) => (await classifyPairs(pairs, { consent: options.consent, onProgress })).map((scores) => nliResult(scores)),
  };
}
