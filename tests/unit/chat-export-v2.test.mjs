// Chat export v2 and import: the tree format (every node, the active path, model, provider and label
// per node, attachments as metadata without their bytes, never credentials or internal flags), the
// Markdown of the active path, and an importer that reads v1 and v2, repairs damaged trees and
// refuses what is not a chat.
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  CHAT_EXPORT_V1,
  CHAT_EXPORT_V2,
  ChatImportError,
  chatToJson,
  chatToJsonV2,
  conversationToV2,
  exportConversation,
  IMPORT_MAX_NODES,
  parseChatImport,
  pathToTurns,
  turnsToThread,
} from '../../src/js/chat/export.js';
import { CHAT_EXPORT_SCHEMA, CHAT_EXPORT_V2 as FACADE_V2, exportFileName } from '../../src/js/chat-export.js';
import { createChatStore } from '../../src/js/chat/store.js';
import { indexNodes, pathTo } from '../../src/js/chat/tree.js';
import { openAppDb } from '../../src/js/store/schema.js';

/** @typedef {import('../../src/js/store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../../src/js/store/schema.js').ConversationRecord} ConversationRecord */

const META = { exportedAt: '2026-10-17T10:00:00.000Z', version: '3.0.0-test', locale: 'en' };
const T0 = Date.parse('2026-10-17T09:00:00.000Z');

/**
 * @param {Partial<NodeRecord> & Pick<NodeRecord, 'id' | 'parentId' | 'role' | 'parts'>} fields
 * @returns {NodeRecord}
 */
function node(fields) {
  return { conversationId: 'starpi_conv-1', opaque: [], model: null, provider: null, label: null, usage: null, localOnly: false, createdAt: T0, ...fields };
}

/** @type {ConversationRecord} */
const CONVERSATION = { id: 'starpi_conv-1', title: 'Picture of a cat', createdAt: T0, updatedAt: T0 + 5000, pinned: 1, archived: 0, activeLeafId: 'a2', model: 'model-b', mode: 'free', projectId: 'project-9' };

const NODES = [
  node({ id: 'q1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'What is in this picture?' }, { type: 'image', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==', name: 'cat.png' }], localOnly: true, createdAt: T0 }),
  node({
    id: 'a1',
    parentId: 'q1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'A cat on a sofa.' }],
    model: 'model-a',
    provider: 'openai',
    label: 'free',
    usage: { input: 812, output: 9 },
    meta: { engine: 'cloud', thoughts: ['internal trace'] },
    createdAt: T0 + 1000,
  }),
  node({
    id: 'a2',
    parentId: 'q1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'A grey cat.' }, { type: 'tool_call', id: 't1', name: 'lookup', args: { query: 'cat', apiKey: 'sk-secret-123', nested: { Authorization: 'Bearer abc' } } }],
    opaque: [{ type: 'thinking', thinking: 'grey fur', signature: 'c2ln' }],
    model: 'model-b',
    provider: 'anthropic',
    label: 'free',
    receiptId: 'receipt-7',
    grounding: { verdict: 'none' },
    sources: [{ title: 'notes.md', rank: 0.5 }],
    createdAt: T0 + 2000,
  }),
];

