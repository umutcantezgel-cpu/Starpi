// The chat provider fakes (OpenAI-compatible with its flavors, Messages API, Gemini): each starts
// on a free loopback port and streams in its provider's shape, scenarios produce reasoning, tool
// calls, citations, pause and refusal, and every scripted fault behaves as documented. The last
// suite runs the stream driver and a direct transport against the OpenAI fake end to end.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { textPart } from '../../src/js/ai/contract.js';
import { AiError } from '../../src/js/ai/errors.js';
import { readSse } from '../../src/js/ai/sse.js';
import { fromOpenAiChat } from '../../src/js/ai/stop-reason.js';
import { stream } from '../../src/js/ai/stream.js';
import { directTransport } from '../../src/js/ai/transport.js';
import { NVIDIA_MODELS } from '../../src/js/models/nvidia-catalog.js';
import { createAnthropicFake, signatureOf } from '../../scripts/fakes/anthropic.mjs';
import { createGeminiFake } from '../../scripts/fakes/gemini.mjs';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { defaultAnswer, REASONING_TEXT } from '../../scripts/fakes/shared.mjs';

/** @type {Record<string, import('../../scripts/fakes/shared.mjs').Fake>} */
const fakes = {};
/** @type {Record<string, string>} */
const url = {};

before(async () => {
  fakes.openai = createOpenAiFake({ gapMs: 0, fixtures: { custom_purpose: [{ text: 'first variant' }, { json: { n: 2 } }] } });
  fakes.anthropic = createAnthropicFake({ gapMs: 0 });
  fakes.gemini = createGeminiFake({ gapMs: 0 });
  fakes.marked = createOpenAiFake({ gapMs: 0, marker: 'other-purpose', fixtures: { pick: [{ text: 'picked by the other marker' }] } });
  for (const [name, fake] of Object.entries(fakes)) url[name] = (await fake.listen(0)).url;
});

after(async () => {
  await Promise.all(Object.values(fakes).map((f) => f.close()));
});

/**
 * @param {string} target
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
const post = (target, body, headers = {}) => fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** @param {Response} res */
async function events(res) {
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  const out = [];
  for await (const ev of readSse(res.body)) out.push({ event: ev.event, data: ev.data === '[DONE]' ? '[DONE]' : JSON.parse(ev.data) });
  return out;
}

const BEARER = { authorization: 'Bearer test-key' };
const ANTHROPIC = { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' };
const GOOGLE = { 'x-goog-api-key': 'test-key' };

/** @param {string} text @param {any} [extra] */
const chatBody = (text, extra = {}) => ({ model: 'fake-model', stream: true, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: text }], ...extra });
/** @param {any[]} evs */
const deltas = (evs) => evs.filter((e) => e.data !== '[DONE]' && e.data.choices?.length).map((e) => e.data.choices[0].delta);

