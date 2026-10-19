// Projects (chat/projects.js) and assistants (chat/assistants.js): the stores with their field
// validation, the browser asked to keep the site's data on the first project only, deleting a
// project (its chats stay, its notes go), and the `starpi.assistant/v1` import and export with
// every field checked and no tool beyond web search and thinking (no code execution).
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createMemoryStore } from '../../src/js/ai/memory.js';
import {
  ASSISTANT_LIMITS,
  ASSISTANT_SCHEMA,
  ASSISTANT_TOOLS,
  AssistantError,
  assistantFields,
  assistantFileName,
  createAssistantStore,
  exportAssistant,
  parseAssistant,
} from '../../src/js/chat/assistants.js';
import { createProjectStore, MODEL_VALUE, PROJECT_LIMITS, ProjectError, projectFields, removeProject } from '../../src/js/chat/projects.js';
import { createChatStore } from '../../src/js/chat/store.js';
import { openAppDb } from '../../src/js/store/schema.js';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
let seq = 0;

async function freshDb() {
  return openAppDb({ name: `presets-test-${(seq += 1)}`, factory: new IDBFactory() });
}

describe('project fields', () => {
  it('need a name and keep every field within its limits', () => {
    assert.throws(() => projectFields({ name: '   ' }), (e) => e instanceof ProjectError && e.code === 'name');
    const f = projectFields({
      name: `  My\nthesis ${'x'.repeat(200)}`,
      instructions: `Cite sources.\r\n${'y'.repeat(5000)}`,
      defaultModel: 'anthropic:claude-sonnet-4-5',
      docIds: ['doc-1', 'doc-1', 'bad id!', 42, ...Array.from({ length: 80 }, (_, i) => `d${i}`)],
      memoryScope: /** @type {any} */ ('everything'),
    });
    assert.equal(f.name.length, PROJECT_LIMITS.nameChars);
    assert.ok(f.name.startsWith('My thesis'));
    assert.equal(f.instructions.length, PROJECT_LIMITS.instructionChars);
    assert.ok(f.instructions.startsWith('Cite sources.\n'));
    assert.equal(f.defaultModel, 'anthropic:claude-sonnet-4-5');
    assert.equal(f.docIds.length, PROJECT_LIMITS.docs);
    assert.equal(f.docIds[0], 'doc-1');
    assert.ok(!f.docIds.includes('bad id!'));
    assert.equal(f.memoryScope, 'global');
  });

  it('keep a model only when it is a picker value', () => {
    for (const ok of ['auto', 'device', 'local:*', 'openai:gpt-5', 'nvidia:meta/llama-3.3-70b-instruct']) assert.ok(MODEL_VALUE.test(ok), ok);
    for (const bad of ['', 'gpt-5', 'openai:', 'javascript:alert(1)//', 'a b:c', 'Open AI:x']) assert.equal(projectFields({ name: 'P', defaultModel: bad }).defaultModel, null, bad);
  });
});

