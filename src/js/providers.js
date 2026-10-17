// @ts-check
// Remote inference providers: Google Gemini and OpenRouter (bring-your-own key), a user-operated
// Chat Completions-compatible server (/v1/chat/completions: MLX, Ollama, vLLM) and NVIDIA NIM cloud
// models through Starpi's own proxy. Keys never leave the browser except to their provider; the
// NVIDIA keys never reach the browser at all.
import { ACCESS_SLOT, getKey } from './ai/keys.js';
import { ACCESS_HEADER } from './ai/transport.js';
import { createChatStreamAssembler, createSseParser, splitStreamingText } from './chat-stream.js';
import { t } from './i18n/index.js';
import { TIMEOUTS_MS } from './config.js';
import { findNvidiaModel, NVIDIA_CLIENT_TIMEOUTS, NVIDIA_LIMITS } from './models/nvidia-catalog.js';
import { withTimeoutSignal } from './signals.js';

/** @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} ChatMessage */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, notConfigured?: boolean, cause?: unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message, { cause: info.cause });
    this.name = 'ProviderError';
    this.status = info.status;
    this.notConfigured = info.notConfigured ?? false;
  }
}

export function hasGeminiKey() {
  return getKey('gemini').length > 0;
}

export function hasOpenRouterKey() {
  return getKey('openrouter').length > 0;
}

/**
 * @param {Response} res
 * @param {string} label
 */
async function httpError(res, label) {
  /** @type {{ error?: { message?: string } }} */
  let body = {};
  try {
    body = await res.json();
  } catch {
    // ignore non-JSON error bodies
  }
  return new ProviderError(`HTTP ${res.status}${label ? ` [${label}]` : ''}: ${body.error?.message || res.statusText}`, {
    status: res.status,
  });
}

/**
 * Gemini completion. The key travels in the x-goog-api-key header, never in the URL. Without
 * `system` and `history` (source mode, connection test) the request is a single user turn.
 * @param {string} prompt
 * @param {{ signal?: AbortSignal, key?: string, system?: string, history?: Array<{ role: 'user' | 'assistant', content: string }> }} [opts]
 *   `key`: test a key that is not saved yet; `system` and `history`: the free chat
 * @returns {Promise<{ text: string }>}
 */
export async function callGemini(prompt, opts = {}) {
  const key = (opts.key || getKey('gemini')).trim();
  if (!key) throw new ProviderError(t('provider.no_gemini_key'), { notConfigured: true });
  const contents = [
    ...(opts.history ?? []).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: prompt }] },
  ];
  const body = opts.system ? { systemInstruction: { parts: [{ text: opts.system }] }, contents } : { contents };
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: withTimeoutSignal(opts.signal, TIMEOUTS_MS.gemini),
  });
  if (!res.ok) throw await httpError(res, '');
  /** @type {{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }} */
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) throw new ProviderError(t('provider.empty_answer'));
  return { text };
}

const OPENROUTER_MODELS = ['liquid/lfm-2.5-2.6b:free', 'openrouter/free', 'nvidia/nemotron-3.5-lightning:free'];
const OPENROUTER_MAX_ATTEMPTS = 3;

/**
 * OpenRouter chat completion with failover across free models.
 * @param {ChatMessage[]} messages
 * @param {{ signal?: AbortSignal, key?: string }} [opts]  `key`: test a key that is not saved yet
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function callOpenRouter(messages, opts = {}) {
  const key = (opts.key || getKey('openrouter')).trim();
  if (!key) {
    throw new ProviderError(t('provider.no_openrouter_key'), { notConfigured: true });
  }
  /** @type {unknown} */
  let lastErr = null;
  for (const model of OPENROUTER_MODELS.slice(0, OPENROUTER_MAX_ATTEMPTS)) {
    if (opts.signal?.aborted) break;
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://www.starpi.app/',
          'X-Title': 'Starpi Assistant',
        },
        body: JSON.stringify({ model, messages, temperature: 0.5, max_tokens: 1024 }),
        signal: withTimeoutSignal(opts.signal, TIMEOUTS_MS.openrouter),
      });
      if (!res.ok) throw await httpError(res, model);
      /** @type {{ choices?: Array<{ message?: { content?: string } }> }} */
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      if (text) return { text, model };
      lastErr = new ProviderError(`${t('provider.empty_answer')} [${model}]`);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastErr = err;
      // Authentication problems will not improve with another model.
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) break;
      console.warn('[starpi] OpenRouter attempt failed:', err instanceof Error ? err.message : err);
    }
  }
  throw lastErr instanceof Error ? lastErr : new ProviderError(t('provider.cloud_unreachable'));
}

