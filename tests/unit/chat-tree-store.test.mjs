// The conversation store on IndexedDB: conversations CRUD, append-only messages (edit and
// regenerate add siblings, a stored message never changes), the active leaf, metadata attached
// later, attachments, cascading deletes, imports under fresh ids, change events in this tab and in
// another one, and calls that run in the order they were made.
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { branchInfo, switchBranch } from '../../src/js/chat/tree.js';
import { createChatStore, titleFromText } from '../../src/js/chat/store.js';
import { openAppDb } from '../../src/js/store/schema.js';

let seq = 0;

/**
 * A store on its own fresh database, with a clock and ids the test controls.
 * @param {{ factory?: IDBFactory | null, channel?: string, name?: string }} [opts]
 */
function setup(opts = {}) {
  const name = opts.name ?? `chat-store-test-${(seq += 1)}`;
  const factory = opts.factory === undefined ? new IDBFactory() : opts.factory;
  /** @type {Promise<import('../../src/js/store/idb.js').StoreDb> | null} */
  let db = null;
  const open = () => (db ??= openAppDb({ name, factory }));
  let clock = Date.parse('2026-10-17T09:00:00Z');
  let ids = 0;
  const store = createChatStore({ open, now: () => clock, uuid: () => `id-${(ids += 1)}`, channel: opts.channel ?? null });
  return {
    store,
    open,
    /** @param {number} ms */
    tick: (ms) => (clock += ms),
  };
}

/** @param {string} text */
const text = (text) => [{ type: 'text', text }];

describe('conversations', () => {
  it('creates, lists (pinned first, then recent), updates and deletes conversations', async () => {
    const { store, tick } = setup();
    const a = await store.createConversation({ mode: 'free' });
    tick(1000);
    const b = await store.createConversation({ title: '  Trip   planning  ', model: 'model-x', projectId: 'p1' });
    assert.match(a.id, /^starpi_id-\d+$/);
    assert.deepEqual(
      { ...b, id: '' },
      { id: '', title: 'Trip planning', createdAt: b.createdAt, updatedAt: b.createdAt, pinned: 0, archived: 0, activeLeafId: null, model: 'model-x', mode: 'auto', projectId: 'p1' },
    );
    assert.deepEqual((await store.listConversations()).map((c) => c.id), [b.id, a.id]);

    await store.updateConversation(a.id, { pinned: true, title: 'Pinned one' });
    assert.deepEqual((await store.listConversations()).map((c) => c.id), [a.id, b.id]);
    const moved = await store.updateConversation(b.id, { projectId: null, archived: true });
    assert.equal('projectId' in moved, false);
    assert.equal(moved.updatedAt, b.updatedAt, 'renaming or moving does not reorder the list');
    assert.deepEqual((await store.listConversations()).map((c) => c.id), [a.id]);
    assert.equal((await store.listConversations({ includeArchived: true })).length, 2);

    await assert.rejects(store.updateConversation(a.id, /** @type {any} */ ({ activeLeafId: 'x' })), { code: 'data' });
    await assert.rejects(store.updateConversation(a.id, /** @type {any} */ ({ mode: 'loud' })), { code: 'data' });
    await assert.rejects(store.updateConversation('nope', { title: 'x' }), { code: 'not_found' });

    assert.equal(await store.deleteConversation(b.id), true);
    assert.equal(await store.deleteConversation(b.id), false);
    assert.equal(await store.getConversation(b.id), undefined);
  });

  it('titles a conversation after its first question', async () => {
    const { store } = setup();
    const c = await store.createConversation();
    await store.appendNode(c.id, { parentId: null, role: 'user', parts: text('\n  How do   tides work?\nPlease keep it short.') });
    assert.equal((await store.getConversation(c.id))?.title, 'How do tides work?');
    assert.equal(titleFromText('x'.repeat(100)).length, 60);
    const named = await store.createConversation({ title: 'Kept' });
    await store.appendNode(named.id, { parentId: null, role: 'user', parts: text('Something else') });
    assert.equal((await store.getConversation(named.id))?.title, 'Kept');
  });
});

