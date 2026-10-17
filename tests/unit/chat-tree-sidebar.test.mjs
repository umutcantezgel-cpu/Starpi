// The conversation list in a DOM (chat/sidebar.js): groups Pinned / Today / Previous 7 days / Older,
// the current chat marked, opening a chat, the actions menu by mouse, keyboard, long press and right
// click (rename, pin, move to project, export, delete), search, import, changes made elsewhere, and
// both languages.
/* global document, KeyboardEvent, MouseEvent */
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location'];
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();

/** @type {typeof import('../../src/js/chat/sidebar.js')} */
let sidebar;
/** @type {typeof import('../../src/js/chat/store.js')} */
let chatStoreModule;
/** @type {typeof import('../../src/js/store/schema.js')} */
let schema;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;
/** @type {typeof import('../../src/js/i18n/index.js')} */
let i18n;

before(async () => {
  const jsdom = new JSDOM('<!doctype html><html><body><div id="toastRegion"></div><section id="chat-sidebar"></section><textarea id="chatInput"></textarea></body></html>', { url: 'https://app.example/' });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  i18n = await import('../../src/js/i18n/index.js');
  sidebar = await import('../../src/js/chat/sidebar.js');
  chatStoreModule = await import('../../src/js/chat/store.js');
  schema = await import('../../src/js/store/schema.js');
});

after(() => {
  for (const key of GLOBALS) delete (/** @type {any} */ (globalThis))[key];
});

/**
 * @param {() => unknown} check
 * @param {string} what
 */