describe('openai fake: Chat Completions', () => {
  it('lists models per flavor and needs a Bearer key except for local servers', async () => {
    assert.equal((await fetch(`${url.openai}/v1/models`)).status, 401);
    const list = await (await fetch(`${url.openai}/v1/models`, { headers: BEARER })).json();
    assert.ok(list.data.length > 0 && list.data.every((/** @type {any} */ m) => m.object === 'model'));
    const nvidia = await (await fetch(`${url.openai}/flavor/nvidia/v1/models`, { headers: BEARER })).json();
    assert.deepEqual(nvidia.data.map((/** @type {any} */ m) => m.id), NVIDIA_MODELS.map((m) => m.id));
    assert.equal((await fetch(`${url.openai}/flavor/ollama/v1/models`)).status, 200);
    assert.equal((await fetch(`${url.openai}/flavor/groq/openai/v1/models`, { headers: BEARER })).status, 200);
  });

  it('refuses a key in the URL', async () => {
    const res = await fetch(`${url.openai}/v1/models?key=abc`, { headers: BEARER });
    assert.equal(res.status, 400);
  });

  it('streams the simulated answer, then usage and [DONE]', async () => {
    const evs = await events(await post(`${url.openai}/v1/chat/completions`, chatBody('What is a fake?', { stream_options: { include_usage: true } }), BEARER));
    const text = deltas(evs).map((d) => d.content ?? '').join('');
    assert.equal(text, defaultAnswer('What is a fake?'));
    assert.equal(evs.at(-1)?.data, '[DONE]');
    const usage = evs.find((e) => e.data !== '[DONE]' && e.data.usage)?.data;
    assert.deepEqual(usage.choices, []);
    assert.ok(usage.usage.total_tokens > 0);
    assert.ok(evs.some((e) => e.data !== '[DONE]' && e.data.choices?.[0]?.finish_reason === 'stop'));
  });

  it('answers German questions in German and whole when not streamed', async () => {
    const res = await post(`${url.openai}/v1/chat/completions`, { ...chatBody('Was ist das?'), stream: false }, BEARER);
    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.match(body.choices[0].message.content, /simulierte Antwort/);
    assert.equal(body.choices[0].finish_reason, 'stop');
  });

  it('shapes reasoning per flavor', async () => {
    const reasoning = { 'x-fake-scenario': 'reasoning', ...BEARER };
    const xai = deltas(await events(await post(`${url.openai}/flavor/xai/v1/chat/completions`, chatBody('Q'), reasoning)));
    assert.equal(xai.map((d) => d.reasoning_content ?? '').join(''), REASONING_TEXT);
    const groqEvents = await events(await post(`${url.openai}/flavor/groq/openai/v1/chat/completions`, chatBody('Q'), reasoning));
    assert.equal(deltas(groqEvents).map((d) => d.reasoning ?? '').join(''), REASONING_TEXT);
    assert.ok(groqEvents.some((e) => e.data !== '[DONE]' && e.data.x_groq?.usage));
    const mistral = deltas(await events(await post(`${url.openai}/flavor/mistral/v1/chat/completions`, chatBody('Q'), reasoning)));
    assert.equal(mistral.filter((d) => Array.isArray(d.content)).map((d) => d.content[0].thinking[0].text).join(''), REASONING_TEXT);
    const ollama = deltas(await events(await post(`${url.openai}/flavor/ollama/v1/chat/completions`, chatBody('Q'), { 'x-fake-scenario': 'reasoning' })));
    assert.match(ollama.map((d) => d.content ?? '').join(''), /^<think>.*<\/think>\n\n/s);
    const router = await post(`${url.openai}/flavor/openrouter/api/v1/chat/completions`, chatBody('Q', { reasoning: { effort: 'low' } }), BEARER);
    const raw = await router.text();
    assert.match(raw, /^: OPENROUTER PROCESSING\n\n/);
    assert.match(raw, /"reasoning_details":\[/);
  });

  it('streams a tool call whose arguments arrive in pieces, then answers the tool result', async () => {
    const tools = [{ type: 'function', function: { name: 'look_up', parameters: { type: 'object' } } }];
    const evs = await events(await post(`${url.openai}/v1/chat/completions`, chatBody('Find docs [[fake:tool]]', { tools }), BEARER));
    const calls = deltas(evs).flatMap((d) => d.tool_calls ?? []);
    assert.equal(calls[0].function.name, 'look_up');
    assert.ok(calls.length > 2, 'arguments are streamed');
    assert.deepEqual(JSON.parse(calls.map((c) => c.function.arguments ?? '').join('')), { query: 'Find docs' });
    assert.ok(evs.some((e) => e.data !== '[DONE]' && e.data.choices?.[0]?.finish_reason === 'tool_calls'));
    const followUp = chatBody('Find docs [[fake:tool]]', { tools });
    followUp.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: calls[0].id, type: 'function', function: { name: 'look_up', arguments: '{}' } }] }, { role: 'tool', tool_call_id: calls[0].id, content: 'result' });
    const after = deltas(await events(await post(`${url.openai}/v1/chat/completions`, followUp, BEARER)));
    assert.ok(after.some((d) => typeof d.content === 'string' && d.content.length > 0));
    assert.ok(!after.some((d) => d.tool_calls));
  });

  it('ends refusals with content_filter and long answers with the flavor length reason', async () => {
    const refusal = await events(await post(`${url.openai}/v1/chat/completions`, chatBody('Q [[fake:refusal]]'), BEARER));
    assert.equal(fromOpenAiChat(refusal.find((e) => e.data !== '[DONE]' && e.data.choices?.[0]?.finish_reason)?.data.choices[0].finish_reason), 'refusal');
    const length = await events(await post(`${url.openai}/flavor/mistral/v1/chat/completions`, chatBody('Q'), { 'x-fake-scenario': 'length', ...BEARER }));
    assert.ok(length.some((e) => e.data !== '[DONE]' && e.data.choices?.[0]?.finish_reason === 'model_length'));
  });

  it('serves purpose fixtures in turn, built-in purposes and schema-shaped JSON', async () => {
    /** @param {string} system @param {any} [extra] */
    const ask = async (system, extra = {}) => {
      const res = await post(`${url.openai}/v1/chat/completions`, { model: 'm', messages: [{ role: 'system', content: system }, { role: 'user', content: 'plan a quiet weekend trip please' }], ...extra }, BEARER);
      return (await res.json()).choices[0].message.content;
    };
    assert.equal(await ask('[[starpi-purpose:custom_purpose]]'), 'first variant');
    assert.equal(await ask('[[starpi-purpose:custom_purpose]]'), '{"n":2}');
    assert.equal(await ask('[[starpi-purpose:title_chat]] Make a title.'), 'Plan a quiet weekend trip please');
    const schema = { type: 'object', properties: { score: { type: 'integer', minimum: 3 }, tags: { type: 'array', items: { type: 'string' } }, kind: { enum: ['a', 'b'] } }, required: ['score', 'tags', 'kind'] };
    assert.deepEqual(JSON.parse(await ask('Answer in JSON.', { response_format: { type: 'json_schema', json_schema: { name: 'x', schema } } })), { score: 3, tags: ['example'], kind: 'a' });
    const marked = await post(`${url.marked}/v1/chat/completions`, { model: 'm', messages: [{ role: 'system', content: '[[other-purpose:pick]]' }, { role: 'user', content: 'x' }] }, BEARER);
    assert.equal((await marked.json()).choices[0].message.content, 'picked by the other marker');
  });

  it('serves the image, speech and transcription stubs', async () => {
    const image = await (await post(`${url.openai}/v1/images/generations`, { model: 'fake-image-1', prompt: 'a square' }, BEARER)).json();
    assert.match(image.data[0].b64_json, /^iVBOR/);
    const speech = await post(`${url.openai}/v1/audio/speech`, { model: 'fake-tts-1', input: 'Hello there', voice: 'alloy' }, BEARER);
    assert.equal(speech.headers.get('content-type'), 'audio/mpeg');
    const bytes = new Uint8Array(await speech.arrayBuffer());
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfb]);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(64)], { type: 'audio/wav' }), 'a.wav');
    form.append('model', 'fake-transcribe-1');
    form.append('language', 'de');
    const text = await (await fetch(`${url.openai}/v1/audio/transcriptions`, { method: 'POST', headers: BEARER, body: form })).json();
    assert.equal(text.text, 'Dies ist ein simuliertes Transkript.');
  });
});

