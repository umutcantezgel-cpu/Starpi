// Transport selection: direct for providers that allow browser calls, auto (direct, then once
// through the relay after a call blocked before any answer, remembered per provider) for those that
// may not, the site pool without a key, local servers always direct. Relay and pool calls carry the
// site's access code; direct calls never do. Network calls go to a scripted fetch.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiError } from '../../src/js/ai/errors.js';
import { complete, registerAdapter, setTransportResolver } from '../../src/js/ai/index.js';
import { ACCESS_HEADER, relayTransport } from '../../src/js/ai/transport.js';
import {
  createTransportResolver,
  fetchPools,
  forgetTransports,
  parsePoolCatalog,
  planTransport,
  rememberedTransport,
  relayEnabled,
  RELAY_SETTING_KEY,
  selectTransport,
  setRelayEnabled,
  testKey,
  TRANSPORT_MEMORY_PREFIX,
} from '../../src/js/ai/transport-select.js';

const ORIGIN = 'https://app.example';

function memoryStore() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    map,
    read: (/** @type {string} */ k) => map.get(k) ?? null,
    write: (/** @type {string} */ k, /** @type {string} */ v) => (map.set(k, v), true),
    remove: (/** @type {string} */ k) => void map.delete(k),
  };
}

/**
 * A fetch that answers per URL prefix: a Response, an Error to throw, or a function of the call.
 * @param {Array<[string, Response | Error | ((url: string) => Response)]>} script
 */
function scriptedFetch(script) {
  /** @type {Array<{ url: string, init: RequestInit, headers: Headers }>} */
  const calls = [];
  /** @type {import('../../src/js/ai/transport.js').FetchLike} */
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init, headers: new Headers(init.headers) });
    const hit = script.find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new TypeError(`unscripted ${url}`);
    const answer = hit[1];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(url) : answer.clone();
  };
  return { fetch, calls };
}

const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const blocked = () => new TypeError('Failed to fetch');
const built = { path: '/v1/chat/completions', body: { model: 'm' } };

describe('planTransport', () => {
  const memory = memoryStore();
  /** @type {Array<[string, import('../../src/js/ai/transport-select.js').SelectOptions, string, string?]>} */
  const table = [
    ['anthropic', { key: 'k' }, 'direct'],
    ['openai', { key: 'k' }, 'direct'],
    ['gemini', { key: 'k' }, 'direct'],
    ['openrouter', { key: 'k' }, 'direct'],
    ['xai', { key: 'k' }, 'auto'],
    ['groq', { key: 'k' }, 'auto'],
    ['mistral', { key: 'k' }, 'auto'],
    ['deepseek', { key: 'k' }, 'auto'],
    ['deepseek', { key: 'k', relay: false }, 'direct'],
    ['nvidia', { key: 'k' }, 'relay'],
    ['nvidia', { key: 'k', relay: false }, 'none', 'relay_off'],
    ['nvidia', { key: '', pool: true }, 'pool'],
    ['groq', { pool: true }, 'pool'],
    ['groq', { pool: false }, 'none', 'no_key'],
    ['anthropic', { pool: true }, 'none', 'no_key'],
    ['local', { baseUrl: 'http://localhost:11434/v1' }, 'direct'],
    ['local', { baseUrl: 'not a url' }, 'none', 'no_server'],
    ['webgpu', {}, 'device', 'in_browser'],
    ['brave', { key: 'k' }, 'relay'],
    ['elevenlabs', { key: 'k' }, 'auto'],
    ['nope', { key: 'k' }, 'none', 'unknown'],
  ];
  for (const [id, opts, route, reason] of table) {
    it(`${id} ${JSON.stringify(opts)} → ${route}${reason ? ` (${reason})` : ''}`, () => {
      const plan = planTransport(id, { memory, ...opts });
      assert.equal(plan.route, route);
      assert.equal(plan.reason, reason);
    });
  }

  it('sends an auto provider straight to the relay once the relay is remembered', () => {
    const mem = memoryStore();
    mem.write(`${TRANSPORT_MEMORY_PREFIX}groq`, 'relay');
    assert.equal(planTransport('groq', { key: 'k', memory: mem }).route, 'relay');
    assert.equal(planTransport('groq', { key: 'k', memory: mem, relay: false }).route, 'direct');
    mem.write(`${TRANSPORT_MEMORY_PREFIX}groq`, 'direct');
    assert.equal(planTransport('groq', { key: 'k', memory: mem }).route, 'auto');
  });
});

