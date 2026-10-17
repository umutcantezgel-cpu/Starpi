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

/**
 * What the conversation list needs from the chat view; chat.js binds it at start-up, so the list
 * never imports the chat view itself.
 * @typedef {object} ChatView
 * @property {(id: string) => Promise<void>} open  shows a stored conversation
 * @property {() => boolean} isBusy  an answer is being written
 * @property {() => void} reset  clears the chat on screen
 */

/** @type {ChatView | null} */
let chatView = null;

/** @param {ChatView} view */
export function bindChatView(view) {
  chatView = view;
}

/** @returns {ChatView | null} */
export function getChatView() {
  return chatView;
}

/** @type {Promise<typeof import('./chat/store.js')> | null} */
let storeModule = null;

/** The conversation store module, loaded on first use (after the first paint). */
function loadStoreModule() {
  storeModule ??= import('./chat/store.js').catch((err) => {
    storeModule = null;
    throw err;
  });
  return storeModule;
}

/**
 * The conversation store, once the one-time migrations ran.
 * @returns {Promise<ChatStore>}
 */
export async function chatData() {
  return (await loadStoreModule()).openChatStore();
}

/** Message writes still under way, per session; a delete waits for them. */
/** @type {Map<string, Set<Promise<void>>>} */
const pendingWrites = new Map();
/** Sessions deleted in this tab: a write that ends later must not store them again. */
const deletedSessions = new Set();

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
    const m = await loadStoreModule();
    const store = await m.openChatStore();
    if (deletedSessions.has(sid)) return;
    const mode = message.metadata?.chat_mode === 'free' ? 'free' : 'grounded';
    await store.appendToActive(sid, m.rowToNode(message, opts.localOnly), { create: { mode } });
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
 * @param {typeof import('./chat/store.js')} m
 * @param {ChatStore} store
 * @param {string} sid
 */
async function restoreSynced(m, store, sid) {
  const res = await loadChatSession(sid);
  if (!res.ok) {
    console.warn('[starpi] could not load the synced chat:', res.error.kind, res.error.message);
    return null;
  }
  for (const row of res.data ?? []) await store.appendToActive(sid, m.rowToNode(row, false), { create: { mode: 'grounded' } });
  return store.loadThread(sid);
}

/**
 * Loads the current session: the active thread of its conversation.
 * @returns {Promise<ChatRow[]>}
 */
export async function loadCurrentSession() {
  const sid = sessionId;
  try {
    const m = await loadStoreModule();
    const store = await m.openChatStore();
    let thread = await store.loadThread(sid);
    if (!thread && CHAT_SYNC_ENABLED && canSyncChats()) thread = await restoreSynced(m, store, sid);
    if (!thread) return [];
    return thread.path.filter((n) => n.role === 'user' || n.role === 'assistant').map(m.nodeToRow);
  } catch (err) {
    console.warn('[starpi] could not load the chat history', err);
    return [];
  }
}

/**
 * A session's stored conversation once its messages still being written are stored; null when
 * nothing is stored for it or the store cannot be read.
 * @param {string} sid
 * @returns {Promise<import('./chat/store.js').Thread | null>}
 */
export async function loadSessionThread(sid) {
  await waitForWrites(sid);
  try {
    return await (await chatData()).loadThread(sid);
  } catch (err) {
    console.warn('[starpi] could not read the stored chat', err);
    return null;
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
