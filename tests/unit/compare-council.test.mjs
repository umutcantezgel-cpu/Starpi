// Compare and the council in a DOM (jsdom) with the app database in memory (fake-indexeddb) and the
// OpenAI-compatible fake as the user's own server. Compare: the models it offers and starts with,
// the cost hint and time line, one question to 2 to 4 models in columns (each labelled as the
// thread labels a free answer, with its time, tokens and cost hint), a column stopped on its own,
// "Continue with this" as the newest branch under the question (and a question from the composer
// stored with the first answer continued). The council: its pool, the stored copy and the answer
// it becomes; in the chat with scripted providers, the judge's choice and the best draft when the
// judge fails, both labelled under the answer; no council for a question that stays on this device.
/* global document, window */
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { purposeMarker } from '../../src/js/ai/purposes.js';
import { fakeClock, scriptedProviders, systemText, testDeps } from './router-fakes.mjs';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'HTMLFormElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'CustomEvent', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS', 'DOMParser', 'getComputedStyle', 'MutationObserver'];

const MODELS = ['local:fake-local:8b', 'local:fake-local-reasoner:4b', 'local:fake-local:70b', 'local:fake-mini:1b'];

const MARKUP = `<!doctype html><html><body>
  <div id="toastRegion"></div><span id="assistantStatusText"></span><span id="servedModel" class="hidden"></span><p id="privacyNotice"></p>
  <select id="engineSelector"><option value="auto">Auto</option><option value="webgpu:qwen-small">On this device</option>${MODELS.map((m) => `<option value="${m}">${m.slice(6)}</option>`).join('')}</select>
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

/** @type {Awaited<ReturnType<ReturnType<typeof createOpenAiFake>['listen']>>} */
let server;
/** @type {JSDOM} */
let jsdom;
const fake = createOpenAiFake({ flavor: 'ollama', gapMs: 0 });
/** @type {typeof import('../../src/js/chat.js')} */
let chat;
/** @type {typeof import('../../src/js/chat-store.js')} */
let chatStore;
/** @type {typeof import('../../src/js/chat/compare.js')} */
let compare;
/** @type {typeof import('../../src/js/chat/council-view.js')} */
let council;
/** @type {string[]} */
const asides = [];
/** @type {string[]} */
const toasts = [];

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => boolean} check
 * @param {number} [ms]
 */
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

const rows = (/** @type {'user' | 'assistant'} */ role) => [...document.querySelectorAll(`#chatMessages .message-row[data-role="${role}"]`)].map((el) => /** @type {HTMLElement} */ (el));
const panel = () => /** @type {HTMLElement} */ (document.getElementById('chat-aside-compare'));
const columns = () => [...panel().querySelectorAll('[data-column]')].map((el) => /** @type {HTMLElement} */ (el));
const settled = () => compare.compareState().running === 0 && compare.compareState().columns.every((c) => c.status !== 'pending' && c.status !== 'streaming');

async function storedPath() {
  const store = await chatStore.chatData();
  return (await store.loadThread(chatStore.currentSessionId()))?.path ?? [];
}

/** @param {string} text */
async function ask(text) {
  /** @type {HTMLTextAreaElement} */ (document.getElementById('chatInput')).value = text;
  await chat.submitChat();
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
  localStorage.setItem('starpi_assistant_v1', 'local:fake-local:8b');
  localStorage.setItem('starpi_chat_mode', 'free');
  const dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  (await import('../../src/js/messages.js')).initMessages();
  chat = await import('../../src/js/chat.js');
  chat.initChat();
  chatStore = await import('../../src/js/chat-store.js');
  await (await import('../../src/js/providers.js')).refreshProviders();
  // The feature as the shell mounts it: message actions, composer tools, decorations.
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
    openChatAside: (tab) => void asides.push(String(tab)),
    closeChatAside: noop,
    openDialog: /** @type {any} */ (noop),
    closeDialog: noop,
    toast: (message) => {
      toasts.push(String(message));
      return noop;
    },
  });
  compare = await import('../../src/js/chat/compare.js');
  council = await import('../../src/js/chat/council-view.js');
});

after(async () => {
  await fake.close();
  (await chatStore.chatData()).close();
  jsdom.window.close();
});

