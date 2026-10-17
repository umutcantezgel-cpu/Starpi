// Start-up migration and the chat view's persistence layer: the 2.x chats in localStorage become
// conversations once (on-device flags kept, nothing duplicated on a repeat, the localStorage copy
// removed), the plaintext keys move out of localStorage in the same run, and chat-store.js reads and
// writes sessions through the conversation store, with sync switched off.
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { STORAGE_KEYS } from '../../src/js/config.js';

/** A Web Storage stand-in. */
class MemoryStorage {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map();
  }
  get length() {
    return this.map.size;
  }
  /** @param {string} key */
  getItem(key) {
    return this.map.get(key) ?? null;
  }
  /** @param {string} key @param {string} value */
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  /** @param {string} key */
  removeItem(key) {
    this.map.delete(key);
  }
  /** @param {number} i */
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  clear() {
    this.map.clear();
  }
}

const SID = 'starpi_aaaaaaaa-1111';
const LEGACY = {
  [SID]: {
    updatedAt: Date.parse('2026-10-01T09:00:05Z'),
    messages: [
      { role: 'user', content: 'How do tides work?', sources: [], metadata: { chat_mode: 'free', local_only: false }, created_at: '2026-10-01T09:00:00.000Z' },
      { role: 'assistant', content: 'The moon pulls on the oceans.', sources: [], metadata: { engine: 'cloud', chat_mode: 'free', local_only: false }, created_at: '2026-10-01T09:00:04.000Z' },
      { role: 'user', content: 'Summarise my notes', sources: [], metadata: { chat_mode: 'grounded', local_only: true }, created_at: '2026-10-01T09:00:05.000Z' },
    ],
  },
  'starpi_bbbbbbbb-2222': {
    updatedAt: Date.parse('2026-09-20T10:00:00Z'),
    // An early 2.x build: no timestamps, no local_only flag (treated as on-device).
    messages: [{ role: 'user', content: 'Old question', sources: [], metadata: {} }],
  },
};

const local = new MemoryStorage();
const session = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true, writable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: session, configurable: true, writable: true });

describe('runStartupMigrations', () => {
  it('turns the 2.x chats into conversations once and keeps the on-device flags', async () => {
    const { runStartupMigrations } = await import('../../src/js/chat/migrate-v1.js');
    const { openAppDb } = await import('../../src/js/store/schema.js');
    const { createChatStore } = await import('../../src/js/chat/store.js');
    local.setItem(STORAGE_KEYS.localChats, JSON.stringify(LEGACY));
    local.setItem(STORAGE_KEYS.geminiKey, 'AIza-legacy-plaintext');
    const db = await openAppDb({ name: 'migrate-v1-test', factory: new IDBFactory() });

    const first = await runStartupMigrations({ db, now: () => Date.parse('2026-10-17T00:00:00Z') });
    assert.equal(first.importedChats, 2);
    assert.deepEqual(
      first.outcomes.map((o) => [o.id, o.status]),
      [
        ['local-chats-v1', 'done'],
        ['legacy-keys-v1', 'done'],
      ],
    );
    assert.equal(local.getItem(STORAGE_KEYS.localChats), null, 'the localStorage copy is gone once the records committed');
    assert.equal(local.getItem(STORAGE_KEYS.geminiKey), null, 'plaintext keys leave localStorage in the same run');

    const store = createChatStore({ open: async () => db });
    const thread = await store.loadThread(SID);
    assert.ok(thread);
    assert.deepEqual(
      thread.path.map((n) => [n.role, n.localOnly]),
      [
        ['user', false],
        ['assistant', false],
        ['user', true],
      ],
    );
    assert.equal(thread.conversation.title, 'How do tides work?');
    assert.equal((await store.loadThread('starpi_bbbbbbbb-2222'))?.path[0].localOnly, true);

    // A second start finds the markers and changes nothing, even if old data shows up again.
    local.setItem(STORAGE_KEYS.localChats, JSON.stringify(LEGACY));
    const second = await runStartupMigrations({ db });
    assert.equal(second.importedChats, 0);
    assert.deepEqual(
      second.outcomes.map((o) => o.status),
      ['skipped', 'skipped'],
    );
    assert.equal((await store.getNodes(SID)).length, 3);
    local.removeItem(STORAGE_KEYS.localChats);
  });
});

