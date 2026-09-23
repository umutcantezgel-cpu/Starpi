// @ts-check
// Chat persistence. Messages go to Supabase only when an anonymous session exists AND the hardened
// RLS schema is installed (rows are owner-scoped). In local mode, or when either is missing, the
// history stays in this browser's localStorage.
import { formatNumber, setText } from './i18n/index.js';
import { LIMITS, STORAGE_KEYS } from './config.js';
import { byId } from './dom.js';
import { readLocal, readLocalJson, writeLocal, writeLocalJson } from './storage.js';
import { canSyncChats, countChatMessages, getConnection, insertChatMessage, loadChatSession } from './supabase.js';

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
  entry.messages = [...entry.messages, message].slice(-LIMITS.localChatMessagesPerSession);
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
    appendLocal(sid, message);
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
  const local = readLocalChats()[sessionId]?.messages ?? [];
  if (!canSyncChats()) return local;
  const res = await loadChatSession(sessionId);
  if (!res.ok) {
    console.warn('[starpi] could not load chat history:', res.error.kind, res.error.message);
    return local;
  }
  const remote = res.data ?? [];
  if (remote.length === 0) return local;
  if (local.length === 0) return remote;
  // Messages written while offline/local-only live in localStorage; show them after the synced ones.
  return [...remote, ...local.filter((m) => !remote.some((r) => r.role === m.role && r.content === m.content))];
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
