// Transports: where each sends a request, which auth header it sets (and which it strips), the
// fetch options every call uses, keys never in the URL, the SDK fetch that stays below its base
// URL, and how failures before an answer map to AiError codes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiError } from '../../src/js/ai/errors.js';
import { AUTH_HEADER_NAMES, directTransport, nativeAuthHeader, poolTransport, relayTransport } from '../../src/js/ai/transport.js';

/**
 * A fetch that records its calls; `fail` makes it throw instead.
 * @param {{ fail?: unknown }} [options]
 */
function recordingFetch(options = {}) {
  /** @type {Array<{ url: string, init: RequestInit, headers: Headers }>} */
  const calls = [];
  /** @type {import('../../src/js/ai/transport.js').FetchLike} */
  const fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init, headers: new Headers(init.headers) });
    if (options.fail) throw options.fail;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const built = (/** @type {Record<string, unknown>} */ extra = {}) => ({ path: '/v1/chat/completions', headers: { accept: 'text/event-stream', authorization: 'Bearer smuggled', 'x-api-key': 'smuggled', cookie: 'a=b' }, body: { model: 'm' }, ...extra });

describe('directTransport', () => {
  it('sends to base URL + path with the adapter auth header, JSON body and safe fetch options', async () => {
    const { fetch, calls } = recordingFetch();
    const t = directTransport('https://api.example.com/', ' key-123 ', undefined, { fetch, provider: 'openai' });
    const res = await t({ authHeader: (k) => ['x-custom-key', k] }, built());
    assert.equal(res.status, 200);
    const [call] = calls;
    assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.headers.get('x-custom-key'), 'key-123');
    assert.equal(call.headers.get('authorization'), null, 'auth headers the adapter set are stripped');
    assert.equal(call.headers.get('x-api-key'), null);
    assert.equal(call.headers.get('cookie'), null);
    assert.equal(call.headers.get('content-type'), 'application/json');
    assert.equal(call.init.body, '{"model":"m"}');
    assert.equal(t.kind, 'direct');
    assert.equal(t.baseURL, 'https://api.example.com');
  });

  it('uses a header name, a function or Bearer, and no header without a key', async () => {
    const { fetch, calls } = recordingFetch();
    await directTransport('https://g.example', 'k1', 'x-goog-api-key', { fetch })(null, { path: '/v1beta/models' });
    await directTransport('https://o.example', 'k2', 'authorization', { fetch })(null, { path: '/v1/models' });
    await directTransport('https://o.example/openai', 'k3', undefined, { fetch })(null, { path: '/v1/models' });
    await directTransport('http://localhost:11434', '', undefined, { fetch })(null, { path: '/v1/models' });
    assert.equal(calls[2].url, 'https://o.example/openai/v1/models');
    assert.equal(calls[0].headers.get('x-goog-api-key'), 'k1');
    assert.equal(calls[1].headers.get('authorization'), 'Bearer k2');
    assert.equal(calls[2].headers.get('authorization'), 'Bearer k3');
    assert.equal(calls[3].headers.get('authorization'), null);
    assert.equal(calls[0].init.method, 'GET');
  });

  it('maps a fetch that throws before an answer to cors, and an abort to aborted', async () => {
    const t = directTransport('https://api.example.com', 'k', undefined, { fetch: recordingFetch({ fail: new TypeError('Failed to fetch') }).fetch, provider: 'xai' });
    await assert.rejects(t(null, { path: '/v1/models' }), (/** @type {any} */ err) => err instanceof AiError && err.code === 'cors' && err.provider === 'xai');
    const ac = new AbortController();
    ac.abort();
    const aborting = directTransport('https://api.example.com', 'k', undefined, { fetch: recordingFetch({ fail: new DOMException('aborted', 'AbortError') }).fetch });
    await assert.rejects(aborting(null, { path: '/v1/models' }, { signal: ac.signal }), (/** @type {any} */ err) => err.code === 'aborted');
  });

  it('refuses keys in the URL, odd paths and keys that would break a header', async () => {
    const { fetch, calls } = recordingFetch();
    const t = directTransport('https://api.example.com', 'k', undefined, { fetch });
    for (const path of ['/v1/models?key=abc', '/v1/x?api_key=1', 'v1/models', '//evil.example/x', '/v1/../admin', '/a\\b', '/a b']) {
      await assert.rejects(t(null, { path }), (/** @type {any} */ err) => err.code === 'bad_request', path);
    }
    await assert.rejects(directTransport('https://api.example.com', 'bad key\r\nx: y', undefined, { fetch })(null, { path: '/v1/models' }), (/** @type {any} */ err) => err.code === 'auth');
    assert.equal(calls.length, 0);
  });

  it('accepts only absolute http(s) base URLs without credentials', () => {
    for (const base of ['/v1', 'ftp://example.com', 'https://user:pw@example.com', 'https://example.com/v1?key=1']) {
      assert.throws(() => directTransport(base, 'k'), TypeError, base);
    }
  });

  it('gives SDKs a fetch that sets its own auth and stays below the base URL', async () => {
    const { fetch, calls } = recordingFetch();
    const t = directTransport('https://api.example.com', 'real-key', 'x-api-key', { fetch });
    await t.fetch('https://api.example.com/v1/messages', { method: 'POST', headers: { 'x-api-key': 'placeholder', 'anthropic-version': '2023-06-01' }, body: '{}' });
    assert.equal(calls[0].headers.get('x-api-key'), 'real-key');
    assert.equal(calls[0].headers.get('anthropic-version'), '2023-06-01');
    assert.equal(calls[0].init.redirect, 'error');
    await assert.rejects(t.fetch('https://elsewhere.example/v1/messages', {}), (/** @type {any} */ err) => err.code === 'bad_request');
    await assert.rejects(t.fetch('https://api.example.com/v1/messages?key=x', {}), (/** @type {any} */ err) => err.code === 'bad_request');
    assert.equal(calls.length, 1);
  });

  it("falls back to the provider's native header, also for SDK requests", async () => {
    const { fetch, calls } = recordingFetch();
    await directTransport('https://a.example', 'ka', undefined, { fetch, provider: 'anthropic' }).fetch('https://a.example/v1/messages', { method: 'POST', body: '{}' });
    await directTransport('https://g.example', 'kg', undefined, { fetch, provider: 'gemini' })(null, { path: '/v1beta/models' });
    await directTransport('https://g.example', 'kx', undefined, { fetch, provider: 'gemini' })({ authHeader: (k) => ['x-custom-key', k] }, { path: '/v1beta/models' });
    assert.equal(calls[0].headers.get('x-api-key'), 'ka');
    assert.equal(calls[0].headers.get('authorization'), null);
    assert.equal(calls[1].headers.get('x-goog-api-key'), 'kg');
    assert.equal(calls[2].headers.get('x-custom-key'), 'kx', 'the adapter header wins');
  });
});

