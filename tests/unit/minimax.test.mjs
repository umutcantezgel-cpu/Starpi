// MiniMax and the cloud base model: the catalog entry and snapshot (M3.1 Flash as every tier,
// M3 beside it, the OpenRouter entry), the quirk (reasoning_content as reasoning, thinking off as
// the low effort and never none, other levels as they are, a reserve for the thinking), streams
// through the fake (reasoning apart from the answer, a tool loop, <think> tags), the relay
// allowlist and a relayed call, the site pool (MINIMAX_API_KEYS, STARPI_POOL_PROVIDERS, the fixed
// low effort), the key test and the provider ping without a model list, the base model first in
// Auto and the router with and without MiniMax, and self-hosted MiniMax M3 builds on the user's
// own server (names, context window, reasoning, the workstation note).
import './setup.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { findPoolModel, findPoolSpec, MINIMAX_POOL_UPSTREAM, parsePoolKeys, publicPoolModels } from '../../api/_lib/pool/allowlist.js';
import { buildPools, handlePool, poolStatus } from '../../api/_lib/pool/handler.js';
import { poolRoute, validatePoolRequest } from '../../api/_lib/pool/request.js';
import { handleRelay, relayRoots } from '../../api/_lib/relay/handler.js';
import { findUpstream, matchUpstreamRoute, resolveRoot } from '../../api/_lib/relay/upstreams.js';
import { healthReport } from '../../api/health.js';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { defaultAnswer, REASONING_TEXT } from '../../scripts/fakes/shared.mjs';
import { pingProvider } from '../../scripts/provider-ping.mjs';
import { cspFor, loadHeaderConfig, PROFILES } from '../../scripts/lib/headers.mjs';
import { createAdapter } from '../../src/js/ai/adapters/index.js';
import { buildChatBody } from '../../src/js/ai/adapters/openai-chat.js';
import { capsFor, heuristicCaps, MINIMAX_M3_CONTEXT, roleModel, SNAPSHOT, snapshotModels } from '../../src/js/ai/catalog/models.js';
import { POOLS } from '../../src/js/ai/catalog/pools.js';
import { BASE_MODEL, BASE_PROVIDER, baseFirst, getProvider, keyLooksValid, MINIMAX_M3 } from '../../src/js/ai/catalog/providers.js';
import { contextWindowFor, forgetContextWindows } from '../../src/js/ai/context-pack.js';
import { collect, validateCaps, validateEventSequence } from '../../src/js/ai/index.js';
import { selectedModel } from '../../src/js/ai/model-selection.js';
import { getQuirks } from '../../src/js/ai/quirks/index.js';
import { createLocalQuirks, probeContextWindow, vllmContext } from '../../src/js/ai/quirks/local.js';
import { LOW_EFFORT_RESERVE, minimaxEffort } from '../../src/js/ai/quirks/minimax.js';
import { roleCandidates } from '../../src/js/ai/roles.js';
import { runPurpose } from '../../src/js/ai/router.js';
import { applyThinking, thinkingFor } from '../../src/js/ai/thinking.js';
import { directTransport } from '../../src/js/ai/transport.js';
import { KEY_TEST_TOKENS, keyTestRequest, testKey } from '../../src/js/ai/transport-select.js';
import { assistantGroups, defaultPoolValue, serverItem } from '../../src/js/models/choices.js';
import { configuredProviders, updateProviderState } from '../../src/js/providers.js';
import { sanitizeModelNames } from '../../src/js/render.js';
import { joined, LOOKUP, ofType, replay, request, run } from '../fixtures/ai/replay.mjs';
import { frontGuards, jsonRequest, readAll } from './relay-helpers.mjs';
import { fakeClock, scriptedProviders, testDeps } from './router-fakes.mjs';

/** A key of no real format, built at run time so no key-shaped literal is committed. */
const KEY = `mm${'k'.repeat(40)}`;
const FLASH = 'MiniMax-M3.1-Flash';

/**
 * The request body the provider's adapter builds.
 * @param {any} req
 */
