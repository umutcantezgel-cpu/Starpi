// Settings → Trust → Model downloads in a DOM (trust/model-integrity-view.js): the results of the
// download check per model with their state and failed files, "Load unverified (upstream changed)"
// only after the warning is confirmed, the way back, a refresh when a check finishes, and texts that
// exist in English and German. The engine and the embedding client name the same keys for their
// errors and progress.
/* global document */
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'SVGElement', 'NodeFilter', 'Text', 'localStorage', 'location'];

/** @type {typeof import('../../src/js/trust/model-integrity-view.js')} */
let view;
/** @type {typeof import('../../src/js/models/integrity-state.js')} */
let state;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;
/** @type {typeof import('../../src/js/i18n/index.js')} */
let i18n;
/** @type {typeof import('../../src/js/store/schema.js')} */
let schema;

before(async () => {
  const jsdom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example/' });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  view = await import('../../src/js/trust/model-integrity-view.js');
  state = await import('../../src/js/models/integrity-state.js');
  i18n = await import('../../src/js/i18n/index.js');
  schema = await import('../../src/js/store/schema.js');
});

after(() => {
  for (const key of GLOBALS) delete (/** @type {any} */ (globalThis))[key];
});

afterEach(() => {
  document.querySelectorAll('[data-test-host]').forEach((el) => el.remove());
});

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let seq = 0;

/** @param {Partial<import('../../src/js/models/integrity-state.js').ModelCheck>} fields */
const check = (fields) => ({ id: 'wasm:org/m', label: 'Model M', runtime: /** @type {const} */ ('wasm'), status: /** @type {const} */ ('verified'), files: 5, mismatched: [], unverified: [], checkedAt: Date.UTC(2026, 9, 17, 10), ...fields });

/** Mounts the view over a database of its own. */
async function mount(/** @type {{ confirm?: boolean }} */ opts = {}) {
  const db = await schema.openAppDb({ name: `integrity-view-${(seq += 1)}`, factory: new IDBFactory() });
  const getDb = async () => db;
  const confirmations = { asked: /** @type {string[]} */ ([]), answer: opts.confirm ?? true };
  const host = document.createElement('div');
  host.dataset.testHost = '';
  document.body.append(host);
  const handle = view.mountModelIntegrityView(host, { onAction: dom.onAction, onChange: dom.onChange, onLocaleChange: i18n.onLocaleChange }, {
    readChecks: () => state.readChecks(getDb),
    unverifiedAllowed: () => state.unverifiedAllowed(getDb),
    setAllowUnverified: (id, allow) => state.setAllowUnverified(id, allow, getDb),
    confirm: (message) => (confirmations.asked.push(message), confirmations.answer),
  });
  await handle.loaded;
  /** @param {string} selector */
  const q = (selector) => /** @type {HTMLElement | null} */ (host.querySelector(selector));
  /** @param {string} action @param {string} arg */
  const click = async (action, arg) => {
    const button = host.querySelector(`[data-action="${action}"][data-arg="${arg}"]`);
    assert.ok(button, `${action} ${arg}`);
    /** @type {HTMLElement} */ (button).click();
    await settle();
  };
  return { host, db, getDb, q, click, confirmations, handle, save: (/** @type {any} */ c) => state.saveCheck(c, getDb) };
}