describe('compare: models and numbers', () => {
  it('offers the picker\'s models without Auto and models of this device that are not loaded', () => {
    const choices = compare.pickerChoices(/** @type {HTMLSelectElement} */ (document.getElementById('engineSelector')));
    assert.deepEqual(choices.map((c) => c.value), MODELS);
    assert.equal(choices[0].provider, 'local');
    const select = document.createElement('select');
    select.innerHTML = '<option value="device">This device</option><option value="anthropic:claude-x">X</option><option value="openai:gpt-y" disabled>Y</option>';
    assert.deepEqual(compare.pickerChoices(select).map((c) => c.value), ['anthropic:claude-x']);
    assert.deepEqual(compare.pickerChoices(select, { deviceReady: true }).map((c) => c.provider), ['device', 'anthropic']);
  });

  it('starts with the given model, then one model per provider', () => {
    const choices = [
      { value: 'openai:a', label: 'A', provider: 'openai' },
      { value: 'openai:b', label: 'B', provider: 'openai' },
      { value: 'anthropic:c', label: 'C', provider: 'anthropic' },
      { value: 'groq:d', label: 'D', provider: 'groq' },
    ];
    assert.deepEqual(compare.defaultChoices(choices, 3), ['openai:a', 'anthropic:c', 'groq:d']);
    assert.deepEqual(compare.defaultChoices(choices, 2, 'openai:b'), ['openai:b', 'anthropic:c']);
    assert.deepEqual(compare.defaultChoices(choices, 4, 'groq:d'), ['groq:d', 'openai:a', 'anthropic:c', 'openai:b']);
    assert.deepEqual(compare.defaultChoices(choices.slice(0, 1), 3), ['openai:a'], 'never more than exist');
  });

  it('gives a cost hint and a time line', () => {
    const usage = { input: 1000, output: 500 };
    assert.equal(compare.costHint({ provider: 'webgpu', model: 'x', route: 'device' }, usage).key, 'canvas.compare.cost_device');
    assert.equal(compare.costHint({ provider: 'local', model: 'x', route: 'local' }, usage).key, 'canvas.compare.cost_server');
    assert.equal(compare.costHint({ provider: 'groq', model: 'x', route: 'pool' }, usage).key, 'canvas.compare.cost_pool');
    assert.deepEqual(compare.costHint({ provider: 'openai', model: 'x', route: 'key' }, { ...usage, costUsd: 0.25 }), { key: 'canvas.compare.cost', params: { usd: '0.25' } });
    assert.equal(compare.costHint({ provider: 'openai', model: 'no-such-model', route: 'key' }, usage).key, 'canvas.compare.cost_unknown');
    assert.equal(compare.costHint({ provider: 'openai', model: 'x', route: 'key' }, null).key, 'canvas.compare.cost_unknown');
    assert.deepEqual(compare.latencyLine({ durationMs: 2340, firstMs: 410 }), { key: 'canvas.compare.latency_first', params: { seconds: '2.3', first: '0.4' } });
    assert.deepEqual(compare.latencyLine({ durationMs: 900, firstMs: null }), { key: 'canvas.compare.latency', params: { seconds: '0.9' } });
  });
});

