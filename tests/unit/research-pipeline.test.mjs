// The research pipeline with fake models, a fake research step and fake document search (no
// network): the web query (as typed, optional removal of personal details), the read-only source
// tools, the tool loop with a person's key and the signed loop on the site's pool (short hints,
// waiting out the site's per-minute limit), the sentence gate
// in sources mode with [Doc: …, Chunk: n] cites, the quote without a model, web answers in one shape
// judged as a whole (an ungrounded web part is withheld and keeps no text), the report stored as an
// artifact and the v3 receipt of the documents part.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReceipt, RECEIPT_SCHEMA, validateReceipt } from '../../src/js/core/receipt.js';
import { receiptDraft, reportMarkdown, runResearch } from '../../src/js/research/deep.js';
import { MAX_TOOL_ROUNDS, promptMarker, sectionOfHeading, SOURCE_TOOL_NAMES, sourcesPrompt } from '../../src/js/research/prompts.js';
import { purposeMarker } from '../../src/js/ai/purposes.js';
import { createSourceTools, gateSources, loopFocus, loopHints, patientStep, quoteExcerpts, RATE_WAIT_MAX_S, recheckSources, runSignedLoop, runToolLoop } from '../../src/js/research/sources-part.js';
import { judgeWeb, mergeWebAnswers, recheckWeb, runWebPart, webAnswerFromResult, webAnswerFromStep } from '../../src/js/research/web-part.js';
import { webQuery } from '../../src/js/research/web-query.js';

/** @typedef {import('../../src/js/supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {import('../../src/js/ai/index.js').CompletionResult} CompletionResult */

const PLAN_TEXT = 'The community hall has 3 rooms. The large room holds 120 people. The hall opened in 1907 after two years of work. Bookings are made at the front desk on weekdays.';
const RULES_TEXT = 'Rooms must be booked 14 days ahead. Each booking covers 4 hours per evening. Cancellations are free until 7 days before the date.';

/** @type {KnowledgeHit[]} */
const HITS = [
  { documentId: 'w1', documentTitle: 'hall-plan.md', heading: '', content: PLAN_TEXT, tags: [], rank: 2, workspace: { docId: 'w1', chunkIndex: 0, start: 0, end: PLAN_TEXT.length } },
  { documentId: 'lib-7', documentTitle: 'Booking rules', heading: '## Prices', content: RULES_TEXT, tags: [], rank: 0.5 },
];

/** Backends over the fixed hits: a hit matches when it shares a word with the query. */
function backends() {
  /** @type {string[]} */
  const queries = [];
  return {
    queries,
    /** @param {string} query @param {number} k */
    async search(query, k) {
      queries.push(query);
      const words = query.toLowerCase().match(/\p{L}+/gu) ?? [];
      return HITS.filter((h) => words.some((w) => w.length > 3 && h.content.toLowerCase().includes(w))).slice(0, k);
    },
    async documents() {
      return ['hall-plan.md', 'Booking rules'];
    },
  };
}

const PLAN_LABEL = '[Doc: hall-plan.md, Chunk: 1]';
const RULES_LABEL = '[Doc: Booking rules, Chunk: 1]';

/**
 * A CompletionResult.
 * @param {Partial<CompletionResult>} fields
 * @returns {CompletionResult}
 */
function result(fields) {
  return { text: '', reasoning: '', reasoningTokens: 0, toolCalls: [], citations: [], images: [], opaque: [], stopReason: 'end_turn', provider: 'gemini', model: 'test-model', requestId: null, usage: null, error: null, ...fields };
}

/**
 * A fake AI layer: answers each call with the next scripted result and records the requests.
 * @param {Array<Partial<CompletionResult> | ((req: any) => Partial<CompletionResult>)>} script
 */
function fakeComplete(script) {
  /** @type {any[]} */
  const requests = [];
  const complete = (/** @type {any} */ req) => {
    requests.push(structuredClone(req));
    const next = script.shift();
    if (!next) throw new Error('no scripted answer left');
    return { result: Promise.resolve(result(typeof next === 'function' ? next(req) : next)) };
  };
  return { complete, requests };
}

