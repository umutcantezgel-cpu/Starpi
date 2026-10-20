// The OpenAI-compatible chat adapter and its per-provider quirks: request fields (reasoning
// controls, search, attribution headers, server extras, content shapes), recorded streams of every
// fake flavor (reasoning fields, thinking chunks, <think> tags, tool calls streamed and whole,
// annotations, usage locations, stop words, errors, a stream without [DONE]), whole JSON answers,
// runs against the fake (a tool loop, a local server without a key, Stop), and the local server
// helpers (presets, context window probe).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { defaultAnswer, REASONING_TEXT, refusalText, SEARCH_SOURCES, searchSentences } from '../../scripts/fakes/shared.mjs';
import { createAdapter } from '../../src/js/ai/adapters/index.js';
import { buildChatBody, CHAT_PATH, createChatStreamAssembler, createOpenAiChatAdapter, OPAQUE_REASONING_DETAILS, splitReasoning } from '../../src/js/ai/adapters/openai-chat.js';
import { capsFor } from '../../src/js/ai/catalog/models.js';
import { collect, validateEventSequence } from '../../src/js/ai/index.js';
import { createLocalQuirks, getQuirks, QUIRKS } from '../../src/js/ai/quirks/index.js';
import { detectServer, FALLBACK_CONTEXT_TOKENS, llamaCppContext, localApiRoot, ollamaContext, probeContextWindow } from '../../src/js/ai/quirks/local.js';
import { XAI_SEARCH_VERIFIED } from '../../src/js/ai/quirks/xai.js';
import { stream } from '../../src/js/ai/stream.js';
import { directTransport } from '../../src/js/ai/transport.js';
import { NVIDIA_DEFAULT_MODEL, NVIDIA_MODELS } from '../../src/js/models/nvidia-catalog.js';
import { fixture, joined, LOOKUP, ofType, replay, request, run } from '../fixtures/ai/replay.mjs';

/**
 * @param {any} provider
 * @param {any} req
 * @param {any} [quirks]
 */
const bodyOf = (provider, req, quirks = getQuirks(provider === 'local' ? 'local' : provider)) => buildChatBody(req, provider, quirks, capsFor(provider, req.model));
const PNG = 'iVBORw0KGgo=';
const PDF = Buffer.from('%PDF-1.4 tiny').toString('base64');

