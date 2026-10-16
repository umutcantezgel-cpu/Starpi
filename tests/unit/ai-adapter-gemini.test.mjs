// The Gemini adapter: the streamGenerateContent request (key in the header, thinking level or
// budget, thoughts included, function declarations, google_search grounding, inline images and
// PDFs, JSON output), replay of thought signatures on function-calling turns, the events of
// recorded streams (thought parts, function calls, grounding citations with byte offsets turned
// into UTF-16 offsets, prompt blocks, safety stops, images), and runs against the fake.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createGeminiFake } from '../../scripts/fakes/gemini.mjs';
import { REASONING_TEXT, SEARCH_SOURCES, searchSentences, TINY_PNG_BASE64 } from '../../scripts/fakes/shared.mjs';
import { buildGeminiBody, createGeminiAdapter, groundingCitations, OPAQUE_GROUNDING, OPAQUE_PARTS } from '../../src/js/ai/adapters/gemini.js';
import { AiError } from '../../src/js/ai/errors.js';
import { collect, validateEventSequence } from '../../src/js/ai/index.js';
import { stream } from '../../src/js/ai/stream.js';
import { directTransport } from '../../src/js/ai/transport.js';
import { fixture, joined, LOOKUP, ofType, replay, request, run } from '../fixtures/ai/replay.mjs';

const adapter = createGeminiAdapter();
const PNG = 'iVBORw0KGgo=';
const PDF = Buffer.from('%PDF-1.4 tiny').toString('base64');

describe('gemini adapter: request', () => {
  it('streams over SSE with the key in its header, never in the URL', () => {
    const built = adapter.buildRequest(request('gemini', 'gemini-2.5-flash', 'Hi', { system: 'Be brief.' }));
    assert.equal(built.path, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    assert.doesNotMatch(built.path, /key=/);
    assert.deepEqual(adapter.authHeader?.('k'), ['x-goog-api-key', 'k']);
    assert.deepEqual(/** @type {any} */ (built.body).systemInstruction, { parts: [{ text: 'Be brief.' }] });
    for (const bad of ['Gemini-2.5', 'models/x', '../x', 'a b']) assert.throws(() => adapter.buildRequest(request('gemini', bad, 'Hi')), AiError);
  });

  it('maps the thinking toggle onto a budget or a level, with thoughts included when shown', () => {
    /** @param {string} model @param {any} thinking */
    const cfg = (model, thinking) => buildGeminiBody(request('gemini', model, 'Hi', { thinking })).generationConfig?.thinkingConfig;
    assert.deepEqual(cfg('gemini-2.5-flash', { mode: 'on' }), { includeThoughts: true, thinkingBudget: -1 });
    assert.deepEqual(cfg('gemini-2.5-flash', { mode: 'auto', effort: 'low' }), { includeThoughts: true, thinkingBudget: 1024 });
    assert.deepEqual(cfg('gemini-2.5-flash', { mode: 'off' }), { includeThoughts: false, thinkingBudget: 0 });
    assert.deepEqual(cfg('gemini-2.5-pro', { mode: 'off' }), { includeThoughts: false, thinkingBudget: 128 });
    assert.deepEqual(cfg('gemini-3-pro-preview', { mode: 'on', show: false }), { includeThoughts: false, thinkingLevel: 'high' });
    assert.deepEqual(cfg('gemini-3-pro-preview', { mode: 'off' }), { includeThoughts: false, thinkingLevel: 'low' });
    assert.equal(cfg('gemini-2.5-flash-image', { mode: 'on' }), undefined);
  });

  it('declares functions, grounding with Google Search, JSON output and image output', () => {
    const body = buildGeminiBody(request('gemini', 'gemini-2.5-flash', 'Hi', { tools: [LOOKUP], toolChoice: 'none', search: { enabled: true }, responseFormat: { type: 'json_schema', schema: { type: 'object' } }, maxOutputTokens: 900, temperature: 0.1 }));
    assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: 'lookup', description: LOOKUP.description, parametersJsonSchema: LOOKUP.schema }] }, { google_search: {} }]);
    assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(body.generationConfig.responseJsonSchema, { type: 'object' });
    assert.equal(body.generationConfig.maxOutputTokens, 900);
    assert.equal(body.generationConfig.temperature, 0.1);
    assert.deepEqual(buildGeminiBody(request('gemini', 'gemini-2.5-flash-image', 'Draw')).generationConfig?.responseModalities, ['TEXT', 'IMAGE']);
  });

  it('sends images and PDFs inline and replays a function-calling turn with its signatures', () => {
    const stored = [{ functionCall: { name: 'lookup', args: { query: 'x' } }, thoughtSignature: 'c2ln' }];
    const req = {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mime: 'image/jpeg', data: PNG },
            { type: 'file', mime: 'application/pdf', data: PDF, name: 'a.pdf' },
            { type: 'text', text: 'Read these.' },
          ],
        },
        { role: 'assistant', content: [{ type: 'tool_call', id: 'gemini-call-1', name: 'lookup', args: { query: 'x' } }, { type: 'opaque', provider: 'gemini', model: 'gemini-2.5-flash', block: { kind: OPAQUE_PARTS, parts: stored } }] },
        { role: 'tool', content: [{ type: 'tool_result', id: 'gemini-call-1', content: 'X' }] },
        { role: 'system', content: [{ type: 'text', text: 'Short answers.' }] },
      ],
    };
    const body = buildGeminiBody(/** @type {any} */ (req));
    assert.deepEqual(body.contents[0].parts, [{ inlineData: { mimeType: 'image/jpeg', data: PNG } }, { inlineData: { mimeType: 'application/pdf', data: PDF } }, { text: 'Read these.' }]);
    assert.deepEqual(body.contents[1], { role: 'model', parts: stored });
    assert.deepEqual(body.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { result: 'X' } } }] });
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Short answers.' }] });
    // Without stored parts the turn is rebuilt; a provider id travels with the response.
    const rebuilt = buildGeminiBody(/** @type {any} */ ({ ...req, messages: [req.messages[0], { role: 'assistant', content: [{ type: 'tool_call', id: 'fc-7', name: 'lookup', args: {} }] }, { role: 'tool', content: [{ type: 'tool_result', id: 'fc-7', content: 'bad', isError: true }] }] }));
    assert.deepEqual(rebuilt.contents[1].parts, [{ functionCall: { name: 'lookup', args: {} } }]);
    assert.deepEqual(rebuilt.contents[2].parts, [{ functionResponse: { name: 'lookup', response: { error: 'bad' }, id: 'fc-7' } }]);
  });
});