describe('openai fake: Responses API', () => {
  /** @param {any} extra @param {Record<string, string>} [headers] */
  const respond = async (extra, headers = {}) => events(await post(`${url.openai}/v1/responses`, { model: 'fake-gpt-reasoner', stream: true, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Explain fakes' }] }], ...extra }, { ...BEARER, ...headers }));

  it('streams reasoning summaries, encrypted reasoning and text, then completed with usage', async () => {
    const evs = await respond({ reasoning: { effort: 'low', summary: 'auto' }, include: ['reasoning.encrypted_content'] });
    const types = evs.map((e) => e.event);
    assert.equal(types[0], 'response.created');
    assert.equal(types.at(-1), 'response.completed');
    assert.equal(evs.filter((e) => e.event === 'response.reasoning_summary_text.delta').map((e) => e.data.delta).join(''), REASONING_TEXT);
    const reasoningItem = evs.find((e) => e.event === 'response.output_item.done' && e.data.item.type === 'reasoning')?.data.item;
    assert.ok(reasoningItem.encrypted_content);
    assert.equal(evs.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join(''), defaultAnswer('Explain fakes'));
    assert.ok(evs.at(-1)?.data.response.usage.output_tokens_details.reasoning_tokens > 0);
    assert.deepEqual(evs.map((e) => e.data.sequence_number), evs.map((_e, i) => i));
  });

  it('streams function calls, search annotations, refusals and incomplete answers', async () => {
    const tool = await respond({ tools: [{ type: 'function', name: 'look_up', parameters: { type: 'object' } }] }, { 'x-fake-scenario': 'tool' });
    assert.deepEqual(JSON.parse(tool.filter((e) => e.event === 'response.function_call_arguments.delta').map((e) => e.data.delta).join('')), { query: 'Explain fakes' });
    const search = await respond({ tools: [{ type: 'web_search' }] });
    const annotations = search.filter((e) => e.event === 'response.output_text.annotation.added').map((e) => e.data.annotation);
    assert.equal(annotations.length, 2);
    const text = search.find((e) => e.event === 'response.output_text.done')?.data.text;
    assert.equal(text.slice(annotations[1].start_index, annotations[1].end_index), 'The reference page adds the details.');
    const refusal = await respond({}, { 'x-fake-scenario': 'refusal' });
    assert.ok(refusal.some((e) => e.event === 'response.refusal.delta'));
    const length = await respond({}, { 'x-fake-scenario': 'length' });
    assert.equal(length.at(-1)?.event, 'response.incomplete');
    assert.equal(length.at(-1)?.data.response.incomplete_details.reason, 'max_output_tokens');
  });
});

describe('fake faults', () => {
  const target = () => `${url.openai}/v1/chat/completions`;

  it('answers 429 with Retry-After, 401, 404, 500 and 503 in the provider shape', async () => {
    const limited = await post(target(), chatBody('Q'), { ...BEARER, 'x-fake-fault': '429', 'x-fake-retry-after': '7' });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '7');
    assert.equal((await limited.json()).error.code, 'rate_limit_exceeded');
    for (const [fault, status] of [['401', 401], ['404', 404], ['500', 500], ['503', 503]]) {
      const res = await post(target(), chatBody('Q'), { ...BEARER, 'x-fake-fault': String(fault) });
      assert.equal(res.status, status, String(fault));
      assert.ok((await res.json()).error);
    }
    const marked = await post(target(), chatBody('Q [[fake-fault:429]]'), BEARER);
    assert.equal(marked.status, 429, 'a marker in the user message works too');
    const query = await post(`${target()}?fault=503`, chatBody('Q'), BEARER);
    assert.equal(query.status, 503);
  });

  it('delays the first byte', async () => {
    const t0 = Date.now();
    const res = await post(target(), chatBody('Q'), { ...BEARER, 'x-fake-fault': 'slow-first-byte', 'x-fake-delay-ms': '150' });
    assert.ok(Date.now() - t0 >= 140);
    assert.equal(res.status, 200);
    await res.body?.cancel();
  });

  it('cuts the stream midway, breaks a JSON line, and stalls', async () => {
    const cut = await post(target(), chatBody('Q'), { ...BEARER, 'x-fake-fault': 'cut-mid-stream' });
    await assert.rejects(async () => {
      for await (const ev of readSse(cut.body)) assert.notEqual(ev.data, '[DONE]');
    });
    const broken = await post(target(), chatBody('Q'), { ...BEARER, 'x-fake-fault': 'invalid-json' });
    const datas = [];
    for await (const ev of readSse(broken.body)) datas.push(ev.data);
    assert.ok(datas.some((d) => d !== '[DONE]' && (() => {
      try {
        JSON.parse(d);
        return false;
      } catch {
        return true;
      }
    })()));
    assert.equal(datas.at(-1), '[DONE]', 'the rest of the stream still arrives');
    const whole = await post(target(), { ...chatBody('Q'), stream: false }, { ...BEARER, 'x-fake-fault': 'invalid-json' });
    await assert.rejects(whole.json());
    const stalled = await post(target(), chatBody('Q'), { ...BEARER, 'x-fake-fault': 'stall-mid-stream' });
    const reader = stalled.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let seen = '';
    const quiet = Symbol('quiet');
    for (;;) {
      const next = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve(quiet), 150))]);
      if (next === quiet) break;
      const chunk = /** @type {ReadableStreamReadResult<Uint8Array>} */ (next);
      assert.equal(chunk.done, false, 'a stalled stream stays open');
      seen += decoder.decode(chunk.value, { stream: true });
    }
    assert.ok(seen.includes('data: '));
    assert.ok(!seen.includes('[DONE]'));
    await reader.cancel();
  });

  it('hangs until the client gives up', async () => {
    await assert.rejects(fetch(target(), { method: 'POST', headers: { ...BEARER, 'x-fake-fault': 'hang' }, body: '{}', signal: AbortSignal.timeout(100) }), (/** @type {any} */ err) => err.name === 'TimeoutError');
  });

  it('records requests and hides credentials in the request log', async () => {
    await post(target(), chatBody('Logged question'), BEARER);
    const log = await (await fetch(`${url.openai}/__fake/requests`)).json();
    const last = log.at(-1);
    assert.equal(last.path, '/v1/chat/completions');
    assert.equal(last.headers.authorization, '[redacted]');
    assert.equal(last.body.messages[1].content, 'Logged question');
    assert.equal(fakes.openai.requests.at(-1)?.headers.authorization, 'Bearer test-key', 'tests in the same process see the raw headers');
  });
});