describe('compare in the side panel', () => {
  it('offers Compare models and Ask the council on answers and in the tools menu', async () => {
    await ask('Name three rivers');
    const answer = /** @type {HTMLElement} */ (rows('assistant').at(-1));
    assert.equal(answer.querySelector('[data-extra="compare"]')?.getAttribute('aria-label'), 'Compare models');
    assert.equal(answer.querySelector('[data-extra="council"]')?.getAttribute('aria-label'), 'Ask the council');
    assert.equal(rows('user').at(-1)?.querySelector('[data-extra="compare"]'), null, 'questions have neither');
    const speaker = answer.querySelector('[data-action="voice-read-aloud"]');
    assert.ok(speaker?.classList.contains('px-1.5') && !speaker.classList.contains('btn-icon'), 'the speaker button has the size of the bar\'s other buttons');
    const tools = [...document.querySelectorAll('#toolsMenuList [data-action="run-composer-tool"]')].map((b) => b.getAttribute('data-arg'));
    assert.deepEqual(tools, ['compare', 'council']);
  });

  it('asks the answer\'s question to three models in columns, each labelled with its numbers', async () => {
    const answer = /** @type {HTMLElement} */ (rows('assistant').at(-1));
    /** @type {HTMLButtonElement} */ (answer.querySelector('[data-extra="compare"]')).click();
    await until(() => panel().querySelector('[data-compare]') !== null);
    assert.equal(asides.at(-1), 'compare');
    const question = /** @type {HTMLTextAreaElement} */ (panel().querySelector('[data-compare-question]'));
    assert.equal(question.value, 'Name three rivers');
    assert.ok(question.readOnly, 'a question from the chat stays as it was asked');
    assert.deepEqual(compare.compareState().values, MODELS.slice(0, 3), 'the answering model first');
    /** @type {HTMLFormElement} */ (panel().querySelector('[data-compare-form]')).requestSubmit();
    await until(() => columns().length === 3);
    await until(settled);
    for (const col of columns()) {
      assert.equal(col.dataset.status, 'done');
      assert.match(col.querySelector('[data-column-body]')?.textContent ?? '', /simulated answer from the local test provider/);
      assert.ok(col.querySelector('.free-note'), 'labelled as a free answer');
      const stats = col.querySelector('[data-column-stats]')?.textContent ?? '';
      assert.match(stats, /\d s/);
      assert.match(stats, /in · \d+ out tokens/);
      assert.match(stats, /No cost: your own server/);
      assert.ok(col.querySelector('[data-action="compare-continue"]'));
      assert.equal(col.hasAttribute('data-stays-on-device'), false, 'an answer of the own server to a question that may travel');
    }
    assert.match(columns()[1].querySelector('[data-column-model]')?.textContent ?? '', /fake-local-reasoner:4b/);
    const sent = fake.requests.filter((r) => /chat\/completions/.test(r.path) && JSON.stringify(r.body).includes('Name three rivers')).slice(-3);
    assert.deepEqual(sent.map((r) => r.body.model).sort(), ['fake-local-reasoner:4b', 'fake-local:70b', 'fake-local:8b']);
    assert.match(String(sent[0].body.messages.at(-1).content), /<<<CONTEXT>>>/, 'the question goes out with its context block, as in the thread');
  });

  it('continues with one column as the newest branch under the question', async () => {
    const before = await storedPath();
    const question = before.at(-2);
    /** @type {HTMLButtonElement} */ (columns()[1].querySelector('[data-action="compare-continue"]')).click();
    await until(() => compare.compareState().columns[1].adopted !== null);
    const path = await storedPath();
    const fresh = path.at(-1);
    assert.equal(path.length, before.length);
    assert.equal(fresh?.parentId, question?.id);
    assert.equal(fresh?.model, 'fake-local-reasoner:4b');
    assert.equal(fresh?.label, 'free');
    assert.deepEqual(fresh?.meta?.compare, { models: 3, column: 2 });
    assert.match(String(fresh?.parts[0].text), /simulated answer/);
    await until(() => rows('assistant').at(-1)?.querySelector('[data-compared]') !== null && rows('assistant').at(-1)?.querySelector('[data-compared]') !== undefined);
    const shown = /** @type {HTMLElement} */ (rows('assistant').at(-1));
    assert.equal(shown.dataset.nodeId, fresh?.id);
    assert.equal(shown.querySelector('.branch-pos')?.textContent, '2/2');
    assert.match(shown.querySelector('[data-compared]')?.textContent ?? '', /Chosen in a comparison of 3 models/);
    assert.ok(shown.querySelector('.free-note'));
    assert.match(columns()[1].textContent ?? '', /In the chat as the newest branch/);
  });

  it('asks a question from the composer, stops one column, and stores the question with the first answer continued', async () => {
    /** @type {HTMLTextAreaElement} */ (document.getElementById('chatInput')).value = '[[fake-fault:slow-first-byte]] Which is longer?';
    /** @type {HTMLButtonElement} */ (document.querySelector('#toolsMenuList [data-arg="compare"]')).click();
    await until(() => /** @type {HTMLTextAreaElement | null} */ (panel().querySelector('[data-compare-question]'))?.value === '[[fake-fault:slow-first-byte]] Which is longer?');
    assert.equal(/** @type {HTMLTextAreaElement} */ (document.getElementById('chatInput')).value, '', 'the text moved from the message box');
    const remove = /** @type {HTMLButtonElement} */ (panel().querySelector('[data-action="compare-remove"][data-arg="2"]'));
    remove.click();
    assert.equal(panel().querySelectorAll('[data-compare-model]').length, 2);
    /** @type {HTMLFormElement} */ (panel().querySelector('[data-compare-form]')).requestSubmit();
    await until(() => columns().length === 2 && columns()[0].querySelector('[data-action="compare-stop"]') !== null);
    /** @type {HTMLButtonElement} */ (columns()[0].querySelector('[data-action="compare-stop"]')).click();
    await until(settled, 10_000);
    assert.equal(columns()[0].dataset.status, 'stopped');
    assert.equal(columns()[0].querySelector('[data-action="compare-continue"]'), null, 'nothing to continue with');
    assert.equal(columns()[1].dataset.status, 'done');
    const before = await storedPath();
    /** @type {HTMLButtonElement} */ (columns()[1].querySelector('[data-action="compare-continue"]')).click();
    await until(() => compare.compareState().columns[1].adopted !== null);
    const path = await storedPath();
    assert.equal(path.length, before.length + 2, 'the question and the answer');
    assert.equal(path.at(-2)?.role, 'user');
    assert.equal(path.at(-2)?.parentId, before.at(-1)?.id);
    assert.match(String(path.at(-2)?.meta?.context), /^<<<CONTEXT>>>/, 'with the context block that went out');
    assert.equal(compare.compareState().questionId, path.at(-2)?.id, 'later columns continue under the stored question');
  });

  it('refuses the same model twice', async () => {
    compare.openCompare({ text: 'Again' });
    const selects = /** @type {HTMLSelectElement[]} */ ([...panel().querySelectorAll('[data-compare-model]')]);
    selects[1].value = selects[0].value;
    selects[1].dispatchEvent(new window.Event('change', { bubbles: true }));
    /** @type {HTMLFormElement} */ (panel().querySelector('[data-compare-form]')).requestSubmit();
    await until(() => !(/** @type {HTMLElement} */ (panel().querySelector('[data-compare-message]')).hidden));
    assert.match(panel().querySelector('[data-compare-message]')?.textContent ?? '', /different model for each column/);
    assert.equal(columns().length, 0);
  });

  it('adds columns up to four', () => {
    compare.openCompare({ text: 'Four' });
    for (let i = 0; i < 3; i += 1) /** @type {HTMLButtonElement | null} */ (panel().querySelector('[data-action="compare-add"]'))?.click();
    assert.equal(panel().querySelectorAll('[data-compare-model]').length, 4);
    assert.equal(panel().querySelector('[data-action="compare-add"]'), null);
    assert.deepEqual([...new Set(compare.compareState().values)].length, 4);
  });

  it('marks the columns of a question that stays on this device as staying (for the canvas)', async () => {
    const store = await chatStore.chatData();
    const id = chatStore.currentSessionId();
    const leaf = (await storedPath()).at(-1);
    const local = await store.appendNode(id, { parentId: leaf?.id ?? null, role: 'user', parts: [{ type: 'text', text: 'About my own notes' }], localOnly: true, meta: { chat_mode: 'free' } });
    compare.openCompare({ conversationId: id, questionId: local.id, text: 'About my own notes' });
    /** @type {HTMLFormElement} */ (panel().querySelector('[data-compare-form]')).requestSubmit();
    await until(() => columns().length >= 2);
    await until(settled, 10_000);
    for (const col of columns()) {
      assert.equal(col.dataset.status, 'done');
      assert.ok(col.hasAttribute('data-stays-on-device'));
    }
  });
});