describe('gemini adapter: recorded streams', () => {
  /** @param {string} name @param {string} [text] */
  const events = (name, text = 'x') => replay(adapter, request('gemini', 'gemini-2.5-flash', text), fixture('gemini', name));

  it('reads thought parts as reasoning and keeps the signed answer parts', () => {
    const evs = events('reasoning');
    assert.deepEqual(validateEventSequence(evs), []);
    assert.equal(joined(evs, 'reasoning'), REASONING_TEXT);
    const [opaque] = ofType(evs, 'opaque');
    assert.equal(opaque.block.kind, OPAQUE_PARTS);
    assert.match(opaque.block.parts[0].thoughtSignature, /^fake-thought-/);
    assert.equal(opaque.block.parts.map((/** @type {any} */ p) => p.text ?? '').join(''), joined(evs, 'text'));
    const [usage] = ofType(evs, 'usage');
    assert.ok(usage.reasoning > 0);
    assert.equal(evs.at(-1).stopReason, 'end_turn');
  });

  it('reads a function call whole and ends the turn as a tool call', () => {
    const evs = events('tool');
    const [call] = ofType(evs, 'tool_call');
    assert.deepEqual(call, { type: 'tool_call', id: 'gemini-call-1', name: 'lookup', args: { query: 'Look it up' }, final: true });
    assert.equal(evs.at(-1).stopReason, 'tool_call');
    assert.ok(ofType(evs, 'opaque')[0].block.parts[0].thoughtSignature);
  });

  for (const [name, text] of [
    ['search', 'Search the topic'],
    ['search-de', 'Was ist das für ein Thema?'],
  ]) {
    it(`${name}: grounding supports become citations with UTF-16 offsets`, () => {
      const evs = events(name);
      const answer = joined(evs, 'text');
      const sentences = searchSentences(text);
      const cites = ofType(evs, 'citation');
      assert.equal(cites.length, sentences.length);
      cites.forEach((c, i) => {
        assert.equal(c.url, SEARCH_SOURCES[sentences[i].source].url);
        assert.equal(answer.slice(c.start, c.end), sentences[i].text.trim());
        assert.equal(c.citedText, sentences[i].text.trim());
      });
      const grounding = ofType(evs, 'opaque').find((o) => o.block.kind === OPAQUE_GROUNDING);
      assert.match(grounding.block.searchEntryPoint, /fake-search-entry/);
      assert.equal(grounding.block.queries.length, 1);
    });
  }

  it('lists consulted sources the answer does not point at, without offsets', () => {
    const cites = groundingCitations({ groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'A' } }, { web: { uri: 'https://example.org/b', title: 'B' } }], groundingSupports: [{ segment: { startIndex: 0, endIndex: 3 }, groundingChunkIndices: [0] }] }, 'Abc def');
    assert.deepEqual(cites, [
      { type: 'citation', url: 'https://example.com/a', title: 'A', start: 0, end: 3 },
      { type: 'citation', url: 'https://example.org/b', title: 'B' },
    ]);
  });

  it('maps a blocked prompt and safety stops to refusal, MAX_TOKENS to max_tokens', () => {
    const blocked = events('blocked');
    assert.deepEqual(validateEventSequence(blocked), []);
    assert.equal(blocked.at(-1).stopReason, 'refusal');
    assert.equal(events('refusal').at(-1).stopReason, 'refusal');
    assert.equal(events('length').at(-1).stopReason, 'max_tokens');
  });

  it('turns inline image data into image events', () => {
    const [image] = ofType(events('image'), 'image');
    assert.deepEqual(image, { type: 'image', mime: 'image/png', data: TINY_PNG_BASE64 });
  });

  it('reads an error object inside the stream and a JSON array answer', () => {
    const state = adapter.createState(request('gemini', 'gemini-2.5-flash', 'x'));
    const evs = adapter.parseEvent({ event: 'message', data: JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } }) }, state);
    assert.equal(/** @type {any} */ (evs.at(-1)).error.code, 'server');
    const whole = adapter.parseResponse?.([{ candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }] }], adapter.createState(request('gemini', 'gemini-2.5-flash', 'x'))) ?? [];
    assert.deepEqual(validateEventSequence(whole), []);
    assert.equal(joined(whole, 'text'), 'Hi');
  });
});

