// @ts-check
// Chat persistence for the chat view, as a compatibility layer over the conversation store
// (chat/store.js). The chat view thinks in sessions and flat messages: a session id is a
// conversation id, and every stored message continues that conversation's active thread. The store
// loads on first use, together with the one-time move of the chats 2.x kept in localStorage.
//
// Sync is off in this version: CHAT_SYNC_ENABLED stays false until end-to-end encrypted sync
// replaces the plaintext chat table. The code behind the flag is kept for that work. Deleting still
// removes the messages an earlier version synced.
import { formatNumber, setText } from './i18n/index.js';
import { STORAGE_KEYS } from './config.js';
import { byId } from './dom.js';
import { readLocal, writeLocal } from './storage.js';
import { canSyncChats, countChatMessages, deleteChatSession, deleteOwnChats, getConnection, insertChatMessage, loadChatSession } from './supabase.js';

/** @typedef {import('./supabase.js').ChatRow} ChatRow */
/** @typedef {import('./chat/store.js').ChatStore} ChatStore */
/** @typedef {import('./store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('./chat/store.js').NodeInput} NodeInput */

/** Plaintext chat sync. Stays false until end-to-end encrypted sync lands. */
export const CHAT_SYNC_ENABLED = false;

const SESSION_ID = /^starpi_[\w-]{6,120}$/;

/** @returns {string} */
function newSessionId() {
  return `starpi_${crypto.randomUUID()}`;
}

let sessionId = readLocal(STORAGE_KEYS.sessionId) || '';
if (!SESSION_ID.test(sessionId)) {
  sessionId = newSessionId();
  writeLocal(STORAGE_KEYS.sessionId, sessionId);
}

/** @type {Set<(sid: string) => void>} */
const sessionListeners = new Set();

/** @param {string} sid */
function setSession(sid) {
  sessionId = sid;
  writeLocal(STORAGE_KEYS.sessionId, sid);
  for (const listener of [...sessionListeners]) {
    try {
      listener(sid);
    } catch (err) {
      console.error('[starpi] a chat session listener failed', err);
    }
  }
}

export function currentSessionId() {
  return sessionId;
}

export function startNewSession() {
  setSession(newSessionId());
  return sessionId;
}

/**
 * Makes a stored conversation the current chat session.
 * @param {string} sid
 */
export function switchSession(sid) {
  if (!SESSION_ID.test(sid)) throw new TypeError('Not a chat session id');
  if (sid !== sessionId) setSession(sid);
  return sessionId;
}

/**
 * Calls the listener whenever the current chat session changes (new chat, another conversation).
 * @param {(sid: string) => void} listener
 * @returns {() => void} stops listening
 */
