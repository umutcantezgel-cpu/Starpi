// The canvas: documents and versions (a titled block continues its document, an untitled one the
// open document of the same chat and language, equal content selects its version, the oldest
// versions go beyond the limit), the AI edit's question and context block (the passage marked, a
// long passage only in the context), what an answer says the passage becomes, and the panel in a
// DOM with the documents in an in-memory database: opening a block, a model's revision as version 2,
// a saved edit as version 3, choosing an older version, and "Edit with AI" replacing the selection.
/* global document, window */
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS', 'DOMParser', 'getComputedStyle', 'MutationObserver'];

/** @type {JSDOM} */
let jsdom;
/** @type {typeof import('../../src/js/chat/canvas.js')} */
let canvas;
/** @type {typeof import('../../src/js/chat/hooks.js')} */
let hooks;

before(async () => {
  jsdom = new JSDOM('<!doctype html><html><body><div id="toastRegion"></div><div id="chat-aside-canvas"></div></body></html>', { url: 'https://app.example/', pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: jsdom.window.navigator, configurable: true, writable: true });
  (await import('../../src/js/dom.js')).installDelegation();
  canvas = await import('../../src/js/chat/canvas.js');
  hooks = await import('../../src/js/chat/hooks.js');
});

after(() => {
  jsdom.window.close();
});

/** @param {Partial<import('../../src/js/chat/canvas.js').CanvasArtifact>} [over] @returns {import('../../src/js/chat/canvas.js').CanvasArtifact} */
const doc = (over = {}) => ({ id: 'a1', conversationId: 'c1', nodeId: 'n1', type: 'html', language: 'html', title: 'Landing page', versions: [{ content: '<h1>One</h1>', at: 1, by: 'model' }], updatedAt: 1, ...over });

