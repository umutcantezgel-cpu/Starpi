// The canvas and content that stays on this device, through the real chat (jsdom, the app database in
// memory, the OpenAI-compatible fake as the own server, a key for a cloud provider whose calls are
// recorded): a code block of an answer that stays on this device opens as a document that stays; its
// AI edit with the cloud model chosen asks nothing and sends nothing, the same question asked to the
// chat as one that stays is refused before it is stored, and with the own server chosen the edit is
// answered there and stored as staying here (later cloud turns do not see it); a block of a compare
// column marked as staying opens as a document that stays.
/* global document, window */
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'HTMLFormElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'CustomEvent', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS', 'DOMParser', 'getComputedStyle', 'MutationObserver'];

const CLOUD = 'anthropic:claude-haiku-5-5';
const SERVER = 'local:*';

const MARKUP = `<!doctype html><html><body>
  <div id="toastRegion"></div><span id="assistantStatusText"></span><span id="servedModel" class="hidden"></span><p id="privacyNotice"></p>
  <select id="engineSelector"><option value="auto">Auto</option><option value="${CLOUD}">Claude Haiku</option><option value="${SERVER}">Own server</option></select>
  <div id="chatMessages"><div class="welcome">Welcome</div></div>
  <form id="chatForm">
    <div class="mode-toggle"><button type="button" data-action="set-chat-mode" data-arg="auto"></button><button type="button" data-action="set-chat-mode" data-arg="free"></button><button type="button" data-action="set-chat-mode" data-arg="grounded"></button></div>
    <span id="chatModeHint"></span><button type="button" id="thinkingToggle" data-action="toggle-thinking"></button><button type="button" id="webToggle" data-action="toggle-web"></button>
    <details class="tools-menu"><summary>Tools</summary><div id="toolsMenuList"></div></details><div id="attachedInfo" class="hidden"></div><p id="composerNotice" class="hidden"></p>
    <input type="file" id="chatFileInput" data-change="attach-file"><span id="composerMicSlot"></span><span id="composerVoiceSlot"></span>
    <textarea id="chatInput"></textarea><button type="button" id="stopBtn" class="hidden" data-action="stop-generation"></button><button type="submit" id="sendBtn"></button>
  </form>
  <aside id="chat-aside" class="hidden"><div id="chat-aside-canvas"></div><div id="chat-aside-compare"></div></aside>
</body></html>`;

/** Lines that must never reach the cloud provider. */
const SECRET = Array.from({ length: 20 }, (_, i) => `ONLY_ON_THIS_DEVICE_${i} = ${i}`).join('\n');

/** @type {Awaited<ReturnType<ReturnType<typeof createOpenAiFake>['listen']>>} */
let server;
/** @type {JSDOM} */
let jsdom;
const fake = createOpenAiFake({ flavor: 'ollama', gapMs: 0 });
/** @type {typeof import('../../src/js/chat.js')} */
let chat;
/** @type {typeof import('../../src/js/chat-store.js')} */
let chatStore;
/** @type {typeof import('../../src/js/chat/thread.js')} */
let thread;
/** @type {typeof import('../../src/js/state.js')} */
let state;
/** @type {typeof import('../../src/js/chat/canvas.js')} */
let canvas;
/** Bodies of the calls to the cloud provider. */
/** @type {string[]} */
const cloudBodies = [];
const leaked = () => cloudBodies.some((b) => b.includes('ONLY_ON_THIS_DEVICE'));

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => boolean | Promise<boolean>} check
 * @param {number} [ms]
 */
async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

const panel = () => /** @type {HTMLElement} */ (document.getElementById('chat-aside-canvas'));
const statusText = () => panel().querySelector('[data-canvas-status]')?.textContent ?? '';

async function storedPath() {
  const store = await chatStore.chatData();
  return (await store.loadThread(chatStore.currentSessionId()))?.path ?? [];
}

/** @param {string} instruction */
async function editWithAi(instruction) {
  /** @type {HTMLTextAreaElement} */ (panel().querySelector('[data-canvas-instruction]')).value = instruction;
  /** @type {HTMLFormElement} */ (panel().querySelector('[data-canvas-ai]')).requestSubmit();
  await until(() => canvas.canvasState().editing);
  await until(() => !canvas.canvasState().editing, 15_000);
}

before(async () => {
  server = await fake.listen(0);
  jsdom = new JSDOM(MARKUP, { url: 'https://app.example/', pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: jsdom.window.navigator, configurable: true, writable: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (/** @type {number} */ status, /** @type {unknown} */ body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/models/pool')) return json(200, { pools: {} });
    if (new URL(url).hostname === 'api.anthropic.com') {
      cloudBodies.push(String(init?.body ?? ''));
      return json(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } });
    }
    return realFetch(input, init);
  };
  sessionStorage.setItem('starpi_key_anthropic', 'sk-ant-unit0123456789abcdefghijklmnop');
  localStorage.setItem('starpi_llm_url', `${server.url}/flavor/ollama/v1`);
  localStorage.setItem('starpi_assistant_v1', SERVER);
  localStorage.setItem('starpi_chat_mode', 'free');
  const dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  (await import('../../src/js/messages.js')).initMessages();
  chat = await import('../../src/js/chat.js');
  chat.initChat();
  chatStore = await import('../../src/js/chat-store.js');
  await (await import('../../src/js/providers.js')).refreshProviders();
  // The feature as the shell mounts it: "Open in canvas" on code blocks.
  await import('../../src/js/features/canvas.js');
  const { mountFeatures } = await import('../../src/js/features/registry.js');
  const noop = () => {};
  await mountFeatures({
    onAction: dom.onAction,
    onChange: dom.onChange,
    onLocaleChange: () => noop,
    onTabOpen: noop,
    switchTab: noop,
    setNavVisible: noop,
    openChatAside: noop,
    closeChatAside: noop,
    openDialog: /** @type {any} */ (noop),
    closeDialog: noop,
    toast: () => noop,
  });
  thread = await import('../../src/js/chat/thread.js');
  state = await import('../../src/js/state.js');
  canvas = await import('../../src/js/chat/canvas.js');
  await thread.showConversation();
});

