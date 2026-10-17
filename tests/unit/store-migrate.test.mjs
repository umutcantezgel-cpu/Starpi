// One-time migrations: the 2.x chats in localStorage become conversations with a linear chain of
// nodes, exactly once, without duplicates on a repeat, and the localStorage copy is removed only
// after the records committed (never when the database lives in memory).
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { STORAGE_KEYS } from '../../src/js/config.js';
import {
  APP_MIGRATIONS,
  isMigrationDone,
  LEGACY_CHATS_MIGRATION_ID,
  LEGACY_KEYS_MIGRATION_ID,
  legacyChatsMigration,
  legacyChatsToRecords,
  MIGRATION_MARKER_PREFIX,
  runMigrations,
} from '../../src/js/store/migrate.js';
import { openAppDb } from '../../src/js/store/schema.js';

/** @typedef {import('../../src/js/store/schema.js').NodeRecord} NodeRecord */

let seq = 0;
const uniqueName = () => `migrate-test-${(seq += 1)}`;
const NOW = Date.parse('2026-10-16T12:00:00Z');

const LEGACY = {
  starpi_aaaaaaaa: {
    updatedAt: Date.parse('2026-10-01T09:00:05Z'),
    messages: [
      { role: 'user', content: 'How do tides work?\nPlease keep it short.', sources: [], metadata: { chat_mode: 'free', local_only: false }, created_at: '2026-10-01T09:00:00.000Z' },
      {
        role: 'assistant',
        content: 'The moon pulls on the oceans.',
        sources: [],
        metadata: { engine: 'nvidia', model: 'example-model-8b', chat_mode: 'free', thoughts: [], duration_ms: 812, local_only: false },
        created_at: '2026-10-01T09:00:04.000Z',
      },
      { role: 'system', content: 'not a chat row' },
      { role: 'user', content: '', sources: [], metadata: {} },
      { role: 'user', content: 'And in lakes?', sources: [], metadata: { chat_mode: 'grounded', local_only: true }, created_at: '2026-10-01T09:00:05.000Z' },
    ],
  },
  starpi_bbbbbbbb: {
    updatedAt: Date.parse('2026-09-20T10:00:00Z'),
    // Written by an early 2.x build: no timestamps and no local_only flag.
    messages: [
      { role: 'user', content: 'Summarise the attached report', sources: [], metadata: {} },
      { role: 'assistant', content: 'It covers three topics [Doc: report.pdf, Chunk: 2].', sources: [{ title: 'report.pdf', rank: 0.82 }, { bad: true }], metadata: { engine: 'client', chat_mode: 'grounded' } },
    ],
  },
  starpi_empty: { updatedAt: 1, messages: [] },
  broken: 'not an entry',
};

/**
 * A localStorage stand-in for the migration.
 * @param {Record<string, string>} [initial]
 */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    read: (/** @type {string} */ key) => data.get(key) ?? null,
    remove: (/** @type {string} */ key) => void data.delete(key),
  };
}

const legacyStorage = () => memoryStorage({ [STORAGE_KEYS.localChats]: JSON.stringify(LEGACY) });