describe('starpi.chat/v2 export', () => {
  const doc = conversationToV2({ conversation: CONVERSATION, nodes: [...NODES].reverse() }, META);

  it('has the schema, the generator, the conversation, the active path and every node in time order', () => {
    assert.equal(CHAT_EXPORT_V2, 'starpi.chat/v2');
    assert.equal(FACADE_V2, CHAT_EXPORT_V2);
    assert.deepEqual(Object.keys(doc), ['schema', 'generator', 'exportedAt', 'locale', 'conversation', 'activePath', 'nodes']);
    assert.deepEqual(doc.generator, { name: 'starpi', version: '3.0.0-test' });
    assert.deepEqual(doc.conversation, {
      id: 'starpi_conv-1',
      title: 'Picture of a cat',
      createdAt: '2026-10-17T09:00:00.000Z',
      updatedAt: '2026-10-17T09:00:05.000Z',
      pinned: true,
      model: 'model-b',
      mode: 'free',
      activeLeafId: 'a2',
    });
    assert.deepEqual(doc.activePath, ['q1', 'a2']);
    assert.deepEqual(
      doc.nodes.map((n) => n.id),
      ['q1', 'a1', 'a2'],
    );
  });

  it('records model, provider, label, engine and usage per node', () => {
    const a1 = doc.nodes[1];
    assert.deepEqual(a1, {
      id: 'a1',
      parentId: 'q1',
      role: 'assistant',
      createdAt: '2026-10-17T09:00:01.000Z',
      parts: [{ type: 'text', text: 'A cat on a sofa.' }],
      model: 'model-a',
      provider: 'openai',
      label: 'free',
      engine: 'cloud',
      usage: { input: 812, output: 9 },
    });
    assert.deepEqual(doc.nodes[2].opaque, [{ type: 'thinking', thinking: 'grey fur', signature: 'c2ln' }]);
    assert.deepEqual(doc.nodes[2].sources, [{ title: 'notes.md', rank: 0.5 }]);
  });

  it('keeps attachments as metadata and leaves their bytes on the device', () => {
    const q1 = doc.nodes[0];
    assert.deepEqual(q1.parts[1], { type: 'image', mime: 'image/png', name: 'cat.png', omitted: true });
    assert.deepEqual(q1.attachments, [{ type: 'image', name: 'cat.png', mime: 'image/png', size: 18 }]);
  });

  it('never writes credentials, internal flags or local references', () => {
    const text = chatToJsonV2({ conversation: CONVERSATION, nodes: NODES }, META);
    assert.ok(text.endsWith('}\n'));
    for (const leak of ['sk-secret-123', 'Bearer abc', 'apiKey', 'Authorization', 'localOnly', 'local_only', 'receipt-7', 'receiptId', 'project-9', 'internal trace', 'iVBORw0KGgo']) {
      assert.equal(text.includes(leak), false, leak);
    }
    assert.deepEqual(JSON.parse(text).nodes[2].parts[1], { type: 'tool_call', id: 't1', name: 'lookup', args: { query: 'cat', nested: {} } });
  });

  it('exports the active path as Markdown, attachment names included', async () => {
    const path = pathTo(indexNodes(NODES), 'a2');
    const turns = pathToTurns(path);
    assert.deepEqual(turns, [
      { role: 'user', content: 'What is in this picture?\n\n[cat.png]', createdAt: '2026-10-17T09:00:00.000Z', engine: null, model: null, chatMode: null },
      { role: 'assistant', content: 'A grey cat.', createdAt: '2026-10-17T09:00:02.000Z', engine: null, model: 'model-b', chatMode: 'free' },
    ]);
    const store = { loadThread: async (/** @type {string} */ id) => (id === CONVERSATION.id ? { conversation: CONVERSATION, nodes: NODES, path } : null) };
    const labels = { title: 'Chat', subtitle: 'Exported', user: 'You', assistant: (/** @type {any} */ t) => `Starpi · ${t.model}` };
    const md = await exportConversation(store, CONVERSATION.id, { format: 'md', meta: META, labels });
    assert.deepEqual(md, {
      name: 'starpi-chat-2026-10-17-conv-1.md',
      type: 'text/markdown;charset=utf-8',
      text: '# Chat\n\n_Exported_\n\n## You\n\nWhat is in this picture?\n\n[cat.png]\n\n## Starpi · model-b\n\nA grey cat.\n',
    });
    const json = await exportConversation(store, CONVERSATION.id, { format: 'json', meta: META });
    assert.equal(json?.type, 'application/json');
    assert.equal(JSON.parse(json?.text ?? '').schema, CHAT_EXPORT_V2);
    assert.equal(await exportConversation(store, 'other', { format: 'json', meta: META }), null);
  });

  it('turns the turns on screen into a linear thread when nothing is stored', () => {
    const thread = turnsToThread('starpi_x', [
      { role: 'user', content: 'Hi there', createdAt: '2026-10-17T09:00:00.000Z', engine: null, model: null, chatMode: 'free' },
      { role: 'assistant', content: 'Hello', createdAt: null, engine: 'cloud', model: null, chatMode: 'free' },
    ]);
    const v2 = conversationToV2(thread, META);
    assert.deepEqual(v2.activePath, ['m0', 'm1']);
    assert.equal(v2.conversation.title, 'Hi there');
    assert.equal(v2.nodes[1].engine, 'cloud');
    assert.equal(v2.nodes[1].label, 'free');
  });
});