describe('research: web query', () => {
  it('sends the question as typed, tidied and capped', () => {
    assert.deepEqual(webQuery('  How old is   the hall?\n'), { text: 'How old is the hall?', removed: [] });
    assert.equal(webQuery('x'.repeat(2500)).text.length, 2000);
    const raw = 'Write to anna@example.org or call +49 30 1234567 about the hall.';
    assert.equal(webQuery(raw).text, raw, 'nothing is removed unless asked');
  });

  it('removes personal details on request and names only their kinds', () => {
    const q = webQuery('Mail anna.berg@example.org, call 030 1234567 or +44 20 7946 0958; IBAN DE89 3704 0044 0532 0130 00, card 4111 1111 1111 1111, host 192.168.1.20. Is the hall from 1907, 120 m long, open on 03.03.2026, ISO 9001?', { stripPii: true });
    assert.deepEqual(q.removed, ['email', 'iban', 'card', 'ip', 'phone']);
    for (const gone of ['anna.berg', '1234567', '7946', 'DE89', '4111', '192.168']) assert.ok(!q.text.includes(gone), gone);
    for (const kept of ['1907', '120 m', '03.03.2026', 'ISO 9001']) assert.ok(q.text.includes(kept), kept);
    assert.deepEqual(webQuery('A card-like run 1234 5678 9012 3456 that fails the check.', { stripPii: true }).removed, []);
  });

  it('leaves a list of decimals alone, while phone numbers written with dots still go', () => {
    assert.deepEqual(webQuery('compare 0.5 0.25 0.125 mg doses', { stripPii: true }), { text: 'compare 0.5 0.25 0.125 mg doses', removed: [] });
    assert.deepEqual(webQuery('Vergleich 0,5 0,25 0,125 mg', { stripPii: true }).removed, []);
    assert.deepEqual(webQuery('ring 030.1234.5678 today', { stripPii: true }), { text: 'ring today', removed: ['phone'] });
  });
});

describe('research: source tools', () => {
  it('search, read and list only, with stable labels and previews', async () => {
    const tools = createSourceTools(backends());
    assert.deepEqual(tools.specs.map((s) => s.name), [...SOURCE_TOOL_NAMES]);
    assert.ok(tools.specs.every((s) => s.sideEffects === false));
    const found = JSON.parse((await tools.call('search_sources', { query: 'hall rooms booked', k: 5 })).content);
    assert.deepEqual(found.excerpts.map((/** @type {any} */ e) => e.label), [PLAN_LABEL, RULES_LABEL]);
    assert.equal(found.excerpts[1].heading, 'Prices');
    const again = JSON.parse((await tools.call('search_sources', { query: 'hall booked' })).content);
    assert.deepEqual(again.excerpts.map((/** @type {any} */ e) => e.label), [PLAN_LABEL, RULES_LABEL], 'the same hits keep their labels');
    const read = await tools.call('read_excerpt', { label: RULES_LABEL });
    assert.equal(read.isError, false);
    assert.equal(JSON.parse(read.content).text, RULES_TEXT);
    assert.equal(tools.excerpts().find((e) => e.label === RULES_LABEL)?.delivered, 'full');
    assert.equal((await tools.call('read_excerpt', { label: '[Doc: secret.md, Chunk: 9]' })).isError, true);
    assert.deepEqual(JSON.parse((await tools.call('list_documents', {})).content), { documents: ['hall-plan.md', 'Booking rules'] });
    const forbidden = await tools.call('delete_document', { name: 'hall-plan.md' });
    assert.equal(forbidden.isError, true);
    assert.match(forbidden.content, /only search_sources, read_excerpt and list_documents/);
    assert.equal((await tools.call('search_sources', {})).isError, true);
    const nothing = JSON.parse((await tools.call('search_sources', { query: 'zebra' })).content);
    assert.deepEqual(nothing.excerpts, []);
  });

  it('shows a preview of a long excerpt and puts the focused document first', async () => {
    const long = { ...HITS[0], content: `${PLAN_TEXT} ${'More text about the hall. '.repeat(60)}` };
    const tools = createSourceTools({ search: async () => [HITS[1], long], documents: async () => [] }, { focus: 'hall-plan.md' });
    const found = JSON.parse((await tools.call('search_sources', { query: 'hall' })).content);
    assert.equal(found.excerpts[0].label, PLAN_LABEL);
    assert.equal(found.excerpts[0].complete, false);
    assert.ok(found.excerpts[0].text.length <= 700);
    const excerpt = tools.excerpts()[0];
    assert.equal(excerpt.delivered, 'partial');
    assert.equal(excerpt.deliveredChars, 700);
  });
});

