// The Anthropic adapter: the request body it builds for the current models (thinking, effort, no
// forced tool choice, documents and images, web search, prompt caching, fallbacks only when asked
// and only where allowed), the events it reads from recorded Messages API streams (text,
// reasoning with signatures, tool calls, citations, pause, refusal, errors, a fallback midway),
// append-only replay of whole answers, and the SDK and wire forms end to end against the local
// fake, including Stop in the middle of a stream.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createAnthropicFake, signatureOf } from '../../scripts/fakes/anthropic.mjs';
import { defaultAnswer, REASONING_TEXT, SEARCH_SOURCES, searchSentences } from '../../scripts/fakes/shared.mjs';
import {
  anthropicModelTraits,
  buildAnthropicBody,
  createAnthropicAdapter,
  createAnthropicWireAdapter,
  FALLBACK_BETA,
  OPAQUE_CONTENT,
  replayContent,
  WEB_SEARCH_TOOL,
  WEB_SEARCH_TOOL_BASIC,
} from '../../src/js/ai/adapters/anthropic.js';
import { collect, validateEventSequence } from '../../src/js/ai/index.js';
import { stream } from '../../src/js/ai/stream.js';
import { directTransport } from '../../src/js/ai/transport.js';
import { fixture, joined, LOOKUP, ofType, replay, request, run } from '../fixtures/ai/replay.mjs';

const wire = createAnthropicWireAdapter();
const PNG = 'iVBORw0KGgo=';
const PDF = Buffer.from('%PDF-1.4 tiny').toString('base64');
const TXT = Buffer.from('Notes: grün und blau').toString('base64');