describe('message tree', () => {
  it('appends nodes, makes them the active leaf and keeps parts and provider state exactly as given', async () => {
    const { store, tick } = setup();
    const c = await store.createConversation({ mode: 'free' });
    const parts = [{ type: 'text', text: 'Hi' }, { type: 'image', mime: 'image/png', data: 'iVBORw0KGgo=', name: 'dot.png' }];
    const q = await store.appendNode(c.id, { parentId: null, role: 'user', parts });
    tick(500);
    const opaque = [{ type: 'opaque', provider: 'anthropic', model: 'model-a', block: { type: 'thinking', thinking: 'hm', signature: 'sig==' } }];
    const a = await store.appendNode(c.id, { parentId: q.id, role: 'assistant', parts: text('Hello!'), opaque, model: 'model-a', provider: 'anthropic', label: 'free', usage: { input: 10, output: 3 } });
    const stored = await store.getNode(a.id);
    assert.deepEqual(stored?.opaque, opaque);
    assert.deepEqual((await store.getNode(q.id))?.parts, parts);
    assert.equal(stored?.localOnly, false);
    const conversation = await store.getConversation(c.id);
    assert.equal(conversation?.activeLeafId, a.id);
    assert.equal(conversation?.updatedAt, a.createdAt);

    const thread = await store.loadThread(c.id);
    assert.deepEqual(thread?.path.map((n) => n.id), [q.id, a.id]);
    assert.equal(await store.loadThread('missing'), null);
  });

  it('adds siblings for edits and regenerations and never changes a stored node', async () => {
    const { store } = setup();
    const c = await store.createConversation();
    const q = await store.appendNode(c.id, { parentId: null, role: 'user', parts: text('Name a colour') });
    const a1 = await store.appendNode(c.id, { parentId: q.id, role: 'assistant', parts: text('Blue') });
    const before = await store.getNodes(c.id);

    const a2 = await store.addSibling(a1.id, { role: 'assistant', parts: text('Green'), model: 'other-model' });
    const q2 = await store.addSibling(q.id, { role: 'user', parts: text('Name a fruit') });
    assert.equal(a2.parentId, q.id);
    assert.equal(q2.parentId, null);

    const after = await store.getNodes(c.id);
    for (const node of before) assert.deepEqual(after.find((n) => n.id === node.id), node, `${node.id} is unchanged`);
    assert.equal(after.length, 4);

    const thread = await store.loadThread(c.id);
    assert.ok(thread);
    assert.deepEqual(thread.path.map((n) => n.id), [q2.id]);
    assert.deepEqual(branchInfo(thread.tree, a2.id), { position: 2, count: 2, previous: a1.id, next: null });

    // Back to the first answer: ‹ 1/2 ›.
    const leaf = switchBranch(thread.tree, q2.id, -1);
    assert.equal(leaf, a2.id, 'the first question continues on its newest answer');
    await store.setActiveLeaf(c.id, /** @type {string} */ (leaf));
    assert.deepEqual((await store.loadThread(c.id))?.path.map((n) => n.id), [q.id, a2.id]);

    // An id that exists is refused instead of replacing the stored node.
    await assert.rejects(store.appendNode(c.id, { id: a1.id, parentId: q.id, role: 'assistant', parts: text('Overwrite') }), { code: 'constraint' });
    assert.deepEqual((await store.getNode(a1.id))?.parts, text('Blue'));
  });

  it('refuses broken messages and parents of another conversation', async () => {
    const { store } = setup();
    const c = await store.createConversation();
    const other = await store.createConversation();
    const q = await store.appendNode(other.id, { parentId: null, role: 'user', parts: text('elsewhere') });
    await assert.rejects(store.appendNode(c.id, { parentId: q.id, role: 'assistant', parts: text('x') }), { code: 'data' });
    await assert.rejects(store.appendNode(c.id, { parentId: 'nope', role: 'assistant', parts: text('x') }), { code: 'data' });
    await assert.rejects(store.appendNode(c.id, /** @type {any} */ ({ parentId: null, role: 'robot', parts: text('x') })), { code: 'data' });
    await assert.rejects(store.appendNode(c.id, /** @type {any} */ ({ parentId: null, role: 'user', parts: [{ text: 'no type' }] })), { code: 'data' });
    await assert.rejects(store.appendNode('missing', { parentId: null, role: 'user', parts: text('x') }), { code: 'not_found' });
    await assert.rejects(store.setActiveLeaf(c.id, q.id), { code: 'data' });
    assert.deepEqual(await store.getNodes(c.id), []);
  });

  it('attaches metadata later but never parts, provider state or the place in the tree', async () => {
    const { store } = setup();
    const c = await store.createConversation();
    const q = await store.appendNode(c.id, { parentId: null, role: 'user', parts: text('Q'), meta: { engine: 'cloud' } });
    const done = await store.annotateNode(q.id, { receiptId: 'r-1', grounding: { verdict: 'ok' }, meta: { duration_ms: 12 } });
    assert.equal(done.receiptId, 'r-1');
    assert.deepEqual(done.meta, { engine: 'cloud', duration_ms: 12 });
    for (const field of ['parts', 'opaque', 'role', 'parentId', 'conversationId', 'createdAt', 'localOnly']) {
      await assert.rejects(store.annotateNode(q.id, /** @type {any} */ ({ [field]: [] })), { code: 'data' }, field);
    }
    assert.deepEqual((await store.getNode(q.id))?.parts, text('Q'));
  });

  it('continues the active thread and creates the conversation on its first message', async () => {
    const { store } = setup();
    const q = await store.appendToActive('starpi_session-1', { role: 'user', parts: text('First'), localOnly: true }, { create: { mode: 'grounded' } });
    const a = await store.appendToActive('starpi_session-1', { role: 'assistant', parts: text('Answer') });
    assert.equal(q.parentId, null);
    assert.equal(a.parentId, q.id);
    const c = await store.getConversation('starpi_session-1');
    assert.equal(c?.mode, 'grounded');
    assert.equal(c?.title, 'First');
    assert.equal(c?.activeLeafId, a.id);
    assert.equal((await store.getNode(q.id))?.localOnly, true);
    await assert.rejects(store.appendToActive('starpi_unknown', { role: 'user', parts: text('x') }), { code: 'not_found' });
  });

  it('runs calls in the order they were made, so unawaited writes form a chain', async () => {
    const { store } = setup();
    const writes = ['one', 'two', 'three', 'four'].map((t, i) => store.appendToActive('starpi_order', { role: i % 2 ? 'assistant' : 'user', parts: text(t) }, { create: {} }));
    const thread = await store.loadThread('starpi_order');
    await Promise.all(writes);
    assert.deepEqual(thread?.path.map((n) => n.parts[0].text), ['one', 'two', 'three', 'four']);
    // A failed call does not stop the ones after it.
    const failed = store.appendNode('nope', { parentId: null, role: 'user', parts: text('x') });
    const next = store.createConversation();
    await assert.rejects(failed);
    assert.ok(await next);
  });
});