// Exactly the plain-http hosts the CSP connect-src allows. CSP host sources cannot express IPv6
// literals, so http://[::1] would pass here and then be blocked by the browser.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Validates a user-supplied Chat Completions base URL: https anywhere, plain http only on loopback.
 * @param {string} value
 * @returns {string} normalized URL without trailing slash
 */
export function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProviderError(t('provider.invalid_url'));
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ProviderError(t('provider.insecure_url'));
  }
  if (url.username || url.password) throw new ProviderError(t('provider.credentials_in_url'));
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/** Model id reported by the own server's GET /models, per server URL. */
const serverModels = new Map();

/**
 * Checks the own server and remembers the first model it lists: servers such as Ollama reject a
 * chat request without a `model` field.
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function probeLocalServer(baseUrl) {
  try {
    const base = normalizeServerUrl(baseUrl);
    const res = await fetch(`${base}/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUTS_MS.localServerProbe),
    });
    if (!res.ok) return false;
    /** @type {{ data?: Array<{ id?: unknown }> } | null} */
    const body = await res.json().catch(() => null);
    const id = body?.data?.find((m) => typeof m?.id === 'string')?.id;
    if (typeof id === 'string') serverModels.set(base, id.slice(0, 200));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} baseUrl
 * @param {ChatMessage[]} messages
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ text: string }>}
 */
export async function callLocalServer(baseUrl, messages, opts = {}) {
  const base = normalizeServerUrl(baseUrl);
  if (!serverModels.has(base)) await probeLocalServer(base);
  const model = serverModels.get(base);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(model ? { model } : {}), messages, temperature: 0.7, max_tokens: 1024 }),
    signal: withTimeoutSignal(opts.signal, TIMEOUTS_MS.localServer),
  });
  if (!res.ok) throw await httpError(res, 'server');
  /** @type {{ choices?: Array<{ message?: { content?: string } }> }} */
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new ProviderError(t('provider.empty_server_answer'));
  return { text };
}

// ---------------------------------------------------------------------------------------------------
// NVIDIA NIM cloud through Starpi's own proxy (api/chat/nvidia.js, or backend/server.py behind the same
// origin). The browser holds no NVIDIA key: it calls same-origin URLs without an Authorization header,
// and the proxy adds a key from its pool. Error texts come only from i18n keys chosen by the proxy's
// error code; text the server or NVIDIA sends is never shown.

/**
 * A model the proxy offers, as GET /api/models/nvidia lists it.
 * @typedef {object} NvidiaOffer
 * @property {string} id
 * @property {string} label
 * @property {string} vendor
 * @property {boolean} reasoning
 * @property {boolean} vision
 * @property {number} maxOutputTokens
 * @property {number} defaultMaxTokens
 */

/**
 * What the proxy says about itself. `reachable` is false when there is no proxy (a static host, a 404,
 * a network error or a reply that is not JSON); `configured` is true only when it holds keys.
 * @typedef {object} NvidiaCatalog
 * @property {boolean} configured
 * @property {boolean} reachable
 * @property {number | null} version
 * @property {string | null} defaultModel
 * @property {Partial<import('./models/nvidia-catalog.js').NvidiaLimits> | null} limits
 * @property {NvidiaOffer[]} models
 */

/**
 * @typedef {object} NvidiaResult
 * @property {string} text  the answer, with the model's reasoning as a leading <think> block
 * @property {string} model
 * @property {string | null} finishReason
 * @property {boolean} truncated  the answer stopped early (Stop, a timeout, an interrupted stream, the token limit)
 */

export const NVIDIA_CHAT_URL = '/api/chat/nvidia';
export const NVIDIA_MODELS_URL = '/api/models/nvidia';

