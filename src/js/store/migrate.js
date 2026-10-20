// @ts-check
// Data migrations that run once, after the database opened. A small runner records every finished
// migration as a marker in `settings`, so each one runs a single time per browser profile, and
// holds a Web Lock while it works, so two tabs never migrate at once. The first migration moves
// the chats that 2.x kept in localStorage into conversations and nodes.
//
// A migration must be safe to repeat: when a tab closes between its data write and its marker,
// the next start runs it again. The chat migration writes both in one transaction and derives
// every id from the legacy data, so a repeat finds its own records and skips them.
import { migrateLegacyKeys } from '../ai/keys.js';
import { STORAGE_KEYS } from '../config.js';
import { readLocal, removeLocal } from '../storage.js';
import { StoreError } from './idb.js';

/** @typedef {import('./idb.js').StoreDb} StoreDb */
/** @typedef {import('./schema.js').ConversationRecord} ConversationRecord */
/** @typedef {import('./schema.js').NodeRecord} NodeRecord */
/** @typedef {import('./schema.js').SettingsRecord} SettingsRecord */
/** @typedef {import('./schema.js').SourceRef} SourceRef */

/**
 * @typedef {object} MigrationContext
 * @property {StoreDb} db
 * @property {() => number} now
 * @property {string} markerKey  the settings key that marks this migration as done
 * @property {(result?: unknown) => SettingsRecord} marker  the marker record; a migration may write
 *   it in its own transaction, so that its data and the marker commit together
 */

/** @typedef {{ id: string, run: (ctx: MigrationContext) => unknown | Promise<unknown> }} Migration */

/**
 * 'done': ran now; 'skipped': ran before; 'failed': threw and runs again next time;
 * 'pending': not tried because an earlier migration failed.
 * @typedef {{ id: string, status: 'done' | 'skipped' | 'failed' | 'pending', result?: unknown, error?: unknown }} MigrationOutcome
 */

/**
 * @typedef {object} LegacyChatsResult
 * @property {number} conversations  conversations written
 * @property {number} nodes  messages written
 * @property {number} kept  conversations that already existed and were left alone
 * @property {boolean} unreadable  the stored value was not valid JSON (nothing imported, key kept)
 * @property {boolean} legacyRemoved
 */

export const MIGRATION_MARKER_PREFIX = 'migration:';
export const LEGACY_CHATS_MIGRATION_ID = 'local-chats-v1';
export const LEGACY_KEYS_MIGRATION_ID = 'legacy-keys-v1';
const TITLE_CHARS = 60;

/** Runs of this page per database, so two starts in one page never overlap without Web Locks. */
/** @type {Map<string, Promise<unknown>>} */
const pageQueues = new Map();

