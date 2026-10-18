// The composer, the mode row and the action bar in a DOM (jsdom): Enter sends and Shift+Enter does
// not, files become chips (at most LIMITS.attachmentsPerMessage per message), Send waits while the
// chosen model cannot take the draft and says why, the voice slots and the tools menu take what other
// features register; Auto/Free/Grounded and the route rule; the bar's buttons per message.
/* global document, KeyboardEvent, window */
import './setup.mjs';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS'];

const MARKUP = `<!doctype html><html><body>
  <select id="engineSelector"><option value="auto">Auto</option><option value="webgpu:qwen-3b">Qwen</option><option value="anthropic:claude-opus-5-5">Opus</option></select>
  <div id="chatMessages"><div class="message-row" data-role="assistant"><div class="message-content">Answer</div><div class="message-actions"></div></div></div>
  <form id="chatForm">
    <div class="mode-toggle"><button type="button" data-action="set-chat-mode" data-arg="auto"></button><button type="button" data-action="set-chat-mode" data-arg="free"></button><button type="button" data-action="set-chat-mode" data-arg="grounded"></button></div>
    <span id="chatModeHint"></span><button type="button" id="webToggle" data-action="toggle-web"></button>
    <div id="toolsMenuList"></div><div id="attachedInfo" class="hidden"></div><p id="composerNotice" class="hidden"></p>
    <input type="file" id="chatFileInput" data-change="attach-file"><span id="composerMicSlot"><button type="button" id="voiceBtn">mic</button></span><span id="composerVoiceSlot"></span>
    <textarea id="chatInput"></textarea><button type="button" id="stopBtn" class="hidden" data-action="stop-generation"></button><button type="submit" id="sendBtn"></button>
  </form>
</body></html>`;

/** @type {typeof import('../../src/js/chat/composer.js')} */
let composer;
/** @type {typeof import('../../src/js/chat/hooks.js')} */
let hooks;
/** @type {typeof import('../../src/js/chat/mode-control.js')} */
let mode;
/** @type {typeof import('../../src/js/chat/actions.js')} */
let actions;
/** @type {typeof import('../../src/js/state.js')} */
let state;
let submits = 0;
let stops = 0;
/** @type {{ ok: true } | { ok: false, key: string, params?: Record<string, string> }} */
let verdict = { ok: true };
/** @type {Array<[string, unknown]>} */
const calls = [];

const wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byId = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

