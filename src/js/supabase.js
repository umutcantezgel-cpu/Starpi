// @ts-check
// Supabase data layer: timeouts, error classification, anonymous auth bootstrap and typed queries.
// Every exported query resolves to a Result and never rejects, so callers cannot leak unhandled rejections.
// The Supabase library itself is not part of the first load: connect() (or the first query) loads it
// on demand, while the connection state and its listeners answer synchronously from the start.
import { LIMITS, SUPABASE_ANON_KEY, SUPABASE_URL, TIMEOUTS_MS } from './config.js';
import { withTimeoutSignal } from './signals.js';

/** @typedef {'timeout' | 'network' | 'missing_schema' | 'missing_function' | 'forbidden' | 'not_found' | 'auth_disabled' | 'not_signed_in' | 'unknown'} ErrorKind */
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
 * @property {{ url: string }} [web] set for passages from a web search: the page they rest on
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

/** @typedef {import('@supabase/supabase-js').SupabaseClient} SupabaseClient */
/** @typedef {typeof import('./supabase-lib.js')} SupabaseLib */

/**
 * The library's URL in a build (scripts/build.mjs writes it here: a lazy entry of its own, not
 * precached, kept by the service worker once loaded); unbundled (tests, Node), the module next to
 * this one.
 */
const SUPABASE_LIB_URL = '__STARPI_SUPABASE_LIB_URL__';

/** @type {Promise<SupabaseClient> | null} */
let clientPromise = null;
/** Loads of the library that failed or ran out of time so far. */
let failedLoads = 0;
/** @type {SupabaseLib | null} */
let arrivedLib = null;
/** @type {(lib: SupabaseLib) => void} */
let libArrived = () => {};
/**
 * Resolves with the library once any load of it succeeds, including one that ran out of time
 * earlier: a module import cannot be cancelled, and a slow download that finishes after all is
 * used instead of being fetched again.
 * @type {Promise<SupabaseLib>}
 */
const libArrival = new Promise((resolve) => {
  libArrived = (lib) => {
    arrivedLib ??= lib;
    resolve(lib);
  };
});

/**
 * Rejects with a TimeoutError when `promise` has not settled within `ms`.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, message) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Starts one load of the library, or hands over the one that has already arrived. A load gets the
 * same time as a Supabase request: a stalled network must not keep connect() and every query
 * waiting, it ends in the offline state like a request that times out (classifyError() reads the
 * TimeoutError as 'timeout'). The browser remembers a failed module import for the life of the
 * page, so after a failure or a timeout the next load asks for the same file under another URL.
 * @returns {Promise<SupabaseLib>}
 */
function loadLib() {
  if (arrivedLib) return Promise.resolve(arrivedLib);
  const url = SUPABASE_LIB_URL.startsWith('/') ? SUPABASE_LIB_URL : './supabase-lib.js';
  const specifier = failedLoads > 0 && url.startsWith('/') ? `${url}?attempt=${failedLoads}` : url;
  const load = /** @type {Promise<SupabaseLib>} */ (import(specifier));
  load.then(libArrived, () => {});
  return withDeadline(Promise.race([load, libArrival]), TIMEOUTS_MS.supabase, `The Supabase library did not load within ${TIMEOUTS_MS.supabase} ms`);
}

/**
 * The one Supabase client, created when it is first needed. A failed or timed-out load (the
 * network is gone or stalls, or the file is gone after a deploy) is not kept, so the next attempt
 * loads the library again; classifyError() reads that failure as 'network' or 'timeout'.
 * @returns {Promise<SupabaseClient>}
 */
function client() {
  if (clientPromise) return clientPromise;
  clientPromise = loadLib()
    .then(({ createClient }) =>
      createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storageKey: 'starpi-auth',
        },
        global: { fetch: fetchWithTimeout },
        // postgrest-js would retry timed-out reads three more times (about a minute per request); the app
        // handles failures itself: it marks the connection offline and reconnects in the background.
        db: { retry: false },
      }),
    )
    .catch((err) => {
      clientPromise = null;
      failedLoads += 1;
      throw err;
    });
  return clientPromise;
}

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
  // A library chunk that does not load fails with the browser's own words for a dynamic import.
  if (
    /Failed to fetch|NetworkError|Load failed|fetch failed|ERR_[A-Z_]+|dynamically imported module|Importing a module script failed/i.test(message) ||
    (name === 'TypeError' && /fetch|network/i.test(message))
  ) {
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
 * Builds a request on the client (loading it first) and maps its answer, or any failure on the way,
 * onto a Result.
 * @template T
 * @param {(sb: SupabaseClient) => PromiseLike<{ data: T | null, error: unknown }>} request
 * @returns {Promise<Result<T>>}
 */
async function run(request) {
  let result;
  try {
    const { data, error } = await request(await client());
    result = error ? { ok: /** @type {const} */ (false), error: classifyError(error) } : { ok: /** @type {const} */ (true), data: /** @type {T} */ (data) };
  } catch (err) {
    result = { ok: /** @type {const} */ (false), error: classifyError(err) };
  }
  // A request that cannot reach Supabase switches the app to offline, so later requests answer
  // from the device at once instead of waiting for timeouts; a reconnect is scheduled.
  if (!result.ok && (result.error.kind === 'network' || result.error.kind === 'timeout') && connection.status === 'ready') {
    updateConnection({ status: 'offline' });
    scheduleReconnect();
  }
  return result;
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
/** Offline attempts so far; spaces the automatic retries (30 s, 60 s, … up to 5 min). */
let offlineAttempts = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let retryTimer = null;

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

/**
 * Whether the project allows anonymous sign-ins, from the public auth settings. `null` when the
 * answer says nothing about it or the request fails (the sign-in is then simply attempted); a
 * timeout error when the project does not answer, so the app goes offline at once instead of
 * waiting for a sign-in as well.
 * @returns {Promise<boolean | null | DataError>}
 */
async function anonymousSignInsEnabled() {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_ANON_KEY } });
    if (!res.ok) return null;
    /** @type {{ external?: { anonymous_users?: unknown } } | null} */
    const settings = await res.json().catch(() => null);
    const enabled = settings?.external?.anonymous_users;
    return typeof enabled === 'boolean' ? enabled : null;
  } catch (err) {
    // A timeout means the project does not answer: a sign-in would wait just as long.
    const error = classifyError(err);
    return error.kind === 'timeout' ? error : null;
  }
}

