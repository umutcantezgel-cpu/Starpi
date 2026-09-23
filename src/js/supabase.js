// @ts-check
// Supabase data layer: timeouts, error classification, anonymous auth bootstrap and typed queries.
// Every exported query resolves to a Result and never rejects, so callers cannot leak unhandled rejections.
import { createClient } from '@supabase/supabase-js';
import { LIMITS, SUPABASE_ANON_KEY, SUPABASE_URL, TIMEOUTS_MS } from './config.js';
import { withTimeoutSignal } from './signals.js';

/** @typedef {'timeout' | 'network' | 'missing_schema' | 'missing_function' | 'forbidden' | 'auth_disabled' | 'not_signed_in' | 'unknown'} ErrorKind */
/** @typedef {{ kind: ErrorKind, message: string, code?: string }} DataError */
/**
 * @template T
 * @typedef {{ ok: true, data: T } | { ok: false, error: DataError }} Result
 */

/**
 * @typedef {object} KnowledgeHit
 * @property {string | null} documentId
 * @property {string} documentTitle
 * @property {string} heading
 * @property {string} content
 * @property {string[]} tags
 * @property {number | null} rank
 * @property {{ docId: string, chunkIndex: number, start: number, end: number }} [workspace] set for chunks from the on-device workspace
 */

/**
 * @typedef {object} DocumentRow
 * @property {string} id
 * @property {string} title
 * @property {string | null} source_type
 * @property {string | null} summary
 * @property {string | null} raw_content
 * @property {string[] | null} tags
 * @property {string} created_at
 */

/**
 * @typedef {object} ChatRow
 * @property {'user' | 'assistant'} role
 * @property {string} content
 * @property {Array<{ title: string, rank?: number | null }>} sources
 * @property {Record<string, unknown>} metadata
 * @property {string} [created_at]
 */

/**
 * fetch() with a hard timeout, combined with any caller-provided signal.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
function fetchWithTimeout(input, init = {}) {
  return fetch(input, { ...init, signal: withTimeoutSignal(init.signal, TIMEOUTS_MS.supabase) });
}

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'starpi-auth',
  },
  global: { fetch: fetchWithTimeout },
});

/**
 * Maps Supabase/PostgREST/Auth/network failures onto a small set of actionable kinds.
 * @param {unknown} err
 * @returns {DataError}
 */
export function classifyError(err) {
  const e = /** @type {{ name?: string, code?: string, message?: string, status?: number } | null} */ (
    err && typeof err === 'object' ? err : null
  );
  const message = e?.message ? String(e.message) : String(err ?? 'Unbekannter Fehler');
  const code = e?.code ? String(e.code) : undefined;
  const name = e?.name ?? '';

  if (name === 'TimeoutError' || name === 'AbortError' || /TimeoutError|AbortError|timed? ?out|signal is aborted/i.test(message)) {
    return { kind: 'timeout', message, code };
  }
  // postgrest-js/auth-js wrap fetch failures in plain objects ({ message: 'TypeError: Failed to fetch' }).
  if (/Failed to fetch|NetworkError|Load failed|fetch failed|ERR_[A-Z_]+/i.test(message) || (name === 'TypeError' && /fetch|network/i.test(message))) {
    return { kind: 'network', message, code };
  }
  if (code === 'anonymous_provider_disabled' || /anonymous sign-ins are disabled/i.test(message)) {
    return { kind: 'auth_disabled', message, code };
  }
  if (code === 'PGRST202') return { kind: 'missing_function', message, code };
  if (code === '42P01' || code === 'PGRST205' || code === '42703' || code === 'PGRST204') {
    return { kind: 'missing_schema', message, code };
  }
  if (code === '42501' || code === 'PGRST301' || e?.status === 401 || e?.status === 403) {
    return { kind: 'forbidden', message, code };
  }
  return { kind: 'unknown', message, code };
}

/**
 * @template T
 * @param {PromiseLike<{ data: T | null, error: unknown }>} request
 * @returns {Promise<Result<T>>}
 */