describe('research: sources part', () => {
  it('gates the answer in sources mode: a number needs a cited excerpt that states it', async () => {
    const tools = createSourceTools(backends());
    await tools.call('search_sources', { query: 'hall rooms booked' });
    await tools.call('read_excerpt', { label: RULES_LABEL });
    const answer = [
      '## Summary',
      `The hall has 3 rooms. ${PLAN_LABEL} The large room holds 150 people. ${PLAN_LABEL}`,
      '## Details',
      `- Each booking covers 4 hours per evening ${RULES_LABEL}`,
      '- Rooms are booked 14 days ahead.',
      '- Bookings are made at the front desk.',
      '## Open questions',
      '- Whether the hall has parking.',
    ].join('\n');
    const gated = gateSources(answer, tools.excerpts(), { question: 'What does the hall offer?', locale: 'en' });
    assert.deepEqual(gated.sections.summary.map((s) => s.text), ['The hall has 3 rooms.']);
    assert.deepEqual(gated.sections.summary[0].cites, [PLAN_LABEL]);
    assert.deepEqual(gated.sections.details.map((s) => s.text), ['Each booking covers 4 hours per evening', 'Bookings are made at the front desk.']);
    assert.deepEqual(gated.sections.open_questions.map((s) => s.text), ['Whether the hall has parking.']);
    assert.equal(gated.withheld, 2, 'the wrong number and the uncited number are withheld');
    assert.deepEqual(gated.cited, [PLAN_LABEL, RULES_LABEL]);
    assert.equal(gated.released, 4);
  });

  it('checks a stored part again: a changed number in storage is not shown', async () => {
    const tools = createSourceTools(backends());
    await tools.call('search_sources', { query: 'hall rooms' });
    const gated = gateSources(`## Summary\nThe hall has 3 rooms. ${PLAN_LABEL}`, tools.excerpts(), { locale: 'en' });
    const part = { sections: structuredClone(gated.sections), excerpts: tools.excerpts() };
    assert.equal(recheckSources(part, { locale: 'en' }).released, 1);
    part.sections.summary[0].text = 'The hall has 9 rooms.';
    const again = recheckSources(part, { locale: 'en' });
    assert.equal(again.released, 0);
    assert.equal(again.withheld, 1);
  });

  it('runs the tool loop with a key: tools until the model answers, none after the last round', async () => {
    const tools = createSourceTools(backends());
    const { complete, requests } = fakeComplete([
      { toolCalls: [{ id: 'c1', name: 'search_sources', args: { query: 'hall rooms' }, argsText: '' }], stopReason: 'tool_call', opaque: [{ type: 'opaque', provider: 'gemini', model: 'test-model', block: { kind: 'gemini-parts', parts: [] } }] },
      { toolCalls: [{ id: 'c2', name: 'read_excerpt', args: { label: PLAN_LABEL }, argsText: '' }], stopReason: 'tool_call' },
      { text: `## Summary\nThe hall has 3 rooms. ${PLAN_LABEL}` },
    ]);
    /** @type {number[]} */
    const rounds = [];
    const out = await runToolLoop({ complete, provider: 'gemini', model: 'test-model', locale: 'en', question: 'How many rooms?', tools, hints: ['hall rooms'], onRound: (r) => rounds.push(r) });
    assert.equal(out.rounds, 2);
    assert.deepEqual(rounds, [1, 2]);
    assert.equal(requests[0].system, sourcesPrompt('en', { rounds: MAX_TOOL_ROUNDS, hints: ['hall rooms'], focus: undefined }));
    assert.equal(requests[0].toolChoice, 'auto');
    assert.deepEqual(requests[0].tools.map((/** @type {any} */ t) => t.name), [...SOURCE_TOOL_NAMES]);
    const second = requests[1].messages;
    assert.deepEqual(second[1].content.map((/** @type {any} */ p) => p.type), ['tool_call', 'opaque']);
    assert.equal(second[2].role, 'tool');
    assert.equal(second[2].content[0].id, 'c1');
    assert.match(second[2].content[0].content, /hall-plan\.md/);

    const endless = fakeComplete(Array.from({ length: 3 }, () => (/** @type {any} */ req) => (req.toolChoice === 'none' ? { text: 'Final.' } : { toolCalls: [{ id: 'x', name: 'list_documents', args: {}, argsText: '{}' }] })));
    const capped = await runToolLoop({ complete: endless.complete, provider: 'gemini', model: 'm', locale: 'de', question: 'Q?', tools: createSourceTools(backends()), maxRounds: 2 });
    assert.equal(capped.text, 'Final.');
    assert.deepEqual(endless.requests.map((r) => r.toolChoice), ['auto', 'auto', 'none']);
  });

  it('runs the signed loop on the pool: turns go back unchanged with the results', async () => {
    const tools = createSourceTools(backends());
    /** @type {any[]} */
    const bodies = [];
    const turn = { role: 'model', parts: [{ functionCall: { name: 'search_sources', args: { query: 'hall' } }, thoughtSignature: 'sig-state' }] };
    /** @type {import('../../src/js/research/sources-part.js').StepFn} */
    const step = async (body) => {
      bodies.push(structuredClone(body));
      if (bodies.length === 1) return { status: 'tool_calls', round: 1, model: 'gemini-2.5-flash', calls: [{ name: 'search_sources', args: { query: 'hall' } }, { name: 'drop_table', args: {} }], turn, sig: 'S'.repeat(43) };
      return { status: 'final', round: 2, model: 'gemini-2.5-flash', text: `The hall has 3 rooms. ${PLAN_LABEL}` };
    };
    const out = await runSignedLoop({ step, locale: 'en', question: 'Rooms?', tools, hints: ['a', 'b', 'c', 'd', 'e'] });
    assert.deepEqual({ rounds: out.rounds, provider: out.provider, model: out.model }, { rounds: 1, provider: 'gemini', model: 'gemini-2.5-flash' });
    assert.deepEqual(bodies[0], { part: 'sources', question: 'Rooms?', locale: 'en', history: [], hints: ['a', 'b', 'c', 'd'], focus: null });
    assert.deepEqual(bodies[1].history[0], { turn, sig: 'S'.repeat(43) });
    const results = bodies[1].history[1].results;
    assert.equal(results[0].name, 'search_sources');
    assert.match(results[0].content, /hall-plan\.md/);
    assert.match(results[1].content, /unknown tool/, 'a tool this side does not run is answered as an error');
  });

  it('sends the plan as short hints without the question, and a long document name cut', () => {
    const question = 'How many rooms does the hall have?';
    assert.deepEqual(loopHints([question], question), []);
    assert.deepEqual(loopHints([` ${question.toUpperCase()} `, 'hall  rooms', 'Hall rooms', '', 'y'.repeat(250), 'a', 'b', 'c'], question), ['hall rooms', 'y'.repeat(200), 'a', 'b']);
    assert.equal(loopHints([`${'z'.repeat(199)}\u{1F600}`], question)[0], 'z'.repeat(199), 'no half of a character pair is sent');
    assert.equal(loopFocus('  '), null);
    assert.equal(loopFocus(null), null);
    assert.equal(loopFocus(`${'d'.repeat(320)}.md`), 'd'.repeat(300));
  });

  it("waits out the site's per-minute limit a few times; other refusals and a cancel end at once", async () => {
    const refusal = (/** @type {string} */ code, /** @type {number | null} */ retryAfterS) => Object.assign(new Error(code), { code, retryAfterS });
    const final = /** @type {const} */ ({ status: 'final', round: 1, model: 'm', text: 'ok' });
    /** @param {unknown[]} script */
    const scripted = (script) => {
      let n = 0;
      return {
        calls: () => n,
        /** @type {import('../../src/js/research/sources-part.js').StepFn} */
        step: async () => {
          const next = script[n++];
          if (next instanceof Error) throw next;
          return /** @type {any} */ (next);
        },
      };
    };
    /** @type {number[]} */
    const waits = [];
    const wait = async (/** @type {number} */ ms) => void waits.push(ms);

    const busy = scripted([refusal('rate_limited', 12), refusal('rate_limited', 2.2), final]);
    assert.deepEqual(await patientStep(busy.step, { wait })({}), final);
    assert.deepEqual(waits, [12_000, 3_000]);

    for (const [err, calls] of /** @type {Array<[Error, number]>} */ ([
      [refusal('daily_limit_reached', 3600), 1],
      [refusal('rate_limited', RATE_WAIT_MAX_S + 1), 1],
      [refusal('rate_limited', null), 1],
      [refusal('upstream_busy', 5), 1],
    ])) {
      const s = scripted([err, final]);
      await assert.rejects(patientStep(s.step, { wait })({}), (e) => e === err);
      assert.equal(s.calls(), calls);
    }
    const always = scripted([refusal('rate_limited', 1), refusal('rate_limited', 1), refusal('rate_limited', 1), final]);
    await assert.rejects(patientStep(always.step, { wait, tries: 3 })({}), /rate_limited/);
    assert.equal(always.calls(), 3);

    // The real wait ends with the job's signal.
    const ctrl = new AbortController();
    const pending = patientStep(scripted([refusal('rate_limited', 30), final]).step)({}, ctrl.signal);
    setTimeout(() => ctrl.abort(new DOMException('Cancelled', 'AbortError')), 5);
    await assert.rejects(pending, (e) => e instanceof DOMException && e.name === 'AbortError');
  });

  it('quotes the best sentences without a model, and the gate keeps them', async () => {
    const tools = createSourceTools(backends());
    const text = await quoteExcerpts({ question: 'How many rooms does the hall have and how many hours does a booking cover?', tools, locale: 'en' });
    assert.match(text, /^## Summary\n/);
    assert.ok(text.includes(PLAN_LABEL) && text.includes(RULES_LABEL));
    const gated = gateSources(text, tools.excerpts(), { locale: 'en' });
    assert.equal(gated.withheld, 0);
    assert.ok(gated.released >= 2);
    assert.equal(await quoteExcerpts({ question: 'zebra', tools: createSourceTools(backends()), locale: 'en' }), '');
  });

  it('names sections in both languages and marks prompts for the fakes', () => {
    assert.equal(sectionOfHeading('Offene Fragen'), 'open_questions');
    assert.equal(sectionOfHeading('**Summary:**'), 'summary');
    assert.equal(sectionOfHeading('Background'), null);
    assert.equal(promptMarker('research_web'), purposeMarker('research_web'));
  });
});

describe('research: web part', () => {
  const GROUNDED = 'The bridge is 120 m long. It opened in 1907.';
  const answer = (/** @type {Partial<import('../../src/js/research/web-part.js').WebAnswer>} */ over = {}) => ({
    text: GROUNDED,
    segments: [{ start: 0, end: GROUNDED.length, sources: [0] }],
    sources: [{ uri: 'https://example.org/bridge', title: 'Bridge facts' }],
    queries: ['bridge length'],
    suggestionsHtml: '<div>suggestions</div>',
    ...over,
  });

  it('brings answers of every provider into one shape', () => {
    const a = webAnswerFromResult(
      result({
        text: GROUNDED,
        citations: [
          { url: 'https://example.org/bridge', title: 'Bridge facts', start: 0, end: 26 },
          { url: 'https://example.com/history', title: 'History', start: 27, end: GROUNDED.length },
          { url: 'https://example.org/bridge', title: 'Bridge facts', start: 27, end: GROUNDED.length },
          { url: 'javascript:alert(1)', title: 'bad' },
        ],
        opaque: [{ type: 'opaque', provider: 'gemini', model: 'm', block: { kind: 'gemini-grounding', searchEntryPoint: '<div>s</div>', queries: ['bridge'] } }],
      }),
    );
    assert.deepEqual(a.sources.map((s) => s.uri), ['https://example.org/bridge', 'https://example.com/history']);
    assert.deepEqual(a.segments, [
      { start: 0, end: 26, sources: [0] },
      { start: 27, end: GROUNDED.length, sources: [1, 0] },
    ]);
    assert.deepEqual(a.queries, ['bridge']);
    assert.equal(a.suggestionsHtml, '<div>s</div>');
    const fromStep = webAnswerFromStep({ text: GROUNDED, grounding: { segments: [{ start: 0, end: 999, sources: [0] }, { start: 0, end: 5, sources: [0, 7] }], sources: [{ uri: 'https://example.org', title: 't' }, { uri: 'file:///etc/passwd' }], queries: ['q'], suggestionsHtml: ' ' } });
    assert.deepEqual(fromStep.segments, [{ start: 0, end: 5, sources: [0] }]);
    assert.equal(fromStep.sources.length, 1);
    assert.equal(fromStep.suggestionsHtml, null);
  });

  it('releases a grounded answer as a whole and withholds an ungrounded one entirely', () => {
    assert.deepEqual(judgeWeb(answer(), { locale: 'en' }), { verdict: 'released', reason: null, released: 2, withheld: 0 });
    const half = judgeWeb(answer({ segments: [{ start: 0, end: 26, sources: [0] }] }), { locale: 'en' });
    assert.equal(half.verdict, 'withheld');
    assert.equal(half.reason, 'web_ungrounded');
    assert.equal(half.released, 1, 'one good sentence does not save the part');
    assert.equal(judgeWeb(answer({ sources: [] }), {}).reason, 'no_sources');
    assert.equal(judgeWeb(answer({ text: ' ' }), {}).reason, 'empty');
  });

  it('joins rounds with moved offsets and merged sources', () => {
    const second = 'The second text has 2 lanes.';
    const merged = mergeWebAnswers([answer(), answer({ text: second, segments: [{ start: 0, end: second.length, sources: [1] }], sources: [{ uri: 'https://example.com/x', title: 'x' }, { uri: 'https://example.org/lanes', title: 'Lanes' }], suggestionsHtml: '<div>two</div>' })], 2);
    assert.equal(merged.text, `${GROUNDED}\n\n${second}`);
    assert.deepEqual(merged.sources.map((s) => s.uri), ['https://example.org/bridge', 'https://example.com/x']);
    assert.deepEqual(merged.segments.map((s) => [s.start, s.end]), [[0, GROUNDED.length]], 'a segment whose source is past the cap grounds nothing');
    assert.deepEqual(merged.suggestions, ['<div>suggestions</div>', '<div>two</div>']);
  });

  it('runs up to four rounds, the question as typed first, and keeps no text of a withheld part', async () => {
    /** @type {string[]} */
    const asked = [];
    const part = await runWebPart({
      search: async (q) => {
        asked.push(q);
        return q === 'q2' ? answer({ text: 'Unsupported: it has 99 arches.', segments: [] }) : answer();
      },
      query: 'How long is the bridge?',
      queries: ['How long is the bridge?', 'q1', 'q2', 'q3', 'q4'],
      locale: 'en',
      provider: { id: 'gemini', model: 'm' },
    });
    assert.deepEqual(asked, ['How long is the bridge?', 'q1', 'q2', 'q3']);
    assert.equal(part.status, 'withheld');
    assert.equal(part.reason, 'web_ungrounded');
    assert.equal(part.text, null);
    assert.equal(part.suggestionsHtml, null);
    assert.equal(part.grounding, null);
    assert.deepEqual(part.sources.map((s) => s.uri), ['https://example.org/bridge']);
    const released = await runWebPart({ search: async () => answer(), query: 'Bridge?', locale: 'en', provider: null });
    assert.equal(released.status, 'done');
    assert.equal(released.text, GROUNDED);
    assert.deepEqual(released.suggestionsHtml, ['<div>suggestions</div>']);
    assert.equal(recheckWeb(released).status, 'done');
    const tampered = { ...released, text: `${released.text} It has 99 arches.` };
    assert.equal(recheckWeb(tampered).status, 'withheld');
    assert.equal(recheckWeb(tampered).text, null);
  });
});

describe('research: pipeline', () => {
  const at = Date.UTC(2026, 9, 1, 9, 30);
  /**
   * @param {import('../../src/js/research/deep.js').ResearchRoutes} routes
   * @param {{ complete?: any, step?: any }} over
   */
  function runtime(routes, over = {}) {
    /** @type {any[]} */
    const artifacts = [];
    return {
      artifacts,
      runtime: {
        complete: over.complete ?? (() => assert.fail('no model call expected')),
        step: over.step ?? (async () => assert.fail('no step expected')),
        backends: backends(),
        routes: async () => routes,
        saveArtifact: async (/** @type {any} */ a) => {
          artifacts.push(a);
        },
        now: () => at,
      },
    };
  }
  const job = (/** @type {Record<string, unknown>} */ over = {}) => ({ id: 'job-1', question: 'How many rooms does the hall have?', createdAt: at, locale: 'en', scope: { conversationId: 'conv-1', nodeId: 'node-9' }, options: { web: true, stripPii: true }, parts: {}, ...over });

  it('plans, searches with tools, searches the web, stores the report and builds a v3 receipt', async () => {
    const grounded = 'The hall is listed in the town register.';
    const { complete, requests } = fakeComplete([
      { text: '{"queries": ["hall rooms", "hall bookings", "hall rooms"]}' },
      { toolCalls: [{ id: 'c1', name: 'search_sources', args: { query: 'hall rooms' }, argsText: '' }] },
      { text: `## Summary\nThe large room holds 120 people. ${PLAN_LABEL}\n## Open questions\n- None.`, model: 'test-model-2' },
      ...Array.from({ length: 3 }, () => ({ text: grounded, citations: [{ url: 'https://example.org/register', title: 'Register', start: 0, end: grounded.length }] })),
    ]);
    const { runtime: rt, artifacts } = runtime({ sources: { provider: 'gemini', model: 'test-model' }, web: { provider: 'gemini', model: 'test-model' }, pool: false }, { complete });
    /** @type {string[]} */
    const steps = [];
    const out = await runResearch(job({ question: 'How many rooms does the hall have? Ask anna@example.org.' }), rt, { progress: (p) => steps.push(p.step) });
    assert.deepEqual(out.plan.queries, ['hall rooms', 'hall bookings']);
    assert.equal(requests[0].responseFormat.type, 'json_schema');
    assert.ok(!requests[0].messages[0].content[0].text.includes('anna@'), 'the plan sees the web query without personal details');
    assert.equal(out.parts.sources.via, 'byok');
    assert.deepEqual(out.parts.sources.provider, { id: 'gemini', model: 'test-model-2' });
    assert.deepEqual(out.parts.sources.sections.summary.map((s) => s.text), ['The large room holds 120 people.']);
    assert.deepEqual(out.parts.sources.check, { supported: 1, weak: 0, unsupported: 0, unchecked: 0 });
    const web = /** @type {import('../../src/js/research/web-part.js').WebPart} */ (out.parts.web);
    assert.equal(web.status, 'done');
    assert.equal(web.query, 'How many rooms does the hall have? Ask.');
    assert.deepEqual(web.removed, ['email']);
    assert.equal(web.rounds, 3);
    assert.equal(requests[3].search.enabled, true);
    assert.equal(requests[3].messages[0].content[0].text, web.query, 'the first round sends the question as typed');
    assert.deepEqual(steps.filter((s, i) => s !== steps[i - 1]), ['plan', 'sources', 'web', 'check', 'report']);
    // The report: an artifact with the document part, the web part and its pages listed as not verified.
    assert.equal(artifacts.length, 1);
    const artifact = artifacts[0];
    assert.deepEqual({ id: artifact.id, type: artifact.type, conversationId: artifact.conversationId, nodeId: artifact.nodeId, researchId: artifact.researchId }, { id: 'research-job-1', type: 'markdown', conversationId: 'conv-1', nodeId: 'node-9', researchId: 'job-1' });
    const md = artifact.versions[0].content;
    assert.equal(md, out.report.markdown);
    for (const piece of ['# Research report', '## Summary', `The large room holds 120 people. ${PLAN_LABEL}`, '## From the web', grounded, '### Web pages (listed, not verified against the pages)', '<https://example.org/register>', '## Open questions', 'Source check: 1 supported']) {
      assert.ok(md.includes(piece), piece);
    }
    // The receipt covers the documents part only.
    const receipt = await buildReceipt(receiptDraft({ question: 'q', createdAt: at, locale: 'en', sources: out.parts.sources }, { version: '3.0.0-test' }));
    assert.equal(receipt.schema, RECEIPT_SCHEMA);
    assert.equal(validateReceipt(receipt).ok, true);
    assert.deepEqual(receipt.gate, { mode: 'sources', released: 2, withheld: 0 });
    assert.ok(receipt.citations.every((c) => c.label.startsWith('[Doc: ')));
    assert.ok(!JSON.stringify(receipt).includes('example.org/register'));
  });

  it('withholds an ungrounded web part in the pipeline and keeps only its sources', async () => {
    const { complete } = fakeComplete([{ text: 'The hall seats 400 guests.', citations: [{ url: 'https://example.org/hall', title: 'Hall' }] }]);
    const { runtime: rt } = runtime({ sources: null, web: { provider: 'anthropic', model: 'test-model' }, pool: false }, { complete });
    const out = await runResearch(job({ options: { web: true } }), rt);
    assert.equal(out.parts.sources.via, 'quote');
    const web = /** @type {import('../../src/js/research/web-part.js').WebPart} */ (out.parts.web);
    assert.deepEqual({ status: web.status, verdict: web.verdict, text: web.text, reason: web.reason }, { status: 'withheld', verdict: 'withheld', text: null, reason: 'web_ungrounded' });
    assert.ok(!out.report.markdown.includes('400 guests'));
    assert.ok(out.report.markdown.includes('The web part was withheld'));
  });

  it('uses the signed pool loop and the pool web step without a key, and quotes without either', async () => {
    /** @type {any[]} */
    const bodies = [];
    const step = async (/** @type {any} */ body) => {
      bodies.push(body);
      if (body.part === 'web') return { status: 'final', round: 1, model: 'gemini-2.5-flash', text: 'Plain words.', grounding: { segments: [{ start: 0, end: 12, sources: [0] }], sources: [{ uri: 'https://example.org/a', title: 'A' }], queries: [], suggestionsHtml: null } };
      return { status: 'final', round: 1, model: 'gemini-2.5-flash', text: `The hall has 3 rooms. ${PLAN_LABEL}` };
    };
    const pooled = runtime({ sources: null, web: null, pool: true }, { step });
    const out = await runResearch(job(), pooled.runtime);
    assert.equal(out.parts.sources.via, 'pool');
    assert.equal(out.parts.web?.status, 'done');
    assert.deepEqual(bodies.map((b) => b.part), ['sources', 'web']);
    // The pool's answer cites an excerpt the browser never handed out: the sentence has a number, so it is withheld.
    assert.equal(out.parts.sources.withheld, 1);

    const offline = runtime({ sources: null, web: null, pool: false });
    const quoted = await runResearch(job(), offline.runtime);
    assert.equal(quoted.parts.sources.via, 'quote');
    assert.ok(quoted.parts.sources.released > 0);
    assert.deepEqual({ status: quoted.parts.web?.status, reason: quoted.parts.web?.reason }, { status: 'off', reason: 'no_provider' });
    assert.ok(quoted.report.markdown.includes('Quoted from the documents without a model'));
  });

  it('falls back to the quote when the model fails, and keeps finished parts on a retry', async () => {
    const failing = fakeComplete([{ error: /** @type {any} */ (Object.assign(new Error('busy'), { code: 'rate_limited' })), stopReason: 'error' }, { error: /** @type {any} */ (Object.assign(new Error('busy'), { code: 'rate_limited' })), stopReason: 'error' }]);
    const { runtime: rt } = runtime({ sources: { provider: 'openai', model: 'test-model' }, web: null, pool: false }, { complete: failing.complete });
    const out = await runResearch(job({ options: { web: false } }), rt);
    assert.equal(out.parts.sources.via, 'quote');
    assert.equal(out.parts.sources.fallback, 'rate_limited');
    assert.equal(out.parts.web, null);

    const kept = runtime({ sources: null, web: null, pool: false });
    const again = await runResearch(job({ options: { web: false }, plan: { queries: ['x'] }, parts: { sources: out.parts.sources } }), kept.runtime);
    assert.deepEqual(kept.runtime.backends.queries, [], 'the finished sources part did not search again');
    assert.deepEqual(again.parts.sources.sections, out.parts.sources.sections);
    assert.deepEqual(again.plan.queries, ['x']);
  });

  it('cancels between steps', async () => {
    const ctrl = new AbortController();
    const { runtime: rt } = runtime({ sources: null, web: null, pool: false });
    ctrl.abort();
    await assert.rejects(runResearch(job(), rt, { signal: ctrl.signal }), (err) => err instanceof DOMException && err.name === 'AbortError');
  });

  it('writes the report in German for a German job', () => {
    const md = reportMarkdown({
      question: 'Wie viele Räume?',
      createdAt: at,
      locale: 'de',
      sources: /** @type {any} */ ({ via: 'quote', provider: null, sections: { summary: [{ text: 'Drei Räume.', cites: [PLAN_LABEL], kind: 'sentence' }], details: [], open_questions: [] }, cited: [PLAN_LABEL], excerpts: [{ label: PLAN_LABEL, heading: '' }], withheld: 1, check: { supported: 1, weak: 0, unsupported: 0, unchecked: 0 } }),
      web: null,
    });
    for (const piece of ['# Recherchebericht', '## Zusammenfassung', '## Quellen', 'Ohne Modell aus den Dokumenten zitiert', 'Die Satzprüfung hat 1 Satz zurückgehalten.']) assert.ok(md.includes(piece), piece);
  });
});