describe('gemini adapter: end to end against the fake', () => {
  /** @type {ReturnType<typeof createGeminiFake>} */
  let fake;
  /** @type {ReturnType<typeof createGeminiFake>} */
  let slow;
  let url = '';
  let slowUrl = '';
  before(async () => {
    fake = createGeminiFake({ gapMs: 0 });
    slow = createGeminiFake({ gapMs: 25 });
    url = (await fake.listen(0)).url;
    slowUrl = (await slow.listen(0)).url;
  });
  after(async () => {
    await fake.close();
    await slow.close();
  });

  it('runs a function-calling loop and sends the thought signature back', async () => {
    const t = directTransport(url, 'test-key', undefined, { provider: 'gemini' });
    const first = request('gemini', 'gemini-2.5-flash', 'Look it up [[fake:tool]]', { tools: [LOOKUP], thinking: { mode: 'on' } });
    const r1 = await collect(await run(adapter, first, t));
    assert.equal(r1.stopReason, 'tool_call');
    const call = r1.toolCalls[0];
    const assistant = { role: 'assistant', content: [{ type: 'tool_call', id: call.id, name: call.name, args: call.args ?? {} }, ...r1.opaque] };
    const second = { ...first, messages: [...first.messages, assistant, { role: 'tool', content: [{ type: 'tool_result', id: call.id, content: 'A word.' }] }] };
    const r2 = await collect(await run(adapter, /** @type {any} */ (second), t));
    assert.equal(r2.stopReason, 'end_turn');
    const sent = fake.requests.at(-1);
    assert.equal(sent?.headers['x-goog-api-key'], 'test-key');
    assert.equal(sent?.query.alt, 'sse');
    assert.equal(sent?.query.key, undefined);
    assert.match(sent?.body.contents[1].parts[0].thoughtSignature, /^fake-thought-/);
    assert.deepEqual(sent?.body.contents[2].parts[0].functionResponse, { name: 'lookup', response: { result: 'A word.' } });
  });

  it('reads the retry delay of a rate limit from the error body', async () => {
    const t = directTransport(url, 'test-key', undefined, { provider: 'gemini' });
    const r = await collect(await run(adapter, request('gemini', 'gemini-2.5-flash', 'Hi [[fake-fault:429]]'), t));
    assert.equal(r.error?.code, 'rate_limited');
    assert.equal(r.error?.retryAfterMs, 2000);
  });

  it('stops in the middle of a stream', async () => {
    const t = directTransport(slowUrl, 'test-key', undefined, { provider: 'gemini' });
    const controller = new AbortController();
    const evs = [];
    for await (const ev of stream(adapter, request('gemini', 'gemini-2.5-flash', 'Tell me a longer story about it', { thinking: { mode: 'off' } }), t, { signal: controller.signal })) {
      evs.push(ev);
      if (ev.type === 'text') controller.abort();
    }
    assert.deepEqual(validateEventSequence(evs), []);
    assert.equal(evs.at(-1).stopReason, 'cancelled');
    assert.equal(ofType(evs, 'text').length, 1);
  });
});
