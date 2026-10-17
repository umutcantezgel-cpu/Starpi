// The purpose router walks its chain with a fake clock and scripted providers: a 429 cools the
// model down and the next model answers, then the next provider, then the device, then the cached
// answer, then the template. A rejected answer gets exactly one retry that names the problems; an
// answer cut off at the token limit gets none. Cached answers never cross between simulated and
// real providers, and every call, skip and switch is visible in the attempts.
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AiError } from '../../src/js/ai/errors.js';
import { fromOpenAiChat } from '../../src/js/ai/stop-reason.js';
import { complete } from '../../src/js/ai/index.js';
import { directTransport } from '../../src/js/ai/transport.js';
import { getPurpose, purposeMarker } from '../../src/js/ai/purposes.js';
import { cachedPurpose, hashInput, planChain, purposeCacheKey, runPurpose, stableJson } from '../../src/js/ai/router.js';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { fakeClock, lastUserText, scriptedProviders, systemText, testDeps } from './router-fakes.mjs';

const QUESTION = { question: 'When does the reading club meet?' };
const GOOD = JSON.stringify({ queries: ['reading club meeting time'] });

/** Only two models per provider, so the chains stay short and readable. */
const LIVE = /** @type {Record<string, string[]>} */ ({ openai: ['gpt-5-nano', 'gpt-5-mini'], anthropic: ['claude-haiku-5-5'] });

