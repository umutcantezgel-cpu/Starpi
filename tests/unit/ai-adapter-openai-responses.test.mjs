// The OpenAI Responses adapter: stateless requests (store false, encrypted reasoning included),
// reasoning effort and summaries, tools and the built-in web search, images and PDFs, replay of
// encrypted reasoning items; the events of recorded streams (summary deltas, citations, tool calls,
// refusal, incomplete and failed responses); whole JSON answers; and runs against the fake with a
// tool loop and Stop in the middle of a stream.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { REASONING_TEXT, refusalText, SEARCH_SOURCES, searchSentences } from '../../scripts/fakes/shared.mjs';
import { buildResponsesBody, createOpenAiResponsesAdapter, RESPONSES_PATH } from '../../src/js/ai/adapters/openai-responses.js';
import { collect, validateEventSequence } from '../../src/js/ai/index.js';
import { stream } from '../../src/js/ai/stream.js';
import { directTransport } from '../../src/js/ai/transport.js';
import { fixture, joined, LOOKUP, ofType, replay, request, run } from '../fixtures/ai/replay.mjs';

const adapter = createOpenAiResponsesAdapter();
const PNG = 'iVBORw0KGgo=';
const PDF = Buffer.from('%PDF-1.4 tiny').toString('base64');

describe('openai responses adapter: request body', () => {
  it('is stateless and asks for encrypted reasoning, summaries and the effort of the toggle', () => {
    const built = adapter.buildRequest(request('openai', 'gpt-5', 'Hi', { system: 'Be brief.', thinking: { mode: 'on', effort: 'max' }, maxOutputTokens: 500 }));
    assert.equal(built.path, RESPONSES_PATH);
    const body = /** @type {any} */ (built.body);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
    assert.equal(body.instructions, 'Be brief.');
    assert.equal(body.max_output_tokens, 500);
    assert.equal(body.temperature, undefined, 'reasoning models take no temperature');
    const off = buildResponsesBody(request('openai', 'gpt-5-mini', 'Hi', { thinking: { mode: 'off' } }));
    assert.deepEqual(off.reasoning, { effort: 'minimal' });
    const plain = buildResponsesBody(request('openai', 'gpt-image-1', 'Hi', { temperature: 0.4 }));
    assert.equal(plain.include, undefined);
    assert.equal(plain.reasoning, undefined);
    assert.equal(plain.temperature, 0.4);
  });

  it('declares function tools and the built-in web search, and passes only auto or none', () => {
    const body = buildResponsesBody(request('openai', 'gpt-5', 'Hi', { tools: [LOOKUP], toolChoice: 'none', search: { enabled: true, allowDomains: ['example.com'] } }));
    assert.deepEqual(body.tools, [
      { type: 'function', name: 'lookup', description: LOOKUP.description, parameters: LOOKUP.schema, strict: false },
      { type: 'web_search', filters: { allowed_domains: ['example.com'] } },
    ]);
    assert.equal(body.tool_choice, 'none');
    const json = buildResponsesBody(request('openai', 'gpt-5', 'Hi', { responseFormat: { type: 'json_schema', schema: { type: 'object' } } }));
    assert.deepEqual(json.text, { format: { type: 'json_schema', name: 'response', schema: { type: 'object' }, strict: false } });
  });

  it('converts the conversation into input items and replays encrypted reasoning in order', () => {
    const reasoningItem = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ZW5j' };
    const req = {
      provider: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at these.' },
            { type: 'image', mime: 'image/png', data: PNG },
            { type: 'file', mime: 'application/pdf', data: PDF, name: 'a.pdf' },
            { type: 'file', mime: 'text/csv', data: Buffer.from('a,b').toString('base64'), name: 'b.csv' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_call', id: 'call_1', name: 'lookup', args: { query: 'x' } },
            { type: 'opaque', provider: 'openai', model: 'gpt-5', block: reasoningItem },
            { type: 'opaque', provider: 'anthropic', model: 'claude-opus-5-5', block: { kind: 'anthropic-content', content: [] } },
          ],
        },
        { role: 'tool', content: [{ type: 'tool_result', id: 'call_1', content: 'X' }] },
        { role: 'system', content: [{ type: 'text', text: 'Now answer.' }] },
      ],
    };
    const { input } = buildResponsesBody(/** @type {any} */ (req));
    assert.deepEqual(input[0].content, [
      { type: 'input_text', text: 'Look at these.' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
      { type: 'input_file', filename: 'a.pdf', file_data: `data:application/pdf;base64,${PDF}` },
      { type: 'input_text', text: 'b.csv\n\na,b' },
    ]);
    assert.deepEqual(input.slice(1), [
      reasoningItem,
      { role: 'assistant', content: 'Checking.' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'X' },
      { role: 'developer', content: [{ type: 'input_text', text: 'Now answer.' }] },
    ]);
  });
});