describe('anthropic adapter: request body', () => {
  it('turns thinking off with low effort, never by disabling it, and caches the prompt', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      const { body, betas } = buildAnthropicBody(request('anthropic', model, 'Hi', { thinking: { mode: 'off' } }));
      assert.equal(body.thinking, undefined, model);
      assert.deepEqual(body.output_config, { effort: 'low' }, model);
      assert.deepEqual(body.cache_control, { type: 'ephemeral' });
      assert.equal(body.stream, true);
      assert.equal(body.fallbacks, undefined);
      assert.deepEqual(betas, []);
      assert.ok(body.max_tokens > 0 && body.max_tokens <= 128_000);
      assert.equal(body.temperature, undefined);
    }
  });

  it('asks for adaptive thinking with a summarized display and the toggle effort when thinking is on', () => {
    const on = buildAnthropicBody(request('anthropic', 'claude-opus-5-5', 'Hi', { thinking: { mode: 'on' } })).body;
    assert.deepEqual(on.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(on.output_config, { effort: 'high' });
    const max = buildAnthropicBody(request('anthropic', 'claude-opus-5-5', 'Hi', { thinking: { mode: 'auto', effort: 'max', show: false } })).body;
    assert.deepEqual(max.thinking, { type: 'adaptive' });
    assert.deepEqual(max.output_config, { effort: 'max' });
    const auto = buildAnthropicBody(request('anthropic', 'claude-sonnet-5-5', 'Hi')).body;
    assert.deepEqual(auto.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(auto.output_config, undefined, 'auto keeps the model default effort');
    assert.ok(!JSON.stringify([on, max, auto]).includes('between_tools'));
    assert.ok(!JSON.stringify([on, max, auto]).includes('budget_tokens'));
  });

  it('gives older models a thinking budget and their sampling settings', () => {
    const { body } = buildAnthropicBody(request('anthropic', 'claude-haiku-4-5', 'Hi', { thinking: { mode: 'on', effort: 'low' }, maxOutputTokens: 16_000 }));
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 });
    assert.equal(body.output_config, undefined);
    const cool = buildAnthropicBody(request('anthropic', 'claude-haiku-4-5', 'Hi', { temperature: 0.3, thinking: { mode: 'off' } })).body;
    assert.equal(cool.temperature, 0.3);
    assert.equal(cool.thinking, undefined);
  });

  it('never forces a tool: auto is the default and none is passed on', () => {
    const auto = buildAnthropicBody(request('anthropic', 'claude-opus-5-5', 'Hi', { tools: [LOOKUP], toolChoice: 'auto' })).body;
    assert.equal(auto.tool_choice, undefined);
    assert.deepEqual(auto.tools, [{ name: 'lookup', description: LOOKUP.description, input_schema: LOOKUP.schema, eager_input_streaming: true }]);
    const none = buildAnthropicBody(request('anthropic', 'claude-opus-5-5', 'Hi', { tools: [LOOKUP], toolChoice: 'none' })).body;
    assert.deepEqual(none.tool_choice, { type: 'none' });
  });

  it('sends server-side fallbacks with their beta only to Opus and Sonnet 5.5, and only when asked', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      const { body, betas } = buildAnthropicBody(request('anthropic', model, 'Hi'), { serverFallbacks: true });
      assert.equal(body.fallbacks, 'default', model);
      assert.deepEqual(betas, [FALLBACK_BETA]);
    }
    for (const model of ['claude-haiku-5-5', 'claude-opus-5', 'claude-haiku-4-5']) {
      const { body, betas } = buildAnthropicBody(request('anthropic', model, 'Hi'), { serverFallbacks: true });
      assert.equal(body.fallbacks, undefined, model);
      assert.deepEqual(betas, []);
    }
    const headers = createAnthropicWireAdapter({ serverFallbacks: true }).buildRequest(request('anthropic', 'claude-opus-5-5', 'Hi')).headers;
    assert.equal(headers?.['anthropic-beta'], FALLBACK_BETA);
    assert.equal(headers?.['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(headers?.['x-api-key'], undefined, 'the transport adds the key');
  });

  it('sends images, PDFs with citations and text files, media before the text', () => {
    const req = {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these.' },
            { type: 'image', mime: 'image/png', data: PNG },
            { type: 'file', mime: 'application/pdf', data: PDF, name: 'report.pdf' },
            { type: 'file', mime: 'text/plain', data: TXT, name: 'notes.txt' },
          ],
        },
      ],
    };
    const [user] = buildAnthropicBody(/** @type {any} */ (req)).body.messages;
    assert.deepEqual(user.content.map((/** @type {any} */ b) => b.type), ['image', 'document', 'document', 'text']);
    assert.deepEqual(user.content[0].source, { type: 'base64', media_type: 'image/png', data: PNG });
    assert.deepEqual(user.content[1], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'report.pdf', citations: { enabled: true } });
    assert.deepEqual(user.content[2].source, { type: 'text', media_type: 'text/plain', data: 'Notes: grün und blau' });
    const json = buildAnthropicBody(/** @type {any} */ ({ ...req, responseFormat: { type: 'json_schema', schema: { type: 'object' } } })).body;
    assert.equal(json.messages[0].content[1].citations, undefined, 'citations and a JSON format exclude each other');
    assert.deepEqual(json.output_config.format, { type: 'json_schema', schema: { type: 'object' } });
  });

  it('adds the web search server tool in the variant the model takes', () => {
    const search = { enabled: true, maxUses: 3, allowDomains: ['example.com'] };
    const opus = buildAnthropicBody(request('anthropic', 'claude-opus-5-5', 'Hi', { search })).body;
    assert.deepEqual(opus.tools, [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: 3, allowed_domains: ['example.com'] }]);
    const haiku = buildAnthropicBody(request('anthropic', 'claude-haiku-5-5', 'Hi', { search: { enabled: true, blockDomains: ['example.org'] } })).body;
    assert.deepEqual(haiku.tools, [{ type: WEB_SEARCH_TOOL_BASIC, name: 'web_search', blocked_domains: ['example.org'] }]);
  });

  it('keeps system text in its place where the model allows it and groups parallel tool results', () => {
    const req = {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      system: 'Be brief.',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Leading note.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Find two words.' }] },
        { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'lookup', args: { query: 'a' } }, { type: 'tool_call', id: 't2', name: 'lookup', args: { query: 'b' } }] },
        { role: 'tool', content: [{ type: 'tool_result', id: 't1', content: 'A' }] },
        { role: 'tool', content: [{ type: 'tool_result', id: 't2', content: 'B', isError: true }] },
        { role: 'system', content: [{ type: 'text', text: 'Answer in one line.' }] },
      ],
    };
    const { body } = buildAnthropicBody(/** @type {any} */ (req));
    assert.equal(body.system, 'Be brief.\n\nLeading note.');
    assert.deepEqual(body.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant', 'user', 'system']);
    assert.deepEqual(body.messages[2].content, [
      { type: 'tool_result', tool_use_id: 't1', content: 'A' },
      { type: 'tool_result', tool_use_id: 't2', content: 'B', is_error: true },
    ]);
    // Models without system messages in the conversation get it in the system prompt.
    const older = buildAnthropicBody(/** @type {any} */ ({ ...req, model: 'claude-sonnet-5' })).body;
    assert.equal(older.messages.at(-1).role, 'user');
    assert.ok(older.system.endsWith('Answer in one line.'));
  });

  it('replays a stored answer verbatim and drops other providers state', () => {
    const stored = [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'text', text: 'Hello.', citations: [] },
    ];
    const req = {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello.' },
            { type: 'opaque', provider: 'gemini', model: 'gemini-2.5-flash', block: { kind: 'gemini-parts', parts: [] } },
            { type: 'opaque', provider: 'anthropic', model: 'claude-opus-5-5', block: { kind: OPAQUE_CONTENT, model: 'claude-opus-5-5', content: stored } },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'More' }] },
      ],
    };
    const { body } = buildAnthropicBody(/** @type {any} */ (req));
    assert.deepEqual(body.messages[1], { role: 'assistant', content: stored });
    // Without stored content the turn is rebuilt from its parts.
    const rebuilt = buildAnthropicBody(/** @type {any} */ ({ ...req, messages: [req.messages[0], { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }, { type: 'tool_call', id: 't1', name: 'lookup', args: { query: 'x' } }] }, { role: 'tool', content: [{ type: 'tool_result', id: 't1', content: 'X' }] }] })).body;
    assert.deepEqual(rebuilt.messages[1].content, [{ type: 'text', text: 'Hello.' }, { type: 'tool_use', id: 't1', name: 'lookup', input: { query: 'x' } }]);
  });

  it('knows which model families take what', () => {
    assert.deepEqual(anthropicModelTraits('claude-opus-5-5'), { adaptive: true, effort: true, maxEffort: true, sampling: false, fallbacks: true, midSystem: true, webSearchTool: WEB_SEARCH_TOOL });
    assert.equal(anthropicModelTraits('claude-haiku-5-5').fallbacks, false);
    assert.equal(anthropicModelTraits('claude-haiku-4-5-20251001').adaptive, false);
    assert.equal(anthropicModelTraits('claude-sonnet-4-6').sampling, true);
    assert.equal(anthropicModelTraits('claude-sonnet-5').midSystem, false);
  });
});

