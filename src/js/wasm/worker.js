// @ts-check
/// <reference lib="webworker" />
// Processor (WASM) runtime: Transformers.js runs a catalog model (src/js/models/wasm-catalog.js) on
// the CPU with a self-hosted, single-threaded ONNX Runtime. Only catalog models load, and every
// download comes from huggingface.co at the model's pinned revision.
//
// Protocol (main -> worker), handled one after another:
//   { id, type: 'load', source: { repo, revision, dtype } }               -> progress*, ready
//   { id, type: 'generate', messages, maxTokens, temperature, ignoreEos } -> delta*, done { usage }
//   { id, type: 'unload' }                                                -> unloaded
//   { type: 'interrupt', upTo } stops the running generation at its next token and skips queued
//                                generations with an id up to `upTo` (handled at once)
// Replies: { id, type: 'progress', file, loaded, done } | { id, type: 'ready' } | { id, type: 'delta', text }
//   | { id, type: 'done', usage: { prompt_tokens, completion_tokens } } | { id, type: 'unloaded' }
//   | { id, type: 'error', name, message }   (no stack traces)
import { AutoModelForCausalLM, AutoTokenizer, env, InterruptableStoppingCriteria, TextStreamer } from '@huggingface/transformers';
import { findWasmSource, pinnedWasmUrl, WASM_CACHE_NAME } from '../models/wasm-catalog.js';

/**
 * @typedef {import('./client.js').WorkerRequest} WorkerRequest
 * @typedef {import('./client.js').WorkerReply} WorkerReply
 * @typedef {import('./client.js').GenerateRequest} GenerateRequest
 * @typedef {import('../models/wasm-catalog.js').WasmSource} WasmSource
 *
 * @typedef {import('@huggingface/transformers').PreTrainedTokenizer} Tokenizer
 *
 * Parts of Transformers.js typed locally where its declarations are loose or generic.
 * @typedef {{ input_ids: { dims: number[] } }} TokenizedChat
 * @typedef {{ generate(options: object): Promise<unknown>, forward(inputs: unknown): Promise<unknown>, dispose(): Promise<unknown> }} CausalLM
 * @typedef {{ status: string, file?: string, loaded?: number }} ProgressInfo
 */

/** Replaced at build time with the content-hashed ONNX Runtime binary (scripts/build.mjs). */
const ORT_WASM_URL = '__STARPI_ORT_WASM_URL__';

env.allowLocalModels = false; // no /models/... requests to this site
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.cacheKey = WASM_CACHE_NAME;
// A cached runtime would turn ONNX Runtime's glue into a blob: module, which script-src 'self' blocks.
env.useWasmCache = false;
// env.backends.onnx is a shallow copy of ONNX Runtime's env: the .wasm object is shared, so set its
// fields; replacing it would leave ONNX Runtime with the CDN default, which the CSP blocks.
const ortWasm = /** @type {{ wasm: { wasmPaths?: unknown, numThreads?: number, proxy?: boolean } }} */ (/** @type {unknown} */ (env.backends.onnx)).wasm;
// The binary only: the glue is bundled with onnxruntime-web/wasm (scripts/build.mjs).
ortWasm.wasmPaths = { wasm: new URL(ORT_WASM_URL, self.location.href).href };
// Threads need SharedArrayBuffer, which needs cross-origin isolation (COEP); the app is not isolated.
ortWasm.numThreads = 1;
ortWasm.proxy = false;

/** @type {WasmSource | null} */
let source = null;
/** @type {Tokenizer | null} */
let tokenizer = null;
/** @type {CausalLM | null} */
let model = null;
/** @type {InterruptableStoppingCriteria | null} */
let stopping = null;
/** Requests run one after another; 'interrupt' bypasses the queue. */
let queue = Promise.resolve();
/** Generations with an id up to this one were stopped, possibly before they started. */
let interruptedUpTo = 0;