const bodyOf = (req) => buildChatBody(req, 'minimax', getQuirks('minimax'), capsFor('minimax', req.model));

/** A memory store, so nothing touches localStorage. */
const memory = () => {
  const map = new Map();
  return { read: (/** @type {string} */ k) => map.get(k) ?? null, write: (/** @type {string} */ k, /** @type {string} */ v) => void map.set(k, v), remove: (/** @type {string} */ k) => void map.delete(k) };
};

describe('MiniMax in the catalog', () => {
  it('is an OpenAI-compatible provider with auto transport, a pool, no model list and no key format', () => {
    const info = getProvider('minimax');
    assert.ok(info);
    assert.equal(info.dialect, 'openai-chat');
    assert.equal(info.baseUrl, 'https://api.minimax.io');
    assert.equal(info.auth, 'bearer');
    assert.equal(info.transport, 'auto');
    assert.equal(info.quirks, 'minimax');
    assert.equal(info.modelsPath, null);
    assert.equal(info.keyPattern, null);
    assert.equal(keyLooksValid('minimax', KEY), null, 'no key format is relied on, no hint');
    assert.equal(info.byok, true);
    assert.equal(info.pool, true);
    assert.equal(info.testModel, FLASH);
    assert.equal(createAdapter('minimax').dialect, 'openai-chat');
    assert.deepEqual(createAdapter('minimax').authHeader?.(KEY), ['authorization', `Bearer ${KEY}`]);
  });

  it('names M3.1 Flash the base model and every tier, with M3 beside it', () => {
    assert.equal(BASE_PROVIDER, 'minimax');
    assert.equal(BASE_MODEL, FLASH);
    for (const tier of /** @type {const} */ (['fast', 'balanced', 'max'])) assert.equal(roleModel('minimax', tier), FLASH, tier);
    assert.deepEqual(snapshotModels('minimax').map((m) => m.id), [FLASH, 'MiniMax-M3']);
    for (const role of /** @type {const} */ (['fast', 'reasoning', 'judge'])) assert.equal(roleCandidates('minimax', role)[0], FLASH, role);
    assert.deepEqual(roleCandidates('minimax', 'vision'), []);
    for (const id of [FLASH, 'MiniMax-M3']) {
      const caps = capsFor('minimax', id);
      assert.deepEqual(validateCaps(caps), [], id);
      assert.equal(caps.contextTokens, 1_000_000, id);
      assert.equal(caps.reasoning, 'effort', id);
      assert.equal(caps.reasoningVisible, true, id);
      assert.equal(caps.tools, true, id);
      assert.equal(caps.vision, false, id);
      assert.equal(caps.json, false, 'structured output is not documented: no response_format is sent');
      assert.equal(caps.verified, false, 'not checked with a real key');
      assert.equal(caps.priceIn, undefined, 'no price is claimed');
      assert.ok(caps.maxOutput > 0 && caps.maxOutput <= 32_768, 'a conservative output cap');
    }
  });

  it('lists MiniMax M3.1 Flash at OpenRouter with tools and reasoning', () => {
    const entry = SNAPSHOT.providers.openrouter?.models.find((m) => m.id === 'minimax/minimax-m3.1-flash');
    assert.ok(entry);
    assert.equal(entry.caps.tools, true);
    assert.equal(entry.caps.reasoning, 'effort');
    assert.equal(entry.caps.contextTokens, 1_000_000);
    assert.equal(entry.caps.free, false);
  });
});