describe('anthropic adapter: recorded streams', () => {
  /** @param {string} name @param {string} model */
  const events = (name, model) => replay(wire, request('anthropic', model, 'x'), fixture('anthropic', name));

  it('reads text, summarized reasoning and the signed thinking block of an answer', () => {
    const evs = events('text', 'claude-opus-5-5');
    assert.deepEqual(validateEventSequence(evs), []);
    assert.deepEqual(evs[0], { type: 'start', provider: 'anthropic', model: 'claude-opus-5-5', requestId: undefined });
    assert.equal(joined(evs, 'reasoning'), REASONING_TEXT);
    assert.equal(joined(evs, 'text'), defaultAnswer('What is a fixture?'));
    const [opaque] = ofType(evs, 'opaque');
    assert.equal(opaque.block.kind, OPAQUE_CONTENT);
    assert.deepEqual(opaque.block.content[0], { type: 'thinking', thinking: REASONING_TEXT, signature: signatureOf(REASONING_TEXT, 'claude-opus-5-5') });
    assert.equal(ofType(evs, 'usage').length, 1);
    assert.deepEqual(evs.at(-1), { type: 'end', stopReason: 'end_turn' });
  });

  it('reads a tool call with its argument pieces and a final parsed call', () => {
    const evs = events('tool', 'claude-opus-5-5');
    const calls = ofType(evs, 'tool_call');
    assert.equal(calls[0].final, false);
    assert.equal(calls.map((c) => c.argsDelta ?? '').join(''), JSON.stringify({ query: 'Look it up' }));
    assert.deepEqual(calls.at(-1), { type: 'tool_call', id: calls[0].id, name: 'lookup', args: { query: 'Look it up' }, final: true });
    assert.equal(evs.at(-1).stopReason, 'tool_call');
    const tool = ofType(evs, 'opaque')[0].block.content.find((/** @type {any} */ b) => b.type === 'tool_use');
    assert.deepEqual(tool.input, { query: 'Look it up' });
  });

  it('turns web search citations into citation events over their text block', () => {
    const evs = events('search', 'claude-sonnet-5-5');
    const text = joined(evs, 'text');
    const cites = ofType(evs, 'citation');
    const sentences = searchSentences('Search the topic');
    assert.equal(cites.length, sentences.length);
    cites.forEach((c, i) => {
      assert.equal(c.url, SEARCH_SOURCES[sentences[i].source].url);
      assert.equal(text.slice(c.start, c.end), sentences[i].text);
      assert.equal(c.citedText, SEARCH_SOURCES[sentences[i].source].snippet);
    });
    const content = ofType(evs, 'opaque')[0].block.content;
    assert.deepEqual(content.map((/** @type {any} */ b) => b.type), ['server_tool_use', 'web_search_tool_result', 'text', 'text']);
    assert.deepEqual(content[0].input, { query: 'Search the topic' });
  });

  it('maps pause, refusal, length and a redacted thinking block', () => {
    const pause = events('pause', 'claude-sonnet-5-5');
    assert.equal(pause.at(-1).stopReason, 'pause');
    assert.equal(ofType(pause, 'opaque')[0].block.content.at(-1).type, 'server_tool_use');
    assert.equal(events('refusal', 'claude-opus-5-5').at(-1).stopReason, 'refusal');
    assert.equal(events('length', 'claude-haiku-5-5').at(-1).stopReason, 'max_tokens');
    const redacted = ofType(events('redacted', 'claude-opus-5-5'), 'opaque')[0].block.content;
    assert.ok(redacted.some((/** @type {any} */ b) => b.type === 'redacted_thinking' && typeof b.data === 'string'));
  });

  it('ends with an AiError when the stream reports an error', () => {
    const evs = events('stream-error', 'claude-haiku-5-5');
    assert.deepEqual(validateEventSequence(evs), []);
    const end = evs.at(-1);
    assert.equal(end.stopReason, 'error');
    assert.equal(end.error.code, 'server');
    assert.equal(end.error.providerCode, 'overloaded_error');
    assert.equal(ofType(evs, 'opaque').length, 0);
  });

  it('follows a fallback midway: the served model, text of both parts, and only replayable blocks', () => {
    const evs = events('fallback', 'claude-opus-5-5');
    assert.equal(evs[0].model, 'claude-opus-5-5');
    assert.equal(joined(evs, 'text'), 'Part one. Part two.');
    const [opaque] = ofType(evs, 'opaque');
    assert.equal(opaque.block.model, 'claude-opus-5');
    assert.deepEqual(opaque.block.content.map((/** @type {any} */ b) => b.type), ['text', 'fallback', 'text']);
    assert.deepEqual(ofType(evs, 'usage')[0], { type: 'usage', input: 47, output: 9, cacheRead: 30 });
  });

  it('keeps answered server tool calls before a fallback and drops unanswered ones', () => {
    const blocks = [
      { type: 'thinking', signature: 's' },
      { type: 'server_tool_use', id: 'a' },
      { type: 'web_search_tool_result', tool_use_id: 'a' },
      { type: 'server_tool_use', id: 'b' },
      { type: 'tool_use', id: 'c' },
      { type: 'fallback' },
      { type: 'thinking', signature: 't' },
    ];
    assert.deepEqual(replayContent(blocks).map((b) => b.type + (b.id ?? '')), ['server_tool_usea', 'web_search_tool_result', 'fallback', 'thinking']);
  });
});

