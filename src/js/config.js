// @ts-check
// Static configuration. Supabase values are public by design (anon key + RLS) and injected at build time.

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
  sessionId: 'starpi_chat_session_id',
  localChats: 'starpi_local_chats_v1',
});

/** Keys written by earlier versions that are no longer read. */
export const LEGACY_STORAGE_KEYS = Object.freeze(['starpi_ai_tier']);

/** @typedef {'council' | 'client' | 'local'} ComputeMode */

/** @type {readonly ComputeMode[]} */
export const COMPUTE_MODES = Object.freeze(['council', 'client', 'local']);

/** Values persisted by earlier versions, mapped onto the current modes. */
export const LEGACY_MODE_ALIASES = Object.freeze({
  gemini: 'council',
  brain: 'council',
  cluster_a: 'council',
  cluster_b: 'council',
  openrouter: 'council',
  webgpu: 'client',
});

export const DEFAULT_LLM_URL = 'http://localhost:8000/v1';

export const TIMEOUTS_MS = Object.freeze({
  supabase: 12_000,
  gemini: 20_000,
  openrouter: 20_000,
  localServer: 90_000,
  localServerProbe: 4_000,
});

export const LIMITS = Object.freeze({
  chatInputChars: 8_000,
  attachmentBytes: 512 * 1024,
  ingestFileBytes: 2 * 1024 * 1024,
  ingestContentChars: 200_000,
  titleChars: 200,
  localChatMessagesPerSession: 200,
  localChatSessions: 10,
  retrievalRows: 6,
  contextCharsCloud: 9_000,
  excerptChars: 1_600,
});
