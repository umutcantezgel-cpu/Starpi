// @ts-check
// The one-time start-up migrations, loaded on demand by chat/store.js (openChatStore): the 2.x
// chats in localStorage become conversations with one linear thread each, and the provider keys
// 2.x kept in plaintext leave localStorage (store/migrate.js runs both, in that order). Each records
// a marker when it finished, so later starts skip it; a repeat after an interrupted run finds the
// records it already wrote. Every migrated message keeps its on-device flag (localOnly), so a turn
// that stayed on this device in 2.x is never sent to a cloud provider as history afterwards.
import { LEGACY_CHATS_MIGRATION_ID, migrateAppData } from '../store/migrate.js';
import { appDb } from '../store/schema.js';

/** @typedef {import('../store/migrate.js').MigrationOutcome} MigrationOutcome */
/** @typedef {import('../store/migrate.js').LegacyChatsResult} LegacyChatsResult */

/**
 * @typedef {object} StartupMigrationResult
 * @property {MigrationOutcome[]} outcomes
 * @property {number} importedChats  conversations the chat migration wrote in this run
 */

/**
 * Runs the app's migrations against the app database (or the given one).
 * @param {{ db?: import('../store/idb.js').StoreDb, now?: () => number }} [options]
 * @returns {Promise<StartupMigrationResult>}
 */
export async function runStartupMigrations(options = {}) {
  const db = options.db ?? (await appDb());
  const outcomes = await migrateAppData(db, options.now ? { now: options.now } : undefined);
  const chats = outcomes.find((o) => o.id === LEGACY_CHATS_MIGRATION_ID);
  const result = /** @type {Partial<LegacyChatsResult> | undefined} */ (chats?.status === 'done' ? chats.result : undefined);
  return { outcomes, importedChats: result?.conversations ?? 0 };
}