describe('project store', () => {
  it('creates, lists by name, updates and removes projects; asks to keep the data on the first one only', async () => {
    const db = await freshDb();
    let persisted = 0;
    let ids = 0;
    const store = createProjectStore({ open: async () => db, now: () => NOW, uuid: () => `u${(ids += 1)}`, persist: () => (persisted += 1) });
    let changes = 0;
    store.onChange(() => (changes += 1));
    const b = await store.create({ name: 'Garden' });
    const a = await store.create({ name: 'Archive of letters', memoryScope: 'project', docIds: ['doc-a'] });
    assert.equal(persisted, 1);
    assert.equal(b.id, 'project_u1');
    assert.deepEqual(
      (await store.list()).map((p) => p.name),
      ['Archive of letters', 'Garden'],
    );
    const updated = await store.update(a.id, { instructions: 'Formal tone.', memoryScope: 'off' });
    assert.equal(updated.instructions, 'Formal tone.');
    assert.equal(updated.memoryScope, 'off');
    assert.deepEqual(updated.docIds, ['doc-a']);
    await assert.rejects(store.update('missing', { name: 'x' }), (e) => e instanceof ProjectError && e.code === 'not_found');
    await assert.rejects(store.update(a.id, { name: '' }), (e) => e instanceof ProjectError && e.code === 'name');
    assert.equal(await store.remove(a.id), true);
    assert.equal(await store.remove(a.id), false);
    assert.equal(await store.get(a.id), null);
    assert.equal(changes, 4);
  });

  it('feeds the conversation list its "Move to project" entries', async () => {
    const db = await freshDb();
    const projects = createProjectStore({ open: async () => db, persist: () => {} });
    const chats = createChatStore({ open: async () => db });
    assert.deepEqual(await chats.listProjects(), []);
    const p = await projects.create({ name: 'Thesis' });
    assert.deepEqual(await chats.listProjects(), [{ id: p.id, name: 'Thesis' }]);
  });

  it('deletes a project: its chats stay without a project, the notes saved for it go', async () => {
    const db = await freshDb();
    const projects = createProjectStore({ open: async () => db, persist: () => {} });
    const chats = createChatStore({ open: async () => db });
    const memory = createMemoryStore({ open: async () => db });
    const p = await projects.create({ name: 'Thesis' });
    const inside = await chats.createConversation({ title: 'Chapter 1', projectId: p.id });
    const archived = await chats.createConversation({ title: 'Old notes', projectId: p.id, archived: true });
    const outside = await chats.createConversation({ title: 'Elsewhere' });
    await memory.add({ text: 'The thesis is about tides', scope: p.id, source: 'explicit' });
    await memory.add({ text: 'I like tea', source: 'explicit' });
    const result = await removeProject(p.id, { projects, chats, removeNotes: (scope) => memory.removeScope(scope) });
    assert.deepEqual(result, { chats: 2 });
    for (const id of [inside.id, archived.id, outside.id]) assert.equal((await chats.getConversation(id))?.projectId, undefined);
    assert.equal(await projects.get(p.id), null);
    assert.deepEqual((await memory.list()).facts.map((f) => f.text), ['I like tea']);
  });
});