describe('relay setting and memory', () => {
  it('is on by default, stored as an opt-out', () => {
    const mem = memoryStore();
    assert.equal(relayEnabled(mem), true);
    setRelayEnabled(false, mem);
    assert.equal(mem.read(RELAY_SETTING_KEY), '0');
    assert.equal(relayEnabled(mem), false);
    setRelayEnabled(true, mem);
    assert.equal(mem.map.size, 0);
  });

  it('forgets remembered routes', () => {
    const mem = memoryStore();
    mem.write(`${TRANSPORT_MEMORY_PREFIX}groq`, 'relay');
    mem.write(`${TRANSPORT_MEMORY_PREFIX}xai`, 'direct');
    assert.equal(rememberedTransport('groq', mem), 'relay');
    forgetTransports('groq', mem);
    assert.equal(rememberedTransport('groq', mem), null);
    assert.equal(rememberedTransport('xai', mem), 'direct');
    forgetTransports(undefined, mem);
    assert.equal(mem.map.size, 0);
  });
});

describe('selectTransport', () => {
  it('builds a direct transport with the provider header and never the access code', async () => {
    const { fetch, calls } = scriptedFetch([['https://api.anthropic.com', json({})]]);
    const t = selectTransport('anthropic', { key: 'sk-ant-x', fetch, origin: ORIGIN, access: 'site-code', memory: memoryStore() });
    assert.equal(t?.kind, 'direct');
    await t?.(null, { path: '/v1/models' });
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models');
    assert.equal(calls[0].headers.get('x-api-key'), 'sk-ant-x');
    assert.equal(calls[0].headers.get(ACCESS_HEADER), null);
  });

  it('auto: a call blocked before any answer goes once through the relay, and the relay is remembered', async () => {
    const memory = memoryStore();
    const { fetch, calls } = scriptedFetch([
      ['https://api.groq.com', blocked()],
      [`${ORIGIN}/api/relay/groq`, json({ ok: true })],
    ]);
    const t = /** @type {any} */ (selectTransport('groq', { key: 'gsk_x', fetch, origin: ORIGIN, access: 'site-code', memory }));
    const res = await t(null, built);
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => c.url),
      ['https://api.groq.com/openai/v1/chat/completions', `${ORIGIN}/api/relay/groq/v1/chat/completions`],
    );
    assert.equal(calls[0].headers.get(ACCESS_HEADER), null);
    assert.equal(calls[1].headers.get(ACCESS_HEADER), 'site-code');
    assert.equal(calls[1].headers.get('authorization'), 'Bearer gsk_x');
    assert.equal(t.route(), 'relay');
    assert.equal(rememberedTransport('groq', memory), 'relay');
    // Next time the relay is used right away.
    const next = selectTransport('groq', { key: 'gsk_x', fetch, origin: ORIGIN, memory });
    assert.equal(next?.kind, 'relay');
  });

  it('auto: a direct answer (any status) is remembered as direct and not retried', async () => {
    const memory = memoryStore();
    const { fetch, calls } = scriptedFetch([['https://api.x.ai', json({ error: { code: 'invalid_api_key' } }, 401)]]);
    const t = /** @type {any} */ (selectTransport('xai', { key: 'xai-x', fetch, origin: ORIGIN, memory }));
    const res = await t(null, built);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 1);
    assert.equal(rememberedTransport('xai', memory), 'direct');
  });

  it('auto: no retry with the relay switched off, after an abort, or for other errors', async () => {
    const off = scriptedFetch([['https://api.mistral.ai', blocked()]]);
    const plain = selectTransport('mistral', { key: 'k', fetch: off.fetch, origin: ORIGIN, relay: false, memory: memoryStore() });
    await assert.rejects(plain?.(null, built) ?? Promise.reject(new Error('no transport')), (/** @type {any} */ err) => err instanceof AiError && err.code === 'cors');
    assert.equal(off.calls.length, 1);

    const aborted = scriptedFetch([['https://api.mistral.ai', blocked()]]);
    const controller = new AbortController();
    controller.abort();
    const t = selectTransport('mistral', { key: 'k', fetch: aborted.fetch, origin: ORIGIN, memory: memoryStore() });
    await assert.rejects(t?.(null, built, { signal: controller.signal }) ?? Promise.reject(new Error('no transport')), (/** @type {any} */ err) => err.code === 'aborted');
    assert.equal(aborted.calls.length, 1);
  });

  it('auto: a site without the relay function keeps the cors error and remembers nothing', async () => {
    const memory = memoryStore();
    const { fetch } = scriptedFetch([
      ['https://api.deepseek.com', blocked()],
      [`${ORIGIN}/api/relay/`, new Response('<!doctype html>', { status: 404, headers: { 'content-type': 'text/html' } })],
    ]);
    const t = selectTransport('deepseek', { key: 'sk-x', fetch, origin: ORIGIN, memory });
    await assert.rejects(t?.(null, built) ?? Promise.reject(new Error('no transport')), (/** @type {any} */ err) => err.code === 'cors');
    assert.equal(rememberedTransport('deepseek', memory), null);
  });

  it('auto: SDK requests fall back with the URL moved below the relay', async () => {
    const memory = memoryStore();
    const { fetch, calls } = scriptedFetch([
      ['https://api.groq.com', blocked()],
      [`${ORIGIN}/api/relay/groq`, json({})],
    ]);
    const t = /** @type {any} */ (selectTransport('groq', { key: 'gsk_x', fetch, origin: ORIGIN, memory }));
    await t.fetch(`${t.baseURL}/v1/models`, { method: 'GET' });
    assert.equal(calls[1].url, `${ORIGIN}/api/relay/groq/v1/models`);
    assert.equal(calls[1].headers.get('authorization'), 'Bearer gsk_x');
  });

  it('uses the pool without a key, with the access code and no key header', async () => {
    const { fetch, calls } = scriptedFetch([[`${ORIGIN}/api/pool`, json({})]]);
    const t = selectTransport('nvidia', { key: '', pool: true, fetch, origin: ORIGIN, access: () => 'site-code', memory: memoryStore() });
    assert.equal(t?.kind, 'pool');
    await t?.(null, built);
    assert.equal(calls[0].url, `${ORIGIN}/api/pool?provider=nvidia&path=%2Fv1%2Fchat%2Fcompletions`);
    assert.equal(calls[0].headers.get(ACCESS_HEADER), 'site-code');
    assert.equal(calls[0].headers.get('authorization'), null);
    assert.equal(selectTransport('anthropic', { key: '', pool: true, memory: memoryStore() }), null);
  });

  it('calls a local server direct, with its optional key, never through the relay', async () => {
    const { fetch, calls } = scriptedFetch([['http://localhost:11434', json({ data: [] })]]);
    const bare = selectTransport('local', { baseUrl: 'http://localhost:11434/v1', fetch, access: 'site-code', memory: memoryStore() });
    await bare?.(null, { path: '/v1/models' });
    const keyed = selectTransport('local', { baseUrl: 'http://localhost:11434', key: 'local-secret', fetch, memory: memoryStore() });
    await keyed?.(null, { path: '/v1/models' });
    assert.equal(calls[0].url, 'http://localhost:11434/v1/models');
    assert.equal(calls[0].headers.get('authorization'), null);
    assert.equal(calls[0].headers.get(ACCESS_HEADER), null);
    assert.equal(calls[1].headers.get('authorization'), 'Bearer local-secret');
    assert.equal(selectTransport('webgpu', {}), null);
  });
});