describe('relayTransport', () => {
  it("sends to the site's relay with the key in the provider's native header", async () => {
    const { fetch, calls } = recordingFetch();
    const anthropic = relayTransport('anthropic', 'sk-a', { fetch, origin: 'https://app.example' });
    await anthropic(null, { path: '/v1/messages', body: {} });
    const gemini = relayTransport('gemini', 'g-k', { fetch, origin: 'https://app.example' });
    await gemini(null, { path: '/v1beta/models/m:streamGenerateContent?alt=sse', body: {} });
    const groq = relayTransport('groq', 'gk', { fetch, origin: 'https://app.example' });
    await groq({ authHeader: () => ['x-ignored', 'nope'] }, built());
    assert.equal(calls[0].url, 'https://app.example/api/relay/anthropic/v1/messages');
    assert.equal(calls[0].headers.get('x-api-key'), 'sk-a');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(calls[1].url, 'https://app.example/api/relay/gemini/v1beta/models/m:streamGenerateContent?alt=sse');
    assert.equal(calls[1].headers.get('x-goog-api-key'), 'g-k');
    assert.equal(calls[2].headers.get('authorization'), 'Bearer gk');
    assert.equal(calls[2].headers.get('x-ignored'), null);
    assert.equal(anthropic.baseURL, 'https://app.example/api/relay/anthropic');
    assert.equal(anthropic.kind, 'relay');
  });

  it('maps a failing same-origin fetch to network, not cors', async () => {
    const t = relayTransport('openai', 'k', { fetch: recordingFetch({ fail: new TypeError('Failed to fetch') }).fetch, origin: 'https://app.example' });
    await assert.rejects(t(null, { path: '/v1/models' }), (/** @type {any} */ err) => err.code === 'network');
  });

  it('never relays local servers or in-browser engines', () => {
    for (const id of ['local', 'webgpu', 'wasm', 'unknown']) assert.throws(() => relayTransport(id, 'k'), TypeError, id);
  });

  it('routes SDK requests below its base URL only', async () => {
    const { fetch, calls } = recordingFetch();
    const t = relayTransport('anthropic', 'sk-a', { fetch, origin: 'https://app.example' });
    await t.fetch(`${t.baseURL}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer placeholder' } });
    assert.equal(calls[0].url, 'https://app.example/api/relay/anthropic/v1/messages');
    assert.equal(calls[0].headers.get('authorization'), null);
    assert.equal(calls[0].headers.get('x-api-key'), 'sk-a');
    await assert.rejects(t.fetch('https://app.example/api/relay/openai/v1/x', {}), (/** @type {any} */ err) => err.code === 'bad_request');
  });
});

describe('poolTransport', () => {
  it('sends provider and path to the pool endpoint, without any key', async () => {
    const { fetch, calls } = recordingFetch();
    const t = poolTransport('nvidia', { fetch, origin: 'https://app.example' });
    await t({ authHeader: (k) => ['authorization', `Bearer ${k}`] }, built());
    assert.equal(calls[0].url, 'https://app.example/api/pool?provider=nvidia&path=%2Fv1%2Fchat%2Fcompletions');
    for (const name of AUTH_HEADER_NAMES) assert.equal(calls[0].headers.get(name), null, name);
    await t.fetch(`${t.baseURL}/v1/models`, { headers: { authorization: 'Bearer x' } });
    assert.equal(calls[1].url, 'https://app.example/api/pool?provider=nvidia&path=%2Fv1%2Fmodels');
    assert.equal(calls[1].headers.get('authorization'), null);
    assert.equal(t.kind, 'pool');
  });
});

describe('nativeAuthHeader', () => {
  it('knows the header style of each provider', () => {
    assert.deepEqual(nativeAuthHeader('anthropic', 'k'), ['x-api-key', 'k']);
    assert.deepEqual(nativeAuthHeader('gemini', 'k'), ['x-goog-api-key', 'k']);
    assert.deepEqual(nativeAuthHeader('openrouter', 'k'), ['authorization', 'Bearer k']);
  });
});
