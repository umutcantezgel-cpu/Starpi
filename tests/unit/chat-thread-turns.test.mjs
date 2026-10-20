// The thread's turns against other chats and other models, in a DOM (jsdom) with the app database in
// memory (fake-indexeddb), the OpenAI-compatible fake as the user's own server and the site's pools
// answering as set up for one provider: the chat title is asked only of the provider that answered;
// an answer still streaming when the user starts a new chat or opens another one is stored beside
// its question and shows again in its chat; a question asked on this device is answered again only
// on this device or by the own server (the regenerate menu offers only those); a request that cannot
// be built leaves no bubble behind and says so in i18n text; a question is busy from the moment it is
// taken, so a second one sent while the route of the first is decided starts no turn beside it.
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
  <select id="engineSelector"><option value="auto">Auto</option><option value="anthropic:claude-haiku-5-5">Claude Haiku</option><option value="groq:llama-3.3-70b-versatile">Llama via the site</option><option value="local:fake-local-reasoner:4b">Own server reasoner</option></select>
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
/** Request bodies the site's pool endpoint received. */
/** @type {string[]} */
const poolBodies = [];
/** Request bodies sent to Anthropic. */
/** @type {string[]} */
const anthropicBodies = [];
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

/** @param {string} id */
async function storedPath(id) {
  const t = await (await chatStore.chatData()).loadThread(id);
  return t?.path ?? [];
}

/** Starts a new chat the way the header button does. */
function newChat() {
  /** @type {HTMLButtonElement} */ (document.getElementById('newChat')).click();
}

const titleCalls = () => fake.requests.filter((r) => JSON.stringify(r.body ?? '').includes('You name conversations'));

before(async () => {
  server = await fake.listen(0);
  jsdom = new JSDOM(MARKUP, { url: 'https://app.example/', pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: jsdom.window.navigator, configurable: true, writable: true });
  // The site's pools: one provider is set up; every pool call is recorded and fails.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (/** @type {number} */ status, /** @type {unknown} */ body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/models/pool')) return json(200, { pools: { groq: { configured: true, models: ['llama-3.3-70b-versatile'], defaultModel: 'llama-3.3-70b-versatile' } } });
    if (url.includes('/api/pool')) {
      poolBodies.push(String(init?.body ?? ''));
      return json(500, { error: 'unavailable' });
    }
    if (new URL(url).hostname === 'api.anthropic.com') {
      anthropicBodies.push(String(init?.body ?? ''));
      return json(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } });
    }
    return realFetch(input, init);
  };
  sessionStorage.setItem('starpi_key_anthropic', 'sk-ant-unit0123456789abcdefghijklmnop');
  localStorage.setItem('starpi_llm_url', `${server.url}/flavor/ollama/v1`);
  localStorage.setItem('starpi_assistant_v1', 'local:*');
  localStorage.setItem('starpi_chat_mode', 'free');
  const dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  (await import('../../src/js/messages.js')).initMessages();
  chat = await import('../../src/js/chat.js');
  chat.initChat();
  chatStore = await import('../../src/js/chat-store.js');
  const providers = await import('../../src/js/providers.js');
  await providers.refreshProviders();
  thread = await import('../../src/js/chat/thread.js');
  await thread.showConversation();
});

after(async () => {
  await fake.close();
  (await chatStore.chatData()).close();
  jsdom.window.close();
});

describe('chat titles', () => {
  it('asks only the provider that answered, never the site pools or another key', async () => {
    const providers = await import('../../src/js/providers.js');
    assert.deepEqual(providers.configuredProviders(), ['anthropic', 'groq', 'local'], 'a key, a pool and the own server are set up');
    const id = chatStore.currentSessionId();
    await ask('My question for my own server only');
    await until(async () => (await (await chatStore.chatData()).getConversation(id))?.title !== 'My question for my own server only');
    assert.ok(titleCalls().length >= 1, 'the own server named the chat');
    assert.deepEqual(poolBodies, [], 'nothing went to the site pools');
    assert.deepEqual(anthropicBodies, [], 'nothing went to the provider of the key');
  });

  it('names the providers a title may go to', () => {
    assert.deepEqual(thread.titleProviders({ provider: 'local', localOnly: false }), ['local']);
    assert.deepEqual(thread.titleProviders({ provider: 'groq', localOnly: false }), ['groq']);
    assert.deepEqual(thread.titleProviders({ provider: 'webgpu', localOnly: true }), []);
    assert.deepEqual(thread.titleProviders({ provider: 'local', localOnly: true }), [], 'a conversation that stays here is named here');
    assert.deepEqual(thread.titleProviders({ provider: null, localOnly: false }), []);
  });
});

