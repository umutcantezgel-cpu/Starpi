// The paired companion in the chat, in a DOM (jsdom) with the app database in memory
// (fake-indexeddb), a stand-in companion whose /v1/chat keeps conversations as the real one does (a
// question after an earlier turn goes on in a copy of the turns up to it), and the
// OpenAI-compatible fake as the user's own server:
//   - an answer asked for again, or a changed question, goes on in a branch of its own, and the next
//     question goes on in the branch on screen;
//   - a question to the companion stays on this device like its answer: never synced, answered
//     again only here, and the privacy line and the notice say so;
//   - a compare column asks the companion as the thread does (the bare question, free or sources,
//     its data class), shows what its gate released, and a question continued with it stays here;
//   - a free Live turn asks it the same way and goes on in the session's conversation; a source
//     turn does not ask it.
/* global document */
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { fakeCompanion } from './companion-fakes.mjs';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'HTMLFormElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'CustomEvent', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS', 'DOMParser', 'getComputedStyle', 'MutationObserver'];

const COMPANION = 'companion:starpi-core';

const MARKUP = `<!doctype html><html><body>
  <div id="toastRegion"></div><span id="assistantStatusText"></span><span id="servedModel" class="hidden"></span><p id="privacyNotice"></p>
  <select id="engineSelector"><option value="auto">Auto</option><option value="${COMPANION}">Starpi Core</option><option value="local:fake-local:8b">fake-local:8b</option><option value="local:fake-local:70b">fake-local:70b</option></select>
  <div id="chatMessages"><div class="welcome">Welcome</div></div>
  <button type="button" id="newChat" data-action="new-chat"></button>
  <form id="chatForm">
    <span id="chatModeHint"></span><button type="button" id="thinkingToggle"></button><button type="button" id="webToggle"></button>
    <div id="toolsMenuList"></div><div id="attachedInfo" class="hidden"></div><p id="composerNotice" class="hidden"></p>
    <input type="file" id="chatFileInput"><span id="composerMicSlot"></span><span id="composerVoiceSlot"></span>
    <textarea id="chatInput"></textarea><button type="button" id="stopBtn" class="hidden"></button><button type="submit" id="sendBtn"></button>
  </form>
  <aside id="chat-aside"><div id="chat-aside-compare"></div></aside>
</body></html>`;

/** @type {Awaited<ReturnType<ReturnType<typeof createOpenAiFake>['listen']>>} */
let server;
/** @type {JSDOM} */
let jsdom;
const fake = createOpenAiFake({ flavor: 'ollama', gapMs: 0 });
const companion = fakeCompanion();
/** Bodies of the questions the companion was asked, in order. */
/** @type {any[]} */
const asked = [];
/** Request bodies sent to Anthropic (a provider in the cloud). */
/** @type {string[]} */
const cloudBodies = [];
/** @type {typeof import('../../src/js/chat.js')} */
let chat;
/** @type {typeof import('../../src/js/chat/thread.js')} */
let thread;
/** @type {typeof import('../../src/js/chat-store.js')} */
let chatStore;
/** @type {typeof import('../../src/js/chat/compare.js')} */
let compare;
/** @type {typeof import('../../src/js/state.js')} */
let state;

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => boolean | Promise<boolean>} check
 * @param {number} [ms]
 */
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

/** @param {string} text */
async function ask(text) {
  /** @type {HTMLTextAreaElement} */ (document.getElementById('chatInput')).value = text;
  await chat.submitChat();
}

/** The stored active path of the chat on screen. */
async function storedPath() {
  return (await (await chatStore.chatData()).loadThread(chatStore.currentSessionId()))?.path ?? [];
}

/** Every stored message and the record of the chat on screen. */
async function storedChat() {
  const loaded = await (await chatStore.chatData()).loadThread(chatStore.currentSessionId());
  return { conversation: /** @type {any} */ (loaded?.conversation), nodes: loaded?.nodes ?? [] };
}

