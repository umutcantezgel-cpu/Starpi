// @ts-check
// Lifecycle controller for the on-device engine: WebLLM on the GPU (running in webgpu/worker.js), or
// Transformers.js on the processor (WASM, running in wasm/worker.js) when the model ref asks for it.
//
// State machine: idle -> loading -> ready, with error as a terminal state until the next load.
// Every load gets a sequence number; cancel/unload bump it, so late results of superseded loads are
// discarded and their worker is terminated. Teardown always ends in worker.terminate(), which frees
// GPU memory even if the engine is stuck mid-download or its device was lost.
import { WASM_CACHE_NAME, WASM_RUNTIME_MB } from '../models/wasm-catalog.js';
import { wasmCacheStatus, WasmEngineClient } from '../wasm/client.js';
import { ALL_MODEL_IDS, chooseModel, detectMobile } from './models.js';

/** Replaced at build time with the hashed worker URLs (scripts/build.mjs). */
const WORKER_URL = '__STARPI_WEBLLM_WORKER_URL__';
const WASM_WORKER_URL = '__STARPI_WASM_WORKER_URL__';

/** @typedef {import('./models.js').ModelChoice} ModelChoice */
/** @typedef {import('./models.js').ModelPreference} ModelPreference */
/** @typedef {import('./models.js').HardwareProfile} HardwareProfile */
/** @typedef {typeof import('@mlc-ai/web-llm')} WebLLM */
/** @typedef {import('@mlc-ai/web-llm').InitProgressReport} InitProgressReport */
/** @typedef {import('@mlc-ai/web-llm').ChatCompletionMessageParam} ChatCompletionMessageParam */

/**
 * The part of WebLLM's engine API this module uses; WasmEngineClient implements the same.
 * @typedef {{ choices: Array<{ delta?: { content?: string | null } }>, usage?: { prompt_tokens?: number, completion_tokens?: number, extra?: BenchmarkRun['engineStats'] } }} StreamChunk
 * @typedef {{ messages: ChatCompletionMessageParam[], temperature: number, max_tokens: number, stream: true, ignore_eos?: boolean, stream_options?: { include_usage: boolean } }} StreamRequest
 * @typedef {{ chat: { completions: { create(req: StreamRequest): Promise<AsyncIterable<StreamChunk>> } }, interruptGenerate(): void, unload(): Promise<void>, resetChat(): Promise<void> }} LocalEngine
 */

/**
 * @typedef {'unsupported' | 'no-adapter' | 'quota' | 'network' | 'code-download' | 'device-lost' | 'out-of-memory' | 'cancelled' | 'busy' | 'not-loaded' | 'unknown'} EngineErrorKind
 */

/**
 * Engine failures carry a kind (for the UI to localize) and a developer-facing English message.
 */
export class EngineError extends Error {
  /**
   * @param {EngineErrorKind} kind
   * @param {string} message
   * @param {unknown} [cause]
   * @param {Record<string, string | number>} [details] values for the localized message
   */
  constructor(kind, message, cause, details) {
    super(message, { cause });
    this.name = 'EngineError';
    this.kind = kind;
    this.details = details ?? {};
  }
}

/** @typedef {'init' | 'download' | 'cache' | 'shaders' | 'finalizing'} LoadPhase */

/**
 * Maps WebLLM's progress text onto a load phase the UI can name in any language.
 * @param {string} text
 * @returns {LoadPhase}
 */
export function classifyProgress(text) {
  if (/^Fetching param cache|^Start to fetch params/i.test(text)) return 'download';
  if (/^Loading model from cache/i.test(text)) return 'cache';
  if (/shader/i.test(text)) return 'shaders';
  if (/^Finish loading/i.test(text)) return 'finalizing';
  return 'init';
}

/**
 * @typedef {object} EngineState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ModelChoice | null} model
 * @property {EngineError | null} error
 * @property {{ progress: number, text: string, phase: LoadPhase, label?: string } | null} progress label: the model being loaded
 */

/** @type {EngineState} */
let state = { status: 'idle', model: null, error: null, progress: null };
/** @type {Set<(s: EngineState) => void>} */
const listeners = new Set();

