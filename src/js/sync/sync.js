// @ts-check
// End-to-end encrypted conversation sync: the engine. It keeps the conversations of this browser
// and the user's encrypted rows on the server (chat_sync) in step, one conversation per row.
//
// - Turning sync on takes a passphrase. Without a key envelope on the server it makes a new sync
//   key and stores the envelope; with one (sync is on in another browser of the same account) it
//   opens it, which is how a second browser restores the conversations. crypto.js has the details.
// - The opened keys (non-extractable CryptoKeys), the account and the revision each row had when
//   this device last wrote or read it are the sync state, kept in the app database.
// - A sync reads the revisions of all rows (ids and numbers only), fetches and merges the rows that
//   are newer than the state knows (payload.js), and writes every conversation that changed here as
//   the next revision. A write names the revision it builds on and fails when the row has moved on
//   meanwhile; the newer row is then merged in and written again. Conversations deleted here are
//   written as deletion markers, so other browsers delete them too.
// - Deletions against changes: new messages win over a deletion (nothing written is lost), and a
//   deletion wins over changed conversation fields (a pin, a title, another branch), whichever came
//   first. "New" is measured against the messages of the revision this device last synced, which
//   the state keeps per row.
// - Turning sync off with deletion removes the key envelope first (other browsers stop), then the
//   rows. When the rows could not be deleted, the state remembers that and every later sync
//   retries the deletion instead of syncing, until it is done.
// - Only ciphertext, opaque row ids and revision numbers reach the server. Turns marked localOnly,
//   provider keys and signing keys never enter a record (payload.js builds records from an
//   allowlist and reads nothing else).
// - Syncs never overlap: within a tab they queue, across tabs they share a Web Lock.
//
// The engine gets its server, store, state storage and clock from the caller (service.js wires the
// app's; tests pass fakes).
import { createSyncKey, digestText, openRecord, openSyncKey, passphraseLongEnough, rowIdFor, sealRecord, SYNC_KDF_ITERATIONS, SyncCryptoError } from './crypto.js';
import { applyPayload, buildPayload, canonicalJson, deletedPayload, isSyncRecord, mergePayloads, metaOf } from './payload.js';

/** @typedef {import('./crypto.js').KeyEnvelope} KeyEnvelope */
/** @typedef {import('./crypto.js').SyncKeys} SyncKeys */
/** @typedef {import('./payload.js').SyncRecord} SyncRecord */
/** @typedef {import('./payload.js').ConversationPayload} ConversationPayload */
/** @typedef {import('./payload.js').SyncedMeta} SyncedMeta */
/** @typedef {import('../chat/store.js').ChatStore} ChatStore */
/** @typedef {import('../chat/store.js').ChatChange} ChatChange */
/** @typedef {import('../supabase.js').DataError} DataError */
/**
 * @template T
 * @typedef {import('../supabase.js').Result<T>} Result
 */

/**
 * @typedef {object} SyncAccount
 * @property {string | null} userId  null without a session
 * @property {string | null} email   set once the account has a confirmed email address
 * @property {boolean} anonymous
 */

/** @typedef {{ rowId: string, rev: number }} RowRevision */
/** @typedef {{ rowId: string, rev: number, iv: string, ciphertext: string }} RemoteRow */

/**
 * The server side: supabase.js in the app, a fake in tests. Every call resolves to a Result.
 * @typedef {object} SyncRemote
 * @property {() => Promise<Result<SyncAccount>>} account
 * @property {() => Promise<Result<KeyEnvelope | null>>} getKeyEnvelope
 * @property {(envelope: KeyEnvelope) => Promise<Result<'created' | 'exists'>>} putKeyEnvelope
 * @property {() => Promise<Result<RowRevision[]>>} listRevisions
 * @property {(rowIds: string[]) => Promise<Result<RemoteRow[]>>} fetchRows
 * @property {(row: RemoteRow, baseRev: number) => Promise<Result<'written' | 'conflict'>>} writeRow  baseRev 0 inserts
 * @property {() => Promise<Result<null>>} deleteAll  every row and the key envelope of the account
 */

