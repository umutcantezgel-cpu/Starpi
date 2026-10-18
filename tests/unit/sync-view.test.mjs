// Settings → Chat sync in a DOM (sync/settings-view.js) with a stand-in engine and data layer: the
// new-passphrase form and the unlock form of an account that already syncs, the passphrase checks,
// the state after turning on, sync now, turning off with or without deleting the synced copy (each
// confirmed), the notices of the other phases, the email code flow, a disabled form without a
// connection, and both languages.
/* global document */
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'SVGElement', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location'];

/** @type {typeof import('../../src/js/sync/settings-view.js')} */
let view;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;
/** @type {typeof import('../../src/js/i18n/index.js')} */
let i18n;

before(async () => {
  const jsdom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example/' });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  view = await import('../../src/js/sync/settings-view.js');
  i18n = await import('../../src/js/i18n/index.js');
});

after(() => {
  for (const key of GLOBALS) delete (/** @type {any} */ (globalThis))[key];
});

afterEach(async () => {
  document.querySelectorAll('[data-test-host]').forEach((el) => el.remove());
  await i18n.setLocale('en');
});

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/**
 * A stand-in engine whose answers the test sets.
 * @param {{ hasSync?: boolean }} [opts]
 */
function fakeSync(opts = {}) {
  /** @type {import('../../src/js/sync/sync.js').SyncStatus} */
  let status = { phase: 'off', busy: false, conversations: 0, lastSyncAt: null, skipped: 0, error: null, purging: false };
  /** @type {Set<(s: typeof status) => void>} */
  const listeners = new Set();
  /** @type {string[]} */
  const calls = [];
  /** @type {import('../../src/js/sync/sync.js').EnableResult} */
  let enableResult = { ok: true, joined: false, report: { applied: 0, written: 2, skipped: 0 } };
  /** A turn-off with deletion that cannot delete the rows yet. */
  let deleteFails = false;
  const set = (/** @type {Partial<typeof status>} */ patch) => {
    status = { ...status, ...patch };
    for (const fn of listeners) fn(status);
  };
  const sync = {
    ready: async () => {},
    status: () => status,
    onStatus: (/** @type {(s: typeof status) => void} */ fn) => (listeners.add(fn), () => listeners.delete(fn)),
    accountHasSync: async () => ({ ok: /** @type {const} */ (true), data: opts.hasSync === true }),
    enable: async (/** @type {string} */ pass) => {
      calls.push(`enable:${pass}`);
      if (enableResult.ok) set({ phase: 'on', conversations: 2, lastSyncAt: Date.parse('2026-10-18T10:00:00Z') });
      return enableResult;
    },
    disable: async (/** @type {{ deleteRemote: boolean }} */ o) => {
      calls.push(`disable:${o.deleteRemote}`);
      if (o.deleteRemote && deleteFails) {
        set({ purging: true, error: 'network' });
        return false;
      }
      set({ phase: 'off', conversations: 0, purging: false });
      return true;
    },
    syncNow: async () => {
      calls.push('syncNow');
      // A sync with a deletion pending finishes it (sync is off then).
      if (status.purging) set({ phase: 'off', conversations: 0, purging: false, error: null });
      return { applied: 0, written: 0, skipped: 0 };
    },
  };
  return {
    sync: /** @type {any} */ (sync),
    calls,
    set,
    /** @param {typeof enableResult} r */
    enableWith: (r) => (enableResult = r),
    /** @param {boolean} fails */
    deleteFailsWith: (fails) => (deleteFails = fails),
  };
}

/**
 * A stand-in data layer.
 * @param {{ ready?: boolean }} [opts]
 */
function fakeApi(opts = {}) {
  /** @type {string[]} */
  const calls = [];
  let email = /** @type {string | null} */ (null);
  const api = {
    getConnection: () => ({ status: opts.ready === false ? 'offline' : 'ready', signedIn: opts.ready !== false, hardened: true, authError: null, probeError: null }),
    onConnectionChange: () => () => {},
    syncAccount: async () => ({ ok: true, data: { userId: 'u1', email, anonymous: !email } }),
    sendEmailCode: async (/** @type {string} */ address, /** @type {string} */ purpose) => {
      calls.push(`send:${purpose}:${address}`);
      return address.includes('@') ? { ok: true, data: null } : { ok: false, error: { kind: 'invalid_email', message: 'x' } };
    },
    verifyEmailCode: async (/** @type {string} */ address, /** @type {string} */ code, /** @type {string} */ purpose) => {
      calls.push(`verify:${purpose}:${code}`);
      if (code !== '123456') return { ok: false, error: { kind: 'invalid_code', message: 'x' } };
      email = address;
      return { ok: true, data: { userId: 'u1', email, anonymous: false } };
    },
    signOutAccount: async () => {
      calls.push('signout');
      email = null;
      return { ok: true, data: null };
    },
  };
  return { api: /** @type {any} */ (api), calls };
}

