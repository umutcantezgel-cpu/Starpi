// @ts-check
// The app's chat sync: the engine (sync.js) on the Supabase data layer, the conversation store and
// the app database. features/sync.js starts it at boot. While sync is on, it syncs once the
// connection is ready, a few seconds after a local change, every two minutes while the page is
// visible, when the browser is online again and when the tab comes back into view.
import { bindChatSync, chatData, refreshSyncStatus } from '../chat-store.js';
import { formatNumber } from '../i18n/index.js';
import { appDb } from '../store/schema.js';
import { deleteSyncData, fetchSyncRows, getConnection, getSyncKeyEnvelope, listSyncRevisions, onConnectionChange, putSyncKeyEnvelope, syncAccount, writeSyncRow } from '../supabase.js';
import { createChatSync, settingsStateStore } from './sync.js';

/** @typedef {import('./sync.js').ChatSync} ChatSync */
/** @typedef {import('./sync.js').SyncStatus} SyncStatus */

const INTERVAL_MS = 120_000;

/** @type {ChatSync | null} */
let shared = null;

/** The page's sync engine. */
export function chatSync() {
  shared ??= createChatSync({
    remote: {
      account: syncAccount,
      getKeyEnvelope: getSyncKeyEnvelope,
      putKeyEnvelope: putSyncKeyEnvelope,
      listRevisions: listSyncRevisions,
      fetchRows: fetchSyncRows,
      writeRow: writeSyncRow,
      deleteAll: deleteSyncData,
    },
    store: chatData,
    state: settingsStateStore(appDb),
    locks: globalThis.navigator?.locks ?? null,
  });
  return shared;
}

/**
 * The sync line in Settings › Knowledge base, or null while sync is off.
 * @param {SyncStatus} s
 * @returns {{ key: string, params?: Record<string, string> } | null}
 */
export function statusLine(s) {
  if (s.phase === 'off' || s.phase === 'unavailable') return null;
  if (s.phase !== 'on') return { key: 'sync.line.attention' };
  if (s.error === 'network' || s.error === 'timeout') return { key: 'sync.line.waiting' };
  return { key: 'sync.line.on', params: { n: formatNumber(s.conversations) } };
}

/** @type {Promise<ChatSync> | null} */
let starting = null;

/**
 * Starts the page's sync (once) and binds it to the chat view's delete paths and sync line.
 * @returns {Promise<ChatSync>}
 */
export function startChatSync() {
  starting ??= (async () => {
    const sync = chatSync();
    await sync.ready();
    bindChatSync({
      statusLine: () => statusLine(sync.status()),
      // After a delete: write the deletion now when sync is on (false when that failed; it is
      // written with a later sync then).
      flush: async () => (sync.status().phase === 'on' ? (await sync.syncNow()) !== null : true),
    });
    // The store is followed only while sync is on, so a browser that does not sync loads nothing.
    sync.onStatus((s) => {
      if (s.phase === 'on') void sync.start();
      void refreshSyncStatus();
    });
    if (sync.status().phase === 'on') await sync.start();
    const kick = () => {
      if (sync.status().phase === 'on' && getConnection().status === 'ready') void sync.syncNow({ ifAvailable: true });
    };
    onConnectionChange((c) => {
      if (c.status === 'ready') kick();
    });
    globalThis.addEventListener?.('online', kick);
    globalThis.document?.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick();
    });
    setInterval(() => {
      if (globalThis.document?.visibilityState !== 'hidden') kick();
    }, INTERVAL_MS);
    kick();
    return sync;
  })();
  return starting;
}