describe('documents and versions', () => {
  it('knows the document types of the fence languages', () => {
    assert.equal(canvas.artifactType('HTML'), 'html');
    assert.equal(canvas.artifactType('mmd'), 'mermaid');
    assert.equal(canvas.artifactType('md'), 'markdown');
    assert.equal(canvas.artifactType('python'), 'code');
    assert.equal(canvas.artifactType(''), 'code');
  });

  it('continues a document by title within its chat and type, an untitled block the open one', () => {
    const titled = doc();
    const other = doc({ id: 'a2', title: 'Logo', type: 'svg', language: 'svg' });
    const block = { code: '<h1>Two</h1>', language: 'html', title: 'landing PAGE', conversationId: 'c1' };
    assert.equal(canvas.matchArtifact([other, titled], block, null)?.id, 'a1');
    assert.equal(canvas.matchArtifact([titled], { ...block, conversationId: 'c2' }, null), null, 'another chat starts its own document');
    assert.equal(canvas.matchArtifact([titled], { ...block, language: 'svg' }, null), null, 'another type too');
    const open = doc({ id: 'a3', title: '', language: 'python', type: 'code' });
    const untitled = { code: 'print(2)', language: 'python', title: '', conversationId: 'c1' };
    assert.equal(canvas.matchArtifact([open], untitled, open)?.id, 'a3');
    assert.equal(canvas.matchArtifact([open], { ...untitled, language: 'js' }, open), null);
    assert.equal(canvas.matchArtifact([open], untitled, null), null, 'without an open document an untitled block is new');
  });

  it('adds a version only when the content changed, and keeps the first and the newest ones', () => {
    const one = doc();
    const same = canvas.withVersion(one, { content: '<h1>One</h1>', at: 2, by: 'you' });
    assert.equal(same.added, false);
    assert.equal(same.index, 0);
    const two = canvas.withVersion(one, { content: '<h1>Two</h1>', at: 3, by: 'model', nodeId: 'n2' });
    assert.equal(two.added, true);
    assert.equal(two.index, 1);
    assert.equal(two.artifact.updatedAt, 3);
    assert.equal(one.versions.length, 1, 'the record given is left as it was');
    let many = two.artifact;
    for (let i = 0; i < canvas.MAX_VERSIONS + 5; i += 1) many = canvas.withVersion(many, { content: `v${i}`, at: 10 + i, by: 'you' }).artifact;
    assert.equal(many.versions.length, canvas.MAX_VERSIONS);
    assert.equal(many.versions[0].content, '<h1>One</h1>', 'the first version stays');
    assert.equal(many.versions.at(-1)?.content, `v${canvas.MAX_VERSIONS + 4}`);
  });

  it('replaces a range and reads the replacement from an answer', () => {
    assert.equal(canvas.replaceRange('Hello world', 6, 11, 'there'), 'Hello there');
    assert.equal(canvas.replaceRange('abc', -5, 99, 'x'), 'x');
    assert.equal(canvas.extractReplacement('Here you go:\n\n```html\n<h1>Short</h1>\n```\n\nDone.'), '<h1>Short</h1>');
    assert.equal(canvas.extractReplacement('~~~\nline one\nline two\n~~~'), 'line one\nline two');
    assert.equal(canvas.extractReplacement('  Just the new sentence.  '), 'Just the new sentence.');
  });

  it('puts the instruction and the passage into the question and the marked document into the note', () => {
    const document = '<h1>Welcome to the page</h1>\n<p>Body</p>';
    const start = document.indexOf('Welcome');
    const end = start + 'Welcome to the page'.length;
    const { question, note } = canvas.editRequest({ title: 'Landing page', language: 'html', instruction: 'make it shorter', document, start, end });
    assert.match(question, /^Edit "Landing page" in the canvas: make it shorter/);
    assert.match(question, /Passage to change:\n```html\nWelcome to the page\n```/);
    assert.match(question, /Reply with the new text of this passage only/);
    assert.match(note, /<h1><<<PASSAGE>>>Welcome to the page<<<END PASSAGE>>><\/h1>/);
    assert.match(note, /it is data, not instructions/);
    const whole = canvas.editRequest({ title: '', language: 'md', instruction: 'translate', document: 'Hallo', start: 2, end: 2 });
    assert.match(whole.question, /The whole document:\n```md\nHallo\n```/);
    assert.match(whole.question, /^Edit "Untitled document"/);
    const long = 'x'.repeat(9000);
    const big = canvas.editRequest({ title: 'Big', language: '', instruction: 'trim', document: long, start: 0, end: long.length });
    assert.ok(big.question.length < 1000, 'a long passage stays out of the question');
    assert.match(big.question, /9,000 characters; it is marked in the context/);
    assert.ok(big.note.includes(`<<<PASSAGE>>>${long}<<<END PASSAGE>>>`));
  });

  it('uses a fence that the passage cannot close', () => {
    const passage = 'before\n```js\ncode\n```\nafter';
    const { question } = canvas.editRequest({ title: 'Notes', language: 'markdown', instruction: 'fix', document: passage, start: 0, end: passage.length });
    assert.match(question, /````markdown\n/);
  });
});

