// A conversation's context (chat/context.js) in a DOM (jsdom) with the app database in memory: a
// chat started in a project keeps its project on the draft across a reload before the first
// question (the module is loaded afresh, as a reload would), and gets it once it is stored; the
// memory_lookup tool finds nothing while memory is off and then only the matching notes of the
// scopes the conversation may use.
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS', 'DOMParser', 'getComputedStyle'];

const MARKUP = `<!doctype html><html><body>
  <div id="toastRegion"></div><span id="assistantStatusText"></span><p id="privacyNotice"></p>
  <div id="chatMessages"><div class="welcome">Welcome</div></div>
  <textarea id="chatInput"></textarea>
</body></html>`;

/** @type {JSDOM} */
let jsdom;
/** @type {typeof import('../../src/js/chat/context.js')} */
let context;
/** @type {typeof import('../../src/js/chat-store.js')} */
let chatStore;
/** @type {typeof import('../../src/js/chat/projects.js')} */
let projects;
/** @type {typeof import('../../src/js/ai/memory.js')} */
let memory;

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {() => boolean | Promise<boolean>} check */
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

before(async () => {
  jsdom = new JSDOM(MARKUP, { url: 'https://app.example/', pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: jsdom.window.navigator, configurable: true, writable: true });
  (await import('../../src/js/messages.js')).initMessages();
  chatStore = await import('../../src/js/chat-store.js');
  projects = await import('../../src/js/chat/projects.js');
  memory = await import('../../src/js/ai/memory.js');
  context = await import('../../src/js/chat/context.js');
});

after(async () => {
  // The stores talk to other tabs over channels: closed, the test process can end.
  (await chatStore.chatData()).close();
  projects.projectStore().close();
  (await import('../../src/js/chat/assistants.js')).assistantStore().close();
  memory.memoryStore().close();
  jsdom.window.close();
});

describe('a chat started in a project', () => {
  it('keeps its project on the draft across a reload before the first question, and gets it once stored', async () => {
    const project = await projects.projectStore().create({ name: 'Garden', instructions: 'Answer like a gardener.', docIds: ['doc-garden'], memoryScope: 'project' });
    await context.startChat({ projectId: project.id });
    const id = chatStore.currentSessionId();
    assert.deepEqual(JSON.parse(localStorage.getItem(context.DRAFTS_KEY) ?? '[]'), [[id, { projectId: project.id }]], 'kept with the draft in this browser');
    // A reload: the module reads its drafts again.
    const reloaded = /** @type {typeof import('../../src/js/chat/context.js')} */ (await import('../../src/js/chat/context.js?reload'));
    assert.equal((await reloaded.contextOf(id)).project?.name, 'Garden');
    assert.deepEqual(await reloaded.workspaceScope(id), ['doc-garden'], "the project's files scope its questions");
    assert.match(await reloaded.systemNote({ conversationId: id, question: 'Hi', mode: 'free', route: 'free', target: null, locale: 'en', attachments: [] }), /Answer like a gardener\./);
    // The first question stores the conversation: it gets its project, and the draft is gone.
    await reloaded.startContext({ toast: () => () => {} });
    const chats = await chatStore.chatData();
    await chats.appendToActive(id, { role: 'user', parts: [{ type: 'text', text: 'When do I plant tulips?' }] }, { create: { mode: 'free' } });
    await until(async () => (await chats.getConversation(id))?.projectId === project.id);
    await until(() => JSON.parse(localStorage.getItem(context.DRAFTS_KEY) ?? '[]').length === 0);
  });

  it('drops a draft left without a question once another chat is on screen', async () => {
    localStorage.setItem(context.DRAFTS_KEY, JSON.stringify([['starpi_left-behind-draft', { projectId: 'project_x' }], ['not a session', { projectId: 'project_y' }]]));
    const reloaded = /** @type {typeof import('../../src/js/chat/context.js')} */ (await import('../../src/js/chat/context.js?reload-2'));
    await reloaded.startContext({ toast: () => () => {} });
    await until(() => JSON.parse(localStorage.getItem(context.DRAFTS_KEY) ?? '[]').length === 0);
  });
});

describe('the memory_lookup tool', () => {
  it('finds nothing while memory is off, then only the matching notes the conversation may use', async () => {
    const store = memory.memoryStore();
    const project = await projects.projectStore().create({ name: 'Bees', memoryScope: 'project' });
    await store.add({ text: 'Keeps three bee hives behind the house.', scope: project.id, source: 'explicit' });
    await store.add({ text: 'Prefers bee stories in German.', scope: 'global', source: 'explicit' });
    await store.add({ text: 'Has a dog called Rex.', scope: project.id, source: 'explicit' });
    const chats = await chatStore.chatData();
    const inProject = await chats.createConversation({ mode: 'free', projectId: project.id });
    const outside = await chats.createConversation({ mode: 'free' });
    assert.deepEqual(await context.lookupNotes('bee hives', 8, inProject.id), [], 'memory is off by default');
    await store.setPrefs({ enabled: true });
    const found = await context.lookupNotes('bee hives', 8, inProject.id);
    assert.deepEqual(
      found.map((f) => f.text),
      ['Keeps three bee hives behind the house.'],
      'only the project notes (its memory is kept apart), and only those that match',
    );
    assert.match(found[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      (await context.lookupNotes('bee', 8, outside.id)).map((f) => f.text),
      ['Prefers bee stories in German.'],
      'outside the project, the global notes',
    );
    assert.deepEqual(await context.lookupNotes('   ', 8, outside.id), []);
    await store.setPrefs({ enabled: false });
  });
});
