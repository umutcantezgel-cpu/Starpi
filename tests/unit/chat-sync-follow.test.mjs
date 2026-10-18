// The chat with the encrypted sync and other tabs in mind, in a DOM (jsdom) with the app database in
// memory (fake-indexeddb) and the OpenAI-compatible fake as the user's own server: the privacy line
// under the composer says that a chat syncs only while the sync is on, and follows it; a question
// restored from the sync whose attachment stayed on another device goes out without it, with a
// note, never as an empty file; the chat on screen follows changes made elsewhere (a merged turn
// shows, a deletion returns to a new chat, an own deletion says nothing); and the verified web
// answer of the tool runner is labelled and stored as the thread's web check.
/* global document */
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS', 'DOMParser', 'getComputedStyle'];

const MARKUP = `<!doctype html><html><body>
  <div id="toastRegion"></div><span id="assistantStatusText"></span><span id="servedModel" class="hidden"></span><p id="privacyNotice"></p>
  <select id="engineSelector"><option value="auto">Auto</option><option value="local:*">Own server</option></select>
  <div id="chatMessages"><div class="welcome">Welcome</div></div>
  <button type="button" id="newChat" data-action="new-chat"></button>
  <form id="chatForm">
    <span id="chatModeHint"></span><button type="button" id="thinkingToggle"></button><button type="button" id="webToggle"></button>
    <div id="toolsMenuList"></div><div id="attachedInfo" class="hidden"></div><p id="composerNotice" class="hidden"></p>
    <input type="file" id="chatFileInput"><span id="composerMicSlot"></span><span id="composerVoiceSlot"></span>
    <textarea id="chatInput"></textarea><button type="button" id="stopBtn" class="hidden"></button><button type="submit" id="sendBtn"></button>
  </form>
</body></html>`;

/** @type {Awaited<ReturnType<ReturnType<typeof createOpenAiFake>['listen']>>} */
let server;
/** @type {JSDOM} */
let jsdom;
const fake = createOpenAiFake({ flavor: 'ollama', gapMs: 0 });
/** @type {typeof import('../../src/js/chat.js')} */
let chat;
/** @type {typeof import('../../src/js/chat/thread.js')} */
let thread;
/** @type {typeof import('../../src/js/chat-store.js')} */
let chatStore;

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => boolean | Promise<boolean>} check
 * @param {number} [ms]
 */
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

/** @param {string} text */
function ask(text) {
  /** @type {HTMLTextAreaElement} */ (document.getElementById('chatInput')).value = text;
  return chat.submitChat();
}

const rows = (/** @type {'user' | 'assistant'} */ role) => [...document.querySelectorAll(`#chatMessages .message-row[data-role="${role}"]`)].map((el) => /** @type {HTMLElement} */ (el));
const notices = () => [...document.querySelectorAll('#chatMessages > [role="status"]')].map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim());
const store = () => chatStore.chatData();

/** The messages of the newest chat request (the title calls are left out). */
function lastChat() {
  const body = fake.requests.filter((r) => /chat\/completions/.test(r.path) && !JSON.stringify(r.body ?? '').includes('You name conversations')).at(-1)?.body;
  return /** @type {Array<{ role: string, content: unknown }>} */ (body?.messages ?? []);
}

/** Starts a new chat the way the header button does. */
function newChat() {
  /** @type {HTMLButtonElement} */ (document.getElementById('newChat')).click();
}

before(async () => {
  server = await fake.listen(0);
  jsdom = new JSDOM(MARKUP, { url: 'https://app.example/', pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: jsdom.window.navigator, configurable: true, writable: true });
  localStorage.setItem('starpi_llm_url', `${server.url}/flavor/ollama/v1`);
  localStorage.setItem('starpi_assistant_v1', 'local:*');
  localStorage.setItem('starpi_chat_mode', 'free');
  const dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  (await import('../../src/js/messages.js')).initMessages();
  chat = await import('../../src/js/chat.js');
  chat.initChat();
  chatStore = await import('../../src/js/chat-store.js');
  await (await import('../../src/js/providers.js')).refreshProviders();
  thread = await import('../../src/js/chat/thread.js');
  await thread.showConversation();
});

