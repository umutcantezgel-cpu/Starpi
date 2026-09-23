// @ts-check
// Remote inference providers: Google Gemini and OpenRouter (bring-your-own key) and a user-operated
// Chat Completions-compatible server (/v1/chat/completions: MLX, Ollama, vLLM). Keys never leave the browser except to their provider.
import { t } from './i18n/index.js';
import { STORAGE_KEYS, TIMEOUTS_MS } from './config.js';
import { withTimeoutSignal } from './signals.js';
import { readSecret } from './storage.js';

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
  return readSecret(STORAGE_KEYS.geminiKey).trim().length > 0;
}

export function hasOpenRouterKey() {
  return readSecret(STORAGE_KEYS.openrouterKey).trim().length > 0;
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
 * Single-turn Gemini completion. The key travels in the x-goog-api-key header, never in the URL.
 * @param {string} prompt
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ text: string }>}
 */
export async function callGemini(prompt, opts = {}) {
  const key = readSecret(STORAGE_KEYS.geminiKey).trim();
  if (!key) throw new ProviderError(t('provider.no_gemini_key'), { notConfigured: true });
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
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
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function callOpenRouter(messages, opts = {}) {
  const key = readSecret(STORAGE_KEYS.openrouterKey).trim();
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

/**
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function probeLocalServer(baseUrl) {
  try {
    const res = await fetch(`${normalizeServerUrl(baseUrl)}/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUTS_MS.localServerProbe),
    });
    return res.ok;
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
  const res = await fetch(`${normalizeServerUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature: 0.7, max_tokens: 1024 }),
    signal: withTimeoutSignal(opts.signal, TIMEOUTS_MS.localServer),
  });
  if (!res.ok) throw await httpError(res, 'server');
  /** @type {{ choices?: Array<{ message?: { content?: string } }> }} */
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new ProviderError(t('provider.empty_server_answer'));
  return { text };
}
