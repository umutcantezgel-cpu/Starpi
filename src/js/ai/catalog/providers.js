// @ts-check
// The providers the AI layer can talk to: how each is reached (dialect, API root, auth header),
// which transport the browser tries first, a key format hint, where its documentation lives and
// which quirks object shapes its requests. Pure data plus small lookups; the model lists live in
// snapshot.json and models.js.
//
// Base URLs are API roots without the version segment (see the paths note in ../transport.js):
// adapters build paths such as /v1/chat/completions below them, so one built request works direct,
// through the relay and through a pool.
//
// Transport defaults:
//   direct  the browser calls the provider (it allows cross-origin calls); the relay is the fallback
//   auto    try direct once; a call blocked before any answer (cors) retries through the relay and
//           the outcome is remembered per provider
//   relay   always through this site's stateless relay
//   pool    this site's key pool (no key in the browser); a user key goes through the relay
//   device  local server on the user's network, an in-browser engine, or the paired companion on
//           this machine (its adapter reaches it through the pairing, without a transport); never
//           relayed

/** @typedef {import('../contract.js').ProviderId} ProviderId */

/**
 * @typedef {'anthropic' | 'openai-responses' | 'openai-chat' | 'gemini' | 'webllm' | 'wasm' | 'companion'} Dialect
 * @typedef {'bearer' | 'x-api-key' | 'x-goog-api-key' | 'optional-bearer' | 'none'} AuthStyle
 * @typedef {'direct' | 'auto' | 'relay' | 'pool' | 'device'} TransportDefault
 *
 * @typedef {object} ProviderInfo
 * @property {ProviderId} id
 * @property {string} label            proper name, never translated
 * @property {Dialect} dialect
 * @property {string | null} baseUrl   API root without the version segment; null for in-browser engines
 * @property {AuthStyle} auth
 * @property {string | null} authHeader header that carries the key (lower case)
 * @property {TransportDefault} transport
 * @property {string | null} keyPattern  regular expression source of the key format, for hints only
 * @property {string | null} keyHint     how a key starts, as shown next to the input
 * @property {string | null} docsUrl
 * @property {string | null} keysUrl     where a user creates a key
 * @property {string | null} quirks      id of the request quirks (src/js/ai/quirks)
 * @property {string | null} modelsPath  live model list below baseUrl
 * @property {boolean} byok            a user key can be added
 * @property {boolean} pool            the site may offer a key pool for it
 * @property {string} [testModel]      for a provider without a live model list: the model the key
 *   test sends one tiny chat request to instead
 */

/**
 * @typedef {object} LocalServerPreset
 * @property {'ollama' | 'lmstudio' | 'vllm' | 'llamacpp'} id
 * @property {string} label
 * @property {string} baseUrl         API root without /v1
 * @property {string | null} corsSetting the server's own name of the setting that lets a web page call
 *   it (an environment variable, a switch or a flag; technical, so never translated); null when the
 *   server answers cross-origin calls without setup
 */

/**
 * @param {ProviderInfo} info
 * @returns {Readonly<ProviderInfo>}
 */
const provider = (info) => Object.freeze(info);

