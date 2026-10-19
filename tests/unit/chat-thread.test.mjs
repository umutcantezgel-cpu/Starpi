// The chat thread end to end in a DOM (jsdom) with the app database in memory (fake-indexeddb) and
// the OpenAI-compatible fake as the user's own server: a free question streams an answer that is
// stored with its usage; Continue after the length limit adds a new turn; regenerating and editing
// add siblings (the branch navigator switches between them); the stored context block travels with
// the question but never shows; a failing model shows a notice from i18n, never the server's text.
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
  <select id="engineSelector"></select>
  <div id="chatMessages"><div class="welcome">Welcome</div></div>
  <form id="chatForm">
    <div class="mode-toggle"><button type="button" data-action="set-chat-mode" data-arg="auto"></button><button type="button" data-action="set-chat-mode" data-arg="free"></button><button type="button" data-action="set-chat-mode" data-arg="grounded"></button></div>
    <span id="chatModeHint"></span><button type="button" id="thinkingToggle" data-action="toggle-thinking"></button><button type="button" id="webToggle" data-action="toggle-web"></button>
    <div id="toolsMenuList"></div><div id="attachedInfo" class="hidden"></div><p id="composerNotice" class="hidden"></p>
    <input type="file" id="chatFileInput" data-change="attach-file"><span id="composerMicSlot"><button type="button" id="voiceBtn">mic</button></span><span id="composerVoiceSlot"></span>
    <textarea id="chatInput"></textarea><button type="button" id="stopBtn" class="hidden" data-action="stop-generation"></button><button type="submit" id="sendBtn"></button>
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
 * @param {() => boolean} check
 * @param {number} [ms]
 */
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

/** @param {string} text */
async function ask(text) {
  /** @type {HTMLTextAreaElement} */ (document.getElementById('chatInput')).value = text;
  await chat.submitChat();
}

const rows = (/** @type {'user' | 'assistant'} */ role) => [...document.querySelectorAll(`#chatMessages .message-row[data-role="${role}"]`)].map((el) => /** @type {HTMLElement} */ (el));

async function storedPath() {
  const store = await chatStore.chatData();
  const t = await store.loadThread(chatStore.currentSessionId());
  return t?.path ?? [];
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
  const providers = await import('../../src/js/providers.js');
  await providers.refreshProviders();
  thread = await import('../../src/js/chat/thread.js');
});

after(async () => {
  await fake.close();
  (await chatStore.chatData()).close();
  jsdom.window.close();
});