describe('legacyChatsToRecords', () => {
  const { conversations, nodes } = legacyChatsToRecords(LEGACY, NOW);

  it('makes one conversation per session with messages, and drops rows without a role or text', () => {
    assert.deepEqual(conversations.map((c) => c.id).sort(), ['starpi_aaaaaaaa', 'starpi_bbbbbbbb']);
    assert.deepEqual(nodes.filter((n) => n.conversationId === 'starpi_aaaaaaaa').map((n) => n.id), ['starpi_aaaaaaaa:0', 'starpi_aaaaaaaa:1', 'starpi_aaaaaaaa:4']);
  });

  it('chains the messages linearly and points the conversation at the last one', () => {
    const chain = nodes.filter((n) => n.conversationId === 'starpi_aaaaaaaa');
    assert.deepEqual(chain.map((n) => n.parentId), [null, 'starpi_aaaaaaaa:0', 'starpi_aaaaaaaa:1']);
    const conv = conversations.find((c) => c.id === 'starpi_aaaaaaaa');
    assert.deepEqual(conv, {
      id: 'starpi_aaaaaaaa',
      title: 'How do tides work?',
      createdAt: Date.parse('2026-10-01T09:00:00.000Z'),
      updatedAt: Date.parse('2026-10-01T09:00:05Z'),
      pinned: 0,
      archived: 0,
      activeLeafId: 'starpi_aaaaaaaa:4',
      model: 'example-model-8b',
      mode: 'grounded',
    });
  });

  it('keeps the text, model, sources, label, on-device flag and the remaining metadata', () => {
    const answer = /** @type {NodeRecord} */ (nodes.find((n) => n.id === 'starpi_aaaaaaaa:1'));
    assert.deepEqual(answer.parts, [{ type: 'text', text: 'The moon pulls on the oceans.' }]);
    assert.equal(answer.model, 'example-model-8b');
    assert.equal(answer.label, 'free');
    assert.equal(answer.localOnly, false);
    assert.deepEqual(answer.meta, { engine: 'nvidia', model: 'example-model-8b', chat_mode: 'free', thoughts: [], duration_ms: 812 });
    assert.equal(answer.createdAt, Date.parse('2026-10-01T09:00:04.000Z'));
    const cited = /** @type {NodeRecord} */ (nodes.find((n) => n.id === 'starpi_bbbbbbbb:1'));
    assert.deepEqual(cited.sources, [{ title: 'report.pdf', rank: 0.82 }]);
    assert.equal(cited.label, 'grounded');
    assert.equal(nodes.find((n) => n.id === 'starpi_aaaaaaaa:0')?.label, null, 'questions carry no answer label');
  });

  it('treats rows from before the on-device flag as on-device, and dates them by the session', () => {
    const early = nodes.filter((n) => n.conversationId === 'starpi_bbbbbbbb');
    assert.deepEqual(early.map((n) => n.localOnly), [true, true]);
    assert.deepEqual(early.map((n) => n.createdAt), [LEGACY.starpi_bbbbbbbb.updatedAt, LEGACY.starpi_bbbbbbbb.updatedAt]);
    assert.equal(conversations.find((c) => c.id === 'starpi_bbbbbbbb')?.title, 'Summarise the attached report');
  });

  it('is deterministic and ignores input that is not a chat map', () => {
    assert.deepEqual(legacyChatsToRecords(LEGACY, NOW), legacyChatsToRecords(structuredClone(LEGACY), NOW + 1));
    for (const bad of [null, [], 'x', 42]) assert.deepEqual(legacyChatsToRecords(bad, NOW), { conversations: [], nodes: [] });
  });

  it('cuts long titles at 60 characters without splitting a character', () => {
    const text = `${'é'.repeat(59)}😀 and more`;
    const { conversations: [conv] } = legacyChatsToRecords({ s: { updatedAt: 1, messages: [{ role: 'user', content: text, sources: [], metadata: {} }] } }, NOW);
    assert.equal(Array.from(conv.title).length, 60);
    assert.ok(conv.title.endsWith('😀'));
  });
});