/**
 * What this device knows about one row.
 * @typedef {object} RowState
 * @property {string} convId
 * @property {number} rev  the revision this device last wrote or applied
 * @property {string} hash  of the record at that revision ('unreadable' when it did not open)
 * @property {SyncedMeta | null} base  conversation fields at that revision (null for a deletion)
 * @property {string[]} [nodes]  ids of the messages at that revision (empty for a deletion)
 * @property {boolean} deleted  a deletion marker (or a row that did not open)
 */

/**
 * @typedef {object} SyncState
 * @property {1} v
 * @property {string} userId
 * @property {string} keyId
 * @property {CryptoKey} enc
 * @property {CryptoKey} ids
 * @property {Record<string, RowState>} rows  by row id
 * @property {number | null} lastSyncAt
 * @property {true} [purge]  turning off with deletion has not finished: the rows are still to be deleted
 */

/**
 * Where the sync state lives (the app database's settings store in the app).
 * @typedef {object} StateStore
 * @property {() => Promise<SyncState | null>} load
 * @property {(state: SyncState) => Promise<void>} save
 * @property {() => Promise<void>} clear
 * @property {() => Promise<boolean>} persistent  whether the state survives a reload
 */

/**
 * off: not set up in this browser; on: set up (see error and lastSyncAt); unavailable: this
 * browser cannot keep the sync key; remote_off: the account's synced data and key are gone (sync
 * was turned off in another browser); rekeyed: sync was set up again elsewhere with another
 * passphrase; other_account: this browser is now signed in to another account.
 * @typedef {'off' | 'on' | 'unavailable' | 'remote_off' | 'rekeyed' | 'other_account'} SyncPhase
 */

/**
 * @typedef {object} SyncStatus
 * @property {SyncPhase} phase
 * @property {boolean} busy  a sync is running
 * @property {number} conversations  synced conversations (deletion markers not counted)
 * @property {number | null} lastSyncAt
 * @property {number} skipped  conversations left out: too large, or rows that do not open
 * @property {string | null} error  kind of the last failure (a DataError kind)
 * @property {boolean} purging  turning off with deletion has not finished; syncs retry it
 */

/** @typedef {{ applied: number, written: number, skipped: number }} SyncReport */

/**
 * too_short: passphrase below the minimum; wrong_passphrase: it does not open the account's key;
 * no_session: no signed-in session; offline: Supabase cannot be reached; missing_schema: the
 * database lacks the sync tables; unavailable: this browser cannot keep the key; error: anything else.
 * @typedef {'too_short' | 'wrong_passphrase' | 'no_session' | 'offline' | 'missing_schema' | 'unavailable' | 'error'} EnableFailure
 */

/** @typedef {{ ok: true, joined: boolean, report: SyncReport | null } | { ok: false, reason: EnableFailure }} EnableResult */

/**
 * @typedef {object} Timers
 * @property {(fn: () => void, ms: number) => unknown} set
 * @property {(handle: unknown) => void} clear
 */

/**
 * @typedef {object} ChatSyncOptions
 * @property {SyncRemote} remote
 * @property {() => Promise<ChatStore>} store
 * @property {StateStore} state
 * @property {Crypto} [crypto]
 * @property {() => number} [now]
 * @property {number} [iterations]  PBKDF2 iterations of a new key (default 600 000)
 * @property {Pick<LockManager, 'request'> | null} [locks]  shares one sync at a time across tabs
 * @property {Timers} [timers]
 * @property {number} [debounceMs]  wait after a local change before syncing (default 2 s)
 */

const LOCK_NAME = 'starpi-chat-sync';
const FETCH_CHUNK = 40;
const MAX_ATTEMPTS = 4;
const UNREADABLE = 'unreadable';

/** A failed server call, carried out of the sync as an exception. */
class RemoteFailure extends Error {
  /** @param {DataError} error */
  constructor(error) {
    super(error.message);
    this.name = 'RemoteFailure';
    this.error = error;
  }
}

/**
 * @template T
 * @param {Result<T>} res
 * @returns {T}
 */
function must(res) {
  if (!res.ok) throw new RemoteFailure(res.error);
  return res.data;
}

/**
 * @param {DataError} error
 * @returns {EnableFailure}
 */