describe('runPurpose: the fallback chain with a fake clock', () => {
  it('goes 429 -> next model -> next provider -> device -> cache -> template', async () => {
    const clock = fakeClock();
    /** @type {Record<string, (index: number) => import('./router-fakes.mjs').Scripted>} */
    let behave = {
      'openai:gpt-5-nano': () => ({ error: 'rate_limited', retryAfterMs: 7000 }),
      'openai:gpt-5-mini': () => ({ text: GOOD }),
    };
    const providers = scriptedProviders((call, i) => behave[`${call.provider}:${call.model}`]?.(i) ?? { error: 'server' }, clock);
    let deviceLoaded = true;
    const deps = testDeps(providers, clock, {
      configured: () => ['openai', 'anthropic'],
      liveModels: (p) => LIVE[p] ?? [],
      selection: (p) => (p === 'openai' ? { provider: 'openai', model: 'gpt-5-nano' } : null),
      device: () => (deviceLoaded ? { provider: 'webgpu', model: 'auto' } : null),
    });

    // 1. The selected model is rate limited: the next model of the role answers, and says so.
    const first = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.equal(first.ok, true);
    assert.deepEqual(first.value, { queries: ['reading club meeting time'] });
    assert.equal(first.tier, 'role');
    assert.equal(first.model, 'gpt-5-mini');
    assert.deepEqual(first.attempts.map((a) => [a.tier, a.model, a.outcome]), [['selected', 'gpt-5-nano', 'rate_limited'], ['role', 'gpt-5-mini', 'ok']]);
    assert.equal(first.attempts[0].code, 'rate_limited');
    assert.equal(first.fallbackReason, 'rate_limited');

    // 2. Within the Retry-After the cooling model is skipped without a call.
    const before = providers.calls.length;
    const second = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off' });
    assert.deepEqual(second.attempts.map((a) => [a.model, a.outcome, a.blocked]), [['gpt-5-nano', 'skipped', 'cooldown'], ['gpt-5-mini', 'ok', undefined]]);
    assert.equal(providers.calls.length - before, 1);

    // 3. After the Retry-After it is called again.
    clock.advance(7001);
    behave['openai:gpt-5-nano'] = () => ({ text: GOOD });
    const third = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off' });
    assert.equal(third.tier, 'selected');
    assert.equal(third.model, 'gpt-5-nano');

    // 4. Every model of the first provider fails: the next provider answers.
    behave = { 'anthropic:claude-haiku-5-5': () => ({ text: GOOD }) };
    const fourth = await runPurpose('query_rewrite', { question: 'Who leads the club?' }, { deps });
    assert.equal(fourth.tier, 'provider');
    assert.equal(fourth.provider, 'anthropic');
    assert.deepEqual(fourth.attempts.map((a) => a.outcome), ['error', 'error', 'ok']);

    // 5. Every remote model fails: the loaded on-device model answers.
    behave = { 'webgpu:auto': () => ({ text: `<think>short</think>${GOOD}` }) };
    const fifth = await runPurpose('query_rewrite', { question: 'Where does the club meet?' }, { deps });
    assert.equal(fifth.tier, 'device');
    assert.equal(fifth.provider, 'webgpu');
    assert.equal(fifth.simulated, false);
    const deviceCall = providers.calls.at(-1);
    assert.equal(deviceCall?.req.responseFormat, undefined, 'the browser engines get no response format');

    // 6. Nothing answers, not even the device: the answer stored in step 4 stands in.
    behave = {};
    deviceLoaded = false;
    const sixth = await runPurpose('query_rewrite', { question: 'Who leads the club?' }, { deps });
    assert.equal(sixth.tier, 'cache');
    assert.equal(sixth.ok, true);
    assert.equal(sixth.provider, 'anthropic');
    assert.deepEqual(sixth.value, { queries: ['reading club meeting time'] });
    assert.equal(typeof sixth.cachedAt, 'number');
    assert.ok(sixth.attempts.length > 0, 'the failed calls stay visible');

    // 7. No cached answer either: the template. query_rewrite has a deterministic one.
    const seventh = await runPurpose('query_rewrite', { question: 'What does the club read next?' }, { deps });
    assert.equal(seventh.tier, 'template');
    assert.equal(seventh.ok, false);
    assert.deepEqual(seventh.value, { queries: ['What does the club read next?'] });
    assert.equal(seventh.provider, null);

    // 8. A purpose without a deterministic answer is { unavailable }.
    const eighth = await runPurpose('summarize_doc', { text: 'The club meets every second Tuesday.' }, { deps });
    assert.equal(eighth.tier, 'template');
    assert.equal(eighth.unavailable, true);
    assert.equal(eighth.text, undefined);
  });

  it('opens the breaker after three failures and probes again once the open time is over', async () => {
    const clock = fakeClock();
    let healthy = false;
    const providers = scriptedProviders(() => (healthy ? { text: GOOD } : { error: 'server' }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano'] });
    for (let i = 0; i < 3; i += 1) await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off' });
    assert.equal(providers.calls.length, 3);
    const open = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off' });
    assert.deepEqual(open.attempts.map((a) => [a.outcome, a.blocked]), [['skipped', 'circuit_open']]);
    assert.equal(providers.calls.length, 3, 'an open circuit makes no call');
    clock.advance(60_000);
    healthy = true;
    const probe = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off' });
    assert.equal(probe.ok, true);
    assert.equal(deps.wheel.status('openai', 'gpt-5-nano').circuit, 'closed');
  });
});

describe('runPurpose: validation and retries', () => {
  it('retries once with a message that names the problems, then accepts the corrected answer', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders((_call, i) => (i === 0 ? { text: 'Sure! Here you go: {"query": "club"}' } : { text: GOOD }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano'] });
    const res = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.equal(res.ok, true);
    assert.deepEqual(res.attempts.map((a) => [a.outcome, a.retry ?? false]), [['invalid', false], ['ok', true]]);
    assert.ok(res.attempts[0].errors?.includes('schema:$:required:queries'));
    assert.equal(providers.calls.length, 2);
    const retry = providers.calls[1].req;
    assert.match(lastUserText(retry), /could not be used/);
    assert.match(lastUserText(retry), /"queries" is missing/);
    const replayed = retry.messages.at(-2);
    assert.equal(replayed?.role, 'assistant', 'the rejected answer is shown back to the model');
    assert.equal(deps.wheel.status('openai', 'gpt-5-nano').circuit, 'closed', 'a rejected answer does not count against the model');
  });

  it('gives a model only one retry, then moves on to the next model', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders((call) => (call.model === 'gpt-5-mini' ? { text: GOOD } : { text: 'no json here' }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano', 'gpt-5-mini'] });
    const res = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.equal(res.model, 'gpt-5-mini');
    assert.deepEqual(res.attempts.map((a) => [a.model, a.outcome, a.retry ?? false]), [['gpt-5-nano', 'invalid', false], ['gpt-5-nano', 'invalid', true], ['gpt-5-mini', 'ok', false]]);
    assert.deepEqual(res.attempts[0].errors, ['no_json']);
  });

  it('never retries an answer cut off at the token limit', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders((call) => (call.model === 'gpt-5-nano' ? { text: '{"queries": ["clu', stop: 'max_tokens' } : { text: GOOD }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano', 'gpt-5-mini'] });
    const res = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.deepEqual(res.attempts.map((a) => [a.model, a.outcome]), [['gpt-5-nano', 'truncated'], ['gpt-5-mini', 'ok']]);
    assert.equal(providers.calls.filter((c) => c.model === 'gpt-5-nano').length, 1);
    assert.equal(res.fallbackReason, 'truncated');
  });

  it('sends the purpose marker, the decoder schema and the limits with every call', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders(() => ({ text: GOOD }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano'] });
    await runPurpose('query_rewrite', QUESTION, { deps, locale: 'de' });
    const req = providers.calls[0].req;
    assert.ok(systemText(req).includes(purposeMarker('query_rewrite')));
    assert.match(systemText(req), /Suchanfragen/);
    assert.equal(req.maxOutputTokens, getPurpose('query_rewrite')?.maxTokens);
    assert.equal(req.temperature, 0.1);
    assert.equal(req.timeoutMs, 12_000);
    assert.equal(req.responseFormat?.type, 'json_schema');
    assert.doesNotMatch(JSON.stringify(req.responseFormat), /minLength|maxLength/);
  });

  it('records the model that served when the provider answered with another one', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders(() => ({ text: GOOD, served: 'gpt-5-mini-2026' }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano'] });
    const res = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.equal(res.model, 'gpt-5-mini-2026');
    assert.equal(res.attempts[0].model, 'gpt-5-nano');
    assert.equal(res.attempts[0].served, 'gpt-5-mini-2026');
  });

  it('ends every call to a provider whose key fails, and reports it', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders((call) => (call.provider === 'openai' ? { error: 'auth' } : { text: GOOD }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai', 'anthropic'], liveModels: (p) => LIVE[p] ?? [] });
    const res = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.deepEqual(res.attempts.map((a) => [a.provider, a.outcome]), [['openai', 'unavailable'], ['anthropic', 'ok']]);
    assert.equal(res.fallbackReason, 'auth');
  });

  it('does not count a timeout the run budget caused against the model', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders(() => ({ error: 'timeout' }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano'] });
    for (let i = 0; i < 4; i += 1) await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off', deadlineMs: 2000 });
    assert.equal(providers.calls.at(-1)?.req.timeoutMs, 2000, 'the call gets only what is left of the budget');
    assert.equal(deps.wheel.status('openai', 'gpt-5-nano').failures, 0);
    for (let i = 0; i < 3; i += 1) await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off' });
    assert.equal(deps.wheel.status('openai', 'gpt-5-nano').circuit, 'open', 'a timeout within the purpose limit counts');
  });

  it('stops at the call limit and when the budget is spent', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders(() => ({ text: 'nope', advanceMs: 1500 }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai', 'anthropic'], liveModels: (p) => LIVE[p] ?? [] });
    const limited = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off', maxCalls: 3 });
    assert.equal(limited.attempts.length, 3);
    assert.equal(limited.tier, 'template');
    const budget = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off', deadlineMs: 2000 });
    assert.equal(budget.attempts.length, 2, 'the second call starts with 500 ms left, a third never starts');
  });
});

describe('runPurpose: cache, simulated providers and the template', () => {
  it('never serves a simulated answer for a real provider or the other way round', async () => {
    const clock = fakeClock();
    let simulated = true;
    let up = true;
    const providers = scriptedProviders(() => (up ? { text: GOOD } : { error: 'server' }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['nvidia'], liveModels: () => ['nvidia/nemotron-3.5-lightning-30b-a3b'], simulated: () => simulated });
    const made = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.equal(made.simulated, true);
    up = false;
    simulated = false;
    const real = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.equal(real.tier, 'template', 'the simulated answer does not stand in for the real provider');
    simulated = true;
    clock.advance(120_000);
    const again = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.equal(again.tier, 'cache');
    assert.equal(again.simulated, true);
    assert.equal(cachedPurpose('query_rewrite', QUESTION, { deps: { ...deps, simulated: () => null }, locale: 'en' }), null, 'unknown simulation state: nothing is shown');
  });

  it('answers from the cache without a call when asked to prefer it', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders(() => ({ text: GOOD }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano'] });
    await runPurpose('query_rewrite', QUESTION, { deps });
    const res = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'prefer' });
    assert.equal(res.tier, 'cache');
    assert.equal(providers.calls.length, 1);
    assert.equal(deps.cache.get(purposeCacheKey('query_rewrite', 'en', hashInput(QUESTION)))?.provider, 'openai');
    const german = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'prefer', locale: 'de' });
    assert.notEqual(german.tier, 'cache', 'the language is part of the key');
  });

  it('answers a grounded question without a model by quoting the sources', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders(() => ({ error: 'network' }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano'] });
    const hits = [{ documentId: '1', documentTitle: 'Club handbook', heading: '', content: 'The reading club meets every second Tuesday in the library.', tags: [], rank: 1 }];
    const citations = [{ label: '[Doc: Club handbook, Chunk: 1]', text: hits[0].content, truncated: false }];
    const res = await runPurpose('summarize_doc', { text: hits[0].content }, { deps, grounding: { query: 'When does the reading club meet?', hits, citations, knownTitles: [] } });
    assert.equal(res.tier, 'template');
    assert.match(res.text ?? '', /every second Tuesday/);
    assert.match(res.text ?? '', /Club handbook/);
  });

  it('turns an input a purpose cannot take into the template without any call', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders(() => ({ text: GOOD }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'] });
    const res = await runPurpose('query_rewrite', { question: '   ' }, { deps });
    assert.equal(res.fallbackReason, 'invalid_input');
    assert.equal(providers.calls.length, 0);
    await assert.rejects(runPurpose('no_such_purpose', {}, { deps }), TypeError);
  });

  it('rejects with an AbortError when the caller stops, without falling back', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const providers = scriptedProviders(async () => {
      controller.abort();
      return { text: GOOD };
    }, clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano', 'gpt-5-mini'] });
    await assert.rejects(runPurpose('query_rewrite', QUESTION, { deps, signal: controller.signal }), (err) => err instanceof DOMException && err.name === 'AbortError');
    assert.equal(providers.calls.length, 1);
    await assert.rejects(runPurpose('query_rewrite', QUESTION, { deps, signal: AbortSignal.abort() }), { name: 'AbortError' });
  });
});

describe('planChain', () => {
  it('orders selected, role fallback, the next providers and the device without repeats', () => {
    const clock = fakeClock();
    const deps = testDeps(scriptedProviders(() => ({})), clock, {
      configured: () => ['openai', 'anthropic'],
      selection: (p) => (p === 'anthropic' ? { provider: 'anthropic', model: 'claude-sonnet-5-5' } : null),
      device: () => ({ provider: 'webgpu', model: 'auto' }),
    });
    const def = /** @type {import('../../src/js/ai/purposes.js').PurposeDef} */ (getPurpose('query_rewrite'));
    const steps = planChain(def, { provider: 'openai', model: 'gpt-5' }, deps);
    assert.deepEqual(
      steps.map((s) => `${s.tier}:${s.provider}:${s.model}:${s.role}`),
      [
        'selected:openai:gpt-5:fast',
        'role:openai:gpt-5-nano:fast',
        'role:openai:gpt-5-mini:fast',
        'provider:anthropic:claude-sonnet-5-5:fast',
        'provider:anthropic:claude-haiku-5-5:fast',
        'provider:anthropic:claude-opus-5-5:reasoning',
        'device:webgpu:auto:null',
      ],
    );
    assert.deepEqual(planChain(def, { provider: 'openai', model: 'gpt-5', fallback: false }, deps).map((s) => s.model), ['gpt-5']);
    const vision = /** @type {import('../../src/js/ai/purposes.js').PurposeDef} */ (getPurpose('ocr_image'));
    const visionSteps = planChain(vision, {}, { ...deps, caps: (_p, m) => /** @type {any} */ ({ vision: m !== 'gpt-5-mini' }) });
    assert.ok(!visionSteps.some((s) => s.model === 'gpt-5-mini'), 'a model without vision never gets an image');
    assert.ok(!visionSteps.some((s) => s.tier === 'device'), 'images never go to the device');
  });

  it('puts a slow fast model behind the other fast models', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders((call) => (call.model === 'gpt-5-nano' ? { text: GOOD, advanceMs: 9000 } : { text: GOOD }), clock);
    const deps = testDeps(providers, clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano', 'gpt-5-mini'] });
    const slow = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off' });
    assert.equal(slow.model, 'gpt-5-nano');
    const next = await runPurpose('query_rewrite', QUESTION, { deps, cache: 'off' });
    assert.equal(next.model, 'gpt-5-mini', 'the model that took 9 s for a short call waits behind the others');
  });

  it('keys inputs by stable JSON', () => {
    assert.equal(stableJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
    assert.equal(hashInput({ b: 1, a: 2 }), hashInput({ a: 2, b: 1 }));
    assert.notEqual(hashInput({ a: 1 }), hashInput({ a: 2 }));
    assert.match(hashInput('x'), /^[0-9a-f]{16}$/);
  });
});

describe('runPurpose against the OpenAI-compatible fake', () => {
  /** @type {ReturnType<typeof createOpenAiFake>} */
  let fake;
  let url = '';
  before(async () => {
    fake = createOpenAiFake({ gapMs: 0, fixtures: { query_rewrite: [{ text: 'I would search for the club.' }, { json: { queries: ['reading club schedule'] } }] } });
    url = (await fake.listen(0)).url;
  });
  after(() => fake.close());

  /** A minimal Chat Completions adapter for this test only. @type {import('../../src/js/ai/stream.js').WireAdapter} */
  const adapter = {
    kind: 'wire',
    id: 'openai',
    dialect: 'openai-chat',
    buildRequest: (req) => ({
      path: '/v1/chat/completions',
      body: { model: req.model, stream: true, messages: req.messages.map((m) => ({ role: m.role, content: m.content.map((p) => (p.type === 'text' ? p.text : '')).join('') })) },
    }),
    createState: () => ({ finish: null }),
    parseEvent(sse, state) {
      if (sse.data === '[DONE]') return [{ type: 'end', stopReason: fromOpenAiChat(state.finish) }];
      const chunk = JSON.parse(sse.data);
      if (chunk.error) return [{ type: 'end', stopReason: 'error', error: new AiError('server') }];
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) state.finish = choice.finish_reason;
      return choice?.delta?.content ? [{ type: 'text', delta: choice.delta.content }] : [];
    },
  };

  it('finds the purpose fixture by its marker and retries the rejected first variant', async () => {
    const clock = fakeClock();
    const deps = {
      ...testDeps(scriptedProviders(() => ({})), clock, { configured: () => ['openai'], liveModels: () => ['gpt-5-nano'] }),
      complete: (/** @type {any} */ req, /** @type {any} */ options) => complete(req, { ...options, adapter, transport: directTransport(url, 'test-key', undefined, { provider: 'openai' }) }),
    };
    const res = await runPurpose('query_rewrite', QUESTION, { deps });
    assert.equal(res.ok, true);
    assert.deepEqual(res.value, { queries: ['reading club schedule'] });
    assert.deepEqual(res.attempts.map((a) => a.outcome), ['invalid', 'ok']);
    const log = fake.requests.filter((r) => r.path === '/v1/chat/completions');
    assert.equal(log.length, 2);
    assert.ok(String(log[0].body.messages[0].content).startsWith(purposeMarker('query_rewrite')));
    assert.match(String(log[1].body.messages.at(-1).content), /could not be used/);
  });
});

