// @ts-check
// Language models that run on the processor (WebAssembly) when WebGPU is missing, loaded by
// Transformers.js in src/js/wasm/worker.js. Pure data and helpers: every repository is pinned to a
// commit, and every file Transformers.js downloads is listed with its size, so the download the
// confirmation names is the one that happens (tests/unit/wasm-catalog.test.mjs checks the pins).

/**
 * @typedef {'smollm2-135m' | 'smollm2-360m' | 'qwen-0.5b'} WasmModelKey
 *
 * @typedef {object} WasmSource
 * @property {WasmModelKey} key
 * @property {string} label Name shown in the model picker (a proper name, never translated).
 * @property {string} repo Hugging Face repository.
 * @property {string} revision Commit every file is downloaded from.
 * @property {'q8'} dtype Transformers.js dtype; q8 loads the quantized ONNX weights.
 * @property {string} weights ONNX file the dtype maps to.
 * @property {ReadonlyArray<readonly [string, number]>} files Every downloaded file with its size in bytes.
 * @property {readonly string[]} cacheProbe Files whose presence in the cache means the model is stored.
 * @property {number} approxDownloadMB
 * @property {number} contextWindow Tokens the app uses for prompt and answer together.
 * @property {number} maxPositionEmbeddings Context length the model was trained for.
 * @property {number} maxOutputTokens
 */

/**
 * Cache API name Transformers.js stores model files under (its `env.cacheKey`). It must not start
 * with "starpi-": the service worker deletes those caches when a new build activates.
 */
export const WASM_CACHE_NAME = 'transformers-cache';

/** The self-hosted ONNX Runtime binary (ort-wasm-simd-threaded.wasm, 14.3 MB), downloaded once. */
export const WASM_RUNTIME_MB = 15;

const WEIGHTS = 'onnx/model_quantized.onnx';
/** Files Transformers.js fetches for every model: the config, the tokenizer and the weights. */
const CACHE_PROBE = Object.freeze(['config.json', 'tokenizer.json', WEIGHTS]);
/** Single-threaded WASM decodes a few tokens per second; a short context keeps answers responsive. */
const CONTEXT_WINDOW = 2_048;
const MAX_OUTPUT_TOKENS = 384;

/** @type {Readonly<Record<WasmModelKey, WasmSource>>} */
export const WASM_CATALOG = Object.freeze({
  'smollm2-135m': {
    key: 'smollm2-135m',
    label: 'SmolLM2 135M',
    repo: 'HuggingFaceTB/SmolLM2-135M-Instruct',
    revision: '12fd25f77366fa6b3b4b768ec3050bf629380bac',
    dtype: 'q8',
    weights: WEIGHTS,
    files: [
      ['config.json', 861],
      ['generation_config.json', 132],
      ['tokenizer.json', 2_104_556],
      ['tokenizer_config.json', 3_764],
      [WEIGHTS, 137_147_981],
    ],
    cacheProbe: CACHE_PROBE,
    approxDownloadMB: 140,
    contextWindow: CONTEXT_WINDOW,
    maxPositionEmbeddings: 8_192,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  },
  'smollm2-360m': {
    key: 'smollm2-360m',
    label: 'SmolLM2 360M',
    repo: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    revision: 'a10cc1512eabd3dde888204e902eca88bddb4951',
    dtype: 'q8',
    weights: WEIGHTS,
    files: [
      ['config.json', 846],
      ['generation_config.json', 132],
      ['tokenizer.json', 2_104_556],
      ['tokenizer_config.json', 3_764],
      [WEIGHTS, 364_564_671],
    ],
    cacheProbe: CACHE_PROBE,
    approxDownloadMB: 370,
    contextWindow: CONTEXT_WINDOW,
    maxPositionEmbeddings: 8_192,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  },
  'qwen-0.5b': {
    key: 'qwen-0.5b',
    label: 'Qwen 2.5 0.5B',
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    revision: '22942cb7d7ba4cc81bb4673549ca4d4614469b5e',
    dtype: 'q8',
    weights: WEIGHTS,
    files: [
      ['config.json', 678],
      ['generation_config.json', 242],
      ['tokenizer.json', 7_031_673],
      ['tokenizer_config.json', 7_849],
      [WEIGHTS, 512_096_557],
    ],
    cacheProbe: CACHE_PROBE,
    approxDownloadMB: 520,
    contextWindow: CONTEXT_WINDOW,
    maxPositionEmbeddings: 32_768,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  },
});

/**
 * Download URL of a pinned file; Transformers.js uses the same URL as its cache key.
 * @param {WasmSource} src
 * @param {string} file
 */
export function wasmFileUrl(src, file) {
  return `https://huggingface.co/${src.repo}/resolve/${encodeURIComponent(src.revision)}/${file}`;
}

/**
 * The catalog entry with exactly this repository, revision and dtype, or null. The worker loads
 * nothing else.
 * @param {{ repo?: unknown, revision?: unknown, dtype?: unknown } | null | undefined} source
 * @returns {WasmSource | null}
 */
export function findWasmSource(source) {
  return Object.values(WASM_CATALOG).find((w) => w.repo === source?.repo && w.revision === source?.revision && w.dtype === source?.dtype) ?? null;
}
