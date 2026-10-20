// The council panel follows a run: placeholder cards first, then one card per member with its state,
// the judge with its reasons, and the result with how it was decided. The status line is one live
// region whose text changes; an opened draft stays open across updates; times use the local zone.
/* global document */
import './setup.mjs';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/ui/council-panel.js')} */
let panel;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'NodeFilter', 'Text']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key], configurable: true, writable: true });
  }
  panel = await import('../../src/js/ui/council-panel.js');
});

/** @typedef {import('../../src/js/ai/council.js').CouncilResult} CouncilResult */
/** @typedef {import('../../src/js/ai/council.js').CouncilPhase} CouncilPhase */

/** A run the test drives by hand: push(snapshot, phase), then finish(result) or fail(err). */
function manualRun() {
  /** @type {Set<(r: CouncilResult, p: CouncilPhase) => void>} */
  const listeners = new Set();
  /** @type {(r: CouncilResult) => void} */
  let resolve = () => {};
  /** @type {(e: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const run = Object.assign(promise, {
    /** @param {(r: CouncilResult, p: CouncilPhase) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  return {
    run: /** @type {Promise<CouncilResult> & { subscribe: typeof run.subscribe }} */ (run),
    /** @param {CouncilResult} r @param {CouncilPhase} p */
    push: (r, p) => listeners.forEach((fn) => fn(r, p)),
    finish: resolve,
    fail: reject,
  };
}

/** @param {Partial<CouncilResult>} over @returns {CouncilResult} */
const result = (over) => ({ mode: 'free', purpose: null, members: [], judge: null, output: null, decidedBy: 'none', validCount: 0, startedAt: 1_700_000_000_000, ...over });

const settle = () => new Promise((r) => setTimeout(r, 0));

/** @param {string} id */
function host(id) {
  const el = document.createElement('div');
  el.id = id;
  document.body.append(el);
  return el;
}