describe('import', () => {
  it('reads a v2 export back into the same tree', async () => {
    const parsed = parseChatImport(chatToJsonV2({ conversation: CONVERSATION, nodes: NODES }, META));
    assert.equal(parsed.schema, CHAT_EXPORT_V2);
    assert.equal(parsed.conversation.activeLeafId, 'a2');
    assert.equal(parsed.conversation.title, 'Picture of a cat');
    assert.equal(parsed.conversation.pinned, true);
    assert.equal(parsed.nodes.length, 3);
    assert.ok(parsed.nodes.every((n) => n.localOnly === true), 'an imported chat is never resent to a provider');
    assert.deepEqual(parsed.nodes[1].meta, { engine: 'cloud' });
    assert.deepEqual(parsed.nodes[2].opaque, [{ type: 'thinking', thinking: 'grey fur', signature: 'c2ln' }]);

    const name = 'chat-import-test';
    /** @type {Promise<import('../../src/js/store/idb.js').StoreDb> | null} */
    let db = null;
    const store = createChatStore({ open: () => (db ??= openAppDb({ name, factory: new IDBFactory() })) });
    const imported = await store.importConversation(parsed);
    const thread = await store.loadThread(imported.id);
    assert.ok(thread);
    assert.deepEqual(
      thread.path.map((n) => n.parts[0].text),
      ['What is in this picture?', 'A grey cat.'],
    );
    assert.equal(thread.nodes.length, 3);
    // Exporting the imported chat gives the same messages (under the new ids).
    const again = conversationToV2(thread, META);
    assert.deepEqual(
      again.nodes.map((n) => [n.role, n.model, n.provider, n.label]),
      [
        ['user', null, null, null],
        ['assistant', 'model-a', 'openai', 'free'],
        ['assistant', 'model-b', 'anthropic', 'free'],
      ],
    );
  });

  it('reads a v1 export as one linear thread', () => {
    const v1 = chatToJson(
      [
        { role: 'user', content: 'Write hello world in Python.', createdAt: '2026-10-14T09:00:00.000Z', engine: null, model: null, chatMode: 'free' },
        { role: 'assistant', content: "print('hi')", createdAt: '2026-10-14T09:00:02.000Z', engine: 'client', model: 'small-model', chatMode: 'free' },
        { role: 'user', content: 'Thanks', createdAt: null, engine: null, model: null, chatMode: 'grounded' },
      ],
      { sessionId: 'starpi_old', exportedAt: META.exportedAt, version: '2.1.0', locale: 'de' },
    );
    assert.equal(CHAT_EXPORT_SCHEMA, CHAT_EXPORT_V1);
    const parsed = parseChatImport(v1);
    assert.equal(parsed.schema, CHAT_EXPORT_V1);
    assert.deepEqual(
      parsed.nodes.map((n) => [n.id, n.parentId, n.role, n.parts[0].text, n.model, n.label, n.meta]),
      [
        ['m0', null, 'user', 'Write hello world in Python.', null, null, { chat_mode: 'free' }],
        ['m1', 'm0', 'assistant', "print('hi')", 'small-model', 'free', { engine: 'client', chat_mode: 'free' }],
        ['m2', 'm1', 'user', 'Thanks', null, null, { chat_mode: 'grounded' }],
      ],
    );
    assert.equal(parsed.nodes[2].createdAt, Date.parse('2026-10-14T09:00:02.000Z'), 'a turn without a time follows the one before');
    assert.deepEqual(parsed.conversation, { mode: 'grounded', activeLeafId: 'm2', model: 'small-model' });
  });

  it('drops unknown parents and breaks cycles', () => {
    const doc = {
      schema: CHAT_EXPORT_V2,
      conversation: { activeLeafId: 'gone' },
      activePath: ['x', 'c'],
      nodes: [
        { id: 'a', parentId: 'c', role: 'user', parts: [{ type: 'text', text: 'a' }] },
        { id: 'b', parentId: 'a', role: 'assistant', parts: [{ type: 'text', text: 'b' }] },
        { id: 'c', parentId: 'b', role: 'user', parts: [{ type: 'text', text: 'c' }] },
        { id: 'd', parentId: 'nowhere', role: 'user', parts: [{ type: 'text', text: 'd' }] },
      ],
    };
    const parsed = parseChatImport(JSON.stringify(doc));
    const roots = parsed.nodes.filter((n) => n.parentId === null).map((n) => n.id);
    assert.equal(roots.length, 2);
    assert.ok(roots.includes('d'));
    assert.equal(parsed.conversation.activeLeafId, 'c', 'the end of the active path stands in for an unknown leaf');
  });

  it('refuses what is not a chat export, with a reason', () => {
    /** @param {string} text @param {string} code */
    const refuses = (text, code) => assert.throws(() => parseChatImport(text), (err) => err instanceof ChatImportError && err.code === code, code);
    refuses('not json', 'json');
    refuses('[]', 'schema');
    refuses(JSON.stringify({ schema: 'other/v1', messages: [] }), 'schema');
    refuses(JSON.stringify({ schema: CHAT_EXPORT_V1, messages: [{ role: 'system', content: 'x' }] }), 'empty');
    refuses(JSON.stringify({ schema: CHAT_EXPORT_V2, nodes: [] }), 'empty');
    refuses(JSON.stringify({ schema: CHAT_EXPORT_V2 }), 'schema');
    refuses(JSON.stringify({ schema: CHAT_EXPORT_V2, nodes: [{ id: 'a', parentId: null, role: 'user', parts: [{ type: 'text', text: 'x' }] }, { id: 'a', parentId: null, role: 'user', parts: [] }] }), 'invalid');
    refuses(JSON.stringify({ schema: CHAT_EXPORT_V2, nodes: [{ id: 'a', parentId: null, role: 'wizard', parts: [] }] }), 'invalid');
    refuses(JSON.stringify({ schema: CHAT_EXPORT_V2, nodes: [{ id: 'a', parentId: null, role: 'user', parts: [{ text: 'no type' }] }] }), 'invalid');
    refuses(JSON.stringify({ schema: CHAT_EXPORT_V2, nodes: Array.from({ length: IMPORT_MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, parentId: null, role: 'user', parts: [] })) }), 'too_large');
  });

  it('drops credentials found in an imported file', () => {
    const doc = { schema: CHAT_EXPORT_V2, nodes: [{ id: 'a', parentId: null, role: 'user', parts: [{ type: 'tool_call', id: 't', name: 'x', args: { api_key: 'sk-1', q: 'ok' } }] }] };
    const parsed = parseChatImport(JSON.stringify(doc));
    assert.deepEqual(parsed.nodes[0].parts, [{ type: 'tool_call', id: 't', name: 'x', args: { q: 'ok' } }]);
  });
});

describe('file names', () => {
  it('stay dated and safe through the compatibility module', () => {
    assert.equal(exportFileName('starpi_0f8fad5b-d9cb', '2026-10-17T00:00:00Z', 'json'), 'starpi-chat-2026-10-17-0f8fad5b.json');
  });
});