/** @type {LocalEngine | null} */
let engine = null;
/** @type {Worker | null} */
let worker = null;
let loadSeq = 0;
/** @type {Promise<boolean> | null} */
let loadPromise = null;
/** @type {((reason: EngineError) => void) | null} */
let abortPending = null;
/** @type {Promise<WebLLM> | null} */
let webllmModule = null;
let generating = false;

/** @param {Partial<EngineState>} patch */
function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export function getEngineState() {
  return state;
}

/** @param {(s: EngineState) => void} fn */
export function onEngineChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isReady() {
  return state.status === 'ready' && engine !== null;
}

function loadWebLLM() {
  // A failed import is not cached here, although the browser may keep the failure until a reload.
  webllmModule ??= import('@mlc-ai/web-llm').catch((err) => {
    webllmModule = null;
    throw err;
  });
  return webllmModule;
}

/** Scope and URL layout WebLLM uses for its model cache (Cache API, "webllm/model"). */
const MODEL_CACHE = 'webllm/model';

/**
 * True only when the model is certainly not cached: its tensor index is missing from WebLLM's cache.
 * Lets the app skip downloading the 6 MB WebLLM library just to learn that nothing is cached.
 * @param {string} modelId
 */
async function certainlyNotCached(modelId) {
  try {
    if (!globalThis.caches) return false;
    if (!(await caches.has(MODEL_CACHE))) return true;
    const cache = await caches.open(MODEL_CACHE);
    return !(await cache.match(`https://huggingface.co/mlc-ai/${modelId}/resolve/main/tensor-cache.json`));
  } catch {
    return false;
  }
}

/**
 * @typedef {object} AdapterDetails
 * @property {{ vendor: string, architecture: string, device: string, description: string }} info
 * @property {Record<string, number>} limits
 * @property {string[]} features
 */

const REPORTED_LIMITS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupSizeY',
  'maxComputeWorkgroupSizeZ',
  'maxComputeWorkgroupsPerDimension',
  'maxStorageBuffersPerShaderStage',
];

/** @typedef {{ powerPreference?: 'high-performance' | 'low-power' }} AdapterOptions */
/** @typedef {{ supported: true, hw: HardwareProfile, adapter: AdapterDetails } | { supported: false, error: EngineError }} WebGPUProbe */
/** @typedef {{ hw: HardwareProfile, webgpu: WebGPUProbe }} DeviceProbe */

/** What the navigator tells about the device, with or without WebGPU. */
function navigatorHints() {
  const nav = /** @type {Navigator & { deviceMemory?: number, userAgentData?: { mobile?: boolean } }} */ (navigator);
  return {
    isMobile: detectMobile({ userAgent: nav.userAgent ?? '', userAgentDataMobile: nav.userAgentData?.mobile }),
    deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
  };
}

/**
 * Checks WebGPU availability and reads the adapter capabilities used for model selection and the
 * diagnostics panel.
 * @param {AdapterOptions} [options] the adapter request; loading a model asks for the fast GPU
 * @returns {Promise<WebGPUProbe>}
 */
export async function probeWebGPU(options = { powerPreference: 'high-performance' }) {
  /** @typedef {{ limits?: Record<string, unknown> & { maxBufferSize?: number }, features?: { has(name: string): boolean } & Iterable<string>, info?: Partial<AdapterDetails['info']> }} AdapterLike */
  /** @typedef {{ requestAdapter?: (opts?: AdapterOptions) => Promise<AdapterLike | null> }} GpuLike */
  const gpu = /** @type {{ gpu?: GpuLike }} */ (/** @type {unknown} */ (navigator)).gpu;
  if (!gpu?.requestAdapter) {
    return { supported: false, error: new EngineError('unsupported', 'navigator.gpu is not available in this browser') };
  }
  let adapter;
  try {
    adapter = await gpu.requestAdapter(options);
  } catch (err) {
    return { supported: false, error: new EngineError('no-adapter', 'requestAdapter() failed', err) };
  }
  if (!adapter) {
    return { supported: false, error: new EngineError('no-adapter', 'requestAdapter() returned no adapter (GPU blocked or disabled)') };
  }
  /** @type {Record<string, number>} */
  const limits = {};
  for (const name of REPORTED_LIMITS) {
    const value = Number(adapter.limits?.[name]);
    if (Number.isFinite(value)) limits[name] = value;
  }
  const info = adapter.info ?? {};
  return {
    supported: true,
    adapter: {
      info: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' },
      limits,
      features: adapter.features ? [...adapter.features].sort() : [],
    },
    hw: {
      ...navigatorHints(),
      maxBufferSize: Number(adapter.limits?.maxBufferSize ?? 0),
      hasF16: Boolean(adapter.features?.has?.('shader-f16')),
    },
  };
}

