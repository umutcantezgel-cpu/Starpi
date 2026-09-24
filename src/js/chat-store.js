// @ts-check
// Chat persistence. Messages go to Supabase only when an anonymous session exists AND the hardened
// RLS schema is installed (rows are owner-scoped). In local mode, or when either is missing, the
// history stays in this browser's localStorage.
import { formatNumber, setText } from './i18n/index.js';
import { LIMITS, STORAGE_KEYS } from './config.js';
import { byId } from './dom.js';
import { readLocal, readLocalJson, writeLocal, writeLocalJson } from './storage.js';
import { canSyncChats, countChatMessages, deleteOwnChats, getConnection, insertChatMessage, loadChatSession } from './supabase.js';

/** @typedef {import('./supabase.js').ChatRow} ChatRow */

/** @returns {string} */
function newSessionId() {
  return `starpi_${crypto.randomUUID()}`;
}

let sessionId = readLocal(STORAGE_KEYS.sessionId) || '';
if (!/^starpi_[\w-]{6,120}$/.test(sessionId)) {
  sessionId = newSessionId();
  writeLocal(STORAGE_KEYS.sessionId, sessionId);
}

export function currentSessionId() {
  return sessionId;
}

export function startNewSession() {
  sessionId = newSessionId();
  writeLocal(STORAGE_KEYS.sessionId, sessionId);
  return sessionId;
}

/** @typedef {Record<string, { updatedAt: number, messages: ChatRow[] }>} LocalChats */

/** @returns {LocalChats} */
function readLocalChats() {
  const data = readLocalJson(STORAGE_KEYS.localChats, /** @type {LocalChats} */ ({}));
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * @param {string} sid
 * @param {ChatRow} message
 */
function appendLocal(sid, message) {
  const chats = readLocalChats();
  const entry = chats[sid] ?? { updatedAt: 0, messages: [] };
  const stamped = message.created_at ? message : { ...message, created_at: new Date().toISOString() };
  entry.messages = [...entry.messages, stamped].slice(-LIMITS.localChatMessagesPerSession);
  entry.updatedAt = Date.now();
  chats[sid] = entry;
  const newest = Object.entries(chats)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, LIMITS.localChatSessions);
  writeLocalJson(STORAGE_KEYS.localChats, Object.fromEntries(newest));
}

/**
 * @param {string} sid
 * @param {ChatRow} message
 * @param {{ localOnly: boolean }} opts
 */
export async function persistMessage(sid, message, opts) {
  if (!message.content) return;
  if (opts.localOnly || !canSyncChats()) {
    // The flag keeps on-device turns out of the history sent to cloud providers after a reload.
    appendLocal(sid, { ...message, metadata: { ...message.metadata, local_only: opts.localOnly } });
    return;
  }
  const res = await insertChatMessage(sid, message);
  if (!res.ok) {
    console.warn('[starpi] chat sync failed, keeping message locally:', res.error.kind, res.error.message);
    appendLocal(sid, message);
    return;
  }
  void refreshSyncStatus();
}

/**
 * Loads the current session: from Supabase when syncing is possible, otherwise from localStorage.
 * @returns {Promise<ChatRow[]>}
 */
export async function loadCurrentSession() {
  // Rows stored before the local_only flag existed are treated as on-device turns.
  const local = (readLocalChats()[sessionId]?.messages ?? []).map((m) =>
    typeof m.metadata?.local_only === 'boolean' ? m : { ...m, metadata: { ...m.metadata, local_only: true } },
  );
  if (!canSyncChats()) return local;
  const res = await loadChatSession(sessionId);
  if (!res.ok) {
    console.warn('[starpi] could not load chat history:', res.error.kind, res.error.message);
    return local;
  }
  const remote = res.data ?? [];
  if (remote.length === 0) return local;
  if (local.length === 0) return remote;
  return mergeByTime(remote, local);
}

/**
 * Synced and on-device messages in the order they were written. Local rows from before timestamps
 * were stored go last, and are dropped when a synced row has the same text.
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
 * Deletes the chat history: every chat stored in this browser and, when chats are synced, every
 * synced message of this browser's anonymous user. Starts a new chat session.
 * @returns {Promise<boolean>} false when the synced history could not be deleted
 */
export async function deleteChatHistory() {
  writeLocalJson(STORAGE_KEYS.localChats, {});
  startNewSession();
  if (!canSyncChats()) return true;
  const res = await deleteOwnChats();
  void refreshSyncStatus();
  return res.ok;
}

export async function refreshSyncStatus() {
  const el = byId('chatSyncStatusText');
  if (!el) return;
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
