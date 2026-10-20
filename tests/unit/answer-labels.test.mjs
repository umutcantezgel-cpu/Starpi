// Answer labels (src/js/chat/answer-labels.js) in a DOM: every answer shows its label (free,
// grounded, mixed, web) with the "checking…" state while the check runs, an embedding app replaces
// the wording, web answers get the web check's line, and mixed answers get their checked parts
// marked from the rendered answer.
/* global document */
import './setup.mjs';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/chat/answer-labels.js')} */
let labels;
/** @type {typeof import('../../src/js/rag/citations.js')} */
let citations;
/** @type {typeof import('../../src/js/render.js')} */
let render;
/** @type {typeof import('../../src/js/retrieval.js')} */
let retrieval;
/** @type {typeof import('../../src/js/i18n/index.js')} */
let i18n;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'NodeFilter', 'Text', 'localStorage']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : /** @type {any} */ (dom.window)[key], configurable: true, writable: true });
  }
  render = await import('../../src/js/render.js');
  citations = await import('../../src/js/rag/citations.js');
  retrieval = await import('../../src/js/retrieval.js');
  i18n = await import('../../src/js/i18n/index.js');
  labels = await import('../../src/js/chat/answer-labels.js');
});

/** @param {string} markdown @param {string | null} [scope] */
function message(markdown, scope = null) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="message-content">${render.renderMarkdown(markdown)}</div><div class="message-provenance"></div>`;
  if (scope) citations.linkifyCitations(/** @type {HTMLElement} */ (el.querySelector('.message-content')), scope);
  document.body.append(el);
  return el;
}

/** @param {HTMLElement} el */
const labelOf = (el) => /** @type {HTMLElement | null} */ (el.querySelector('.answer-label'));

describe('labels', () => {
  it('shows the label of every kind with its provenance and text', () => {
    const want = {
      free: ['unchecked', 'Free chat · not checked'],
      grounded: ['checked', 'Checked against your sources'],
      mixed: ['mixed', 'Partly from sources (checked parts marked)'],
      web: ['web', 'From the web · cited, not verified'],
    };
    for (const [name, [kind, text]] of Object.entries(want)) {
      const el = message('An answer.');
      labels.renderAnswerLabel(el, /** @type {any} */ (name));
      const row = /** @type {HTMLElement} */ (labelOf(el));
      assert.equal(row.dataset.answerLabel, name);
      assert.equal(row.querySelector('[data-provenance]')?.getAttribute('data-provenance'), kind);
      assert.equal(row.textContent?.trim(), text);
      assert.ok(row.querySelector('[data-provenance]')?.getAttribute('title'), 'a tooltip says what the label means');
    }
  });

  it('says "checking…" while the check runs and replaces the label when it is shown again', () => {
    const el = message('An answer.');
    labels.renderAnswerLabel(el, 'grounded', { checking: true });
    assert.equal(labelOf(el)?.dataset.checking, 'true');
    assert.equal(labelOf(el)?.getAttribute('aria-busy'), 'true');
    assert.match(labelOf(el)?.textContent ?? '', /checking…/);
    labels.renderAnswerLabel(el, 'grounded');
    assert.equal(el.querySelectorAll('.answer-label').length, 1);
    assert.equal(labelOf(el)?.dataset.checking, undefined);
  });

  it('takes the wording an embedding app passes, per language or as its own key', async () => {
    const restore = labels.setAnswerLabelProfile({ free: { text: { en: 'General knowledge · not checked', de: 'Allgemeinwissen · nicht geprüft' } }, grounded: { text: 'answers.label.web' } });
    try {
      const el = message('An answer.');
      labels.renderAnswerLabel(el, 'free');
      assert.equal(labelOf(el)?.textContent?.trim(), 'General knowledge · not checked');
      await i18n.setLocale('de');
      labels.renderAnswerLabel(el, 'free');
      assert.equal(labelOf(el)?.textContent?.trim(), 'Allgemeinwissen · nicht geprüft');
      labels.renderAnswerLabel(el, 'mixed');
      assert.equal(labelOf(el)?.textContent?.trim(), 'Teilweise aus Quellen (geprüfte Teile markiert)');
      await i18n.setLocale('en');
      labels.renderAnswerLabel(el, 'grounded');
      assert.equal(labelOf(el)?.textContent?.trim(), 'From the web · cited, not verified');
    } finally {
      restore();
      await i18n.setLocale('en');
    }
    const el = message('An answer.');
    labels.renderAnswerLabel(el, 'free');
    assert.equal(labelOf(el)?.textContent?.trim(), 'Free chat · not checked');
  });

  it('reads the label of a stored answer', () => {
    assert.equal(labels.answerLabelOf({ label: 'free', meta: { chat_mode: 'free' } }), 'free');
    assert.equal(labels.answerLabelOf({ label: 'grounded', meta: { chat_mode: 'grounded' } }), 'grounded');
    assert.equal(labels.answerLabelOf({ label: 'mixed', meta: { chat_mode: 'grounded' } }), 'mixed');
    assert.equal(labels.answerLabelOf({ label: 'web', meta: { chat_mode: 'free' } }), 'web');
    assert.equal(labels.answerLabelOf({ label: 'free', meta: { chat_mode: 'free', web_sources: [{ url: 'https://a.example' }] } }), 'web', 'answers stored before the label');
    assert.equal(labels.answerLabelOf({ label: null, meta: { answer_label: 'mixed' } }), 'mixed');
    assert.equal(labels.answerLabelOf({ label: 'grounded', meta: { answer_label: 'bogus' } }), 'grounded');
  });

  it('shows the web check under the label', () => {
    const lines = [
      [{ kind: 'checked', pages: 2, supported: 2, total: 3, flagged: 1 }, 'Checked against the cited text: 2 of 3 statements found'],
      [{ kind: 'checked', pages: 1, total: 0 }, 'Checked against the cited text: no statement to compare'],
      [{ kind: 'segments', pages: 1, flagged: 0, total: 2 }, 'Numbers checked: all lie in cited passages'],
      [{ kind: 'segments', pages: 1, flagged: 2, total: 4 }, 'Numbers checked: 2 sentence(s) with numbers outside the cited passages'],
      [{ kind: 'cited', pages: 3 }, 'Cited, not checked'],
    ];
    for (const [check, text] of lines) {
      const el = message('An answer.');
      labels.renderAnswerLabel(el, 'web');
      labels.renderWebCheck(el, /** @type {any} */ (check));
      const line = el.querySelector('.web-check');
      assert.equal(line?.textContent, text);
      assert.equal(line?.previousElementSibling, labelOf(el), 'right under the label');
    }
    const none = message('An answer.');
    labels.renderWebCheck(none, { kind: 'none', pages: 0 });
    labels.renderWebCheck(none, null);
    assert.equal(none.querySelector('.web-check'), null);
  });
});

describe('companion answers', () => {
  it('take their label from the companion, with its notice and the withheld count under it', () => {
    assert.equal(labels.companionLabel({ mode: 'sources', source: 'model' }), 'companion');
    assert.equal(labels.companionLabel({ mode: 'free', source: 'model' }), 'companion_free');
    assert.equal(labels.companionLabel({ mode: 'sources', source: 'template' }), 'companion_template');
    const want = { companion: ['checked', 'Checked by the companion'], companion_free: ['unchecked', 'General knowledge, not checked against sources'], companion_template: ['withheld', 'Template answer, no model wrote it'] };
    for (const [name, [kind, text]] of Object.entries(want)) {
      const el = message('An answer.');
      labels.renderAnswerLabel(el, /** @type {any} */ (name));
      const row = /** @type {HTMLElement} */ (labelOf(el));
      assert.equal(row.querySelector('[data-provenance]')?.getAttribute('data-provenance'), kind);
      assert.equal(row.textContent?.trim(), text);
      assert.ok(row.querySelector('[data-provenance]')?.getAttribute('title'));
    }
    assert.equal(labels.answerLabelOf({ label: 'companion_free', meta: { answer_label: 'companion_free' } }), 'companion_free');

    const el = message('No language model is configured.');
    labels.renderAnswerLabel(el, 'companion_template');
    labels.renderCompanionNotes(el, { notice: 'no_model', withheld: 2 });
    labels.renderCompanionNotes(el, { notice: 'no_model', withheld: 2 });
    const notes = [...el.querySelectorAll('.companion-note')];
    assert.equal(notes.length, 2, 'shown once');
    assert.match(notes[0].textContent ?? '', /No language model is configured in the companion/);
    assert.match(notes[1].textContent ?? '', /2 sentences were withheld/);
    assert.equal(labelOf(el)?.nextElementSibling, notes[0], 'right under the label');
    const other = message('x');
    labels.renderCompanionNotes(other, { notice: 'something_new', withheld: 0 });
    assert.match(other.textContent ?? '', /The companion answered with a template/);
  });
});

describe('mixed answers', () => {
  const PLAN = 'Project Nebula launches on 12 May 2027. The approved budget is 480,000 EUR.';

  function register() {
    const hits = [{ documentId: 'a', documentTitle: 'plan.md', heading: '', content: PLAN, tags: [], rank: 1, workspace: { docId: 'a', chunkIndex: 0, start: 0, end: PLAN.length } }];
    const list = retrieval.assignCitations(hits, { excerptChars: 1600 });
    const scope = /** @type {string} */ (citations.registerCitations(list));
    const sources = list.map((c) => ({ label: c.label, doc: c.doc, heading: c.heading, text: c.text, delivered: /** @type {const} */ ('full') }));
    return { scope, sources };
  }

  it('marks statements found in the sources, cited ones that are not, and general knowledge', () => {
    const { scope, sources } = register();
    const el = message(
      'The approved budget is 480,000 EUR [Doc: plan.md, Chunk: 1]. Nebula launches on 14 June 2027 [Doc: plan.md, Chunk: 1].\n\nIn general, large projects keep a reserve of about ten percent for surprises.',
      scope,
    );
    const report = labels.applyMixedMarks(el, { scope, sources, given: ['What is the budget?'] });
    assert.ok(report);
    const items = [...el.querySelectorAll('.mixed-marks .grounding-item')].map((li) => /** @type {HTMLElement} */ (li).dataset.mark);
    assert.deepEqual(items, ['from_sources', 'cited_not_found', 'not_in_sources']);
    const bar = /** @type {HTMLDetailsElement} */ (el.querySelector('.mixed-marks'));
    assert.ok(bar.classList.contains('grounding-review'));
    assert.equal(bar.open, true, 'a cited statement the source does not hold opens the list');
    assert.match(bar.querySelector('summary')?.textContent ?? '', /1 of 3 statements found in your sources/);
    assert.match(bar.textContent ?? '', /general knowledge of the model and were not checked/);
    labels.renderAnswerLabel(el, 'mixed');
    assert.equal(el.querySelector('.message-provenance')?.firstElementChild, labelOf(el), 'the label stays on top');
  });

  it('keeps the list closed when nothing cited is wrong, and needs excerpts to compare', () => {
    const { scope, sources } = register();
    const el = message('The approved budget is 480,000 EUR [Doc: plan.md, Chunk: 1]. Budgets are usually reviewed every quarter.', scope);
    labels.applyMixedMarks(el, { scope, sources });
    const bar = /** @type {HTMLDetailsElement} */ (el.querySelector('.mixed-marks'));
    assert.ok(bar.classList.contains('grounding-partial'));
    assert.equal(bar.open, false);
    assert.equal(labels.applyMixedMarks(message('Text.'), { scope, sources: [] }), null);
  });
});