/**
 * A device without usable WebGPU: only processor (WASM) models run.
 * @param {EngineError} error why WebGPU is not available
 * @returns {DeviceProbe}
 */
function withoutWebGPU(error) {
  return { webgpu: { supported: false, error }, hw: { ...navigatorHints(), maxBufferSize: 0, hasF16: false, webgpu: false } };
}

/**
 * The device profile for model selection: the adapter's capabilities, or a profile without WebGPU
 * when the browser offers no adapter.
 * @param {AdapterOptions} [options]
 * @returns {Promise<DeviceProbe>}
 */
export async function probeDevice(options) {
  const webgpu = await probeWebGPU(options);
  if (!webgpu.supported) return withoutWebGPU(webgpu.error);
  const { limits, info } = webgpu.adapter;
  return {
    webgpu,
    hw: { ...webgpu.hw, webgpu: true, maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize ?? 0, vendor: info.vendor, architecture: info.architecture },
  };
}

/** A menu must not wait long for an adapter that never answers. */
const PICKER_PROBE_TIMEOUT_MS = 2_500;
/** @type {Promise<DeviceProbe> | null} */
let pickerProbe = null;

/**
 * The device profile for the model picker, probed once. It asks for the browser's default adapter
 * (filling a menu should not wake a discrete GPU) and counts as "no WebGPU" when the adapter does
 * not answer within 2.5 s. Loading a model always probes afresh.
 * @returns {Promise<DeviceProbe>}
 */
export function getDeviceProbe() {
  pickerProbe ??= Promise.race([
    probeDevice({}),
    /** @type {Promise<DeviceProbe>} */ (
      new Promise((resolve) => {
        setTimeout(() => resolve(withoutWebGPU(new EngineError('no-adapter', 'requestAdapter() did not answer in time'))), PICKER_PROBE_TIMEOUT_MS);
      })
    ),
  ]);
  return pickerProbe;
}

/**
 * Maps WebLLM/WebGPU/storage failures onto user-actionable kinds.
 * @param {unknown} err
 * @returns {EngineError}
 */
export function classifyEngineError(err) {
  if (err instanceof EngineError) return err;
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'QuotaExceededError' || /quota/i.test(message)) {
    return new EngineError('quota', 'Storage quota exceeded while caching model data', err);
  }
  if (name === 'DeviceLostError' || /device (was )?lost|device is lost|GPUDevice.*destroyed/i.test(message)) {
    return new EngineError('device-lost', 'The GPU device was lost', err);
  }
  if (/out of memory|OOM|allocation failed|failed to allocate/i.test(message)) {
    return new EngineError('out-of-memory', 'Out of GPU memory for this model', err);
  }
  if (/dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message)) {
    return new EngineError('code-download', 'The on-device engine could not be downloaded', err);
  }
  if (name === 'TypeError' && /fetch|network|load failed/i.test(message)) {
    return new EngineError('network', 'Model download failed', err);
  }
  if (/WebGPU|navigator\.gpu|shader-f16/i.test(message) && /not (supported|available)/i.test(message)) {
    return new EngineError('unsupported', 'WebGPU is not available on this device', err);
  }
  return new EngineError('unknown', message || 'Unknown error while loading the model', err, { reason: message || '–' });
}

