// The research step on the site's Gemini pool (api/research/step.js, api/_lib/gemini/research.js):
// the guard order, the shape check, signed model turns (a changed turn, signature, question, round
// or model is refused before anything reaches Google), the round limit with functionCallingConfig
// NONE after the last round, the web step with its grounding in UTF-16 offsets, the daily budget,
// and a whole loop against the local Gemini fake.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { canonicalJson, checkStepRequest, createTurnSigner, researchModel, RESEARCH_MODEL, stepBody, webGrounding } from '../../api/_lib/gemini/research.js';
import { createDailyLimiter } from '../../api/_lib/origins.js';
import { createRateLimiter } from '../../api/_lib/guards.js';
import * as route from '../../api/research/step.js';
import { createGeminiFake } from '../../scripts/fakes/gemini.mjs';
import { MAX_TOOL_ROUNDS, sourcesPrompt, SOURCE_TOOL_NAMES } from '../../src/js/research/prompts.js';
import { errorOf, jsonRequest, siteRequest, testKey } from './relay-helpers.mjs';

const KEY = testKey('gemini');
const QUESTION = 'Which rooms does the plan name?';

/**
 * A fetch that answers generateContent with the scripted candidates in turn and records the bodies.
 * @param {Array<Record<string, unknown> | number>} answers  a candidate object, or an HTTP status
 */
function scriptedFetch(answers) {
  /** @type {Array<{ url: string, body: any, headers: Record<string, string> }>} */
  const calls = [];
  const fn = /** @type {typeof fetch} */ (
    async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url: String(input), body, headers: /** @type {Record<string, string>} */ (init?.headers ?? {}) });
      const next = answers.shift();
      if (next === undefined) throw new Error('no scripted answer left');
      if (typeof next === 'number') return new Response('{"error":{}}', { status: next, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ candidates: [next] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  );
  return { fetch: fn, calls };
}

/** @param {string} name @param {Record<string, unknown>} args @param {string} [id] */
const callPart = (name, args, id) => ({ functionCall: { name, args, ...(id ? { id } : {}) }, thoughtSignature: 'opaque-thought' });
/** @param {Array<Record<string, unknown>>} parts */
const candidate = (parts, extra = {}) => ({ content: { role: 'model', parts }, finishReason: 'STOP', ...extra });

/**
 * @param {Partial<import('../../api/research/step.js').ResearchDeps>} [over]
 * @returns {import('../../api/research/step.js').ResearchDeps}
 */
function deps(over = {}) {
  return {
    keys: [KEY],
    root: 'https://generativelanguage.googleapis.com',
    model: RESEARCH_MODEL,
    limiter: createRateLimiter({ limit: 100, windowMs: 60_000, now: () => 0 }),
    daily: createDailyLimiter({ limit: 100, now: () => 0 }),
    extraOrigins: [],
    accessCode: '',
    fetch: scriptedFetch([]).fetch,
    now: () => 0,
    log: () => {},
    ...over,
  };
}

/** @param {unknown} data */
const step = (data) => jsonRequest('/api/research/step', data);