describe('chat thread', () => {
  it('streams a free answer from the own server and stores the question and answer', async () => {
    await ask('Hello there, how are you?');
    const answer = rows('assistant').at(-1);
    assert.ok(answer);
    assert.match(answer.querySelector('.message-content')?.textContent ?? '', /simulated answer from the local test provider/);
    assert.equal(answer.querySelector('.engine-badge-label')?.textContent, 'Your server · fake-local:8b');
    assert.ok(answer.querySelector('[data-answer-label="free"]'), 'free answers are labelled not checked');
    const path = await storedPath();
    assert.deepEqual(path.map((n) => n.role), ['user', 'assistant']);
    assert.equal(path[1].provider, 'local');
    assert.equal(path[1].label, 'free');
    assert.equal(answer.dataset.nodeId, path[1].id);
    // The context block (date and time) is kept with the question, outside its text.
    assert.match(String(path[0].meta?.context), /^<<<CONTEXT>>>\n/);
    assert.equal(rows('user').at(-1)?.querySelector('.message-content')?.textContent, 'Hello there, how are you?');
    assert.ok(path[1].usage && path[1].usage.output > 0);
  });

  it('keeps the model\'s reasoning in the details block, never in the answer', async () => {
    await ask('[[fake:reasoning]] Why is the sky blue?');
    const answer = rows('assistant').at(-1);
    assert.doesNotMatch(answer?.querySelector('.message-content')?.textContent ?? '', /key facts|think>/);
    assert.match(answer?.querySelector('.thought-body')?.textContent ?? '', /I recall the key facts first/);
    const path = await storedPath();
    assert.match(String(path.at(-1)?.meta?.reasoning), /key facts/);
    assert.doesNotMatch(String(path.at(-1)?.parts[0].text), /<think>/);
  });

  it('offers Continue after the length limit and continues as a new turn', async () => {
    await ask('[[fake:length]] Explain the tides');
    const cut = rows('assistant').at(-1);
    const cont = /** @type {HTMLButtonElement | null} */ (cut?.querySelector('[data-action="msg-continue"]') ?? null);
    assert.ok(cont, 'Continue is offered');
    cont.click();
    await until(() => document.querySelector('.continue-marker') !== null && !thread.isThreadBusy());
    await until(() => !thread.isThreadBusy());
    const path = await storedPath();
    assert.deepEqual(path.slice(-4).map((n) => n.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(path.at(-2)?.meta?.continue, true);
    assert.equal(path.at(-3)?.meta?.stop_reason, 'max_tokens');
    assert.equal(rows('assistant').at(-2)?.querySelector('[data-action="msg-continue"]'), null, 'only the newest answer offers Continue');
  });

  it('regenerates an answer as a sibling and switches between the branches', async () => {
    const before = await storedPath();
    const last = /** @type {import('../../src/js/store/schema.js').NodeRecord} */ (before.at(-1));
    await thread.regenerate(last.id, 'local:fake-local-reasoner:4b');
    const after = await storedPath();
    assert.equal(after.length, before.length);
    const fresh = after.at(-1);
    assert.notEqual(fresh?.id, last.id);
    assert.equal(fresh?.parentId, last.parentId);
    assert.equal(fresh?.model, 'fake-local-reasoner:4b');
    assert.equal(fresh?.meta?.requested, 'fake-local-reasoner:4b');
    const answer = rows('assistant').at(-1);
    assert.equal(answer?.querySelector('.branch-pos')?.textContent, '2/2');
    await thread.showBranch(/** @type {string} */ (fresh?.id), -1);
    assert.equal(rows('assistant').at(-1)?.querySelector('.branch-pos')?.textContent, '1/2');
    assert.equal((await storedPath()).at(-1)?.id, last.id);
  });

  it('answers an edited question as a new branch that keeps the earlier one', async () => {
    const path = await storedPath();
    const first = path[0];
    await thread.editQuestion(first.id, 'Hello again, edited');
    const now = await storedPath();
    assert.equal(now.length, 2);
    assert.equal(now[0].parentId, null);
    assert.notEqual(now[0].id, first.id);
    assert.equal(rows('user')[0].querySelector('.branch-pos')?.textContent, '2/2');
    await thread.showBranch(now[0].id, -1);
    assert.equal((await storedPath())[0].id, first.id);
  });

  it('gives every answer a speaker button and "Research this", and hands the answer to the voice features', async () => {
    await ask('Tell me about tides');
    const answer = /** @type {HTMLElement} */ (rows('assistant').at(-1));
    const id = /** @type {string} */ (answer.dataset.nodeId);
    const speaker = answer.querySelector('[data-action="voice-read-aloud"]');
    assert.equal(speaker?.getAttribute('data-arg'), id);
    assert.equal(speaker?.getAttribute('aria-label'), 'Read aloud');
    const research = answer.querySelector('[data-action="msg-extra"][data-extra="research"]');
    assert.equal(research?.getAttribute('aria-label'), 'Research this');
    const question = /** @type {HTMLElement} */ (rows('user').at(-1));
    assert.equal(question.querySelector('[data-action="voice-read-aloud"]'), null, 'questions are not read aloud');
    assert.equal(question.querySelector('[data-extra="research"]'), null);
    const { voiceUi, composerInput } = await import('../../src/js/voice/hooks.js');
    const readable = voiceUi().getAnswer?.(id);
    assert.equal(readable?.label, 'free');
    assert.equal(readable?.question, 'Tell me about tides');
    assert.match(readable?.text ?? '', /simulated answer from the local test provider/);
    assert.deepEqual(readable?.sources, []);
    assert.equal(voiceUi().getAnswer?.(/** @type {string} */ (question.dataset.nodeId)), null, 'a question is no answer');
    assert.equal(composerInput(), document.getElementById('chatInput'));
  });

  it('answers a Live turn through the chat\'s model and fails a turn without a model with no_model', async () => {
    const { voiceUi } = await import('../../src/js/voice/hooks.js');
    const ask = /** @type {NonNullable<ReturnType<typeof voiceUi>['ask']>} */ (voiceUi().ask);
    let text = '';
    for await (const delta of ask({ text: 'How long is a day on Mars?', mode: 'free', sources: [], history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello.' }], image: null, locale: 'en', signal: new AbortController().signal })) text += delta;
    assert.match(text, /simulated answer from the local test provider/);
    const seen = fake.requests.filter((r) => /chat\/completions/.test(r.path) && JSON.stringify(r.body).includes('day on Mars')).at(-1)?.body;
    assert.match(String(seen?.messages?.[0]?.content), /This conversation is spoken/);
    assert.deepEqual(seen?.messages?.slice(1).map((/** @type {any} */ m) => m.role), ['user', 'assistant', 'user']);
    const state = await import('../../src/js/state.js');
    state.setAssistant('device');
    try {
      await assert.rejects(async () => {
        for await (const _ of ask({ text: 'x', mode: 'free', sources: [], history: [], image: null, locale: 'en', signal: new AbortController().signal })) void _;
      }, (/** @type {any} */ err) => err.code === 'no_model');
    } finally {
      state.setAssistant('local:*');
    }
  });

  it('shows a failing model as a notice from i18n, without the server text', async () => {
    await ask('[[fake-fault:500]] This fails');
    const notices = [...document.querySelectorAll('#chatMessages [role="status"]')].map((n) => n.textContent ?? '');
    assert.ok(notices.some((n) => /The provider has a problem right now/.test(n)), notices.join(' | '));
    const path = await storedPath();
    assert.equal(path.at(-1)?.role, 'user', 'no answer is stored');
  });
});

describe('voice and web helpers of the thread', () => {
  it('builds a spoken request with the excerpts of a source turn and a picture only for a model that sees', () => {
    const req = thread.liveRequest(
      { provider: 'local', model: 'fake-local:8b', route: 'local' },
      { text: 'What does the plan say?', mode: 'grounded', sources: [{ label: '[Doc: plan.md, Chunk: 1]', text: 'The plan has three phases.' }], history: [], image: { mime: 'image/jpeg', data: 'AAAA' }, locale: 'de-AT', signal: new AbortController().signal },
    );
    assert.match(String(req.system), /Dieses Gespräch wird gesprochen/);
    assert.match(String(req.system), /<<<EXCERPT 1 \[Doc: plan\.md, Chunk: 1\]>>>\nThe plan has three phases\./);
    assert.equal(req.maxOutputTokens, 700);
    assert.deepEqual(req.messages.at(-1)?.content.map((p) => p.type), ['text']);
    const device = thread.liveRequest({ provider: 'webgpu', model: 'qwen', route: 'device' }, { text: 'Hi', mode: 'free', sources: [], history: [], image: null, locale: 'en', signal: new AbortController().signal });
    assert.equal(device.maxOutputTokens, undefined);
    assert.match(String(device.system), /on-device AI assistant/);
  });

  it('reads a streaming answer aloud without the reasoning a model writes into its text', () => {
    assert.equal(thread.readableSoFar('Hello wor', ''), 'Hello wor');
    assert.equal(thread.readableSoFar('Hello world. ', 'Hello wor'), 'Hello world.');
    assert.equal(thread.readableSoFar('<thi', ''), '', 'an opening tag waits');
    assert.equal(thread.readableSoFar('<think>Let me see', ''), '');
    assert.equal(thread.readableSoFar('<think>Let me see</think>', ''), '');
    assert.equal(thread.readableSoFar('<think>Let me see</think>The answer', ''), 'The answer');
    // Text that no longer extends what was read (it turned out to be reasoning) adds nothing.
    assert.equal(thread.readableSoFar('<think>x', 'Hi'), 'Hi');
  });

  it('turns the web citations of an answer into the read-aloud grounding', () => {
    const base = { text: 'Paris has 2.1 million people. It is old.', reasoning: '', reasoningTokens: 0, toolCalls: [], images: [], opaque: [], stopReason: /** @type {const} */ ('end'), provider: /** @type {const} */ ('gemini'), model: 'm', requestId: null, usage: null };
    assert.equal(thread.webGrounding({ ...base, citations: [] }), null);
    const g = thread.webGrounding({
      ...base,
      citations: [
        { url: 'https://example.org/paris', title: 'Paris', start: 0, end: 29 },
        { url: 'https://example.org/paris', title: 'Paris', start: 30, end: 40 },
        { url: 'javascript:alert(1)', title: 'x', start: 0, end: 5 },
        { url: 'https://example.org/other', title: '' },
      ],
    });
    assert.deepEqual(g, {
      sources: [{ uri: 'https://example.org/paris', title: 'Paris' }, { uri: 'https://example.org/other' }],
      segments: [
        { start: 0, end: 29, sources: [0] },
        { start: 30, end: 40, sources: [0] },
      ],
    });
  });
});