/** @param {any} provider @param {string} model @param {Array<import('../../src/js/ai/roles.js').ModelRole>} roles */
const entry = (provider, model, roles) => ({ provider, model, roles, pinned: false });
const POOL = [entry('openai', 'gpt-5-mini', ['reasoning', 'fast']), entry('anthropic', 'claude-sonnet-5-5', ['reasoning']), entry('gemini', 'gemini-2.5-flash', ['reasoning']), entry('openai', 'gpt-5', ['judge', 'reasoning'])];

/**
 * Scripted providers for a council: drafts by model (once `gate` settles), the judge's answer.
 * @param {Record<string, import('./router-fakes.mjs').Scripted>} drafts
 * @param {import('./router-fakes.mjs').Scripted} judge
 * @param {Promise<unknown>} [gate]
 */
function councilWorld(drafts, judge, gate) {
  const clock = fakeClock();
  const providers = scriptedProviders(async (call) => {
    if (systemText(call.req).includes(purposeMarker('council_judge'))) return judge;
    await gate;
    return drafts[call.model] ?? { error: 'server' };
  }, clock);
  return { providers, deps: testDeps(providers, clock, { caps: () => null }) };
}

describe('the council: pool and stored copy', () => {
  it('adds the own server to the pool, each model once', () => {
    const pool = council.councilPool([entry('openai', 'a', ['fast'])], [entry('local', 'srv', ['fast']), entry('openai', 'a', ['reasoning'])]);
    assert.deepEqual(pool.map((e) => `${e.provider}:${e.model}`), ['openai:a', 'local:srv']);
    assert.equal(council.sharedTarget([entry('local', 'srv', ['fast'])])?.provider, 'local', 'only the server: its request');
    assert.notEqual(council.sharedTarget(POOL)?.provider, 'local');
    assert.equal(council.sharedTarget([]), null);
  });

  it('keeps a bounded copy and names who wrote the answer', () => {
    /** @type {import('../../src/js/ai/council.js').CouncilResult} */
    const result = {
      mode: 'free',
      purpose: null,
      members: [
        { provider: 'openai', model: 'gpt-5-mini', status: 'ok', text: 'x'.repeat(9000), latencyMs: 10 },
        { provider: 'anthropic', model: 'claude-sonnet-5-5', status: 'error', errors: ['server', 'a', 'b', 'c'] },
      ],
      judge: { provider: 'openai', model: 'gpt-5', status: 'ok', chosen: 0, reasons: Array.from({ length: 9 }, (_, i) => `reason ${i} ${'y'.repeat(400)}`), merged: true },
      output: { text: 'Merged answer.' },
      decidedBy: 'merged',
      bestIndex: 0,
      validCount: 1,
      startedAt: 1000,
      finishedAt: 4000,
    };
    const kept = council.keptCouncil(result);
    assert.equal(kept.members[0].text?.length, council.KEPT_DRAFT_CHARS);
    assert.equal(kept.members[1].text, undefined);
    assert.equal(kept.members[1].errors?.length, 3);
    assert.equal(kept.judge?.reasons.length, 5);
    assert.ok((kept.judge?.reasons[0].length ?? 0) <= 300);
    assert.equal(kept.output, null, 'the answer itself is the message');
    assert.deepEqual(council.authorOf(result), { provider: 'openai', model: 'gpt-5' }, 'a merged answer is the judge\'s');
    assert.deepEqual(council.authorOf({ ...result, decidedBy: 'judge' }), { provider: 'openai', model: 'gpt-5-mini' });
    const question = /** @type {any} */ ({ id: 'q', localOnly: false });
    const answer = council.councilAnswer(result, question);
    assert.equal(answer?.parts[0].text, 'Merged answer.');
    assert.equal(answer?.label, 'free');
    assert.equal(answer?.meta?.duration_ms, 3000);
    assert.equal(/** @type {any} */ (answer?.meta ?? {}).council?.decidedBy, 'merged');
    assert.equal(council.councilAnswer({ ...result, output: null }, question), null);
    assert.equal(council.councilLabelKey('judge'), 'canvas.council.label_judge');
    assert.equal(council.councilLabelKey('best'), 'canvas.council.label_best');
  });
});