describe('anthropic adapter: end to end against the fake', () => {
  /** @type {ReturnType<typeof createAnthropicFake>} */
  let fake;
  /** @type {ReturnType<typeof createAnthropicFake>} */
  let slow;
  let url = '';
  let slowUrl = '';
  before(async () => {
    fake = createAnthropicFake({ gapMs: 0 });
    slow = createAnthropicFake({ gapMs: 25 });
    url = (await fake.listen(0)).url;
    slowUrl = (await slow.listen(0)).url;
  });
  after(async () => {
    await fake.close();
    await slow.close();
  });

  const transport = () => directTransport(url, 'test-key', undefined, { provider: 'anthropic' });

  /**
   * The assistant message a chat stores for a result: text, tool calls and opaque state.
   * @param {import('../../src/js/ai/index.js').CompletionResult} result
   */
  const assistantOf = (result) => ({
    role: 'assistant',
    content: [...(result.text ? [{ type: 'text', text: result.text }] : []), ...result.toolCalls.map((c) => ({ type: 'tool_call', id: c.id, name: c.name, args: c.args ?? {} })), ...result.opaque],
  });

  for (const [label, adapter] of /** @type {const} */ ([
    ['SDK', createAnthropicAdapter()],
    ['wire', createAnthropicWireAdapter()],
  ])) {
    it(`${label}: runs a tool loop and replays the signed answer unchanged`, async () => {
      fake.requests.length = 0;
      const first = request('anthropic', 'claude-opus-5-5', 'Look it up [[fake:tool]]', { tools: [LOOKUP], thinking: { mode: 'on' } });
      const evs1 = await run(adapter, first, transport());
      assert.deepEqual(validateEventSequence(evs1), []);
      const r1 = await collect(evs1);
      assert.equal(r1.stopReason, 'tool_call');
      assert.match(r1.requestId ?? '', /^req_\d+fake$/);
      assert.equal(r1.reasoning, REASONING_TEXT);
      const call = r1.toolCalls[0];
      const second = { ...first, messages: [...first.messages, assistantOf(r1), { role: 'tool', content: [{ type: 'tool_result', id: call.id, content: 'A word.' }] }] };
      const r2 = await collect(await run(adapter, /** @type {any} */ (second), transport()));
      assert.equal(r2.stopReason, 'end_turn');
      assert.ok(r2.text.length > 0);
      const sent = fake.requests.at(-1);
      assert.equal(sent?.headers['x-api-key'], 'test-key');
      assert.equal(sent?.headers['anthropic-dangerous-direct-browser-access'], 'true');
      assert.equal(sent?.headers['anthropic-version'], '2023-06-01');
      assert.deepEqual(sent?.body.messages[1].content, /** @type {any} */ (r1.opaque[0].block).content);
      assert.equal(sent?.body.messages[1].content[0].signature, signatureOf(REASONING_TEXT, 'claude-opus-5-5'));
      assert.equal(sent?.body.fallbacks, undefined);
    });
  }

  it('continues a paused turn by sending it back', async () => {
    const adapter = createAnthropicAdapter();
    const first = request('anthropic', 'claude-sonnet-5-5', 'Search the topic [[fake:pause]]', { search: { enabled: true }, thinking: { mode: 'off' } });
    const r1 = await collect(await run(adapter, first, transport()));
    assert.equal(r1.stopReason, 'pause');
    const again = { ...first, messages: [{ role: 'user', content: [{ type: 'text', text: 'Search the topic' }] }, assistantOf(r1)] };
    const r2 = await collect(await run(adapter, /** @type {any} */ (again), transport()));
    assert.equal(r2.stopReason, 'end_turn');
    assert.equal(r2.citations.length, 2);
  });

  it('sends fallbacks and their beta header through the SDK when the caller turns them on', async () => {
    const r = await collect(await run(createAnthropicAdapter({ serverFallbacks: true }), request('anthropic', 'claude-sonnet-5-5', 'Hi'), transport()));
    assert.equal(r.stopReason, 'end_turn');
    const sent = fake.requests.at(-1);
    assert.equal(sent?.body.fallbacks, 'default');
    assert.equal(sent?.headers['anthropic-beta'], FALLBACK_BETA);
  });

  it('maps HTTP errors and stream errors to AiErrors', async () => {
    const limited = await collect(await run(createAnthropicAdapter(), request('anthropic', 'claude-opus-5-5', 'Hi [[fake-fault:429]]'), transport()));
    assert.equal(limited.error?.code, 'rate_limited');
    assert.equal(limited.error?.retryAfterMs, 2000);
    const midway = await collect(await run(createAnthropicAdapter(), request('anthropic', 'claude-opus-5-5', 'Hi [[fake:stream-error]]'), transport()));
    assert.equal(midway.error?.code, 'server');
    assert.ok(midway.text.length > 0, 'text before the error is kept');
    const badKey = await collect(await run(createAnthropicAdapter(), request('anthropic', 'claude-opus-5-5', 'Hi [[fake-fault:401]]'), transport()));
    assert.equal(badKey.error?.code, 'auth');
  });

  for (const [label, adapter] of /** @type {const} */ ([
    ['SDK', createAnthropicAdapter()],
    ['wire', createAnthropicWireAdapter()],
  ])) {
    it(`${label}: stops in the middle of a stream`, async () => {
      const controller = new AbortController();
      const t = directTransport(slowUrl, 'test-key', undefined, { provider: 'anthropic' });
      const evs = [];
      for await (const ev of stream(adapter, request('anthropic', 'claude-opus-5-5', 'Tell me a longer story about it', { thinking: { mode: 'off' } }), t, { signal: controller.signal })) {
        evs.push(ev);
        if (ev.type === 'text') controller.abort();
      }
      assert.deepEqual(validateEventSequence(evs), []);
      const end = evs.at(-1);
      assert.equal(end.stopReason, 'cancelled');
      assert.equal(end.error?.code, 'aborted');
      assert.equal(ofType(evs, 'text').length, 1);
    });
  }
});