describe('anthropic fake', () => {
  const messages = () => `${url.anthropic}/v1/messages`;
  /** @param {any} extra */
  const body = (extra = {}) => ({ model: 'claude-sonnet-5-5', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'Tell me about fakes' }], ...extra });

  it('needs a key and the version header, and lists models', async () => {
    assert.equal((await post(messages(), body(), { 'anthropic-version': '2023-06-01' })).status, 401);
    const noVersion = await post(messages(), body(), { 'x-api-key': 'k' });
    assert.equal(noVersion.status, 400);
    assert.equal((await noVersion.json()).error.type, 'invalid_request_error');
    const list = await (await fetch(`${url.anthropic}/v1/models`, { headers: ANTHROPIC })).json();
    assert.ok(list.data.some((/** @type {any} */ m) => m.id === 'claude-opus-5-5' && m.max_input_tokens > 0));
  });

  it('streams the Messages event sequence', async () => {
    const evs = await events(await post(messages(), body(), ANTHROPIC));
    assert.deepEqual(evs.map((e) => e.event), ['message_start', 'ping', 'content_block_start', ...evs.slice(3, -3).map(() => 'content_block_delta'), 'content_block_stop', 'message_delta', 'message_stop']);
    assert.equal(evs.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join(''), defaultAnswer('Tell me about fakes'));
    assert.equal(evs.at(-2)?.data.delta.stop_reason, 'end_turn');
    assert.equal(evs[0].data.message.model, 'claude-sonnet-5-5');
  });

  it('streams thinking with a signature, summarized or omitted', async () => {
    const summarized = await events(await post(messages(), body({ thinking: { type: 'adaptive', display: 'summarized' } }), ANTHROPIC));
    assert.equal(summarized.filter((e) => e.data.delta?.type === 'thinking_delta').map((e) => e.data.delta.thinking).join(''), REASONING_TEXT);
    const sig = summarized.find((e) => e.data.delta?.type === 'signature_delta')?.data.delta.signature;
    assert.equal(sig, signatureOf(REASONING_TEXT, 'claude-sonnet-5-5'));
    const omitted = await events(await post(messages(), body({ thinking: { type: 'adaptive' } }), ANTHROPIC));
    assert.equal(omitted.filter((e) => e.data.delta?.type === 'thinking_delta').length, 0);
    assert.ok(omitted.some((e) => e.data.delta?.type === 'signature_delta'));
    const redacted = await events(await post(messages(), body(), { ...ANTHROPIC, 'x-fake-scenario': 'redacted' }));
    assert.ok(redacted.some((e) => e.data.content_block?.type === 'redacted_thinking'));
  });

  it('streams tool_use input as JSON pieces and stops with tool_use', async () => {
    const tools = [{ name: 'look_up', description: 'Looks up.', input_schema: { type: 'object' } }];
    const evs = await events(await post(messages(), body({ tools }), { ...ANTHROPIC, 'x-fake-scenario': 'tool' }));
    const start = evs.find((e) => e.data.content_block?.type === 'tool_use')?.data.content_block;
    assert.equal(start.name, 'look_up');
    assert.deepEqual(start.input, {});
    assert.deepEqual(JSON.parse(evs.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('')), { query: 'Tell me about fakes' });
    assert.equal(evs.at(-2)?.data.delta.stop_reason, 'tool_use');
  });

  it('runs web search with results and citations, and reports search errors as result objects', async () => {
    const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }];
    const evs = await events(await post(messages(), body({ tools }), ANTHROPIC));
    const result = evs.find((e) => e.data.content_block?.type === 'web_search_tool_result')?.data.content_block;
    assert.equal(result.content.length, 2);
    assert.match(result.content[0].url, /^https:\/\/example\.com\//);
    const citations = evs.filter((e) => e.data.delta?.type === 'citations_delta').map((e) => e.data.delta.citation);
    assert.deepEqual(citations.map((c) => c.type), ['web_search_result_location', 'web_search_result_location']);
    assert.deepEqual(evs.at(-2)?.data.usage.server_tool_use, { web_search_requests: 1 });
    const failed = await events(await post(messages(), body({ tools }), { ...ANTHROPIC, 'x-fake-scenario': 'search-error' }));
    assert.equal(failed.find((e) => e.data.content_block?.type === 'web_search_tool_result')?.data.content_block.content.error_code, 'max_uses_exceeded');
  });

  it('pauses a turn and continues it when the turn is sent back', async () => {
    const tools = [{ type: 'web_search_20260209', name: 'web_search' }];
    const paused = await (await post(messages(), body({ tools, stream: false }), { ...ANTHROPIC, 'x-fake-scenario': 'pause' })).json();
    assert.equal(paused.stop_reason, 'pause_turn');
    assert.equal(paused.content.at(-1).type, 'server_tool_use');
    const resumed = await (await post(messages(), body({ tools, stream: false, messages: [{ role: 'user', content: 'Tell me about fakes' }, { role: 'assistant', content: paused.content }] }), ANTHROPIC)).json();
    assert.equal(resumed.stop_reason, 'end_turn');
    assert.equal(resumed.content[0].type, 'web_search_tool_result');
    assert.equal(resumed.content[0].tool_use_id, paused.content.at(-1).id);
  });

  it('refuses with stop details, cuts at max_tokens and can fail mid-stream', async () => {
    const refused = await (await post(messages(), body({ stream: false }), { ...ANTHROPIC, 'x-fake-scenario': 'refusal' })).json();
    assert.equal(refused.stop_reason, 'refusal');
    assert.equal(refused.stop_details.type, 'refusal');
    const long = await (await post(messages(), body({ stream: false }), { ...ANTHROPIC, 'x-fake-scenario': 'length' })).json();
    assert.equal(long.stop_reason, 'max_tokens');
    const failing = await events(await post(messages(), body(), { ...ANTHROPIC, 'x-fake-scenario': 'stream-error' }));
    assert.equal(failing.at(-1)?.event, 'error');
    assert.equal(failing.at(-1)?.data.error.type, 'overloaded_error');
  });

  it('rejects what the 5.5 models reject', async () => {
    const forced = await post(messages(), body({ tool_choice: { type: 'any' }, tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }] }), ANTHROPIC);
    assert.equal(forced.status, 400);
    assert.equal((await post(messages(), body({ model: 'claude-opus-5-5', thinking: { type: 'disabled' } }), ANTHROPIC)).status, 400);
    assert.equal((await post(messages(), body({ thinking: { type: 'enabled', budget_tokens: 2048 } }), ANTHROPIC)).status, 400);
    assert.equal((await post(messages(), body({ model: 'claude-haiku-5-5', tool_choice: { type: 'any' } }), ANTHROPIC)).status, 200);
  });

  it('answers browsers only with the direct-access header', async () => {
    const origin = 'http://127.0.0.1:4173';
    const allowed = await fetch(messages(), {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key,anthropic-version,anthropic-dangerous-direct-browser-access', 'access-control-request-private-network': 'true' },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
    assert.equal(allowed.headers.get('access-control-allow-private-network'), 'true');
    const refused = await fetch(messages(), { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key' } });
    assert.equal(refused.status, 403);
    const actual = await post(messages(), body({ stream: false }), { ...ANTHROPIC, origin, 'anthropic-dangerous-direct-browser-access': 'true' });
    assert.equal(actual.headers.get('access-control-allow-origin'), origin);
    assert.equal(actual.headers.get('cross-origin-resource-policy'), 'cross-origin', 'usable from a cross-origin-isolated page');
    const limited = await post(messages(), body(), { ...ANTHROPIC, 'x-fake-fault': '429' });
    assert.equal((await limited.json()).error.type, 'rate_limit_error');
  });
});

describe('gemini fake', () => {
  /** @param {string} method @param {string} [model] */
  const at = (method, model = 'gemini-fake-flash') => `${url.gemini}/v1beta/models/${model}:${method}`;
  /** @param {any} extra */
  const body = (extra = {}) => ({ contents: [{ role: 'user', parts: [{ text: 'Describe fakes' }] }], ...extra });

  it('takes the key only from x-goog-api-key and lists models', async () => {
    assert.equal((await post(`${at('generateContent')}?key=abc`, body(), GOOGLE)).status, 400);
    assert.equal((await post(at('generateContent'), body())).status, 401);
    const list = await (await fetch(`${url.gemini}/v1beta/models`, { headers: GOOGLE })).json();
    assert.ok(list.models.every((/** @type {any} */ m) => m.name.startsWith('models/') && Array.isArray(m.supportedGenerationMethods)));
  });

  it('streams thought parts and puts the thought signature on the first answer part', async () => {
    const evs = await events(await post(`${at('streamGenerateContent')}?alt=sse`, body({ generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' } } }), GOOGLE));
    const parts = evs.flatMap((e) => e.data.candidates?.[0]?.content?.parts ?? []);
    assert.equal(parts.filter((p) => p.thought).map((p) => p.text).join(''), REASONING_TEXT);
    const answer = parts.filter((p) => !p.thought && typeof p.text === 'string');
    assert.ok(answer[0].thoughtSignature);
    assert.equal(answer.map((p) => p.text).join(''), defaultAnswer('Describe fakes'));
    const last = evs.at(-1)?.data;
    assert.equal(last.candidates[0].finishReason, 'STOP');
    assert.ok(last.usageMetadata.thoughtsTokenCount > 0);
  });

  it('streams a JSON array without alt=sse and merges parts in generateContent', async () => {
    const array = await (await post(at('streamGenerateContent'), body(), GOOGLE)).json();
    assert.ok(Array.isArray(array) && array.length > 1);
    const whole = await (await post(at('generateContent'), body(), GOOGLE)).json();
    assert.equal(whole.candidates[0].content.parts.length, 1);
    assert.equal(whole.candidates[0].content.parts[0].text, defaultAnswer('Describe fakes'));
  });

  it('calls functions with a signature and grounds searches with byte offsets', async () => {
    const tools = [{ functionDeclarations: [{ name: 'look_up', parameters: { type: 'object' } }] }];
    const call = await (await post(at('generateContent'), body({ tools }), { ...GOOGLE, 'x-fake-scenario': 'tool' })).json();
    const part = call.candidates[0].content.parts[0];
    assert.deepEqual(part.functionCall, { name: 'look_up', args: { query: 'Describe fakes' } });
    assert.ok(part.thoughtSignature);
    const german = { contents: [{ role: 'user', parts: [{ text: 'Erkläre das bitte' }] }], tools: [{ google_search: {} }] };
    const grounded = await (await post(at('generateContent'), german, GOOGLE)).json();
    const meta = grounded.candidates[0].groundingMetadata;
    const text = grounded.candidates[0].content.parts.map((/** @type {any} */ p) => p.text).join('');
    const bytes = Buffer.from(text);
    for (const s of meta.groundingSupports) assert.equal(bytes.subarray(s.segment.startIndex, s.segment.endIndex).toString(), s.segment.text);
    assert.equal(meta.groundingChunks.length, 2);
    assert.ok(meta.searchEntryPoint.renderedContent);
  });

  it('reports safety stops, blocked prompts, length, images and speech', async () => {
    /** @param {string} scenario */
    const get = async (scenario, extra = {}) => (await post(at('generateContent'), body(extra), { ...GOOGLE, 'x-fake-scenario': scenario })).json();
    assert.equal((await get('refusal')).candidates[0].finishReason, 'SAFETY');
    assert.equal((await get('recitation')).candidates[0].finishReason, 'RECITATION');
    const blocked = await get('blocked');
    assert.equal(blocked.promptFeedback.blockReason, 'SAFETY');
    assert.equal(blocked.candidates, undefined);
    assert.equal((await get('length')).candidates[0].finishReason, 'MAX_TOKENS');
    const image = await (await post(at('generateContent', 'gemini-fake-image'), body({ generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }), GOOGLE)).json();
    assert.ok(image.candidates[0].content.parts.some((/** @type {any} */ p) => p.inlineData?.mimeType === 'image/png'));
    const speech = await (await post(at('generateContent', 'gemini-fake-tts'), body({ generationConfig: { responseModalities: ['AUDIO'] } }), GOOGLE)).json();
    assert.match(speech.candidates[0].content.parts[0].inlineData.mimeType, /^audio\/L16/);
  });

  it('puts the retry delay of a 429 in the body', async () => {
    const res = await post(at('generateContent'), body(), { ...GOOGLE, 'x-fake-fault': '429', 'x-fake-retry-after': '5' });
    const err = await res.json();
    assert.equal(err.error.status, 'RESOURCE_EXHAUSTED');
    assert.equal(err.error.details[0].retryDelay, '5s');
  });
});

describe('stream driver against the openai fake', () => {
  /**
   * A minimal Chat Completions adapter for this test only; the real adapters live elsewhere.
   * @param {Record<string, string>} [headers]
   * @returns {import('../../src/js/ai/stream.js').WireAdapter}
   */
  const chatAdapter = (headers = {}) => ({
    kind: 'wire',
    id: 'openai',
    dialect: 'openai-chat',
    buildRequest: (req) => ({
      path: '/v1/chat/completions',
      headers: { accept: 'text/event-stream', ...headers },
      body: { model: req.model, stream: true, messages: req.messages.map((m) => ({ role: m.role, content: m.content.map((p) => (p.type === 'text' ? p.text : '')).join('') })) },
    }),
    createState: () => ({ finish: /** @type {string | null} */ (null) }),
    parseEvent(sse, state) {
      if (sse.data === '[DONE]') return [{ type: 'end', stopReason: fromOpenAiChat(state.finish) }];
      const chunk = JSON.parse(sse.data);
      if (chunk.error) return [{ type: 'end', stopReason: 'error', error: new AiError('server', { providerCode: chunk.error.code }) }];
      const choice = chunk.choices?.[0];
      if (!choice) return [];
      if (choice.finish_reason) state.finish = choice.finish_reason;
      /** @type {import('../../src/js/ai/contract.js').AiEvent[]} */
      const out = [];
      if (choice.delta?.reasoning_content) out.push({ type: 'reasoning', delta: choice.delta.reasoning_content });
      if (choice.delta?.content) out.push({ type: 'text', delta: choice.delta.content });
      return out;
    },
  });
  /** @returns {import('../../src/js/ai/contract.js').AiRequest} */
  const req = () => ({ provider: 'openai', model: 'fake-model', messages: [{ role: 'user', content: [textPart('Stream please')] }] });
  /** @param {AsyncIterable<any>} it */
  const all = async (it) => {
    const out = [];
    for await (const ev of it) out.push(ev);
    return out;
  };

  it('streams text and reasoning through a direct transport', async () => {
    const evs = await all(stream(chatAdapter(), req(), directTransport(url.openai, 'test-key', undefined, { provider: 'openai' })));
    assert.equal(evs[0].type, 'start');
    assert.equal(evs.filter((e) => e.type === 'text').map((e) => e.delta).join(''), defaultAnswer('Stream please'));
    assert.deepEqual(evs.at(-1), { type: 'end', stopReason: 'end_turn' });
    const xai = await all(stream(chatAdapter({ 'x-fake-scenario': 'reasoning' }), req(), directTransport(`${url.openai}/flavor/xai`, 'test-key')));
    assert.equal(xai.filter((e) => e.type === 'reasoning').map((e) => e.delta).join(''), REASONING_TEXT);
  });

  it('turns every fault into the documented end', async () => {
    /** @param {string} fault @param {{ idleTimeoutMs?: number }} [options] */
    const endFor = async (fault, options = {}) => (await all(stream(chatAdapter({ 'x-fake-fault': fault }), req(), directTransport(url.openai, 'test-key'), options))).at(-1);
    const limited = await endFor('429');
    assert.equal(limited.error.code, 'rate_limited');
    assert.equal(limited.error.retryAfterMs, 2000);
    assert.equal((await endFor('401')).error.code, 'auth');
    assert.equal((await endFor('500')).error.code, 'server');
    assert.equal((await endFor('503')).error.code, 'server');
    assert.equal((await endFor('cut-mid-stream')).error.code, 'stream_cut');
    assert.equal((await endFor('invalid-json')).error.code, 'bad_response');
    const stalled = await endFor('stall-mid-stream', { idleTimeoutMs: 100 });
    assert.equal(stalled.stopReason, 'timeout');
    const slow = await endFor('slow-first-byte', { idleTimeoutMs: 5000 });
    assert.equal(slow.stopReason, 'end_turn');
    assert.equal((await endFor('slow-first-byte', { idleTimeoutMs: 100 })).stopReason, 'timeout');
    assert.equal((await endFor('hang', { idleTimeoutMs: 100 })).error.code, 'timeout');
    const midway = (await all(stream(chatAdapter({ 'x-fake-scenario': 'stream-error' }), req(), directTransport(url.openai, 'test-key')))).at(-1);
    assert.equal(midway.error.code, 'server');
    assert.equal(midway.error.providerCode, 'overloaded');
    const noServer = (await all(stream(chatAdapter(), req(), directTransport('http://127.0.0.1:9', 'k')))).at(-1);
    assert.equal(noServer.error.code, 'cors');
  });
});