const notices = () => [...document.querySelectorAll('#chatMessages [role="status"]')].map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim());
const panel = () => /** @type {HTMLElement} */ (document.getElementById('chat-aside-compare'));
const columns = () => [...panel().querySelectorAll('[data-column]')].map((el) => /** @type {HTMLElement} */ (el));
const settled = () => compare.compareState().running === 0 && compare.compareState().columns.every((c) => c.status !== 'pending' && c.status !== 'streaming');

/** Starts a new chat the way the header button does. */
function newChat() {
  /** @type {HTMLButtonElement} */ (document.getElementById('newChat')).click();
}

/**
 * The companion's answer of one turn.
 * @param {string} text
 * @param {string} mode
 */
const answerOf = (text, mode) => ({ id: `ans-${asked.length}`, text, units: [], withheld: [], sources: [], mode, dataClass: 'personal', model: 'small-local', locality: 'local', source: 'model', notice: null, counts: { released: 1, withheld: 0 } });

/**
 * Opens Compare on a question with the companion first and the own server second (two columns).
 * @param {{ conversationId?: string, questionId?: string, text: string }} input
 */
async function compareWithCompanion(input) {
  compare.openCompare({ ...input, first: COMPANION });
  for (;;) {
    const extra = panel().querySelector('[data-action="compare-remove"][data-arg="2"]');
    if (!extra) break;
    /** @type {HTMLButtonElement} */ (extra).click();
  }
  assert.deepEqual(compare.compareState().values, [COMPANION, 'local:fake-local:8b']);
  /** @type {HTMLFormElement} */ (panel().querySelector('[data-compare-form]')).requestSubmit();
  await until(() => columns().length === 2);
  await until(settled);
}