describe('another chat while an answer streams', () => {
  it('stores the answer beside its question when the user starts a new chat', async () => {
    newChat();
    const first = chatStore.currentSessionId();
    const done = ask('[[fake-fault:stall-mid-stream]] A long story, please');
    await until(() => /simulated/.test(document.querySelector('[data-streaming="true"] .message-content')?.textContent ?? ''));
    newChat();
    const second = chatStore.currentSessionId();
    assert.notEqual(second, first);
    assert.equal(thread.threadConversationId(), second);
    assert.equal(rows('assistant').length, 0, 'the new chat shows no answer of the other one');
    assert.equal(thread.isThreadBusy(), true, 'the answer goes on');
    thread.stopAnswer();
    await done;
    const path = await storedPath(first);
    assert.deepEqual(path.map((n) => n.role), ['user', 'assistant']);
    assert.match(String(path[1].parts[0].text), /simulated/);
    assert.equal(path[1].meta?.stop_reason, 'cancelled');
    assert.deepEqual(await storedPath(second), [], 'nothing was stored in the new chat');
    assert.deepEqual(notices(), [], 'no notice in the new chat');
    assert.equal(rows('assistant').length, 0);
    await chat.openConversation(first);
    assert.equal(rows('assistant').length, 1);
    assert.equal(rows('assistant')[0].dataset.nodeId, path[1].id);
  });

  it('goes on streaming in its chat when the user comes back to it', async () => {
    newChat();
    const first = chatStore.currentSessionId();
    await ask('Hello first chat');
    const done = ask('[[fake-fault:stall-mid-stream]] Another long story');
    await until(() => /simulated/.test(document.querySelector('[data-streaming="true"] .message-content')?.textContent ?? ''));
    const live = /** @type {HTMLElement} */ (document.querySelector('[data-streaming="true"]'));
    newChat();
    assert.equal(document.querySelector('[data-streaming="true"]'), null);
    await chat.openConversation(first);
    assert.equal(document.querySelector('[data-streaming="true"]'), live, 'the streaming answer is back below its question');
    assert.equal(rows('user').length, 2);
    thread.stopAnswer();
    await done;
    const path = await storedPath(first);
    assert.deepEqual(path.map((n) => n.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(rows('assistant').length, 2);
    assert.equal(rows('assistant')[1].dataset.nodeId, path[3].id, 'the stored answer shows in its chat');
    assert.equal(document.querySelector('[data-streaming="true"]'), null);
  });

  it('stores the answer in its chat when the user opens another conversation', async () => {
    newChat();
    const other = chatStore.currentSessionId();
    await ask('A chat of its own');
    newChat();
    const first = chatStore.currentSessionId();
    const done = ask('[[fake-fault:stall-mid-stream]] Tell me about rivers');
    await until(() => /simulated/.test(document.querySelector('[data-streaming="true"] .message-content')?.textContent ?? ''));
    await chat.openConversation(other);
    thread.stopAnswer();
    await done;
    assert.deepEqual((await storedPath(first)).map((n) => n.role), ['user', 'assistant']);
    assert.deepEqual((await storedPath(other)).map((n) => n.role), ['user', 'assistant'], 'the other chat is unchanged');
    assert.equal(rows('user').length, 1);
    assert.match(rows('user')[0].textContent ?? '', /A chat of its own/);
    assert.deepEqual(notices(), []);
  });
});

describe('questions that stay on this device', () => {
  /** @type {string} */
  let id;
  /** @type {import('../../src/js/store/schema.js').NodeRecord} */
  let q1;
  /** @type {import('../../src/js/store/schema.js').NodeRecord} */
  let a1;

  before(async () => {
    newChat();
    const db = await chatStore.chatData();
    id = chatStore.currentSessionId();
    await db.createConversation({ id, mode: 'free', model: 'device' });
    const q0 = await db.appendNode(id, { parentId: null, role: 'user', parts: [{ type: 'text', text: 'shared question' }], meta: { chat_mode: 'free' } });
    const a0 = await db.appendNode(id, { parentId: q0.id, role: 'assistant', parts: [{ type: 'text', text: 'shared answer' }], provider: 'local', model: 'fake-local:8b', label: 'free', meta: { chat_mode: 'free', requested: 'fake-local:8b', route: 'local' } });
    q1 = await db.appendNode(id, { parentId: a0.id, role: 'user', localOnly: true, parts: [{ type: 'text', text: 'PRIVATE device question' }], meta: { chat_mode: 'free' } });
    a1 = await db.appendNode(id, { parentId: q1.id, role: 'assistant', localOnly: true, parts: [{ type: 'text', text: 'device answer' }], provider: 'webgpu', model: 'webgpu:x', label: 'free', meta: { chat_mode: 'free' } });
    await thread.showConversation(id);
  });

  it('offers only the own server in the regenerate menu', () => {
    const row = /** @type {HTMLElement} */ (document.querySelector(`.message-row[data-node-id="${a1.id}"]`));
    const menu = /** @type {HTMLDetailsElement} */ (row.querySelector('details.regen-menu'));
    menu.open = true;
    menu.dispatchEvent(new Event('toggle'));
    const values = [...menu.querySelectorAll('[data-action="msg-regenerate"]')].map((b) => /** @type {HTMLElement} */ (b).dataset.value);
    assert.deepEqual(values, ['', 'local:fake-local-reasoner:4b']);
    menu.open = false;
    const shared = /** @type {HTMLDetailsElement} */ (document.querySelectorAll('details.regen-menu')[0]);
    shared.open = true;
    shared.dispatchEvent(new Event('toggle'));
    assert.ok([...shared.querySelectorAll('[data-action="msg-regenerate"]')].some((b) => /** @type {HTMLElement} */ (b).dataset.value === 'anthropic:claude-haiku-5-5'), 'a shared answer may go to any model');
    shared.open = false;
  });

  it('does not regenerate it with a provider or edit it for one: a notice says why, nothing is sent', async () => {
    const before = fake.requests.length;
    await thread.regenerate(a1.id, 'anthropic:claude-haiku-5-5');
    await thread.regenerate(a1.id, 'groq:llama-3.3-70b-versatile');
    const state = await import('../../src/js/state.js');
    state.setAssistant('anthropic:claude-haiku-5-5');
    try {
      await thread.editQuestion(q1.id, 'PRIVATE edited question');
    } finally {
      state.setAssistant('local:*');
    }
    assert.deepEqual(anthropicBodies, []);
    assert.deepEqual(poolBodies, []);
    assert.equal(fake.requests.length, before);
    assert.equal(notices().filter((n) => /This question stays on this device/.test(n)).length, 3);
    assert.equal(document.querySelectorAll('[data-streaming="true"]').length, 0);
    const path = await storedPath(id);
    assert.deepEqual(path.map((n) => n.id).slice(-2), [q1.id, a1.id], 'the thread is unchanged');
    assert.equal((await (await chatStore.chatData()).loadThread(id))?.nodes.length, 4, 'no question or answer was added');
  });

  it('answers it again on the own server with the whole conversation and the question last', async () => {
    await thread.regenerate(a1.id, 'local:fake-local-reasoner:4b');
    const sent = fake.requests.filter((r) => /chat\/completions/.test(r.path) && JSON.stringify(r.body).includes('PRIVATE device question')).at(-1)?.body;
    assert.ok(sent, 'the own server got the question');
    const messages = /** @type {any[]} */ (sent.messages).filter((m) => m.role !== 'system');
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(JSON.stringify(messages.at(-1).content), /PRIVATE device question/);
    const path = await storedPath(id);
    assert.equal(path.at(-1)?.parentId, q1.id);
    assert.equal(path.at(-1)?.localOnly, true, 'the new answer stays on this device too');
  });
});

describe('grounded questions asked on this device', () => {
  it('are answered again on this device or the own server only, like free ones', async () => {
    newChat();
    const db = await chatStore.chatData();
    const id = chatStore.currentSessionId();
    await db.createConversation({ id, mode: 'grounded', model: 'device' });
    const q = await db.appendNode(id, { parentId: null, role: 'user', localOnly: true, parts: [{ type: 'text', text: 'PRIVATE grounded question' }], meta: { chat_mode: 'grounded', device_only: true } });
    const a = await db.appendNode(id, { parentId: q.id, role: 'assistant', localOnly: true, parts: [{ type: 'text', text: 'grounded device answer' }], provider: 'webgpu', model: 'webgpu:x', label: 'grounded', meta: { chat_mode: 'grounded' } });
    await thread.showConversation(id);
    const row = /** @type {HTMLElement} */ (document.querySelector(`.message-row[data-node-id="${a.id}"]`));
    const menu = /** @type {HTMLDetailsElement} */ (row.querySelector('details.regen-menu'));
    menu.open = true;
    menu.dispatchEvent(new Event('toggle'));
    const values = [...menu.querySelectorAll('[data-action="msg-regenerate"]')].map((b) => /** @type {HTMLElement} */ (b).dataset.value);
    assert.ok(values.every((v) => v === '' || v?.startsWith('local:')), values.join(', '));
    menu.open = false;
    const shown = notices().filter((n) => /This question stays on this device/.test(n)).length;
    await thread.regenerate(a.id, 'anthropic:claude-haiku-5-5');
    assert.deepEqual(anthropicBodies, []);
    assert.equal(notices().filter((n) => /This question stays on this device/.test(n)).length, shown + 1);
    assert.equal((await db.loadThread(id))?.nodes.length, 2, 'nothing was added');
  });
});

describe('failures inside a turn', () => {
  it('leaves no bubble behind when the request cannot be built, and says so in i18n text', async () => {
    newChat();
    await thread.showConversation();
    const { registerRequestHook } = await import('../../src/js/chat/hooks.js');
    const off = registerRequestHook(() => {
      throw new TypeError('Cannot read properties of undefined');
    });
    try {
      await ask('This request breaks');
    } finally {
      off();
    }
    assert.equal(document.querySelectorAll('[data-streaming="true"]').length, 0);
    const shown = notices().join(' | ');
    assert.match(shown, /Something went wrong while answering/);
    assert.doesNotMatch(shown, /Cannot read properties/);
  });

  it('names workspace errors with the workspace texts', () => {
    assert.equal(thread.workspaceErrorKey({ code: 'needs_ocr' }), 'workspace.error_needs_ocr');
    assert.equal(thread.workspaceErrorKey({ code: 'zip_bomb' }), 'workspace.error_zip_bomb');
    assert.equal(thread.workspaceErrorKey({ code: 'encrypted_document' }), 'workspace.error_encrypted_document');
    assert.equal(thread.workspaceErrorKey({ code: 'invalid_document' }), 'workspace.error_invalid_document');
    assert.equal(thread.workspaceErrorKey({ code: 'title' }), 'workspace.error_internal');
    assert.equal(thread.workspaceErrorKey({ code: 'no such code' }), 'workspace.error_internal');
    assert.equal(thread.workspaceErrorKey(new Error('x')), 'workspace.error_internal');
  });
});

describe('a second question while the route of the first is decided', () => {
  it('is refused: the turn starts when the first question is taken, not after its route', async () => {
    newChat();
    await thread.showConversation();
    const id = chatStore.currentSessionId();
    // A starter question clicked twice: the second click comes while the first one's route is decided.
    const first = thread.sendQuestion({ text: 'What is the capital of France?' });
    assert.equal(thread.isThreadBusy(), true, 'busy while the route is decided');
    assert.equal(document.getElementById('stopBtn')?.classList.contains('hidden'), false, 'Stop shows');
    await thread.sendQuestion({ text: 'What is the capital of France?' });
    await first;
    assert.deepEqual((await storedPath(id)).map((n) => n.role), ['user', 'assistant'], 'one turn, not two beside each other');
  });
});
