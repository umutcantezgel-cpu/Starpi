// The research views in a DOM: a report shows only what the gate releases now (a sentence changed
// in storage is not shown), cites become citation buttons, a released web part shows its text, its
// pages and its search suggestions in the sandboxed frame, a withheld one shows no text at all; the
// Research tab starts jobs with the chosen options and offers cancel and retry by state; the header
// badge counts running jobs.
/* global document, window */
import './setup.mjs';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/research/view.js')} */
let view;
/** @type {typeof import('../../src/js/research/sources-part.js')} */
let sourcesPart;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><header><div><div id="langSwitch"></div></div></header><nav><button id="nav-research">Research</button></nav><div id="host"></div></body></html>', { url: 'http://localhost/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'SVGElement', 'NodeFilter', 'Text', 'MessageEvent', 'Event']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key], configurable: true, writable: true });
  }
  view = await import('../../src/js/research/view.js');
  sourcesPart = await import('../../src/js/research/sources-part.js');
});

const LABEL = '[Doc: hall-plan.md, Chunk: 1]';
const EXCERPT = 'The large room holds 120 people. The hall opened in 1907.';

/** @returns {import('../../src/js/research/jobs.js').ResearchJob} */
function doneJob() {
  const excerpts = [{ label: LABEL, doc: 'hall-plan.md', heading: '', source: /** @type {const} */ ('workspace'), text: EXCERPT, truncated: false, delivered: /** @type {const} */ ('full'), deliveredChars: EXCERPT.length, documentId: 'w1', span: { docId: 'w1', chunkIndex: 0, start: 0, end: EXCERPT.length } }];
  const gated = sourcesPart.gateSources(`## Summary\nThe large room holds 120 people. ${LABEL}\n## Open questions\n- Whether there is parking.`, excerpts, { locale: 'en' });
  const web = 'The hall is listed in the town register.';
  return {
    id: 'job-view-1',
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 1),
    question: 'How big is the hall?',
    origin: 'header',
    status: 'done',
    heartbeatAt: null,
    runner: null,
    provider: { id: 'gemini', model: 'test-model' },
    locale: 'en',
    scope: {},
    options: { web: true, stripPii: false },
    progress: null,
    plan: { queries: ['hall size'] },
    parts: {
      sources: { status: 'done', via: 'byok', provider: { id: 'gemini', model: 'test-model' }, rounds: 1, ...gated, excerpts, fallback: null, check: { supported: 1, weak: 0, unsupported: 0, unchecked: 0 } },
      web: { status: 'done', verdict: 'released', query: 'How big is the hall?', removed: [], text: web, grounding: { segments: [{ start: 0, end: web.length, sources: [0] }], queries: [] }, suggestionsHtml: ['<div>suggestions</div>'], sources: [{ uri: 'https://example.org/register', title: 'Register' }, { uri: 'javascript:alert(1)', title: 'bad' }], rounds: 1, reason: null, provider: { id: 'gemini', model: 'test-model' } },
    },
    artifactId: 'research-job-view-1',
    error: null,
    unread: true,
  };
}