describe('council panel', () => {
  it('fills while the run goes and ends with the judge and the result', async () => {
    const el = host('p1');
    const { run, push, finish } = manualRun();
    /** @type {CouncilResult | null} */
    let done = null;
    panel.renderCouncilPanel(el, run, { onDone: (r) => (done = r) });
    assert.equal(el.querySelectorAll('[data-member]').length, 3, 'three placeholder cards');
    const status = /** @type {HTMLElement} */ (el.querySelector('[role="status"]'));
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.match(status.textContent ?? '', /starting/);

    const pending = result({ members: [{ provider: 'openai', model: 'gpt-5-mini', status: 'pending' }, { provider: 'anthropic', model: 'claude-sonnet-5-5', status: 'pending', thinking: true }] });
    push(pending, 'members');
    assert.equal(el.querySelectorAll('[data-member]').length, 2);
    assert.ok(el.querySelector('[data-member="1"] [data-member-thinking]'));
    assert.match(status.textContent ?? '', /0 of 2/);

    const drafted = result({
      members: [
        { provider: 'openai', model: 'gpt-5-mini', status: 'ok', text: 'Light becomes sugar.', latencyMs: 1500 },
        { provider: 'anthropic', model: 'claude-sonnet-5-5', status: 'invalid', errors: ['schema:$.summary:minLength', 'truncated'], latencyMs: 300 },
      ],
      validCount: 1,
    });
    push(drafted, 'members');
    assert.equal(el.querySelector('[role="status"]'), status, 'the live region stays the same element');
    assert.match(status.textContent ?? '', /2 of 2/);
    const card0 = /** @type {HTMLElement} */ (el.querySelector('[data-member="0"]'));
    assert.equal(card0.dataset.status, 'ok');
    assert.match(card0.textContent ?? '', /1\.5 s/);
    const rejected = el.querySelector('[data-member="1"]')?.textContent ?? '';
    assert.match(rejected, /did not have the expected shape/);
    assert.match(rejected, /length limit/);

    // Open the draft, then update: the card is unchanged and stays open.
    const details = /** @type {HTMLDetailsElement} */ (el.querySelector('details[data-draft="0"]'));
    details.open = true;
    push({ ...drafted, judge: { provider: 'openai', model: 'gpt-5', status: 'pending', chosen: null, reasons: [], merged: false } }, 'judge');
    assert.equal(el.querySelector('details[data-draft="0"]'), details);
    assert.ok(details.open);
    assert.equal(el.querySelector('[data-judge]')?.getAttribute('data-status'), 'pending');

    const final = result({
      ...drafted,
      members: [drafted.members[0], { provider: 'anthropic', model: 'claude-sonnet-5-5', status: 'ok', text: 'Plants <b>make</b> food.' }],
      validCount: 2,
      judge: { provider: 'openai', model: 'gpt-5', status: 'ok', chosen: 1, reasons: ['More precise.'], merged: false },
      output: { text: 'Plants <b>make</b> food.' },
      decidedBy: 'judge',
      bestIndex: 1,
      finishedAt: Date.UTC(2026, 9, 17, 12, 30),
    });
    finish(final);
    await settle();
    assert.equal(done, final);
    assert.equal(el.querySelector('[data-council-phase]')?.getAttribute('data-council-phase'), 'done');
    assert.match(status.textContent ?? '', /chose a draft/);
    assert.ok(el.querySelector('[data-member="1"] [data-chosen]'), 'the chosen draft is marked');
    assert.deepEqual([...el.querySelectorAll('[data-reasons] li')].map((li) => li.textContent), ['More precise.']);
    assert.match(el.querySelector('[data-judge]')?.textContent ?? '', /Chose Draft 2/);
    const out = /** @type {HTMLElement} */ (el.querySelector('[data-result]'));
    assert.equal(out.dataset.decidedBy, 'judge');
    assert.equal(out.querySelector('b'), null, 'model text is escaped');
    assert.match(out.textContent ?? '', /2 of 2 drafts valid/);
    const expected = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(Date.UTC(2026, 9, 17, 12, 30)));
    assert.ok((out.textContent ?? '').includes(expected), 'the finish time is shown in the local time zone');
  });

  it('says why the best draft stands, marks it, and shows JSON as JSON', async () => {
    const el = host('p2');
    const { run, finish } = manualRun();
    panel.renderCouncilPanel(el, run, { showDrafts: false });
    finish(
      result({
        mode: 'purpose',
        purpose: 'research_brief',
        members: [{ provider: 'openai', model: 'gpt-5-mini', status: 'ok', value: { summary: 'Old bridge.' }, text: '{"summary":"Old bridge."}' }],
        validCount: 1,
        output: { value: { summary: 'Old bridge.' } },
        decidedBy: 'best',
        bestIndex: 0,
        fallbackReason: 'one_valid_draft',
      }),
    );
    await settle();
    assert.match(el.querySelector('[data-judge="none"]')?.textContent ?? '', /no judge was needed/);
    assert.ok(el.querySelector('[data-member="0"] [data-used]'));
    assert.equal(el.querySelector('details[data-draft]'), null, 'drafts hidden on request');
    assert.match(el.querySelector('[data-output] pre')?.textContent ?? '', /"summary": "Old bridge."/);
  });

  it('shows a stopped run, and a newer run owns the container', async () => {
    const el = host('p3');
    const first = manualRun();
    panel.renderCouncilPanel(el, first.run);
    const second = manualRun();
    panel.renderCouncilPanel(el, second.run);
    first.finish(result({ decidedBy: 'best', members: [{ provider: 'openai', model: 'old', status: 'ok', text: 'old' }] }));
    await settle();
    assert.equal(el.querySelector('[data-council-phase]')?.getAttribute('data-council-phase'), 'start', 'the older run does not draw');
    second.fail(new DOMException('stopped', 'AbortError'));
    await settle();
    assert.match(el.querySelector('[role="status"]')?.textContent ?? '', /stopped/);
  });

  it('words rejection codes of every kind', () => {
    assert.deepEqual(panel.rejectionLabel('schema:$.x:type'), { key: 'ai-orchestration.council.error.schema', params: { detail: '$.x:type' } });
    assert.equal(panel.rejectionLabel('rate_limited'), 'ai.error.rate_limited');
    assert.equal(panel.rejectionLabel('circuit_open'), 'ai-orchestration.blocked.circuit_open');
    assert.deepEqual(panel.rejectionLabel('weird_code'), { key: 'ai-orchestration.council.error.other', params: { code: 'weird_code' } });
  });
});
