// @ts-check
// Main-thread side of the processor (WASM) runtime. WasmEngineClient drives src/js/wasm/worker.js
// and offers the part of WebLLM's engine API that webgpu/engine.js uses, so loading, streaming,
// Stop, the benchmark and unloading work the same for both runtimes. wasmCacheStatus tells whether
// a model is stored without starting the worker.
import { embedFileUrl } from '../models/embed-catalog.js';
import { WASM_CACHE_NAME, wasmFileUrl } from '../models/wasm-catalog.js';

/**
 * @typedef {import('../models/wasm-catalog.js').WasmSource} WasmSource
 * @typedef {import('../webgpu/engine.js').StreamChunk} StreamChunk
 * @typedef {import('../webgpu/engine.js').StreamRequest} StreamRequest
 *
 * Worker protocol (see the header of wasm/worker.js).
 * @typedef {{ role: string, content: string }} ChatMessage
 * @typedef {{ type: 'load', source: { repo: string, revision: string, dtype: string } } | { type: 'unload' }} ControlRequest
 * @typedef {{ type: 'generate', messages: ChatMessage[], maxTokens: number, temperature: number, ignoreEos: boolean }} GenerateRequest
 * @typedef {{ type: 'embed', source: { repo: string, revision: string, dtype: string }, texts: string[], kind: 'query' | 'passage' }} EmbedBody
 * @typedef {EmbedBody & { id: number }} EmbedRequest
 * @typedef {(ControlRequest | GenerateRequest | EmbedBody) & { id: number } | { type: 'interrupt', upTo: number }} WorkerRequest
 * @typedef {{ prompt_tokens: number, completion_tokens: number }} Usage
 * @typedef {{ id: number, type: 'progress', file: string, loaded: number, done: boolean }
 *   | { id: number, type: 'ready' | 'unloaded' }
 *   | { id: number, type: 'delta', text: string }
 *   | { id: number, type: 'done', usage: Usage }
 *   | { id: number, type: 'embedded', dim: number, count: number, data: Float32Array }
 *   | { id: number, type: 'error', name: string, message: string }} WorkerReply
 *
 * @typedef {{ progress: number, stage: 'files' | 'session' }} WasmLoadProgress share of the model's
 *   bytes loaded; 'session' once every file is there and ONNX Runtime prepares the model
 */

/**
 * Whether a model's files are in the Transformers.js cache. 'none' also when the Cache API is
 * unavailable or unreadable: Transformers.js could not have stored anything there either.
 * @param {WasmSource} src
 * @returns {Promise<'full' | 'partial' | 'none'>}
 */
export async function wasmCacheStatus(src) {
  try {
    if (!globalThis.caches || !(await caches.has(WASM_CACHE_NAME))) return 'none';
    const cache = await caches.open(WASM_CACHE_NAME);
    const hits = await Promise.all(src.cacheProbe.map((file) => cache.match(wasmFileUrl(src, file))));
    return hits.every(Boolean) ? 'full' : hits.some(Boolean) ? 'partial' : 'none';
  } catch {
    return 'none';
  }
}

/**
 * Whether an embedding model's files are in the Transformers.js cache (same rules as
 * wasmCacheStatus).
 * @param {import('../models/embed-catalog.js').EmbedSource} src
 * @returns {Promise<'full' | 'partial' | 'none'>}
 */