async function until(check, what) {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

let seq = 0;

/** A list mounted on a fresh in-memory store, with every dependency recorded. */
async function setup() {
  const name = `sidebar-test-${(seq += 1)}`;
  const store = chatStoreModule.createChatStore({ open: () => schema.openAppDb({ name, factory: null }), now: () => NOW });
  const root = /** @type {HTMLElement} */ (document.getElementById('chat-sidebar'));
  root.innerHTML = '';
  /** @type {Set<(id: string) => void>} */
  const sessionListeners = new Set();
  const calls = { opened: /** @type {string[]} */ ([]), removed: /** @type {string[]} */ ([]), tabs: /** @type {string[]} */ ([]), toasts: /** @type {any[]} */ ([]), downloads: /** @type {Array<{ name: string, text: string, type: string }>} */ ([]), alerts: /** @type {string[]} */ ([]), cleared: 0 };
  const env = { current: 'starpi_none', busy: false, confirm: true, narrow: false };
  const list = sidebar.mountConversationList(
    root,
    {
      onAction: dom.onAction,
      onChange: dom.onChange,
      switchTab: (tab) => void calls.tabs.push(tab),
      toast: (message, opts) => (calls.toasts.push({ message, tone: opts?.tone }), () => {}),
    },
    {
      store: async () => store,
      currentId: () => env.current,
      onSessionChange: (fn) => {
        sessionListeners.add(fn);
        return () => sessionListeners.delete(fn);
      },
      open: async (id) => {
        calls.opened.push(id);
        env.current = id;
        for (const fn of sessionListeners) fn(id);
      },
      remove: async (id) => {
        calls.removed.push(id);
        await store.deleteConversation(id);
        return true;
      },
      isBusy: () => env.busy,
      afterRemoveCurrent: () => void (calls.cleared += 1),
      version: '3.0.0-test',
      download: (n, text, type) => void calls.downloads.push({ name: n, text, type }),
      confirm: () => env.confirm,
      alert: (m) => void calls.alerts.push(m),
      now: () => NOW,
      isNarrow: () => env.narrow,
    },
  );
  /** @param {string} title @param {number} updatedAt @param {{ pinned?: boolean, question?: string }} [opts] */
  const add = async (title, updatedAt, opts = {}) => {
    const c = await store.createConversation({ title, createdAt: updatedAt, updatedAt, pinned: opts.pinned });
    if (opts.question) await store.appendNode(c.id, { parentId: null, role: 'user', parts: [{ type: 'text', text: opts.question }], createdAt: updatedAt });
    return c;
  };
  return { store, root, list, calls, env, add };
}

/** @param {HTMLElement} root */
const headings = (root) => [...root.querySelectorAll('h2')].map((h) => h.textContent);
/** @param {HTMLElement} root */
const titles = (root) => [...root.querySelectorAll('[data-action="conv-open"]')].map((b) => b.textContent?.trim());
/** @param {HTMLElement} root @param {string} title */
const rowOf = (root, title) => /** @type {HTMLElement} */ ([...root.querySelectorAll('[data-conv-id]')].find((li) => li.textContent?.includes(title)));
/** @param {Element | null | undefined} el */
const click = (el) => /** @type {HTMLElement} */ (el).click();
/** @param {Element | null} el @param {string} key */
const press = (el, key) => /** @type {HTMLElement} */ (el).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
/** @param {HTMLElement} root */
const menuLabels = (root) => [...root.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((b) => b.textContent?.trim());

beforeEach(async () => {
  await i18n.setLocale('en');
});

describe('conversation list', () => {
  it('says when there are no chats yet, and offers New chat, import and search', async () => {
    const { root, list } = await setup();
    await list.refresh();
    assert.match(root.textContent ?? '', /No chats yet/);
    assert.equal(root.querySelector('[data-action="new-chat"]')?.textContent?.trim(), 'New chat');
    assert.equal(root.querySelector('[data-action="conv-import"]')?.getAttribute('aria-label'), 'Import a chat');
    const search = root.querySelector('#chatListSearch');
    assert.equal(root.querySelector(`label[for="chatListSearch"]`)?.textContent, 'Search chats');
    assert.equal(search?.getAttribute('type'), 'search');
    list.destroy();
  });

  it('groups chats by last use with pinned ones on top and marks the current chat', async () => {
    const { root, list, add, env } = await setup();
    await add('Older chat', NOW - 30 * DAY);
    const week = await add('Last week', NOW - 3 * DAY);
    await add('This morning', NOW - 5 * 3600_000);
    await add('Pinned old', NOW - 90 * DAY, { pinned: true });
    env.current = week.id;
    await list.refresh();
    assert.deepEqual(headings(root), ['Pinned', 'Today', 'Previous 7 days', 'Older']);
    assert.deepEqual(titles(root), ['Pinned: Pinned old', 'This morning', 'Last week', 'Older chat']);
    assert.equal(root.querySelectorAll('[aria-current="true"]').length, 1);
    assert.equal(root.querySelector('[aria-current="true"]')?.textContent?.trim(), 'Last week');
    // Every group is a labelled section with a list.
    for (const section of root.querySelectorAll('section')) assert.ok(document.getElementById(section.getAttribute('aria-labelledby') ?? ''));
    list.destroy();
  });

  it('opens a chat, marks it and shows the chat tab; on phones the composer takes focus', async () => {
    const { root, list, add, calls, env } = await setup();
    const a = await add('First', NOW - 1000);
    const b = await add('Second', NOW - 2000);
    env.current = a.id;
    await list.refresh();
    click(rowOf(root, 'Second').querySelector('[data-action="conv-open"]'));
    await until(() => calls.opened.length === 1, 'the chat to open');
    await until(() => root.querySelector('[aria-current="true"]')?.textContent?.includes('Second'), 'the mark to move');
    assert.deepEqual(calls.opened, [b.id]);
    assert.deepEqual(calls.tabs, ['chat']);
    assert.equal(document.activeElement, rowOf(root, 'Second').querySelector('[data-action="conv-open"]'));

    // The current chat is not opened again; on phones the composer gets the focus.
    env.narrow = true;
    click(rowOf(root, 'Second').querySelector('[data-action="conv-open"]'));
    await until(() => calls.tabs.length === 2, 'the chat tab');
    assert.deepEqual(calls.opened, [b.id]);
    assert.equal(document.activeElement?.id, 'chatInput');

    // New chat from the list shows the chat as well.
    dom.onAction('new-chat', () => {});
    click(root.querySelector('[data-action="new-chat"]'));
    assert.equal(calls.tabs.length, 3);
    list.destroy();
  });

  it('opens the actions menu by keyboard and closes it with Escape, back on its button', async () => {
    const { root, list, add } = await setup();
    await add('Menu chat', NOW - 1000);
    await list.refresh();
    const trigger = /** @type {HTMLElement} */ (root.querySelector('[data-action="conv-menu"]'));
    assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
    assert.equal(trigger.getAttribute('aria-label'), 'More actions for Menu chat');
    trigger.focus();
    press(trigger, 'ArrowDown');
    await until(() => root.querySelector('[role="menu"]'), 'the menu');
    assert.deepEqual(menuLabels(root), ['Rename', 'Pin', 'Export as Markdown', 'Export as JSON', 'Delete']);
    const menuTrigger = /** @type {HTMLElement} */ (root.querySelector('[data-action="conv-menu"]'));
    assert.equal(menuTrigger.getAttribute('aria-expanded'), 'true');
    assert.equal(menuTrigger.getAttribute('aria-controls'), 'chatListMenu');
    assert.equal(root.querySelector('[role="menu"]')?.getAttribute('aria-label'), 'Actions for Menu chat');
    await until(() => document.activeElement?.textContent?.trim() === 'Rename', 'focus on the first item');
    press(document.activeElement, 'ArrowDown');
    assert.equal(document.activeElement?.textContent?.trim(), 'Pin');
    press(document.activeElement, 'End');
    assert.equal(document.activeElement?.textContent?.trim(), 'Delete');
    press(document.activeElement, 'ArrowDown');
    assert.equal(document.activeElement?.textContent?.trim(), 'Rename', 'the focus wraps around');
    press(document.activeElement, 'ArrowUp');
    assert.equal(document.activeElement?.textContent?.trim(), 'Delete');
    press(document.activeElement, 'Escape');
    assert.equal(root.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement?.getAttribute('data-action'), 'conv-menu');
    assert.equal(document.activeElement?.getAttribute('aria-expanded'), 'false');

    // A click elsewhere closes it too; a right click opens it.
    click(root.querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[role="menu"]'), 'the menu by click');
    document.body.click();
    assert.equal(root.querySelector('[role="menu"]'), null);
    rowOf(root, 'Menu chat').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await until(() => root.querySelector('[role="menu"]'), 'the menu by right click');
    list.destroy();
  });

  it('opens the menu on a long press without opening the chat', async () => {
    const { root, list, add, calls } = await setup();
    await add('Touch chat', NOW - 1000);
    await list.refresh();
    const button = /** @type {HTMLElement} */ (rowOf(root, 'Touch chat').querySelector('[data-action="conv-open"]'));
    const pointer = (/** @type {string} */ type) => Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }), { pointerType: 'touch' });
    button.dispatchEvent(pointer('pointerdown'));
    await until(() => root.querySelector('[role="menu"]'), 'the menu after a long press');
    button.dispatchEvent(pointer('pointerup'));
    click(rowOf(root, 'Touch chat').querySelector('[data-action="conv-open"]'));
    assert.deepEqual(calls.opened, [], 'the click that ends a long press is swallowed');
    list.destroy();
  });

  it('renames with Enter, cancels with Escape, and pins', async () => {
    const { root, list, add, store } = await setup();
    const c = await add('Draft title', NOW - 1000);
    await add('Other', NOW - 500);
    await list.refresh();
    click(rowOf(root, 'Draft title').querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[data-action="conv-rename"]'), 'the menu');
    click(root.querySelector('[data-action="conv-rename"]'));
    const input = /** @type {HTMLInputElement} */ (root.querySelector('[data-rename]'));
    assert.equal(document.activeElement, input);
    assert.equal(input.getAttribute('aria-label'), 'New title for Draft title');
    input.value = 'Final title';
    press(input, 'Enter');
    await until(() => titles(root).includes('Final title'), 'the new title');
    assert.equal((await store.getConversation(c.id))?.title, 'Final title');

    click(rowOf(root, 'Final title').querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[data-action="conv-rename"]'), 'the menu');
    click(root.querySelector('[data-action="conv-rename"]'));
    const again = /** @type {HTMLInputElement} */ (root.querySelector('[data-rename]'));
    again.value = 'Not this';
    press(again, 'Escape');
    assert.ok(titles(root).includes('Final title'));
    assert.equal(document.activeElement?.getAttribute('data-action'), 'conv-open');

    click(rowOf(root, 'Final title').querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[data-action="conv-pin"]'), 'the menu');
    click(root.querySelector('[data-action="conv-pin"]'));
    await until(() => headings(root)[0] === 'Pinned', 'the pinned group');
    assert.deepEqual(titles(root), ['Pinned: Final title', 'Other']);
    click(rowOf(root, 'Final title').querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[data-action="conv-pin"]'), 'the menu');
    assert.equal(root.querySelector('[data-action="conv-pin"]')?.textContent?.trim(), 'Unpin');
    list.destroy();
  });

  it('moves a chat into a project once projects exist', async () => {
    const { root, list, add, store, calls } = await setup();
    const c = await add('Project chat', NOW - 1000);
    const db = await schema.openAppDb({ name: `sidebar-test-${seq}`, factory: null });
    await db.put('projects', { id: 'p1', name: 'Garden', instructions: '', defaultModel: null, docIds: [], memoryScope: 'off', createdAt: 1, updatedAt: 1 });
    await list.refresh();
    click(root.querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[data-action="conv-move"]'), 'the project item');
    click(root.querySelector('[data-action="conv-move"]'));
    assert.deepEqual(menuLabels(root), ['Back', 'No project', 'Garden']);
    assert.equal(root.querySelector('[data-action="conv-move-to"][data-arg=""]')?.getAttribute('aria-checked'), 'true');
    click(root.querySelector('[data-action="conv-move-to"][data-arg="p1"]'));
    await until(() => calls.toasts.length === 1, 'the toast');
    assert.equal((await store.getConversation(c.id))?.projectId, 'p1');
    assert.deepEqual(calls.toasts[0], { message: { key: 'chat.list.moved', params: { project: 'Garden' } }, tone: 'ok' });
    list.destroy();
  });

  it('deletes after confirmation, refuses while the current chat is answering, and moves the focus on', async () => {
    const { root, list, add, store, calls, env } = await setup();
    const keep = await add('Keep me', NOW - 2000);
    const gone = await add('Delete me', NOW - 1000);
    env.current = gone.id;
    await list.refresh();

    env.busy = true;
    click(rowOf(root, 'Delete me').querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[data-action="conv-delete"]'), 'the menu');
    click(root.querySelector('[data-action="conv-delete"]'));
    await until(() => calls.alerts.length === 1, 'the busy notice');
    assert.match(calls.alerts[0], /still being written/);
    assert.deepEqual(calls.removed, []);

    env.busy = false;
    env.confirm = false;
    click(rowOf(root, 'Delete me').querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[data-action="conv-delete"]'), 'the menu');
    click(root.querySelector('[data-action="conv-delete"]'));
    assert.deepEqual(calls.removed, []);

    env.confirm = true;
    click(rowOf(root, 'Delete me').querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[data-action="conv-delete"]'), 'the menu');
    click(root.querySelector('[data-action="conv-delete"]'));
    await until(() => calls.toasts.length === 1, 'the toast');
    assert.deepEqual(calls.removed, [gone.id]);
    assert.equal(calls.cleared, 1, 'the chat on screen is cleared when its conversation is deleted');
    assert.deepEqual(titles(root), ['Keep me']);
    assert.equal(document.activeElement?.getAttribute('data-focus'), `open:${keep.id}`);
    assert.deepEqual(calls.toasts[0], { message: 'chat.list.deleted', tone: 'ok' });
    assert.equal(await store.getConversation(gone.id), undefined);
    list.destroy();
  });

  it('searches titles and first questions, announces the result and clears with Escape', async () => {
    const { root, list, add } = await setup();
    await add('Moon facts', NOW - 1000, { question: 'Why does the moon change shape?' });
    await add('Weekend', NOW - 2000, { question: 'How do tides work?' });
    await list.refresh();
    const search = /** @type {HTMLInputElement} */ (root.querySelector('#chatListSearch'));
    search.value = 'tides';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => headings(root)[0] === 'Search results', 'the results');
    assert.deepEqual(titles(root), ['Weekend']);
    assert.equal(root.querySelector('#chatListStatus')?.textContent, '1 chat found');

    search.value = 'zebra';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => /No chat matches/.test(root.textContent ?? ''), 'no results');
    assert.equal(root.querySelector('#chatListStatus')?.textContent, 'No chat matches your search.');

    press(search, 'Escape');
    await until(() => headings(root)[0] === 'Today', 'the full list');
    assert.equal(search.value, '');
    list.destroy();
  });

  it('exports a chat as Markdown and JSON', async () => {
    const { root, list, store, calls } = await setup();
    const q = await store.appendToActive('starpi_export-me', { role: 'user', parts: [{ type: 'text', text: 'Hello?' }] }, { create: { mode: 'free' } });
    await store.appendNode(q.conversationId, { parentId: q.id, role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }], meta: { engine: 'cloud' }, label: 'free' });
    await list.refresh();
    for (const format of ['md', 'json']) {
      click(root.querySelector('[data-action="conv-menu"]'));
      await until(() => root.querySelector(`[data-action="conv-export"][data-arg="${format}"]`), 'the menu');
      click(root.querySelector(`[data-action="conv-export"][data-arg="${format}"]`));
      await until(() => calls.downloads.length === (format === 'md' ? 1 : 2), `the ${format} download`);
    }
    const [md, json] = calls.downloads;
    assert.equal(md.name, 'starpi-chat-2026-10-17-export-m.md');
    assert.match(md.text, /^# Starpi chat\n\n_Exported on .+ · 2 messages_\n\n## You\n\nHello\?\n\n## Starpi · Cloud assistant\n\nHi!\n$/);
    assert.equal(json.type, 'application/json');
    const doc = JSON.parse(json.text);
    assert.equal(doc.schema, 'starpi.chat/v2');
    assert.equal(doc.generator.version, '3.0.0-test');
    assert.equal(doc.nodes.length, 2);
    list.destroy();
  });

  it('imports a v1 file, opens it, and reports files it cannot read', async () => {
    const { root, list, calls } = await setup();
    await list.refresh();
    const input = /** @type {HTMLInputElement} */ (root.querySelector('[data-conv-import]'));
    /** @param {string} text */
    const choose = (text) => {
      Object.defineProperty(input, 'files', { value: [new File([text], 'chat.json', { type: 'application/json' })], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    choose(JSON.stringify({ schema: 'starpi.chat/v1', messages: [{ role: 'user', content: 'Imported question', createdAt: null, engine: null, model: null, chatMode: 'free' }] }));
    await until(() => calls.opened.length === 1, 'the imported chat to open');
    await until(() => titles(root).includes('Imported question'), 'the imported chat in the list');
    assert.deepEqual(calls.toasts[0], { message: { key: 'chat.list.import_done', params: { title: 'Imported question' } }, tone: 'ok' });
    assert.equal(root.querySelector('[aria-current="true"]')?.textContent?.trim(), 'Imported question');

    choose('{"schema":"something/else"}');
    await until(() => calls.toasts.length === 2, 'the refusal');
    assert.deepEqual(calls.toasts[1], { message: 'chat.list.import_error_schema', tone: 'warn' });
    list.destroy();
  });

  it('follows changes made elsewhere and switches language in place', async () => {
    const { root, list, store } = await setup();
    await list.refresh();
    await store.appendToActive('starpi_elsewhere', { role: 'user', parts: [{ type: 'text', text: 'Asked in the chat' }] }, { create: {} });
    await until(() => titles(root).includes('Asked in the chat'), 'the new chat');
    await i18n.setLocale('de');
    assert.deepEqual(headings(root), ['Heute']);
    assert.equal(root.querySelector('[data-action="new-chat"]')?.textContent?.trim(), 'Neuer Chat');
    assert.equal(root.querySelector('#chatListSearch')?.getAttribute('placeholder'), 'Chats durchsuchen');
    assert.equal(root.querySelector('[data-action="conv-menu"]')?.getAttribute('aria-label'), 'Weitere Aktionen für Asked in the chat');
    click(root.querySelector('[data-action="conv-menu"]'));
    await until(() => root.querySelector('[role="menu"]'), 'the menu');
    assert.deepEqual(menuLabels(root), ['Umbenennen', 'Anheften', 'Als Markdown exportieren', 'Als JSON exportieren', 'Löschen']);
    list.destroy();
  });
});

describe('groupConversations', () => {
  it('puts the start of today and of the last seven days at local midnight', () => {
    const midnight = new Date(2026, 9, 17).getTime();
    /** @param {string} id @param {number} updatedAt @returns {any} */
    const c = (id, updatedAt) => ({ id, updatedAt, pinned: 0 });
    const groups = sidebar.groupConversations([c('a', midnight), c('b', midnight - 1), c('c', midnight - 7 * DAY), c('d', midnight - 7 * DAY - 1)], NOW);
    assert.deepEqual(
      groups.map((g) => [g.id, g.items.map((i) => i.id)]),
      [
        ['today', ['a']],
        ['week', ['b', 'c']],
        ['older', ['d']],
      ],
    );
  });
});