before(async () => {
  server = await fake.listen(0);
  jsdom = new JSDOM(MARKUP, { url: 'https://app.example/', pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: jsdom.window.navigator, configurable: true, writable: true });

  // The companion keeps one line per conversation; a question after an earlier turn than the last
  // goes on in a copy of the turns up to it, as packages/companion does.
  /** @type {Map<string, number>} */
  const turns = new Map();
  let made = 0;
  companion.handlers.set('POST /v1/chat', (req) => {
    const body = req.body;
    asked.push(body);
    let id = body.conversation;
    /** @type {string | null} */
    let from = null;
    if (!id) {
      id = `conv-${(made += 1)}`;
      turns.set(id, 0);
    } else if (typeof body.after === 'number' && body.after < (turns.get(id) ?? 0)) {
      from = id;
      id = `conv-${(made += 1)}`;
      turns.set(id, body.after);
    }
    const turn = (turns.get(id) ?? 0) + 1;
    turns.set(id, turn);
    const text = `Reply ${asked.length} of the companion.`;
    return {
      events: [
        { event: 'start', data: { conversation: id, turn, ...(from ? { from } : {}) } },
        { event: 'unit', data: { text, cites: [], kind: 'sentence' } },
        { event: 'done', data: { conversation: id, turn, answer: answerOf(text, body.mode) } },
      ],
    };
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(companion.origin)) return companion.fetch(url, init);
    if (url.includes('api.anthropic.com')) {
      cloudBodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/models/pool')) return new Response(JSON.stringify({ pools: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    return realFetch(input, init);
  };
  sessionStorage.setItem('starpi_key_anthropic', 'sk-ant-unit0123456789abcdefghijklmnop');
  localStorage.setItem('starpi_llm_url', `${server.url}/flavor/ollama/v1`);
  localStorage.setItem('starpi_assistant_v1', COMPANION);
  localStorage.setItem('starpi_chat_mode', 'free');
  const dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  (await import('../../src/js/messages.js')).initMessages();
  chat = await import('../../src/js/chat.js');
  chat.initChat();
  chatStore = await import('../../src/js/chat-store.js');
  state = await import('../../src/js/state.js');
  // Paired as the Settings card pairs (the link sealed in IndexedDB, the flag set).
  const { companionPairing } = await import('../../src/js/companion/pair.js');
  await companionPairing().pair({ code: 'ABCDEFGH', origin: companion.origin });
  await (await import('../../src/js/providers.js')).refreshProviders();
  thread = await import('../../src/js/chat/thread.js');
  await thread.showConversation();
  compare = await import('../../src/js/chat/compare.js');
  compare.mountCompare(panel(), {});
});

after(async () => {
  chatStore.bindChatSync(null);
  await fake.close();
  (await chatStore.chatData()).close();
  jsdom.window.close();
});

describe('a companion conversation follows the branch being asked', () => {
  it('asks an answer again and a changed question in branches of their own, and goes on in the branch on screen', async () => {
    const first = asked.length;
    await ask('Where is the ladder?');
    await ask('And the paint?');
    assert.deepEqual(asked[first], { question: 'Where is the ladder?', mode: 'free' }, 'the bare question, never the context block');
    assert.deepEqual(asked[first + 1], { question: 'And the paint?', mode: 'free', conversation: 'conv-1', after: 1 });

    // Asked again: the question follows turn 1, so the companion goes on in a copy of it.
    const replaced = /** @type {any} */ ((await storedPath()).at(-1));
    assert.equal(replaced.meta.companion.turn, 2);
    await thread.regenerate(replaced.id, null);
    assert.deepEqual(asked[first + 2], { question: 'And the paint?', mode: 'free', conversation: 'conv-1', after: 1 });
    const again = /** @type {any} */ ((await storedPath()).at(-1));
    assert.notEqual(again.id, replaced.id);
    assert.equal(again.parentId, replaced.parentId, 'a branch beside the answer it replaces');
    assert.deepEqual([again.meta.companion.conversation, again.meta.companion.turn], ['conv-2', 2], 'its history holds turn 1 only');

    // Changed: again a copy of turn 1, without the discarded question.
    await thread.editQuestion(/** @type {string} */ (replaced.parentId), 'And the brushes?');
    assert.deepEqual(asked[first + 3], { question: 'And the brushes?', mode: 'free', conversation: 'conv-1', after: 1 });
    const edited = /** @type {any} */ ((await storedPath()).at(-1));
    assert.deepEqual([edited.meta.companion.conversation, edited.meta.companion.turn], ['conv-3', 2]);

    // The next question goes on in the branch on screen, without another copy.
    await ask('Thanks!');
    assert.deepEqual(asked[first + 4], { question: 'Thanks!', mode: 'free', conversation: 'conv-3', after: 2 });
    // Back on the first question's branch, it goes on where that branch's latest answer is.
    await thread.showBranch(/** @type {string} */ (edited.parentId), -1);
    const shown = /** @type {any} */ ((await storedPath()).at(-1));
    assert.equal(shown.provider, 'companion');
    await ask('One more?');
    assert.deepEqual(asked[first + 5], { question: 'One more?', mode: 'free', conversation: shown.meta.companion.conversation, after: shown.meta.companion.turn });
  });
});

describe('a question to the companion stays on this device', () => {
  it('is stored local-only like its answer, never synced, and the privacy line says so with sync on', async () => {
    const settings = await import('../../src/js/settings.js');
    settings.initSettings();
    chatStore.bindChatSync({ statusLine: () => ({ key: 'sync.line.on', params: { n: '1' } }), flush: async () => true });
    await chatStore.refreshSyncStatus();
    await until(() => document.querySelector('#privacyNotice [data-history-unsynced]') !== null);
    assert.match(document.querySelector('#privacyNotice [data-history-unsynced]')?.textContent ?? '', /questions to the companion and its answers stay on this device/);
    assert.equal(document.querySelector('#privacyNotice [data-history-synced]'), null, 'it does not claim the chat reaches the other browsers');

    newChat();
    await ask('Which code opens the shed?');
    const { conversation, nodes } = await storedChat();
    const question = /** @type {any} */ (nodes.find((n) => n.role === 'user'));
    const answer = /** @type {any} */ (nodes.find((n) => n.role === 'assistant'));
    assert.equal(question.localOnly, true);
    assert.equal(question.meta.kept_for_companion, true);
    assert.equal(answer.localOnly, true);
    assert.equal(asked.at(-1).dataClass, undefined, 'asked of the companion only: not sensitive');
    const { buildPayload } = await import('../../src/js/sync/payload.js');
    assert.equal(buildPayload(conversation, nodes), null, 'nothing of it goes into the synced copy');

    // Asked again, it goes to no model in the cloud: the notice says why, nothing is sent.
    const before = cloudBodies.length;
    await thread.regenerate(answer.id, 'anthropic:claude-haiku-5-5');
    assert.equal(cloudBodies.length, before);
    assert.ok(notices().some((n) => /asked of your companion and stays on this device like its answer/.test(n)), notices().join(' | '));
    chatStore.bindChatSync(null);
  });

  it('goes as sensitive when it was asked to stay here for what it holds', async () => {
    newChat();
    const db = await chatStore.chatData();
    const id = chatStore.currentSessionId();
    await db.createConversation({ id, mode: 'free', model: 'device' });
    // A question asked with the model of this device, and its answer.
    const q = await db.appendNode(id, { parentId: null, role: 'user', parts: [{ type: 'text', text: 'My notes say what?' }], localOnly: true, meta: { chat_mode: 'free' } });
    const a = await db.appendNode(id, { parentId: q.id, role: 'assistant', parts: [{ type: 'text', text: 'They say hello.' }], provider: 'webgpu', model: 'webgpu:x', label: 'free', localOnly: true, meta: { chat_mode: 'free', engine: 'client' } });
    await thread.showConversation(id);
    await thread.regenerate(a.id, COMPANION);
    assert.deepEqual(asked.at(-1), { question: 'My notes say what?', mode: 'free', dataClass: 'sensitive' });
  });
});

describe('a compare column asks the companion as the thread does', () => {
  it('sends the bare question in free mode and shows what its gate released, marked as staying here', async () => {
    newChat();
    state.setAssistant('local:fake-local:8b');
    await ask('Name a river');
    const question = /** @type {any} */ ((await storedPath()).at(-2));
    assert.match(String(question.meta.context), /^<<<CONTEXT>>>/, 'the stored question has a context block');
    const before = asked.length;
    await compareWithCompanion({ conversationId: chatStore.currentSessionId(), questionId: question.id, text: 'Name a river' });
    assert.equal(asked.length, before + 1);
    assert.deepEqual(asked.at(-1), { question: 'Name a river', mode: 'free' }, 'no context block, no system prompt');
    const [own, server] = columns();
    assert.equal(own.dataset.status, 'done');
    assert.equal(own.querySelector('[data-column-body]')?.textContent?.trim(), `Reply ${asked.length} of the companion.`);
    assert.ok(own.querySelector('[data-answer-label="companion_free"]'), 'labelled with the companion label');
    assert.ok(own.hasAttribute('data-stays-on-device'));
    assert.equal(server.dataset.status, 'done');
    assert.equal(server.hasAttribute('data-stays-on-device'), false);
    // Continued, the companion's answer stays on this device; the question was already asked elsewhere.
    /** @type {HTMLButtonElement} */ (own.querySelector('[data-action="compare-continue"]')).click();
    await until(() => compare.compareState().columns[0].adopted !== null);
    const stored = /** @type {any} */ ((await storedChat()).nodes.find((n) => n.id === compare.compareState().columns[0].adopted));
    assert.equal(stored.provider, 'companion');
    assert.equal(stored.localOnly, true);
    assert.equal(stored.parts[0].text, `Reply ${asked.length} of the companion.`);
  });

  it('asks a grounded question in sources mode, and one held here as sensitive', async () => {
    const db = await chatStore.chatData();
    const id = chatStore.currentSessionId();
    const leaf = (await storedPath()).at(-1);
    const held = await db.appendNode(id, { parentId: leaf?.id ?? null, role: 'user', parts: [{ type: 'text', text: 'What do my files say about rivers?' }], localOnly: true, meta: { chat_mode: 'grounded', device_only: true } });
    await compareWithCompanion({ conversationId: id, questionId: held.id, text: 'What do my files say about rivers?' });
    assert.deepEqual(
      (({ question, mode, dataClass }) => ({ question, mode, dataClass }))(asked.at(-1)),
      { question: 'What do my files say about rivers?', mode: 'sources', dataClass: 'sensitive' },
    );
    assert.equal(columns()[0].dataset.status, 'done');
    assert.equal(columns()[1].dataset.status, 'done', 'the own server answers a question that stays here too');
  });

  it('keeps a new question continued with the companion column on this device', async () => {
    newChat();
    await compareWithCompanion({ text: 'A question for both' });
    assert.deepEqual(asked.at(-1), { question: 'A question for both', mode: 'free' }, 'asked of the companion and the own server only: not sensitive');
    /** @type {HTMLButtonElement} */ (columns()[0].querySelector('[data-action="compare-continue"]')).click();
    await until(() => compare.compareState().columns[0].adopted !== null);
    const path = await storedPath();
    const question = /** @type {any} */ (path.at(-2));
    assert.equal(question.role, 'user');
    assert.equal(question.localOnly, true);
    assert.equal(question.meta.kept_for_companion, true);
    // A column continued after it stays under that question, and on this device with it.
    /** @type {HTMLButtonElement} */ (columns()[1].querySelector('[data-action="compare-continue"]')).click();
    await until(() => compare.compareState().columns[1].adopted !== null);
    const other = /** @type {any} */ ((await storedChat()).nodes.find((n) => n.id === compare.compareState().columns[1].adopted));
    assert.equal(other.parentId, question.id);
    assert.equal(other.localOnly, true);
  });
});

describe('the council and Live', () => {
  it('never seats the companion in a council', async () => {
    const { councilPool } = await import('../../src/js/chat/council-view.js');
    const pool = councilPool([{ provider: 'companion', model: 'starpi-core', roles: ['fast'], pinned: true }, { provider: 'openai', model: 'gpt-x', roles: ['fast'], pinned: false }], []);
    assert.deepEqual(pool.map((e) => e.provider), ['openai']);
  });

  it('asks a free Live turn as the thread does and goes on in the session; a source turn does not ask it', async () => {
    state.setAssistant(COMPANION);
    const signal = new AbortController().signal;
    const turn = (/** @type {string} */ text, /** @type {'free' | 'grounded'} */ mode, /** @type {Array<{ role: 'user' | 'assistant', text: string }>} */ history) => ({ text, mode, sources: [], history, image: null, locale: 'en', signal });
    /** @param {AsyncIterable<string>} it */
    const all = async (it) => {
      const out = [];
      for await (const d of it) out.push(d);
      return out;
    };
    const before = asked.length;
    const first = await all(thread.liveAnswer(turn('Is it raining?', 'free', [{ role: 'user', text: 'Is it raining?' }])));
    assert.deepEqual(first, [`Reply ${asked.length} of the companion.`], 'in one piece, as its gate released it');
    assert.deepEqual(asked.at(-1), { question: 'Is it raining?', mode: 'free' });
    await all(thread.liveAnswer(turn('And tomorrow?', 'free', [{ role: 'user', text: 'Is it raining?' }, { role: 'assistant', text: first[0] }, { role: 'user', text: 'And tomorrow?' }])));
    assert.equal(asked.length, before + 2);
    assert.equal(typeof asked.at(-1).conversation, 'string', 'the session goes on in its conversation');
    assert.equal(asked.at(-1).after, 1);
    await assert.rejects(all(thread.liveAnswer(turn('What do my files say?', 'grounded', [{ role: 'user', text: 'What do my files say?' }]))), (err) => /** @type {any} */ (err).code === 'companion_sources');
    assert.equal(asked.length, before + 2, 'a source turn asks nothing');
  });
});
