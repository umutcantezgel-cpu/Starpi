// Test doubles for the chat sync: an in-memory server with the semantics of the chat_sync tables
// (one key envelope per account, rows written against the revision they build on), and a "browser"
// with its own app database, conversation store and sync engine.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createChatStore } from '../../src/js/chat/store.js';
import { openAppDb } from '../../src/js/store/schema.js';
import { createChatSync, settingsStateStore } from '../../src/js/sync/sync.js';

/** @typedef {import('../../src/js/sync/sync.js').SyncRemote} SyncRemote */
/** @typedef {import('../../src/js/sync/crypto.js').KeyEnvelope} KeyEnvelope */

/** A copy of a value as it would arrive over the network. */
const wire = (value) => JSON.parse(JSON.stringify(value));

export function createFakeServer() {
  /** @type {Map<string, { envelope: KeyEnvelope | null, rows: Map<string, { rev: number, iv: string, ciphertext: string }> }>} */
  const accounts = new Map();
  /** Everything a browser sent, in order. */
  /** @type {Array<{ call: string, args: unknown[] }>} */
  const sent = [];
  const server = {
    accounts,
    sent,
    offline: false,
    failRowsDelete: false,
    /** @param {string} userId */
    account(userId) {
      if (!accounts.has(userId)) accounts.set(userId, { envelope: null, rows: new Map() });
      return /** @type {NonNullable<ReturnType<typeof accounts.get>>} */ (accounts.get(userId));
    },
    /**
     * The remote of a browser signed in as `who().userId`.
     * @param {() => { userId: string | null }} who
     * @returns {SyncRemote}
     */
    remoteFor(who) {
      const down = () => ({ ok: /** @type {const} */ (false), error: { kind: /** @type {const} */ ('network'), message: 'Failed to fetch' } });
      /**
       * @template T
       * @param {string} call
       * @param {unknown[]} args
       * @param {(acct: ReturnType<typeof server.account>) => T} fn
       */
      const handle = async (call, args, fn) => {
        await Promise.resolve();
        if (server.offline) return down();
        sent.push({ call, args: wire(args) });
        const { userId } = who();
        if (!userId) return { ok: /** @type {const} */ (false), error: { kind: /** @type {const} */ ('not_signed_in'), message: 'No session' } };
        return { ok: /** @type {const} */ (true), data: fn(server.account(userId)) };
      };
      return {
        account: async () => {
          if (server.offline) return down();
          return { ok: true, data: { userId: who().userId, email: null, anonymous: true } };
        },
        getKeyEnvelope: () => handle('getKeyEnvelope', [], (a) => (a.envelope ? wire(a.envelope) : null)),
        putKeyEnvelope: (envelope) =>
          handle('putKeyEnvelope', [envelope], (a) => {
            if (a.envelope) return 'exists';
            a.envelope = wire(envelope);
            return 'created';
          }),
        listRevisions: () => handle('listRevisions', [], (a) => [...a.rows].map(([rowId, r]) => ({ rowId, rev: r.rev }))),
        fetchRows: (rowIds) => handle('fetchRows', [rowIds], (a) => rowIds.filter((id) => a.rows.has(id)).map((id) => ({ rowId: id, ...wire(a.rows.get(id)) }))),
        writeRow: (row, baseRev) =>
          handle('writeRow', [row, baseRev], (a) => {
            const current = a.rows.get(row.rowId);
            if ((current?.rev ?? 0) !== baseRev || row.rev <= baseRev) return 'conflict';
            a.rows.set(row.rowId, { rev: row.rev, iv: row.iv, ciphertext: row.ciphertext });
            return 'written';
          }),
        // The key goes first; with `failRowsDelete` the rows then fail to delete (key already gone).
        deleteAll: async () => {
          const res = await handle('deleteAll', [], (a) => {
            a.envelope = null;
            if (server.failRowsDelete) return 'rows_failed';
            a.rows.clear();
            return null;
          });
          return res.ok && res.data === 'rows_failed' ? down() : res;
        },
      };
    },
  };
  return server;
}

let seq = 0;

/**
 * A browser: its own database, conversation store and sync engine, signed in as `user.userId`.
 * @param {ReturnType<typeof createFakeServer>} server
 * @param {{ userId: string | null }} user
 * @param {{ debounceMs?: number }} [opts]
 */
export function createBrowser(server, user, opts = {}) {
  const name = `sync-browser-${(seq += 1)}`;
  const factory = new IDBFactory();
  /** @type {Promise<import('../../src/js/store/idb.js').StoreDb> | null} */
  let db = null;
  const open = () => (db ??= openAppDb({ name, factory }));
  let clock = Date.parse('2026-10-18T09:00:00Z') + seq * 60_000;
  const store = createChatStore({ open, now: () => (clock += 1) });
  const sync = createChatSync({
    remote: server.remoteFor(() => user),
    store: async () => store,
    state: settingsStateStore(open),
    now: () => clock,
    debounceMs: opts.debounceMs ?? 5,
  });
  return { user, open, store, sync, tick: (/** @type {number} */ ms) => (clock += ms) };
}

/** @param {string} text */
export const text = (text) => [{ type: 'text', text }];