/**
 * Checks the storage quota before a multi-GB download.
 * @param {number} requiredMB
 */
async function checkQuota(requiredMB) {
  const storage = navigator.storage;
  if (!storage?.estimate) return;
  const { quota = 0, usage = 0 } = await storage.estimate();
  const freeMB = (quota - usage) / (1024 * 1024);
  if (quota > 0 && freeMB < requiredMB * 1.2) {
    throw new EngineError('quota', `Not enough storage: need ~${requiredMB} MB, ~${Math.floor(freeMB)} MB available`, undefined, {
      requiredMB,
      freeMB: Math.floor(freeMB),
    });
  }
}

/** Asks for persistent storage, only after the user agreed to the download. */
async function requestPersistence() {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is best effort; the browser may still evict under pressure.
  }
}

/**
 * Quota check, confirmation and persistence before a download. Resolves false when declined.
 * @param {ModelChoice} choice
 * @param {LoadOptions} options
 */
async function agreeToDownload(choice, options) {
  // A processor model may also need the ONNX Runtime binary, which is cached like the app's assets.
  await checkQuota(Math.max(choice.approxDownloadMB + (choice.runtime === 'wasm' ? WASM_RUNTIME_MB : 0), 1));
  if (options.confirmDownload && !(await options.confirmDownload(choice))) return false;
  await requestPersistence();
  return true;
}