describe('relay for voice and search services', () => {
  it('sends each service its native auth header', async () => {
    const { fetch, calls } = scriptedFetch([[`${ORIGIN}/api/relay/`, json({})]]);
    await relayTransport('elevenlabs', 'el-key', { fetch, origin: ORIGIN })(null, { path: '/v1/voices' });
    await relayTransport('brave', 'br-key', { fetch, origin: ORIGIN, access: 'c' })(null, { path: '/res/v1/web/search?q=test' });
    await relayTransport('tavily', 'tv-key', { fetch, origin: ORIGIN })(null, { path: '/search', body: { query: 'x' } });
    assert.equal(calls[0].url, `${ORIGIN}/api/relay/elevenlabs/v1/voices`);
    assert.equal(calls[0].headers.get('xi-api-key'), 'el-key');
    assert.equal(calls[0].headers.get('authorization'), null);
    assert.equal(calls[1].headers.get('x-subscription-token'), 'br-key');
    assert.equal(calls[1].headers.get(ACCESS_HEADER), 'c');
    assert.equal(calls[2].headers.get('authorization'), 'Bearer tv-key');
  });

  it('never pools a service and keeps a malformed access code out of the headers', async () => {
    const { fetch, calls } = scriptedFetch([[`${ORIGIN}/api/relay/`, json({})]]);
    await relayTransport('brave', 'br-key', { fetch, origin: ORIGIN, access: 'bad\ncode' })(null, { path: '/res/v1/web/search?q=a' });
    assert.equal(calls[0].headers.get(ACCESS_HEADER), null);
    assert.equal(planTransport('brave', { key: '', pool: true }).route, 'none');
  });
});