describe('the council in the chat', () => {
  it('drafts with three providers, lets the judge choose and stores the labelled answer as a new branch', async () => {
    await ask('What makes bread rise?');
    const before = await storedPath();
    const question = /** @type {import('../../src/js/store/schema.js').NodeRecord} */ (before.at(-2));
    /** @type {() => void} */
    let open = () => {};
    const gate = new Promise((resolve) => (open = () => resolve(undefined)));
    const { deps, providers } = councilWorld({ 'gpt-5-mini': { text: 'Yeast makes gas.' }, 'claude-sonnet-5-5': { text: 'Yeast ferments sugar into carbon dioxide.' }, 'gemini-2.5-flash': { text: 'Gas bubbles.' } }, { text: '{"chosen":1,"reasons":["It names the process."]}' }, gate);
    const run = council.askCouncil({ conversationId: chatStore.currentSessionId(), questionId: question.id, pool: POOL, deps });
    await until(() => document.querySelectorAll('#chatMessages .council-row [data-member]').length === 3);
    assert.ok(document.querySelector('.council-row [data-action="council-stop"]'), 'the council can be stopped while it works');
    assert.match(document.querySelector('.council-row [role="status"]')?.textContent ?? '', /./);
    open();
    const node = await run;
    assert.ok(node);
    assert.equal(node.parentId, question.id);
    assert.equal(node.parts[0].text, 'Yeast ferments sugar into carbon dioxide.');
    assert.equal(node.provider, 'anthropic');
    const kept = /** @type {any} */ (node.meta?.council);
    assert.equal(kept.decidedBy, 'judge');
    assert.deepEqual(kept.judge.reasons, ['It names the process.']);
    assert.deepEqual(kept.members.map((/** @type {any} */ m) => m.provider), ['openai', 'anthropic', 'gemini']);
    // Every draft got the thread's free request: its system prompt and the question with its context block.
    const draft = providers.calls.find((c) => c.model === 'gpt-5-mini');
    assert.match(String(draft?.req.system), /./);
    assert.match(JSON.stringify(draft?.req.messages.at(-1)), /What makes bread rise\?/);
    assert.equal(document.querySelector('#chatMessages .council-row'), null, 'the live row gives way to the stored answer');
    await until(() => rows('assistant').at(-1)?.querySelector('[data-council-label]') !== null && rows('assistant').at(-1)?.querySelector('[data-council-label]') !== undefined);
    const shown = /** @type {HTMLElement} */ (rows('assistant').at(-1));
    assert.equal(shown.dataset.nodeId, node.id);
    assert.match(shown.querySelector('[data-council-label]')?.textContent ?? '', /Council · the judge's choice/);
    assert.equal(shown.querySelectorAll('[data-council-details] [data-member]').length, 3, 'the drafts can be read under the answer');
    assert.ok(shown.querySelector('[data-council-details] [data-judge]'));
    assert.ok(shown.querySelector('.free-note'), 'not checked, like every free answer');
    assert.equal(shown.querySelector('.branch-pos')?.textContent, '2/2');
  });

  it('keeps the best draft when the judge fails, and says so', async () => {
    const path = await storedPath();
    const question = /** @type {import('../../src/js/store/schema.js').NodeRecord} */ (path.at(-2));
    const { deps } = councilWorld({ 'gpt-5-mini': { text: 'Short.' }, 'claude-sonnet-5-5': { text: 'Longer answer.' }, 'gemini-2.5-flash': { error: 'rate_limited' } }, { error: 'server' });
    const node = await council.askCouncil({ conversationId: chatStore.currentSessionId(), questionId: question.id, pool: POOL, deps });
    assert.ok(node);
    const kept = /** @type {any} */ (node.meta?.council);
    assert.equal(kept.decidedBy, 'best');
    assert.equal(kept.fallbackReason, 'judge_error');
    assert.equal(kept.members[2].status, 'error');
    await until(() => (rows('assistant').at(-1)?.querySelector('[data-council-label]')?.textContent ?? '').length > 0);
    assert.match(rows('assistant').at(-1)?.querySelector('[data-council-label]')?.textContent ?? '', /best draft, no judge decided/);
  });

  it('asks a question from the composer and stores it with the result', async () => {
    const before = await storedPath();
    const { deps } = councilWorld({ 'gpt-5-mini': { text: 'One.' }, 'claude-sonnet-5-5': { text: 'Two.' }, 'gemini-2.5-flash': { text: 'Three.' } }, { text: '{"chosen":2,"reasons":["Shortest."]}' });
    const node = await council.askCouncil({ text: 'Count to three', pool: POOL, deps });
    assert.equal(node?.parts[0].text, 'Three.');
    const path = await storedPath();
    assert.equal(path.length, before.length + 2);
    assert.equal(path.at(-2)?.parts[0].text, 'Count to three');
  });

  it('sends no question that stays on this device to a council, and needs two providers', async () => {
    const store = await chatStore.chatData();
    const id = chatStore.currentSessionId();
    const leaf = (await storedPath()).at(-1);
    const local = await store.appendNode(id, { parentId: leaf?.id ?? null, role: 'user', parts: [{ type: 'text', text: 'About my private file' }], localOnly: true, meta: { chat_mode: 'grounded' } });
    const { deps, providers } = councilWorld({}, { text: '{}' });
    assert.equal(await council.askCouncil({ conversationId: id, questionId: local.id, pool: POOL, deps }), null);
    assert.equal(providers.calls.length, 0);
    const notices = [...document.querySelectorAll('#chatMessages [role="status"]')].map((n) => n.textContent ?? '');
    assert.ok(notices.some((n) => /This question stays on this device/.test(n)), notices.join(' | '));
    assert.equal(await council.askCouncil({ conversationId: id, text: 'Hello', pool: [entry('openai', 'gpt-5-mini', ['fast'])], deps }), null);
    assert.ok([...document.querySelectorAll('#chatMessages [role="status"]')].some((n) => /at least two providers/.test(n.textContent ?? '')));
  });
});