async function run(request) {
  try {
    const { data, error } = await request;
    if (error) return { ok: false, error: classifyError(error) };
    return { ok: true, data: /** @type {T} */ (data) };
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
}

// ---------------------------------------------------------------------------
// Connection state: anonymous session + schema capability probe
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ConnectionState
 * @property {'pending' | 'ready' | 'offline'} status
 * @property {boolean} signedIn Anonymous (or regular) Supabase session is active.
 * @property {boolean} hardened The RLS migration (owner_id / is_public columns) is installed.
 * @property {DataError | null} authError
 * @property {DataError | null} probeError
 */

/** @type {ConnectionState} */
let connection = { status: 'pending', signedIn: false, hardened: false, authError: null, probeError: null };
/** @type {Set<(state: ConnectionState) => void>} */
const connectionListeners = new Set();
/** @type {Promise<ConnectionState> | null} */
let connectPromise = null;

export function getConnection() {
  return connection;
}

/** @param {(state: ConnectionState) => void} listener */
export function onConnectionChange(listener) {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

/** @param {Partial<ConnectionState>} patch */
function updateConnection(patch) {
  connection = { ...connection, ...patch };
  for (const listener of connectionListeners) listener(connection);
}

/** @returns {Promise<DataError | null>} */
async function ensureSession() {
  try {
    const { data, error } = await sb.auth.getSession();
    if (error) return classifyError(error);
    if (data.session) return null;
    const signIn = await sb.auth.signInAnonymously();
    return signIn.error ? classifyError(signIn.error) : null;
  } catch (err) {
    return classifyError(err);
  }
}

/**
 * Establishes the anonymous session and detects whether the hardened schema is installed.
 * Safe to call repeatedly; concurrent callers share one attempt.
 */
export function connect() {
  if (!connectPromise) {
    connectPromise = (async () => {
      const authError = await ensureSession();
      const probe = await run(sb.from('knowledge_documents').select('id, is_public').limit(1));
      const offline = !probe.ok && (probe.error.kind === 'network' || probe.error.kind === 'timeout');
      updateConnection({
        status: offline ? 'offline' : 'ready',
        signedIn: authError === null,
        authError,
        hardened: probe.ok,
        probeError: probe.ok ? null : probe.error,
      });
      if (offline) connectPromise = null; // allow a later retry
      return connection;
    })();
  }
  return connectPromise;
}

/** Chats may be stored in Supabase only when a session exists and RLS isolates them per user. */
export function canSyncChats() {
  return connection.signedIn && connection.hardened;
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

/** @returns {Promise<Result<DocumentRow[]>>} */
export function listDocuments() {
  return run(
    sb
      .from('knowledge_documents')
      .select('id, title, source_type, summary, raw_content, tags, created_at')
      .order('created_at', { ascending: false })
      .limit(200),
  );
}

/**
 * @param {string} id
 * @returns {Promise<Result<{ doc: DocumentRow, sections: Array<{ heading: string | null, markdown_content: string | null }> }>>}
 */
export async function getDocument(id) {
  const [doc, sections] = await Promise.all([
    run(sb.from('knowledge_documents').select('id, title, source_type, summary, raw_content, tags, created_at').eq('id', id).maybeSingle()),
    run(sb.from('knowledge_sections').select('heading, markdown_content').eq('document_id', id).order('section_index', { ascending: true })),
  ]);
  if (!doc.ok) return doc;
  if (!doc.data) return { ok: false, error: { kind: 'forbidden', message: 'Document not found or not shared.' } };
  const sectionRows = sections.ok ? /** @type {Array<{ heading: string | null, markdown_content: string | null }>} */ (sections.data ?? []) : [];
  return { ok: true, data: { doc: /** @type {DocumentRow} */ (doc.data), sections: sectionRows } };
}

/**
 * Most recent documents flattened into knowledge hits. Sends no user text to the server.
 * @param {number} limit
 * @returns {Promise<Result<KnowledgeHit[]>>}
 */
export async function recentKnowledge(limit) {
  const res = await run(
    sb
      .from('knowledge_documents')
      .select('id, title, summary, raw_content, tags, knowledge_sections(heading, markdown_content, section_index)')
      .order('created_at', { ascending: false })
      .limit(limit),
  );
  if (!res.ok) return res;
  /** @type {KnowledgeHit[]} */
  const hits = [];
  for (const raw of /** @type {Array<Record<string, unknown>>} */ (res.data ?? [])) {
    const sections = /** @type {Array<{ heading: string | null, markdown_content: string | null, section_index: number | null }>} */ (
      Array.isArray(raw.knowledge_sections) ? raw.knowledge_sections : []
    ).sort((a, b) => (a.section_index ?? 0) - (b.section_index ?? 0));
    const base = {
      documentId: /** @type {string} */ (raw.id),
      documentTitle: String(raw.title ?? ''),
      tags: /** @type {string[]} */ (Array.isArray(raw.tags) ? raw.tags : []),
      rank: null,
    };
    if (sections.length === 0) {
      hits.push({ ...base, heading: '', content: String(raw.summary || raw.raw_content || '') });
    } else {
      for (const s of sections) hits.push({ ...base, heading: s.heading ?? '', content: s.markdown_content ?? '' });
    }
  }
  return { ok: true, data: hits };
}

/**
 * Full-text search through the `search_knowledge` RPC (RLS applies, SECURITY INVOKER).
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<Result<KnowledgeHit[]>>}
 */
export async function searchKnowledge(query, limit = LIMITS.retrievalRows) {
  const res = await run(sb.rpc('search_knowledge', { query_text: query.slice(0, 1_000), match_count: limit }));
  if (!res.ok) return res;
  const rows = /** @type {Array<Record<string, unknown>>} */ (Array.isArray(res.data) ? res.data : []);
  return {
    ok: true,
    data: rows.map((r) => ({
      documentId: /** @type {string | null} */ (r.document_id ?? null),
      documentTitle: String(r.document_title ?? ''),
      heading: String(r.heading ?? ''),
      content: String(r.markdown_content ?? ''),
      tags: /** @type {string[]} */ (Array.isArray(r.tags) ? r.tags : []),
      rank: typeof r.rank === 'number' ? r.rank : null,
    })),
  };
}

/**
 * Inserts a document and its single Markdown section. Embeddings are left NULL; the backend
 * computes real vectors (the browser never writes placeholder embeddings).
 * @param {{ title: string, sourceType: string, rawContent: string, summary: string, tags: string[], markdown: string, heading: string }} input
 * @returns {Promise<Result<{ id: string }>>}
 */
export async function insertDocument(input) {
  const doc = await run(
    sb
      .from('knowledge_documents')
      .insert({
        title: input.title,
        source_type: input.sourceType,
        source_name: input.title,
        raw_content: input.rawContent,
        summary: input.summary,
        tags: input.tags,
      })
      .select('id')
      .single(),
  );
  if (!doc.ok) return doc;
  const id = /** @type {{ id: string }} */ (/** @type {unknown} */ (doc.data)).id;
  const section = await run(
    sb.from('knowledge_sections').insert({
      document_id: id,
      section_index: 0,
      heading: input.heading,
      markdown_content: input.markdown,
      token_count: input.rawContent.split(/\s+/).filter(Boolean).length,
      embedding: null,
    }),
  );
  if (!section.ok) {
    // Do not leave a document without content behind (best effort; requires owner delete rights).
    await run(sb.from('knowledge_documents').delete().eq('id', id));
    return section;
  }
  return { ok: true, data: { id } };
}

/** @returns {Promise<Result<Array<{ id: string, name: string, entity_type: string, description: string | null }>>>} */
export function listEntities() {
  return run(sb.from('knowledge_entities').select('id, name, entity_type, description').order('name').limit(500));
}

/** @returns {Promise<Result<Array<{ source_entity_id: string, target_entity_id: string, relation_type: string }>>>} */
export function listRelations() {
  return run(sb.from('knowledge_relations').select('source_entity_id, target_entity_id, relation_type').limit(2_000));
}

/**
 * @param {{ name: string, entityType: string, description: string }} input
 * @returns {Promise<Result<null>>}
 */
export function insertEntity(input) {
  return run(
    sb.from('knowledge_entities').insert({
      name: input.name,
      entity_type: input.entityType,
      description: input.description,
    }),
  );
}

// ---------------------------------------------------------------------------
// Chat history (only used when canSyncChats() is true)
// ---------------------------------------------------------------------------

/**
 * @param {string} sessionId
 * @param {ChatRow} message
 * @returns {Promise<Result<null>>}
 */
export function insertChatMessage(sessionId, message) {
  return run(
    sb.from('chat_history').insert({
      session_id: sessionId,
      role: message.role,
      content: message.content,
      sources: message.sources,
      metadata: message.metadata,
    }),
  );
}

/**
 * @param {string} sessionId
 * @returns {Promise<Result<ChatRow[]>>}
 */
export function loadChatSession(sessionId) {
  return run(
    sb
      .from('chat_history')
      .select('role, content, sources, metadata, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(LIMITS.localChatMessagesPerSession),
  );
}

/** @returns {Promise<Result<number>>} */
export async function countChatMessages() {
  try {
    const { count, error } = await sb.from('chat_history').select('id', { count: 'exact', head: true });
    if (error) return { ok: false, error: classifyError(error) };
    return { ok: true, data: count ?? 0 };
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
}
