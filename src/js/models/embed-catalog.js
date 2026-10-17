// @ts-check
// Embedding models for semantic search over the on-device workspace, run by Transformers.js in
// src/js/wasm/worker.js. Pure data and helpers, like models/wasm-catalog.js: every repository is
// pinned to a commit, and every file Transformers.js downloads is listed with its size and SHA-256,
// so the download the settings name is the one that happens (tests/unit/hybrid-embed-catalog.test.mjs
// checks the pins).
//
// The default model is also the one the shared library's 384-dimensional vectors were computed
// with (tools/library-publisher), at the same revision and quantisation, so a query vector made in
// the browser can rank the library without sending the question text.
//
// NLI_CATALOG holds the entailment model of the source check's optional second opinion
// (core/entail.js, wasm/nli.js), pinned the same way. It downloads only after the user asked for a
// second opinion on this device.

/**
 * @typedef {'e5-small' | 'minilm-l6'} EmbedModelKey
 * @typedef {'query' | 'passage'} EmbedKind
 *
 * @typedef {object} EmbedSource
 * @property {EmbedModelKey} key
 * @property {string} label Name shown in the settings (a proper name, never translated).
 * @property {string} repo Hugging Face repository.
 * @property {string} revision Commit every file is downloaded from.
 * @property {'q8'} dtype Transformers.js dtype; q8 loads the quantized ONNX weights.
 * @property {string} weights ONNX file the dtype maps to.
 * @property {ReadonlyArray<readonly [string, number, string]>} files Every downloaded file: path, size in bytes, SHA-256.
 * @property {readonly string[]} cacheProbe Files whose presence in the cache means the model is stored.
 * @property {number} approxDownloadMB
 * @property {number} dim Length of one vector.
 * @property {Readonly<Record<EmbedKind, string>>} prefixes Text put before a query or a passage, as the model was trained.
 * @property {'mean'} pooling
 * @property {true} normalize Vectors are L2-normalised, so a dot product is the cosine similarity.
 * @property {'multilingual' | 'english'} languages
 * @property {boolean} library The shared library's vectors come from exactly this model.
 */

/** Texts per embedding request to the worker (and per ONNX Runtime batch). */
export const EMBED_BATCH_SIZE = 16;

const WEIGHTS = 'onnx/model_quantized.onnx';
/** Files Transformers.js fetches for a feature-extraction model: the config, the tokenizer and the weights. */
const CACHE_PROBE = ['config.json', 'tokenizer.json', WEIGHTS];