describe('attachments and deletes', () => {
  it('stores attachments and deletes them, the messages and the artifacts with their conversation', async () => {
    const { store, open } = setup();
    const keep = await store.createConversation();
    const c = await store.createConversation();
    const q = await store.appendNode(c.id, { parentId: null, role: 'user', parts: text('see file') });
    const kept = await store.appendNode(keep.id, { parentId: null, role: 'user', parts: text('other') });
    const blobId = await store.putBlob(new Blob(['hello'], { type: 'text/plain' }), { name: 'a.txt', ownerId: q.id });
    const otherBlob = await store.putBlob(new Blob(['x']), { ownerId: kept.id, kind: 'thumbnail' });
    assert.equal((await store.getBlob(blobId))?.size, 5);
    assert.equal((await store.getBlob(blobId))?.type, 'text/plain');
    const db = await open();
    await db.put('artifacts', { id: 'art-1', conversationId: c.id, nodeId: q.id, type: 'code', title: 'x', versions: [] });
    await db.put('blobs', { id: 'workspace-file', data: new Blob(['pdf']), type: 'application/pdf', size: 3, kind: 'file', createdAt: 1 });

    await store.deleteConversation(c.id);
    assert.equal(await store.getBlob(blobId), undefined);
    assert.equal(await store.getNode(q.id), undefined);
    assert.equal(await db.get('artifacts', 'art-1'), undefined);
    assert.ok(await store.getBlob(otherBlob));
    assert.ok(await store.getNode(kept.id));

    // Deleting everything keeps workspace originals.
    await store.clearConversations();
    assert.deepEqual(await store.listConversations({ includeArchived: true }), []);
    assert.equal(await store.getBlob(otherBlob), undefined);
    assert.ok(await db.get('blobs', 'workspace-file'));
  });

  it('works on the in-memory stand-in when IndexedDB is missing', async () => {
    const { store, open } = setup({ factory: null });
    const c = await store.createConversation();
    await store.appendNode(c.id, { parentId: null, role: 'user', parts: text('kept for this page') });
    assert.equal((await open()).persistent, false);
    assert.equal((await store.loadThread(c.id))?.path.length, 1);
  });
});