function failureOf(error) {
  if (error.kind === 'network' || error.kind === 'timeout') return 'offline';
  if (error.kind === 'not_signed_in' || error.kind === 'forbidden' || error.kind === 'auth_disabled') return 'no_session';
  if (error.kind === 'missing_schema') return 'missing_schema';
  return 'error';
}

/** @param {SyncState} st */
const countRows = (st) => Object.values(st.rows).filter((r) => !r.deleted).length;
/** @param {SyncState} st */
const countUnreadable = (st) => Object.values(st.rows).filter((r) => r.hash === UNREADABLE).length;

/**
 * @param {unknown} value
 * @returns {value is SyncState}
 */
export function isSyncState(value) {
  if (!value || typeof value !== 'object') return false;
  const s = /** @type {Record<string, unknown>} */ (value);
  return s.v === 1 && typeof s.userId === 'string' && typeof s.keyId === 'string' && typeof CryptoKey === 'function' && s.enc instanceof CryptoKey && s.ids instanceof CryptoKey && Boolean(s.rows) && typeof s.rows === 'object';
}

/**
 * The sync state in the app database's `settings` store (one record; the CryptoKeys are stored as
 * they are, which keeps them non-extractable).
 * @param {() => Promise<import('../store/idb.js').StoreDb>} getDb
 * @returns {StateStore}
 */
