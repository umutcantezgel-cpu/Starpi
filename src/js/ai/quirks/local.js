// @ts-check
// Local OpenAI-compatible servers (Ollama, LM Studio, vLLM, llama.cpp and others) on the user's
// machine or network. They are called direct only (the relay cannot and must not reach them), the
// key is optional, reasoning usually arrives inside <think> tags, and stop words follow each
// server's native vocabulary.
//
// Server extras, sent only to the server they belong to:
//   Ollama     keep_alive: '30m' keeps the model loaded between turns
//   llama.cpp  cache_prompt: true reuses the KV cache of a stable prompt prefix
// A server's real context window can be read with probeContextWindow(): Ollama's OpenAI endpoint
// otherwise cuts long prompts silently at its configured size.
import { LOCAL_SERVER_PRESETS, localApiRoot } from '../catalog/providers.js';
import { defineQuirks } from './generic.js';

/** @typedef {import('../catalog/providers.js').LocalServerPreset} LocalServerPreset */
/** @typedef {LocalServerPreset['id'] | 'other'} LocalServer */
/** @typedef {import('../transport.js').FetchLike} FetchLike */

export { LOCAL_SERVER_PRESETS, localApiRoot };

/** Context window assumed when the server does not say. */
export const FALLBACK_CONTEXT_TOKENS = 4096;
/** How long a context probe may take; local servers answer fast or not at all. */
export const PROBE_TIMEOUT_MS = 3000;

/**
 * @typedef {object} LocalQuirkOptions
 * @property {LocalServer} [server]   which server runs there (detectServer() guesses it from the port)
 * @property {boolean} [reasoningOff] send `reasoning_effort: 'none'` when thinking is off; only for
 *   servers known to accept it (one that refuses the field answers 400, and the caller retries without)
 */

/**
 * @param {LocalQuirkOptions} [options]
 */
export function createLocalQuirks(options = {}) {
  const server = options.server ?? 'other';
  return defineQuirks({
    id: 'local',
    reasoningFields: ['reasoning_content', 'reasoning'],
    thinkTags: true,
    stopDialect: 'local',
    shape(body, req) {
      if (server === 'ollama') body.keep_alive = '30m';
      if (server === 'llamacpp') body.cache_prompt = true;
      if (options.reasoningOff && req.thinking?.mode === 'off') body.reasoning_effort = 'none';
    },
  });
}

export const localQuirks = createLocalQuirks();

/**
 * The server a base URL most likely points at, from its preset port; 'other' when unknown.
 * @param {string} baseUrl
 * @returns {LocalServer}
 */
export function detectServer(baseUrl) {
  const root = localApiRoot(baseUrl);
  if (!root) return 'other';
  const port = new URL(root).port;
  for (const preset of Object.values(LOCAL_SERVER_PRESETS)) if (new URL(preset.baseUrl).port === port) return preset.id;
  return 'other';
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
const positive = (value) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null);

/**
 * The context window an Ollama /api/show answer configures: `num_ctx` from the parameters, capped
 * by the trained length in model_info; null when neither is there.
 * @param {unknown} json
 * @returns {number | null}
 */
export function ollamaContext(json) {
  if (!json || typeof json !== 'object') return null;
  const body = /** @type {Record<string, unknown>} */ (json);
  const params = typeof body.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(body.parameters) : null;
  const configured = params ? positive(Number(params[1])) : null;
  const info = body.model_info && typeof body.model_info === 'object' ? /** @type {Record<string, unknown>} */ (body.model_info) : {};
  const trainedKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
  const trained = trainedKey ? positive(info[trainedKey]) : null;
  if (configured && trained) return Math.min(configured, trained);
  return configured ?? null;
}

/**
 * The context window a llama.cpp /props answer reports (`n_ctx`, at the top or in the default
 * generation settings); null when absent.
 * @param {unknown} json
 * @returns {number | null}
 */
export function llamaCppContext(json) {
  if (!json || typeof json !== 'object') return null;
  const body = /** @type {Record<string, any>} */ (json);
  return positive(body.n_ctx) ?? positive(body.default_generation_settings?.n_ctx) ?? positive(body.default_generation_settings?.params?.n_ctx);
}

/**
 * Reads the real context window of a local server: Ollama (POST /api/show for the model), then
 * llama.cpp (GET /props), else FALLBACK_CONTEXT_TOKENS. Never throws; `source` tells where the
 * number came from.
 * @param {string} baseUrl  the server's address, with or without /v1
 * @param {{ model?: string, server?: LocalServer, key?: string | null, fetch?: FetchLike, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ contextTokens: number, source: 'ollama' | 'llamacpp' | 'fallback' }>}
 */
export async function probeContextWindow(baseUrl, options = {}) {
  const root = localApiRoot(baseUrl);
  const fallback = { contextTokens: FALLBACK_CONTEXT_TOKENS, source: /** @type {const} */ ('fallback') };
  if (!root) return fallback;
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const server = options.server ?? detectServer(root);
  /** @type {Record<string, string>} */
  const headers = options.key ? { authorization: `Bearer ${options.key}` } : {};
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  /** @param {string} path @param {RequestInit} init */
  const read = async (path, init) => {
    try {
      const res = await doFetch(`${root}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal, redirect: 'error', credentials: 'omit' });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      return await res.json();
    } catch {
      return null;
    }
  };
  if ((server === 'ollama' || server === 'other') && options.model) {
    const n = ollamaContext(await read('/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: options.model }) }));
    if (n) return { contextTokens: n, source: 'ollama' };
  }
  if (server === 'llamacpp' || server === 'other') {
    const n = llamaCppContext(await read('/props', { method: 'GET' }));
    if (n) return { contextTokens: n, source: 'llamacpp' };
  }
  return fallback;
}