/**
 * @param {ReturnType<typeof fakeSync>} s
 * @param {ReturnType<typeof fakeApi>} a
 * @param {{ confirm?: (m: string) => boolean }} [opts]
 */
async function mount(s, a, opts = {}) {
  const host = document.createElement('div');
  host.dataset.testHost = '';
  document.body.append(host);
  /** @type {string[]} */
  const confirms = [];
  const handle = view.mountSyncView(host, { onAction: dom.onAction, onLocaleChange: i18n.onLocaleChange }, { sync: s.sync, api: a.api, confirm: (m) => (confirms.push(m), opts.confirm ? opts.confirm(m) : true) });
  await handle.loaded;
  await settle();
  const $ = (/** @type {string} */ sel) => /** @type {HTMLElement | null} */ (host.querySelector(sel));
  const click = async (/** @type {string} */ action) => {
    const button = $(`[data-action="${action}"]`);
    assert.ok(button, `no button ${action}`);
    button.click();
    await settle();
  };
  const type = (/** @type {string} */ id, /** @type {string} */ value) => {
    const input = /** @type {HTMLInputElement} */ ($(`#${id}`));
    assert.ok(input, `no field ${id}`);
    input.value = value;
  };
  const result = () => $('[data-sv="result"]')?.textContent?.trim() ?? '';
  return { host, $, click, type, result, confirms };
}

