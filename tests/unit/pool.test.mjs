// Site key pools (api/pool.js, api/chat/nvidia.js, api/_lib/pool/*): the generic key router (auth
// header and URL as parameters, token buckets, failover before the first byte and commit after
// it, parking), the guard order of the pool handler, the daily budget, the environment, the NVIDIA
// alias and streams against the local provider fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findPoolSpec, enabledPoolIds, parsePoolKeys } from '../../api/_lib/pool/allowlist.js';
import { buildPools, handlePool, POOL_FUNCTION_MAX_MS, poolTarget } from '../../api/_lib/pool/handler.js';
import { createKeyRouter } from '../../api/_lib/pool/key-router.js';
import * as aliasRoute from '../../api/chat/nvidia.js';
import * as poolRoute from '../../api/pool.js';
import { createGeminiFake } from '../../scripts/fakes/gemini.mjs';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { NVIDIA_DEFAULT_MODEL, NVIDIA_PROXY } from '../../src/js/models/nvidia-catalog.js';
import { answer, errorOf, frontGuards, jsonRequest, readAll, recordingFetch, siteRequest, sse, SSE_CHUNKS, testKey } from './relay-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TIMING = { ...NVIDIA_PROXY, attemptTimeoutMs: 40, failoverBudgetMs: 400, idleTimeoutMs: 200 };
const NVIDIA_BODY = { model: NVIDIA_DEFAULT_MODEL, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16 };
const GROQ_MODEL = /** @type {{ models: Array<{ id: string }> }} */ (findPoolSpec('groq')).models[0].id;
const GEMINI_PATH = '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse';
const poolUrl = (/** @type {string} */ provider, /** @type {string} */ p) => `/api/pool?${new URLSearchParams({ provider, path: p })}`;

function fakeClock(start = 1_700_000_000_000) {
  const clock = { t: start, now: () => clock.t };
  return clock;
}

/**
 * A router over a recording fetch.
 * @param {number} count
 * @param {ReturnType<typeof recordingFetch>} fetch
 * @param {Partial<Parameters<typeof createKeyRouter>[0]>} [options]
 */
function makeRouter(count, fetch, options = {}) {
  /** @type {string[]} */
  const logs = [];
  const keys = Array.from({ length: count }, (_, i) => testKey('plain', i + 1));
  const router = createKeyRouter({ keys, fetch, upstreamUrl: 'https://upstream.test/v1/chat/completions', timing: TIMING, log: (line) => logs.push(line), ...options });
  return { router, logs, keys };
}

/**
 * Pool dependencies with one pool whose router uses the given fetch.
 * @param {Record<string, ReturnType<typeof recordingFetch> | null>} fetches pool id -> fetch (null: no keys)
 * @param {Parameters<typeof frontGuards>[0]} [guards]
 */
function poolDeps(fetches, guards = {}) {
  /** @type {Record<string, import('../../api/_lib/pool/handler.js').Pool>} */
  const pools = {};
  for (const [id, fetch] of Object.entries(fetches)) {
    const spec = { .../** @type {import('../../api/_lib/pool/allowlist.js').PoolSpec} */ (findPoolSpec(id)), timing: TIMING };
    const authHeader = spec.auth === 'bearer' ? undefined : (/** @type {string} */ k) => /** @type {[string, string]} */ ([spec.auth, k]);
    pools[id] = {
      spec,
      simulated: false,
      router: fetch ? createKeyRouter({ keys: [testKey('plain', 1), testKey('plain', 2)], fetch, upstreamUrl: `${spec.root}/v1/chat/completions`, timing: TIMING, log: () => {}, ...(authHeader ? { authHeader } : {}) }) : null,
    };
  }
  return { ...frontGuards(guards), pools };
}