after(async () => {
  await fake.close();
  (await chatStore.chatData()).close();
  jsdom.window.close();
});

describe('the canvas and content that stays on this device', () => {
  it('opens a block of an answer that stays on this device as a document that stays', async () => {
    /** @type {HTMLTextAreaElement} */ (document.getElementById('chatInput')).value = 'Hello own server';
    await chat.submitChat();
    const id = chatStore.currentSessionId();
    const store = await chatStore.chatData();
    const leaf = (await storedPath()).at(-1);
    // A question about a file of the workspace and its answer: both stay on this device.
    const q = await store.appendNode(id, { parentId: leaf?.id ?? null, role: 'user', parts: [{ type: 'text', text: 'Show the settings from my file' }], localOnly: true, meta: { chat_mode: 'grounded' } });
    await store.appendNode(id, { parentId: q.id, role: 'assistant', parts: [{ type: 'text', text: `\`\`\`python\n${SECRET}\n\`\`\`` }], localOnly: true, label: 'grounded', meta: { chat_mode: 'grounded' } });
    await thread.showConversation(id);
    const answer = /** @type {HTMLElement} */ ([...document.querySelectorAll('#chatMessages .message-row[data-role="assistant"]')].at(-1));
    /** @type {HTMLButtonElement} */ (answer.querySelector('[data-action="canvas-code"]')).click();
    await until(() => canvas.canvasState().artifact !== null);
    assert.equal(canvas.canvasState().artifact?.localOnly, true);
    assert.ok(panel().querySelector('[data-canvas-local]'));
  });

  it('asks nothing and sends nothing for an AI edit while a cloud model is chosen', async () => {
    state.setAssistant(CLOUD);
    const before = await storedPath();
    await editWithAi('rename the variables');
    assert.match(statusText(), /This document stays on this device/);
    assert.equal(leaked(), false);
    assert.equal((await storedPath()).length, before.length, 'no question was stored');
    assert.equal(canvas.canvasState().artifact?.versions.length, 1);
  });

  it('refuses a question that stays on this device before it is stored when a cloud model is chosen', async () => {
    const before = await storedPath();
    await chat.submitChat(`Rewrite this:\n${SECRET}`, { chatMode: 'free', localOnly: true });
    assert.equal(leaked(), false);
    assert.equal((await storedPath()).length, before.length);
    const notices = [...document.querySelectorAll('#chatMessages [role="status"]')].map((n) => n.textContent ?? '');
    assert.ok(notices.some((n) => /This question stays on this device/.test(n)), notices.join(' | '));
  });

  it('has the own server answer the AI edit and stores it as staying on this device', async () => {
    state.setAssistant(SERVER);
    const before = await storedPath();
    await editWithAi('rename the variables');
    const path = await storedPath();
    assert.equal(path.length, before.length + 2, 'the edit is a turn of the chat');
    const [question, reply] = path.slice(-2);
    assert.equal(question.role, 'user');
    assert.equal(question.localOnly, true, 'the edit question stays on this device');
    assert.match(String(question.meta?.context ?? ''), /ONLY_ON_THIS_DEVICE_0/, 'the document went along in its context block');
    assert.equal(reply.provider, 'local');
    assert.equal(reply.localOnly, true);
    const doc = canvas.canvasState().artifact;
    assert.equal(doc?.versions.length, 2);
    assert.equal(doc?.versions.at(-1)?.by, 'ai');
    assert.equal(doc?.localOnly, true);
    // A later question to the cloud model gets none of it as history.
    state.setAssistant(CLOUD);
    const sent = cloudBodies.length;
    /** @type {HTMLTextAreaElement} */ (document.getElementById('chatInput')).value = 'A follow-up for the cloud model';
    await chat.submitChat();
    assert.ok(cloudBodies.length > sent, 'the cloud model was asked');
    assert.equal(leaked(), false);
  });

  it('keeps a block of a compare column marked as staying on this device', async () => {
    const { OPEN_CANVAS_EVENT } = await import('../../src/js/code-blocks.js');
    const column = document.createElement('article');
    column.setAttribute('data-stays-on-device', '');
    const block = document.createElement('pre');
    column.append(block);
    document.body.append(column);
    block.dispatchEvent(new window.CustomEvent(OPEN_CANVAS_EVENT, { bubbles: true, cancelable: true, detail: { code: 'column = 1', language: 'python', title: 'From a column' } }));
    await until(() => canvas.canvasState().artifact?.title === 'From a column');
    assert.equal(canvas.canvasState().artifact?.localOnly, true);
    column.remove();
  });
});