describe('Settings → Trust → Model downloads', () => {
  it('says that nothing was checked yet', async () => {
    const { q } = await mount();
    assert.match(q('[data-mi="list"]')?.textContent ?? '', /No model has been checked on this device yet/);
  });

  it('lists each checked model with its state and failed files, and refreshes when a check finishes', async () => {
    const { q, save, handle } = await mount();
    await save(check({ id: 'webgpu:Tiny-q4f16_1-MLC', label: 'Tiny (f16)', runtime: 'webgpu', files: 12 }));
    await settle();
    const verified = q('[data-model-check="webgpu:Tiny-q4f16_1-MLC"]');
    assert.ok(verified, 'a finished check shows without a reload');
    assert.equal(verified.dataset.state, 'verified');
    assert.match(verified.textContent ?? '', /Tiny \(f16\).*GPU \(WebGPU\).*Verified/s);
    assert.match(verified.textContent ?? '', /12 files checked · /);
    assert.equal(verified.querySelector('[data-action]'), null, 'nothing to allow for a verified model');

    const files = ['params_shard_0.bin', 'params_shard_1.bin', 'params_shard_2.bin', 'params_shard_3.bin', 'params_shard_4.bin', 'params_shard_5.bin'];
    await save(check({ id: 'embed:org/e', label: 'Embedder', runtime: 'embed', status: 'mismatch', files: 1, mismatched: ['onnx/model_quantized.onnx'], checkedAt: Date.UTC(2026, 9, 17, 12) }));
    await save(check({ id: 'wasm:org/u', label: 'Unpinned', status: 'unverified', files: 6, unverified: files, checkedAt: Date.UTC(2026, 9, 17, 11) }));
    await handle.reload();
    const ids = [...(q('[data-mi="list"]')?.querySelectorAll('[data-model-check]') ?? [])].map((el) => /** @type {HTMLElement} */ (el).dataset.modelCheck);
    assert.deepEqual(ids, ['embed:org/e', 'wasm:org/u', 'webgpu:Tiny-q4f16_1-MLC'], 'newest first');
    const mismatch = /** @type {HTMLElement} */ (q('[data-model-check="embed:org/e"]'));
    assert.match(mismatch.textContent ?? '', /Search model.*File deleted/s);
    assert.match(mismatch.textContent ?? '', /Did not match the pinned hash: onnx\/model_quantized\.onnx/);
    assert.ok(mismatch.querySelector('[data-action="model-integrity-allow"]'));
    const unpinned = /** @type {HTMLElement} */ (q('[data-model-check="wasm:org/u"]'));
    assert.match(unpinned.textContent ?? '', /No pinned hash: params_shard_0\.bin, params_shard_1\.bin, params_shard_2\.bin, params_shard_3\.bin, … \(\+2\)/);
  });

  it('allows a model to load unverified only after the warning, and takes it back', async () => {
    const { q, click, confirmations, getDb, save } = await mount({ confirm: false });
    await save(check({ status: 'unverified', unverified: ['onnx/extra.onnx'] }));
    await settle();
    await click('model-integrity-allow', 'wasm:org/m');
    assert.equal(confirmations.asked.length, 1);
    assert.match(confirmations.asked[0], /Load Model M without matching pinned hashes\?/);
    assert.deepEqual(await state.unverifiedAllowed(getDb), [], 'declined: nothing changes');

    confirmations.answer = true;
    await click('model-integrity-allow', 'wasm:org/m');
    assert.deepEqual(await state.unverifiedAllowed(getDb), ['wasm:org/m']);
    assert.match(q('[data-mi="result"]')?.textContent ?? '', /Model M may load unverified/);
    const item = /** @type {HTMLElement} */ (q('[data-model-check="wasm:org/m"]'));
    assert.match(item.textContent ?? '', /Allowed to load unverified/);
    assert.ok(item.querySelector('[data-action="model-integrity-revoke"]'));

    await click('model-integrity-revoke', 'wasm:org/m');
    assert.deepEqual(await state.unverifiedAllowed(getDb), []);
    assert.match(q('[data-mi="result"]')?.textContent ?? '', /Model M loads only with verified files again/);
    assert.ok(q('[data-model-check="wasm:org/m"] [data-action="model-integrity-allow"]'));
  });

  it('says when the setting cannot be stored', async () => {
    const host = document.createElement('div');
    host.dataset.testHost = '';
    document.body.append(host);
    const handle = view.mountModelIntegrityView(host, { onAction: dom.onAction, onChange: dom.onChange }, {
      readChecks: async () => [check({ status: 'mismatch', mismatched: ['a.bin'] })],
      unverifiedAllowed: async () => [],
      setAllowUnverified: async () => Promise.reject(new Error('read-only')),
      onIntegrityChange: () => () => {},
      confirm: () => true,
    });
    await handle.loaded;
    /** @type {HTMLElement} */ (host.querySelector('[data-action="model-integrity-allow"]')).click();
    await settle();
    assert.match(host.querySelector('[data-mi="result"]')?.textContent ?? '', /could not be stored on this device/);
  });

  it('uses only keys that exist in English and German, and follows a language switch', async () => {
    const { host, save } = await mount();
    await save(check({ status: 'override', mismatched: ['a.bin'] }));
    await settle();
    const keys = new Set([...host.querySelectorAll('[data-i18n]')].map((el) => el.getAttribute('data-i18n') ?? ''));
    for (const s of ['verified', 'override', 'mismatch', 'unverified']) keys.add(`trust.models.state.${s}`);
    for (const r of ['webgpu', 'wasm', 'embed']) keys.add(`trust.models.runtime.${r}`);
    for (const k of ['empty', 'mismatched', 'unpinned', 'allow', 'allow_confirm', 'allowed', 'revoke', 'result.allowed', 'result.revoked', 'error.storage']) keys.add(`trust.models.${k}`);
    // What the engine shows for a failed check and while it hashes.
    for (const k of ['engine.error.integrity', 'engine.error.unverified', 'engine.progress.verify']) keys.add(k);
    keys.delete('');
    await i18n.loadLocale('de');
    assert.deepEqual([...keys].filter((k) => !i18n.hasKey(k, 'en') || !i18n.hasKey(k, 'de')), []);
    await i18n.setLocale('de');
    try {
      assert.match(host.textContent ?? '', /Vertrauen · Modell-Downloads/);
      assert.match(host.textContent ?? '', /Ungeprüft geladen/);
      assert.match(host.textContent ?? '', /5 Dateien geprüft/);
    } finally {
      await i18n.setLocale('en');
    }
  });
});