export function onSessionChange(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** @type {Promise<ChatStore> | null} */
let storeReady = null;

/**
 * The conversation store, loaded on first use, after the one-time migrations.
 * @returns {Promise<ChatStore>}
 */
export function chatData() {
  storeReady ??= import('./chat/store.js')
    .then((m) => m.openChatStore())
    .catch((err) => {
      storeReady = null;
      throw err;
    });
  return storeReady;
}

/** Message writes still under way, per session; a delete waits for them. */
/** @type {Map<string, Set<Promise<void>>>} */
const pendingWrites = new Map();
/** Sessions deleted in this tab: a write that ends later must not store them again. */
const deletedSessions = new Set();

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {Record<string, unknown>} meta @returns {'free' | 'grounded' | null} */
function chatModeOf(meta) {
  return meta.chat_mode === 'free' || meta.chat_mode === 'grounded' ? meta.chat_mode : null;
}

/**
 * A chat row as a message of the tree. Its metadata (engine, mode, reasoning trace, duration) is
 * kept as the node's meta, as the 2.x migration does.
 * @param {ChatRow} row
 * @param {boolean} localOnly
 * @returns {Omit<NodeInput, 'parentId'>}
 */
export function rowToNode(row, localOnly) {
  /** @type {Record<string, unknown>} */
  const meta = { ...(isRecord(row.metadata) ? row.metadata : {}) };
  // The flag lives on the node itself.
  delete meta.local_only;
  const ms = row.created_at ? Date.parse(row.created_at) : Number.NaN;
  return {
    role: row.role,
    parts: [{ type: 'text', text: row.content }],
    model: typeof meta.model === 'string' ? meta.model : null,
    label: row.role === 'assistant' ? chatModeOf(meta) : null,
    sources: Array.isArray(row.sources) ? row.sources : [],
    localOnly,
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(Number.isFinite(ms) ? { createdAt: ms } : {}),
  };
}

/**
 * A stored message as the chat view's row.
 * @param {NodeRecord} node
 * @param {(node: NodeRecord) => string} textOf
 * @returns {ChatRow}
 */
export function nodeToRow(node, textOf) {
  /** @type {Record<string, unknown>} */
  const meta = { ...node.meta };
  if (node.model && typeof meta.model !== 'string') meta.model = node.model;
  if (!chatModeOf(meta) && (node.label === 'free' || node.label === 'grounded')) meta.chat_mode = node.label;
  return {
    role: node.role === 'user' ? 'user' : 'assistant',
    content: textOf(node),
    sources: Array.isArray(node.sources) ? node.sources : [],
    metadata: { ...meta, local_only: node.localOnly === true },
    created_at: new Date(node.createdAt).toISOString(),
  };
}

/**
 * Stores a message at the end of its session's thread. A delete of its session waits for it.
 * Never rejects: a failed write is logged.
 * @param {string} sid
 * @param {ChatRow} message
 * @param {{ localOnly: boolean }} opts
 * @returns {Promise<void>}
 */
export function persistMessage(sid, message, opts) {
  const write = writeMessage(sid, message, opts);
  const writes = pendingWrites.get(sid) ?? new Set();
  pendingWrites.set(sid, writes);
  writes.add(write);
  return write.finally(() => {
    writes.delete(write);
    if (writes.size === 0 && pendingWrites.get(sid) === writes) pendingWrites.delete(sid);
  });
}

/**
 * Waits for the message writes of a session that are still under way.
 * @param {string} sid
 */
export async function waitForWrites(sid) {
  await Promise.allSettled([...(pendingWrites.get(sid) ?? [])]);
}

/**
 * Waits for the writes of the given sessions (all when none are given) and marks those sessions as
 * deleted, so a write that is still sending cannot bring a deleted chat back.
 * @param {string[]} [sids]
 */
async function settleWrites(sids) {
  const keys = sids ?? [...pendingWrites.keys()];
  for (const sid of keys) deletedSessions.add(sid);
  await Promise.allSettled(keys.flatMap((sid) => [...(pendingWrites.get(sid) ?? [])]));
}

/**
 * @param {string} sid
 * @param {ChatRow} message
 * @param {{ localOnly: boolean }} opts
 */
async function writeMessage(sid, message, opts) {
  if (!message.content || deletedSessions.has(sid)) return;
  try {
    const store = await chatData();
    if (deletedSessions.has(sid)) return;
    const node = rowToNode(message, opts.localOnly);
    await store.appendToActive(sid, node, { create: { mode: chatModeOf(node.meta ?? {}) ?? 'grounded' } });
  } catch (err) {
    console.warn('[starpi] a chat message could not be stored on this device', err);
    return;
  }
  // Off until end-to-end encrypted sync (CHAT_SYNC_ENABLED). On-device turns never sync.
  if (!CHAT_SYNC_ENABLED || opts.localOnly || !canSyncChats()) return;
  const res = await insertChatMessage(sid, message);
  if (!res.ok) console.warn('[starpi] chat sync failed, the message stays on this device:', res.error.kind, res.error.message);
  else void refreshSyncStatus();
}

/**
 * Copies a synced session into the store (only while sync is enabled).
 * @param {ChatStore} store
 * @param {string} sid
 */
async function restoreSynced(store, sid) {
  const res = await loadChatSession(sid);
  if (!res.ok) {
    console.warn('[starpi] could not load the synced chat:', res.error.kind, res.error.message);
    return null;
  }
  for (const row of res.data ?? []) await store.appendToActive(sid, rowToNode(row, false), { create: { mode: 'grounded' } });
  return store.loadThread(sid);
}

/**
 * Loads the current session: the active thread of its conversation.
 * @returns {Promise<ChatRow[]>}
 */
export async function loadCurrentSession() {
  const sid = sessionId;
  try {
    const store = await chatData();
    let thread = await store.loadThread(sid);
    if (!thread && CHAT_SYNC_ENABLED && canSyncChats()) thread = await restoreSynced(store, sid);
    if (!thread) return [];
    const { nodeText } = await import('./chat/tree.js');
    return thread.path.filter((n) => n.role === 'user' || n.role === 'assistant').map((n) => nodeToRow(n, nodeText));
  } catch (err) {
    console.warn('[starpi] could not load the chat history', err);
    return [];
  }
}

/**
 * Synced and on-device messages in the order they were written. Local rows from before timestamps
 * were stored go last, and are dropped when a synced row has the same text. (Kept for the sync.)
 * @param {ChatRow[]} remote
 * @param {ChatRow[]} local
 * @returns {ChatRow[]}
 */
export function mergeByTime(remote, local) {
  const at = (/** @type {ChatRow} */ m) => {
    const ms = m.created_at ? Date.parse(m.created_at) : Number.NaN;
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  const legacyDuplicate = (/** @type {ChatRow} */ m) => !m.created_at && remote.some((r) => r.role === m.role && r.content === m.content);
  // Array.prototype.sort is stable, so rows with equal or missing times keep their order.
  return [...remote, ...local.filter((m) => !legacyDuplicate(m))].sort((a, b) => at(a) - at(b));
}

/**
 * Removes what an earlier version synced, when that can have happened.
 * @param {() => ReturnType<typeof deleteOwnChats>} remove
 * @returns {Promise<boolean>}
 */
async function deleteSynced(remove) {
  // Nothing was synced from this browser when the connection is up and chats cannot sync (no
  // session, or an older schema). Offline or still connecting, the delete is attempted and reports
  // a failure instead of claiming success.
  if (getConnection().status === 'ready' && !canSyncChats()) return true;
  const res = await remove();
  void refreshSyncStatus();
  return res.ok;
}

/**
 * Deletes the chat history: every conversation on this device and every message an earlier
 * version synced for this browser's anonymous user. Starts a new chat session.
 * @returns {Promise<boolean>} false when something could not be deleted
 */
export async function deleteChatHistory() {
  // A message still being stored would otherwise be stored after the delete.
  await settleWrites();
  let local = true;
  try {
    await (await chatData()).clearConversations();
  } catch (err) {
    console.warn('[starpi] the chats on this device could not be deleted', err);
    local = false;
  }
  startNewSession();
  return (await deleteSynced(() => deleteOwnChats())) && local;
}

/**
 * Deletes one chat: its conversation on this device and the messages an earlier version synced.
 * Deleting the current chat starts a new chat session.
 * @param {string} sid
 * @returns {Promise<boolean>} false when something could not be deleted
 */
export async function deleteSession(sid) {
  await settleWrites([sid]);
  let local = true;
  try {
    await (await chatData()).deleteConversation(sid);
  } catch (err) {
    console.warn('[starpi] the chat could not be deleted on this device', err);
    local = false;
  }
  if (sid === sessionId) startNewSession();
  return (await deleteSynced(() => deleteChatSession(sid))) && local;
}

export async function refreshSyncStatus() {
  const el = byId('chatSyncStatusText');
  if (!el) return;
  if (!CHAT_SYNC_ENABLED) {
    setText(el, 'chat.list.device_only');
    return;
  }
  const c = getConnection();
  if (c.status !== 'ready') {
    setText(el, 'sync.device_offline');
    return;
  }
  if (!canSyncChats()) {
    setText(el, c.hardened ? 'sync.device_no_session' : 'sync.device_migration');
    return;
  }
  const res = await countChatMessages();
  if (res.ok) setText(el, 'sync.synced_count', { n: formatNumber(res.data ?? 0) });
  else setText(el, 'sync.synced');
}