/** Releases the engine and its worker. Never throws. */
async function teardown() {
  const e = engine;
  const w = worker;
  engine = null;
  worker = null;
  if (e) {
    try {
      e.interruptGenerate();
    } catch {
      // ignore
    }
    try {
      await Promise.race([e.unload(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    } catch {
      // ignore: the worker is terminated below either way
    }
  }
  w?.terminate();
}

/**
 * @typedef {object} LoadOptions
 * @property {ModelPreference} preference
 * @property {(choice: ModelChoice) => Promise<boolean> | boolean} [confirmDownload] asked before a model is downloaded
 * @property {boolean} [onlyIfCached] do not download; resolve false when the model is not cached yet
 */

/**
 * Loads (or reuses) the model for the current hardware. Concurrent callers share one load.
 * Resolves true when ready, false when cancelled/superseded/declined; rejects with EngineError on failure.
 * @param {LoadOptions} options
 * @returns {Promise<boolean>}
 */
export function loadModel(options) {
  if (loadPromise) return loadPromise;
  const seq = ++loadSeq;
  /** @type {Promise<never>} */
  const aborted = new Promise((_, reject) => {
    abortPending = reject;
  });
  aborted.catch(() => {});
  const current = () => seq === loadSeq;

  const run = async () => {
    const { hw, webgpu } = await probeDevice();
    const choice = chooseModel(hw, options.preference);
    // A WebGPU preset picked on a device without WebGPU: say why instead of switching runtimes.
    if (choice.runtime === 'webgpu' && !webgpu.supported) throw webgpu.error;

    if (engine && state.model?.runtime === choice.runtime && state.model.modelId === choice.modelId) return true;
    // Settle the cheap questions first: without a cached model, a start-up load stops here silently,
    // and an interactive load asks for consent before anything is downloaded. A processor model
    // that is not fully cached (or whose cache cannot be read) always needs consent.
    const wasm = choice.wasm;
    const missing = wasm ? (await wasmCacheStatus(wasm)) !== 'full' : await certainlyNotCached(choice.modelId);
    if (missing) {
      if (options.onlyIfCached) return false;
      if (!(await agreeToDownload(choice, options))) return false;
      if (!current()) return false;
    }
    await teardown();
    if (!current()) return false;
    setState({ status: 'loading', error: null, model: null, progress: { progress: 0, text: '', phase: 'init', label: choice.label } });

    if (wasm) {
      const w = new Worker(new URL(WASM_WORKER_URL, location.href), { type: 'module', name: 'starpi-wasm' });
      worker = w;
      const created = await Promise.race([
        WasmEngineClient.load(w, wasm, ({ progress, stage }) => {
          if (current()) setState({ progress: { progress, text: '', phase: stage === 'session' ? 'finalizing' : missing ? 'download' : 'cache', label: choice.label } });
        }),
        aborted,
      ]);
      if (!current()) {
        w.terminate();
        return false;
      }
      engine = created;
      setState({ status: 'ready', error: null, progress: null, model: choice });
      return true;
    }

    const webllm = await Promise.race([loadWebLLM(), aborted]);
    if (!current()) return false;
    const record = webllm.prebuiltAppConfig.model_list.find((m) => m.model_id === choice.modelId);
    if (!record) throw new EngineError('unknown', `Model ${choice.modelId} is not in this WebLLM build`, undefined, { reason: choice.modelId });

    const cached = missing ? false : await webllm.hasModelInCache(choice.modelId).catch(() => false);
    if (!cached && !missing) {
      // Partly cached (the index exists, some shards do not): same consent as a fresh download.
      if (options.onlyIfCached || !(await agreeToDownload(choice, options))) {
        if (current()) setState({ status: 'idle', progress: null });
        return false;
      }
      if (!current()) return false;
    }

    const w = new Worker(new URL(WORKER_URL, location.href), { type: 'module', name: 'starpi-webllm' });
    worker = w;
    const created = await Promise.race([
      webllm.CreateWebWorkerMLCEngine(
        w,
        choice.modelId,
        {
          initProgressCallback: (/** @type {InitProgressReport} */ report) => {
            if (current()) setState({ progress: { progress: report.progress, text: report.text, phase: classifyProgress(report.text), label: choice.label } });
          },
        },
        choice.chatOptions,
      ),
      aborted,
    ]);
    if (!current()) {
      w.terminate();
      return false;
    }
    // WebLLM's engine is typed for its whole API; this module only uses the LocalEngine part.
    engine = /** @type {LocalEngine} */ (/** @type {unknown} */ (created));
    setState({
      status: 'ready',
      error: null,
      progress: null,
      model: { ...choice, vramMB: typeof record.vram_required_MB === 'number' ? Math.round(record.vram_required_MB) : choice.vramMB },
    });
    return true;
  };

  loadPromise = run()
    .catch(async (err) => {
      if (!current()) return false;
      await teardown();
      const error = classifyEngineError(err);
      setState({ status: 'error', error, model: null, progress: null });
      throw error;
    })
    .finally(() => {
      if (current()) {
        loadPromise = null;
        abortPending = null;
      }
    });
  return loadPromise;
}

/** Cancels an in-flight load (or unloads a ready model) and frees GPU memory. */
export async function unloadModel() {
  loadSeq += 1;
  abortPending?.(new EngineError('cancelled', 'Load cancelled'));
  abortPending = null;
  loadPromise = null;
  await teardown();
  setState({ status: 'idle', model: null, error: null, progress: null });
}

/** Stops the current generation, if any. */
export function interrupt() {
  try {
    engine?.interruptGenerate();
  } catch {
    // ignore
  }
}

/**
 * Streams a chat completion. On fatal GPU errors the engine is torn down and the error rethrown.
 * @param {{ messages: ChatCompletionMessageParam[], maxTokens: number, temperature: number, onDelta: (text: string) => void }} req
 * @returns {Promise<string>}
 */
export async function generate(req) {
  const e = engine;
  if (!e || state.status !== 'ready') throw new EngineError('not-loaded', 'The local model is not loaded');
  if (generating) throw new EngineError('busy', 'A generation is already running');
  generating = true;
  let text = '';
  try {
    const stream = await e.chat.completions.create({
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        text += delta;
        req.onDelta(text);
      }
    }
    return text;
  } catch (err) {
    throw await handleGenerationError(err);
  } finally {
    generating = false;
  }
}

/**
 * Fatal GPU errors tear the engine down so the next request reloads it cleanly.
 * @param {unknown} err
 */
async function handleGenerationError(err) {
  const error = classifyEngineError(err);
  if (error.kind === 'device-lost' || error.kind === 'out-of-memory') {
    loadSeq += 1;
    loadPromise = null;
    await teardown();
    setState({ status: 'error', error, model: null, progress: null });
  }
  return error;
}

/**
 * Standardized benchmark prompt (about 64 tokens with the chat template of the supported models).
 */
export const BENCHMARK_PROMPT =
  'Write a detailed technical overview of how a web browser renders a page: parsing HTML into the DOM, ' +
  'building the CSS object model, computing layout, painting layers and compositing them on the GPU. ' +
  'Use complete sentences and continue until you are stopped.';

/**
 * @typedef {object} BenchmarkRun
 * @property {string} modelId
 * @property {ModelChoice['runtime']} runtime
 * @property {boolean} f16
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} startedAt      performance.now() before the request
 * @property {number} firstTokenAt   performance.now() when the first content token arrived
 * @property {number} finishedAt     performance.now() after the last chunk
 * @property {{ prefill_tokens_per_s?: number, decode_tokens_per_s?: number, time_to_first_token_s?: number } | null} engineStats
 */

/**
 * Reads a stream to its end without using its output.
 * @param {AsyncIterable<StreamChunk>} stream
 */
async function drain(stream) {
  const chunks = stream[Symbol.asyncIterator]();
  while (!(await chunks.next()).done) {
    // only the work matters
  }
}

/**
 * Measures the loaded model: one short warm-up request, then a fixed prompt with exactly
 * `outputTokens` generated tokens (EOS ignored). The chat state is reset before and after, so the
 * run measures a cold prefill and leaves no trace in the conversation.
 * @param {{ outputTokens?: number, onPhase?: (phase: 'warmup' | 'prefill' | 'decode', done: number, total: number) => void }} [options]
 * @returns {Promise<BenchmarkRun>}
 */
export async function runBenchmark(options = {}) {
  const e = engine;
  const model = state.model;
  if (!e || !model || state.status !== 'ready') throw new EngineError('not-loaded', 'The local model is not loaded');
  if (generating) throw new EngineError('busy', 'A generation is already running');
  const total = options.outputTokens ?? 128;
  generating = true;
  try {
    options.onPhase?.('warmup', 0, total);
    await e.resetChat();
    await drain(await e.chat.completions.create({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 8, temperature: 0, stream: true }));
    await e.resetChat();

    options.onPhase?.('prefill', 0, total);
    const startedAt = performance.now();
    let firstTokenAt = 0;
    let chunks = 0;
    /** @type {{ prompt_tokens?: number, completion_tokens?: number, extra?: BenchmarkRun['engineStats'] } | undefined} */
    let usage;
    const stream = await e.chat.completions.create({
      messages: [{ role: 'user', content: BENCHMARK_PROMPT }],
      max_tokens: total,
      temperature: 0,
      ignore_eos: true,
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) {
      if (chunk.usage) usage = /** @type {typeof usage} */ (chunk.usage);
      if (chunk.choices[0]?.delta?.content) {
        chunks += 1;
        if (!firstTokenAt) firstTokenAt = performance.now();
        if (chunks % 8 === 0) options.onPhase?.('decode', chunks, total);
      }
    }
    const finishedAt = performance.now();
    await e.resetChat();
    return {
      modelId: model.modelId,
      runtime: model.runtime,
      f16: model.f16,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? chunks,
      startedAt,
      firstTokenAt: firstTokenAt || finishedAt,
      finishedAt,
      engineStats: usage?.extra ?? null,
    };
  } catch (err) {
    throw await handleGenerationError(err);
  } finally {
    generating = false;
  }
}

/**
 * Unloads the engine and deletes every cached artifact of the models this app can use. The ONNX
 * Runtime binary is app code (a hashed /assets file) and stays.
 */
export async function deleteCachedModels() {
  await unloadModel();
  try {
    await globalThis.caches?.delete(WASM_CACHE_NAME);
  } catch (err) {
    console.warn('[starpi] could not delete cached processor models', err);
  }
  const webllm = await loadWebLLM();
  for (const id of ALL_MODEL_IDS) {
    try {
      await webllm.deleteModelAllInfoInCache(id);
    } catch (err) {
      console.warn('[starpi] could not delete cached model', id, err);
    }
  }
}
