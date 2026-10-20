// Settings -> Memory and personalization in a DOM (settings/memory-view.js): memory off by default,
// the suggestion switch only with memory on, custom instructions, adding, editing, deleting and
// exporting notes with their scope, a redraw after a change that keeps what is being typed and
// clicked, the vault line, and the notes hidden while the vault is locked.
/* global document */
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLFormElement', 'HTMLButtonElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location'];
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

/** @type {typeof import('../../src/js/settings/memory-view.js')} */
let view;
/** @type {typeof import('../../src/js/ai/memory.js')} */
let memory;
/** @type {typeof import('../../src/js/store/schema.js')} */
let schema;
/** @type {typeof import('../../src/js/i18n/index.js')} */
let i18n;

before(async () => {
  const jsdom = new JSDOM('<!doctype html><html><body><div id="memorySettings"></div></body></html>', { url: 'https://app.example/' });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  i18n = await import('../../src/js/i18n/index.js');
  memory = await import('../../src/js/ai/memory.js');
  schema = await import('../../src/js/store/schema.js');
  view = await import('../../src/js/settings/memory-view.js');
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

/** @param {{ vault?: 'none' | 'locked' | 'unlocked' | 'unavailable', wrap?: (store: any) => any }} [opts] */
async function setup(opts = {}) {
  const db = await schema.openAppDb({ name: `memory-view-${(seq += 1)}`, factory: new IDBFactory() });
  let ids = 0;
  const created = memory.createMemoryStore({ open: async () => db, now: () => NOW, uuid: () => `n${(ids += 1)}` });
  const store = opts.wrap ? opts.wrap(created) : created;
  const el = /** @type {HTMLElement} */ (document.getElementById('memorySettings'));
  el.replaceWith(el.cloneNode(false));
  const host = /** @type {HTMLElement} */ (document.getElementById('memorySettings'));
  const calls = { toasts: /** @type {any[]} */ ([]), downloads: /** @type {Array<{ name: string, text: string }>} */ ([]), confirm: true };
  let vaultState = opts.vault ?? 'none';
  /** @type {Array<() => void>} */
  const vaultListeners = [];
  const mounted = await view.mountMemoryView(
    host,
    { toast: (message, o) => (calls.toasts.push({ message, tone: o?.tone }), () => {}) },
    {
      store,
      projects: async () => [{ id: 'project_p1', name: 'Thesis' }],
      onProjectsChange: () => {},
      vault: { state: () => /** @type {any} */ (vaultState), onChange: (fn) => vaultListeners.push(fn) },
      download: (name, text) => void calls.downloads.push({ name, text }),
      confirm: () => calls.confirm,
      now: () => NOW,
      version: '3.0.0-test',
    },
  );
  const setVault = (/** @type {typeof vaultState} */ next) => {
    vaultState = next;
    for (const fn of vaultListeners) fn();
  };
  return { host, store, calls, mounted, setVault };
}

/** @param {HTMLElement} host @param {string} selector */
const q = (host, selector) => /** @type {HTMLElement} */ (host.querySelector(selector));
/** @param {HTMLElement} host */
const noteTexts = (host) => [...host.querySelectorAll('[data-fact] p.text-sm')].map((p) => p.textContent);

/** @param {HTMLInputElement} box @param {boolean} checked */
function toggle(box, checked) {
  box.checked = checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('memory settings', () => {
  it('starts with memory and suggestions off; suggestions can only be switched with memory on', async () => {
    await i18n.setLocale('en');
    const { host, store, calls } = await setup();
    const enabled = /** @type {HTMLInputElement} */ (q(host, '#mvEnabled'));
    assert.equal(enabled.checked, false);
    assert.equal(/** @type {HTMLInputElement} */ (q(host, '#mvSuggest')).disabled, true);
    assert.match(host.textContent ?? '', /Off by default\. At most 8 notes \(800 characters\)/);
    toggle(enabled, true);
    await until(() => calls.toasts.length === 1, 'the toast');
    assert.deepEqual(await store.prefs(), { enabled: true, suggest: false });
    assert.equal(/** @type {HTMLInputElement} */ (q(host, '#mvSuggest')).disabled, false);
    toggle(/** @type {HTMLInputElement} */ (q(host, '#mvSuggest')), true);
    await until(() => calls.toasts.length === 2, 'the toast');
    assert.deepEqual(await store.prefs(), { enabled: true, suggest: true });
    // Memory off takes the suggestions along.
    toggle(/** @type {HTMLInputElement} */ (q(host, '#mvEnabled')), false);
    await until(() => calls.toasts.length === 3, 'the toast');
    assert.deepEqual(await store.prefs(), { enabled: false, suggest: false });
  });

  it('saves the custom instructions', async () => {
    const { host, store, calls } = await setup();
    /** @type {HTMLTextAreaElement} */ (q(host, '#mvAboutMe')).value = 'I teach biology.';
    /** @type {HTMLTextAreaElement} */ (q(host, '#mvHowToAnswer')).value = 'Be brief.';
    q(host, '[data-mv="save-instructions"]').click();
    await until(() => calls.toasts.length === 1, 'the toast');
    assert.deepEqual(await store.instructions(), { aboutMe: 'I teach biology.', howToAnswer: 'Be brief.' });
    assert.deepEqual(calls.toasts[0], { message: 'memory.settings.instructions_saved', tone: 'ok' });
  });

  it('adds, edits, deletes and exports notes with their scope', async () => {
    const { host, store, calls } = await setup();
    assert.match(host.textContent ?? '', /No notes yet/);
    /** @type {HTMLInputElement} */ (q(host, '#mvAddText')).value = 'I live in Lisbon';
    q(host, '[data-mv-add]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => noteTexts(host).length === 1, 'the note');
    /** @type {HTMLInputElement} */ (q(host, '#mvAddText')).value = 'Chapter two is due in May';
    /** @type {HTMLSelectElement} */ (q(host, '#mvAddScope')).value = 'project_p1';
    q(host, '[data-mv-add]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => noteTexts(host).length === 2, 'the second note');
    assert.match(q(host, '[data-mv-count]').textContent ?? '', /Saved notes: 2 of 200/);
    assert.match(host.textContent ?? '', /Project: Thesis/);
    // A duplicate is refused with a message.
    /** @type {HTMLInputElement} */ (q(host, '#mvAddText')).value = 'i live in  lisbon';
    q(host, '[data-mv-add]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => calls.toasts.length === 1, 'the refusal');
    assert.deepEqual(calls.toasts[0], { message: 'memory.error_duplicate', tone: 'warn' });

    const lisbon = (await store.list()).facts.find((f) => f.text === 'I live in Lisbon');
    q(host, `[data-mv="edit"][data-id="${lisbon?.id}"]`).click();
    await until(() => host.querySelector('[data-mv-edit-text]'), 'the editor');
    /** @type {HTMLTextAreaElement} */ (q(host, '[data-mv-edit-text]')).value = 'I live in Porto';
    q(host, '[data-mv="edit-save"]').click();
    await until(() => noteTexts(host).includes('I live in Porto'), 'the edited note');

    q(host, '[data-mv="export"]').click();
    await until(() => calls.downloads.length === 1, 'the download');
    const doc = JSON.parse(calls.downloads[0].text);
    assert.equal(calls.downloads[0].name, 'starpi-memory-2026-10-18.json');
    assert.equal(doc.schema, 'starpi.memory/v1');
    assert.deepEqual(doc.facts.map((/** @type {any} */ f) => [f.text, f.scope, f.project ?? null]).sort(), [
      ['Chapter two is due in May', 'project', 'Thesis'],
      ['I live in Porto', 'global', null],
    ]);

    q(host, `[data-mv="delete"][data-id="${lisbon?.id}"]`).click();
    await until(() => noteTexts(host).length === 1, 'the delete');
    calls.confirm = false;
    q(host, '[data-mv="clear"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await store.list()).facts.length, 1);
    calls.confirm = true;
    q(host, '[data-mv="clear"]').click();
    await until(() => noteTexts(host).length === 0, 'the clear');
  });

  it('a redraw after a change keeps the note being typed and a switch just clicked', async () => {
    // The redraw after a change reads the store first; a switch clicked meanwhile is written after it.
    const held = { on: false, list: /** @type {(() => void) | null} */ (null), prefs: /** @type {(() => void) | null} */ (null) };
    /** @param {'list' | 'prefs'} which */
    const hold = (which) => (held.on ? new Promise((r) => (held[which] = () => r(undefined))) : undefined);
    const { host, store, calls } = await setup({
      wrap: (s) => ({ ...s, list: async () => (await hold('list'), s.list()), setPrefs: async (/** @type {any} */ p) => (await hold('prefs'), s.setPrefs(p)) }),
    });
    /** @type {HTMLInputElement} */ (q(host, '#mvAddText')).value = 'Chapter two is due in May';
    /** @type {HTMLSelectElement} */ (q(host, '#mvAddScope')).value = 'project_p1';
    held.on = true;
    await store.add({ text: 'I live in Lisbon', source: 'explicit' });
    await until(() => held.list, 'the redraw reading the notes');
    toggle(/** @type {HTMLInputElement} */ (q(host, '#mvEnabled')), true);
    held.on = false;
    held.list?.();
    await until(() => noteTexts(host).length === 1, 'the redrawn notes');
    assert.equal(/** @type {HTMLInputElement} */ (q(host, '#mvAddText')).value, 'Chapter two is due in May');
    assert.equal(/** @type {HTMLSelectElement} */ (q(host, '#mvAddScope')).value, 'project_p1');
    assert.equal(/** @type {HTMLInputElement} */ (q(host, '#mvEnabled')).checked, true, 'the click is not undone');
    held.prefs?.();
    await until(() => calls.toasts.length === 1, 'the switch');
    assert.deepEqual(await store.prefs(), { enabled: true, suggest: false });
    assert.equal(/** @type {HTMLInputElement} */ (q(host, '#mvEnabled')).checked, true);
  });

  it('says whether the notes are encrypted and hides them while the vault is locked', async () => {
    const { host, setVault } = await setup({ vault: 'unlocked' });
    assert.equal(q(host, '[data-mv-vault]').dataset.mvVault, 'unlocked');
    assert.match(q(host, '[data-mv-vault]').textContent ?? '', /encrypted with your vault passphrase/);
    setVault('locked');
    await until(() => q(host, '[data-mv-vault]').dataset.mvVault === 'locked', 'the locked line');
    assert.equal(host.querySelector('[data-mv-add]'), null, 'no new notes while locked');
    setVault('none');
    await until(() => q(host, '[data-mv-vault]').dataset.mvVault === 'none', 'the plain line');
    assert.match(q(host, '[data-mv-vault]').textContent ?? '', /Set a vault passphrase/);
  });

  it('switches language in place', async () => {
    const { host } = await setup();
    await i18n.setLocale('de');
    assert.match(host.textContent ?? '', /Gedächtnis und Personalisierung/);
    assert.match(host.textContent ?? '', /Gespeicherte Notizen in Chats verwenden/);
    await i18n.setLocale('en');
  });
});