/**
 * Runs `work` after every earlier run queued under `name` in this page has settled.
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
function inPageQueue(name, work) {
  const run = (pageQueues.get(name) ?? Promise.resolve()).then(work, work);
  pageQueues.set(name, run.catch(() => undefined));
  return run;
}

/** @returns {LockManager | null} */
function webLocks() {
  try {
    return globalThis.navigator?.locks ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {StoreDb} db
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function isMigrationDone(db, id) {
  return Boolean(await db.get('settings', MIGRATION_MARKER_PREFIX + id));
}

/**
 * Runs the migrations in order and stops at the first failure; the failed one and those after it
 * run again on the next start.
 * @param {StoreDb} db
 * @param {readonly Migration[]} migrations
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<MigrationOutcome[]>}
 */
export async function runMigrations(db, migrations, options = {}) {
  const ids = migrations.map((m) => m.id);
  if (ids.some((id, i) => !id || ids.indexOf(id) !== i)) throw new StoreError('data', 'Migration ids must be unique and non-empty');
  const now = options.now ?? Date.now;
  const work = () => runInOrder(db, migrations, now);
  const name = `${db.name}-migrations`;
  const locks = webLocks();
  // Only a database shared with other tabs needs the Web Lock; the memory stand-in is this page's
  // own. Without Web Locks the runs of this page still wait for each other.
  if (db.persistent && locks) return locks.request(name, work);
  return inPageQueue(name, work);
}

/**
 * @param {StoreDb} db
 * @param {readonly Migration[]} migrations
 * @param {() => number} now
 * @returns {Promise<MigrationOutcome[]>}
 */
async function runInOrder(db, migrations, now) {
  /** @type {MigrationOutcome[]} */
  const outcomes = [];
  let stopped = false;
  for (const migration of migrations) {
    const { id } = migration;
    if (stopped) {
      outcomes.push({ id, status: 'pending' });
      continue;
    }
    const markerKey = MIGRATION_MARKER_PREFIX + id;
    if (await db.get('settings', markerKey)) {
      outcomes.push({ id, status: 'skipped' });
      continue;
    }
    /** @param {unknown} [result] @returns {SettingsRecord} */
    const marker = (result) => ({ key: markerKey, value: { done: true, at: now(), ...(result === undefined ? {} : { result }) }, updatedAt: now() });
    try {
      const result = await migration.run({ db, now, markerKey, marker });
      if (!(await db.get('settings', markerKey))) await db.put('settings', marker(result));
      outcomes.push({ id, status: 'done', result });
    } catch (error) {
      console.warn(`[store] migration "${id}" failed and will be retried:`, error);
      outcomes.push({ id, status: 'failed', error });
      stopped = true;
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------------------------
// 2.x chats from localStorage

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {SourceRef[]}
 */
function sourcesOf(value) {
  if (!Array.isArray(value)) return [];
  /** @type {SourceRef[]} */
  const out = [];
  for (const s of value) {
    if (!isRecord(s) || typeof s.title !== 'string') continue;
    out.push(typeof s.rank === 'number' || s.rank === null ? { title: s.title, rank: s.rank } : { title: s.title });
  }
  return out;
}

/** @param {string} text */
function titleOf(text) {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return Array.from(line.replace(/\s+/g, ' ').trim()).slice(0, TITLE_CHARS).join('');
}

/** @param {unknown} value */
function timeOf(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Turns the 2.x chat map (session id -> { updatedAt, messages }) into conversations whose
 * messages form one linear chain. Ids come from the session id and the message position, so the
 * same input always gives the same records. Rows without a role or text are dropped.
 * @param {unknown} data
 * @param {number} now  time for sessions without any timestamp
 * @returns {{ conversations: ConversationRecord[], nodes: NodeRecord[] }}
 */
export function legacyChatsToRecords(data, now) {
  /** @type {ConversationRecord[]} */
  const conversations = [];
  /** @type {NodeRecord[]} */
  const nodes = [];
  if (!isRecord(data)) return { conversations, nodes };
  for (const [sid, entry] of Object.entries(data)) {
    if (!sid || sid.length > 200 || !isRecord(entry) || !Array.isArray(entry.messages)) continue;
    const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : null;
    const firstKnown = entry.messages.map((m) => (isRecord(m) ? timeOf(m.created_at) : null)).find((t) => t !== null) ?? null;
    /** @type {NodeRecord[]} */
    const chain = [];
    entry.messages.forEach((m, i) => {
      if (!isRecord(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) return;
      const { local_only: localOnly, ...meta } = isRecord(m.metadata) ? m.metadata : {};
      const previous = chain[chain.length - 1];
      const mode = meta.chat_mode === 'free' || meta.chat_mode === 'grounded' ? meta.chat_mode : null;
      chain.push({
        id: `${sid}:${i}`,
        conversationId: sid,
        parentId: previous?.id ?? null,
        role: m.role,
        parts: [{ type: 'text', text: m.content }],
        opaque: [],
        model: typeof meta.model === 'string' ? meta.model : null,
        provider: null,
        label: m.role === 'assistant' ? mode : null,
        usage: null,
        sources: sourcesOf(m.sources),
        // As in 2.x: rows stored before the flag existed count as on-device turns.
        localOnly: typeof localOnly === 'boolean' ? localOnly : true,
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
        createdAt: timeOf(m.created_at) ?? previous?.createdAt ?? firstKnown ?? updatedAt ?? now,
      });
    });
    if (chain.length === 0) continue;
    const last = chain[chain.length - 1];
    const firstUser = chain.find((n) => n.role === 'user');
    const lastAssistant = chain.findLast((n) => n.role === 'assistant');
    const lastMode = chain.findLast((n) => n.meta?.chat_mode === 'free' || n.meta?.chat_mode === 'grounded')?.meta?.chat_mode;
    conversations.push({
      id: sid,
      title: firstUser ? titleOf(String(firstUser.parts[0].text)) : '',
      createdAt: chain[0].createdAt,
      updatedAt: updatedAt ?? last.createdAt,
      pinned: 0,
      archived: 0,
      activeLeafId: last.id,
      model: lastAssistant?.model ?? null,
      mode: lastMode === 'free' ? 'free' : 'grounded',
    });
    nodes.push(...chain);
  }
  return { conversations, nodes };
}

/**
 * @typedef {object} LegacyChatsOptions
 * @property {(key: string) => string | null} [read]  defaults to localStorage
 * @property {(key: string) => void} [remove]
 * @property {boolean} [removeLegacy]  remove the localStorage copy after the write (default true;
 *   never when the database is the memory stand-in, whose data ends with the page)
 */

/**
 * Copies the 2.x chats into the database. Conversations that already exist are left alone. The
 * legacy key is removed only after the transaction with the records and the marker committed.
 * @param {MigrationContext} ctx
 * @param {LegacyChatsOptions} [options]
 * @returns {Promise<LegacyChatsResult>}
 */
export async function migrateLegacyChats(ctx, options = {}) {
  const read = options.read ?? readLocal;
  const remove = options.remove ?? removeLocal;
  const key = STORAGE_KEYS.localChats;
  const raw = read(key);
  /** @type {LegacyChatsResult} */
  const result = { conversations: 0, nodes: 0, kept: 0, unreadable: false, legacyRemoved: false };
  if (raw === null) return result;
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Unreadable data is never deleted; the marker still keeps this from running on every start.
    return { ...result, unreadable: true };
  }
  const { conversations, nodes } = legacyChatsToRecords(data, ctx.now());
  await ctx.db.transaction(
    ['conversations', 'nodes', 'settings'],
    'readwrite',
    async (tx) => {
      const existing = await Promise.all(conversations.map((c) => tx.get('conversations', c.id)));
      const fresh = conversations.filter((_, i) => !existing[i]);
      const ids = new Set(fresh.map((c) => c.id));
      const freshNodes = nodes.filter((n) => ids.has(n.conversationId));
      await tx.putMany('conversations', fresh);
      await tx.putMany('nodes', freshNodes);
      result.conversations = fresh.length;
      result.nodes = freshNodes.length;
      result.kept = conversations.length - fresh.length;
      await tx.put('settings', ctx.marker({ conversations: result.conversations, nodes: result.nodes, kept: result.kept }));
    },
    { durability: 'strict' },
  );
  if (options.removeLegacy !== false && ctx.db.persistent) {
    remove(key);
    result.legacyRemoved = true;
  }
  return result;
}

/**
 * @param {LegacyChatsOptions} [options]
 * @returns {Migration}
 */
export function legacyChatsMigration(options = {}) {
  return { id: LEGACY_CHATS_MIGRATION_ID, run: (ctx) => migrateLegacyChats(ctx, options) };
}

// ---------------------------------------------------------------------------------------------
// 2.x plaintext keys from localStorage

/**
 * The provider keys 2.x remembered in plaintext move into this tab's session storage and leave
 * localStorage, together with the "remember keys" switch. A vault needs the user's passphrase, so
 * the keys view then suggests setting one, which moves them into the vault (ai/keys.js). The key
 * store runs the same move on its first use, so the keys are safe even before this runs; the marker
 * records only which providers moved.
 * @param {Partial<import('../ai/keys.js').LegacyStorage>} [storage]
 * @returns {Migration}
 */
export function legacyKeysMigration(storage) {
  return { id: LEGACY_KEYS_MIGRATION_ID, run: () => migrateLegacyKeys(storage) };
}

/** The app's migrations, oldest first. New ones are appended, never reordered. */
export const APP_MIGRATIONS = Object.freeze([legacyChatsMigration(), legacyKeysMigration()]);

/**
 * Runs the app's migrations against the app database.
 * @param {StoreDb} db
 * @param {{ now?: () => number }} [options]
 */
export function migrateAppData(db, options) {
  return runMigrations(db, APP_MIGRATIONS, options);
}