describe('openai chat adapter: request body and quirks', () => {
  it('builds plain Chat Completions with usage, tools, a JSON format and string content', () => {
    const adapter = createOpenAiChatAdapter();
    const built = adapter.buildRequest(request('local', 'any-model', 'Hi', { system: 'Be brief.', tools: [LOOKUP], toolChoice: 'auto', maxOutputTokens: 300, temperature: 0.2, responseFormat: { type: 'json_schema', schema: { type: 'object' } } }));
    assert.equal(built.path, CHAT_PATH);
    const body = /** @type {any} */ (built.body);
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.max_tokens, 300);
    assert.equal(body.temperature, 0.2);
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'lookup', description: LOOKUP.description, parameters: LOOKUP.schema } }]);
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'response', schema: { type: 'object' }, strict: false } });
  });

  it('sends images where they can be read, PDFs only as file parts, text files inline', () => {
    const msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'Look.' },
        { type: 'image', mime: 'image/png', data: PNG },
        { type: 'file', mime: 'application/pdf', data: PDF, name: 'a.pdf' },
        { type: 'file', mime: 'text/markdown', data: Buffer.from('# Title').toString('base64'), name: 'b.md' },
      ],
    };
    const router = bodyOf('openrouter', { provider: 'openrouter', model: 'openrouter/auto', messages: [msg] }).messages[0].content;
    assert.deepEqual(router.map((/** @type {any} */ p) => p.type), ['text', 'image_url', 'file', 'text']);
    assert.deepEqual(router[2], { type: 'file', file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${PDF}` } });
    assert.equal(router[3].text, 'b.md\n\n# Title');
    // A verified text-only model gets no image; without image parts the content is a string again.
    const text = bodyOf('deepseek', { provider: 'deepseek', model: 'deepseek-chat', messages: [msg] }).messages[0].content;
    assert.equal(text, 'Look.\n\nb.md\n\n# Title');
  });

  it('replays tool calls and results, never reasoning text, and OpenRouter reasoning details', () => {
    const details = [{ type: 'reasoning.encrypted', data: 'abc', index: 0 }];
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Find it.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_call', id: 'c1', name: 'lookup', args: { query: 'x' } },
          { type: 'opaque', provider: 'openrouter', model: 'openrouter/auto', block: { kind: OPAQUE_REASONING_DETAILS, details } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', id: 'c1', content: 'X' }] },
    ];
    const router = bodyOf('openrouter', { provider: 'openrouter', model: 'openrouter/auto', messages });
    assert.deepEqual(router.messages[1], { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"query":"x"}' } }], reasoning_details: details });
    assert.deepEqual(router.messages[2], { role: 'tool', tool_call_id: 'c1', content: 'X' });
    const deepseek = bodyOf('deepseek', { provider: 'deepseek', model: 'deepseek-reasoner', messages });
    assert.ok(!JSON.stringify(deepseek).includes('reasoning'), 'DeepSeek never gets reasoning back');
  });

  it('xAI: two-level reasoning effort where the catalog allows it, and no search until verified', () => {
    assert.equal(bodyOf('xai', request('xai', 'grok-3-mini', 'Hi', { thinking: { mode: 'on' } })).reasoning_effort, 'high');
    assert.equal(bodyOf('xai', request('xai', 'grok-3-mini', 'Hi', { thinking: { mode: 'off' } })).reasoning_effort, 'low');
    assert.equal(bodyOf('xai', request('xai', 'grok-3-mini', 'Hi')).reasoning_effort, undefined);
    assert.equal(bodyOf('xai', request('xai', 'grok-4', 'Hi', { thinking: { mode: 'on' } })).reasoning_effort, undefined);
    assert.equal(XAI_SEARCH_VERIFIED, false);
    const searched = bodyOf('xai', request('xai', 'grok-4', 'Hi', { search: { enabled: true } }));
    assert.equal(searched.search_parameters, undefined);
    assert.equal(searched.tools, undefined);
  });

  it('Groq: reasoning switches per model family', () => {
    const oss = bodyOf('groq', request('groq', 'openai/gpt-oss-20b', 'Hi', { thinking: { mode: 'on', effort: 'medium' } }));
    assert.equal(oss.include_reasoning, true);
    assert.equal(oss.reasoning_effort, 'medium');
    assert.equal(oss.reasoning_format, undefined);
    const qwen = bodyOf('groq', request('groq', 'qwen/qwen3-32b', 'Hi', { thinking: { mode: 'off' } }));
    assert.equal(qwen.reasoning_format, 'hidden');
    assert.equal(qwen.reasoning_effort, 'none');
    assert.equal(bodyOf('groq', request('groq', 'qwen/qwen3-32b', 'Hi')).reasoning_format, 'parsed');
    const plain = bodyOf('groq', request('groq', 'llama-3.3-70b-versatile', 'Hi', { thinking: { mode: 'on' } }));
    assert.equal(plain.reasoning_format, undefined);
    assert.equal(plain.include_reasoning, undefined);
  });

  it('Mistral leaves out stream options; OpenRouter adds attribution, reasoning and the web plugin', () => {
    assert.equal(bodyOf('mistral', request('mistral', 'mistral-small-latest', 'Hi')).stream_options, undefined);
    const built = createAdapter('openrouter').buildRequest?.(request('openrouter', 'openrouter/auto', 'Hi', { thinking: { mode: 'on', show: false }, search: { enabled: true, maxUses: 3 } }));
    assert.equal(built?.headers?.['HTTP-Referer'], 'https://www.starpi.app');
    assert.equal(built?.headers?.['X-Title'], 'Starpi');
    const body = /** @type {any} */ (built?.body);
    assert.deepEqual(body.reasoning, { effort: 'high', exclude: true });
    assert.deepEqual(body.plugins, [{ id: 'web', max_results: 3 }]);
    assert.equal(bodyOf('openrouter', request('openrouter', 'openrouter/auto', 'Hi', { thinking: { mode: 'off' } })).reasoning, undefined);
  });

  it('NVIDIA: the catalog fixes extras and the default output budget per model', () => {
    const body = bodyOf('nvidia', request('nvidia', NVIDIA_DEFAULT_MODEL, 'Hi'));
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.max_tokens, NVIDIA_MODELS.find((m) => m.id === NVIDIA_DEFAULT_MODEL)?.defaultMaxTokens);
    const other = bodyOf('nvidia', request('nvidia', 'z-ai/glm-5.3', 'Hi'));
    assert.equal(other.chat_template_kwargs, undefined);
  });

  it('local servers: keep_alive for Ollama, cache_prompt for llama.cpp, reasoning off only when asked', () => {
    const req = request('local', 'qwen3:8b', 'Hi', { thinking: { mode: 'off' } });
    assert.equal(bodyOf('local', req, createLocalQuirks({ server: 'ollama' })).keep_alive, '30m');
    assert.equal(bodyOf('local', req, createLocalQuirks({ server: 'llamacpp' })).cache_prompt, true);
    const plain = bodyOf('local', req, createLocalQuirks({ server: 'vllm' }));
    assert.equal(plain.keep_alive, undefined);
    assert.equal(plain.cache_prompt, undefined);
    assert.equal(plain.reasoning_effort, undefined);
    assert.equal(bodyOf('local', req, createLocalQuirks({ server: 'ollama', reasoningOff: true })).reasoning_effort, 'none');
    assert.deepEqual(Object.keys(QUIRKS).sort(), ['deepseek', 'generic', 'groq', 'local', 'minimax', 'mistral', 'nvidia', 'openrouter', 'xai']);
  });
});

describe('openai chat adapter: recorded streams', () => {
  /**
   * @param {string} name
   * @param {any} provider
   * @param {string} model
   */
  const events = (name, provider, model) => replay(createAdapter(provider), request(provider, model, 'x'), fixture('openai-chat', name));

  for (const [name, provider, model] of /** @type {const} */ ([
    ['xai-reasoning', 'xai', 'fake-grok-reasoner'],
    ['groq-reasoning', 'groq', 'fake-groq-reasoner'],
    ['mistral-reasoning', 'mistral', 'fake-mistral-reasoner'],
    ['deepseek-reasoning', 'deepseek', 'fake-deepseek-reasoner'],
    ['openrouter-reasoning', 'openrouter', 'fake/router-reasoner:free'],
    ['ollama-reasoning', 'local', 'fake-local-reasoner:4b'],
  ])) {
    it(`${name}: reasoning and answer arrive apart`, () => {
      const evs = events(name, provider, model);
      assert.deepEqual(validateEventSequence(evs), []);
      assert.equal(evs[0].model, model);
      assert.equal(joined(evs, 'reasoning'), REASONING_TEXT);
      assert.equal(joined(evs, 'text'), defaultAnswer('Think first'));
      assert.equal(evs.at(-1).stopReason, 'end_turn');
      assert.ok(ofType(evs, 'usage').length <= 1);
    });
  }

  it('reads usage from the last chunk, including Groq x_groq', () => {
    const groq = ofType(events('groq-reasoning', 'groq', 'fake-groq-reasoner'), 'usage');
    assert.equal(groq.length, 1);
    assert.ok(groq[0].input > 0 && groq[0].output > 0 && groq[0].reasoning > 0);
    const openai = ofType(events('openai-text', 'local', 'fake-gpt-small'), 'usage');
    assert.equal(openai.length, 1);
  });

  it('keeps OpenRouter reasoning details as opaque state', () => {
    const [opaque] = ofType(events('openrouter-reasoning', 'openrouter', 'fake/router-reasoner:free'), 'opaque');
    assert.equal(opaque.block.kind, OPAQUE_REASONING_DETAILS);
    assert.equal(opaque.block.details.length, 1);
    assert.equal(opaque.block.details[0].text, REASONING_TEXT);
  });

  it('reads tool calls streamed in pieces and sent whole', () => {
    const pieces = events('openai-tool', 'local', 'fake-gpt-small');
    const calls = ofType(pieces, 'tool_call');
    assert.ok(calls.filter((c) => c.argsDelta).length > 1);
    assert.deepEqual(calls.at(-1), { type: 'tool_call', id: calls[0].id, name: 'lookup', args: { query: 'Look it up' }, final: true });
    assert.equal(pieces.at(-1).stopReason, 'tool_call');
    const whole = ofType(events('mistral-tool', 'mistral', 'fake-mistral-small'), 'tool_call');
    assert.deepEqual(whole.at(-1).args, { query: 'Look it up' });
    assert.match(whole[0].id, /^fk\d+$/);
  });

  it('turns annotations into citations', () => {
    const evs = events('openrouter-search', 'openrouter', 'fake/router-small');
    const text = joined(evs, 'text');
    const sentences = searchSentences('Search the topic');
    const cites = ofType(evs, 'citation');
    assert.equal(cites.length, 2);
    cites.forEach((c, i) => {
      assert.equal(c.url, SEARCH_SOURCES[sentences[i].source].url);
      assert.equal(text.slice(c.start, c.end), sentences[i].text.trim());
    });
  });

  it('maps stop words: content_filter, a provider length word, and an error inside the stream', () => {
    const refusal = events('openai-refusal', 'local', 'fake-gpt-small');
    assert.equal(joined(refusal, 'text'), refusalText('Declined'));
    assert.equal(refusal.at(-1).stopReason, 'refusal');
    assert.equal(events('mistral-length', 'mistral', 'fake-mistral-small').at(-1).stopReason, 'max_tokens');
    const failed = events('stream-error', 'xai', 'fake-grok-fast');
    assert.deepEqual(validateEventSequence(failed), []);
    assert.equal(failed.at(-1).error.code, 'server');
    assert.equal(failed.at(-1).error.provider, 'xai');
  });

  it('splits <think> tags across deltas and ends a stream that closes without [DONE]', () => {
    const evs = events('ollama-split-tags', 'local', 'fake-local:8b');
    assert.deepEqual(validateEventSequence(evs), []);
    assert.equal(joined(evs, 'reasoning'), 'Plan it');
    assert.equal(joined(evs, 'text'), 'The answer is short. a < b');
    assert.equal(evs.at(-1).stopReason, 'end_turn');
  });

  it('counts a stream cut before any finish reason as incomplete', () => {
    const adapter = createAdapter('xai');
    const state = /** @type {any} */ (adapter).createState(request('xai', 'm', 'x'));
    /** @type {any} */ (adapter).parseEvent({ event: 'message', data: JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { content: 'Hal' } }] }) }, state);
    assert.deepEqual(/** @type {any} */ (adapter).finish(state), []);
  });

  it('reads a whole JSON answer, including thinking chunks', () => {
    const adapter = createAdapter('mistral');
    const json = { model: 'magistral-medium-latest', choices: [{ index: 0, message: { role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Plan.' }] }, { type: 'text', text: 'Done.' }] }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } };
    const evs = /** @type {any} */ (adapter).parseResponse(json, /** @type {any} */ (adapter).createState(request('mistral', 'magistral-medium-latest', 'x')));
    assert.deepEqual(validateEventSequence(evs), []);
    assert.equal(joined(evs, 'reasoning'), 'Plan.');
    assert.equal(joined(evs, 'text'), 'Done.');
  });

  it('keeps the 2.x chunk fold and splitReasoning available from the dialect module', () => {
    const fold = createChatStreamAssembler();
    fold.push(JSON.stringify({ choices: [{ delta: { reasoning_content: 'R' } }] }));
    fold.push(JSON.stringify({ choices: [{ delta: { content: 'A' } }] }));
    assert.equal(fold.text(), '<think>R</think>\n\nA');
    assert.deepEqual(splitReasoning('<think>R</think>A'), { thoughts: 'R', answer: 'A' });
  });
});

describe('openai chat adapter: end to end against the fake', () => {
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

  for (const [flavor, provider] of /** @type {const} */ ([
    ['xai', 'xai'],
    ['groq', 'groq'],
    ['mistral', 'mistral'],
    ['deepseek', 'deepseek'],
    ['openrouter', 'openrouter'],
    ['nvidia', 'nvidia'],
  ])) {
    it(`${flavor}: a tool loop through the direct transport`, async () => {
      const t = directTransport(`${url}/flavor/${flavor}`, 'test-key', undefined, { provider });
      const adapter = createAdapter(provider);
      const first = request(provider, 'fake-model', 'Look it up [[fake:tool]]', { tools: [LOOKUP] });
      const evs = await run(adapter, first, t);
      assert.deepEqual(validateEventSequence(evs), []);
      const r1 = await collect(evs);
      assert.equal(r1.stopReason, 'tool_call');
      const call = r1.toolCalls[0];
      assert.deepEqual(call.args, { query: 'Look it up' });
      const second = {
        ...first,
        messages: [...first.messages, { role: 'assistant', content: [{ type: 'tool_call', id: call.id, name: call.name, args: call.args ?? {} }] }, { role: 'tool', content: [{ type: 'tool_result', id: call.id, content: 'A word.' }] }],
      };
      const r2 = await collect(await run(adapter, /** @type {any} */ (second), t));
      assert.equal(r2.stopReason, 'end_turn');
      assert.ok(r2.text.length > 0);
      const sent = fake.requests.at(-1);
      assert.equal(sent?.headers.authorization, 'Bearer test-key');
      assert.deepEqual(sent?.body.messages.at(-1), { role: 'tool', tool_call_id: call.id, content: 'A word.' });
    });
  }

  it('a local server without a key gets no auth header and its extras', async () => {
    const t = directTransport(`${url}/flavor/ollama`, null, undefined, { provider: 'local' });
    const adapter = createAdapter('local', { local: { server: 'ollama' } });
    const r = await collect(await run(adapter, request('local', 'fake-local:8b', 'Hello'), t));
    assert.equal(r.text, defaultAnswer('Hello'));
    const sent = fake.requests.at(-1);
    assert.equal(sent?.headers.authorization, undefined);
    assert.equal(sent?.body.keep_alive, '30m');
  });

  it('maps an unknown model to not_found and a missing key to auth', async () => {
    const lost = await collect(await run(createAdapter('groq'), request('groq', 'fake-model', 'Hi [[fake-fault:404]]'), directTransport(`${url}/flavor/groq`, 'test-key', undefined, { provider: 'groq' })));
    assert.equal(lost.error?.code, 'not_found');
    const keyless = await collect(await run(createAdapter('groq'), request('groq', 'fake-model', 'Hi'), directTransport(`${url}/flavor/groq`, null, undefined, { provider: 'groq' })));
    assert.equal(keyless.error?.code, 'auth');
  });

  it('stops in the middle of a stream', async () => {
    const t = directTransport(`${slowUrl}/flavor/deepseek`, 'test-key', undefined, { provider: 'deepseek' });
    const controller = new AbortController();
    const evs = [];
    for await (const ev of stream(createAdapter('deepseek'), request('deepseek', 'fake-deepseek-chat', 'Tell me a longer story about it'), t, { signal: controller.signal })) {
      evs.push(ev);
      if (ev.type === 'text') controller.abort();
    }
    assert.deepEqual(validateEventSequence(evs), []);
    assert.equal(evs.at(-1).stopReason, 'cancelled');
    assert.equal(ofType(evs, 'text').length, 1);
  });

  it('probes the context window of an Ollama server', async () => {
    const probe = await probeContextWindow(`${url}/flavor/ollama/v1`, { model: 'fake-local:8b' });
    assert.deepEqual(probe, { contextTokens: 8192, source: 'ollama' });
  });
});

describe('local server helpers', () => {
  /** @type {import('node:http').Server} */
  let props;
  let propsUrl = '';
  before(async () => {
    props = createServer((req, res) => {
      res.writeHead(req.url === '/props' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/props' ? { default_generation_settings: { n_ctx: 16384 } } : { error: 'no' }));
    });
    await new Promise((resolve) => props.listen(0, '127.0.0.1', () => resolve(undefined)));
    propsUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (props.address()).port}`;
  });
  after(async () => {
    props.closeAllConnections();
    await new Promise((resolve) => props.close(() => resolve(undefined)));
  });

  it('reads llama.cpp props and falls back to 4096 when nothing answers', async () => {
    assert.deepEqual(await probeContextWindow(propsUrl, { server: 'llamacpp' }), { contextTokens: 16384, source: 'llamacpp' });
    assert.deepEqual(await probeContextWindow('http://127.0.0.1:9/v1', { model: 'x', timeoutMs: 500 }), { contextTokens: FALLBACK_CONTEXT_TOKENS, source: 'fallback' });
    assert.deepEqual(await probeContextWindow('not a url'), { contextTokens: 4096, source: 'fallback' });
  });

  it('parses context sizes and recognizes the preset servers', () => {
    assert.equal(ollamaContext({ parameters: 'stop "<|end|>"\nnum_ctx 8192', model_info: { 'llama.context_length': 4096 } }), 4096);
    assert.equal(ollamaContext({ model_info: { 'llama.context_length': 131072 } }), null, 'without num_ctx the server default applies');
    assert.equal(llamaCppContext({ n_ctx: 2048 }), 2048);
    assert.equal(llamaCppContext({}), null);
    assert.equal(detectServer('http://localhost:11434/v1'), 'ollama');
    assert.equal(detectServer('http://127.0.0.1:1234'), 'lmstudio');
    assert.equal(detectServer('http://192.168.1.20:8000/v1/'), 'vllm');
    assert.equal(detectServer('http://localhost:8080'), 'llamacpp');
    assert.equal(detectServer('http://localhost:5000'), 'other');
    assert.equal(localApiRoot('http://localhost:11434/v1/'), 'http://localhost:11434');
    assert.equal(localApiRoot('http://user:pw@localhost:1234'), null);
    assert.equal(localApiRoot('file:///etc/passwd'), null);
  });
});