/** A job engine stand-in for the views. */
function fakeJobs(/** @type {import('../../src/js/research/jobs.js').ResearchJob[]} */ initial = []) {
  const jobs = new Map(initial.map((j) => [j.id, j]));
  /** @type {Set<(c: any) => void>} */
  const listeners = new Set();
  /** @type {any[]} */
  const calls = [];
  const api = {
    ready: Promise.resolve(),
    list: () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt),
    get: (/** @type {string} */ id) => jobs.get(id) ?? null,
    running: () => [...jobs.values()].filter((j) => j.status === 'running').length,
    isRunner: () => true,
    /** @param {any} request */
    async start(request) {
      calls.push(['start', request]);
      const id = `new-${calls.length}`;
      jobs.set(id, { ...doneJob(), id, question: request.question, status: 'queued', parts: {}, createdAt: Date.now(), unread: false });
      listeners.forEach((fn) => fn({ type: 'start', id }));
      return id;
    },
    cancel: async (/** @type {string} */ id) => calls.push(['cancel', id]),
    retry: async (/** @type {string} */ id) => calls.push(['retry', id]),
    remove: async (/** @type {string} */ id) => calls.push(['remove', id]),
    markRead: async (/** @type {string} */ id) => calls.push(['read', id]),
    /** @param {(c: any) => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** @param {import('../../src/js/research/jobs.js').ResearchJob} job */
    set(job) {
      jobs.set(job.id, job);
      listeners.forEach((fn) => fn({ type: 'progress', id: job.id }));
    },
  };
  return { jobs: /** @type {any} */ (api), calls, set: api.set };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('research views', () => {
  it('render a report: kept sentences with citation buttons, the web part, its pages and its suggestions frame', () => {
    const host = document.createElement('div');
    const cleanup = view.renderReport(host, doneJob(), { version: '0.0.0-test' });
    const text = host.textContent ?? '';
    assert.ok(text.includes('The large room holds 120 people.'));
    assert.ok(text.includes('Whether there is parking.'));
    assert.ok(text.includes('Written by test-model with your key'));
    assert.ok(text.includes('Source check: 1 supported'));
    assert.ok(!text.includes(LABEL), 'labels become buttons');
    const chips = host.querySelectorAll('button[data-action="open-citation"]');
    assert.ok(chips.length >= 1);
    assert.match(chips[0].textContent ?? '', /hall-plan\.md/);
    assert.ok(text.includes('The hall is listed in the town register.'));
    const frame = host.querySelector('iframe');
    assert.ok(frame, 'the search suggestions show in a frame');
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    assert.ok(!host.innerHTML.includes('<div>suggestions</div>'), 'suggestions never enter the page itself');
    const links = [...host.querySelectorAll('a')];
    assert.deepEqual(links.map((a) => a.getAttribute('href')), ['https://example.org/register']);
    assert.equal(links[0].getAttribute('rel'), 'noopener noreferrer');
    assert.ok(host.querySelector('[data-role="export"]'));
    assert.ok(host.querySelector('[data-action="open-receipt"]'));
    cleanup();
  });

  it('render the web pages and the report actions where URL.parse does not exist (older browsers the build targets)', () => {
    const saved = Object.getOwnPropertyDescriptor(URL, 'parse');
    // @ts-ignore: removed on purpose
    delete URL.parse;
    try {
      const host = document.createElement('div');
      const cleanup = view.renderReport(host, doneJob(), { version: '0.0.0-test' });
      assert.deepEqual([...host.querySelectorAll('a')].map((a) => a.getAttribute('href')), ['https://example.org/register']);
      assert.ok(host.querySelector('[data-role="export"]'));
      assert.ok(host.querySelector('[data-action="open-receipt"]'));
      cleanup();
    } finally {
      if (saved) Object.defineProperty(URL, 'parse', saved);
    }
  });

  it('show nothing the gate would not release now, and no text of a withheld web part', () => {
    const job = doneJob();
    const sources = /** @type {any} */ (job.parts.sources);
    sources.sections.summary[0].text = 'The large room holds 900 people.';
    job.parts.web = { .../** @type {any} */ (job.parts.web), status: 'withheld', verdict: 'withheld', text: null, grounding: null, suggestionsHtml: null, reason: 'web_ungrounded' };
    const host = document.createElement('div');
    view.renderReport(host, job, { version: '0.0.0-test' });
    const text = host.textContent ?? '';
    assert.ok(!text.includes('900'));
    assert.ok(text.includes('The web answer is withheld because it did not pass the check as a whole: a number lies outside every passage the results support.'));
    assert.equal(host.querySelector('iframe'), null);
    assert.ok(host.querySelector('a[href="https://example.org/register"]'), 'the consulted pages stay listed');
  });

  it('start jobs from the tab with the chosen options and offer actions by state', async () => {
    const host = /** @type {HTMLElement} */ (document.getElementById('host'));
    const running = { ...doneJob(), id: 'run-1', status: /** @type {const} */ ('running'), parts: {}, progress: { step: /** @type {const} */ ('web'), round: 2, sources: 5 }, unread: false };
    const { jobs, calls, set } = fakeJobs([running]);
    const tab = view.mountResearchView(host, jobs, { version: '0.0.0-test' });
    await settle();
    const card = /** @type {HTMLElement} */ (host.querySelector('[data-job="run-1"]'));
    assert.match(card.textContent ?? '', /Searching the web · round 2 · 5 sources/);
    const visible = (/** @type {string} */ role) => !(/** @type {HTMLElement} */ (card.querySelector(`[data-role="${role}"]`)).classList.contains('hidden'));
    assert.deepEqual(['open', 'cancel', 'retry'].map(visible), [false, true, false]);
    /** @type {HTMLButtonElement} */ (card.querySelector('[data-role="cancel"]')).click();
    set({ ...running, status: 'stale', progress: null });
    assert.deepEqual(['open', 'cancel', 'retry'].map(visible), [false, false, true]);
    assert.match(card.textContent ?? '', /closed or reloaded/);
    /** @type {HTMLButtonElement} */ (card.querySelector('[data-role="retry"]')).click();

    const form = /** @type {HTMLFormElement} */ (host.querySelector('#researchForm'));
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    assert.equal(host.querySelector('#researchFormStatus')?.textContent, 'Enter a question first.');
    tab.prefill('How big is the hall?', { focus: 'hall-plan.md', origin: 'library' });
    /** @type {HTMLInputElement} */ (host.querySelector('#researchWeb')).checked = true;
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    const started = calls.find((c) => c[0] === 'start');
    assert.deepEqual(started?.[1], { question: 'How big is the hall?', origin: 'library', scope: { focus: 'hall-plan.md' }, options: { web: true, stripPii: true } });
    assert.deepEqual(calls.filter((c) => c[0] !== 'start' && c[0] !== 'read'), [['cancel', 'run-1'], ['retry', 'run-1']]);
    assert.equal(/** @type {HTMLTextAreaElement} */ (host.querySelector('#researchQuestion')).value, '');
    assert.equal(host.querySelectorAll('#researchJobList > li').length, 2);
  });

  it('count running jobs in the header badge and on the navigation entry', () => {
    const { jobs, set } = fakeJobs([]);
    view.mountResearchBadge({ switchTab: () => {} }, jobs);
    const badge = /** @type {HTMLElement} */ (document.getElementById('researchBadge'));
    assert.ok(badge.classList.contains('hidden'));
    set({ ...doneJob(), id: 'b1', status: 'running', parts: {} });
    set({ ...doneJob(), id: 'b2', status: 'running', parts: {} });
    assert.equal(badge.classList.contains('hidden'), false);
    assert.equal(badge.textContent, '2');
    assert.equal(badge.getAttribute('aria-label'), '2 research jobs running');
    const count = /** @type {HTMLElement} */ (document.querySelector('#nav-research .badge'));
    assert.equal(count.textContent, '2');
  });
});
