// Notes for the request of the question being answered (chat/hooks.js registerRequestNotes), in a
// DOM (jsdom) with the app database in memory and the OpenAI-compatible fake as the own server:
// they go along with the question they were asked for, in their own context block, are never
// stored with it and never sent again with a later turn; a regenerated answer asks for them again,
// Continue does not, and a hook that stops giving notes leaves none anywhere in the request. A
// question asked outside the thread (compare, council: thread.js prepareQuestion) gets the same
// notes, asked once for every model, and none for Continue.
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

/** The note the hook gives, per question; null gives none. */
/** @type {(question: string) => string | null} */
let noteFor = () => null;
/** @type {string[]} */
const asked = [];

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {() => boolean} check */
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

/** The messages of the newest chat request (the title calls are left out). */
function lastChat() {
  const body = fake.requests.filter((r) => /chat\/completions/.test(r.path) && !JSON.stringify(r.body ?? '').includes('You name conversations')).at(-1)?.body;
  return /** @type {Array<{ role: string, content: unknown }>} */ (body?.messages ?? []);
}

/** @param {{ content: unknown }} message  the text of a message (its parts joined) */
const textOf = (message) => (typeof message.content === 'string' ? message.content : (/** @type {any[]} */ (message.content) ?? []).map((p) => p?.text ?? '').join('\n\n'));

async function storedPath() {
  const store = await chatStore.chatData();
  return (await store.loadThread(chatStore.currentSessionId()))?.path ?? [];
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
  thread.registerRequestNotes((ctx) => {
    asked.push(ctx.question);
    const note = noteFor(ctx.question);
    return note ? [note] : [];
  });
});

after(async () => {
  await fake.close();
  (await chatStore.chatData()).close();
  jsdom.window.close();
});

describe('request notes', () => {
  it('go along with the question they were asked for, in their own block, and are never stored', async () => {
    noteFor = (q) => `Saved: the user grows tomatoes (asked for "${q}")`;
    await ask('How often should I water seedlings?');
    const first = lastChat();
    const question = first.at(-1);
    assert.ok(question);
    assert.match(textOf(question), /<<<CONTEXT>>>\nNotes:\nSaved: the user grows tomatoes \(asked for "How often should I water seedlings\?"\)\n<<<END CONTEXT>>>/);
    // The stored context block (date and time) comes first, the request's notes after it.
    assert.ok(textOf(question).indexOf('Current date and time') < textOf(question).indexOf('the user grows tomatoes'));
    const path = await storedPath();
    assert.match(String(path[0].meta?.context), /^<<<CONTEXT>>>\n/);
    assert.doesNotMatch(JSON.stringify(path[0]), /tomatoes/);
  });

  it('are not sent again with a later turn, and none at all once the hook gives none', async () => {
    await ask('And how much sun do they need?');
    const second = lastChat();
    const users = second.filter((m) => m.role === 'user');
    assert.equal(users.length, 2);
    assert.doesNotMatch(textOf(users[0]), /tomatoes/, 'the earlier question goes without its notes');
    assert.match(textOf(users[1]), /asked for "And how much sun do they need\?"/);
    // The feature holds its notes back (switched off, deleted, locked): no turn carries one.
    noteFor = () => null;
    await ask('Thanks!');
    assert.doesNotMatch(JSON.stringify(lastChat()), /tomatoes/);
  });

  it('are asked for again for a regenerated answer, not for Continue', async () => {
    noteFor = (q) => `Saved: the user lives by the sea (for "${q}")`;
    await ask('[[fake:length]] Describe the coast');
    const path = await storedPath();
    const answer = path.at(-1);
    assert.ok(answer);
    const before = asked.length;
    await thread.regenerate(answer.id, null);
    await until(() => !thread.isThreadBusy());
    assert.equal(asked.length, before + 1);
    assert.match(textOf(/** @type {any} */ (lastChat().at(-1))), /lives by the sea \(for "\[\[fake:length\]\] Describe the coast"\)/);
    const cut = [...document.querySelectorAll('#chatMessages .message-row[data-role="assistant"]')].at(-1);
    const cont = /** @type {HTMLButtonElement | null} */ (cut?.querySelector('[data-action="msg-continue"]') ?? null);
    assert.ok(cont, 'Continue is offered');
    cont.click();
    await until(() => document.querySelector('.continue-marker') !== null);
    await until(() => !thread.isThreadBusy());
    assert.equal(asked.length, before + 1, 'Continue asks for no notes');
    assert.doesNotMatch(JSON.stringify(lastChat()), /lives by the sea/);
  });

  it('go along with a question asked outside the thread, asked once for every model, and none for Continue', async () => {
    noteFor = (q) => `Saved: the user keeps bees (for "${q}")`;
    const id = chatStore.currentSessionId();
    const before = asked.length;
    const prepared = await thread.prepareQuestion({ conversationId: id, text: 'When do bees swarm?' });
    const target = /** @type {any} */ ({ provider: 'local', model: 'fake-local:8b', route: 'local' });
    const first = await prepared.build(target);
    const second = await prepared.build({ ...target, model: 'fake-local-reasoner:4b' });
    assert.equal(asked.length, before + 1, 'asked once for the question');
    for (const req of [first, second]) {
      const question = /** @type {any} */ (req.messages.at(-1));
      assert.match(question.content.map((/** @type {any} */ p) => p.text ?? '').join('\n'), /Saved: the user keeps bees \(for "When do bees swarm\?"\)/);
    }
    assert.doesNotMatch(JSON.stringify(prepared.question), /keeps bees/, 'never kept with the question');
    // The hooks learn whether the question stays on this device (the tools then keep it here).
    assert.equal(prepared.ctx.localOnly, false);
    assert.equal((await thread.prepareQuestion({ conversationId: id, text: 'A question that stays here', localOnly: true })).ctx.localOnly, true);
    // A stored "Continue" asks for the rest of an answer: no notes.
    const continued = (await storedPath()).find((n) => n.role === 'user' && /** @type {any} */ (n.meta)?.continue);
    assert.ok(continued, 'the earlier test left a Continue turn');
    const again = await thread.prepareQuestion({ conversationId: id, questionId: continued.id });
    const req = await again.build(target);
    assert.equal(asked.length, before + 1);
    assert.doesNotMatch(JSON.stringify(req), /keeps bees/);
    noteFor = () => null;
  });
});