describe('research step: shape', () => {
  it('accepts a first step and refuses malformed ones', () => {
    assert.equal(checkStepRequest({ part: 'sources', question: QUESTION, locale: 'en' }).ok, true);
    const problem = (/** @type {unknown} */ body) => {
      const r = checkStepRequest(body);
      return r.ok ? null : r.problem;
    };
    assert.match(String(problem({ part: 'other', question: QUESTION, locale: 'en' })), /part/);
    assert.match(String(problem({ part: 'sources', question: ' ', locale: 'en' })), /question/);
    assert.match(String(problem({ part: 'sources', question: QUESTION, locale: 'fr' })), /locale/);
    assert.match(String(problem({ part: 'sources', question: QUESTION, locale: 'en', extra: 1 })), /unknown field/);
    const turn = { role: 'model', parts: [callPart('search_sources', { query: 'rooms' })] };
    const sig = 'a'.repeat(43);
    assert.match(String(problem({ part: 'web', question: QUESTION, locale: 'en', history: [{ turn, sig }, { results: [{ name: 'search_sources', content: '{}' }] }] })), /single step/);
    assert.match(String(problem({ part: 'sources', question: QUESTION, locale: 'en', history: [{ turn, sig }] })), /end with the results/);
    const other = { role: 'model', parts: [callPart('delete_everything', {})] };
    assert.match(String(problem({ part: 'sources', question: QUESTION, locale: 'en', history: [{ turn: other, sig }, { results: [{ name: 'delete_everything', content: '{}' }] }] })), /unknown tool/);
    assert.match(String(problem({ part: 'sources', question: QUESTION, locale: 'en', history: [{ turn, sig }, { results: [{ name: 'read_excerpt', content: '{}' }] }] })), /in order/);
    assert.match(String(problem({ part: 'sources', question: QUESTION, locale: 'en', history: [{ turn, sig }, { results: [] }] })), /one result per call/);
    const tooMany = Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => [{ turn, sig }, { results: [{ name: 'search_sources', content: '{}' }] }]).flat();
    assert.match(String(problem({ part: 'sources', question: QUESTION, locale: 'en', history: tooMany })), /at most/);
  });

  it('builds the body: the read-only tools, AUTO while rounds are left, NONE after the last one', () => {
    const first = /** @type {any} */ (stepBody({ part: 'sources', question: QUESTION, locale: 'en', history: [], hints: ['rooms'], focus: null }));
    assert.deepEqual(first.tools[0].functionDeclarations.map((/** @type {any} */ d) => d.name), [...SOURCE_TOOL_NAMES]);
    assert.equal(first.toolConfig.functionCallingConfig.mode, 'AUTO');
    assert.equal(first.systemInstruction.parts[0].text, sourcesPrompt('en', { hints: ['rooms'], focus: null }));
    const turn = { role: /** @type {const} */ ('model'), parts: [callPart('search_sources', { query: 'rooms' }, 'c1')] };
    const history = Array.from({ length: MAX_TOOL_ROUNDS }, () => [{ turn, sig: 'x' }, { results: [{ name: 'search_sources', id: 'c1', content: 'none' }] }]).flat();
    const last = /** @type {any} */ (stepBody({ part: 'sources', question: QUESTION, locale: 'de', history, hints: [], focus: null }));
    assert.equal(last.toolConfig.functionCallingConfig.mode, 'NONE');
    assert.deepEqual(last.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'search_sources', id: 'c1', response: { result: 'none' } } }] });
    const web = /** @type {any} */ (stepBody({ part: 'web', question: QUESTION, locale: 'en', history: [], hints: [], focus: null }));
    assert.deepEqual(web.tools, [{ google_search: {} }]);
    assert.equal(web.toolConfig, undefined);
  });

  it('takes a configured research model only from the Gemini pool', () => {
    assert.equal(researchModel({}), RESEARCH_MODEL);
    assert.equal(researchModel({ STARPI_RESEARCH_MODEL: 'gemini-2.5-flash-lite' }), 'gemini-2.5-flash-lite');
    assert.equal(researchModel({ STARPI_RESEARCH_MODEL: 'some-other-model' }), RESEARCH_MODEL);
  });
});

describe('research step: signatures', () => {
  const turn = { role: 'model', parts: [callPart('search_sources', { query: 'rooms', k: 3 })] };
  const base = { part: /** @type {const} */ ('sources'), round: 1, question: QUESTION, model: RESEARCH_MODEL, turn };

  it('verify what they signed, whatever the key order of the turn', async () => {
    const signer = createTurnSigner(KEY);
    const sig = await signer.sign(base);
    assert.match(sig, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await signer.verify(base, sig), true);
    const reordered = JSON.parse(JSON.stringify({ parts: turn.parts, role: 'model' }));
    assert.equal(canonicalJson(reordered), canonicalJson(turn));
    assert.equal(await signer.verify({ ...base, turn: reordered }, sig), true);
  });

  it('refuse a changed turn, question, round, part, model, key or signature', async () => {
    const signer = createTurnSigner(KEY);
    const sig = await signer.sign(base);
    const changedTurn = { role: 'model', parts: [callPart('search_sources', { query: 'salaries', k: 3 })] };
    assert.equal(await signer.verify({ ...base, turn: changedTurn }, sig), false);
    assert.equal(await signer.verify({ ...base, question: `${QUESTION}!` }, sig), false);
    assert.equal(await signer.verify({ ...base, round: 2 }, sig), false);
    assert.equal(await signer.verify({ ...base, part: 'web' }, sig), false);
    assert.equal(await signer.verify({ ...base, model: 'gemini-2.5-flash-lite' }, sig), false);
    assert.equal(await createTurnSigner(testKey('gemini', 2)).verify(base, sig), false);
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    assert.equal(await signer.verify(base, flipped), false);
    assert.equal(await signer.verify(base, 'not-a-signature'), false);
  });
});