describe('Settings › Chat sync', () => {
  it('turns sync on with a new passphrase, checked twice and long enough', async () => {
    const s = fakeSync();
    const ui = await mount(s, fakeApi());
    assert.equal(ui.$('[data-sync-state]')?.dataset.syncState, 'off');
    assert.equal(ui.$('[data-sv-form]')?.dataset.svForm, 'new');
    assert.match(ui.host.textContent ?? '', /at least 12 characters/);

    ui.type('svPass', 'a long passphrase');
    ui.type('svPass2', 'a long passphrase!');
    await ui.click('sync-enable');
    assert.match(ui.result(), /differ/);
    assert.deepEqual(s.calls, []);

    s.enableWith({ ok: false, reason: 'too_short' });
    ui.type('svPass', 'short');
    ui.type('svPass2', 'short');
    await ui.click('sync-enable');
    assert.match(ui.result(), /at least 12 characters/);

    s.enableWith({ ok: true, joined: false, report: { applied: 0, written: 2, skipped: 0 } });
    ui.type('svPass', 'a long passphrase');
    ui.type('svPass2', 'a long passphrase');
    await ui.click('sync-enable');
    assert.deepEqual(s.calls, ['enable:short', 'enable:a long passphrase']);
    assert.match(ui.result(), /Sync is on/);
    assert.equal(ui.$('[data-sync-state]')?.dataset.syncState, 'on');
    assert.match(ui.$('[data-sv="count"]')?.textContent ?? '', /2 conversations synced/);
    assert.equal(ui.$('#svPass'), null, 'the form is gone once sync is on');
  });

  it('asks for the passphrase of an account that already syncs, and says when it is wrong', async () => {
    const s = fakeSync({ hasSync: true });
    const ui = await mount(s, fakeApi());
    assert.equal(ui.$('[data-sv-form]')?.dataset.svForm, 'join');
    assert.equal(ui.$('#svPass2'), null);
    s.enableWith({ ok: false, reason: 'wrong_passphrase' });
    ui.type('svPass', 'not the right one');
    await ui.click('sync-enable');
    assert.match(ui.result(), /does not unlock/);
    s.enableWith({ ok: true, joined: true, report: { applied: 3, written: 0, skipped: 0 } });
    ui.type('svPass', 'the right passphrase');
    await ui.click('sync-enable');
    assert.match(ui.result(), /Unlocked/);
  });

  it('syncs now and turns off, with or without deleting the synced copy, after confirmation', async () => {
    const s = fakeSync();
    s.set({ phase: 'on', conversations: 5, lastSyncAt: Date.parse('2026-10-18T10:00:00Z'), skipped: 1 });
    const ui = await mount(s, fakeApi(), { confirm: () => false });
    assert.match(ui.$('[data-sv="summary"]')?.textContent ?? '', /5 conversations synced.*Last sync:.*1 conversations are not synced/s);
    await ui.click('sync-now');
    assert.match(ui.result(), /Synced/);
    await ui.click('sync-off-delete');
    assert.equal(ui.confirms.length, 1);
    assert.match(ui.confirms[0], /delete the synced copy/);
    assert.deepEqual(s.calls, ['syncNow'], 'declined: nothing happens');

    const ui2 = await mount(s, fakeApi());
    await ui2.click('sync-off-delete');
    assert.deepEqual(s.calls, ['syncNow', 'disable:true']);
    assert.match(ui2.result(), /synced copy was deleted/);
    assert.equal(ui2.$('[data-sync-state]')?.dataset.syncState, 'off');

    s.set({ phase: 'on' });
    await settle();
    await ui2.click('sync-off-local');
    assert.deepEqual(s.calls, ['syncNow', 'disable:true', 'disable:false']);
  });

  it('says when deleting the synced copy has not finished, and a later sync finishes it', async () => {
    const s = fakeSync();
    s.set({ phase: 'on', conversations: 3, lastSyncAt: Date.parse('2026-10-18T10:00:00Z') });
    s.deleteFailsWith(true);
    const ui = await mount(s, fakeApi());
    await ui.click('sync-off-delete');
    assert.match(ui.result(), /could not be deleted completely.*tries again/s);
    assert.match(ui.$('[data-sv="summary"]')?.textContent ?? '', /has not finished/);
    assert.ok(ui.$('[data-action="sync-off-delete"]'), 'the deletion can be tried again now');
    assert.equal(ui.$('[data-sync-state]')?.dataset.syncState, 'on');
    await ui.click('sync-now');
    assert.match(ui.result(), /synced copy was deleted/);
    assert.equal(ui.$('[data-sync-state]')?.dataset.syncState, 'off');
    assert.deepEqual(s.calls, ['disable:true', 'syncNow']);
  });

  it('explains the other phases', async () => {
    const s = fakeSync();
    s.set({ phase: 'remote_off' });
    const ui = await mount(s, fakeApi());
    assert.equal(ui.$('[data-sync-state]')?.dataset.syncState, 'remote_off');
    assert.match(ui.host.textContent ?? '', /turned off in another browser/);
    assert.equal(ui.$('[data-sv-form]')?.dataset.svForm, 'new');
    s.set({ phase: 'rekeyed' });
    await settle();
    assert.equal(ui.$('[data-sv-form]')?.dataset.svForm, 'join');
    s.set({ phase: 'other_account' });
    await settle();
    assert.match(ui.host.textContent ?? '', /another account/);
    assert.ok(ui.$('[data-action="sync-off-local"]'));
    s.set({ phase: 'unavailable' });
    await settle();
    assert.match(ui.host.textContent ?? '', /cannot keep the sync key/);
  });

  it('adds an email address with a code, signs out, and keeps typed text across status updates', async () => {
    const s = fakeSync();
    const a = fakeApi();
    const ui = await mount(s, a);
    assert.equal(ui.$('[data-sv-account]')?.dataset.svAccount, 'anonymous');
    ui.type('svEmail', 'nope');
    await ui.click('sync-email-link');
    assert.match(ui.result(), /valid email/);
    ui.type('svEmail', 'me@example.org');
    await ui.click('sync-email-link');
    assert.match(ui.result(), /sent a code to me@example.org/);
    ui.type('svCode', '000000');
    await ui.click('sync-email-verify');
    assert.match(ui.result(), /wrong or has expired/);
    ui.type('svCode', '123456');
    await ui.click('sync-email-verify');
    assert.match(ui.result(), /added to this account/);
    assert.equal(ui.$('[data-sv-account]')?.dataset.svAccount, 'email');
    assert.match(ui.$('[data-sv="who"]')?.textContent ?? '', /Signed in as me@example.org/);
    await ui.click('sync-signout');
    assert.equal(ui.$('[data-sv-account]')?.dataset.svAccount, 'anonymous');
    assert.deepEqual(a.calls, ['send:link:nope', 'send:link:me@example.org', 'verify:link:000000', 'verify:link:123456', 'signout']);

    // A status update while typing keeps the passphrase field as it is.
    ui.type('svPass', 'half typed');
    s.set({ busy: true });
    s.set({ busy: false, error: 'network' });
    await settle();
    assert.equal(/** @type {HTMLInputElement} */ (ui.$('#svPass')).value, 'half typed');
  });

  it('disables the form without a connection, and speaks German', async () => {
    await i18n.setLocale('de');
    const ui = await mount(fakeSync(), fakeApi({ ready: false }));
    assert.equal(/** @type {HTMLInputElement} */ (ui.$('#svPass')).disabled, true);
    assert.equal(ui.$('[data-action="sync-enable"]')?.hasAttribute('disabled'), true);
    assert.match(ui.host.textContent ?? '', /Ende-zu-Ende-verschlüsselt/);
    assert.match(ui.host.textContent ?? '', /braucht eine Verbindung/);
  });
});