/** @type {Readonly<Record<ProviderId, Readonly<ProviderInfo>>>} */
export const PROVIDERS = Object.freeze({
  anthropic: provider({
    id: 'anthropic',
    label: 'Anthropic',
    dialect: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    auth: 'x-api-key',
    authHeader: 'x-api-key',
    transport: 'direct',
    keyPattern: '^sk-ant-[A-Za-z0-9_-]{20,}$',
    keyHint: 'sk-ant-',
    docsUrl: 'https://platform.claude.com/docs/en/api/overview',
    keysUrl: 'https://platform.claude.com/settings/keys',
    quirks: null,
    modelsPath: '/v1/models',
    byok: true,
    pool: false,
  }),
  openai: provider({
    id: 'openai',
    label: 'OpenAI',
    dialect: 'openai-responses',
    baseUrl: 'https://api.openai.com',
    auth: 'bearer',
    authHeader: 'authorization',
    transport: 'direct',
    keyPattern: '^sk-[A-Za-z0-9_-]{20,}$',
    keyHint: 'sk-',
    docsUrl: 'https://platform.openai.com/docs/api-reference/responses',
    keysUrl: 'https://platform.openai.com/api-keys',
    quirks: null,
    modelsPath: '/v1/models',
    byok: true,
    pool: false,
  }),
  gemini: provider({
    id: 'gemini',
    label: 'Google Gemini',
    dialect: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    auth: 'x-goog-api-key',
    authHeader: 'x-goog-api-key',
    transport: 'direct',
    keyPattern: '^AIza[0-9A-Za-z_-]{35}$',
    keyHint: 'AIza',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    keysUrl: 'https://aistudio.google.com/apikey',
    quirks: null,
    modelsPath: '/v1beta/models',
    byok: true,
    pool: true,
  }),
  xai: provider({
    id: 'xai',
    label: 'xAI',
    dialect: 'openai-chat',
    baseUrl: 'https://api.x.ai',
    auth: 'bearer',
    authHeader: 'authorization',
    transport: 'auto',
    keyPattern: '^xai-[A-Za-z0-9]{20,}$',
    keyHint: 'xai-',
    docsUrl: 'https://docs.x.ai/docs',
    keysUrl: 'https://console.x.ai',
    quirks: 'xai',
    modelsPath: '/v1/models',
    byok: true,
    pool: false,
  }),
  groq: provider({
    id: 'groq',
    label: 'Groq',
    dialect: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai',
    auth: 'bearer',
    authHeader: 'authorization',
    transport: 'auto',
    keyPattern: '^gsk_[A-Za-z0-9]{20,}$',
    keyHint: 'gsk_',
    docsUrl: 'https://console.groq.com/docs',
    keysUrl: 'https://console.groq.com/keys',
    quirks: 'groq',
    modelsPath: '/v1/models',
    byok: true,
    pool: true,
  }),
  mistral: provider({
    id: 'mistral',
    label: 'Mistral AI',
    dialect: 'openai-chat',
    baseUrl: 'https://api.mistral.ai',
    auth: 'bearer',
    authHeader: 'authorization',
    transport: 'auto',
    keyPattern: '^[A-Za-z0-9]{32}$',
    keyHint: null,
    docsUrl: 'https://docs.mistral.ai',
    keysUrl: 'https://console.mistral.ai/api-keys',
    quirks: 'mistral',
    modelsPath: '/v1/models',
    byok: true,
    pool: false,
  }),
  deepseek: provider({
    id: 'deepseek',
    label: 'DeepSeek',
    dialect: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    auth: 'bearer',
    authHeader: 'authorization',
    transport: 'auto',
    keyPattern: '^sk-[A-Za-z0-9]{32,}$',
    keyHint: 'sk-',
    docsUrl: 'https://api-docs.deepseek.com',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    quirks: 'deepseek',
    modelsPath: '/v1/models',
    byok: true,
    pool: false,
  }),
  // MiniMax on its OpenAI-compatible endpoint (https://api.minimax.io/v1, as of 2026-10-20). The
  // catalog relies on no model list (no modelsPath: the key test asks the base model for a few
  // tokens instead) and on no key format (no keyPattern or hint).
  minimax: provider({
    id: 'minimax',
    label: 'MiniMax',
    dialect: 'openai-chat',
    baseUrl: 'https://api.minimax.io',
    auth: 'bearer',
    authHeader: 'authorization',
    transport: 'auto',
    keyPattern: null,
    keyHint: null,
    docsUrl: 'https://platform.minimax.io/docs',
    keysUrl: 'https://platform.minimax.io',
    quirks: 'minimax',
    modelsPath: null,
    byok: true,
    pool: true,
    testModel: 'MiniMax-M3.1-Flash',
  }),
  openrouter: provider({
    id: 'openrouter',
    label: 'OpenRouter',
    dialect: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api',
    auth: 'bearer',
    authHeader: 'authorization',
    transport: 'direct',
    keyPattern: '^sk-or-v1-[A-Za-z0-9]{32,}$',
    keyHint: 'sk-or-v1-',
    docsUrl: 'https://openrouter.ai/docs',
    keysUrl: 'https://openrouter.ai/keys',
    quirks: 'openrouter',
    modelsPath: '/v1/models',
    byok: true,
    pool: true,
  }),
  nvidia: provider({
    id: 'nvidia',
    label: 'NVIDIA',
    dialect: 'openai-chat',
    baseUrl: 'https://integrate.api.nvidia.com',
    auth: 'bearer',
    authHeader: 'authorization',
    transport: 'pool',
    keyPattern: '^nvapi-[A-Za-z0-9_-]{40,}$',
    keyHint: 'nvapi-',
    docsUrl: 'https://docs.api.nvidia.com',
    keysUrl: 'https://build.nvidia.com',
    quirks: 'nvidia',
    modelsPath: '/v1/models',
    byok: true,
    pool: true,
  }),
  local: provider({
    id: 'local',
    label: 'Local server',
    dialect: 'openai-chat',
    baseUrl: null,
    auth: 'optional-bearer',
    authHeader: 'authorization',
    transport: 'device',
    keyPattern: null,
    keyHint: null,
    docsUrl: null,
    keysUrl: null,
    quirks: 'local',
    modelsPath: '/v1/models',
    byok: false,
    pool: false,
  }),
  webgpu: provider({
    id: 'webgpu',
    label: 'WebGPU',
    dialect: 'webllm',
    baseUrl: null,
    auth: 'none',
    authHeader: null,
    transport: 'device',
    keyPattern: null,
    keyHint: null,
    docsUrl: null,
    keysUrl: null,
    quirks: null,
    modelsPath: null,
    byok: false,
    pool: false,
  }),
  wasm: provider({
    id: 'wasm',
    label: 'WebAssembly',
    dialect: 'wasm',
    baseUrl: null,
    auth: 'none',
    authHeader: null,
    transport: 'device',
    keyPattern: null,
    keyHint: null,
    docsUrl: null,
    keysUrl: null,
    quirks: null,
    modelsPath: null,
    byok: false,
    pool: false,
  }),
  // The paired companion: reached through the pairing (companion/pair.js), never with a key.
  companion: provider({
    id: 'companion',
    label: 'Starpi Core',
    dialect: 'companion',
    baseUrl: null,
    auth: 'none',
    authHeader: null,
    transport: 'device',
    keyPattern: null,
    keyHint: null,
    docsUrl: null,
    keysUrl: null,
    quirks: null,
    modelsPath: null,
    byok: false,
    pool: false,
  }),
});

