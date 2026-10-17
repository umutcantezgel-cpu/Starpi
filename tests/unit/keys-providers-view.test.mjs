// Settings → Model providers and keys, rendered in a DOM: one row per provider with key and route
// chips, the vault controls, the access code when the site asks for one, the relay switch, the pool
// list and the local server with its cross-origin recipes. Clicks go through the app's delegated
// actions; the key store is a real one on a fake database.
/* global document */
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/settings/providers-view.js')} */
let view;
/** @type {typeof import('../../src/js/ai/keys.js')} */
let keysModule;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;
/** @type {typeof import('../../src/js/i18n/index.js')} */
let i18n;
/** @type {typeof import('../../src/js/store/schema.js')} */
let schema;
/** @type {JSDOM} */
let jsdom;

before(async () => {
  jsdom = new JSDOM('<!doctype html><html><body><div id="toastRegion"></div></body></html>', { url: 'https://app.example/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'SVGElement', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage']) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'location', { value: jsdom.window.location, configurable: true, writable: true });
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  view = await import('../../src/js/settings/providers-view.js');
  keysModule = await import('../../src/js/ai/keys.js');
  i18n = await import('../../src/js/i18n/index.js');
  schema = await import('../../src/js/store/schema.js');
});

after(() => {
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'SVGElement', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location']) delete (/** @type {any} */ (globalThis))[key];
});

afterEach(() => {
  document.querySelectorAll('[data-test-host]').forEach((el) => el.remove());
  localStorage.clear();
});

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/**
 * @param {() => boolean} check
 * @param {string} what
 */
async function until(check, what) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

let seq = 0;

/**
 * @param {{ access?: boolean, pools?: Record<string, { configured: boolean, defaultModel: string | null, models: string[] }>, testResult?: any, confirm?: boolean, clock?: { now: () => number, timers: any } }} [opts]
 */
async function mount(opts = {}) {
  const db = await schema.openAppDb({ name: `view-test-${(seq += 1)}`, factory: new IDBFactory() });
  const session = new Map();
  const keys = keysModule.createKeyStore({
    db: async () => db,
    iterations: 1000,
    session: { read: (n) => session.get(n) ?? '', write: (n, v) => (session.set(n, v), true), remove: (n) => void session.delete(n) },
    ...(opts.clock ? { now: opts.clock.now, timers: opts.clock.timers } : {}),
  });
  const healthState = { status: /** @type {const} */ ('ok'), data: { version: '3', pools: {}, simulated: {}, voice: { tts: false, stt: false, live: false }, research: false, access: opts.access === true }, error: null, at: 1 };
  /** @type {Array<{ id: string, key: string, opts: any }>} */
  const tests = [];
  /** @type {string[]} */
  const urls = [];
  /** @type {unknown[]} */
  const toasts = [];
  const host = document.createElement('div');
  host.dataset.testHost = '';
  document.body.append(host);
  const handle = view.mountProvidersView(
    host,
    { onAction: dom.onAction, onChange: dom.onChange, toast: (label) => void toasts.push(label) },
    {
      keys,
      health: { load: async () => healthState, get: () => healthState, subscribe: () => () => {} },
      fetchPools: async () => ({ reachable: true, pools: opts.pools ?? { groq: { configured: true, defaultModel: 'llama-3.3-70b-versatile', models: ['a', 'b', 'c'] }, nvidia: { configured: false, defaultModel: null, models: [] } } }),
      testKey: async (id, key, o) => {
        tests.push({ id, key, opts: o });
        return opts.testResult ?? { ok: true, via: 'direct', status: 200 };
      },
      getLocalUrl: () => 'http://localhost:8000/v1',
      setLocalUrl: (url) => (urls.push(url), true),
      confirm: () => opts.confirm ?? true,
    },
  );
  await handle.loaded;
  await settle();
  /** @param {string} selector */
  const q = (selector) => /** @type {HTMLElement} */ (host.querySelector(selector));
  /** @param {string} action @param {string} [arg] */
  const click = async (action, arg) => {
    const button = host.querySelector(`[data-action="${action}"]${arg ? `[data-arg="${arg}"]` : ''}`);
    assert.ok(button, `${action} ${arg ?? ''}`);
    /** @type {HTMLElement} */ (button).click();
    await settle();
  };
  /** @param {string} id @param {string} value */
  const type = (id, value) => {
    /** @type {HTMLInputElement} */ (q(`#${id}`)).value = value;
  };
  return { host, keys, session, tests, urls, toasts, q, click, type, handle };
}