/** @returns {Promise<DataError | null>} */
async function ensureSession() {
  try {
    const sb = await client();
    const { data, error } = await sb.auth.getSession();
    if (error) return classifyError(error);
    if (data.session) return null;
    // Asking first avoids a failed sign-in request (and a console error) on every visit to a
    // project that keeps anonymous sign-ins off.
    const allowed = await anonymousSignInsEnabled();
    if (allowed === false) {
      return { kind: 'auth_disabled', message: 'Anonymous sign-ins are disabled', code: 'anonymous_provider_disabled' };
    }
    if (allowed !== null && allowed !== true) return allowed;
    const signIn = await sb.auth.signInAnonymously();
    return signIn.error ? classifyError(signIn.error) : null;
  } catch (err) {
    return classifyError(err);
  }
}

/**
 * Establishes the anonymous session and detects whether the hardened schema is installed.
 * Safe to call repeatedly; concurrent callers share one attempt. When Supabase is unreachable the
 * attempt is repeated as soon as the browser reports a connection again (the `online` event) and
 * otherwise after a growing delay; connection listeners re-render the state on every attempt.
 */
export function connect() {
  if (!connectPromise) {
    connectPromise = (async () => {
      if (globalThis.navigator?.onLine === false) {
        const error = /** @type {DataError} */ ({ kind: 'network', message: 'The browser is offline' });
        updateConnection({ status: 'offline', signedIn: false, authError: error, hardened: false, probeError: error });
        scheduleReconnect();
        return connection;
      }
      // Without its library Supabase cannot be reached either: the same state as a failed request.
      try {
        await client();
      } catch (err) {
        const error = classifyError(err);
        updateConnection({ status: 'offline', signedIn: false, authError: error, hardened: false, probeError: error });
        scheduleReconnect();
        return connection;
      }
      const authError = await ensureSession();
      const probe = await run((sb) => sb.from('knowledge_documents').select('id, is_public').limit(1));
      const offline = !probe.ok && (probe.error.kind === 'network' || probe.error.kind === 'timeout');
      updateConnection({
        status: offline ? 'offline' : 'ready',
        signedIn: authError === null,
        authError,
        hardened: probe.ok,
        probeError: probe.ok ? null : probe.error,
      });
      if (offline) scheduleReconnect();
      else offlineAttempts = 0;
      return connection;
    })();
  }
  return connectPromise;
}

function scheduleReconnect() {
  connectPromise = null;
  if (retryTimer !== null) return;
  const delay = Math.min(30_000 * 2 ** offlineAttempts, 300_000);
  offlineAttempts += 1;
  const retry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    globalThis.removeEventListener?.('online', retry);
    // The reset above can be undone: an attempt that finds the browser offline schedules this
    // before connect() has stored its promise, which then replaces the null with the settled result.
    connectPromise = null;
    void connect();
  };
  retryTimer = setTimeout(retry, delay);
  globalThis.addEventListener?.('online', retry);
}

/**
 * Deletes synced chat messages of this browser's anonymous user: those of one chat session, or all
 * of them (row level security limits the delete to own rows either way).
 * @param {string | null} sessionId
 * @returns {Promise<Result<null>>}
 */
