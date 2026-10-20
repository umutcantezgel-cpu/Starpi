// @ts-check
// Static configuration. Supabase values are public by design (anon key + RLS) and injected at build time.

/** App version from package.json, recorded in answer receipts. */
export const APP_VERSION = __STARPI_VERSION__;
export const SUPABASE_URL = __STARPI_SUPABASE_URL__;
export const SUPABASE_ANON_KEY = __STARPI_SUPABASE_ANON_KEY__;
export const SUPABASE_PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];

export const STORAGE_KEYS = Object.freeze({
  llmUrl: 'starpi_llm_url',
  geminiKey: 'starpi_gemini_key',
  openrouterKey: 'starpi_openrouter_key',
  rememberKeys: 'starpi_remember_keys',
  computeMode: 'starpi_compute_mode',
  webgpuModel: 'starpi_webgpu_model',
  nvidiaModel: 'starpi_nvidia_model',
  chatMode: 'starpi_chat_mode',
  assistant: 'starpi_assistant_v1',
  webSearch: 'starpi_web_search_v1',
  sessionId: 'starpi_chat_session_id',
  localChats: 'starpi_local_chats_v1',
});

/** Keys written by earlier versions that are no longer read. */
export const LEGACY_STORAGE_KEYS = Object.freeze(['starpi_ai_tier']);

/**
 * Where an answer is computed, as 2.x stored it (starpi_compute_mode) and as other modules still
 * ask for it: 'client' runs on this device, 'local' on the user's own server, 'nvidia' through the
 * site's NVIDIA pool, 'council' at a cloud provider (or wherever Auto routes).
 * @typedef {'council' | 'client' | 'local' | 'nvidia'} ComputeMode
 */

/** @type {readonly ComputeMode[]} */
export const COMPUTE_MODES = Object.freeze(['council', 'client', 'local', 'nvidia']);

/**
 * The assistant the model picker selects (starpi_assistant_v1):
 * - 'auto': the best model that is set up (a key of the user's, the site's free pools, a local
 *   server, the model on this device), in that order;
 * - 'device': the on-device model of the stored preference (starpi_webgpu_model, 'auto' = the one
 *   recommended for this device);
 * - '<provider>:<model>': one model of one provider, e.g. 'anthropic:claude-opus-5-5',
 *   'nvidia:<id>' (the site's pool without a key of the user's), 'local:*' (the first model the
 *   user's own server lists).
 * @typedef {'auto' | 'device' | `${string}:${string}`} AssistantValue
 */

export const ASSISTANT_AUTO = 'auto';
export const ASSISTANT_DEVICE = 'device';
/** The model id of 'local:*': the first model the own server lists. */
export const LOCAL_ANY_MODEL = '*';

/**
 * 'grounded': answers from the sources, checked sentence by sentence, with a receipt.
 * 'free': a conversation without retrieval and without the source check.
 * 'auto': grounded when there are sources to answer from (an attached document, files in the
 * on-device workspace, documents in the knowledge base), free otherwise.
 * @typedef {'grounded' | 'free' | 'auto'} ChatMode
 */

/** @type {readonly ChatMode[]} */
export const CHAT_MODES = Object.freeze(['auto', 'free', 'grounded']);

/** Values persisted by earlier versions, mapped onto the 2.x compute modes. */
export const LEGACY_MODE_ALIASES = Object.freeze({
  gemini: 'council',
  brain: 'council',
  cluster_a: 'council',
  cluster_b: 'council',
  openrouter: 'council',
  webgpu: 'client',
});

/**
 * The picker value a 2.x compute mode becomes once (starpi_compute_mode -> starpi_assistant_v1).
 * 'nvidia' keeps its stored model ('nvidia:<id>'); the others map as listed.
 */
export const LEGACY_ASSISTANT = Object.freeze({
  council: ASSISTANT_AUTO,
  client: ASSISTANT_DEVICE,
  local: `local:${LOCAL_ANY_MODEL}`,
});

export const DEFAULT_LLM_URL = 'http://localhost:8000/v1';

export const TIMEOUTS_MS = Object.freeze({
  supabase: 12_000,
  gemini: 20_000,
  openrouter: 20_000,
  localServer: 90_000,
  localServerProbe: 4_000,
  // A chat title is a nicety: the first words of the question stand until a model names it.
  chatTitle: 20_000,
  // Bench history read for the picker's recommendation; without it the hardware guess stands.
  benchHistory: 1_500,
});

export const LIMITS = Object.freeze({
  chatInputChars: 8_000,
  ingestFileBytes: 2 * 1024 * 1024,
  ingestContentChars: 200_000,
  titleChars: 200,
  retrievalRows: 6,
  contextCharsCloud: 9_000,
  excerptChars: 1_600,
  // Free chat: the part of an attached file when the model's context is not known.
  freeAttachmentChars: 12_000,
  // Free chat with the 3.0 thread: files and images per message, the long edge images are scaled
  // to (JPEG at this quality) before they go to a model, and the text budget of an attached file
  // for models with a large context (a fifth of the context, at most this many characters).
  attachmentsPerMessage: 10,
  imageLongEdge: 1568,
  imageQuality: 0.85,
  attachmentTextChars: 120_000,
  // Answers that stopped for a server-side pause are sent again this often at most.
  pauseContinuations: 5,
});
