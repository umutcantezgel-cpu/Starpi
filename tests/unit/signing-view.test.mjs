// Settings → Trust in a DOM (trust/settings-view.js), and the receipt dialog exporting signed
// receipts (rag/receipts.js): the switch, the key with its id, JWK and PEM export, rotate and delete
// with confirmation, earlier keys, both languages; a download that names this device's key as its
// signer, carries its signature and has the id the dialog previewed.
/* global document */
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { sha256Hex, validateReceipt, verifyReceiptSignature } from '../../src/js/core/receipt.js';
import { publicKeyId } from '../../src/js/core/signature.js';
import { CHUNKER, chunkText } from '../../src/js/rag/chunker.js';
import { EXTRACTOR, extractText } from '../../src/js/rag/parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLAnchorElement', 'SVGElement', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage', 'location'];

// The receipt dialog exactly as the page has it.
const page = readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
const modalStart = page.indexOf('<div id="receiptModal"');
const RECEIPT_MODAL = page.slice(modalStart, page.indexOf('\n  </div>\n', modalStart) + 9);

/** @type {typeof import('../../src/js/trust/settings-view.js')} */
let view;
/** @type {typeof import('../../src/js/trust/signing.js')} */
let signing;
/** @type {typeof import('../../src/js/rag/receipts.js')} */
let receipts;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;
/** @type {typeof import('../../src/js/i18n/index.js')} */
let i18n;
/** @type {typeof import('../../src/js/store/schema.js')} */
let schema;
/** @type {Blob[]} */
const downloads = [];

