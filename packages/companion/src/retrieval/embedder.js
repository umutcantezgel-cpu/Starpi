// @ts-check
// Embeddings from a model server on this machine: any server with the OpenAI-shaped route
// `POST <base>/embeddings` (Ollama, llama.cpp's server, LM Studio). The address must be loopback
// (setup/loopback.js), redirects are refused, and every answer is checked before a vector is used:
// one vector per text, finite numbers, the same dimension every time. Texts go out in batches of
// 16; a batch has 30 seconds, the embedding of a question 2 seconds, after which the search goes on
// with keywords alone.
import { fail } from '../lib/errors.js';
import { parseLoopbackUrl } from '../setup/loopback.js';

/** Texts in one request. */
export const EMBED_BATCH = 16;
/** Time one batch may take. */
export const EMBED_BATCH_TIMEOUT_MS = 30_000;
/** Time the embedding of a question may take before the keyword ranking answers alone. */
export const QUERY_EMBED_TIMEOUT_MS = 2_000;
/** Largest answer read for one batch. */
export const EMBED_MAX_RESPONSE = 16 * 1024 * 1024;
/** Dimensions a vector may have. */
export const EMBED_DIMS = Object.freeze({ min: 2, max: 8192 });

/**
 * @typedef {object} EmbedderConfig
 * @property {string} baseUrl         e.g. http://127.0.0.1:11434/v1
 * @property {string} model
 * @property {string} [queryPrefix]   put before a question (some models expect "query: ")
 * @property {string} [passagePrefix] put before a stored passage ("passage: ")
 */

/**
 * Reads a body up to a size.
 * @param {Response} response
 * @param {number} max
 */
async function readCapped(response, max) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw fail('embedder_too_large', 'the embedding server sent more than expected', { status: 502 });
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * @param {EmbedderConfig} config
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createEmbedder(config, { fetchImpl = globalThis.fetch } = {}) {
  const target = parseLoopbackUrl(config.baseUrl, 'modules.retrieval.embeddings.baseUrl');
  if (typeof config.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,159}$/.test(config.model)) throw fail('module_config', 'modules.retrieval.embeddings.model: a model name', { status: 400 });
  const endpoint = `${target.url}/embeddings`;
  const queryPrefix = config.queryPrefix ?? '';
  const passagePrefix = config.passagePrefix ?? '';
  /** @type {number | null} */
  let dimension = null;
  let failures = 0;
  /** @type {string | null} */
  let lastError = null;

  /**
   * One request for up to EMBED_BATCH texts.
   * @param {string[]} texts
   * @param {AbortSignal} signal
   * @returns {Promise<Float32Array[]>}
   */
  async function batch(texts, signal) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ model: config.model, input: texts }),
        redirect: 'error',
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw fail('embedder_timeout', 'the embedding server did not answer in time', { status: 504, cause: err });
      throw fail('embedder_unreachable', 'the embedding server could not be reached', { status: 502, cause: err });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw fail('embedder_http', `the embedding server answered ${response.status}`, { status: 502 });
    }
    let parsed;
    try {
      parsed = JSON.parse(await readCapped(response, EMBED_MAX_RESPONSE));
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'embedder_too_large') throw err;
      throw fail('embedder_bad_answer', 'the embedding server sent no JSON', { status: 502 });
    }
    const data = Array.isArray(parsed?.data) ? parsed.data : null;
    if (!data || data.length !== texts.length) throw fail('embedder_bad_answer', 'the embedding server sent another number of vectors', { status: 502 });
    /** @type {Float32Array[]} */
    const out = new Array(texts.length);
    for (const [position, item] of data.entries()) {
      const index = Number.isInteger(item?.index) ? item.index : position;
      const values = item?.embedding;
      if (index < 0 || index >= texts.length || out[index] || !Array.isArray(values)) throw fail('embedder_bad_answer', 'a vector of the embedding server is malformed', { status: 502 });
      if (values.length < EMBED_DIMS.min || values.length > EMBED_DIMS.max || !values.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw fail('embedder_bad_answer', 'a vector holds something other than finite numbers', { status: 502 });
      }
      if (dimension !== null && values.length !== dimension) throw fail('embedder_bad_answer', `the dimension changed from ${dimension} to ${values.length}`, { status: 502 });
      dimension = values.length;
      out[index] = Float32Array.from(values);
    }
    return out;
  }

  /**
   * @param {string[]} texts
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} options
   */
  async function embed(texts, { signal, timeoutMs = EMBED_BATCH_TIMEOUT_MS }) {
    /** @type {Float32Array[]} */
    const vectors = [];
    try {
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const limit = AbortSignal.timeout(timeoutMs);
        vectors.push(...(await batch(texts.slice(i, i + EMBED_BATCH), signal ? AbortSignal.any([signal, limit]) : limit)));
      }
      failures = 0;
      lastError = null;
      return vectors;
    } catch (err) {
      failures += 1;
      lastError = /** @type {any} */ (err)?.code ?? 'embedder_failed';
      throw err;
    }
  }

  return {
    model: config.model,
    url: target.url,
    /** The dimension seen so far (null before the first answer). */
    dimension: () => dimension,
    /**
     * Vectors of stored passages.
     * @param {string[]} texts
     * @param {{ signal?: AbortSignal }} [options]
     */
    embedPassages: (texts, options = {}) => embed(texts.map((t) => passagePrefix + t), options),
    /**
     * The vector of a question, within QUERY_EMBED_TIMEOUT_MS.
     * @param {string} text
     * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
     */
    async embedQuery(text, options = {}) {
      const [vector] = await embed([queryPrefix + text], { signal: options.signal, timeoutMs: options.timeoutMs ?? QUERY_EMBED_TIMEOUT_MS });
      return vector;
    },
    describe: () => ({ model: config.model, url: target.url, dimension, failures, lastError }),
  };
}

/** @typedef {ReturnType<typeof createEmbedder>} Embedder */