describe('generic key router', () => {
  it('sends the key in the configured header to the URL a request names', async () => {
    const fetch = recordingFetch(sse());
    const { router, keys } = makeRouter(1, fetch, { authHeader: (k) => ['x-goog-api-key', k] });
    const opened = await router.open({ contents: [] }, { deadline: Date.now() + 400, url: 'https://upstream.test/v1beta/models/m:streamGenerateContent?alt=sse' });
    assert.ok(opened.ok);
    opened.reader.cancel();
    const [call] = fetch.calls;
    assert.equal(call.url, 'https://upstream.test/v1beta/models/m:streamGenerateContent?alt=sse');
    assert.deepEqual(call.headers, { 'x-goog-api-key': keys[0], 'content-type': 'application/json', accept: 'text/event-stream' });
    assert.equal(call.init.redirect, 'error');
  });

  it('fails over until the first byte, then commits: a later failure ends the stream, not the key', async () => {
    const clock = fakeClock();
    const broken = sse([SSE_CHUNKS[0]], { fail: true });
    const fetch = recordingFetch(answer(503, { 'content-type': 'application/json' }, ['{}']), broken, sse());
    const { router, keys } = makeRouter(3, fetch, { now: clock.now });
    const opened = await router.open({}, { deadline: clock.t + 400 });
    assert.ok(opened.ok && opened.attempts === 2);
    assert.equal(new TextDecoder().decode(opened.first), SSE_CHUNKS[0]);
    await assert.rejects(opened.reader.read(), /connection reset/);
    assert.equal(fetch.calls.length, 2, 'no failover after the first byte');
    assert.deepEqual(fetch.calls.map((c) => c.headers.authorization), [`Bearer ${keys[0]}`, `Bearer ${keys[1]}`]);
    assert.deepEqual(router.coolingUntil(), [clock.t + NVIDIA_PROXY.cooldownMs.transient, 0, 0]);
  });

  it('parks 429 keys for their Retry-After and 401/403 keys for 30 minutes', async () => {
    const clock = fakeClock();
    const fetch = recordingFetch(answer(429, { 'retry-after': '9' }, ['{}']), answer(401, {}, ['{}']), answer(403, {}, ['{}']), sse());
    const { router } = makeRouter(4, fetch, { now: clock.now });
    assert.ok((await router.open({}, { deadline: clock.t + 400 })).ok);
    assert.deepEqual(router.coolingUntil(), [clock.t + 9000, clock.t + 1_800_000, clock.t + 1_800_000, 0]);
  });

  it('paces each key with a token bucket and answers 503 with the refill time when all are spent', async () => {
    const clock = fakeClock();
    const fetch = recordingFetch(sse());
    const { router, keys } = makeRouter(2, fetch, { now: clock.now, keyRpm: 2 });
    for (let i = 0; i < 4; i++) {
      const opened = await router.open({}, { deadline: clock.t + 400 });
      assert.ok(opened.ok, `request ${i + 1}`);
      opened.reader.cancel();
    }
    assert.deepEqual(fetch.calls.map((c) => c.headers.authorization), [keys[0], keys[1], keys[0], keys[1]].map((k) => `Bearer ${k}`));
    assert.deepEqual(await router.open({}, { deadline: clock.t + 400 }), { ok: false, status: 503, error: 'all_keys_exhausted', retryAfterS: 30 });
    assert.equal(fetch.calls.length, 4, 'no upstream request while every bucket is empty');
    assert.deepEqual(router.coolingUntil(), [0, 0], 'pacing is not parking');
    clock.t += 30_000;
    const again = await router.open({}, { deadline: clock.t + 400 });
    assert.ok(again.ok, 'a token is back after half a minute');
    again.reader.cancel();
  });

  it('names the pool and the key index in log lines, never the key', async () => {
    const fetch = recordingFetch(answer(429, {}, ['{}']), answer(404, {}, ['{}']));
    const { router, logs, keys } = makeRouter(2, fetch, { label: 'groq' });
    assert.deepEqual(await router.open({}, { deadline: Date.now() + 400 }), { ok: false, status: 502, error: 'model_unavailable' });
    assert.deepEqual(logs, ['groq: key 1/2 rate limited (429), cooling 20 s', 'groq: key 2/2 got 404, not retried']);
    assert.ok(keys.every((k) => !logs.join('\n').includes(k)));
  });
});

