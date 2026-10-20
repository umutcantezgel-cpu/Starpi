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
//
// A self-hosted MiniMax M3 or M3.1 build (a model name containing "minimax-m3") always thinks: its
// reasoning arrives as `reasoning_content` or inside <think> tags like any other, and it is never
// sent `reasoning_effort: 'none'`. Such a build needs a workstation or server (about 160 GB of
// memory or more, as of 2026-10-20); there is no in-browser preset for it.
import { LOCAL_SERVER_PRESETS, localApiRoot, MINIMAX_M3 } from '../catalog/providers.js';
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
 * @property {LocalServer | (() => LocalServer)} [server]  which server runs there (detectServer() guesses it from
 *   the port); a function is asked for every request, so the server's address may change meanwhile
 * @property {boolean} [reasoningOff] send `reasoning_effort: 'none'` when thinking is off; only for
 *   servers known to accept it (one that refuses the field answers 400, and the caller retries without),
 *   and never for a model that cannot stop thinking (a MiniMax M3 build)
 */

/**
 * @param {LocalQuirkOptions} [options]
 */
export function createLocalQuirks(options = {}) {
  const serverOf = typeof options.server === 'function' ? options.server : () => /** @type {LocalServer} */ (options.server ?? 'other');
  return defineQuirks({
    id: 'local',
    reasoningFields: ['reasoning_content', 'reasoning'],
    thinkTags: true,
    stopDialect: 'local',
    shape(body, req) {
      const server = serverOf();
      if (server === 'ollama') body.keep_alive = '30m';
      if (server === 'llamacpp') body.cache_prompt = true;
      if (options.reasoningOff && req.thinking?.mode === 'off' && !MINIMAX_M3.test(req.model)) body.reasoning_effort = 'none';
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
 * The context window vLLM serves a model with: `max_model_len` of its entry in GET /v1/models (the
 * only entry when the server lists one model under another name); null when absent.
 * @param {unknown} json
 * @param {string} model
 * @returns {number | null}
 */
export function vllmContext(json, model) {
  const data = json && typeof json === 'object' && Array.isArray(/** @type {any} */ (json).data) ? /** @type {unknown[]} */ (/** @type {any} */ (json).data) : [];
  const entries = /** @type {Array<Record<string, unknown>>} */ (data.filter((m) => m && typeof m === 'object'));
  const entry = entries.find((m) => m.id === model) ?? (entries.length === 1 ? entries[0] : null);
  return entry ? positive(entry.max_model_len) : null;
}

/**
 * Reads the real context window of a local server: Ollama (POST /api/show for the model), then
 * llama.cpp (GET /props), then vLLM (GET /v1/models), else FALLBACK_CONTEXT_TOKENS. Never throws;
 * `source` tells where the number came from.
 * @param {string} baseUrl  the server's address, with or without /v1
 * @param {{ model?: string, server?: LocalServer, key?: string | null, fetch?: FetchLike, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ contextTokens: number, source: 'ollama' | 'llamacpp' | 'vllm' | 'fallback' }>}
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
  if ((server === 'vllm' || server === 'other') && options.model) {
    const n = vllmContext(await read('/v1/models', { method: 'GET' }), options.model);
    if (n) return { contextTokens: n, source: 'vllm' };
  }
  return fallback;
}