after(async () => {
  chatStore.bindChatSync(null);
  await fake.close();
  (await store()).close();
  jsdom.window.close();
});

describe('the privacy line', () => {
  it('says that the chat syncs only while the sync is on, and follows the sync state', async () => {
    const settings = await import('../../src/js/settings.js');
    settings.initSettings();
    const line = () => document.querySelector('#privacyNotice [data-history-synced]');
    assert.equal(line(), null, 'no sync: nothing is said about a synced history');
    /** @type {{ key: string, params?: Record<string, string> } | null} */
    let status = { key: 'sync.line.on', params: { n: '1' } };
    chatStore.bindChatSync({ statusLine: () => status, flush: async () => true });
    await until(() => line() !== null);
    assert.match(line()?.textContent ?? '', /Sync is on: this chat is kept end-to-end encrypted/);
    // The sync turned off: the next status change takes the line away.
    status = null;
    await chatStore.refreshSyncStatus();
    assert.equal(line(), null);
    chatStore.bindChatSync(null);
  });
});

describe('attachments that stayed on another device', () => {
  it('go out as their names only, with a note, never as an empty file', async () => {
    newChat();
    const id = chatStore.currentSessionId();
    const db = await store();
    // As the sync restores a turn: the question names its file, whose blob this browser never had.
    await db.createConversation({ id, mode: 'free' });
    const q = await db.appendNode(id, { parentId: null, role: 'user', parts: [{ type: 'file', mime: 'text/plain', blobId: 'blob-elsewhere', name: 'notes.txt', kind: 'text', size: 120 }, { type: 'text', text: 'Summarize my notes' }], meta: { chat_mode: 'free' } });
    await db.appendNode(id, { parentId: q.id, role: 'assistant', parts: [{ type: 'text', text: 'Your notes are about gardening.' }], provider: 'local', model: 'fake-local:8b', label: 'free', meta: { chat_mode: 'free' } });
    await chat.openConversation(id);
    await ask('And what about the roses?');
    const users = lastChat().filter((m) => m.role === 'user');
    assert.equal(users.length, 2);
    const first = JSON.stringify(users[0].content);
    assert.match(first, /\[notes\.txt\]/, 'the file goes as its name');
    assert.doesNotMatch(first, /<<<FILE|Attached file/i, 'no empty attachment section');
    assert.ok(notices().some((n) => /An attachment is only on the device it was added on/.test(n) && /notes\.txt was left out/.test(n)), notices().join(' | '));
    // Said once per attachment on this page.
    const count = notices().length;
    await ask('One more question');
    assert.equal(notices().length, count);
  });
});