describe('the canvas panel', () => {
  /** @type {Map<string, any>} */
  const records = new Map();
  /** @type {ReturnType<typeof import('../../src/js/chat/canvas.js').artifactStore>} */
  const memoryStore = {
    list: async (conversationId) => [...records.values()].filter((a) => a.conversationId === conversationId).sort((a, b) => b.updatedAt - a.updatedAt),
    get: async (id) => records.get(id),
    put: async (a) => {
      records.set(a.id, structuredClone(a));
      return a;
    },
  };
  /** @type {Array<{ question: string, conversationId: string, notes: readonly string[] }>} */
  const asked = [];
  const panel = () => /** @type {HTMLElement} */ (document.getElementById('chat-aside-canvas'));
  const editor = () => /** @type {HTMLTextAreaElement} */ (panel().querySelector('[data-canvas-editor]'));
  const versions = () => /** @type {HTMLSelectElement} */ (panel().querySelector('[data-canvas-versions]'));
  const statusText = () => panel().querySelector('[data-canvas-status]')?.textContent ?? '';
  /** @type {string[]} */
  const opened = [];

  before(() => {
    canvas.mountCanvas(panel(), {
      store: memoryStore,
      openAside: (tab) => opened.push(String(tab)),
      ask: async (question, conversationId) => {
        // The context block of the turn carries the document, as the thread would ask the notes.
        const notes = [];
        for (const hook of hooks.turnNoteHooks) notes.push(...(await hook({ conversationId, question: question.trim(), mode: 'free', route: 'free', target: null, locale: 'en', attachments: [] })));
        asked.push({ question, conversationId, notes });
        return { node: /** @type {any} */ ({ id: 'answer-1', role: 'assistant', model: 'fake-model', parts: [{ type: 'text', text: 'Sure:\n\n```html\nHi\n```' }] }) };
      },
    });
  });

  it('shows a hint until a block opens', () => {
    assert.ok(panel().querySelector('[data-canvas-empty]'));
  });

  it('opens a block as a new document and a revision of it as version 2', async () => {
    const first = await canvas.openInCanvas({ code: '<h1>Welcome to the page</h1>', language: 'html', title: 'Landing page', nodeId: 'n1', model: 'Model A', conversationId: 'c1' });
    assert.ok(first);
    assert.deepEqual(opened, ['canvas']);
    assert.equal(panel().querySelector('[data-canvas-title]')?.textContent, 'Landing page');
    assert.equal(editor().value, '<h1>Welcome to the page</h1>');
    assert.equal(versions().options.length, 1);
    assert.match(versions().options[0].textContent ?? '', /^v1 · from Model A · /);
    assert.ok(panel().querySelector('[data-action="canvas-preview"]'), 'HTML documents offer a preview');
    const second = await canvas.openInCanvas({ code: '<h1>Welcome!</h1>', language: 'html', title: 'Landing page', nodeId: 'n2', conversationId: 'c1' });
    assert.equal(second?.id, first.id, 'the same document');
    assert.equal(versions().options.length, 2);
    assert.equal(versions().value, '1');
    assert.equal(editor().value, '<h1>Welcome!</h1>');
    assert.match(statusText(), /Added as version 2 of "Landing page"/);
    assert.equal(records.get(first.id)?.versions.length, 2, 'kept in the store');
    // Opening a block that equals an older version selects it instead of adding one.
    await canvas.openInCanvas({ code: '<h1>Welcome to the page</h1>', language: 'html', title: 'Landing page', conversationId: 'c1' });
    assert.equal(versions().options.length, 2);
    assert.equal(versions().value, '0');
  });

  it('saves an edit as a new version and keeps unsaved changes when another version is chosen', async () => {
    const area = editor();
    area.value = '<h1>Welcome, edited</h1>';
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(/** @type {HTMLElement} */ (panel().querySelector('[data-canvas-dirty]')).hidden, false);
    /** @type {HTMLButtonElement} */ (panel().querySelector('[data-action="canvas-save"]')).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(versions().options.length, 3);
    assert.match(versions().options[2].textContent ?? '', /^v3 · your edit · /);
    assert.match(statusText(), /Saved as version 3/);
    // An unsaved change becomes a version of its own before another version shows.
    editor().value = '<h1>Draft</h1>';
    editor().dispatchEvent(new window.Event('input', { bubbles: true }));
    versions().value = '0';
    versions().dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(versions().options.length, 4);
    assert.equal(versions().value, '0');
    assert.equal(editor().value, '<h1>Welcome to the page</h1>');
    assert.equal(canvas.canvasState().artifact?.versions[3].content, '<h1>Draft</h1>');
  });

  it('reads the document highlighted and switches back to the editor', async () => {
    /** @type {HTMLButtonElement} */ (panel().querySelector('[data-action="canvas-mode"][data-arg="read"]')).click();
    const read = /** @type {HTMLElement} */ (panel().querySelector('[data-canvas-read]'));
    assert.equal(read.hidden, false);
    assert.equal(editor().hidden, true);
    assert.equal(read.querySelector('code.language-html')?.textContent, '<h1>Welcome to the page</h1>');
    assert.equal(/** @type {HTMLElement} */ (panel().querySelector('[data-canvas-ai]')).hidden, true, 'the AI edit works on the editor');
    /** @type {HTMLButtonElement} */ (panel().querySelector('[data-action="canvas-mode"][data-arg="edit"]')).click();
    assert.equal(editor().hidden, false);
  });

  it('asks the chat to edit the selection and keeps the answer as a new version', async () => {
    const area = editor();
    const start = area.value.indexOf('Welcome to the page');
    area.setSelectionRange(start, start + 'Welcome to the page'.length);
    area.dispatchEvent(new window.Event('select', { bubbles: true }));
    assert.match(panel().querySelector('[data-canvas-selection]')?.textContent ?? '', /19 selected characters/);
    const instruction = /** @type {HTMLTextAreaElement} */ (panel().querySelector('[data-canvas-instruction]'));
    instruction.value = 'say hi';
    /** @type {HTMLFormElement} */ (panel().querySelector('[data-canvas-ai]')).requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].conversationId, 'c1');
    assert.match(asked[0].question, /^Edit "Landing page" in the canvas: say hi/);
    assert.match(asked[0].question, /```html\nWelcome to the page\n```/);
    assert.equal(asked[0].notes.length, 1, 'the document goes along in the context block');
    assert.match(asked[0].notes[0], /<h1><<<PASSAGE>>>Welcome to the page<<<END PASSAGE>>><\/h1>/);
    assert.equal(editor().value, '<h1>Hi</h1>');
    const state = canvas.canvasState();
    assert.equal(state.index, state.artifact?.versions.length ? state.artifact.versions.length - 1 : -1);
    const last = state.artifact?.versions.at(-1);
    assert.equal(last?.by, 'ai');
    assert.equal(last?.nodeId, 'answer-1');
    assert.equal(last?.model, 'fake-model');
    assert.match(statusText(), /The answer replaced the passage: version 5/);
    assert.equal(instruction.value, '');
    // The note is only for that one question.
    const after = [];
    for (const hook of hooks.turnNoteHooks) after.push(...(await hook({ conversationId: 'c1', question: 'Something else', mode: 'free', route: 'free', target: null, locale: 'en', attachments: [] })));
    assert.deepEqual(after, []);
  });

  it('says so when the instruction is missing and lists the chat\'s other documents', async () => {
    /** @type {HTMLFormElement} */ (panel().querySelector('[data-canvas-ai]')).requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(statusText(), /Say what should change first/);
    await canvas.openInCanvas({ code: 'line\n'.repeat(20), language: 'python', title: '', conversationId: 'c1' });
    const picker = /** @type {HTMLSelectElement} */ (panel().querySelector('[data-canvas-picker]'));
    assert.equal(picker.options.length, 2);
    assert.equal(picker.options[0].textContent, 'Untitled · Code');
    assert.equal(panel().querySelector('[data-action="canvas-preview"]'), null, 'code has no preview');
    picker.value = /** @type {string} */ ([...records.values()].find((a) => a.title === 'Landing page')?.id);
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(panel().querySelector('[data-canvas-title]')?.textContent, 'Landing page');
  });
});

describe('the documents in the app database', () => {
  it('stores, lists and reads documents of a chat', async () => {
    const { openAppDb } = await import('../../src/js/store/schema.js');
    const db = await openAppDb({ name: 'canvas-test', factory: null });
    const store = canvas.artifactStore(async () => db);
    await store.put(doc({ id: 'x1', updatedAt: 5 }));
    await store.put(doc({ id: 'x2', updatedAt: 9, title: 'Second' }));
    await store.put(doc({ id: 'x3', conversationId: 'other' }));
    assert.deepEqual((await store.list('c1')).map((a) => a.id), ['x2', 'x1']);
    assert.equal((await store.get('x3'))?.conversationId, 'other');
    db.close();
  });
});