describe('providers view', () => {
  it('renders every provider with its chips, the vault, the relay switch, pools and the local server', async () => {
    const { host, q } = await mount({ access: true });
    const rows = [...host.querySelectorAll('details[data-provider]')].map((el) => /** @type {HTMLElement} */ (el).dataset.provider);
    assert.deepEqual(rows, ['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'openrouter', 'nvidia']);
    assert.equal(q('[data-pv-status="anthropic"] [data-key]').dataset.key, 'none');
    assert.equal(q('[data-pv-status="anthropic"] [data-route]').dataset.route, 'none');
    assert.equal(q('[data-pv-status="groq"] [data-route]').dataset.route, 'pool', 'groq without a key uses the site pool');
    assert.equal(q('[data-vault-state]').dataset.vaultState, 'none');
    assert.ok(q('#pvPassphrase'));
    assert.equal(/** @type {HTMLInputElement} */ (q('#pvRelay')).checked, true);
    assert.ok(q('#pvAccess'), 'the site asks for an access code');
    assert.match(q('[data-pool="groq"]').textContent ?? '', /Groq: 3 free models/);
    assert.match(q('[data-pool="nvidia"]').textContent ?? '', /not offered/);
    assert.equal(/** @type {HTMLInputElement} */ (q('#pvKey-anthropic')).type, 'password');
    assert.equal(/** @type {HTMLInputElement} */ (q('#pvKey-anthropic')).placeholder, 'sk-ant-…');
    assert.match(q('details[data-provider="anthropic"]').textContent ?? '', /Keys start with sk-ant-/);
    assert.match(q('[data-cors="ollama"]').textContent ?? '', /OLLAMA_ORIGINS set to https:\/\/app\.example/);
    assert.match(q('[data-cors="vllm"]').textContent ?? '', /--allowed-origins/);
    assert.match(host.textContent ?? '', /local network/);
    assert.equal(/** @type {HTMLInputElement} */ (q('#pvLocalUrl')).value, 'http://localhost:8000/v1');
    // Remembering needs an open vault.
    assert.equal(/** @type {HTMLInputElement} */ (q('#pvRemember-anthropic')).disabled, true);
  });

  it('uses only keys that exist in English and German, and follows a language switch', async () => {
    const { host } = await mount({ access: true });
    const keys = new Set([...host.querySelectorAll('[data-i18n],[data-i18n-placeholder]')].map((el) => el.getAttribute('data-i18n') ?? el.getAttribute('data-i18n-placeholder') ?? ''));
    for (const id of ['created', 'unlocked', 'wrong', 'too_short', 'unavailable', 'locked', 'forgotten', 'idle']) keys.add(`providers.vault.result.${id}`);
    for (const code of ['invalid_slot', 'invalid_key', 'locked', 'unavailable', 'storage']) keys.add(`providers.error.${code}`);
    for (const state of ['locked', 'unlocked', 'unavailable']) keys.add(`providers.vault.state.${state}`), keys.add(`providers.vault.${state}_body`);
    for (const route of ['direct', 'auto', 'relay', 'pool', 'device']) keys.add(`providers.route.${route}`);
    for (const reason of ['unknown', 'no_key', 'relay_off', 'no_server', 'in_browser']) keys.add(`providers.route.reason.${reason}`);
    for (const k of ['saved', 'saved_vault', 'removed', 'empty', 'mismatch', 'vault', 'session', 'remember_locked']) keys.add(`providers.key.${k}`);
    for (const k of ['running', 'ok_direct', 'ok_relay', 'failed']) keys.add(`providers.test.${k}`);
    for (const k of ['on', 'off', 'reset_done']) keys.add(`providers.relay.${k}`);
    for (const k of ['saved', 'removed', 'placeholder_saved']) keys.add(`providers.access.${k}`);
    for (const k of ['unreachable', 'loading']) keys.add(`providers.pool.${k}`);
    keys.add('providers.local.saved');
    keys.add('providers.vault.working');
    keys.add('providers.vault.forget_confirm');
    keys.add('providers.vault.suggest');
    keys.add('providers.vault.suggest_dismiss');
    keys.delete('');
    await i18n.loadLocale('de');
    const missing = [...keys].filter((k) => !i18n.hasKey(k, 'en') || !i18n.hasKey(k, 'de'));
    assert.deepEqual(missing, []);
    await i18n.setLocale('de');
    try {
      assert.match(host.textContent ?? '', /Schlüsseltresor/);
      assert.match(host.textContent ?? '', /Kein Schlüssel/);
    } finally {
      await i18n.setLocale('en');
    }
  });

  it('saves a key for the tab, shows it masked and updates the route', async () => {
    const { q, click, type, keys, session } = await mount();
    type('pvKey-groq', 'gsk_abcdefghijklmnopqrstuvwxyz0123');
    await click('providers-save-key', 'groq');
    assert.equal(keys.getKey('groq'), 'gsk_abcdefghijklmnopqrstuvwxyz0123');
    assert.equal(session.get('starpi_key_groq'), 'gsk_abcdefghijklmnopqrstuvwxyz0123');
    assert.equal(/** @type {HTMLInputElement} */ (q('#pvKey-groq')).value, '', 'the field is cleared');
    await until(() => q('[data-pv-status="groq"] [data-key]').dataset.key === 'set', 'the key chip');
    assert.match(q('[data-pv-status="groq"]').textContent ?? '', /Key for this tab \(••••0123\)/);
    assert.equal(q('[data-pv-status="groq"] [data-route]').dataset.route, 'auto');
    assert.match(q('[data-pv-result="groq"]').textContent ?? '', /Key saved for this tab/);
    // A key that does not match the provider's format is kept, with a warning.
    type('pvKey-anthropic', 'not-an-anthropic-key');
    await click('providers-save-key', 'anthropic');
    assert.equal(keys.getKey('anthropic'), 'not-an-anthropic-key');
    assert.match(q('[data-pv-result="anthropic"]').textContent ?? '', /does not look like a key from Anthropic/);
    // Empty field.
    await click('providers-save-key', 'openai');
    assert.match(q('[data-pv-result="openai"]').textContent ?? '', /Paste a key first/);
    await click('providers-remove-key', 'groq');
    assert.equal(keys.getKey('groq'), '');
  });

  it('creates, uses, locks and unlocks the vault', async () => {
    const { q, click, type, keys } = await mount();
    type('pvPassphrase', 'short');
    await click('providers-unlock');
    assert.match(q('[data-pv="vault-result"]').textContent ?? '', /at least 8 characters/);
    type('pvPassphrase', 'a long passphrase');
    await click('providers-unlock');
    await until(() => keys.vaultState() === 'unlocked', 'the vault');
    assert.equal(q('[data-vault-state]').dataset.vaultState, 'unlocked');
    assert.match(q('[data-pv="vault-result"]').textContent ?? '', /Vault created/);
    assert.equal(/** @type {HTMLInputElement} */ (q('#pvRemember-openai')).disabled, false);

    type('pvKey-openai', 'sk-abcdefghijklmnopqrstuvwxyz012345');
    /** @type {HTMLInputElement} */ (q('#pvRemember-openai')).checked = true;
    await click('providers-save-key', 'openai');
    assert.equal(keys.keyLocation('openai'), 'vault');
    await until(() => /Key in the vault/.test(q('[data-pv-status="openai"]').textContent ?? ''), 'the vault chip');

    await click('providers-lock');
    assert.equal(keys.vaultState(), 'locked');
    assert.equal(q('[data-pv-status="openai"] [data-key]').dataset.key, 'none');
    type('pvPassphrase', 'not the passphrase');
    await click('providers-unlock');
    assert.match(q('[data-pv="vault-result"]').textContent ?? '', /does not open the vault/);
    type('pvPassphrase', 'a long passphrase');
    await click('providers-unlock');
    await until(() => keys.vaultState() === 'unlocked', 'the unlocked vault');
    assert.equal(keys.getKey('openai'), 'sk-abcdefghijklmnopqrstuvwxyz012345');

    await click('providers-forget');
    await until(() => keys.vaultState() === 'none', 'the forgotten vault');
    assert.equal(keys.getKey('openai'), '');
    assert.match(q('[data-pv="vault-result"]').textContent ?? '', /All keys were deleted/);
  });

  it('tests the typed key and shows the error code, never provider text', async () => {
    const { q, click, type, tests } = await mount({ testResult: { ok: false, code: 'auth', via: 'direct', status: 401 } });
    await click('providers-test-key', 'mistral');
    assert.match(q('[data-pv-result="mistral"]').textContent ?? '', /Paste a key first/);
    type('pvKey-mistral', 'abcdefghijklmnopqrstuvwxyz012345');
    await click('providers-test-key', 'mistral');
    assert.equal(tests[0].id, 'mistral');
    assert.equal(tests[0].key, 'abcdefghijklmnopqrstuvwxyz012345');
    assert.equal(typeof tests[0].opts.access, 'function');
    assert.equal(q('[data-pv-result="mistral"] [data-tone]').dataset.tone, 'danger');
    assert.match(q('[data-pv-result="mistral"]').textContent ?? '', /Test failed \(auth\): The provider did not accept the key/);
  });

  it('switches the relay fallback, stored as an opt-out, and the route follows', async () => {
    const { q, type, click } = await mount();
    type('pvKey-xai', 'xai-abcdefghijklmnopqrstuvwxyz');
    await click('providers-save-key', 'xai');
    await until(() => q('[data-pv-status="xai"] [data-route]').dataset.route === 'auto', 'the auto route');
    const box = /** @type {HTMLInputElement} */ (q('#pvRelay'));
    box.checked = false;
    box.dispatchEvent(new jsdom.window.Event('change', { bubbles: true }));
    await settle();
    assert.equal(localStorage.getItem('starpi_relay_fallback'), '0');
    assert.equal(q('[data-pv-status="xai"] [data-route]').dataset.route, 'direct');
    assert.equal(q('[data-pv-status="nvidia"] [data-route]').dataset.route, 'none');
    box.checked = true;
    box.dispatchEvent(new jsdom.window.Event('change', { bubbles: true }));
    await settle();
    assert.equal(localStorage.getItem('starpi_relay_fallback'), null);
  });

  it('fills the local server from a preset, saves it and tests it without a key', async () => {
    const { q, click, urls, tests } = await mount();
    await click('providers-local-preset', 'ollama');
    assert.equal(/** @type {HTMLInputElement} */ (q('#pvLocalUrl')).value, 'http://localhost:11434/v1');
    await click('providers-save-key', 'local');
    assert.deepEqual(urls, ['http://localhost:11434/v1']);
    assert.match(q('[data-pv-result="local"]').textContent ?? '', /Server address saved/);
    await click('providers-test-key', 'local');
    assert.deepEqual([tests[0].id, tests[0].key, tests[0].opts.baseUrl], ['local', '', 'http://localhost:11434/v1']);
    /** @type {HTMLInputElement} */ (q('#pvLocalUrl')).value = 'http://evil.example/v1';
    await click('providers-save-key', 'local');
    assert.equal(urls.length, 1, 'a plain-http address that is not loopback is refused');
    assert.equal(q('[data-pv-result="local"] [data-tone]').dataset.tone, 'danger');
  });

  it('stores the access code', async () => {
    const { q, click, type, keys } = await mount({ access: true });
    type('pvAccess', 'Grüße');
    await click('providers-save-access');
    assert.equal(keys.getKey(keysModule.ACCESS_SLOT), '', 'not a usable header value');
    assert.match(q('[data-pv="access-result"]').textContent ?? '', /printable characters/);
    type('pvAccess', ' open sesame ');
    await click('providers-save-access');
    assert.equal(keys.getKey(keysModule.ACCESS_SLOT), 'open sesame', 'an access code may contain inner spaces');
    assert.match(q('[data-pv="access-result"]').textContent ?? '', /Access code saved/);
  });

  it('announces the auto-lock', async () => {
    let now = 1_000;
    /** @type {Array<{ fn: () => void, at: number }>} */
    const timers = [];
    const clock = { now: () => now, timers: { set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.push({ fn, at: now + ms }), clear: () => {} } };
    const { q, click, type, keys, toasts } = await mount({ clock });
    type('pvPassphrase', 'a long passphrase');
    await click('providers-unlock');
    await until(() => keys.vaultState() === 'unlocked', 'the vault');
    now += keysModule.VAULT_IDLE_MS;
    for (const t of timers.splice(0)) if (t.at <= now) t.fn();
    await settle();
    assert.equal(keys.vaultState(), 'locked');
    assert.equal(q('[data-vault-state]').dataset.vaultState, 'locked');
    assert.deepEqual(toasts, ['providers.vault.result.idle']);
  });
});