const NVIDIA_ID = /^[a-z0-9][\w.-]{0,63}\/[\w.:-]{1,96}$/i;
const NVIDIA_MAX_OFFERS = 64;
const CATALOG_TTL_CONFIGURED_MS = 5 * 60_000;
const CATALOG_TTL_UNCONFIGURED_MS = 30_000;
const LIMIT_FIELDS = /** @type {const} */ (['maxMessages', 'maxMessageChars', 'maxTotalChars', 'maxOutputTokens', 'defaultMaxTokens', 'maxBodyBytes']);

/** @returns {NvidiaCatalog} */
function unreachableCatalog() {
  return { configured: false, reachable: false, version: null, defaultModel: null, limits: null, models: [] };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function shortText(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';
}

/**
 * Reads the body of GET /api/models/nvidia. Unknown fields are dropped, invalid and repeated ids are
 * skipped, and anything that is not an object is treated as "no proxy here".
 * @param {unknown} body
 * @returns {NvidiaCatalog}
 */
export function parseNvidiaCatalog(body) {
  if (!isRecord(body)) return unreachableCatalog();
  /** @type {NvidiaOffer[]} */
  const models = [];
  const seen = new Set();
  for (const entry of Array.isArray(body.models) ? body.models : []) {
    if (models.length >= NVIDIA_MAX_OFFERS) break;
    const item = typeof entry === 'string' ? { id: entry } : isRecord(entry) ? entry : null;
    const id = item && typeof item.id === 'string' ? item.id : '';
    if (!NVIDIA_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const bundled = findNvidiaModel(id);
    const maxOutputTokens = positiveInt(item?.maxOutputTokens, bundled?.maxOutputTokens ?? NVIDIA_LIMITS.maxOutputTokens);
    models.push({
      id,
      label: shortText(item?.label, 80) || id,
      vendor: shortText(item?.vendor, 40),
      reasoning: item?.reasoning === true,
      vision: item?.vision === true,
      maxOutputTokens,
      defaultMaxTokens: Math.min(positiveInt(item?.defaultMaxTokens, bundled?.defaultMaxTokens ?? NVIDIA_LIMITS.defaultMaxTokens), maxOutputTokens),
    });
  }
  /** @type {Partial<import('./models/nvidia-catalog.js').NvidiaLimits> | null} */
  let limits = null;
  if (isRecord(body.limits)) {
    const source = body.limits;
    limits = Object.fromEntries(LIMIT_FIELDS.filter((k) => positiveInt(source[k], 0) > 0).map((k) => [k, positiveInt(source[k], 0)]));
  }
  const defaultModel = typeof body.defaultModel === 'string' && NVIDIA_ID.test(body.defaultModel) ? body.defaultModel : null;
  return {
    configured: body.configured === true,
    reachable: true,
    version: positiveInt(body.version, 0) || null,
    defaultModel,
    limits,
    models,
  };
}

/**
 * Asks the proxy which models it offers. Never throws: without a proxy the catalog says unreachable.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<NvidiaCatalog>}
 */
export async function fetchNvidiaModels(opts = {}) {
  try {
    const res = await fetch(NVIDIA_MODELS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      signal: withTimeoutSignal(opts.signal, NVIDIA_CLIENT_TIMEOUTS.models),
    });
    // A static host answers 404, or serves the app's HTML for unknown paths.
    if (!res.ok || !/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) {
      res.body?.cancel().catch(() => {});
      return unreachableCatalog();
    }
    return parseNvidiaCatalog(await res.json());
  } catch {
    return unreachableCatalog();
  }
}

/** @type {{ at: number, catalog: NvidiaCatalog } | null} */
let catalogCache = null;
/** @type {Promise<NvidiaCatalog> | null} */
let catalogRequest = null;
/** @type {Set<(catalog: NvidiaCatalog) => void>} */
const catalogListeners = new Set();

/**
 * The proxy's catalog, cached for five minutes when it has keys and for 30 seconds otherwise.
 * Concurrent callers share one request; `refresh` skips the cache. Listeners hear every new result.
 * @param {{ refresh?: boolean }} [opts]
 * @returns {Promise<NvidiaCatalog>}
 */
export function getNvidiaCatalog(opts = {}) {
  if (!opts.refresh && catalogCache) {
    const ttl = catalogCache.catalog.configured ? CATALOG_TTL_CONFIGURED_MS : CATALOG_TTL_UNCONFIGURED_MS;
    if (Date.now() - catalogCache.at < ttl) return Promise.resolve(catalogCache.catalog);
  }
  if (catalogRequest) return catalogRequest;
  const request = fetchNvidiaModels().then((catalog) => {
    catalogCache = { at: Date.now(), catalog };
    for (const fn of catalogListeners) {
      try {
        fn(catalog);
      } catch (err) {
        console.warn('[starpi] NVIDIA catalog listener failed', err);
      }
    }
    return catalog;
  });
  catalogRequest = request;
  void request.finally(() => {
    if (catalogRequest === request) catalogRequest = null;
  });
  return request;
}

/**
 * @param {(catalog: NvidiaCatalog) => void} fn
 * @returns {() => void} unsubscribes
 */
export function onNvidiaCatalog(fn) {
  catalogListeners.add(fn);
  return () => {
    catalogListeners.delete(fn);
  };
}

/**
 * The model to ask: the preferred one when the proxy offers it, else the proxy's default, else its
 * first model. `replaced` says that a preferred model was not offered.
 * @param {NvidiaCatalog} catalog
 * @param {string | null | undefined} preferred
 * @returns {{ model: string | null, replaced: boolean }}
 */
export function resolveNvidiaModel(catalog, preferred) {
  const offered = new Set(catalog.models.map((m) => m.id));
  /** @type {string | null} */
  let model;
  if (preferred && offered.has(preferred)) model = preferred;
  else if (catalog.defaultModel && offered.has(catalog.defaultModel)) model = catalog.defaultModel;
  else model = catalog.models[0]?.id ?? null;
  return { model, replaced: Boolean(preferred) && model !== null && model !== preferred };
}

/** i18n key per proxy error code (api/_lib, backend/core/nvidia.py). */
const NVIDIA_ERRORS = /** @type {Record<string, string>} */ ({
  nvidia_not_configured: 'provider.nvidia_not_configured',
  rate_limited: 'provider.nvidia_rate_limited',
  all_keys_exhausted: 'provider.nvidia_busy',
  proxy_busy: 'provider.nvidia_busy',
  model_not_allowed: 'provider.nvidia_model_unavailable',
  model_unavailable: 'provider.nvidia_model_unavailable',
  invalid_field: 'provider.nvidia_invalid_request',
  invalid_json: 'provider.nvidia_invalid_request',
  json_body_must_be_object: 'provider.nvidia_invalid_request',
  unsupported_media_type: 'provider.nvidia_invalid_request',
  method_not_allowed: 'provider.nvidia_invalid_request',
  length_required: 'provider.nvidia_invalid_request',
  payload_too_large: 'provider.nvidia_too_long',
  cross_site_request: 'provider.nvidia_forbidden',
  origin_required: 'provider.nvidia_forbidden',
  origin_not_allowed: 'provider.nvidia_forbidden',
  upstream_rejected: 'provider.nvidia_upstream',
  upstream_timeout: 'provider.nvidia_timeout',
});

const RETRY_AFTER_DEFAULT_S = 30;
const RETRY_AFTER_MAX_S = 3600;

/**
 * An error code as the proxy sends it, flat (`{ error: "code" }`) or nested (`{ error: { code } }`).
 * Anything that does not look like a code is ignored, so server text never reaches the page.
 * @param {unknown} body
 * @returns {string | null}
 */
function nvidiaErrorCode(body) {
  if (!isRecord(body)) return null;
  const raw = isRecord(body.error) ? body.error.code : body.error;
  return typeof raw === 'string' && /^[a-z_]{1,40}$/.test(raw) ? raw : null;
}

/**
 * Retry-After in whole seconds (delta seconds or an HTTP date), clamped to 1 s – 1 h.
 * @param {string | null} value
 */
function retryAfterSeconds(value) {
  const text = (value ?? '').trim();
  let seconds = Number.NaN;
  if (/^\d+$/.test(text)) seconds = Number(text);
  else if (text) seconds = Math.ceil((Date.parse(text) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) seconds = RETRY_AFTER_DEFAULT_S;
  return Math.min(Math.max(Math.round(seconds), 1), RETRY_AFTER_MAX_S);
}

/** @param {string} model */
function nvidiaModelName(model) {
  return findNvidiaModel(model)?.label ?? model;
}

/**
 * The error for a refused request, from the status, the code and Retry-After only.
 * @param {Response} res
 * @param {string} model
 * @returns {Promise<ProviderError>}
 */
async function nvidiaHttpError(res, model) {
  const { status } = res;
  const json = /^application\/json\b/i.test(res.headers.get('content-type') ?? '');
  /** @type {string | null} */
  let code = null;
  if (json) {
    try {
      code = nvidiaErrorCode(await res.json());
    } catch {
      // an unreadable body counts as no code
    }
  } else {
    res.body?.cancel().catch(() => {});
  }
  let key = code ? (NVIDIA_ERRORS[code] ?? null) : null;
  if (!key) {
    // No known code: the status decides. No proxy at this address is a 404 or a page that is not JSON.
    if (status === 429) key = 'provider.nvidia_rate_limited';
    else if (status === 503) key = 'provider.nvidia_busy';
    else if (status === 504) key = 'provider.nvidia_timeout';
    else if (status === 404 || !json) key = 'provider.nvidia_not_available';
    else key = 'provider.nvidia_upstream';
  }
  const params = { status, seconds: retryAfterSeconds(res.headers.get('retry-after')), model: nvidiaModelName(model) };
  const notConfigured = key === 'provider.nvidia_not_configured' || key === 'provider.nvidia_not_available';
  return new ProviderError(t(key, params), { status, notConfigured });
}

/**
 * Chat completion from an NVIDIA model through the proxy, streamed. `onDelta` receives the whole
 * answer so far (reasoning as a leading <think> block). On Stop, a timeout or an interrupted stream,
 * the part that already arrived is returned with `truncated: true`; with nothing to keep, Stop throws
 * an AbortError and everything else a ProviderError.
 * @param {ChatMessage[]} messages
 * @param {{ model: string, maxTokens: number, temperature: number, signal?: AbortSignal,
 *   onDelta?: (text: string) => void, timeouts?: Partial<Omit<import('./models/nvidia-catalog.js').NvidiaClientTimeouts, 'models'>> }} opts
 *   `timeouts`: shorter limits for tests
 * @returns {Promise<NvidiaResult>}
 */
export async function callNvidia(messages, opts) {
  const limits = { ...NVIDIA_CLIENT_TIMEOUTS, ...opts.timeouts };
  const user = opts.signal;
  if (user?.aborted) throw new DOMException('Aborted', 'AbortError');
  const local = new AbortController();
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    local.abort(new DOMException('The NVIDIA cloud did not answer in time', 'TimeoutError'));
  };
  const onUserAbort = () => local.abort(user?.reason);
  user?.addEventListener('abort', onUserAbort, { once: true });
  let phaseTimer = setTimeout(expire, limits.firstByte);
  const totalTimer = setTimeout(expire, limits.total);
  /** @param {number} ms */
  const restartPhase = (ms) => {
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(expire, ms);
  };
  /** @type {(() => void) | null} */
  let cancelRead = null;

  try {
    /** @type {Response} */
    let res;
    try {
      res = await fetch(NVIDIA_CHAT_URL, {
        method: 'POST',
        // The site's access code, when it asks for one (key vault slot).
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(getKey(ACCESS_SLOT) ? { [ACCESS_HEADER]: getKey(ACCESS_SLOT) } : {}) },
        body: JSON.stringify({ model: opts.model, messages, max_tokens: opts.maxTokens, temperature: opts.temperature }),
        signal: local.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (err) {
      if (user?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (timedOut) throw new ProviderError(t('provider.nvidia_timeout'), { status: 504, cause: err });
      throw new ProviderError(t('provider.nvidia_unreachable'), { cause: err });
    }
    if (!res.ok) throw await nvidiaHttpError(res, opts.model);

    const type = res.headers.get('content-type') ?? '';
    if (/^application\/json\b/i.test(type)) return await nvidiaJsonAnswer(res, opts.model, () => Boolean(user?.aborted), () => timedOut);
    if (!/^text\/event-stream\b/i.test(type) || !res.body) {
      res.body?.cancel().catch(() => {});
      throw new ProviderError(t('provider.nvidia_bad_response'), { status: res.status });
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    // Stop and the timers cancel the read in progress, which then reports the stream as done.
    cancelRead = () => {
      reader.cancel().catch(() => {});
    };
    local.signal.addEventListener('abort', cancelRead, { once: true });
    const assembler = createChatStreamAssembler();
    const parser = createSseParser((ev) => {
      if (ev.event === 'error') {
        let code = null;
        try {
          code = nvidiaErrorCode(JSON.parse(ev.data));
        } catch {
          // not JSON: an unnamed error
        }
        assembler.fail(code ?? 'stream_error');
      } else if (assembler.push(ev.data)) {
        opts.onDelta?.(assembler.text());
      }
    });
    let interrupted = false;
    try {
      while (!assembler.done && !assembler.error && !assembler.overflow && !local.signal.aborted) {
        restartPhase(limits.idle);
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
      }
      if (!local.signal.aborted) parser.end();
    } catch {
      // A broken connection, or an event longer than the parser accepts.
      interrupted = !local.signal.aborted;
    }
    if (!local.signal.aborted) reader.cancel().catch(() => {});

    const text = assembler.text();
    const hasAnswer = splitStreamingText(text).answer.trim() !== '';
    const result = (/** @type {boolean} */ truncated) => ({ text, model: opts.model, finishReason: assembler.finishReason, truncated });
    if (user?.aborted) {
      if (hasAnswer) return result(true);
      throw new DOMException('Aborted', 'AbortError');
    }
    if (timedOut) {
      if (hasAnswer) return result(true);
      throw new ProviderError(t('provider.nvidia_timeout'), { status: 504 });
    }
    if (interrupted || assembler.error || assembler.overflow) {
      if (hasAnswer) return result(true);
      throw new ProviderError(t(assembler.error === 'stream_timeout' ? 'provider.nvidia_timeout' : 'provider.nvidia_interrupted'), { status: 502 });
    }
    if (!hasAnswer) throw new ProviderError(t(assembler.reasoning.trim() || text.trim() ? 'provider.nvidia_only_reasoning' : 'provider.empty_answer'));
    // Without [DONE] and without a finish reason the stream ended early; "length" hit the token limit.
    return result(assembler.finishReason === 'length' || (!assembler.done && !assembler.finishReason));
  } finally {
    clearTimeout(phaseTimer);
    clearTimeout(totalTimer);
    user?.removeEventListener('abort', onUserAbort);
    if (cancelRead) local.signal.removeEventListener('abort', cancelRead);
  }
}

/**
 * A reply that was not streamed (some servers ignore `stream`): one chat.completion object.
 * @param {Response} res
 * @param {string} model
 * @param {() => boolean} userAborted
 * @param {() => boolean} timedOut
 * @returns {Promise<NvidiaResult>}
 */
async function nvidiaJsonAnswer(res, model, userAborted, timedOut) {
  /** @type {unknown} */
  let data;
  try {
    data = await res.json();
  } catch (err) {
    if (userAborted()) throw new DOMException('Aborted', 'AbortError');
    if (timedOut()) throw new ProviderError(t('provider.nvidia_timeout'), { status: 504, cause: err });
    throw new ProviderError(t('provider.nvidia_bad_response'), { status: res.status, cause: err });
  }
  const choice = isRecord(data) && Array.isArray(data.choices) && isRecord(data.choices[0]) ? data.choices[0] : null;
  const message = choice && isRecord(choice.message) ? choice.message : null;
  if (!message) throw new ProviderError(t('provider.nvidia_bad_response'), { status: res.status });
  const content = typeof message.content === 'string' ? message.content : '';
  const thought = typeof message.reasoning_content === 'string' ? message.reasoning_content : typeof message.reasoning === 'string' ? message.reasoning : '';
  const text = thought.trim() ? `<think>${thought.replaceAll('</think>', '')}</think>\n\n${content}` : content;
  if (!splitStreamingText(text).answer.trim()) throw new ProviderError(t(thought.trim() || content.trim() ? 'provider.nvidia_only_reasoning' : 'provider.empty_answer'));
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason.slice(0, 40) : null;
  return { text, model, finishReason, truncated: finishReason === 'length' };
}