describe('assistant import and export', () => {
  const sample = {
    name: 'Latin tutor',
    icon: 'graduation-cap',
    instructions: 'Answer in simple Latin first, then in English.',
    model: 'gemini:gemini-2.5-flash',
    tools: ['web'],
    starters: ['Decline "rosa"', 'What is an ablative?'],
  };

  it('round-trips through starpi.assistant/v1', () => {
    const doc = exportAssistant(sample, { exportedAt: '2026-10-18T12:00:00.000Z', version: '3.0.0-test' });
    assert.equal(doc.schema, ASSISTANT_SCHEMA);
    assert.deepEqual(doc.generator, { name: 'starpi', version: '3.0.0-test' });
    const { fields, dropped } = parseAssistant(JSON.stringify(doc));
    assert.deepEqual(fields, sample);
    assert.deepEqual(dropped, []);
    assert.equal(assistantFileName('Latin tutor: Übungen!'), 'latin-tutor-ubungen.assistant.json');
    assert.equal(assistantFileName('???'), 'assistant.assistant.json');
  });

  it('refuses what is not an assistant file', () => {
    const code = (/** @type {string} */ text) => {
      try {
        parseAssistant(text);
        return 'ok';
      } catch (e) {
        assert.ok(e instanceof AssistantError);
        return e.code;
      }
    };
    assert.equal(code('not json'), 'json');
    assert.equal(code('[]'), 'schema');
    assert.equal(code(JSON.stringify({ schema: 'starpi.chat/v2', assistant: sample })), 'schema');
    assert.equal(code(JSON.stringify({ schema: ASSISTANT_SCHEMA })), 'invalid');
    assert.equal(code(JSON.stringify({ schema: ASSISTANT_SCHEMA, assistant: { ...sample, name: '  ' } })), 'fields');
    assert.equal(code(JSON.stringify({ schema: ASSISTANT_SCHEMA, assistant: { ...sample, instructions: '' } })), 'fields');
    assert.equal(code(JSON.stringify({ schema: ASSISTANT_SCHEMA, assistant: { ...sample, instructions: 'x'.repeat(ASSISTANT_LIMITS.fileBytes) } })), 'too_large');
  });

  it('never imports code execution or other unknown tools, and reports them', () => {
    const { fields, dropped } = parseAssistant(JSON.stringify({ schema: ASSISTANT_SCHEMA, assistant: { ...sample, tools: ['code_interpreter', 'web', 'thinking', 'python', 'web', 42], code: 'alert(1)', files: ['x'] } }));
    assert.deepEqual(fields.tools, ['web', 'thinking']);
    assert.deepEqual(dropped, ['code_interpreter', 'python', '42']);
    assert.ok(!('code' in fields) && !('files' in fields));
    assert.deepEqual(ASSISTANT_TOOLS, ['web', 'thinking', 'datetime', 'calculator', 'workspace_search', 'memory_lookup', 'web_search', 'generate_image']);
  });

  it("may switch on the chat's built-in tools, but an import does not bring those that read files or cost money", () => {
    const tools = ['web_search', 'workspace_search', 'generate_image', 'calculator', 'memory_lookup', 'mcp_Dictionary_define_word'];
    const imported = parseAssistant(JSON.stringify({ schema: ASSISTANT_SCHEMA, assistant: { ...sample, tools } }));
    assert.deepEqual(imported.fields.tools, ['calculator', 'memory_lookup', 'web_search']);
    assert.deepEqual(imported.dropped, ['workspace_search', 'generate_image', 'mcp_Dictionary_define_word']);
    // Ticked in the editor, they are kept; a tool of an MCP server never is.
    const edited = assistantFields({ ...sample, tools });
    assert.deepEqual(edited.fields.tools, ['calculator', 'workspace_search', 'memory_lookup', 'web_search', 'generate_image']);
    assert.deepEqual(edited.dropped, ['mcp_Dictionary_define_word']);
  });

  it('cuts every field to its limit and falls back for an unknown icon or model', () => {
    const { fields } = assistantFields({
      name: 'n'.repeat(200),
      icon: 'skull',
      instructions: 'i'.repeat(20_000),
      model: 'not a model',
      starters: ['  one  ', 'one', '', 'two', 'three', 'four', 'five', 's'.repeat(500)],
    });
    assert.equal(fields.name.length, ASSISTANT_LIMITS.nameChars);
    assert.equal(fields.icon, 'bot');
    assert.equal(fields.instructions.length, ASSISTANT_LIMITS.instructionChars);
    assert.equal(fields.model, null);
    assert.deepEqual(fields.starters, ['one', 'two', 'three', 'four']);
    assert.deepEqual(fields.tools, []);
  });
});

describe('assistant store', () => {
  it('creates, imports, updates and removes assistants', async () => {
    const db = await freshDb();
    let ids = 0;
    const store = createAssistantStore({ open: async () => db, now: () => NOW, uuid: () => `a${(ids += 1)}` });
    const made = await store.create({ name: 'Editor', instructions: 'Tighten my prose.' });
    assert.equal(made.id, 'assistant_a1');
    assert.equal(made.icon, 'bot');
    const { assistant, dropped } = await store.importText(JSON.stringify({ schema: ASSISTANT_SCHEMA, assistant: { name: 'Coach', instructions: 'Ask one question at a time.', tools: ['shell'] } }));
    assert.deepEqual(dropped, ['shell']);
    assert.deepEqual(assistant.tools, []);
    assert.deepEqual(
      (await store.list()).map((a) => a.name),
      ['Coach', 'Editor'],
    );
    const changed = await store.update(made.id, { starters: ['Shorten this'], tools: ['thinking'] });
    assert.deepEqual([changed.starters, changed.tools, changed.instructions], [['Shorten this'], ['thinking'], 'Tighten my prose.']);
    await assert.rejects(store.update(made.id, { instructions: '' }), (e) => e instanceof AssistantError && e.code === 'fields');
    await assert.rejects(store.importText('{'), (e) => e instanceof AssistantError && e.code === 'json');
    assert.equal(await store.remove(made.id), true);
    assert.equal(await store.get(made.id), null);
  });
});