describe('the legacy chat migration', () => {
  it('writes conversations and nodes, marks itself done and then removes the localStorage copy', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const storage = legacyStorage();
    const [outcome] = await runMigrations(db, [legacyChatsMigration(storage)], { now: () => NOW });
    assert.equal(outcome.status, 'done');
    assert.deepEqual(outcome.result, { conversations: 2, nodes: 5, kept: 0, unreadable: false, legacyRemoved: true });
    assert.equal(await db.count('conversations'), 2);
    assert.equal(await db.countFromIndex('nodes', 'conversationId', 'starpi_bbbbbbbb'), 2);
    assert.equal(storage.data.has(STORAGE_KEYS.localChats), false);
    assert.equal(await isMigrationDone(db, LEGACY_CHATS_MIGRATION_ID), true);
    const marker = await db.get('settings', MIGRATION_MARKER_PREFIX + LEGACY_CHATS_MIGRATION_ID);
    assert.deepEqual(marker.value, { done: true, at: NOW, result: { conversations: 2, nodes: 5, kept: 0 } });
    db.close();
  });

  it('runs once: a second start skips it even when the legacy key is back', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    await runMigrations(db, [legacyChatsMigration(legacyStorage())]);
    const storage = legacyStorage();
    const [outcome] = await runMigrations(db, [legacyChatsMigration(storage)]);
    assert.equal(outcome.status, 'skipped');
    assert.equal(storage.data.has(STORAGE_KEYS.localChats), true);
    assert.equal(await db.count('nodes'), 5);
    db.close();
  });

  it('does not duplicate or overwrite anything when repeated without its marker', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    await runMigrations(db, [legacyChatsMigration({ ...legacyStorage(), removeLegacy: false })]);
    // The conversation was renamed since; then the marker got lost.
    const conv = await db.get('conversations', 'starpi_aaaaaaaa');
    await db.put('conversations', { ...conv, title: 'Renamed' });
    await db.delete('settings', MIGRATION_MARKER_PREFIX + LEGACY_CHATS_MIGRATION_ID);
    const [outcome] = await runMigrations(db, [legacyChatsMigration(legacyStorage())]);
    assert.equal(outcome.status, 'done');
    assert.deepEqual(outcome.result, { conversations: 0, nodes: 0, kept: 2, unreadable: false, legacyRemoved: true });
    assert.equal(await db.count('nodes'), 5);
    assert.equal((await db.get('conversations', 'starpi_aaaaaaaa')).title, 'Renamed');
    db.close();
  });

  it('keeps the localStorage copy when the write fails, and tries again next time', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const storage = legacyStorage();
    // The write transaction fails (a full disk); reads still work.
    const failing = { ...db, transaction: () => Promise.reject(Object.assign(new Error('disk full'), { code: 'quota' })) };
    const outcomes = await runMigrations(/** @type {typeof db} */ (failing), [legacyChatsMigration(storage), { id: 'after', run: () => 'ran' }]);
    assert.deepEqual(outcomes.map((o) => o.status), ['failed', 'pending']);
    assert.equal(storage.data.has(STORAGE_KEYS.localChats), true);
    assert.equal(await isMigrationDone(db, LEGACY_CHATS_MIGRATION_ID), false);
    assert.equal(await db.count('conversations'), 0);
    const retry = await runMigrations(db, [legacyChatsMigration(storage), { id: 'after', run: () => 'ran' }]);
    assert.deepEqual(retry.map((o) => o.status), ['done', 'done']);
    assert.equal(storage.data.has(STORAGE_KEYS.localChats), false);
    db.close();
  });

  it('never removes the localStorage copy while the database lives only in memory', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: null });
    const storage = legacyStorage();
    const [outcome] = await runMigrations(db, [legacyChatsMigration(storage)]);
    assert.equal(outcome.status, 'done');
    assert.equal(/** @type {{ legacyRemoved: boolean }} */ (outcome.result).legacyRemoved, false);
    assert.equal(storage.data.has(STORAGE_KEYS.localChats), true);
    assert.equal(await db.count('conversations'), 2, 'the chats are still shown for this page');
  });

  it('keeps unreadable data and does nothing when there is none', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const storage = memoryStorage({ [STORAGE_KEYS.localChats]: '{not json' });
    const [outcome] = await runMigrations(db, [legacyChatsMigration(storage)]);
    assert.equal(/** @type {{ unreadable: boolean }} */ (outcome.result).unreadable, true);
    assert.equal(storage.data.has(STORAGE_KEYS.localChats), true);
    assert.equal(await isMigrationDone(db, LEGACY_CHATS_MIGRATION_ID), true);

    const other = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    const [none] = await runMigrations(other, [legacyChatsMigration(memoryStorage())]);
    assert.deepEqual(none.result, { conversations: 0, nodes: 0, kept: 0, unreadable: false, legacyRemoved: false });
    db.close();
    other.close();
  });

  it('is part of the app migrations', () => {
    assert.deepEqual(APP_MIGRATIONS.map((m) => m.id), [LEGACY_CHATS_MIGRATION_ID, LEGACY_KEYS_MIGRATION_ID]);
  });
});

describe('runMigrations', () => {
  it('runs migrations in order, one at a time across concurrent callers, and records each', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: new IDBFactory() });
    /** @type {string[]} */
    const log = [];
    const migrations = [
      { id: 'first', run: async () => void log.push('first') },
      { id: 'second', run: async () => void log.push('second') },
    ];
    // Two tabs starting at once: the Web Lock lets the second see the first one's markers.
    const [a, b] = await Promise.all([runMigrations(db, migrations), runMigrations(db, migrations)]);
    assert.deepEqual(log, ['first', 'second']);
    assert.deepEqual([...a, ...b].map((o) => o.status).sort(), ['done', 'done', 'skipped', 'skipped']);
    assert.equal(await isMigrationDone(db, 'second'), true);
    db.close();
  });

  it('refuses duplicate ids', async () => {
    const db = await openAppDb({ name: uniqueName(), factory: null });
    await assert.rejects(
      runMigrations(db, [
        { id: 'x', run() {} },
        { id: 'x', run() {} },
      ]),
      (err) => err.code === 'data',
    );
  });
});