before(async () => {
  const jsdom = new JSDOM(MARKUP, { url: 'https://app.example/', pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  hooks = await import('../../src/js/chat/hooks.js');
  composer = await import('../../src/js/chat/composer.js');
  mode = await import('../../src/js/chat/mode-control.js');
  actions = await import('../../src/js/chat/actions.js');
  state = await import('../../src/js/state.js');
  composer.initComposer({
    submit: () => {
      submits += 1;
    },
    stop: () => {
      stops += 1;
    },
    checkSendable: async () => verdict,
  });
  mode.initModeControl();
  actions.initActions({
    regenerate: (id, value) => calls.push(['regenerate', [id, value]]),
    edit: (id, text) => calls.push(['edit', [id, text]]),
    branch: (id, delta) => calls.push(['branch', [id, delta]]),
    continueAnswer: (id) => calls.push(['continue', id]),
    node: (id) => /** @type {any} */ ({ id, role: 'user', parts: [{ type: 'text', text: 'The question' }] }),
    conversationId: () => 'starpi_test',
  });
});

describe('composer', () => {
  it('sends on Enter, breaks the line on Shift+Enter and stops on Stop', () => {
    const input = /** @type {HTMLTextAreaElement} */ (byId('chatInput'));
    input.value = 'Hello';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(submits, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(submits, 1);
    composer.setComposerBusy(true);
    assert.equal(byId('stopBtn').classList.contains('hidden'), false);
    assert.equal(/** @type {HTMLButtonElement} */ (byId('sendBtn')).disabled, true);
    byId('stopBtn').click();
    assert.equal(stops, 1);
    composer.setComposerBusy(false);
    assert.equal(byId('stopBtn').classList.contains('hidden'), true);
  });

  it('turns files into chips, reads text files, refuses unknown types and holds at most ten per message', async () => {
    const File = /** @type {any} */ (globalThis).File;
    composer.addFiles([new File(['# Notes\nText'], 'notes.ts', { type: 'text/plain' })]);
    assert.match(byId('attachedInfo').textContent ?? '', /Reading notes\.ts/);
    const draft = await composer.takeDraft();
    assert.equal(draft.attachments.length, 1);
    assert.equal(draft.attachments[0].kind, 'text');
    assert.equal(draft.attachments[0].text, '# Notes\nText');
    assert.match(byId('attachedInfo').textContent ?? '', /notes\.ts/);

    composer.addFiles([new File(['x'], 'tool.exe', { type: 'application/octet-stream' })]);
    await wait(20);
    assert.match(byId('composerNotice').textContent ?? '', /tool\.exe cannot be attached/);
    assert.equal((await composer.takeDraft()).attachments.length, 1);

    composer.addFiles(Array.from({ length: 12 }, (_, i) => new File([`f${i}`], `f${i}.py`, { type: 'text/x-python' })));
    assert.match(byId('composerNotice').textContent ?? '', /At most 10 files/);
    assert.equal((await composer.takeDraft()).attachments.length, 10);
    // Removing a chip drops it from the draft.
    const remove = /** @type {HTMLElement} */ (byId('attachedInfo').querySelector('[data-action="remove-attachment"]'));
    remove.click();
    assert.equal((await composer.takeDraft()).attachments.length, 9);
    composer.clearComposer();
    assert.equal((await composer.takeDraft()).attachments.length, 0);
    assert.equal(byId('attachedInfo').classList.contains('hidden'), true);
  });

  it('holds Send while the chosen model cannot take the draft, and says why', async () => {
    const File = /** @type {any} */ (globalThis).File;
    verdict = { ok: false, key: 'chat-thread.composer.no_vision', params: { model: 'Some model' } };
    composer.addFiles([new File(['a,b'], 'table.csv', { type: 'text/csv' })]);
    await composer.takeDraft();
    await wait(10);
    assert.equal(/** @type {HTMLButtonElement} */ (byId('sendBtn')).disabled, true);
    assert.match(byId('composerNotice').textContent ?? '', /Some model cannot see images/);
    verdict = { ok: true };
    await composer.refreshSendable();
    assert.equal(/** @type {HTMLButtonElement} */ (byId('sendBtn')).disabled, false);
    composer.clearComposer();
  });

  it('fills the voice slots and the tools menu with what other features register', () => {
    assert.equal(byId('composerMicSlot').querySelector('#voiceBtn')?.textContent, 'mic');
    let cleaned = 0;
    const off = hooks.registerComposerSlot('mic', (slot) => {
      const b = document.createElement('button');
      b.textContent = 'dictate';
      slot.append(b);
      return () => {
        cleaned += 1;
      };
    });
    assert.equal(byId('composerMicSlot').textContent, 'dictate');
    off();
    assert.equal(cleaned, 1);
    assert.equal(byId('composerMicSlot').querySelector('#voiceBtn')?.textContent, 'mic');

    assert.match(byId('toolsMenuList').textContent ?? '', /No tools are set up yet/);
    let ran = 0;
    const offTool = hooks.registerComposerTool({ id: 'calc', labelKey: 'chat-thread.tools.label', icon: 'zap', run: () => (ran += 1) });
    /** @type {HTMLElement} */ (byId('toolsMenuList').querySelector('[data-action="run-composer-tool"]')).click();
    assert.equal(ran, 1);
    offTool();
    assert.match(byId('toolsMenuList').textContent ?? '', /No tools are set up yet/);
  });
});

describe('mode row', () => {
  it('marks the chosen mode and says what it does', () => {
    state.setChatMode('free');
    assert.equal(document.querySelector('[data-arg="free"]')?.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('[data-arg="auto"]')?.getAttribute('aria-pressed'), 'false');
    assert.equal(byId('chatInput').getAttribute('placeholder'), 'Message Starpi…');
    /** @type {HTMLElement} */ (document.querySelector('[data-arg="auto"]')).click();
    assert.equal(state.getChatMode(), 'auto');
    assert.match(byId('chatModeHint').textContent ?? '', /Answers from your files/);
    byId('webToggle').click();
    assert.equal(state.getWebSearch(), true);
    assert.equal(byId('webToggle').getAttribute('aria-pressed'), 'true');
    byId('webToggle').click();
  });

  it('routes Auto to the sources for documents and files in the workspace, otherwise to the free chat', async () => {
    const image = { name: 'a.png', kind: 'image' };
    const doc = { name: 'a.pdf', kind: 'pdf' };
    assert.equal(mode.builtInRoute({ mode: 'auto', attachments: [], workspaceDocs: 0 }), 'free');
    assert.equal(mode.builtInRoute({ mode: 'auto', attachments: [], workspaceDocs: 2 }), 'grounded');
    assert.equal(mode.builtInRoute({ mode: 'auto', attachments: [image], workspaceDocs: 2 }), 'free');
    assert.equal(mode.builtInRoute({ mode: 'auto', attachments: [image, doc], workspaceDocs: 0 }), 'grounded');
    assert.equal(mode.builtInRoute({ mode: 'free', attachments: [doc], workspaceDocs: 3 }), 'free');
    assert.equal(mode.builtInRoute({ mode: 'grounded', attachments: [], workspaceDocs: 0 }), 'grounded');
    // A registered decider decides Auto, never an explicit mode; null keeps the built-in rule.
    const off = hooks.setRouteDecider((input) => (input.question.includes('web') ? { route: 'grounded' } : null));
    assert.equal(await mode.decideRoute({ question: 'search the web', mode: 'auto', attachments: [], workspaceDocs: 0 }), 'grounded');
    assert.equal(await mode.decideRoute({ question: 'hello', mode: 'auto', attachments: [], workspaceDocs: 0 }), 'free');
    assert.equal(await mode.decideRoute({ question: 'search the web', mode: 'free', attachments: [], workspaceDocs: 0 }), 'free');
    off();
  });
});

describe('action bar', () => {
  const row = () => /** @type {HTMLElement} */ (document.querySelector('#chatMessages .message-row'));

  it('offers copy, Markdown, regenerate, branches and Continue on answers, and registered actions', () => {
    const off = hooks.registerMessageAction({ id: 'research', labelKey: 'chat-thread.action.copy', icon: 'search', run: (node) => calls.push(['research', node.id]) });
    actions.renderActions(row(), { node: /** @type {any} */ ({ id: 'n1', role: 'assistant', parts: [] }), branch: { position: 2, count: 3 }, canContinue: true, busy: false });
    const names = [...row().querySelectorAll('.message-actions [data-action]')].map((b) => b.getAttribute('data-action'));
    assert.deepEqual(names, ['msg-copy', 'msg-copy-md', 'msg-branch-prev', 'msg-branch-next', 'msg-continue', 'msg-extra']);
    assert.ok(row().querySelector('.regen-menu'));
    assert.equal(row().querySelector('.branch-pos')?.textContent, '2/3');
    for (const b of row().querySelectorAll('.message-actions button')) assert.ok(b.getAttribute('aria-label'), 'every button has a name');
    /** @type {HTMLElement} */ (row().querySelector('[data-action="msg-branch-next"]')).click();
    /** @type {HTMLElement} */ (row().querySelector('[data-action="msg-continue"]')).click();
    /** @type {HTMLElement} */ (row().querySelector('[data-action="msg-extra"]')).click();
    assert.deepEqual(calls.splice(0), [['branch', ['n1', 1]], ['continue', 'n1'], ['research', 'n1']]);
    off();
  });

  it('builds the regenerate menu from the picker without on-device presets, and sends the picked model', () => {
    const menu = /** @type {HTMLDetailsElement} */ (row().querySelector('.regen-menu'));
    menu.open = true;
    menu.dispatchEvent(new window.Event('toggle'));
    const entries = [...menu.querySelectorAll('[data-action="msg-regenerate"]')].map((b) => b.getAttribute('data-value'));
    assert.deepEqual(entries, ['', 'auto', 'anthropic:claude-opus-5-5']);
    /** @type {HTMLElement} */ (menu.querySelector('[data-value="anthropic:claude-opus-5-5"]')).click();
    assert.deepEqual(calls.splice(0), [['regenerate', ['n1', 'anthropic:claude-opus-5-5']]]);
  });

  it('edits a question in place and sends the edited text', () => {
    row().dataset.role = 'user';
    actions.renderActions(row(), { node: /** @type {any} */ ({ id: 'q1', role: 'user', parts: [{ type: 'text', text: 'The question' }] }), branch: null, canContinue: false, busy: false });
    assert.deepEqual([...row().querySelectorAll('.message-actions [data-action]')].map((b) => b.getAttribute('data-action')), ['msg-copy', 'msg-edit']);
    /** @type {HTMLElement} */ (row().querySelector('[data-action="msg-edit"]')).click();
    const area = /** @type {HTMLTextAreaElement} */ (row().querySelector('.message-editor textarea'));
    assert.equal(area.value, 'The question');
    area.value = 'A better question';
    /** @type {HTMLFormElement} */ (row().querySelector('.message-editor')).requestSubmit();
    assert.deepEqual(calls.splice(0), [['edit', ['q1', 'A better question']]]);
    assert.equal(row().querySelector('.message-editor'), null);
    // While an answer is written, the question cannot be edited.
    actions.renderActions(row(), { node: /** @type {any} */ ({ id: 'q1', role: 'user', parts: [] }), branch: null, canContinue: false, busy: true });
    assert.equal(/** @type {HTMLButtonElement} */ (row().querySelector('[data-action="msg-edit"]')).disabled, true);
  });
});