async function deleteOwnMessages(sessionId) {
  let uid;
  try {
    const { data } = await (await client()).auth.getSession();
    uid = data.session?.user?.id;
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
  if (!uid) return { ok: true, data: null };
  return run((sb) => {
    const own = sb.from('chat_history').delete().eq('owner_id', uid);
    return sessionId ? own.eq('session_id', sessionId) : own;
  });
}

/**
 * Deletes every synced chat message of this browser's anonymous user, in all chat sessions.
 * @returns {Promise<Result<null>>}
 */
export function deleteOwnChats() {
  return deleteOwnMessages(null);
}

/**
 * Deletes the synced messages of one chat session of this browser's anonymous user.
 * @param {string} sessionId
 * @returns {Promise<Result<null>>}
 */
export function deleteChatSession(sessionId) {
  return deleteOwnMessages(sessionId);
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
  return run((sb) =>
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
    run((sb) => sb.from('knowledge_documents').select('id, title, source_type, summary, raw_content, tags, created_at').eq('id', id).maybeSingle()),
    run((sb) => sb.from('knowledge_sections').select('heading, markdown_content').eq('document_id', id).order('section_index', { ascending: true })),
  ]);
  if (!doc.ok) return doc;
  if (!doc.data) return { ok: false, error: { kind: 'not_found', message: 'Document not found or not shared.' } };
  const sectionRows = sections.ok ? /** @type {Array<{ heading: string | null, markdown_content: string | null }>} */ (sections.data ?? []) : [];
  return { ok: true, data: { doc: /** @type {DocumentRow} */ (doc.data), sections: sectionRows } };
}

/**
 * Most recent documents flattened into knowledge hits. Sends no user text to the server.
 * @param {number} limit
 * @returns {Promise<Result<KnowledgeHit[]>>}
 */
export async function recentKnowledge(limit) {
  const res = await run((sb) =>
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
  const res = await run((sb) => sb.rpc('search_knowledge', { query_text: query.slice(0, 1_000), match_count: limit }));
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
 * Ranks the shared library by meaning through the `match_knowledge_vector_384` RPC (optional
 * migration 20261101000000_embedding_384.sql; RLS applies, SECURITY INVOKER). Only the vector goes
 * to the server, never the question text: an on-device "query: " embedding of
 * multilingual-e5-small, the model and revision the library publisher embeds the sections with.
 * Sections without a vector are not ranked. Fails with 'missing_function' without the migration.
 * @param {ArrayLike<number>} vector  384 values, L2-normalised
 * @param {number} [limit]
 * @returns {Promise<Result<KnowledgeHit[]>>}
 */
export async function matchKnowledgeVector(vector, limit = LIMITS.retrievalRows) {
  if (vector.length !== 384) return { ok: false, error: { kind: 'unknown', message: `A query vector has 384 values, not ${vector.length}` } };
  // Six decimals keep the request small and change no ranking.
  const embedding = Array.from(vector, (v) => Math.round(v * 1e6) / 1e6);
  const res = await run((sb) => sb.rpc('match_knowledge_vector_384', { query_embedding: embedding, match_count: Math.min(Math.max(limit, 1), 20) }));
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
      rank: typeof r.similarity === 'number' ? Math.round(r.similarity * 1000) / 1000 : null,
    })),
  };
}

/**
 * Inserts a document and its single Markdown section. Both vector columns stay NULL: the browser
 * never writes embeddings. Only sections published with tools/library-publisher get an
 * embedding_384, so a document saved here is found by full-text search (search_knowledge) and
 * not by match_knowledge_vector_384.
 * @param {{ title: string, sourceType: string, rawContent: string, summary: string, tags: string[], markdown: string, heading: string }} input
 * @returns {Promise<Result<{ id: string }>>}
 */
export async function insertDocument(input) {
  const doc = await run((sb) =>
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
  const section = await run((sb) =>
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
    await run((sb) => sb.from('knowledge_documents').delete().eq('id', id));
    return section;
  }
  return { ok: true, data: { id } };
}

/** @returns {Promise<Result<Array<{ id: string, name: string, entity_type: string, description: string | null }>>>} */
export function listEntities() {
  return run((sb) => sb.from('knowledge_entities').select('id, name, entity_type, description').order('name').limit(500));
}

/** @returns {Promise<Result<Array<{ source_entity_id: string, target_entity_id: string, relation_type: string }>>>} */
export function listRelations() {
  return run((sb) => sb.from('knowledge_relations').select('source_entity_id, target_entity_id, relation_type').limit(2_000));
}

/**
 * @param {{ name: string, entityType: string, description: string }} input
 * @returns {Promise<Result<null>>}
 */
export function insertEntity(input) {
  return run((sb) =>
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
  return run((sb) =>
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
 * The newest messages of a session, oldest first.
 * @param {string} sessionId
 * @returns {Promise<Result<ChatRow[]>>}
 */
export async function loadChatSession(sessionId) {
  /** @type {Result<ChatRow[]>} */
  const res = await run((sb) =>
    sb
      .from('chat_history')
      .select('role, content, sources, metadata, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(LIMITS.localChatMessagesPerSession),
  );
  return res.ok ? { ok: true, data: [...(res.data ?? [])].reverse() } : res;
}

/** @returns {Promise<Result<number>>} */
export async function countChatMessages() {
  try {
    const { count, error } = await (await client()).from('chat_history').select('id', { count: 'exact', head: true });
    if (error) return { ok: false, error: classifyError(error) };
    return { ok: true, data: count ?? 0 };
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
}