export function settingsStateStore(getDb) {
  const KEY = 'chatSync';
  return {
    async load() {
      const record = await (await getDb()).get('settings', KEY);
      return isSyncState(record?.value) ? record.value : null;
    },
    async save(state) {
      await (await getDb()).put('settings', { key: KEY, value: state, updatedAt: Date.now() });
    },
    async clear() {
      await (await getDb()).delete('settings', KEY);
    },
    async persistent() {
      try {
        return (await getDb()).persistent === true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * @param {ChatSyncOptions} options
 */
export function createChatSync(options) {
  const { remote } = options;
  const now = options.now ?? Date.now;
  const cryptoOpts = { crypto: options.crypto };
  const iterations = options.iterations ?? SYNC_KDF_ITERATIONS;
  const debounceMs = options.debounceMs ?? 2_000;
  /** @type {Timers} */
  const timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (h)) };

  /** @type {SyncStatus} */
  let status = { phase: 'off', busy: false, conversations: 0, lastSyncAt: null, skipped: 0, error: null, purging: false };
  /** @type {Set<(status: SyncStatus) => void>} */
  const listeners = new Set();
  /** @type {Promise<void> | null} */
  let loading = null;
  /** Conversations changed since the last sync; null: check every conversation. */
  /** @type {Set<string> | null} */
  let dirty = null;
  let queue = Promise.resolve();
  /** @type {unknown} */
  let timer = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  let started = false;

  /** @param {Partial<SyncStatus>} patch */
  function setStatus(patch) {
    status = { ...status, ...patch };
    for (const fn of [...listeners]) {
      try {
        fn(status);
      } catch (err) {
        console.error('[starpi] a sync status listener failed', err);
      }
    }
  }

  /** Reads the state once: on, off or unavailable. */
  function ready() {
    loading ??= (async () => {
      if (!(await options.state.persistent())) {
        setStatus({ phase: 'unavailable' });
        return;
      }
      const st = await options.state.load().catch(() => null);
      if (st) setStatus({ phase: 'on', conversations: countRows(st), lastSyncAt: st.lastSyncAt, skipped: countUnreadable(st), purging: st.purge === true });
    })();
    return loading;
  }

  /**
   * Runs `fn` when no other sync runs, in this tab or (with Web Locks) in another one. With
   * `ifAvailable`, skips instead of waiting when another tab holds the lock.
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{ ifAvailable?: boolean }} [opts]
   * @returns {Promise<T | null>}
   */
  function exclusive(fn, opts = {}) {
    const run = queue.then(() => {
      const locks = options.locks;
      if (!locks) return fn();
      return /** @type {Promise<T | null>} */ (locks.request(LOCK_NAME, { ifAvailable: opts.ifAvailable === true }, (lock) => (lock ? fn() : null)));
    });
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * The hash that tells whether a conversation changed. Its creation time is left out: the store
   * cannot change it later, so two copies that differ only there must not write each other back.
   * @param {SyncRecord} record
   */
  const hashOf = (record) => digestText(canonicalJson(record.kind === 'conversation' ? { ...record, conversation: { ...record.conversation, createdAt: 0 } } : record), cryptoOpts);

  /**
   * The record of a stored conversation; `exists` is false when there is no such conversation.
   * @param {ChatStore} store
   * @param {string} convId
   * @param {RowState | undefined} known  what this device last synced of it
   */
  async function localRecord(store, convId, known) {
    const thread = await store.loadThread(convId);
    if (!thread) return { exists: false, payload: null };
    return { exists: true, payload: buildPayload(thread.conversation, thread.nodes, { syncedTitle: known?.base?.title }) };
  }

  /**
   * Whether a record holds messages the revision this device last synced did not have. Without a
   * known list (a row this device never synced), every message counts as new.
   * @param {ConversationPayload | null} payload
   * @param {RowState | undefined} known
   */
  const hasNewMessages = (payload, known) => {
    if (!payload) return false;
    const before = known && !known.deleted && Array.isArray(known.nodes) ? new Set(known.nodes) : null;
    return payload.nodes.some((n) => !before?.has(n.id));
  };

  /**
   * The state of a row at a revision this device wrote or applied.
   * @param {string} convId
   * @param {number} rev
   * @param {SyncRecord} record
   * @returns {Promise<RowState>}
   */
  async function rowState(convId, rev, record) {
    const hash = await hashOf(record);
    if (record.kind === 'deleted') return { convId, rev, hash, base: null, nodes: [], deleted: true };
    return { convId, rev, hash, base: metaOf(record), nodes: record.nodes.map((n) => n.id), deleted: false };
  }

  /**
   * @typedef {object} CycleContext
   * @property {SyncState} st
   * @property {SyncKeys} keys
   * @property {ChatStore} store
   * @property {SyncReport} report
   * @property {number} tooLarge  conversations left out this time for their size
   */

  /**
   * Opens a fetched row; marks it unreadable in the state when it does not open or does not belong
   * to its row id.
   * @param {CycleContext} ctx
   * @param {RemoteRow} row
   * @returns {Promise<SyncRecord | null>}
   */
  async function openRow(ctx, row) {
    try {
      const record = await openRecord(ctx.keys, row, cryptoOpts);
      if (isSyncRecord(record) && (await rowIdFor(ctx.keys, record.id, cryptoOpts)) === row.rowId) return record;
    } catch (err) {
      if (!(err instanceof SyncCryptoError)) throw err;
    }
    ctx.st.rows[row.rowId] = { convId: ctx.st.rows[row.rowId]?.convId ?? '', rev: row.rev, hash: UNREADABLE, base: null, nodes: [], deleted: true };
    ctx.report.skipped += 1;
    return null;
  }

  /**
   * Writes a record as revision baseRev + 1.
   * @param {CycleContext} ctx
   * @param {string} rowId
   * @param {number} baseRev
   * @param {SyncRecord} record
   * @returns {Promise<'written' | 'conflict' | 'skipped'>}
   */
  async function write(ctx, rowId, baseRev, record) {
    const rev = baseRev + 1;
    let sealed;
    try {
      sealed = await sealRecord(ctx.keys, { rowId, rev }, record, cryptoOpts);
    } catch (err) {
      if (err instanceof SyncCryptoError && err.code === 'too_large') {
        ctx.report.skipped += 1;
        ctx.tooLarge += 1;
        return 'skipped';
      }
      throw err;
    }
    if (must(await remote.writeRow({ rowId, rev, ...sealed }, baseRev)) === 'conflict') return 'conflict';
    ctx.st.rows[rowId] = await rowState(record.id, rev, record);
    ctx.report.written += 1;
    return 'written';
  }

  /**
   * Brings one conversation and its row in step. `incoming` is a newer remote revision, if one
   * was fetched.
   * @param {CycleContext} ctx
   * @param {string} rowId
   * @param {string} convId
   * @param {{ rev: number, record: SyncRecord } | null} incoming
   */
  async function reconcile(ctx, rowId, convId, incoming) {
    const { st, store } = ctx;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const known = st.rows[rowId];
      const local = await localRecord(store, convId, known);
      const localHash = local.payload ? await hashOf(local.payload) : null;
      // Changed here since the revision this device last synced (a deletion counts).
      const changed = known ? (local.exists ? local.payload !== null && localHash !== known.hash : !known.deleted) : local.payload !== null;
      /** @type {SyncRecord} */
      let target;
      let baseRev = known?.rev ?? 0;

      if (incoming && incoming.rev > baseRev) {
        const record = incoming.record;
        if (record.kind === 'deleted') {
          // Deleted elsewhere: new messages written here win and are written again; fields changed
          // here (and turns that stay on this device) go with the conversation.
          if (!hasNewMessages(local.payload, known)) {
            if (local.exists) await store.deleteConversation(convId);
            st.rows[rowId] = await rowState(convId, incoming.rev, record);
            ctx.report.applied += 1;
            return;
          }
          target = /** @type {ConversationPayload} */ (local.payload);
        } else if (known && !known.deleted && !local.exists && !hasNewMessages(record, known)) {
          // Deleted here after the revision this device last synced, while the newer revision only
          // changed fields: the deletion wins and is written on top of it.
          target = deletedPayload(convId, now());
        } else {
          const merged = mergePayloads(local.payload, record, changed && known?.base ? known.base : null);
          await applyPayload(store, merged, local.payload);
          ctx.report.applied += 1;
          st.rows[rowId] = await rowState(convId, incoming.rev, record);
          const after = (await localRecord(store, convId, st.rows[rowId])).payload;
          if (!after || (await hashOf(after)) === st.rows[rowId].hash) return;
          target = after;
        }
        baseRev = incoming.rev;
      } else {
        if (!changed) return;
        if (local.payload) target = local.payload;
        else if (!local.exists && known && !known.deleted) target = deletedPayload(convId, now());
        else return;
      }

      const outcome = await write(ctx, rowId, baseRev, target);
      if (outcome !== 'conflict') return;
      // The row moved on meanwhile: merge its newest revision and try again.
      const [row] = must(await remote.fetchRows([rowId]));
      if (!row) {
        // Gone from the server: written again as a new row.
        delete st.rows[rowId];
        incoming = null;
        continue;
      }
      const record = await openRow(ctx, row);
      if (!record) return;
      incoming = { rev: row.rev, record };
    }
  }

  /**
   * One sync, inside exclusive(). Checks the conversations changed since the last sync, or all of
   * them: with `full`, after an error, and while the engine does not follow the store (start()).
   * @param {boolean} [full]
   * @returns {Promise<SyncReport | null>}
   */
  async function cycle(full = false) {
    const st = await options.state.load().catch(() => null);
    if (!st) {
      if (status.phase !== 'unavailable') setStatus({ phase: 'off', purging: false });
      return null;
    }
    if (st.purge) return (await purge()) ? { applied: 0, written: 0, skipped: 0 } : null;
    const check = full || !unsubscribe ? null : dirty;
    dirty = new Set();
    setStatus({ busy: true });
    /** @type {CycleContext | null} */
    let ctx = null;
    try {
      const account = must(await remote.account());
      if (!account.userId) throw new RemoteFailure({ kind: 'not_signed_in', message: 'No session' });
      if (account.userId !== st.userId) {
        setStatus({ phase: 'other_account', error: null });
        return null;
      }
      const envelope = must(await remote.getKeyEnvelope());
      if (!envelope) {
        setStatus({ phase: 'remote_off', error: null });
        return null;
      }
      if (envelope.keyId !== st.keyId) {
        setStatus({ phase: 'rekeyed', error: null });
        return null;
      }
      ctx = { st, keys: { keyId: st.keyId, enc: st.enc, ids: st.ids }, store: await options.store(), report: { applied: 0, written: 0, skipped: 0 }, tooLarge: 0 };
      const revisions = must(await remote.listRevisions());
      const onServer = new Map(revisions.map((r) => [r.rowId, r.rev]));
      // A row this device knew that is gone from the server is forgotten; its conversation is
      // written again as a new row.
      for (const rowId of Object.keys(st.rows)) if (!onServer.has(rowId)) delete st.rows[rowId];

      // 1. Newer revisions from the server.
      const newer = revisions.filter((r) => r.rev > (st.rows[r.rowId]?.rev ?? 0)).map((r) => r.rowId);
      for (let i = 0; i < newer.length; i += FETCH_CHUNK) {
        for (const row of must(await remote.fetchRows(newer.slice(i, i + FETCH_CHUNK)))) {
          if (row.rev <= (st.rows[row.rowId]?.rev ?? 0)) continue;
          const record = await openRow(ctx, row);
          if (record) await reconcile(ctx, row.rowId, record.id, { rev: row.rev, record });
        }
      }

      // 2. Conversations changed here, and synced conversations deleted here.
      const conversations = await ctx.store.listConversations({ includeArchived: true });
      const present = new Set(conversations.map((c) => c.id));
      /** @type {Map<string, string>} */
      const rowOf = new Map();
      for (const [rowId, row] of Object.entries(st.rows)) if (row.convId) rowOf.set(row.convId, rowId);
      const candidates = check === null ? [...present] : [...check].filter((id) => present.has(id));
      for (const convId of candidates) await reconcile(ctx, rowOf.get(convId) ?? (await rowIdFor(ctx.keys, convId, cryptoOpts)), convId, null);
      for (const [rowId, row] of Object.entries(st.rows)) if (!row.deleted && row.convId && !present.has(row.convId)) await reconcile(ctx, rowId, row.convId, null);

      st.lastSyncAt = now();
      setStatus({ phase: 'on', error: null, lastSyncAt: st.lastSyncAt });
      return ctx.report;
    } catch (err) {
      // What was not checked is checked next time.
      if (check === null || dirty === null) dirty = null;
      else for (const id of check) dirty.add(id);
      const kind = err instanceof RemoteFailure ? err.error.kind : err instanceof SyncCryptoError ? err.code : 'unknown';
      if (!(err instanceof RemoteFailure)) console.warn('[starpi] chat sync failed', err);
      setStatus({ error: kind });
      return null;
    } finally {
      // Rows written or applied before a failure stay recorded.
      if (ctx) await options.state.save(st).catch((err) => console.warn('[starpi] the sync state could not be stored', err));
      setStatus({ busy: false, conversations: countRows(st), skipped: countUnreadable(st) + (ctx?.tooLarge ?? 0) });
    }
  }

  /**
   * Syncs now (after any sync already running). `full` checks every conversation, not only the
   * ones changed since the last sync.
   * @param {{ ifAvailable?: boolean, full?: boolean }} [opts]
   * @returns {Promise<SyncReport | null>}
   */
  async function syncNow(opts = {}) {
    await ready();
    if (status.phase === 'unavailable') return null;
    return exclusive(() => cycle(opts.full === true), opts);
  }

  /**
   * Turns sync on with a passphrase and runs the first sync (which restores what the account has).
   * @param {string} passphrase
   * @returns {Promise<EnableResult>}
   */
  async function enable(passphrase) {
    await ready();
    if (status.phase === 'unavailable') return { ok: false, reason: 'unavailable' };
    if (!passphraseLongEnough(passphrase)) return { ok: false, reason: 'too_short' };
    const result = await exclusive(async () => {
      /** @returns {Promise<EnableResult>} */
      const attempt = async () => {
        const account = must(await remote.account());
        if (!account.userId) return { ok: false, reason: 'no_session' };
        let envelope = must(await remote.getKeyEnvelope());
        /** @type {SyncKeys} */
        let keys;
        let joined = Boolean(envelope);
        if (envelope) {
          keys = await openSyncKey(passphrase, envelope, cryptoOpts);
        } else {
          const made = await createSyncKey(passphrase, { ...cryptoOpts, iterations });
          if (must(await remote.putKeyEnvelope(made.envelope)) === 'created') {
            keys = made.keys;
          } else {
            // Another browser of the account was quicker: its key is the one to use.
            envelope = must(await remote.getKeyEnvelope());
            if (!envelope) return { ok: false, reason: 'error' };
            keys = await openSyncKey(passphrase, envelope, cryptoOpts);
            joined = true;
          }
        }
        const previous = await options.state.load().catch(() => null);
        const sameKey = previous?.keyId === keys.keyId && previous.userId === account.userId;
        await options.state.save({ v: 1, userId: account.userId, keyId: keys.keyId, enc: keys.enc, ids: keys.ids, rows: sameKey ? previous.rows : {}, lastSyncAt: sameKey ? previous.lastSyncAt : null });
        dirty = null;
        setStatus({ phase: 'on', error: null, skipped: 0 });
        return { ok: true, joined, report: await cycle(true) };
      };
      try {
        return await attempt();
      } catch (err) {
        /** @type {EnableFailure} */
        let reason;
        if (err instanceof RemoteFailure) reason = failureOf(err.error);
        else if (err instanceof SyncCryptoError) reason = err.code === 'wrong_passphrase' ? 'wrong_passphrase' : err.code === 'unavailable' ? 'unavailable' : 'error';
        else throw err;
        return /** @type {EnableResult} */ ({ ok: false, reason });
      }
    });
    return result ?? { ok: false, reason: 'error' };
  }

  /** Forgets the sync state of this browser: sync is off here. */
  async function forget() {
    await options.state.clear();
    dirty = null;
    setStatus({ phase: status.phase === 'unavailable' ? 'unavailable' : 'off', conversations: 0, lastSyncAt: null, skipped: 0, error: null, purging: false });
  }

  /**
   * Deletes the account's key envelope and rows for a turn-off that asked for it (inside
   * exclusive()); sync is off here once that is done. A failure leaves the state marked, so the
   * next sync retries: the key may already be gone, and the rows left behind must not wait for a
   * new setup.
   * @returns {Promise<boolean>}
   */
  async function purge() {
    const res = await remote.deleteAll();
    if (!res.ok) {
      setStatus({ error: res.error.kind, purging: true });
      return false;
    }
    await forget();
    return true;
  }

  /**
   * Turns sync off in this browser; with deleteRemote, first deletes the key envelope and every
   * synced row of the account (other browsers then stop syncing and keep their conversations).
   * @param {{ deleteRemote: boolean }} opts
   * @returns {Promise<boolean>} false when the remote data could not be deleted yet (later syncs retry)
   */
  async function disable(opts) {
    await ready();
    const done = await exclusive(async () => {
      if (!opts.deleteRemote) {
        await forget();
        return true;
      }
      const st = await options.state.load().catch(() => null);
      if (st && !st.purge) await options.state.save({ ...st, purge: true });
      return purge();
    });
    return done === true;
  }

  /**
   * Notes a change of the conversation store and schedules a sync.
   * @param {ChatChange} change
   */
  function noteChange(change) {
    if (dirty !== null) {
      if (change.kind === 'all') dirty = null;
      else if (change.kind === 'conversation') dirty.add(change.id);
      else if (change.kind === 'node') dirty.add(change.conversationId);
    }
    schedule(debounceMs);
  }

  /**
   * Syncs after `ms` (a later call moves the time).
   * @param {number} ms
   */
  function schedule(ms) {
    if (status.phase !== 'on') return;
    if (timer !== null) timers.clear(timer);
    timer = timers.set(() => {
      timer = null;
      void syncNow();
    }, ms);
  }

  /** Follows the conversation store, so changes made here are synced. */
  async function start() {
    if (started) return;
    started = true;
    await ready();
    const store = await options.store();
    if (!started) return;
    unsubscribe = store.onChange(noteChange);
  }

  function stop() {
    started = false;
    unsubscribe?.();
    unsubscribe = null;
    if (timer !== null) timers.clear(timer);
    timer = null;
  }

  return {
    ready,
    /** @returns {SyncStatus} */
    status: () => status,
    /**
     * @param {(status: SyncStatus) => void} fn
     * @returns {() => void}
     */
    onStatus(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /**
     * Whether the account already has sync set up (a key envelope on the server).
     * @returns {Promise<Result<boolean>>}
     */
    async accountHasSync() {
      const res = await remote.getKeyEnvelope();
      return res.ok ? { ok: true, data: res.data !== null } : res;
    },
    enable,
    disable,
    syncNow,
    schedule,
    start,
    stop,
  };
}

/** @typedef {ReturnType<typeof createChatSync>} ChatSync */