describe('openai responses adapter: recorded streams', () => {
  /** @param {string} name */
  const events = (name) => replay(adapter, request('openai', 'gpt-5', 'x'), fixture('openai-responses', name));

  it('reads the reasoning summary, the encrypted reasoning item and reasoning usage', () => {
    const evs = events('reasoning');
    assert.deepEqual(validateEventSequence(evs), []);
    assert.equal(evs[0].model, 'gpt-5');
    assert.equal(joined(evs, 'reasoning'), REASONING_TEXT);
    const [opaque] = ofType(evs, 'opaque');
    assert.equal(opaque.block.type, 'reasoning');
    assert.equal(typeof opaque.block.encrypted_content, 'string');
    const [usage] = ofType(evs, 'usage');
    assert.ok(usage.reasoning > 0 && usage.output >= usage.reasoning);
    assert.equal(evs.at(-1).stopReason, 'end_turn');
  });

  it('turns url_citation annotations into citations with offsets into the answer', () => {
    const evs = events('search');
    const text = joined(evs, 'text');
    const sentences = searchSentences('Search the topic');
    const cites = ofType(evs, 'citation');
    assert.equal(cites.length, sentences.length);
    cites.forEach((c, i) => {
      assert.equal(c.url, SEARCH_SOURCES[sentences[i].source].url);
      assert.equal(text.slice(c.start, c.end), sentences[i].text.trim());
    });
  });

  it('reads a function call with its argument pieces', () => {
    const evs = events('tool');
    const calls = ofType(evs, 'tool_call');
    assert.equal(calls[0].final, false);
    assert.deepEqual(calls.at(-1).args, { query: 'Look it up' });
    assert.equal(calls.at(-1).id, calls[0].id);
    assert.match(calls[0].id, /^call_/);
    assert.equal(evs.at(-1).stopReason, 'tool_call');
  });

  it('maps refusal, an incomplete answer and a failed response', () => {
    const refusal = events('refusal');
    assert.equal(joined(refusal, 'text'), refusalText('Something declined'));
    assert.equal(refusal.at(-1).stopReason, 'refusal');
    assert.equal(events('length').at(-1).stopReason, 'max_tokens');
    const failed = events('failed').at(-1);
    assert.equal(failed.stopReason, 'error');
    assert.equal(failed.error.code, 'server');
  });

  it('reads an error event and a whole JSON response', () => {
    const state = adapter.createState(request('openai', 'gpt-5', 'x'));
    const evs = adapter.parseEvent({ event: 'error', data: JSON.stringify({ type: 'error', code: 'rate_limit_exceeded', message: 'Slow down.' }) }, state);
    assert.equal(evs.at(-1)?.type, 'end');
    assert.equal(/** @type {any} */ (evs.at(-1)).error.code, 'rate_limited');
    const whole = {
      id: 'resp_1',
      model: 'gpt-5-mini',
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Short plan.' }], encrypted_content: 'ZQ==' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'See the source.', annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'A', start_index: 4, end_index: 14 }] }] },
      ],
      usage: { input_tokens: 5, output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 }, input_tokens_details: { cached_tokens: 1 } },
    };
    const out = adapter.parseResponse?.(whole, adapter.createState(request('openai', 'gpt-5-mini', 'x'))) ?? [];
    assert.deepEqual(validateEventSequence(out), []);
    assert.equal(joined(out, 'reasoning'), 'Short plan.');
    assert.deepEqual(ofType(out, 'citation')[0], { type: 'citation', url: 'https://example.com/a', title: 'A', start: 4, end: 14 });
    assert.deepEqual(ofType(out, 'usage')[0], { type: 'usage', input: 5, output: 7, reasoning: 2, cacheRead: 1 });
  });
});