describe('chat-store.js over the conversation store', () => {
  /** @type {typeof import('../../src/js/chat-store.js')} */
  let facade;

  before(async () => {
    local.clear();
    local.setItem(STORAGE_KEYS.localChats, JSON.stringify(LEGACY));
    local.setItem(STORAGE_KEYS.sessionId, SID);
    facade = await import('../../src/js/chat-store.js');
  });

  // The shared store listens to the other tabs; its channel would keep the test process alive.
  after(async () => (await facade.chatData()).close());

  it('keeps sync off and the current session from 2.x', () => {
    assert.equal(facade.CHAT_SYNC_ENABLED, false);
    assert.equal(facade.currentSessionId(), SID);
  });

  it('loads the migrated chat as the current session, with its on-device flags', async () => {
    const rows = await facade.loadCurrentSession();
    assert.deepEqual(
      rows.map((r) => [r.role, r.content, r.metadata.local_only, r.metadata.chat_mode]),
      [
        ['user', 'How do tides work?', false, 'free'],
        ['assistant', 'The moon pulls on the oceans.', false, 'free'],
        ['user', 'Summarise my notes', true, 'grounded'],
      ],
    );
    assert.equal(rows[1].metadata.engine, 'cloud');
    assert.equal(rows[0].created_at, '2026-10-01T09:00:00.000Z');
    assert.equal(local.getItem(STORAGE_KEYS.localChats), null);
  });

  it('stores new messages at the end of the thread, in order, and never in localStorage', async () => {
    const before = local.getItem(STORAGE_KEYS.localChats);
    void facade.persistMessage(SID, { role: 'assistant', content: 'Here is a summary.', sources: [{ title: 'notes.md', rank: 0.7 }], metadata: { engine: 'client', model: 'small', chat_mode: 'grounded' } }, { localOnly: true });
    void facade.persistMessage(SID, { role: 'user', content: 'Thanks!', sources: [], metadata: { chat_mode: 'free' } }, { localOnly: false });
    void facade.persistMessage(SID, { role: 'user', content: '', sources: [], metadata: {} }, { localOnly: false });
    await facade.waitForWrites(SID);
    const rows = await facade.loadCurrentSession();
    assert.deepEqual(
      rows.slice(3).map((r) => [r.role, r.content, r.metadata.local_only, r.metadata.model ?? null]),
      [
        ['assistant', 'Here is a summary.', true, 'small'],
        ['user', 'Thanks!', false, null],
      ],
    );
    assert.deepEqual(rows[3].sources, [{ title: 'notes.md', rank: 0.7 }]);
    assert.equal(local.getItem(STORAGE_KEYS.localChats), before);
  });

  it('starts, switches and announces sessions; a new chat is stored on its first message', async () => {
    /** @type {string[]} */
    const seen = [];
    const off = facade.onSessionChange((sid) => seen.push(sid));
    const fresh = facade.startNewSession();
    assert.match(fresh, /^starpi_[\w-]+$/);
    assert.equal(local.getItem(STORAGE_KEYS.sessionId), fresh);
    assert.deepEqual(await facade.loadCurrentSession(), []);
    const store = await facade.chatData();
    assert.equal(await store.getConversation(fresh), undefined, 'an empty chat leaves no record');

    await facade.persistMessage(fresh, { role: 'user', content: 'New topic', sources: [], metadata: { chat_mode: 'free' } }, { localOnly: false });
    assert.equal((await store.getConversation(fresh))?.mode, 'free');
    assert.equal((await store.getConversation(fresh))?.title, 'New topic');

    facade.switchSession(SID);
    facade.switchSession(SID);
    assert.equal((await facade.loadCurrentSession()).length, 5);
    assert.throws(() => facade.switchSession('../evil'), TypeError);
    off();
    facade.startNewSession();
    assert.deepEqual(seen, [fresh, SID]);
  });

  it('maps rows to nodes and back', () => {
    const node = facade.rowToNode({ role: 'assistant', content: 'A', sources: [], metadata: { engine: 'nvidia', model: 'm', chat_mode: 'free', local_only: true }, created_at: '2026-10-17T08:00:00.000Z' }, false);
    assert.deepEqual(node, {
      role: 'assistant',
      parts: [{ type: 'text', text: 'A' }],
      model: 'm',
      label: 'free',
      sources: [],
      localOnly: false,
      meta: { engine: 'nvidia', model: 'm', chat_mode: 'free' },
      createdAt: Date.parse('2026-10-17T08:00:00.000Z'),
    });
    const row = facade.nodeToRow(
      { id: 'n', conversationId: 'c', parentId: null, role: 'assistant', parts: [{ type: 'text', text: 'B' }], opaque: [], model: 'x', provider: 'openai', label: 'grounded', usage: null, localOnly: true, createdAt: 0 },
      (n) => String(n.parts[0].text),
    );
    assert.deepEqual(row, { role: 'assistant', content: 'B', sources: [], metadata: { model: 'x', chat_mode: 'grounded', local_only: true }, created_at: '1970-01-01T00:00:00.000Z' });
  });
});
