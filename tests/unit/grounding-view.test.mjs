// The source check on real rendered answers: Markdown -> DOMPurify -> citation buttons -> blocks.
/* global document */
import './setup.mjs';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/rag/grounding-view.js')} */
let view;
/** @type {typeof import('../../src/js/rag/citations.js')} */
let citations;
/** @type {typeof import('../../src/js/render.js')} */
let render;
/** @type {typeof import('../../src/js/synthesizer.js')} */
let synth;
/** @type {typeof import('../../src/js/retrieval.js')} */
let retrieval;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'NodeFilter', 'Text']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key], configurable: true, writable: true });
  }
  render = await import('../../src/js/render.js');
  citations = await import('../../src/js/rag/citations.js');
  view = await import('../../src/js/rag/grounding-view.js');
  synth = await import('../../src/js/synthesizer.js');
  retrieval = await import('../../src/js/retrieval.js');
});

/** @param {string} markdown @param {string | null} scope */
function message(markdown, scope) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="message-content">${render.renderMarkdown(markdown)}</div><div class="message-provenance"></div>`;
  citations.linkifyCitations(/** @type {HTMLElement} */ (el.querySelector('.message-content')), scope);
  document.body.append(el);
  return el;
}

const PLAN = 'Project Nebula launches on 12 May 2027. The approved budget is 480,000 EUR.';
const NOTES = 'The steering group meets every Tuesday at 10:00.';

function register() {
  const hits = [
    { documentId: 'a', documentTitle: 'plan.md', heading: '', content: PLAN, tags: [], rank: 1, workspace: { docId: 'a', chunkIndex: 0, start: 0, end: PLAN.length } },
    { documentId: 'b', documentTitle: 'notes.md', heading: '', content: NOTES, tags: [], rank: 1, workspace: { docId: 'b', chunkIndex: 0, start: 0, end: NOTES.length } },
  ];
  const list = retrieval.assignCitations(hits, { excerptChars: 1600 });
  const scope = /** @type {string} */ (citations.registerCitations(list));
  const sources = list.map((c) => ({ label: c.label, doc: c.doc, heading: c.heading, text: c.text, delivered: /** @type {const} */ ('full') }));
  return { hits, list, scope, sources };
}

describe('source check in the rendered answer', () => {
  it('reads citation buttons, lists and tables into blocks and skips code', () => {
    const { scope, sources } = register();
    const el = message(
      'According to the plan:\n\n- Launch on 12 May 2027 [Doc: plan.md, Chunk: 1]\n- Budget 480,000 EUR\n\n| Item | Value |\n| --- | --- |\n| Budget | 480,000 EUR [Doc: plan.md, Chunk: 1] |\n\n```\n999,999 EUR\n```',
      scope,
    );
    const { blocks } = view.blocksFromElement(/** @type {HTMLElement} */ (el.querySelector('.message-content')), scope, sources);
    assert.deepEqual(blocks.map((b) => b.kind), ['p', 'li', 'li', 'header-row', 'row']);
    assert.equal(blocks[1].leadIn, 0);
    assert.ok(blocks[1].segments.some((s) => s.type === 'cite'));
    assert.ok(blocks[4].segments.some((s) => s.type === 'sep'));
    assert.ok(!blocks.some((b) => b.segments.some((s) => s.type === 'text' && s.text.includes('999,999'))));
  });

  it('shows the summary, lists the flagged statement with its reason and flags only its own button', () => {
    const { scope, sources } = register();
    const el = message('The budget is 520,000 EUR [Doc: plan.md, Chunk: 1]. Nebula launches on 12 May 2027 [Doc: plan.md, Chunk: 1].', scope);
    const report = view.applyGrounding(el, { scope, sources });
    assert.deepEqual(report?.counts, { supported: 1, weak: 0, unsupported: 1, unchecked: 0 });
    const bar = /** @type {HTMLDetailsElement} */ (el.querySelector('.grounding-bar'));
    assert.ok(bar.classList.contains('grounding-review'));
    assert.equal(bar.open, true);
    assert.match(bar.textContent ?? '', /1\/2 statements match/);
    assert.match(bar.textContent ?? '', /520,000 is not in \[Doc: plan\.md, Chunk: 1\]/);
    const buttons = [...el.querySelectorAll('.message-content button[data-action="open-citation"]')];
    assert.deepEqual(buttons.map((b) => b.classList.contains('citation-chip-flag')), [true, false]);
    assert.ok(buttons[0].getAttribute('aria-describedby'));
    assert.ok(el.querySelector(`#${buttons[0].getAttribute('aria-describedby')}`));
  });

  it('lets the items of a loose list inherit the citations of their lead-in', () => {
    const { scope, sources } = register();
    const el = message('The plan says [Doc: plan.md, Chunk: 1]:\n\n- Nebula launches on 12 May 2027\n\n- The approved budget is 480,000 EUR', scope);
    const report = view.applyGrounding(el, { scope, sources });
    assert.deepEqual(report?.counts, { supported: 2, weak: 0, unsupported: 0, unchecked: 0 });
    assert.deepEqual(report?.sentences.filter((s) => s.verdict !== 'neutral').map((s) => s.citeSource), ['leadin', 'leadin']);
  });

  it('shows a neutral bar, not a green one, when nothing could be compared', () => {
    const { scope, sources } = register();
    const el = message('Das Projekt ersetzt den papierbasierten Prozess durch eine mobile App für Fahrer [Doc: plan.md, Chunk: 1].', scope);
    const report = view.applyGrounding(el, { scope, sources });
    assert.equal(report?.counts.unchecked, 1);
    const bar = /** @type {HTMLElement} */ (el.querySelector('.grounding-bar'));
    assert.ok(bar.classList.contains('grounding-none'));
    assert.equal(bar.querySelector('summary [data-lucide]')?.getAttribute('data-lucide'), 'shield');
  });

  it('works without the CSS Custom Highlight API and renders nothing for answers without statements', () => {
    const { scope, sources } = register();
    assert.equal(typeof globalThis.Highlight, 'undefined');
    const el = message('### Hello\n\nThanks!', scope);
    view.applyGrounding(el, { scope, sources });
    assert.equal(el.querySelector('.grounding-bar'), null);
  });

  it('never flags an extractive answer: quoted statements always match their excerpts', () => {
    const { hits, list, scope, sources } = register();
    for (const query of ['When does Project Nebula launch?', 'What is the approved budget?', 'When does the steering group meet?']) {
      const md = synth.synthesizeAnswer({ query, hits, citations: list, knownTitles: [], modelAvailable: false });
      const el = message(md, scope);
      const report = view.applyGrounding(el, { scope, sources, citedOnly: true });
      assert.ok(report && report.counts.supported >= 1, `${query}: ${md}`);
      assert.equal(report.counts.weak + report.counts.unsupported, 0, `${query}: ${JSON.stringify(report.sentences)}`);
    }
  });
});