describe('openai responses adapter: end to end against the fake', () => {
  /** @type {ReturnType<typeof createOpenAiFake>} */
  let fake;
  /** @type {ReturnType<typeof createOpenAiFake>} */
  let slow;
  let url = '';
  let slowUrl = '';
  before(async () => {
    fake = createOpenAiFake({ gapMs: 0 });
    slow = createOpenAiFake({ gapMs: 25 });
    url = (await fake.listen(0)).url;
    slowUrl = (await slow.listen(0)).url;
  });
  after(async () => {
    await fake.close();
    await slow.close();
  });

  it('runs a tool loop and sends the encrypted reasoning back', async () => {
    const t = directTransport(url, 'test-key', undefined, { provider: 'openai' });
    const first = request('openai', 'gpt-5', 'Look it up [[fake:tool]]', { tools: [LOOKUP], thinking: { mode: 'on' } });
    const r1 = await collect(await run(adapter, first, t));
    assert.equal(r1.stopReason, 'tool_call');
    assert.equal(r1.reasoning, REASONING_TEXT);
    assert.equal(r1.opaque.length, 1);
    const call = r1.toolCalls[0];
    const assistant = { role: 'assistant', content: [...r1.toolCalls.map((c) => ({ type: 'tool_call', id: c.id, name: c.name, args: c.args ?? {} })), ...r1.opaque] };
    const second = { ...first, messages: [...first.messages, assistant, { role: 'tool', content: [{ type: 'tool_result', id: call.id, content: 'A word.' }] }] };
    const r2 = await collect(await run(adapter, /** @type {any} */ (second), t));
    assert.equal(r2.stopReason, 'end_turn');
    const sent = fake.requests.at(-1);
    assert.equal(sent?.headers.authorization, 'Bearer test-key');
    assert.equal(sent?.body.store, false);
    assert.deepEqual(sent?.body.input[1], r1.opaque[0].block);
    assert.equal(sent?.body.input[2].type, 'function_call');
    assert.deepEqual(sent?.body.input[3], { type: 'function_call_output', call_id: call.id, output: 'A word.' });
  });

  it('reports a server error as an AiError', async () => {
    const t = directTransport(url, 'test-key', undefined, { provider: 'openai' });
    const r = await collect(await run(adapter, request('openai', 'gpt-5', 'Hi [[fake-fault:500]]'), t));
    assert.equal(r.error?.code, 'server');
    assert.equal(r.stopReason, 'error');
  });

  it('stops in the middle of a stream', async () => {
    const t = directTransport(slowUrl, 'test-key', undefined, { provider: 'openai' });
    const controller = new AbortController();
    const evs = [];
    for await (const ev of stream(adapter, request('openai', 'gpt-5-mini', 'Tell me a longer story about it'), t, { signal: controller.signal })) {
      evs.push(ev);
      if (ev.type === 'text') controller.abort();
    }
    assert.deepEqual(validateEventSequence(evs), []);
    assert.equal(evs.at(-1).stopReason, 'cancelled');
    assert.equal(ofType(evs, 'text').length, 1);
  });
});