describe('the MiniMax quirk', () => {
  it('maps thinking off to the low effort and never asks for no thinking', () => {
    const off = bodyOf(request('minimax', FLASH, 'Hi', { thinking: { mode: 'off', effort: 'low' } }));
    assert.equal(off.reasoning_effort, 'low');
    assert.equal(off.thinking, undefined);
    assert.doesNotMatch(JSON.stringify(off), /"none"|disabled/);
    assert.equal(minimaxEffort(request('minimax', FLASH, 'x', { thinking: { mode: 'off' } })), 'low');
  });

  it('passes the other levels across as they are and leaves the default without a choice', () => {
    for (const effort of /** @type {const} */ (['low', 'medium', 'high', 'max'])) {
      assert.equal(bodyOf(request('minimax', FLASH, 'Hi', { thinking: { mode: 'on', effort } })).reasoning_effort, effort, effort);
    }
    assert.equal(bodyOf(request('minimax', FLASH, 'Hi', { thinking: { mode: 'on' } })).reasoning_effort, 'high');
    assert.equal(bodyOf(request('minimax', FLASH, 'Hi', { thinking: { mode: 'auto', effort: 'medium' } })).reasoning_effort, 'medium');
    assert.equal(bodyOf(request('minimax', FLASH, 'Hi', { thinking: { mode: 'auto' } })).reasoning_effort, undefined);
    assert.equal(bodyOf(request('minimax', FLASH, 'Hi')).reasoning_effort, undefined);
  });

  it('gives a named limit a reserve for the thinking when it is off, capped by the model', () => {
    assert.equal(bodyOf(request('minimax', FLASH, 'Hi', { thinking: { mode: 'off' }, maxOutputTokens: 64 })).max_tokens, 64 + LOW_EFFORT_RESERVE);
    assert.equal(bodyOf(request('minimax', FLASH, 'Hi', { thinking: { mode: 'on' }, maxOutputTokens: 64 })).max_tokens, 64);
    assert.equal(bodyOf(request('minimax', FLASH, 'Hi', { thinking: { mode: 'off' }, maxOutputTokens: 10_000_000 })).max_tokens, capsFor('minimax', FLASH).maxOutput);
    assert.equal(bodyOf(request('minimax', FLASH, 'Hi', { thinking: { mode: 'off' } })).max_tokens, undefined);
  });

  it('reaches the effort lever through the thinking switch, off and on', () => {
    const caps = capsFor('minimax', FLASH);
    const off = thinkingFor({ provider: 'minimax', model: FLASH, caps, on: false });
    assert.deepEqual(off.plan, { control: 'effort', value: 'low' });
    assert.equal(bodyOf(applyThinking(request('minimax', FLASH, 'Hi'), off)).reasoning_effort, 'low');
    const on = thinkingFor({ provider: 'minimax', model: FLASH, caps, on: true, show: true });
    assert.equal(bodyOf(applyThinking(request('minimax', FLASH, 'Hi'), on)).reasoning_effort, 'high');
  });

  it('reads reasoning_content deltas as reasoning, and <think> text never as answer text', () => {
    const chunk = (/** @type {any} */ delta, finish = null) => `data: ${JSON.stringify({ model: FLASH, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const text = [chunk({ role: 'assistant', content: '' }), chunk({ reasoning_content: 'Weigh it. ' }), chunk({ reasoning_content: 'Done.' }), chunk({ content: 'The answer.' }), chunk({}, 'stop'), 'data: [DONE]\n\n'].join('');
    const evs = replay(createAdapter('minimax'), request('minimax', FLASH, 'x'), text, 11);
    assert.deepEqual(validateEventSequence(evs), []);
    assert.equal(joined(evs, 'reasoning'), 'Weigh it. Done.');
    assert.equal(joined(evs, 'text'), 'The answer.');
    const tagged = [chunk({ content: '<think>Hidden plan.</think>\n\nShown.' }), chunk({}, 'stop'), 'data: [DONE]\n\n'].join('');
    const evs2 = replay(createAdapter('minimax'), request('minimax', FLASH, 'x'), tagged, 5);
    assert.equal(joined(evs2, 'reasoning'), 'Hidden plan.');
    assert.equal(joined(evs2, 'text'), 'Shown.');
  });
});

describe('MiniMax against the fake', () => {
  /** @type {ReturnType<typeof createOpenAiFake>} */
  let fake;
  let url = '';
  before(async () => {
    fake = createOpenAiFake({ gapMs: 0 });
    url = (await fake.listen(0)).url;
  });
  after(() => fake.close());

  const transport = () => directTransport(`${url}/flavor/minimax`, KEY, undefined, { provider: 'minimax' });

  it('refuses a request that asks for no thinking, as the provider does', async () => {
    for (const extra of [{ reasoning_effort: 'none' }, { thinking: { type: 'disabled' } }, { reasoning_effort: 'extreme' }]) {
      const res = await fetch(`${url}/flavor/minimax/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: FLASH, messages: [{ role: 'user', content: 'Hi' }], ...extra }) });
      assert.equal(res.status, 400, JSON.stringify(extra));
      await res.body?.cancel();
    }
    const ok = await fetch(`${url}/flavor/minimax/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: FLASH, messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'xhigh' }) });
    assert.equal(ok.status, 200);
    await ok.body?.cancel();
  });

  it('streams the thinking apart from the answer with thinking off', async () => {
    const req = applyThinking(request('minimax', FLASH, 'Hello there'), thinkingFor({ provider: 'minimax', model: FLASH, on: false }));
    const evs = await run(createAdapter('minimax'), req, transport());
    assert.deepEqual(validateEventSequence(evs), []);
    const r = await collect(evs);
    assert.equal(r.error ?? null, null);
    assert.equal(r.text, defaultAnswer('Hello there'));
    assert.equal(r.reasoning, REASONING_TEXT);
    assert.ok(!r.text.includes(REASONING_TEXT.slice(0, 20)), 'no thinking in the answer');
    const sent = fake.requests.at(-1);
    assert.equal(sent?.body.reasoning_effort, 'low');
    assert.equal(sent?.headers.authorization, `Bearer ${KEY}`);
    assert.ok(ofType(evs, 'usage').length > 0);
  });

  it('runs a tool loop', async () => {
    const adapter = createAdapter('minimax');
    const first = request('minimax', FLASH, 'Look it up [[fake:tool]]', { tools: [LOOKUP], thinking: { mode: 'on', effort: 'medium' } });
    const r1 = await collect(await run(adapter, first, transport()));
    assert.equal(r1.stopReason, 'tool_call');
    assert.equal(r1.reasoning, REASONING_TEXT);
    const call = r1.toolCalls[0];
    assert.deepEqual(call.args, { query: 'Look it up' });
    assert.equal(fake.requests.at(-1)?.body.reasoning_effort, 'medium');
    const second = { ...first, messages: [...first.messages, { role: 'assistant', content: [{ type: 'tool_call', id: call.id, name: call.name, args: call.args ?? {} }] }, { role: 'tool', content: [{ type: 'tool_result', id: call.id, content: 'A word.' }] }] };
    const r2 = await collect(await run(adapter, /** @type {any} */ (second), transport()));
    assert.equal(r2.stopReason, 'end_turn');
    assert.ok(r2.text.length > 0);
    assert.ok(!JSON.stringify(fake.requests.at(-1)?.body.messages).includes(REASONING_TEXT.slice(0, 20)), 'thinking is never sent back');
  });

  it('tests a key with one tiny chat request, as there is no model list', async () => {
    const built = /** @type {any} */ (keyTestRequest('minimax'));
    assert.equal(built.path, '/v1/chat/completions');
    assert.equal(built.method, 'POST');
    assert.equal(built.body.model, FLASH);
    assert.equal(built.body.reasoning_effort, 'low');
    assert.equal(built.body.max_tokens, KEY_TEST_TOKENS);
    assert.equal(keyTestRequest('local')?.path, '/v1/models');
    assert.equal(keyTestRequest('webgpu'), null);
    /** @type {typeof fetch} */
    const toFake = (input, init) => fetch(String(input).replace('https://api.minimax.io', `${url}/flavor/minimax`), init);
    const ok = await testKey('minimax', KEY, { fetch: toFake, memory: memory(), relay: false });
    assert.deepEqual(ok, { ok: true, via: 'direct', status: 200 });
    const missing = await testKey('minimax', KEY, { fetch: (input, init) => toFake(input, { ...init, headers: { ...(/** @type {any} */ (init?.headers) ?? {}), 'x-fake-fault': '401' } }), memory: memory(), relay: false });
    assert.equal(missing.ok, false);
    assert.equal(/** @type {any} */ (missing).code, 'auth');
  });

  it('relays a chat request to the fixed host only, and nothing else', async () => {
    const upstream = /** @type {any} */ (findUpstream('minimax'));
    assert.equal(upstream.root, 'https://api.minimax.io');
    assert.ok(matchUpstreamRoute(upstream, 'POST', '/v1/chat/completions').ok);
    assert.deepEqual(matchUpstreamRoute(upstream, 'GET', '/v1/models'), { ok: false, status: 404, error: 'path_not_allowed' });
    assert.deepEqual(matchUpstreamRoute(upstream, 'GET', '/v1/chat/completions'), { ok: false, status: 405, error: 'method_not_allowed' });
    assert.deepEqual(resolveRoot('minimax', upstream.root, { STARPI_MINIMAX_BASE_URL: 'https://elsewhere.example' }), { root: 'https://api.minimax.io', simulated: false });
    const deps = { ...frontGuards(), roots: relayRoots({ STARPI_MINIMAX_BASE_URL: `${url}/flavor/minimax` }), fetch };
    const body = { model: FLASH, messages: [{ role: 'user', content: 'Hello relay' }], stream: true, reasoning_effort: 'low' };
    const res = await handleRelay(jsonRequest('/api/relay/minimax/v1/chat/completions', body, { headers: { authorization: `Bearer ${KEY}` } }), deps);
    assert.equal(res.status, 200);
    const text = await readAll(res.body);
    assert.match(text, /reasoning_content/);
    assert.match(text, /\[DONE\]/);
    assert.equal(fake.requests.at(-1)?.path, '/flavor/minimax/v1/chat/completions');
  });

  it('pings the provider and its pool with a chat request instead of a model list', async () => {
    /** @type {string[]} */
    const lines = [];
    const result = await pingProvider({ id: 'minimax', env: { MINIMAX_API_KEYS: KEY, STARPI_MINIMAX_BASE_URL: `${url}/flavor/minimax` }, print: (line) => lines.push(line) });
    assert.equal(result.status, 'ok', lines.join('\n'));
    assert.ok(lines.some((l) => /^list: 200 \(1 entries\)$/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => l.startsWith(`${FLASH} | 200 |`) && l.endsWith('| yes')), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes('not listed')), 'no model list to compare with');
    assert.ok(!lines.join('\n').includes(KEY), 'the key is never printed');
  });
});

describe('the MiniMax site pool', () => {
  it('reads MINIMAX_API_KEYS, follows STARPI_POOL_PROVIDERS and reports it in the health answer', () => {
    const spec = /** @type {import('../../api/_lib/pool/allowlist.js').PoolSpec} */ (findPoolSpec('minimax'));
    assert.equal(spec.keysVariable, 'MINIMAX_API_KEYS');
    assert.equal(spec.root, 'https://api.minimax.io');
    assert.equal(spec.defaultModel, FLASH);
    assert.deepEqual(parsePoolKeys(spec, `${KEY}, short ${'x'.repeat(1025)}`), { keys: [KEY], invalid: 2 });
    const io = { fetch, now: () => Date.now(), warn: () => {} };
    assert.equal(poolStatus(buildPools({ MINIMAX_API_KEYS: KEY }, io)).minimax?.configured, true);
    assert.equal(poolStatus(buildPools({ MINIMAX_API_KEYS: KEY, STARPI_POOL_PROVIDERS: 'nvidia' }, io)).minimax?.configured, false);
    assert.deepEqual(Object.keys(buildPools({ MINIMAX_API_KEYS: KEY, STARPI_POOL_PROVIDERS: 'minimax' }, io)), ['minimax']);
    const report = healthReport({ MINIMAX_API_KEYS: KEY }, poolStatus(buildPools({ MINIMAX_API_KEYS: KEY }, io)));
    assert.equal(report.pools.minimax, true);
    assert.equal(report.simulated.minimax, false);
    assert.ok(!JSON.stringify(report).includes(KEY));
  });

  it('always asks for the low effort, drops the browser\'s extras and publishes no upstream field', () => {
    const spec = /** @type {import('../../api/_lib/pool/allowlist.js').PoolSpec} */ (findPoolSpec('minimax'));
    const route = /** @type {any} */ (poolRoute(spec, '/v1/chat/completions'));
    const built = /** @type {any} */ (validatePoolRequest(spec, route, { model: FLASH, messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'max', tools: [{ type: 'function' }], thinking: { type: 'enabled' } }));
    assert.equal(built.ok, true);
    assert.equal(built.url, 'https://api.minimax.io/v1/chat/completions');
    assert.equal(built.body.reasoning_effort, MINIMAX_POOL_UPSTREAM.reasoning_effort);
    assert.equal(built.body.reasoning_effort, 'low');
    assert.equal(built.body.tools, undefined);
    assert.equal(built.body.thinking, undefined);
    assert.ok(built.body.max_tokens <= POOLS.minimax.maxOutputTokens);
    assert.equal(/** @type {any} */ (validatePoolRequest(spec, route, { model: 'MiniMax-M3', messages: [{ role: 'user', content: 'Hi' }] })).error, 'model_not_allowed');
    assert.equal(findPoolModel(spec, FLASH)?.reasoning, true);
    assert.ok(!JSON.stringify(publicPoolModels(spec)).includes('reasoning_effort'));
  });

  it('streams the base model with a site key through the pool function', async () => {
    const fake = createOpenAiFake({ gapMs: 0 });
    const { url } = await fake.listen(0);
    try {
      const pools = buildPools({ STARPI_POOL_PROVIDERS: 'minimax', MINIMAX_API_KEYS: KEY, STARPI_MINIMAX_BASE_URL: `${url}/flavor/minimax` }, { fetch, now: () => Date.now(), warn: () => {} });
      const res = await handlePool(jsonRequest(`/api/pool?${new URLSearchParams({ provider: 'minimax', path: '/v1/chat/completions' })}`, { model: FLASH, messages: [{ role: 'user', content: 'Hello pool' }] }), { ...frontGuards(), pools });
      assert.equal(res.status, 200);
      const text = await readAll(res.body);
      assert.match(text, /reasoning_content/);
      assert.match(text, /"content":"/);
      const sent = fake.requests.at(-1);
      assert.equal(sent?.headers.authorization, `Bearer ${KEY}`);
      assert.equal(sent?.body.reasoning_effort, 'low');
    } finally {
      await fake.close();
    }
  });
});

describe('the base model first', () => {
  it('moves MiniMax to the front and leaves every other order alone', () => {
    assert.deepEqual(baseFirst(['anthropic', 'groq', 'minimax', 'local']), ['minimax', 'anthropic', 'groq', 'local']);
    assert.deepEqual(baseFirst(['anthropic', 'groq', 'local']), ['anthropic', 'groq', 'local']);
    assert.deepEqual(baseFirst([]), []);
  });

  it('puts the MiniMax key or pool ahead of the other cloud providers in Auto, and changes nothing without it', () => {
    const pool = (/** @type {boolean} */ on) => ({ configured: on, models: [], defaultModel: null });
    try {
      updateProviderState({ keyed: ['anthropic', 'groq'], pools: { nvidia: pool(true), minimax: pool(false) }, server: true });
      assert.deepEqual(configuredProviders(), ['anthropic', 'groq', 'nvidia', 'local'], 'without MiniMax: as before');
      updateProviderState({ pools: { nvidia: pool(true), minimax: pool(true) } });
      assert.deepEqual(configuredProviders(), ['minimax', 'anthropic', 'groq', 'nvidia', 'local'], 'the site pool');
      updateProviderState({ keyed: ['anthropic', 'groq', 'minimax'], pools: { nvidia: pool(true), minimax: pool(false) } });
      assert.deepEqual(configuredProviders(), ['minimax', 'anthropic', 'groq', 'nvidia', 'local'], 'a key of the user');
      for (const id of configuredProviders()) assert.ok(!['webgpu', 'wasm'].includes(id), 'the device stays after every provider');
    } finally {
      updateProviderState({ keyed: [], pools: null, server: false });
    }
  });

  it('answers a purpose with M3.1 Flash first when it is set up, and with the previous chain when not', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders(() => ({ text: JSON.stringify({ queries: ['club meeting time'] }) }), clock);
    const selection = (/** @type {any} */ provider, /** @type {any} */ live) => selectedModel(provider, { strength: 'auto', pinned: null, live });
    const withBase = await runPurpose('query_rewrite', { question: 'When does the club meet?' }, { deps: testDeps(providers, clock, { configured: () => baseFirst(['anthropic', 'minimax']), selection }), cache: 'off' });
    assert.equal(withBase.ok, true);
    assert.equal(withBase.provider, 'minimax');
    assert.equal(withBase.model, FLASH);
    const without = await runPurpose('query_rewrite', { question: 'When does the club meet?' }, { deps: testDeps(providers, clock, { configured: () => baseFirst(['anthropic']), selection }), cache: 'off' });
    assert.equal(without.provider, 'anthropic');
    assert.equal(without.model, 'claude-haiku-5-5');
  });

  it('makes the MiniMax pool the default free model, and keeps NVIDIA first without it', () => {
    /** @type {import('../../src/js/models/choices.js').PickerState} */
    const state = { hw: null, pools: { nvidia: { configured: true, models: [], defaultModel: null }, minimax: { configured: true, models: [FLASH], defaultModel: FLASH } }, keyed: [], models: {}, server: false, serverModels: [] };
    assert.equal(defaultPoolValue(state), `minimax:${FLASH}`);
    const recommended = assistantGroups(state).find((g) => g.id === 'recommended');
    assert.ok(recommended?.items.some((i) => i.value === `minimax:${FLASH}` && i.free));
    assert.match(String(defaultPoolValue({ ...state, pools: { nvidia: { configured: true, models: [], defaultModel: null } } })), /^nvidia:/);
    assert.match(String(defaultPoolValue({ ...state, keyed: ['minimax'] })), /^nvidia:/, 'a key of the user takes the provider group instead');
  });

  it('is reachable under the CSP of every hosted profile, and named neutrally in status lines', () => {
    const config = loadHeaderConfig();
    for (const profile of PROFILES) assert.match(cspFor(config.csp, profile), /connect-src [^;]*https:(?:\s|;|$)/, profile);
    assert.equal(sanitizeModelNames('HTTP 429 from MiniMax M3.1 Flash'), 'HTTP 429 from AI model');
    assert.equal(sanitizeModelNames('[minimax/minimax-m3.1-flash] empty'), '[AI model] empty');
  });
});

describe('MiniMax M3 on the user\'s own server', () => {
  it('recognises the builds by name, with their window, their thinking and a workstation note', () => {
    for (const id of ['minimax-m3:q3_k_m', 'MiniMaxAI/MiniMax-M3.1-Flash-GGUF', 'unsloth/MiniMax-M3-GGUF:UD-Q3_K_XL', 'minimax_m3.1']) {
      assert.ok(MINIMAX_M3.test(id), id);
      const caps = heuristicCaps('local', id);
      assert.equal(caps.contextTokens, MINIMAX_M3_CONTEXT, id);
      assert.equal(caps.reasoning, 'tagged', id);
      assert.equal(caps.latency, 'slow', id);
      assert.equal(caps.local, true, id);
      assert.equal(serverItem(id).warning, 'workstation', id);
    }
    for (const id of ['llama3.1:8b', 'mini-max-2', 'qwen3:8b']) {
      assert.ok(!MINIMAX_M3.test(id), id);
      assert.equal(serverItem(id).warning, undefined, id);
    }
    assert.equal(heuristicCaps('local', 'minimax-m3', { contextTokens: 131_072 }).contextTokens, 131_072, 'a reported window wins');
  });

  it('never sends reasoning_effort none to such a build, and reads <think> and reasoning_content', () => {
    const quirks = createLocalQuirks({ server: 'vllm', reasoningOff: true });
    const off = (/** @type {string} */ model) => buildChatBody(request('local', model, 'Hi', { thinking: { mode: 'off' } }), 'local', quirks, capsFor('local', model));
    assert.equal(off('minimax-m3:q3').reasoning_effort, undefined);
    assert.equal(off('qwen3:8b').reasoning_effort, 'none', 'other models still may');
    const choice = thinkingFor({ provider: 'local', model: 'minimax-m3:q3', on: false });
    assert.deepEqual(choice.plan, { control: 'none', value: null });
    assert.equal(choice.request, undefined);
    const adapter = createAdapter('local');
    const chunk = (/** @type {any} */ delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const tags = replay(adapter, request('local', 'minimax-m3', 'x'), [chunk({ content: '<think>Plan.</think>Answer.' }), chunk({}, 'stop'), 'data: [DONE]\n\n'].join(''), 7);
    assert.equal(joined(tags, 'reasoning'), 'Plan.');
    assert.equal(joined(tags, 'text'), 'Answer.');
    const field = replay(adapter, request('local', 'minimax-m3', 'x'), [chunk({ reasoning_content: 'Plan.' }), chunk({ content: 'Answer.' }), chunk({}, 'stop'), 'data: [DONE]\n\n'].join(''), 7);
    assert.equal(joined(field, 'reasoning'), 'Plan.');
    assert.equal(joined(field, 'text'), 'Answer.');
  });

  it('sizes the context by what the server reports, else by the published window', async () => {
    assert.equal(vllmContext({ data: [{ id: 'minimax-m3', max_model_len: 196_608 }] }, 'minimax-m3'), 196_608);
    assert.equal(vllmContext({ data: [{ id: 'served-name', max_model_len: 65_536 }] }, 'other'), 65_536, 'the only model of the server');
    assert.equal(vllmContext({ data: [{ id: 'a', max_model_len: 1 }, { id: 'b' }] }, 'c'), null);
    assert.equal(vllmContext(null, 'x'), null);
    forgetContextWindows();
    const caps = capsFor('local', 'minimax-m3:q3');
    const silent = async () => ({ contextTokens: 4096, source: /** @type {const} */ ('fallback') });
    assert.equal(await contextWindowFor({ route: 'local', model: 'minimax-m3:q3' }, caps, { baseUrl: 'http://127.0.0.1:8000/v1', probe: silent }), MINIMAX_M3_CONTEXT);
    assert.equal(await contextWindowFor({ route: 'local', model: 'llama3.1:8b' }, capsFor('local', 'llama3.1:8b'), { baseUrl: 'http://127.0.0.1:8000/v1', probe: silent }), 4096, 'other models keep the small default');
    const reported = async () => ({ contextTokens: 131_072, source: /** @type {const} */ ('vllm') });
    assert.equal(await contextWindowFor({ route: 'local', model: 'minimax-m3:q4' }, caps, { baseUrl: 'http://127.0.0.1:8001/v1', probe: reported }), 131_072);
    forgetContextWindows();
  });

  it('reads the window vLLM serves a model with from its model list', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'minimax-m3', object: 'model', max_model_len: 196_608 }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    try {
      const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      assert.deepEqual(await probeContextWindow(`http://127.0.0.1:${port}/v1`, { model: 'minimax-m3', server: 'vllm' }), { contextTokens: 196_608, source: 'vllm' });
      assert.deepEqual(await probeContextWindow(`http://127.0.0.1:${port}/v1`, { model: 'minimax-m3', server: 'other' }), { contextTokens: 196_608, source: 'vllm' });
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  });
});