describe('testKey', () => {
  it('reports ok and the way that worked', async () => {
    const { fetch, calls } = scriptedFetch([['https://api.anthropic.com/v1/models', json({ data: [] })]]);
    assert.deepEqual(await testKey('anthropic', 'sk-ant-x', { fetch, memory: memoryStore() }), { ok: true, via: 'direct', status: 200 });
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].headers.get('anthropic-dangerous-direct-browser-access'), 'true');
    assert.ok(calls[0].headers.get('anthropic-version'));
  });

  it('reports only an error code, never the provider text', async () => {
    const { fetch } = scriptedFetch([['https://generativelanguage.googleapis.com', json({ error: { status: 'PERMISSION_DENIED', message: 'Your key sk-secret is wrong' } }, 403)]]);
    const result = await testKey('gemini', 'AIza-x', { fetch, memory: memoryStore() });
    assert.deepEqual(result, { ok: false, code: 'auth', via: 'direct', status: 403 });
  });

  it('goes through the relay when the provider blocks the browser', async () => {
    const memory = memoryStore();
    const { fetch } = scriptedFetch([
      ['https://api.groq.com', blocked()],
      [`${ORIGIN}/api/relay/groq/v1/models`, json({ data: [] })],
    ]);
    assert.deepEqual(await testKey('groq', 'gsk_x', { fetch, origin: ORIGIN, memory }), { ok: true, via: 'relay', status: 200 });
    assert.equal(rememberedTransport('groq', memory), 'relay');
  });

  it('maps a failed call and a missing route to codes', async () => {
    const { fetch } = scriptedFetch([['https://api.openai.com', blocked()]]);
    assert.deepEqual(await testKey('openai', 'sk-x', { fetch, memory: memoryStore() }), { ok: false, code: 'cors', via: null, status: 0 });
    assert.equal((await testKey('nvidia', 'nvapi-x', { relay: false, memory: memoryStore() })).code, 'cors');
    assert.equal((await testKey('webgpu', '', {})).code, 'bad_request');
  });
});

describe('pools', () => {
  it('reads the pool list and keeps only known pools and model ids', () => {
    const parsed = parsePoolCatalog({
      version: 1,
      pools: {
        groq: { configured: true, defaultModel: 'llama-3.3-70b-versatile', models: [{ id: 'llama-3.3-70b-versatile' }, 'qwen/qwen3-32b', { id: 7 }] },
        nvidia: { configured: false, models: [] },
        evil: { configured: true },
      },
    });
    assert.deepEqual(parsed, {
      groq: { configured: true, defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b'] },
      nvidia: { configured: false, defaultModel: null, models: [] },
    });
    assert.equal(parsePoolCatalog([]), null);
  });

  it('fetches the list, and reports a static host as unreachable', async () => {
    const ok = scriptedFetch([['/api/models/pool', json({ version: 1, pools: { gemini: { configured: true, models: [] } } })]]);
    assert.deepEqual(await fetchPools({ fetch: ok.fetch }), { reachable: true, pools: { gemini: { configured: true, defaultModel: null, models: [] } } });
    const page = scriptedFetch([['/api/models/pool', new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })]]);
    assert.deepEqual(await fetchPools({ fetch: page.fetch }), { reachable: false, pools: {} });
    const down = scriptedFetch([['/api/models/pool', blocked()]]);
    assert.equal((await fetchPools({ fetch: down.fetch })).reachable, false);
  });
});

describe('transport resolver', () => {
  it('feeds complete() with the key, the pool and the access code', async () => {
    const memory = memoryStore();
    const { fetch, calls } = scriptedFetch([[`${ORIGIN}/api/pool`, new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } })]]);
    /** @type {Record<string, string>} */
    const keys = { access: 'site-code' };
    const resolver = createTransportResolver({ getKey: (slot) => keys[slot] ?? '', pool: (id) => id === 'groq', memory, fetch, origin: ORIGIN });
    const t = await resolver('groq', /** @type {any} */ ({}));
    assert.equal(t?.kind, 'pool');
    assert.throws(() => resolver('anthropic', /** @type {any} */ ({})), (/** @type {any} */ err) => err instanceof AiError && err.code === 'auth');
    keys.nvidia = 'nvapi-x';
    assert.throws(() => createTransportResolver({ getKey: (s) => keys[s] ?? '', pool: () => false, memory: { ...memory, read: (k) => (k === RELAY_SETTING_KEY ? '0' : null) } })('nvidia', /** @type {any} */ ({})), (/** @type {any} */ err) => err.code === 'cors');
    assert.equal(createTransportResolver({ getKey: () => '', localUrl: () => 'http://localhost:1234/v1', memory })('local', /** @type {any} */ ({}))?.kind, 'direct');

    // Installed, complete() sends a pool call with the access code.
    const off = registerAdapter('groq', {
      kind: 'wire',
      id: 'groq',
      dialect: 'openai-chat',
      buildRequest: () => ({ path: '/v1/chat/completions', body: {} }),
      parseEvent: () => [{ type: 'end', stopReason: 'end_turn' }],
    });
    setTransportResolver(resolver);
    try {
      const run = complete({ provider: 'groq', model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
      const result = await run.result;
      assert.equal(result.error, null);
      assert.equal(calls.at(-1)?.headers.get(ACCESS_HEADER), 'site-code');
    } finally {
      setTransportResolver(null);
      off();
    }
  });
});
