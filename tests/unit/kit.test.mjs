// The UI kit builds HTML strings that escape by default, keep i18n keys for later relabelling and
// always pair a status colour with an icon and a word; toasts land in the live region.
/* global document, window */
import './setup.mjs';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/ui/kit.js')} */
let kit;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="toastRegion"></div></body></html>', { url: 'http://localhost/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'NodeFilter', 'Text']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key], configurable: true, writable: true });
  }
  kit = await import('../../src/js/ui/kit.js');
});

/** @param {string} markup */
function fragment(markup) {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

describe('html``', () => {
  it('escapes interpolated values', () => {
    const name = '<img src=x onerror="alert(1)"> & \'quotes\'';
    const out = kit.html`<p title="${name}">${name}</p>`.value;
    assert.equal(out, '<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quotes&#39;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quotes&#39;</p>');
    assert.equal(fragment(out).querySelector('img'), null);
  });

  it('keeps nested kit output and raw() as markup, joins arrays and drops empty values', () => {
    const items = ['a<b', 'c'].map((x) => kit.html`<li>${x}</li>`);
    const out = kit.html`<ul>${items}${null}${undefined}${false}${kit.raw('<li>ok</li>')}</ul>${0}`;
    assert.equal(String(out), '<ul><li>a&lt;b</li><li>c</li><li>ok</li></ul>0');
  });
});

describe('labels', () => {
  it('render i18n keys with data-i18n and params, literal text escaped and without a key', () => {
    const keyed = fragment(kit.label({ key: 'workspace.meta', params: { chunks: 2, chars: '9' } }, { tag: 'p', className: 'x' }).value).firstElementChild;
    assert.equal(keyed?.tagName, 'P');
    assert.equal(keyed?.getAttribute('data-i18n'), 'workspace.meta');
    assert.equal(keyed?.getAttribute('data-i18n-params'), '{"chunks":2,"chars":"9"}');
    assert.equal(keyed?.textContent, '2 chunks · 9 characters');
    const literal = fragment(kit.label({ text: '<b>Report</b>' }).value).firstElementChild;
    assert.equal(literal?.hasAttribute('data-i18n'), false);
    assert.equal(literal?.textContent, '<b>Report</b>');
    assert.equal(kit.labelText('nav.settings'), 'Settings');
  });
});

describe('components', () => {
  it('card: heading level, title, badges, body and footer', () => {
    const el = fragment(kit.card({ title: 'shell.theme.title', icon: 'sun', level: 2, badges: kit.chip({ label: { text: 'New' } }), body: kit.html`<p>${'body <text>'}</p>`, footer: kit.html`<span>f</span>`, id: 'c1' }).value);
    const card = el.querySelector('#c1');
    assert.ok(card?.classList.contains('card'));
    assert.equal(card?.querySelector('h2.card-title')?.textContent, 'Appearance');
    assert.equal(card?.querySelector('.chip')?.textContent, 'New');
    assert.equal(card?.querySelector('p')?.textContent, 'body <text>');
    assert.equal(card?.querySelector('i[data-lucide="sun"]') !== null, true);
  });

  it('chip and provenance badge always carry an icon next to the text', () => {
    for (const tone of /** @type {const} */ (['neutral', 'ok', 'warn', 'danger', 'info'])) {
      const chip = fragment(kit.chip({ label: { text: tone }, tone }).value).firstElementChild;
      assert.ok(chip?.classList.contains(`chip-${tone}`), tone);
      assert.ok(chip?.querySelector('i[data-lucide]'), tone);
    }
    for (const kind of Object.keys(kit.PROVENANCE)) {
      const badge = fragment(kit.provenanceBadge(/** @type {any} */ (kind)).value).firstElementChild;
      assert.equal(badge?.getAttribute('data-provenance'), kind);
      assert.ok(badge?.querySelector('i[data-lucide]'), kind);
      assert.ok(badge?.textContent?.trim(), kind);
    }
    const hinted = fragment(kit.provenanceBadge('web', { label: { text: 'example.org' }, hint: 'shell.label.web' }).value).firstElementChild;
    assert.equal(hinted?.textContent, 'example.org');
    assert.equal(hinted?.getAttribute('title'), 'From the web · not verified');
    assert.equal(hinted?.getAttribute('data-i18n-title'), 'shell.label.web');
  });

  it('disclosure: a details element with a summary and its body', () => {
    const details = fragment(kit.disclosure({ summary: { text: 'More' }, body: kit.html`<p>inside</p>`, open: true }).value).querySelector('details');
    assert.equal(details?.open, true);
    assert.equal(details?.querySelector('summary')?.textContent, 'More');
    assert.equal(details?.querySelector('.disclosure-body p')?.textContent, 'inside');
  });

  it('segmented control: a named group of toggle buttons that dispatch one action', () => {
    const group = fragment(
      kit.segmented({ id: 'seg', action: 'pick', label: 'shell.theme.label', value: 'b', options: [{ value: 'a', label: { text: 'A' } }, { value: 'b', label: { text: 'B' }, icon: 'sun' }] }).value,
    ).querySelector('#seg');
    assert.equal(group?.getAttribute('role'), 'group');
    assert.equal(group?.getAttribute('aria-label'), 'Color theme');
    assert.equal(group?.getAttribute('data-i18n-aria'), 'shell.theme.label');
    const buttons = [...(group?.querySelectorAll('button') ?? [])];
    assert.deepEqual(buttons.map((b) => [b.dataset.action, b.dataset.arg, b.getAttribute('aria-pressed')]), [['pick', 'a', 'false'], ['pick', 'b', 'true']]);
    kit.setSegmentedValue(group ?? null, 'a');
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['true', 'false']);
  });

  it('empty state: title and text', () => {
    const el = fragment(kit.emptyState({ title: 'nav.research', body: 'shell.mount.empty' }).value);
    assert.equal(el.querySelector('h2')?.textContent, 'Research');
    assert.equal(el.querySelector('p')?.textContent, 'Nothing to show here yet.');
  });
});

describe('toast()', () => {
  it('shows notices in the live region, keeps at most three and dismisses them', () => {
    const region = /** @type {HTMLElement} */ (document.getElementById('toastRegion'));
    const dismiss = kit.toast({ text: 'first' }, { timeoutMs: 0 });
    assert.equal(region.children.length, 1);
    assert.equal(region.textContent, 'first');
    assert.equal(region.querySelector('button')?.getAttribute('aria-label'), 'Dismiss');
    dismiss();
    assert.equal(region.children.length, 0);
    for (const n of [1, 2, 3, 4]) kit.toast({ text: `n${n}` }, { tone: 'warn', timeoutMs: 0 });
    assert.deepEqual([...region.children].map((c) => c.textContent), ['n2', 'n3', 'n4']);
    region.querySelector('button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual([...region.children].map((c) => c.textContent), ['n3', 'n4']);
    region.replaceChildren();
  });

  it('removes a notice after its timeout', async () => {
    const region = /** @type {HTMLElement} */ (document.getElementById('toastRegion'));
    kit.toast('shell.theme.not_saved', { timeoutMs: 5 });
    assert.equal(region.children.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(region.children.length, 0);
  });
});