before(async () => {
  const jsdom = new JSDOM(`<!doctype html><html><body><div id="toastRegion"></div>${RECEIPT_MODAL}</body></html>`, { url: 'https://app.example/' });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // Downloads are captured instead of followed.
  URL.createObjectURL = (/** @type {Blob} */ blob) => (downloads.push(blob), 'blob:https://app.example/receipt');
  URL.revokeObjectURL = () => {};
  jsdom.window.HTMLAnchorElement.prototype.click = () => {};
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  view = await import('../../src/js/trust/settings-view.js');
  signing = await import('../../src/js/trust/signing.js');
  receipts = await import('../../src/js/rag/receipts.js');
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

/**
 * @param {() => boolean} check
 * @param {string} what
 */
async function until(check, what) {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

let seq = 0;

/**
 * Mounts the view over a signer of its own.
 * @param {{ confirm?: boolean, signer?: import('../../src/js/trust/signing.js').ReceiptSignerApi }} [opts]
 */
async function mount(opts = {}) {
  const db = await schema.openAppDb({ name: `trust-view-${(seq += 1)}`, factory: new IDBFactory() });
  const signer = opts.signer ?? signing.createReceiptSigner({ db: async () => db });
  /** @type {Array<{ name: string, text: string, type: string }>} */
  const files = [];
  const confirmations = { asked: 0, answer: opts.confirm ?? true };
  const host = document.createElement('div');
  host.dataset.testHost = '';
  document.body.append(host);
  const handle = view.mountTrustView(host, { onAction: dom.onAction, onChange: dom.onChange, onLocaleChange: i18n.onLocaleChange }, {
    signer,
    confirm: () => (confirmations.asked += 1, confirmations.answer),
    download: (name, text, type) => void files.push({ name, text, type }),
  });
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
  const result = () => q('[data-tv="result"]').textContent ?? '';
  return { host, signer, files, confirmations, q, click, result, handle };
}

describe('Settings → Trust', () => {
  it('starts with signing on and no key, creates one and shows its full id', async () => {
    const { q, click, signer, result } = await mount();
    assert.equal(q('[data-trust-state]').dataset.trustState, 'ready');
    assert.equal(/** @type {HTMLInputElement} */ (q('#tvSign')).checked, true);
    assert.ok(q('[data-action="trust-create"]'));
    assert.equal(q('[data-trust="key-id"]'), null);
    await click('trust-create');
    const active = signer.state().active;
    assert.ok(active);
    assert.equal(q('[data-trust="key-id"]').textContent, active.id);
    assert.equal(q('[data-trust="alg"]').textContent, 'Ed25519');
    assert.equal(q('[data-trust-state]').dataset.trustState, 'on');
    assert.match(result(), /Signing key created/);
  });

  it('exports the public key as PEM and JWK files that name the same key', async () => {
    const { click, files, signer, result } = await mount();
    const { id } = await signer.createKey();
    await settle();
    await click('trust-export-pem', id);
    await click('trust-export-jwk', id);
    assert.deepEqual(files.map((f) => [f.name, f.type]), [
      [`starpi-signing-key-${id.slice(0, 12)}.pem`, 'application/x-pem-file'],
      [`starpi-signing-key-${id.slice(0, 12)}.jwk`, 'application/jwk+json'],
    ]);
    for (const f of files) assert.equal(await publicKeyId(f.text), id);
    assert.match(result(), /Saved starpi-signing-key-[0-9a-f]{12}\.jwk\./);
  });

  it('rotates and deletes only after confirming, and lists earlier keys', async () => {
    const { q, host, click, signer, confirmations, result } = await mount();
    const first = await signer.createKey();
    await settle();
    confirmations.answer = false;
    await click('trust-rotate');
    assert.equal(signer.state().active?.id, first.id, 'declined: nothing changes');
    confirmations.answer = true;
    await click('trust-rotate');
    const second = /** @type {NonNullable<ReturnType<typeof signer.state>['active']>} */ (signer.state().active);
    assert.notEqual(second.id, first.id);
    assert.match(result(), /New signing key made/);
    assert.equal(q('[data-trust="key-id"]').textContent, second.id);
    assert.ok(q(`[data-trust-retired="${first.id}"]`), 'the earlier key is listed');
    assert.ok(host.querySelector(`[data-trust-retired="${first.id}"] [data-action="trust-export-pem"]`));
    await click('trust-delete', first.id);
    assert.equal(q(`[data-trust-retired="${first.id}"]`), null);
    assert.match(result(), /Key deleted/);
    await click('trust-delete', second.id);
    assert.equal(signer.state().active, null);
    assert.ok(q('[data-action="trust-create"]'));
    assert.equal(confirmations.asked, 4);
  });

  it('switches signing off and on, stored', async () => {
    const { q, signer, result } = await mount();
    const box = /** @type {HTMLInputElement} */ (q('#tvSign'));
    box.checked = false;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();
    assert.equal(signer.state().enabled, false);
    assert.equal(q('[data-trust-state]').dataset.trustState, 'off');
    assert.match(result(), /Exported receipts are not signed/);
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();
    assert.equal(signer.state().enabled, true);
    assert.match(result(), /Exported receipts are signed/);
  });

  it('says when signing is unavailable or keys last only for the page', async () => {
    const unavailable = await mount({ signer: signing.createReceiptSigner({ crypto: /** @type {Crypto} */ ({}), db: async () => Promise.reject(new Error('none')) }) });
    assert.equal(unavailable.q('[data-trust-state]').dataset.trustState, 'unavailable');
    assert.equal(/** @type {HTMLInputElement} */ (unavailable.q('#tvSign')).disabled, true);
    assert.match(unavailable.q('[data-tv="key"]').textContent ?? '', /cannot make signing keys here/);
    assert.equal(unavailable.q('[data-action="trust-create"]'), null);
    const memory = await schema.openAppDb({ name: `trust-memory-${(seq += 1)}`, factory: null });
    const pageOnly = await mount({ signer: signing.createReceiptSigner({ db: async () => memory }) });
    assert.match(pageOnly.q('[data-tv="note"]').textContent ?? '', /lasts only until the page is closed/);
  });

  it('uses only keys that exist in English and German, and follows a language switch', async () => {
    const { host, signer } = await mount();
    await signer.createKey();
    await signer.rotate();
    await settle();
    const keys = new Set([...host.querySelectorAll('[data-i18n]')].map((el) => el.getAttribute('data-i18n') ?? ''));
    for (const state of ['on', 'off', 'ready', 'unavailable']) keys.add(`trust.state.${state}`);
    for (const k of ['exported', 'created', 'rotated', 'deleted', 'sign_on', 'sign_off', 'sign_page']) keys.add(`trust.result.${k}`);
    for (const k of ['unavailable', 'not_found', 'storage']) keys.add(`trust.error.${k}`);
    for (const k of ['rotate_confirm', 'delete_confirm', 'none', 'unavailable', 'not_persistent', 'create']) keys.add(`trust.key.${k}`);
    keys.add('trust.retired.delete_confirm');
    for (const k of ['signed_by', 'unsigned_off', 'unsigned_unavailable', 'signer', 'signature_missing', 'trusted', 'not_trusted', 'own_key', 'gate', 'second_opinions', 'relations', 'check_ocr']) keys.add(`trust.receipt.${k}`);
    keys.delete('');
    await i18n.loadLocale('de');
    assert.deepEqual([...keys].filter((k) => !i18n.hasKey(k, 'en') || !i18n.hasKey(k, 'de')), []);
    await i18n.setLocale('de');
    try {
      assert.match(host.textContent ?? '', /Vertrauen · Belege signieren/);
      assert.match(host.textContent ?? '', /Frühere Schlüssel/);
    } finally {
      await i18n.setLocale('en');
    }
  });
});

describe('the receipt dialog', () => {
  /** A draft citing the first chunk of the sample plan. */
  async function draft() {
    const bytes = new Uint8Array(readFileSync(path.join(ROOT, 'public/samples/en/nebula-plan.md')));
    const { text, kind, pages, pdfjs } = await extractText(new File([bytes], 'nebula-plan.md'));
    const [chunk] = chunkText(text);
    const label = '[Doc: nebula-plan.md, Chunk: 1]';
    const answer = `The approved budget for Project Nebula is 480,000 EUR ${label}.`;
    const sources = [{ label, doc: 'nebula-plan.md', heading: '', text: chunk.text, delivered: /** @type {const} */ ('full') }];
    return {
      createdAt: '2026-10-17T11:00:00.000Z',
      version: '3.0.0',
      answer: { text: answer, engine: 'cloud', locale: 'en' },
      question: 'Budget?',
      grounding: groundAnswer(blocksFromMarkdown(answer, sources), sources),
      citations: [
        {
          label,
          doc: 'nebula-plan.md',
          heading: '',
          source: /** @type {const} */ ('workspace'),
          delivered: /** @type {const} */ ('full'),
          text: chunk.text,
          truncated: false,
          document: { name: 'nebula-plan.md', kind, bytes: bytes.length, fileSha256: await sha256Hex(bytes), textSha256: await sha256Hex(text), textChars: text.length, pages, extractor: { ...EXTRACTOR, pdfjs }, chunker: { ...CHUNKER, size: 500, overlap: 50 } },
          chunk: { index: chunk.index, start: chunk.start, end: chunk.end },
        },
      ],
    };
  }

  /** Opens the dialog for a draft, waits for the preview, downloads and returns the receipt. */
  async function exportOnce() {
    const button = receipts.receiptButton(receipts.storeReceiptDraft(await draft()));
    button.dataset.testHost = '';
    document.body.append(button);
    const line = () => document.getElementById('receiptSigning')?.textContent ?? '';
    const idEl = /** @type {HTMLElement} */ (document.getElementById('receiptId'));
    idEl.textContent = '–';
    button.click();
    await until(() => idEl.textContent !== '–' && line() !== '', 'the preview');
    const before = downloads.length;
    /** @type {HTMLElement} */ (document.querySelector('[data-action="download-receipt"]')).click();
    await until(() => downloads.length > before, 'the download');
    const receipt = JSON.parse(await downloads[downloads.length - 1].text());
    /** @type {HTMLElement} */ (document.querySelector('[data-action="close-receipt"]')).click();
    return { receipt, previewId: idEl.textContent, line: line() };
  }

  it('downloads a receipt signed with this device key, with the id it previewed', async () => {
    receipts.initReceipts();
    const { receipt, previewId, line } = await exportOnce();
    const valid = validateReceipt(receipt);
    assert.equal(valid.ok, true, JSON.stringify(valid));
    assert.equal(receipt.schema, 'starpi.receipt/v3');
    assert.equal(previewId, receipt.id.slice(0, 16));
    const active = signing.receiptSigner.state().active;
    assert.ok(active);
    assert.deepEqual(receipt.signer, { keyId: active.id, alg: active.alg });
    assert.equal(line, `Signed with this device's key ${active.id.slice(0, 16)}… (${active.alg}).`);
    const pem = (await signing.receiptSigner.exportPublicKey(active.id, 'pem')).text;
    assert.deepEqual(await verifyReceiptSignature(receipt, pem), { status: 'valid', alg: active.alg, keyId: active.id, trusted: true });
  });

  it('downloads an unsigned receipt while signing is off, and says so', async () => {
    await signing.receiptSigner.setEnabled(false);
    try {
      const { receipt, line } = await exportOnce();
      assert.equal(receipt.signer, undefined);
      assert.equal(receipt.signature, undefined);
      assert.match(line, /Not signed: signing is turned off in Settings › Trust/);
    } finally {
      await signing.receiptSigner.setEnabled(true);
    }
  });
});