describe('imports, search helpers and projects', () => {
  it('imports a conversation under fresh ids, keeping its tree and its active leaf', async () => {
    const { store } = setup();
    const existing = await store.createConversation({ id: 'starpi_taken' });
    const imported = await store.importConversation({
      conversation: { id: existing.id, title: '', mode: 'free', activeLeafId: 'b' },
      nodes: [
        { id: 'q', parentId: null, role: 'user', parts: text('Imported question'), createdAt: 10, localOnly: true },
        { id: 'a', parentId: 'q', role: 'assistant', parts: text('A'), createdAt: 20 },
        { id: 'b', parentId: 'q', role: 'assistant', parts: text('B'), createdAt: 30 },
        { id: 'stray', parentId: 'not-in-file', role: 'user', parts: text('Stray'), createdAt: 5 },
      ],
    });
    assert.notEqual(imported.id, existing.id);
    assert.equal(imported.title, 'Stray');
    const thread = await store.loadThread(imported.id);
    assert.ok(thread);
    assert.deepEqual(thread.path.map((n) => n.parts[0].text), ['Imported question', 'B']);
    assert.ok(thread.nodes.every((n) => !['q', 'a', 'b', 'stray'].includes(n.id)));
    assert.equal(thread.nodes.find((n) => n.parts[0].text === 'Stray')?.parentId, null);
    await assert.rejects(store.importConversation({ conversation: {}, nodes: [{ id: 'x', parentId: null, role: 'user', parts: text('1') }, { id: 'x', parentId: null, role: 'user', parts: text('2') }] }), { code: 'data' });
  });

  it('finds the first question of every conversation and lists projects by name', async () => {
    const { store, open, tick } = setup();
    const c = await store.createConversation();
    const q = await store.appendNode(c.id, { parentId: null, role: 'user', parts: text('Original question') });
    tick(10);
    await store.addSibling(q.id, { role: 'user', parts: text('Edited question') });
    const empty = await store.createConversation();
    assert.deepEqual([...(await store.firstUserTurns())], [[c.id, 'Original question']]);
    assert.equal(await store.firstUserTurn(c.id), 'Original question');
    assert.equal(await store.firstUserTurn(empty.id), '');

    assert.deepEqual(await store.listProjects(), []);
    const db = await open();
    await db.putMany('projects', [
      { id: 'p2', name: 'Zeta', instructions: '', defaultModel: null, docIds: [], memoryScope: 'off', createdAt: 1, updatedAt: 1 },
      { id: 'p1', name: 'Alpha', instructions: '', defaultModel: null, docIds: [], memoryScope: 'off', createdAt: 1, updatedAt: 1 },
    ]);
    assert.deepEqual(await store.listProjects(), [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Zeta' },
    ]);
  });
});

describe('change events', () => {
  it('reports changes to listeners in this tab and to other tabs', async () => {
    const channel = `chat-test-${(seq += 1)}`;
    const name = `chat-store-shared-${seq}`;
    const factory = new IDBFactory();
    const a = setup({ channel, name, factory });
    const b = setup({ channel, name, factory });
    /** @type {any[]} */
    const local = [];
    /** @type {any[]} */
    const remote = [];
    const off = a.store.onChange((e) => local.push(e));
    b.store.onChange((e) => remote.push(e));

    const c = await a.store.createConversation();
    const q = await a.store.appendNode(c.id, { parentId: null, role: 'user', parts: text('hi') });
    await a.store.deleteConversation(c.id);
    await a.store.clearConversations();
    assert.deepEqual(local, [
      { kind: 'conversation', op: 'put', id: c.id },
      { kind: 'node', op: 'put', id: q.id, conversationId: c.id },
      { kind: 'conversation', op: 'put', id: c.id },
      { kind: 'conversation', op: 'delete', id: c.id },
      { kind: 'all' },
    ]);
    for (let i = 0; i < 50 && remote.length < local.length; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      remote,
      local.map((e) => ({ ...e, remote: true })),
    );

    off();
    a.store.notify({ kind: 'all' });
    assert.equal(local.length, 5);
    a.store.close();
    b.store.close();
  });

  it('keeps notifying when a listener throws', async () => {
    const { store } = setup();
    /** @type {string[]} */
    const seen = [];
    const errors = console.error;
    console.error = () => {};
    try {
      store.onChange(() => {
        throw new Error('listener bug');
      });
      store.onChange((e) => seen.push(e.kind));
      await store.createConversation();
    } finally {
      console.error = errors;
    }
    assert.deepEqual(seen, ['conversation']);
  });
});