/**
 * Every download of Transformers.js goes through here: files of the loading model only, at its
 * pinned revision. Transformers.js 4.3 checks that tokenizer_config.json exists at the 'main'
 * revision; that check is pinned too and answered from the cache when the model is stored, so a
 * stored model also loads offline.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
env.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const pinned = source && pinnedWasmUrl(source, url);
  if (!pinned) throw new TypeError(`Blocked a request outside the pinned model: ${url}`);
  const cached = await caches.match(pinned, { cacheName: WASM_CACHE_NAME }).catch(() => undefined);
  return cached ?? fetch(pinned, init);
};

/** @param {WorkerReply} reply */
function post(reply) {
  self.postMessage(reply);
}

/**
 * ONNX Runtime finishes each forward pass without returning to the event loop, so a running
 * generation would hold back the 'interrupt' message until its end. One macrotask per token lets
 * the message through.
 * @param {CausalLM} m
 */
function yieldBetweenTokens(m) {
  const forward = m.forward.bind(m);
  m.forward = async (inputs) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return forward(inputs);
  };
}

/**
 * @param {number} id
 * @param {{ repo: string, revision: string, dtype: string }} requested
 */
async function load(id, requested) {
  const src = findWasmSource(requested);
  if (!src) throw new Error('Only catalog models can be loaded');
  await unload();
  source = src;
  const options = {
    revision: src.revision,
    progress_callback: (/** @type {ProgressInfo} */ p) => {
      if ((p.status === 'progress' || p.status === 'done') && p.file) post({ id, type: 'progress', file: p.file, loaded: p.loaded ?? 0, done: p.status === 'done' });
    },
  };
  const [loadedTokenizer, loadedModel] = await Promise.all([
    AutoTokenizer.from_pretrained(src.repo, options),
    AutoModelForCausalLM.from_pretrained(src.repo, { ...options, dtype: src.dtype, device: 'wasm' }),
  ]);
  tokenizer = loadedTokenizer;
  model = /** @type {CausalLM} */ (/** @type {unknown} */ (loadedModel));
  yieldBetweenTokens(model);
  post({ id, type: 'ready' });
}

/**
 * @param {number} id
 * @param {GenerateRequest} req
 */
async function generate(id, req) {
  if (!model || !tokenizer) throw new Error('No model is loaded');
  // Stopped while it waited behind the previous one: it would otherwise run to maxTokens.
  if (id <= interruptedUpTo) {
    post({ id, type: 'done', usage: { prompt_tokens: 0, completion_tokens: 0 } });
    return;
  }
  const inputs = /** @type {TokenizedChat} */ (/** @type {unknown} */ (tokenizer.apply_chat_template(req.messages, { add_generation_prompt: true, return_dict: true })));
  const criteria = new InterruptableStoppingCriteria();
  stopping = criteria;
  let completionTokens = 0;
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (/** @type {string} */ text) => post({ id, type: 'delta', text }),
    token_callback_function: () => {
      completionTokens += 1;
    },
  });
  try {
    await model.generate({
      ...inputs,
      max_new_tokens: req.maxTokens,
      do_sample: req.temperature > 0,
      ...(req.temperature > 0 ? { temperature: req.temperature } : {}),
      // The benchmark generates exactly maxTokens tokens.
      ...(req.ignoreEos ? { min_new_tokens: req.maxTokens } : {}),
      streamer,
      stopping_criteria: criteria,
    });
  } finally {
    if (stopping === criteria) stopping = null;
  }
  post({ id, type: 'done', usage: { prompt_tokens: inputs.input_ids.dims[1] ?? 0, completion_tokens: completionTokens } });
}

async function unload() {
  const m = model;
  model = null;
  tokenizer = null;
  source = null;
  await m?.dispose();
}

self.addEventListener('message', (event) => {
  const msg = /** @type {WorkerRequest} */ (event.data);
  if (msg.type === 'interrupt') {
    interruptedUpTo = Math.max(interruptedUpTo, msg.upTo);
    stopping?.interrupt();
    return;
  }
  const { id } = msg;
  const run =
    msg.type === 'load'
      ? () => load(id, msg.source)
      : msg.type === 'generate'
        ? () => generate(id, msg)
        : () => unload().then(() => post({ id, type: 'unloaded' }));
  queue = queue.then(run).catch((err) => {
    post({ id, type: 'error', name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) });
  });
});