/** The one model id of the paired companion: which of its models answers is the companion's choice. */
export const COMPANION_MODEL = 'starpi-core';

/** Provider ids in the order pickers list them. */
export const PROVIDER_ORDER = /** @type {readonly ProviderId[]} */ (
  Object.freeze(['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'minimax', 'openrouter', 'nvidia', 'local', 'webgpu', 'wasm', 'companion'])
);

/**
 * The cloud base model: what Auto, the purposes and the privacy notice reach first whenever it can
 * answer (a key of the user's, or this site's pool for it), on every kind of device. Without it the
 * order stays as it is, and the on-device default is untouched.
 */
export const BASE_PROVIDER = /** @type {ProviderId} */ ('minimax');
export const BASE_MODEL = 'MiniMax-M3.1-Flash';

/**
 * MiniMax M3 and M3.1 builds by name, also as a self-hosted server lists them (with a vendor prefix,
 * a quantization suffix or a tag). They always think; catalog/models.js knows their context window.
 */
export const MINIMAX_M3 = /minimax[-_. ]?m3/i;

/**
 * The providers with the base model's provider moved to the front when it is among them; the
 * others keep their order.
 * @template {string} T
 * @param {readonly T[]} providers
 * @returns {T[]}
 */
export function baseFirst(providers) {
  const out = [...providers];
  const at = out.indexOf(/** @type {T} */ (/** @type {string} */ (BASE_PROVIDER)));
  if (at > 0) out.unshift(...out.splice(at, 1));
  return out;
}

/**
 * Local OpenAI-compatible servers with their default address. A browser page may call one only
 * after the server allows its origin; `corsSetting` names the setting the view's recipe refers to.
 * @type {Readonly<Record<LocalServerPreset['id'], Readonly<LocalServerPreset>>>}
 */
export const LOCAL_SERVER_PRESETS = Object.freeze({
  ollama: Object.freeze({ id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', corsSetting: 'OLLAMA_ORIGINS' }),
  lmstudio: Object.freeze({ id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234', corsSetting: 'Enable CORS' }),
  vllm: Object.freeze({ id: 'vllm', label: 'vLLM', baseUrl: 'http://localhost:8000', corsSetting: '--allowed-origins' }),
  // Double quotes: the i18n check reads single-quoted dotted words after a colon as message keys.
  llamacpp: Object.freeze({ id: 'llamacpp', label: "llama.cpp", baseUrl: 'http://localhost:8080', corsSetting: null }),
});

/**
 * @param {unknown} id
 * @returns {Readonly<ProviderInfo> | null}
 */
export function getProvider(id) {
  return typeof id === 'string' && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[/** @type {ProviderId} */ (id)] : null;
}

/**
 * Whether a key looks like the provider's format. Only a hint for the key input: providers change
 * their formats, so a key that does not match is still accepted.
 * @param {ProviderId} id
 * @param {string} key
 * @returns {boolean | null} null when the provider has no known format
 */
export function keyLooksValid(id, key) {
  const pattern = getProvider(id)?.keyPattern;
  if (!pattern) return null;
  return new RegExp(pattern).test(String(key ?? '').trim());
}

/**
 * The API root a local server URL stands for: a trailing /v1 (as servers document their OpenAI
 * endpoint) and trailing slashes are removed. Null for anything but an http(s) URL without
 * credentials, query or fragment.
 * @param {string} url
 * @returns {string | null}
 */
export function localApiRoot(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return parsed.href.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * The OpenAI-compatible endpoint of a preset as its documentation writes it (for display).
 * @param {LocalServerPreset['id']} id
 */
export function presetEndpoint(id) {
  return `${LOCAL_SERVER_PRESETS[id].baseUrl}/v1`;
}
