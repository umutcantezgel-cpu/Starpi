// Pages of a web search as passages of a grounded answer (src/js/ai/hybrid.js webHits): they are
// web citations, never knowledge base documents. The citation chip and the drawer name them as web
// pages and link the page; the stored sources keep two pages with one title apart.
/* global document, MouseEvent */
import './setup.mjs';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/ai/hybrid.js')} */
let hybrid;
/** @type {typeof import('../../src/js/retrieval.js')} */
let retrieval;
/** @type {typeof import('../../src/js/rag/citations.js')} */
let citations;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;

const MODAL = `
  <div id="citationModal" class="hidden">
    <button type="button" data-action="close-citation">x</button>
    <p><span id="citationModalDoc"></span> · <span id="citationModalSource"></span></p>
    <span id="citationModalChunkIdx"></span><span id="citationModalScoreLabel"></span><span id="citationModalScore"></span><span id="citationModalOffsets"></span>
    <div><div id="citationModalContent"></div><p id="citationModalNote"></p></div>
  </div>`;

before(async () => {
  const page = new JSDOM(`<!doctype html><html><body>${MODAL}</body></html>`, { url: 'https://app.example/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'NodeFilter', 'Text', 'Event', 'MouseEvent', 'localStorage']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? page.window : key === 'document' ? page.window.document : /** @type {any} */ (page.window)[key], configurable: true, writable: true });
  }
  hybrid = await import('../../src/js/ai/hybrid.js');
  retrieval = await import('../../src/js/retrieval.js');
  citations = await import('../../src/js/rag/citations.js');
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  citations.initCitations();
});

const answer = {
  text: 'Trains run every ten minutes. Tickets cost less on weekends.',
  segments: [
    { start: 0, end: 29, sources: [0] },
    { start: 30, end: 60, sources: [1] },
  ],
  sources: [
    { uri: 'https://transit.example/timetable', title: 'Timetable' },
    { uri: 'https://fares.example/weekend', title: 'Timetable' },
  ],
  queries: [],
  suggestionsHtml: null,
};

describe('web passages', () => {
  it('become web citations with the page address, not library documents', () => {
    const hits = hybrid.webHits(answer);
    assert.deepEqual(
      hits.map((h) => [h.documentId, h.web?.url]),
      [
        [null, 'https://transit.example/timetable'],
        [null, 'https://fares.example/weekend'],
      ],
    );
    const list = retrieval.assignCitations(hits, { excerptChars: 1600 });
    assert.deepEqual(
      list.map((c) => [c.source, c.url, c.documentId]),
      [
        ['web', 'https://transit.example/timetable', null],
        ['web', 'https://fares.example/weekend', null],
      ],
    );
    assert.equal(retrieval.distinctSources(hits).length, 2, 'two pages with one title stay two sources');
    const library = retrieval.assignCitations([{ documentId: 'd1', documentTitle: 'Guide', heading: '', content: 'x', tags: [], rank: 1 }], { excerptChars: 100 });
    assert.deepEqual([library[0].source, 'url' in library[0]], ['knowledge', false]);
  });

  it('show as web pages in the chip and the drawer, with a link to the page', () => {
    const list = retrieval.assignCitations(hybrid.webHits(answer), { excerptChars: 1600 });
    const scope = /** @type {string} */ (citations.registerCitations(list));
    const chip = citations.citationButton(scope, 1, 'badge');
    assert.ok(chip.querySelector('[data-lucide="globe"], svg.lucide-globe'), 'the chip has the globe icon');
    document.body.append(chip);
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.equal(document.getElementById('citationModalSource')?.dataset.i18n, 'citation.source_web');
    assert.equal(document.getElementById('citationModalNote')?.dataset.i18n, 'citation.note_web');
    const links = document.querySelectorAll('#citationModal .citation-page-link a');
    assert.equal(links.length, 1);
    const link = /** @type {HTMLAnchorElement} */ (links[0]);
    assert.deepEqual([link.href, link.target, link.rel], ['https://fares.example/weekend', '_blank', 'noopener noreferrer']);
    assert.match(link.textContent ?? '', /fares\.example/);

    // A library citation opened next shows no page link.
    const libraryScope = /** @type {string} */ (citations.registerCitations(retrieval.assignCitations([{ documentId: 'd1', documentTitle: 'Guide', heading: '', content: 'x', tags: [], rank: 1 }], { excerptChars: 100 })));
    const other = citations.citationButton(libraryScope, 0, 'badge');
    document.body.append(other);
    other.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.equal(document.getElementById('citationModalSource')?.dataset.i18n, 'citation.source_knowledge');
    assert.equal(document.querySelectorAll('#citationModal .citation-page-link').length, 0);
  });
});