describe('changes made elsewhere', () => {
  it('shows a turn merged into the chat on screen by the sync or another tab', async () => {
    newChat();
    await ask('First question here');
    const id = chatStore.currentSessionId();
    const db = await store();
    const path = (await db.loadThread(id))?.path ?? [];
    assert.equal(rows('assistant').length, 1);
    // Another browser continued the chat; the sync merges its turn in.
    const q = await db.appendNode(id, { parentId: path.at(-1)?.id ?? null, role: 'user', parts: [{ type: 'text', text: 'A question from the other browser' }], meta: { chat_mode: 'free' } });
    await db.appendNode(id, { parentId: q.id, role: 'assistant', parts: [{ type: 'text', text: 'An answer written there.' }], provider: 'local', model: 'fake-local:8b', label: 'free', meta: { chat_mode: 'free' } });
    await until(() => rows('assistant').length === 2);
    assert.match(rows('user').at(-1)?.textContent ?? '', /A question from the other browser/);
    assert.match(rows('assistant').at(-1)?.textContent ?? '', /An answer written there/);
    assert.equal(thread.threadConversationId(), id);
  });

  it('returns to a new chat when the chat on screen is deleted elsewhere, and says so', async () => {
    const id = chatStore.currentSessionId();
    await (await store()).deleteConversation(id);
    await until(() => chatStore.currentSessionId() !== id);
    assert.equal(thread.threadConversationId(), chatStore.currentSessionId());
    assert.equal(rows('assistant').length, 0);
    assert.ok(notices().some((n) => /This chat was deleted in another tab or browser/.test(n)), notices().join(' | '));
  });

  it('says nothing when the chat is deleted here', async () => {
    await ask('A chat to delete here');
    const id = chatStore.currentSessionId();
    // As chat-store.js deleteSession does it (without the knowledge base): the conversation goes,
    // a new session starts right after, and the chat view is cleared once the delete is through.
    await (await store()).deleteConversation(id);
    chatStore.startNewSession();
    await wait(200);
    chat.resetConversation();
    await wait(400);
    assert.notEqual(chatStore.currentSessionId(), id);
    assert.deepEqual(
      notices().filter((n) => /deleted in another/.test(n)),
      [],
    );
  });

  it('waits for an answer being written in the chat, then shows what was merged meanwhile', async () => {
    newChat();
    await ask('Before the merge');
    const id = chatStore.currentSessionId();
    const done = ask('[[fake-fault:slow-first-byte]] A slow one');
    await until(() => thread.isThreadBusy());
    const db = await store();
    const first = (await db.loadThread(id))?.path[0];
    // Another browser regenerated the first answer meanwhile: a second branch under the first question.
    await db.appendNode(id, { parentId: first?.id ?? null, role: 'assistant', parts: [{ type: 'text', text: 'Another answer to the first question.' }], provider: 'local', model: 'fake-local:8b', label: 'free', meta: { chat_mode: 'free' } }, { activate: false });
    await done;
    await until(() => !thread.isThreadBusy());
    // The screen shows what is stored: the first answer now has two branches.
    await until(() => document.querySelector('#chatMessages .message-row[data-role="assistant"] .branch-pos')?.textContent === '1/2');
    assert.equal(rows('assistant').length, 2);
  });
});

describe('the verified web answer of the tool runner', () => {
  it('is labelled and stored as the web check of the answer', async () => {
    const off = thread.setToolRunner(async ({ result }) => ({
      ...result,
      text: 'Tides follow the Moon. Waves can be tall.',
      citations: [{ url: 'https://example.org/tides', title: 'Tides', citedText: 'Tides follow the Moon.', start: 0, end: 22 }],
      webCheck: { kind: 'checked', pages: 2, supported: 1, flagged: 1, total: 2 },
    }));
    try {
      newChat();
      await ask('What moves the tides?');
      const answer = /** @type {HTMLElement} */ (rows('assistant').at(-1));
      assert.ok(answer.querySelector('[data-answer-label="web"]'));
      assert.match(answer.querySelector('.web-check')?.textContent ?? '', /Checked against the cited text: 1 of 2 statements found/);
      const stored = ((await (await store()).loadThread(chatStore.currentSessionId()))?.path ?? []).at(-1);
      assert.equal(stored?.label, 'web');
      assert.deepEqual(stored?.meta?.web_check, { kind: 'checked', pages: 2, supported: 1, flagged: 1, total: 2 });
      // Shown again from the store, it keeps the same label and line.
      await chat.openConversation(chatStore.currentSessionId());
      assert.match(rows('assistant').at(-1)?.querySelector('.web-check')?.textContent ?? '', /1 of 2 statements found/);
    } finally {
      off();
    }
  });

  it('keeps no provider state for an answer that stopped with tool calls left open', () => {
    const input = thread.freeAnswerInput({
      question: /** @type {any} */ ({ id: 'q', parts: [{ type: 'text', text: 'Hi' }], meta: {}, localOnly: false }),
      target: /** @type {any} */ ({ provider: 'openai', model: 'gpt-5', route: 'key' }),
      result: /** @type {any} */ ({ text: 'Let me check.', reasoning: '', toolCalls: [{ id: 'c', name: 'datetime', args: {}, argsText: '{}' }], citations: [], images: [], opaque: [{ type: 'opaque', provider: 'openai', block: {} }], stopReason: 'tool_call', provider: 'openai', model: 'gpt-5', usage: null, error: null }),
      durationMs: 10,
    });
    assert.deepEqual(input.opaque, []);
    assert.equal(input.label, 'free');
  });
});