export async function embedCacheStatus(src) {
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
 * An Error that keeps the worker's name and message, so classifyEngineError can map it.
 * @param {{ name: string, message: string }} reply
 */
function workerError(reply) {
  const err = new Error(reply.message);
  err.name = reply.name;
  return err;
}

export class WasmEngineClient {
  /** @type {Worker} */
  #worker;
  #seq = 0;
  /** @type {Map<number, (reply: WorkerReply) => void>} */
  #handlers = new Map();
  /** Ends the running stream at once; set while a stream is read. @type {(() => void) | null} */
  #endStream = null;

  /** Same shape as WebLLM: `chat.completions.create({ stream: true, … })` resolves to a stream. */
  chat = {
    completions: {
      /** @param {StreamRequest} req */
      create: (req) => Promise.resolve(this.#stream(req)),
    },
  };

  /** @param {Worker} worker */
  constructor(worker) {
    this.#worker = worker;
    worker.addEventListener('message', (event) => {
      const reply = /** @type {WorkerReply} */ (event.data);
      this.#handlers.get(reply.id)?.(reply);
    });
    // A worker that fails to start (its script did not load) reports an Event without a message.
    const crash = (/** @type {Event} */ event) => {
      const message = event instanceof ErrorEvent && event.message ? event.message : 'Importing a module script failed';
      for (const [id, handler] of this.#handlers) handler({ id, type: 'error', name: 'Error', message });
    };
    worker.addEventListener('error', crash);
    worker.addEventListener('messageerror', crash);
  }

  /**
   * Starts the worker on a catalog model and resolves once it can generate.
   * @param {Worker} worker
   * @param {WasmSource} src
   * @param {(p: WasmLoadProgress) => void} onProgress
   * @returns {Promise<WasmEngineClient>}
   */
  static async load(worker, src, onProgress) {
    const client = new WasmEngineClient(worker);
    const sizes = new Map(src.files);
    const totalBytes = src.files.reduce((sum, [, bytes]) => sum + bytes, 0);
    /** @type {Map<string, number>} */
    const loaded = new Map();
    /** @type {Set<string>} */
    const done = new Set();
    await client.#request({ type: 'load', source: { repo: src.repo, revision: src.revision, dtype: src.dtype } }, (reply) => {
      if (reply.type !== 'progress') return;
      const size = sizes.get(reply.file) ?? 0;
      if (reply.done) done.add(reply.file);
      loaded.set(reply.file, Math.min(reply.done ? size : reply.loaded, size));
      const bytes = [...loaded.values()].reduce((sum, n) => sum + n, 0);
      onProgress({ progress: totalBytes ? bytes / totalBytes : 0, stage: src.files.every(([file]) => done.has(file)) ? 'session' : 'files' });
    });
    return client;
  }

  /**
   * Sends a load or unload request and settles with its final reply; progress goes to `onReply`.
   * @param {ControlRequest} request
   * @param {(reply: WorkerReply) => void} [onReply]
   * @returns {Promise<void>}
   */
  #request(request, onReply) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#handlers.set(id, (reply) => {
        if (reply.type !== 'error' && reply.type !== 'ready' && reply.type !== 'unloaded') {
          onReply?.(reply);
          return;
        }
        this.#handlers.delete(id);
        if (reply.type === 'error') reject(workerError(reply));
        else resolve();
      });
      this.#worker.postMessage(/** @type {WorkerRequest} */ ({ ...request, id }));
    });
  }

  /**
   * Streams one completion as WebLLM-style chunks. Stop (interruptGenerate) ends the stream at once
   * and the worker stops at its next token.
   * @param {StreamRequest} req
   * @returns {AsyncGenerator<StreamChunk>}
   */
  async *#stream(req) {
    const id = ++this.#seq;
    /** @type {WorkerReply[]} */
    const replies = [];
    /** @type {(() => void) | null} */
    let wake = null;
    let ended = false;
    this.#handlers.set(id, (reply) => {
      replies.push(reply);
      wake?.();
    });
    this.#endStream = () => {
      ended = true;
      wake?.();
    };
    /** @type {WorkerRequest} */
    const request = { id, type: 'generate', messages: req.messages.map(toChatMessage), maxTokens: req.max_tokens, temperature: req.temperature, ignoreEos: Boolean(req.ignore_eos) };
    this.#worker.postMessage(request);
    try {
      while (!ended) {
        const reply = replies.shift();
        if (!reply) {
          await new Promise((resolve) => {
            wake = () => resolve(undefined);
          });
          wake = null;
        } else if (reply.type === 'delta') {
          yield { choices: [{ delta: { content: reply.text } }] };
        } else if (reply.type === 'done') {
          if (req.stream_options?.include_usage) yield { choices: [], usage: reply.usage };
          return;
        } else if (reply.type === 'error') {
          throw workerError(reply);
        }
      }
    } finally {
      this.#handlers.delete(id);
      this.#endStream = null;
    }
  }

  interruptGenerate() {
    // Covers a generation that is still queued in the worker, not only the running one.
    this.#worker.postMessage(/** @type {WorkerRequest} */ ({ type: 'interrupt', upTo: this.#seq }));
    this.#endStream?.();
  }

  /** Stateless: every request carries the whole conversation. */
  async resetChat() {}

  unload() {
    return this.#request({ type: 'unload' });
  }
}

/**
 * Chat messages as the worker takes them: role and text only.
 * @param {StreamRequest['messages'][number]} message
 * @returns {ChatMessage}
 */
function toChatMessage(message) {
  return { role: message.role, content: typeof message.content === 'string' ? message.content : '' };
}

/**
 * The embedding side of the processor runtime: one worker of its own (so loading a chat model
 * never drops the search model), requests of up to EMBED_BATCH_SIZE texts, vectors back as one
 * transferred Float32Array per request.
 */
export class WasmEmbedClient {
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
   * Embeds texts with a catalog model; the first call downloads or loads the model.
   * @param {import('../models/embed-catalog.js').EmbedSource} src
   * @param {string[]} texts
   * @param {'query' | 'passage'} kind
   * @param {(p: { file: string, loaded: number, done: boolean }) => void} [onProgress]
   * @returns {Promise<Float32Array[]>} one vector per text
   */
  embed(src, texts, kind, onProgress) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#handlers.set(id, (reply) => {
        if (reply.type === 'progress') {
          onProgress?.({ file: reply.file, loaded: reply.loaded, done: reply.done });
          return;
        }
        this.#handlers.delete(id);
        if (reply.type === 'error') {
          reject(workerError(reply));
          return;
        }
        if (reply.type !== 'embedded') {
          reject(new Error(`Unexpected reply: ${reply.type}`));
          return;
        }
        const out = [];
        for (let i = 0; i < reply.count; i += 1) out.push(reply.data.subarray(i * reply.dim, (i + 1) * reply.dim));
        resolve(out);
      });
      /** @type {WorkerRequest} */
      const request = { id, type: 'embed', source: { repo: src.repo, revision: src.revision, dtype: src.dtype }, texts, kind };
      this.#worker.postMessage(request);
    });
  }

  terminate() {
    for (const [id, handler] of this.#handlers) handler({ id, type: 'error', name: 'AbortError', message: 'The embedding worker was stopped' });
    this.#handlers.clear();
    this.#worker.terminate();
  }
}