/** @type {Readonly<Record<EmbedModelKey, EmbedSource>>} */
export const EMBED_CATALOG = Object.freeze({
  'e5-small': {
    key: 'e5-small',
    label: 'multilingual-e5-small',
    repo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    dtype: 'q8',
    weights: WEIGHTS,
    files: [
      ['config.json', 658, 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1'],
      ['tokenizer.json', 17_082_730, '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'],
      ['tokenizer_config.json', 443, 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b'],
      [WEIGHTS, 118_308_185, 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193'],
    ],
    cacheProbe: CACHE_PROBE,
    approxDownloadMB: 136,
    dim: 384,
    prefixes: { query: 'query: ', passage: 'passage: ' },
    pooling: 'mean',
    normalize: true,
    languages: 'multilingual',
    library: true,
  },
  'minilm-l6': {
    key: 'minilm-l6',
    label: 'all-MiniLM-L6-v2',
    repo: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    dtype: 'q8',
    weights: WEIGHTS,
    files: [
      ['config.json', 650, '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7'],
      ['tokenizer.json', 711_661, 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0'],
      ['tokenizer_config.json', 366, '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'],
      [WEIGHTS, 22_972_370, 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1'],
    ],
    cacheProbe: CACHE_PROBE,
    approxDownloadMB: 24,
    dim: 384,
    prefixes: { query: '', passage: '' },
    pooling: 'mean',
    normalize: true,
    languages: 'english',
    library: false,
  },
});

/** @type {EmbedModelKey} */
export const DEFAULT_EMBED_MODEL = 'e5-small';

/**
 * The model behind a key; unknown keys get the default.
 * @param {unknown} key
 * @returns {EmbedSource}
 */
export function embedSource(key) {
  return Object.hasOwn(EMBED_CATALOG, String(key)) ? EMBED_CATALOG[/** @type {EmbedModelKey} */ (key)] : EMBED_CATALOG[DEFAULT_EMBED_MODEL];
}

/**
 * The id stored with every vector (VectorRecord.model): vectors of another model, revision or
 * quantisation live in another space and are never compared with these.
 * @param {EmbedSource} src
 */
export function embedModelId(src) {
  return `${src.repo}@${src.revision}/${src.dtype}`;
}

/**
 * The text the model sees: e5 was trained with "query: " and "passage: " in front.
 * @param {EmbedSource} src
 * @param {EmbedKind} kind
 * @param {string} text
 */
export function embedInput(src, kind, text) {
  return `${src.prefixes[kind]}${text}`;
}

/**
 * Download URL of a pinned file; Transformers.js uses the same URL as its cache key.
 * @param {{ repo: string, revision: string }} src
 * @param {string} file
 */
export function embedFileUrl(src, file) {
  return `https://huggingface.co/${src.repo}/resolve/${encodeURIComponent(src.revision)}/${file}`;
}

/**
 * The pinned download URL for a request of Transformers.js, or null when the request is not for a
 * file of this model. Requests at the 'main' revision are pinned too: Transformers.js 4.3 reads
 * config.json and tokenizer_config.json at 'main' even when a revision is given.
 * @param {{ repo: string, revision: string }} src
 * @param {string} url
 * @returns {string | null}
 */
export function pinnedEmbedUrl(src, url) {
  const prefix = `https://huggingface.co/${src.repo}/resolve/`;
  if (!url.startsWith(prefix)) return null;
  const [revision, ...path] = url.slice(prefix.length).split('/');
  // Plain path segments only: no '.', '..', hidden files, queries or fragments.
  const plain = path.length > 0 && path.every((segment) => /^[\w-][\w.-]*$/.test(segment));
  return plain && (revision === src.revision || revision === 'main') ? embedFileUrl(src, path.join('/')) : null;
}

/**
 * The catalog entry with exactly this repository, revision and dtype, or null. The worker loads
 * nothing else.
 * @param {{ repo?: unknown, revision?: unknown, dtype?: unknown } | null | undefined} source
 * @returns {EmbedSource | null}
 */
export function findEmbedSource(source) {
  return Object.values(EMBED_CATALOG).find((e) => e.repo === source?.repo && e.revision === source?.revision && e.dtype === source?.dtype) ?? null;
}

/**
 * Whether this device should be offered semantic search without being asked: not on phones and
 * tablets, and not where the browser reports little memory or few cores. The model always
 * downloads only after the user agreed; this decides whether the offer is made unprompted.
 * @param {{ isMobile: boolean, deviceMemoryGB: number | null, cores: number | null }} hints
 */
export function suggestSemanticSearch(hints) {
  if (hints.isMobile) return false;
  if (hints.deviceMemoryGB !== null && hints.deviceMemoryGB < 4) return false;
  return hints.cores === null || hints.cores >= 4;
}

/**
 * @typedef {'minilm-xnli'} NliModelKey
 *
 * @typedef {object} NliSource
 * @property {NliModelKey} key
 * @property {string} label Name shown in the app (a proper name, never translated).
 * @property {string} repo Hugging Face repository.
 * @property {string} revision Commit every file is downloaded from.
 * @property {'q8'} dtype Transformers.js dtype; q8 loads the quantized ONNX weights.
 * @property {string} weights ONNX file the dtype maps to.
 * @property {ReadonlyArray<readonly [string, number, string]>} files Every downloaded file: path, size in bytes, SHA-256.
 * @property {readonly string[]} cacheProbe Files whose presence in the cache means the model is stored.
 * @property {number} approxDownloadMB
 * @property {Readonly<Record<number, 'entailment' | 'neutral' | 'contradiction'>>} labels The model's output classes, by index.
 * @property {number} maxTokens Longest premise and statement pair the model reads, in tokens (longer pairs are cut).
 * @property {'multilingual'} languages
 */

/**
 * Entailment models: a statement and a passage go in, the probabilities of entailment, neutral and
 * contradiction come out. One small multilingual model (MiniLM, trained on MNLI and XNLI).
 * @type {Readonly<Record<NliModelKey, NliSource>>}
 */
export const NLI_CATALOG = Object.freeze({
  'minilm-xnli': {
    key: 'minilm-xnli',
    label: 'multilingual-MiniLMv2-L6-mnli-xnli',
    repo: 'onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX',
    revision: 'ca5daf3d11b6c4b3143b1f4602a2edfb64c3ad7e',
    dtype: 'q8',
    weights: WEIGHTS,
    files: [
      ['config.json', 989, '3ebbbdf3c3803649b49715fd169207c0f42c4250dfea5dd304b1d8b8f745852a'],
      ['tokenizer.json', 17_082_832, 'd0091a328b3441d754e481db5a390d7f3b8dabc6016869fd13ba350d23ddc4cd'],
      ['tokenizer_config.json', 1286, '329b7d21f02c6c6c9d358733b03a34a89cd8e4fe36998869a6ab824b98e9bf9d'],
      [WEIGHTS, 107_415_176, '55614f3c7da74184742eaa0006b978744437aa91de9ba4913db42f94d7844a8f'],
    ],
    cacheProbe: CACHE_PROBE,
    approxDownloadMB: 125,
    labels: { 0: 'entailment', 1: 'neutral', 2: 'contradiction' },
    maxTokens: 512,
    languages: 'multilingual',
  },
});

/** @type {NliModelKey} */
export const DEFAULT_NLI_MODEL = 'minilm-xnli';

/**
 * The catalog NLI model with exactly this repository, revision and dtype, or null. The worker loads
 * nothing else.
 * @param {{ repo?: unknown, revision?: unknown, dtype?: unknown } | null | undefined} source
 * @returns {NliSource | null}
 */
export function findNliSource(source) {
  return Object.values(NLI_CATALOG).find((e) => e.repo === source?.repo && e.revision === source?.revision && e.dtype === source?.dtype) ?? null;
}

/**
 * The model as a receipt's second opinion records it: repository, revision and dtype.
 * @param {NliSource} src
 */
export function nliModelId(src) {
  return `${src.repo}@${src.revision}/${src.dtype}`;
}
