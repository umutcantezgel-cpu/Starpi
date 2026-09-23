// @ts-check
// Lifecycle controller for the on-device WebLLM engine (running in webgpu/worker.js).
//
// State machine: idle -> loading -> ready, with error as a terminal state until the next load.
// Every load gets a sequence number; cancel/unload bump it, so late results of superseded loads are
// discarded and their worker is terminated. Teardown always ends in worker.terminate(), which frees
// GPU memory even if the engine is stuck mid-download or its device was lost.
import { chooseModel, detectMobile, MODEL_CATALOG } from './models.js';

/** Replaced at build time with the hashed worker URL (scripts/build.mjs). */
const WORKER_URL = '__STARPI_WEBLLM_WORKER_URL__';

/** @typedef {import('./models.js').ModelChoice} ModelChoice */
/** @typedef {import('./models.js').ModelPreference} ModelPreference */
/** @typedef {import('./models.js').HardwareProfile} HardwareProfile */
/** @typedef {typeof import('@mlc-ai/web-llm')} WebLLM */
/** @typedef {import('@mlc-ai/web-llm').WebWorkerMLCEngine} WorkerEngine */
/** @typedef {import('@mlc-ai/web-llm').InitProgressReport} InitProgressReport */
/** @typedef {import('@mlc-ai/web-llm').ChatCompletionMessageParam} ChatCompletionMessageParam */

/**
 * @typedef {'unsupported' | 'no-adapter' | 'quota' | 'network' | 'device-lost' | 'out-of-memory' | 'cancelled' | 'busy' | 'not-loaded' | 'unknown'} EngineErrorKind
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
 * @property {(ModelChoice & { vramMB: number | null }) | null} model
 * @property {EngineError | null} error
 * @property {{ progress: number, text: string, phase: LoadPhase } | null} progress
 */

/** @type {EngineState} */
let state = { status: 'idle', model: null, error: null, progress: null };
/** @type {Set<(s: EngineState) => void>} */
const listeners = new Set();

/** @type {WorkerEngine | null} */
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
  webllmModule ??= import('@mlc-ai/web-llm');
  return webllmModule;
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

/**
 * Checks WebGPU availability and reads the adapter capabilities used for model selection and the
 * diagnostics panel.
 * @returns {Promise<{ supported: true, hw: HardwareProfile, adapter: AdapterDetails } | { supported: false, error: EngineError }>}
 */
export async function probeWebGPU() {
  /** @typedef {{ limits?: Record<string, unknown> & { maxBufferSize?: number }, features?: { has(name: string): boolean } & Iterable<string>, info?: Partial<AdapterDetails['info']> }} AdapterLike */
  /** @typedef {{ requestAdapter?: (opts?: { powerPreference?: 'high-performance' | 'low-power' }) => Promise<AdapterLike | null> }} GpuLike */
  const gpu = /** @type {{ gpu?: GpuLike }} */ (/** @type {unknown} */ (navigator)).gpu;
  if (!gpu?.requestAdapter) {
    return { supported: false, error: new EngineError('unsupported', 'navigator.gpu is not available in this browser') };
  }
  let adapter;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (err) {
    return { supported: false, error: new EngineError('no-adapter', 'requestAdapter() failed', err) };
  }
  if (!adapter) {
    return { supported: false, error: new EngineError('no-adapter', 'requestAdapter() returned no adapter (GPU blocked or disabled)') };
  }
  const nav = /** @type {Navigator & { deviceMemory?: number, userAgentData?: { mobile?: boolean } }} */ (navigator);
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
      isMobile: detectMobile({ userAgent: nav.userAgent ?? '', userAgentDataMobile: nav.userAgentData?.mobile }),
      deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      maxBufferSize: Number(adapter.limits?.maxBufferSize ?? 0),
      hasF16: Boolean(adapter.features?.has?.('shader-f16')),
    },
  };
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
  if (name === 'TypeError' && /fetch|network|load failed/i.test(message)) {
    return new EngineError('network', 'Model download failed', err);
  }
  if (/WebGPU|navigator\.gpu|shader-f16/i.test(message) && /not (supported|available)/i.test(message)) {
    return new EngineError('unsupported', 'WebGPU is not available on this device', err);
  }
  return new EngineError('unknown', message || 'Unknown error while loading the model', err, { reason: message || '–' });
}

/**
 * Checks the storage quota before a multi-GB download and requests persistent storage.
 * @param {number} requiredMB
 */
async function prepareStorage(requiredMB) {
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
  try {
    await storage.persist?.();
  } catch {
    // Persistence is best effort; the browser may still evict under pressure.
  }
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
    const probe = await probeWebGPU();
    if (!probe.supported) throw probe.error;
    const choice = chooseModel(probe.hw, options.preference);

    if (engine && state.model?.modelId === choice.modelId) return true;
    await teardown();
    if (!current()) return false;
    setState({ status: 'loading', error: null, model: null, progress: { progress: 0, text: '', phase: 'init' } });

    const webllm = await Promise.race([loadWebLLM(), aborted]);
    if (!current()) return false;
    const record = webllm.prebuiltAppConfig.model_list.find((m) => m.model_id === choice.modelId);
    if (!record) throw new EngineError('unknown', `Model ${choice.modelId} is not in this WebLLM build`, undefined, { reason: choice.modelId });

    const cached = await webllm.hasModelInCache(choice.modelId).catch(() => false);
    if (!cached) {
      if (options.onlyIfCached) {
        if (current()) setState({ status: 'idle', progress: null });
        return false;
      }
      await prepareStorage(Math.max(choice.approxDownloadMB, 1));
      if (options.confirmDownload && !(await options.confirmDownload(choice))) {
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
            if (current()) setState({ progress: { progress: report.progress, text: report.text, phase: classifyProgress(report.text) } });
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
    engine = created;
    setState({
      status: 'ready',
      error: null,
      progress: null,
      model: { ...choice, vramMB: typeof record.vram_required_MB === 'number' ? Math.round(record.vram_required_MB) : null },
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
 * @property {boolean} f16
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} startedAt      performance.now() before the request
 * @property {number} firstTokenAt   performance.now() when the first content token arrived
 * @property {number} finishedAt     performance.now() after the last chunk
 * @property {{ prefill_tokens_per_s?: number, decode_tokens_per_s?: number, time_to_first_token_s?: number } | null} engineStats
 */

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
    await e.chat.completions.create({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 8, temperature: 0 });
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

/** Unloads the engine and deletes every cached artifact of the models this app can use. */
export async function deleteCachedModels() {
  await unloadModel();
  const webllm = await loadWebLLM();
  const ids = Object.values(MODEL_CATALOG).flatMap((m) => [m.f16, m.f32]);
  for (const id of ids) {
    try {
      await webllm.deleteModelAllInfoInCache(id);
    } catch (err) {
      console.warn('[starpi] could not delete cached model', id, err);
    }
  }
}