describe('research step: route', () => {
  it('runs the guards in order and reports availability', async () => {
    assert.equal(route.available({}), false);
    assert.equal(route.available({ GEMINI_API_KEYS: KEY }), true);
    assert.equal(route.available({ GEMINI_API_KEYS: KEY, STARPI_POOL_PROVIDERS: 'groq' }), false);
    const cross = siteRequest('/api/research/step', { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.deepEqual(await errorOf(await route.handleResearchStep(cross, deps())), { status: 403, error: 'cross_site_request' });
    assert.deepEqual(await errorOf(await route.handleResearchStep(step({}), deps({ accessCode: 'code-for-tests-01' }))), { status: 401, error: 'access_required' });
    assert.deepEqual(await errorOf(await route.handleResearchStep(step({}), deps({ keys: [] }))), { status: 503, error: 'research_not_configured' });
    const bad = await route.handleResearchStep(step({ part: 'sources' }), deps());
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_request');
    assert.equal((await route.GET()).status, 405);
  });

  it('signs a tool round, takes it back with the results, and answers', async () => {
    const upstream = scriptedFetch([candidate([callPart('search_sources', { query: 'rooms' }, 'call-1')]), candidate([{ text: 'The plan names two rooms. [Doc: plan.md, Chunk: 1]' }])]);
    const d = deps({ fetch: upstream.fetch });
    const first = await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en' }), d);
    assert.equal(first.status, 200);
    const tools = await first.json();
    assert.equal(tools.status, 'tool_calls');
    assert.equal(tools.round, 1);
    assert.deepEqual(tools.calls, [{ name: 'search_sources', id: 'call-1', args: { query: 'rooms' } }]);
    assert.equal(upstream.calls[0].headers['x-goog-api-key'], KEY);
    assert.match(upstream.calls[0].url, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    assert.doesNotMatch(upstream.calls[0].url, /key=/);
    const history = [{ turn: tools.turn, sig: tools.sig }, { results: [{ name: 'search_sources', id: 'call-1', content: '{"excerpts":[]}' }] }];
    const second = await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en', history }), d);
    const final = await second.json();
    assert.deepEqual({ status: final.status, round: final.round, text: final.text }, { status: 'final', round: 2, text: 'The plan names two rooms. [Doc: plan.md, Chunk: 1]' });
    // The model turn went back unchanged, thought signature included, followed by the results.
    assert.deepEqual(upstream.calls[1].body.contents[1], tools.turn);
    assert.equal(upstream.calls[1].body.contents[1].parts[0].thoughtSignature, 'opaque-thought');
    assert.deepEqual(upstream.calls[1].body.contents[2].parts[0].functionResponse.response, { result: '{"excerpts":[]}' });
  });

  it('refuses a tampered history before anything reaches Google', async () => {
    const upstream = scriptedFetch([candidate([callPart('search_sources', { query: 'rooms' })])]);
    const d = deps({ fetch: upstream.fetch });
    const tools = await (await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en' }), d)).json();
    assert.equal(upstream.calls.length, 1);
    const results = { results: [{ name: 'search_sources', content: '{}' }] };
    const forgedTurn = { role: 'model', parts: [callPart('search_sources', { query: 'something else entirely' })] };
    const cases = [
      [{ turn: forgedTurn, sig: tools.sig }, results],
      [{ turn: tools.turn, sig: `${tools.sig.slice(0, -2)}AA` === tools.sig ? `${tools.sig.slice(0, -2)}BB` : `${tools.sig.slice(0, -2)}AA` }, results],
    ];
    for (const history of cases) {
      assert.deepEqual(await errorOf(await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en', history }), d)), { status: 400, error: 'history_not_signed' });
    }
    // The same turn for another question is refused as well.
    const moved = [{ turn: tools.turn, sig: tools.sig }, results];
    assert.deepEqual(await errorOf(await route.handleResearchStep(step({ part: 'sources', question: 'Another question?', locale: 'en', history: moved }), d)), { status: 400, error: 'history_not_signed' });
    // A site key change makes old turns invalid.
    assert.deepEqual(await errorOf(await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en', history: moved }), deps({ keys: [testKey('gemini', 3)] }))), { status: 400, error: 'history_not_signed' });
    assert.equal(upstream.calls.length, 1, 'no refused step reached Google');
  });

  it('lets the model only answer after the last round', async () => {
    const answers = Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => candidate([callPart('search_sources', { query: `q${i}` })]));
    const upstream = scriptedFetch([...answers, candidate([callPart('list_documents', {})])]);
    const d = deps({ fetch: upstream.fetch });
    /** @type {unknown[]} */
    const history = [];
    for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
      const r = await (await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en', history }), d)).json();
      assert.equal(r.status, 'tool_calls', `round ${round}`);
      history.push({ turn: r.turn, sig: r.sig }, { results: [{ name: 'search_sources', content: '[]' }] });
    }
    const res = await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en', history }), d);
    assert.equal(upstream.calls.at(-1)?.body.toolConfig.functionCallingConfig.mode, 'NONE');
    assert.deepEqual(await errorOf(res), { status: 502, error: 'bad_response' });
  });

  it('refuses calls of tools that do not exist', async () => {
    const upstream = scriptedFetch([candidate([callPart('send_mail', { to: 'someone' })])]);
    assert.deepEqual(await errorOf(await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en' }), deps({ fetch: upstream.fetch }))), { status: 502, error: 'bad_response' });
  });

  it('answers a web step with its grounding in UTF-16 offsets', async () => {
    const text = 'Die Brücke über den Fluss ist 120 m lang. Sie wurde 1907 eröffnet.';
    const bytes = (/** @type {string} */ s) => Buffer.byteLength(s);
    const first = 'Die Brücke über den Fluss ist 120 m lang.';
    const meta = {
      webSearchQueries: ['Brücke Länge'],
      searchEntryPoint: { renderedContent: '<div>suggestions</div>' },
      groundingChunks: [{ web: { uri: 'https://example.org/bridge', title: 'Bridge' } }, { web: { uri: 'ftp://example.org/x', title: 'ignored' } }],
      groundingSupports: [{ segment: { startIndex: 0, endIndex: bytes(first) }, groundingChunkIndices: [0, 1] }],
    };
    const upstream = scriptedFetch([candidate([{ text }], { groundingMetadata: meta })]);
    const res = await (await route.handleResearchStep(step({ part: 'web', question: 'How long is the bridge?', locale: 'de' }), deps({ fetch: upstream.fetch }))).json();
    assert.equal(res.status, 'final');
    assert.equal(res.text, text);
    assert.deepEqual(res.grounding.sources, [{ uri: 'https://example.org/bridge', title: 'Bridge' }]);
    assert.deepEqual(res.grounding.segments, [{ start: 0, end: first.length, sources: [0] }]);
    assert.deepEqual(res.grounding.queries, ['Brücke Länge']);
    assert.equal(res.grounding.suggestionsHtml, '<div>suggestions</div>');
    assert.deepEqual(upstream.calls[0].body.tools, [{ google_search: {} }]);
    assert.deepEqual(webGrounding('x', null), { segments: [], sources: [], queries: [], suggestionsHtml: null });
  });

  it('counts the daily budget only for steps that reach Google, and fails over to the next key', async () => {
    const upstream = scriptedFetch([429, candidate([{ text: 'Done.' }])]);
    const d = deps({ fetch: upstream.fetch, keys: [KEY, testKey('gemini', 2)], daily: createDailyLimiter({ limit: 1, now: () => 0 }) });
    const forged = [{ turn: { role: 'model', parts: [callPart('list_documents', {})] }, sig: 'A'.repeat(43) }, { results: [{ name: 'list_documents', content: '[]' }] }];
    assert.equal((await errorOf(await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en', history: forged }), d))).error, 'history_not_signed');
    const ok = await (await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en' }), d)).json();
    assert.equal(ok.text, 'Done.');
    assert.notEqual(upstream.calls[0].headers['x-goog-api-key'], upstream.calls[1].headers['x-goog-api-key']);
    const limited = await route.handleResearchStep(step({ part: 'sources', question: QUESTION, locale: 'en' }), d);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'daily_limit_reached');
  });
});

describe('research step against the Gemini fake', () => {
  const fake = createGeminiFake({ gapMs: 0 });
  let root = '';
  before(async () => {
    root = (await fake.listen(0)).url;
  });
  after(() => fake.close());

  it('runs a signed tool round and a web step', async () => {
    const d = deps({ fetch: (input, init) => fetch(input, init), root, model: 'gemini-fake-flash' });
    const question = 'Which rooms does the plan name? [[fake:tool]]';
    const tools = await (await route.handleResearchStep(step({ part: 'sources', question, locale: 'en' }), d)).json();
    assert.equal(tools.status, 'tool_calls');
    assert.equal(tools.calls[0].name, 'search_sources');
    const history = [{ turn: tools.turn, sig: tools.sig }, { results: [{ name: 'search_sources', content: '{"excerpts":[]}' }] }];
    const final = await (await route.handleResearchStep(step({ part: 'sources', question, locale: 'en', history }), d)).json();
    assert.equal(final.status, 'final');
    assert.ok(final.text.length > 0);
    const web = await (await route.handleResearchStep(step({ part: 'web', question: 'What is the topic about?', locale: 'en' }), d)).json();
    assert.equal(web.status, 'final');
    assert.equal(web.grounding.sources.length, 2);
    assert.ok(web.grounding.segments.length > 0);
    assert.match(String(web.grounding.suggestionsHtml), /Simulated search suggestions/);
  });
});