describe('handlePool', () => {
  it('runs origin, rate limit and access code first, then the pool, the path and the keys', async () => {
    const fetch = recordingFetch(sse());
    const deps = poolDeps({ nvidia: fetch, groq: null }, { limit: 3, accessCode: 'pool-code-0123456789' });
    const send = (/** @type {string} */ url, /** @type {Record<string, string | undefined>} */ headers = {}, ip = '198.51.100.1') =>
      handlePool(jsonRequest(url, NVIDIA_BODY, { headers: { 'x-starpi-access': 'pool-code-0123456789', ...headers }, ip }), deps);
    assert.deepEqual(await errorOf(await send(poolUrl('nvidia', '/v1/chat/completions'), { origin: 'https://evil.example', 'sec-fetch-site': undefined })), { status: 403, error: 'origin_not_allowed' });
    assert.deepEqual(await errorOf(await send(poolUrl('nvidia', '/v1/chat/completions'), { 'x-starpi-access': undefined }, '198.51.100.2')), { status: 401, error: 'access_required' });
    assert.deepEqual(await errorOf(await send(poolUrl('openai', '/v1/chat/completions'))), { status: 404, error: 'unknown_pool' });
    assert.deepEqual(await errorOf(await send(poolUrl('nvidia', '/v1/models'))), { status: 404, error: 'path_not_allowed' });
    assert.deepEqual(await errorOf(await send(poolUrl('groq', '/v1/chat/completions'))), { status: 503, error: 'pool_not_configured' });
    assert.deepEqual(await errorOf(await send(poolUrl('nvidia', '/v1/chat/completions'))), { status: 429, error: 'rate_limited' });
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(poolTarget('https://x.test/api/pool?provider=gemini&path=%2Fv1beta%2Fmodels%2Fm%3AstreamGenerateContent%3Falt%3Dsse'), { provider: 'gemini', path: '/v1beta/models/m:streamGenerateContent?alt=sse' });
  });

  it('validates the body against the model allowlist before any upstream call', async () => {
    const fetch = recordingFetch(sse());
    const deps = poolDeps({ nvidia: fetch });
    const url = poolUrl('nvidia', '/v1/chat/completions');
    assert.deepEqual(await errorOf(await handlePool(jsonRequest(url, { ...NVIDIA_BODY, model: 'paid/large-model' }), deps)), { status: 400, error: 'model_not_allowed' });
    assert.deepEqual(await errorOf(await handlePool(jsonRequest(url, { ...NVIDIA_BODY, messages: [] }), deps)), { status: 400, error: 'invalid_field', field: 'messages' });
    assert.deepEqual(await errorOf(await handlePool(siteRequest(url, { headers: { 'content-type': 'text/plain' }, body: '{}' }), deps)), { status: 415, error: 'unsupported_media_type' });
    assert.equal(fetch.calls.length, 0);
  });

  it('streams the answer with no-store headers and sends only the validated body', async () => {
    const fetch = recordingFetch(sse());
    const res = await handlePool(jsonRequest(poolUrl('nvidia', '/v1/chat/completions'), { ...NVIDIA_BODY, tools: [{ type: 'function' }] }), poolDeps({ nvidia: fetch }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(await readAll(res.body), SSE_CHUNKS.join(''));
    const sent = JSON.parse(fetch.calls[0].body);
    assert.equal(sent.stream, true);
    assert.ok(!('tools' in sent));
    assert.equal(fetch.calls[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  });

  it('counts a daily budget per address for requests that reach a provider', async () => {
    const clock = fakeClock(Date.UTC(2026, 9, 16, 23, 0, 0));
    const fetch = recordingFetch(sse());
    const deps = poolDeps({ nvidia: fetch }, { daily: 2, now: clock.now });
    const url = poolUrl('nvidia', '/v1/chat/completions');
    // A refused body does not count.
    await handlePool(jsonRequest(url, { ...NVIDIA_BODY, model: 'x' }), deps);
    for (let i = 0; i < 2; i++) await readAll((await handlePool(jsonRequest(url, NVIDIA_BODY), deps)).body);
    const over = await handlePool(jsonRequest(url, NVIDIA_BODY), deps);
    assert.deepEqual(await errorOf(over), { status: 429, error: 'daily_limit_reached' });
    assert.equal(over.headers.get('retry-after'), '3600', 'until the next UTC day');
    assert.equal((await handlePool(jsonRequest(url, NVIDIA_BODY, { ip: '198.51.100.99' }), deps)).status, 200, 'another address has its own budget');
    clock.t += 3600_000;
    assert.equal((await handlePool(jsonRequest(url, NVIDIA_BODY), deps)).status, 200, 'a new day starts a new budget');
  });

  it('maps router failures to 502, 503 and 504 with Retry-After', async () => {
    const limited = await handlePool(jsonRequest(poolUrl('nvidia', '/v1/chat/completions'), NVIDIA_BODY), poolDeps({ nvidia: recordingFetch(answer(429, { 'retry-after': '12' }, ['{}'])) }));
    assert.deepEqual(await errorOf(limited), { status: 503, error: 'all_keys_exhausted' });
    assert.equal(limited.headers.get('retry-after'), '12');
    const rejected = await handlePool(jsonRequest(poolUrl('nvidia', '/v1/chat/completions'), NVIDIA_BODY), poolDeps({ nvidia: recordingFetch(answer(400, {}, ['secret upstream text'])) }));
    const text = await rejected.text();
    assert.equal(rejected.status, 502);
    assert.deepEqual(JSON.parse(text), { error: 'upstream_rejected' });
  });
});

describe('pool environment', () => {
  it('enables the listed pools, all when unset, and parses keys by count only', () => {
    assert.deepEqual(enabledPoolIds(undefined), ['nvidia', 'groq', 'gemini', 'openrouter']);
    assert.deepEqual(enabledPoolIds(''), ['nvidia', 'groq', 'gemini', 'openrouter']);
    assert.deepEqual(enabledPoolIds('Gemini, groq,unknown'), ['groq', 'gemini']);
    const groq = /** @type {import('../../api/_lib/pool/allowlist.js').PoolSpec} */ (findPoolSpec('groq'));
    assert.deepEqual(parsePoolKeys(groq, `${testKey('groq', 1)}, short ${testKey('groq', 1)}\n${testKey('groq', 2)}`), { keys: [testKey('groq', 1), testKey('groq', 2)], invalid: 1 });
  });

  it('builds a router only for keyed pools, marks loopback roots simulated and warns by count', () => {
    /** @type {string[]} */
    const warnings = [];
    const pools = buildPools(
      {
        STARPI_POOL_PROVIDERS: 'nvidia,groq,gemini',
        NVIDIA_API_KEYS: `${testKey('nvidia', 1)},nvapi-bad`,
        GEMINI_API_KEYS: testKey('gemini'),
        STARPI_GEMINI_BASE_URL: 'http://127.0.0.1:4613',
        STARPI_GROQ_BASE_URL: 'https://not-loopback.example',
      },
      { fetch, now: () => Date.now(), warn: (line) => warnings.push(line) },
    );
    assert.deepEqual(Object.keys(pools), ['nvidia', 'groq', 'gemini']);
    assert.equal(pools.nvidia.router?.size, 1);
    assert.equal(pools.groq.router, null);
    assert.equal(pools.gemini.simulated, true);
    assert.equal(pools.gemini.spec.root, 'http://127.0.0.1:4613');
    assert.equal(pools.groq.simulated, false);
    assert.deepEqual(warnings, ['pool nvidia: ignored 1 malformed entries in NVIDIA_API_KEYS']);
  });
});

describe('pools against the provider fakes', () => {
  const openai = createOpenAiFake({ gapMs: 0 });
  const gemini = createGeminiFake({ gapMs: 0 });
  let openaiUrl = '';
  let geminiUrl = '';
  before(async () => {
    openaiUrl = (await openai.listen(0)).url;
    geminiUrl = (await gemini.listen(0)).url;
  });
  after(async () => {
    await Promise.all([openai.close(), gemini.close()]);
  });

  const deps = () => {
    const pools = buildPools(
      { STARPI_POOL_PROVIDERS: 'groq,gemini', GROQ_API_KEYS: testKey('groq'), GEMINI_API_KEYS: testKey('gemini'), STARPI_GROQ_BASE_URL: `${openaiUrl}/flavor/groq/openai`, STARPI_GEMINI_BASE_URL: geminiUrl },
      { fetch, now: () => Date.now(), warn: () => {} },
    );
    return { ...frontGuards(), pools };
  };

  it('streams a Groq chat completion with the pool key', async () => {
    const res = await handlePool(jsonRequest(poolUrl('groq', '/v1/chat/completions'), { model: GROQ_MODEL, messages: [{ role: 'user', content: 'Hello pool' }] }), deps());
    assert.equal(res.status, 200);
    const text = await readAll(res.body);
    assert.match(text, /"content":"a simulated "/);
    assert.match(text, /\[DONE\]/);
    const recorded = openai.requests.at(-1);
    assert.equal(recorded?.path, '/flavor/groq/openai/v1/chat/completions');
    assert.equal(recorded?.headers.authorization, `Bearer ${testKey('groq')}`);
    assert.equal(recorded?.body.stream, true);
  });

  it('streams Gemini with the key in x-goog-api-key and the model from the path', async () => {
    const res = await handlePool(jsonRequest(poolUrl('gemini', GEMINI_PATH), { contents: [{ role: 'user', parts: [{ text: 'Hello pool' }] }] }), deps());
    assert.equal(res.status, 200);
    assert.match(await readAll(res.body), /"candidates"/);
    const recorded = gemini.requests.at(-1);
    assert.equal(recorded?.path, '/v1beta/models/gemini-2.5-flash:streamGenerateContent');
    assert.equal(recorded?.query.alt, 'sse');
    assert.equal(recorded?.headers['x-goog-api-key'], testKey('gemini'));
    assert.equal(recorded?.headers.authorization, undefined);
  });

  it('fails over on a provider 429 to the next key', async () => {
    const pools = buildPools(
      { STARPI_POOL_PROVIDERS: 'groq', GROQ_API_KEYS: `${testKey('groq', 1)},${testKey('groq', 2)}`, STARPI_GROQ_BASE_URL: `${openaiUrl}/flavor/groq/openai` },
      { fetch: async (input, init) => fetch(input, { ...init, headers: { ...(/** @type {Record<string, string>} */ (init?.headers)), ...(String(/** @type {Record<string, string>} */ (init?.headers).Authorization).endsWith('1') ? { 'x-fake-fault': '429' } : {}) } }), now: () => Date.now(), warn: () => {} },
    );
    const res = await handlePool(jsonRequest(poolUrl('groq', '/v1/chat/completions'), { model: GROQ_MODEL, messages: [{ role: 'user', content: 'Hello pool' }] }), { ...frontGuards(), pools });
    assert.equal(res.status, 200);
    await readAll(res.body);
    assert.ok((/** @type {import('../../api/_lib/pool/key-router.js').KeyRouter} */ (pools.groq.router).coolingUntil()[0]) > Date.now(), 'the first key is parked');
  });
});

describe('pool route wiring and the NVIDIA alias', () => {
  const ENV = ['NVIDIA_API_KEYS', 'STARPI_POOL_PROVIDERS', 'STARPI_ACCESS_CODE', 'STARPI_NVIDIA_BASE_URL', 'STARPI_ALLOWED_ORIGINS', 'NVIDIA_ALLOWED_ORIGINS', 'RELAY_ALLOWED_ORIGINS'];
  /** @type {Record<string, string | undefined>} */
  let saved = {};
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
    for (const name of ENV) delete process.env[name];
  });
  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('exports POST and 405 with Allow for every other method', async () => {
    for (const route of [poolRoute, aliasRoute]) {
      assert.equal(typeof route.POST, 'function');
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await route[/** @type {'GET'} */ (method)]();
        assert.deepEqual(await errorOf(res), { status: 405, error: 'method_not_allowed' });
        assert.equal(res.headers.get('allow'), 'POST');
      }
    }
  });

  it('keeps the old answers of /api/chat/nvidia: origin first, then nvidia_not_configured', async () => {
    const noOrigin = await aliasRoute.POST(jsonRequest('/api/chat/nvidia', NVIDIA_BODY, { headers: { origin: undefined, 'sec-fetch-site': undefined } }));
    assert.deepEqual(await errorOf(noOrigin), { status: 403, error: 'origin_required' });
    assert.deepEqual(await errorOf(await aliasRoute.POST(jsonRequest('/api/chat/nvidia', NVIDIA_BODY))), { status: 503, error: 'nvidia_not_configured' });
    process.env.STARPI_POOL_PROVIDERS = 'groq';
    process.env.NVIDIA_API_KEYS = testKey('nvidia');
    assert.deepEqual(await errorOf(await aliasRoute.POST(jsonRequest('/api/chat/nvidia', NVIDIA_BODY))), { status: 503, error: 'nvidia_not_configured' }, 'a disabled pool answers like one without keys');
  });

  it('streams /api/chat/nvidia through the NVIDIA pool against the fake', async () => {
    const fake = createOpenAiFake({ gapMs: 0, flavor: 'nvidia' });
    const { url } = await fake.listen(0);
    try {
      process.env.NVIDIA_API_KEYS = testKey('nvidia');
      process.env.STARPI_NVIDIA_BASE_URL = url;
      const res = await aliasRoute.POST(jsonRequest('/api/chat/nvidia', NVIDIA_BODY));
      assert.equal(res.status, 200);
      assert.match(await readAll(res.body), /\[DONE\]/);
      assert.equal(fake.requests.at(-1)?.path, '/v1/chat/completions');
      const viaPool = await poolRoute.POST(jsonRequest(poolUrl('nvidia', '/v1/chat/completions'), NVIDIA_BODY));
      assert.equal(viaPool.status, 200);
      await readAll(viaPool.body);
    } finally {
      await fake.close();
    }
  });

  it('keeps vercel.json and the pool deadline in step', () => {
    const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    assert.deepEqual(vercel.functions['api/pool.js'], { maxDuration: POOL_FUNCTION_MAX_MS / 1000, supportsCancellation: true });
    assert.deepEqual(vercel.functions['api/chat/nvidia.js'], { maxDuration: POOL_FUNCTION_MAX_MS / 1000, supportsCancellation: true });
  });
});
