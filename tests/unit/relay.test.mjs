// The stateless BYOK relay (api/relay.js, api/_lib/relay/*): the guard order, the fixed upstream
// map and its path allowlist, the auth header rules, body and query limits, the forwarded header
// allowlist, stream and passthrough relaying, error answers that keep only an identifier, and the
// whole path against the local provider fakes of scripts/fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleRelay, RELAY_FUNCTION_MAX_MS, RELAY_LIMITS, relayRoots, relayTarget, upstreamErrorCode } from '../../api/_lib/relay/handler.js';
import { findUpstream, KNOWN_ANTHROPIC_BETAS, matchUpstreamRoute, parseLoopbackRoot, RELAY_PROVIDERS, resolveRoot, UPSTREAMS } from '../../api/_lib/relay/upstreams.js';
import * as relayRoute from '../../api/relay.js';
import { createAnthropicFake } from '../../scripts/fakes/anthropic.mjs';
import { createElevenLabsFake } from '../../scripts/fakes/elevenlabs.mjs';
import { createGeminiFake } from '../../scripts/fakes/gemini.mjs';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { createSearchFake } from '../../scripts/fakes/search.mjs';
import { answer, errorOf, frontGuards, jsonAnswer, jsonRequest, readAll, recordingFetch, SITE, siteRequest, sse, SSE_CHUNKS, testKey } from './relay-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OPENAI_KEY = testKey('openai');
const ANTHROPIC_KEY = testKey('anthropic');
const GEMINI_KEY = testKey('gemini');
const CHAT_BODY = { model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream: true };

/**
 * Relay dependencies with an injected fetch.
 * @param {ReturnType<typeof recordingFetch>} fetch
 * @param {Parameters<typeof frontGuards>[0] & { roots?: Record<string, string> }} [options]
 */
function relayDeps(fetch, options = {}) {
  return { ...frontGuards(options), roots: options.roots ?? relayRoots({}), fetch };
}

const bearer = (/** @type {string} */ key) => ({ authorization: `Bearer ${key}` });

describe('upstream map', () => {
  it('names a fixed https root for every provider and never a local address', () => {
    assert.deepEqual([...RELAY_PROVIDERS].sort(), ['anthropic', 'brave', 'deepseek', 'elevenlabs', 'gemini', 'groq', 'minimax', 'mistral', 'nvidia', 'openai', 'openrouter', 'tavily', 'xai']);
    for (const upstream of Object.values(UPSTREAMS)) {
      const url = new URL(upstream.root);
      assert.equal(url.protocol, 'https:', upstream.id);
      assert.ok(!/localhost|127\.|\[::1\]|\.local$/.test(url.hostname), upstream.id);
      assert.ok(upstream.routes.length > 0, upstream.id);
    }
    for (const id of ['local', 'ollama', 'custom', 'constructor', '__proto__', 'toString']) assert.equal(findUpstream(id), null, id);
  });

  it('allows the documented method and path pairs', () => {
    const allowed = [
      ['anthropic', 'POST', '/v1/messages'],
      ['anthropic', 'POST', '/v1/messages/count_tokens'],
      ['anthropic', 'GET', '/v1/models'],
      ['anthropic', 'GET', '/v1/models/claude-opus-5-5'],
      ['openai', 'POST', '/v1/responses'],
      ['openai', 'POST', '/v1/chat/completions'],
      ['openai', 'GET', '/v1/models'],
      ['openai', 'POST', '/v1/images/generations'],
      ['openai', 'POST', '/v1/audio/speech'],
      ['openai', 'POST', '/v1/audio/transcriptions'],
      ['gemini', 'POST', '/v1beta/models/gemini-2.5-flash:streamGenerateContent'],
      ['gemini', 'POST', '/v1beta/models/gemini-2.5-flash:generateContent'],
      ['gemini', 'GET', '/v1beta/models'],
      ['groq', 'POST', '/v1/chat/completions'],
      ['groq', 'POST', '/v1/audio/transcriptions'],
      ['mistral', 'POST', '/v1/chat/completions'],
      ['deepseek', 'POST', '/v1/chat/completions'],
      ['minimax', 'POST', '/v1/chat/completions'],
      ['xai', 'POST', '/v1/chat/completions'],
      ['openrouter', 'POST', '/v1/chat/completions'],
      ['nvidia', 'POST', '/v1/chat/completions'],
      ['elevenlabs', 'POST', '/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM'],
      ['elevenlabs', 'POST', '/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream'],
      ['elevenlabs', 'GET', '/v2/voices'],
      ['brave', 'GET', '/res/v1/web/search'],
      ['tavily', 'POST', '/search'],
    ];
    for (const [id, method, p] of allowed) assert.ok(matchUpstreamRoute(/** @type {any} */ (findUpstream(id)), method, p).ok, `${id} ${method} ${p}`);
  });

  it('refuses every other path, including dot segments, encoded separators and other APIs', () => {
    const refused = [
      ['openai', 'POST', '/v1/files'],
      ['openai', 'POST', '/v1/chat/completions/'],
      ['openai', 'POST', '/v1/fine_tuning/jobs'],
      ['openai', 'POST', '//evil.example/v1/chat/completions'],
      ['openai', 'POST', '/v1/chat/completions%2f..'],
      ['anthropic', 'POST', '/v1/messages/batches'],
      ['anthropic', 'GET', '/v1/models/..'],
      ['anthropic', 'GET', '/v1/models/a/b'],
      ['gemini', 'POST', '/v1beta/models/../files:streamGenerateContent'],
      ['gemini', 'POST', '/v1beta/models/gemini:embedContent'],
      ['gemini', 'POST', '/v1beta/models/Gemini-Pro:generateContent'],
      ['gemini', 'POST', '/upload/v1beta/files'],
      ['deepseek', 'POST', '/v1/audio/speech'],
      ['minimax', 'GET', '/v1/models'],
      ['minimax', 'POST', '/anthropic/v1/messages'],
      ['minimax', 'POST', '/v1/text/chatcompletion_v2'],
      ['elevenlabs', 'POST', '/v1/voices/add'],
      ['brave', 'GET', '/res/v1/images/search'],
      ['tavily', 'POST', '/extract'],
      ['openai', 'POST', ''],
    ];
    for (const [id, method, p] of refused) {
      assert.deepEqual(matchUpstreamRoute(/** @type {any} */ (findUpstream(id)), method, p), { ok: false, status: 404, error: 'path_not_allowed' }, `${id} ${p}`);
    }
    assert.deepEqual(matchUpstreamRoute(UPSTREAMS.openai, 'GET', '/v1/chat/completions'), { ok: false, status: 405, error: 'method_not_allowed' });
  });

  it('takes a fake API root only from STARPI_<ID>_BASE_URL and only on loopback', () => {
    assert.equal(parseLoopbackRoot('http://127.0.0.1:4611/'), 'http://127.0.0.1:4611');
    assert.equal(parseLoopbackRoot('http://localhost:4611/flavor/groq'), 'http://localhost:4611/flavor/groq');
    assert.equal(parseLoopbackRoot('http://[::1]:9/x'), 'http://[::1]:9/x');
    for (const bad of ['https://api.example.com', 'http://10.0.0.5:80', 'http://127.0.0.1.example.com', 'http://user:pw@127.0.0.1:1', 'http://127.0.0.1:1/?q=1', 'file:///etc', '', undefined]) {
      assert.equal(parseLoopbackRoot(bad), null, String(bad));
    }
    assert.deepEqual(resolveRoot('openai', UPSTREAMS.openai.root, { STARPI_OPENAI_BASE_URL: 'http://127.0.0.1:5000' }), { root: 'http://127.0.0.1:5000', simulated: true });
    // A developer's own SDK variable never moves the relay.
    assert.deepEqual(resolveRoot('anthropic', UPSTREAMS.anthropic.root, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000' }), { root: 'https://api.anthropic.com', simulated: false });
    assert.equal(relayRoots({ STARPI_GEMINI_BASE_URL: 'https://evil.example' }).gemini, 'https://generativelanguage.googleapis.com');
  });

  it('reads provider and path from the original URL, or from the query of the bare endpoint', () => {
    const t = relayTarget(`${SITE}/api/relay/gemini/v1beta/models/x-1:streamGenerateContent?alt=sse`);
    assert.equal(t?.provider, 'gemini');
    assert.equal(t?.path, '/v1beta/models/x-1:streamGenerateContent');
    assert.equal(t?.query.toString(), 'alt=sse');
    assert.deepEqual({ ...relayTarget(`${SITE}/api/relay/openai`), query: undefined }, { provider: 'openai', path: '', query: undefined });
    const q = relayTarget(`${SITE}/api/relay?provider=brave&path=res/v1/web/search&q=hello`);
    assert.equal(q?.provider, 'brave');
    assert.equal(q?.path, '/res/v1/web/search');
    assert.equal(q?.query.toString(), 'q=hello');
    assert.equal(relayTarget(`${SITE}/api/relay?provider=../x&path=v1`), null);
    assert.equal(relayTarget(`${SITE}/api/other/openai/v1/models`), null);
  });
});

describe('handleRelay guards', () => {
  it('checks the origin before anything else, then the rate limit, then the access code', async () => {
    const fetch = recordingFetch(sse());
    const deps = relayDeps(fetch, { limit: 2, accessCode: 'letmein-please-1234' });
    const cross = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }), deps);
    assert.deepEqual(await errorOf(cross), { status: 403, error: 'cross_site_request' });
    const noOrigin = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: { origin: undefined, 'sec-fetch-site': undefined } }), deps);
    assert.deepEqual(await errorOf(noOrigin), { status: 403, error: 'origin_required' });

    const ip = '198.51.100.20';
    const first = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { ip }), deps);
    assert.deepEqual(await errorOf(first), { status: 401, error: 'access_required' });
    const wrong = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { ip, headers: { 'x-starpi-access': 'guess' } }), deps);
    assert.deepEqual(await errorOf(wrong), { status: 401, error: 'access_denied' });
    // The third guess from the address hits the limit before the code is compared.
    const limited = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { ip, headers: { 'x-starpi-access': 'letmein-please-1234' } }), deps);
    assert.deepEqual(await errorOf(limited), { status: 429, error: 'rate_limited' });
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    const ok = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: { ...bearer(OPENAI_KEY), 'x-starpi-access': 'letmein-please-1234' } }), deps);
    assert.equal(ok.status, 200);
    await readAll(ok.body);
    assert.equal(fetch.calls.length, 1);
    assert.ok(!('x-starpi-access' in fetch.calls[0].headers), 'the access code is not forwarded');
  });

  it('accepts origins from STARPI_ALLOWED_ORIGINS', async () => {
    const fetch = recordingFetch(sse());
    const res = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: { origin: 'https://app.example.org', 'sec-fetch-site': 'cross-site', ...bearer(OPENAI_KEY) } }), relayDeps(fetch, { extraOrigins: ['https://app.example.org'] }));
    assert.equal(res.status, 200);
    await readAll(res.body);
  });

  it('refuses unknown providers, local servers and paths outside the allowlist without an upstream call', async () => {
    const fetch = recordingFetch(sse());
    const deps = relayDeps(fetch);
    const cases = [
      ['/api/relay/ollama/v1/chat/completions', 404, 'unknown_provider'],
      ['/api/relay/local/v1/chat/completions', 404, 'unknown_provider'],
      ['/api/relay/http:%2F%2F127.0.0.1:11434/v1/chat/completions', 404, 'unknown_provider'],
      ['/api/relay/openai/v1/files', 404, 'path_not_allowed'],
      ['/api/relay/openai', 404, 'path_not_allowed'],
      ['/api/relay/anthropic/v1/messages/batches', 404, 'path_not_allowed'],
      ['/api/relay/openai/v1/models', 405, 'method_not_allowed'],
    ];
    for (const [p, status, error] of cases) {
      assert.deepEqual(await errorOf(await handleRelay(jsonRequest(/** @type {string} */ (p), CHAT_BODY, { headers: bearer(OPENAI_KEY) }), deps)), { status, error }, String(p));
    }
    assert.equal(fetch.calls.length, 0);
  });

  it('refuses keys and odd names in the query, and long queries', async () => {
    const fetch = recordingFetch(sse());
    const deps = relayDeps(fetch);
    const base = '/api/relay/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent';
    const cases = [
      [`${base}?key=${GEMINI_KEY}`, 400, 'key_in_query'],
      [`${base}?alt=sse&api_key=x`, 400, 'key_in_query'],
      [`${base}?alt=sse&access_token=x`, 400, 'key_in_query'],
      [`${base}?alt=${GEMINI_KEY}`, 400, 'key_in_query'],
      [`${base}?alt=sse&%24where=1`, 400, 'query_not_allowed'],
      [`${base}?alt=${'x'.repeat(RELAY_LIMITS.maxQueryChars)}`, 414, 'query_too_long'],
    ];
    for (const [p, status, error] of cases) {
      const res = await handleRelay(jsonRequest(/** @type {string} */ (p), { contents: [] }, { headers: { 'x-goog-api-key': GEMINI_KEY } }), deps);
      assert.deepEqual(await errorOf(res), { status, error }, String(p).slice(0, 120));
    }
    assert.equal(fetch.calls.length, 0);
  });

  it('wants exactly one auth header, in the provider style', async () => {
    const fetch = recordingFetch(sse());
    const deps = relayDeps(fetch);
    const messages = '/api/relay/anthropic/v1/messages';
    const body = { model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] };
    const cases = [
      [messages, {}, 401, 'key_required'],
      [messages, bearer(ANTHROPIC_KEY), 400, 'auth_header_not_allowed'],
      [messages, { 'x-api-key': ANTHROPIC_KEY, authorization: `Bearer ${ANTHROPIC_KEY}` }, 400, 'auth_header_not_allowed'],
      [messages, { 'x-api-key': ANTHROPIC_KEY, 'x-goog-api-key': GEMINI_KEY }, 400, 'auth_header_not_allowed'],
      [messages, { 'x-api-key': `${ANTHROPIC_KEY}, ${ANTHROPIC_KEY}` }, 400, 'auth_header_invalid'],
      [messages, { 'x-api-key': 'short' }, 400, 'auth_header_invalid'],
      ['/api/relay/openai/v1/chat/completions', { 'x-api-key': OPENAI_KEY }, 400, 'auth_header_not_allowed'],
      ['/api/relay/openai/v1/chat/completions', { authorization: `Basic ${OPENAI_KEY}` }, 400, 'auth_header_invalid'],
      ['/api/relay/openai/v1/chat/completions', { authorization: `Bearer ${OPENAI_KEY}, Bearer ${OPENAI_KEY}` }, 400, 'auth_header_invalid'],
      ['/api/relay/gemini/v1beta/models/gemini-2.5-flash:generateContent', bearer(GEMINI_KEY), 400, 'auth_header_not_allowed'],
    ];
    for (const [p, headers, status, error] of cases) {
      const res = await handleRelay(jsonRequest(/** @type {string} */ (p), body, { headers: /** @type {Record<string, string>} */ (headers) }), deps);
      assert.deepEqual(await errorOf(res), { status, error }, `${p} ${Object.keys(/** @type {object} */ (headers)).join('+')}`);
    }
    assert.equal(fetch.calls.length, 0);
  });

  it('caps the body at 4 MB and accepts JSON objects, and multipart only for transcription', async () => {
    const fetch = recordingFetch(jsonAnswer(200, { text: 'ok' }));
    const deps = relayDeps(fetch);
    const chat = '/api/relay/openai/v1/chat/completions';
    const big = await handleRelay(siteRequest(chat, { headers: { ...bearer(OPENAI_KEY), 'content-type': 'application/json', 'content-length': String(RELAY_LIMITS.maxBodyBytes + 1) }, body: '{}' }), deps);
    assert.deepEqual(await errorOf(big), { status: 413, error: 'payload_too_large' });
    const streamed = await handleRelay(siteRequest(chat, { headers: { ...bearer(OPENAI_KEY), 'content-type': 'application/json' }, body: `{"x":"${'a'.repeat(RELAY_LIMITS.maxBodyBytes)}"}` }), deps);
    assert.deepEqual(await errorOf(streamed), { status: 413, error: 'payload_too_large' });
    for (const [type, text, error, status] of [
      ['text/plain', '{}', 'unsupported_media_type', 415],
      ['application/json', '{"a":', 'invalid_json', 400],
      ['application/json', '[1]', 'json_body_must_be_object', 400],
      ['application/json', '{"model":7}', 'invalid_field', 400],
      ['multipart/form-data; boundary=x1', '--x1--', 'unsupported_media_type', 415],
    ]) {
      const res = await handleRelay(siteRequest(chat, { headers: { ...bearer(OPENAI_KEY), 'content-type': type }, body: text }), deps);
      assert.equal((await errorOf(res)).error, error, `${type} ${text}`);
      assert.equal(res.status, status);
    }
    assert.equal(fetch.calls.length, 0);

    const form = '--b0undary\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-test\r\n--b0undary--\r\n';
    const ok = await handleRelay(siteRequest('/api/relay/openai/v1/audio/transcriptions', { headers: { ...bearer(OPENAI_KEY), 'content-type': 'multipart/form-data; boundary=b0undary' }, body: form }), deps);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { text: 'ok' });
    assert.equal(fetch.calls[0].body, form, 'multipart bytes pass unchanged');
    assert.equal(fetch.calls[0].headers['content-type'], 'multipart/form-data; boundary=b0undary');
  });

  it('forwards only the key, the content type, accept and the allowlisted provider headers', async () => {
    const fetch = recordingFetch(sse());
    const deps = relayDeps(fetch);
    const res = await handleRelay(
      jsonRequest('/api/relay/anthropic/v1/messages', { model: 'claude-test', max_tokens: 16, messages: [] }, {
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          accept: 'text/event-stream',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': `${KNOWN_ANTHROPIC_BETAS[0]}, files-api-2025-04-14, evil-beta, ${KNOWN_ANTHROPIC_BETAS[0]}`,
          'anthropic-dangerous-direct-browser-access': 'true',
          cookie: 'session=abc',
          'x-forwarded-for': '10.0.0.1',
          'user-agent': 'test',
          'x-starpi-access': 'whatever',
        },
      }),
      deps,
    );
    assert.equal(res.status, 200);
    await readAll(res.body);
    const [call] = fetch.calls;
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.deepEqual(call.headers, {
      'x-api-key': ANTHROPIC_KEY,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': KNOWN_ANTHROPIC_BETAS[0],
    });

    const routerFetch = recordingFetch(jsonAnswer(200, { data: [] }));
    const listed = await handleRelay(siteRequest('/api/relay/openrouter/v1/models', { method: 'GET', headers: { ...bearer(OPENAI_KEY), 'x-title': 'Starpi', 'http-referer': SITE, 'anthropic-version': '2023-06-01' } }), relayDeps(routerFetch));
    assert.equal(listed.status, 200);
    await listed.json();
    assert.deepEqual(routerFetch.calls[0].headers, { authorization: `Bearer ${OPENAI_KEY}`, 'x-title': 'Starpi', 'http-referer': SITE });
    assert.equal(routerFetch.calls[0].init.body, undefined, 'a GET carries no body');
  });
});

describe('handleRelay answers', () => {
  it('relays a 200 event stream byte for byte and cancels the upstream when the browser stops', async () => {
    const upstream = sse([...SSE_CHUNKS]);
    const fetch = recordingFetch(upstream);
    const res = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: bearer(OPENAI_KEY) }), relayDeps(fetch));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(await readAll(res.body), SSE_CHUNKS.join(''));
    assert.equal(fetch.calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.deepEqual(JSON.parse(fetch.calls[0].body), CHAT_BODY);

    const stalled = sse([SSE_CHUNKS[0]], { stall: true });
    const res2 = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: bearer(OPENAI_KEY) }), relayDeps(recordingFetch(stalled)));
    const reader = /** @type {ReadableStream<Uint8Array>} */ (res2.body).getReader();
    await reader.read();
    await reader.cancel();
    assert.ok(stalled.state.cancelled, 'the upstream body was not cancelled');
  });

  it('answers 502 upstream_empty when a stream ends before its first byte', async () => {
    const res = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: bearer(OPENAI_KEY) }), relayDeps(recordingFetch(sse([]))));
    assert.deepEqual(await errorOf(res), { status: 502, error: 'upstream_empty' });
  });

  it('passes JSON and audio through, and cuts a body above the cap', async () => {
    const json = await handleRelay(siteRequest('/api/relay/openai/v1/models', { method: 'GET', headers: bearer(OPENAI_KEY) }), relayDeps(recordingFetch(jsonAnswer(200, { data: [{ id: 'm' }] }))));
    assert.equal(json.status, 200);
    assert.equal(json.headers.get('content-type'), 'application/json');
    assert.deepEqual(await json.json(), { data: [{ id: 'm' }] });

    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0, 1, 2, 3]);
    const audio = await handleRelay(jsonRequest('/api/relay/openai/v1/audio/speech', { model: 'tts-test', input: 'Hi', voice: 'x' }, { headers: bearer(OPENAI_KEY) }), relayDeps(recordingFetch(answer(200, { 'content-type': 'audio/mpeg' }, [mp3]))));
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), mp3);

    const huge = new Uint8Array(RELAY_LIMITS.maxPassthroughBytes / 4);
    const tooBig = answer(200, { 'content-type': 'audio/mpeg' }, [huge, huge, huge, huge, huge], { stall: true });
    const cut = await handleRelay(jsonRequest('/api/relay/openai/v1/audio/speech', { model: 'tts-test', input: 'Hi' }, { headers: bearer(OPENAI_KEY) }), relayDeps(recordingFetch(tooBig)));
    await assert.rejects(cut.arrayBuffer());
    assert.ok(tooBig.state.cancelled);

    const html = await handleRelay(siteRequest('/api/relay/openai/v1/models', { method: 'GET', headers: bearer(OPENAI_KEY) }), relayDeps(recordingFetch(answer(200, { 'content-type': 'text/html' }, ['<html>']))));
    assert.deepEqual(await errorOf(html), { status: 502, error: 'unexpected_content_type' });
  });

  it('turns an upstream error into { error, upstreamStatus } and reads at most 2 KB of it', async () => {
    const cases = [
      [jsonAnswer(401, { error: { message: `Incorrect API key provided: ${OPENAI_KEY}`, type: 'invalid_request_error', code: 'invalid_api_key' } }), 401, 'invalid_api_key'],
      [jsonAnswer(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } }), 400, 'invalid_request_error'],
      [jsonAnswer(429, { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '17' }), 429, 'resource_exhausted'],
      [jsonAnswer(404, { detail: { status: 'voice_not_found', message: 'x' } }), 404, 'voice_not_found'],
      [jsonAnswer(400, { error: { code: 'Bad Code!', type: 'x'.repeat(41) } }), 400, 'upstream_error'],
      [answer(500, { 'content-type': 'text/html' }, ['<h1>oops</h1>']), 502, 'upstream_error'],
      [answer(503, { 'content-type': 'application/json' }, [`{"error":{"type":"overloaded_error","message":"${'m'.repeat(4000)}"}}`]), 502, 'overloaded_error'],
    ];
    for (const [upstream, status, error] of cases) {
      const res = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: bearer(OPENAI_KEY) }), relayDeps(recordingFetch(/** @type {any} */ (upstream))));
      const text = await res.text();
      assert.equal(res.status, status, error);
      const upstreamStatus = /** @type {any} */ (upstream)().status;
      assert.deepEqual(JSON.parse(text), { error, upstreamStatus }, error);
      assert.ok(!text.includes(OPENAI_KEY) && !text.includes('message'), 'nothing of the upstream text is echoed');
      if (upstreamStatus === 429) assert.equal(res.headers.get('retry-after'), '17');
    }
    assert.equal(upstreamErrorCode('{"error":{"type":"invalid_request_error","message":"cut'), 'invalid_request_error');
    assert.equal(upstreamErrorCode(''), 'upstream_error');

    const endless = answer(500, { 'content-type': 'application/json' }, ['{"error":{"code":"', 'x'.repeat(1024), 'x'.repeat(1024), 'x'.repeat(1024)], { stall: true });
    const res = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: bearer(OPENAI_KEY) }), relayDeps(recordingFetch(endless)));
    assert.deepEqual(await errorOf(res), { status: 502, error: 'upstream_error', upstreamStatus: 500 });
    assert.ok(endless.state.cancelled, 'the relay stops reading after 2 KB');
  });

  it('maps a failed fetch to 502, and a client that left to 499', async () => {
    const down = recordingFetch(() => {
      throw new TypeError(`connect failed for ${OPENAI_KEY}`);
    });
    const res = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: bearer(OPENAI_KEY) }), relayDeps(down));
    assert.deepEqual(await errorOf(res), { status: 502, error: 'upstream_unreachable' });
    assert.equal(down.calls[0].init.redirect, 'error');

    const client = new AbortController();
    const hanging = recordingFetch((init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    setTimeout(() => client.abort(), 10);
    const left = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: bearer(OPENAI_KEY), signal: client.signal }), relayDeps(hanging));
    assert.deepEqual(await errorOf(left), { status: 499, error: 'client_closed' });
    assert.ok(hanging.calls[0].init.signal?.aborted, 'the upstream request was aborted');
  });
});

describe('relay against the provider fakes', () => {
  /** @type {Array<{ close: () => Promise<void> }>} */
  const fakes = [];
  /** @type {Record<string, string>} */
  const roots = {};
  /** @type {Record<string, any>} */
  const servers = {};

  before(async () => {
    for (const [id, fake] of /** @type {const} */ ([
      ['openai', createOpenAiFake({ gapMs: 0 })],
      ['anthropic', createAnthropicFake({ gapMs: 0 })],
      ['gemini', createGeminiFake({ gapMs: 0 })],
      ['elevenlabs', createElevenLabsFake({ gapMs: 0 })],
      ['search', createSearchFake({ gapMs: 0 })],
    ])) {
      const { url } = await fake.listen(0);
      fakes.push(fake);
      servers[id] = fake;
      roots[id] = url;
    }
  });
  after(async () => {
    await Promise.all(fakes.map((f) => f.close()));
  });

  const deps = () => {
    const env = {
      STARPI_OPENAI_BASE_URL: roots.openai,
      STARPI_GROQ_BASE_URL: `${roots.openai}/flavor/groq/openai`,
      STARPI_ANTHROPIC_BASE_URL: roots.anthropic,
      STARPI_GEMINI_BASE_URL: roots.gemini,
      STARPI_ELEVENLABS_BASE_URL: roots.elevenlabs,
      STARPI_BRAVE_BASE_URL: roots.search,
      STARPI_TAVILY_BASE_URL: roots.search,
    };
    return { ...frontGuards(), roots: relayRoots(env), fetch };
  };

  it('streams chat completions, Messages and Gemini through the relay', async () => {
    const chat = await handleRelay(jsonRequest('/api/relay/groq/v1/chat/completions', { model: 'fake-groq-small', stream: true, messages: [{ role: 'user', content: 'Hello there' }] }, { headers: bearer(testKey('groq')) }), deps());
    assert.equal(chat.status, 200);
    const chatText = await readAll(chat.body);
    assert.match(chatText, /"model":"fake-groq-small"/);
    assert.match(chatText, /"content":"a simulated "/);
    assert.match(chatText, /data: \[DONE\]/);

    const messages = await handleRelay(jsonRequest('/api/relay/anthropic/v1/messages', { model: 'claude-opus-5-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Hello there' }] }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' } }), deps());
    assert.equal(messages.status, 200);
    assert.match(await readAll(messages.body), /event: message_stop/);

    const gemini = await handleRelay(jsonRequest('/api/relay/gemini/v1beta/models/gemini-fake-flash:streamGenerateContent?alt=sse', { contents: [{ role: 'user', parts: [{ text: 'Hello there' }] }] }, { headers: { 'x-goog-api-key': GEMINI_KEY } }), deps());
    assert.equal(gemini.status, 200);
    assert.match(await readAll(gemini.body), /"candidates"/);
    const recorded = servers.gemini.requests.at(-1);
    assert.equal(recorded.query.alt, 'sse');
    assert.equal(recorded.headers['x-goog-api-key'], GEMINI_KEY);
  });

  it('passes speech, voices and search through, with the provider auth header', async () => {
    const voices = await handleRelay(siteRequest('/api/relay/elevenlabs/v1/voices', { method: 'GET', headers: { 'xi-api-key': testKey('plain') } }), deps());
    assert.equal(voices.status, 200);
    const voiceId = (await voices.json()).voices[0].voice_id;
    const speech = await handleRelay(jsonRequest(`/api/relay/elevenlabs/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, { text: 'Hello' }, { headers: { 'xi-api-key': testKey('plain') } }), deps());
    assert.equal(speech.status, 200);
    assert.equal(speech.headers.get('content-type'), 'audio/mpeg');
    assert.ok((await speech.arrayBuffer()).byteLength > 0);

    const brave = await handleRelay(siteRequest('/api/relay/brave/res/v1/web/search?q=plain+words&count=2', { method: 'GET', headers: { 'x-subscription-token': testKey('plain') } }), deps());
    assert.equal(brave.status, 200);
    assert.equal((await brave.json()).web.results.length, 2);

    const tavily = await handleRelay(jsonRequest('/api/relay/tavily/search', { query: 'plain words', max_results: 1 }, { headers: bearer(testKey('plain')) }), deps());
    assert.equal(tavily.status, 200);
    assert.equal((await tavily.json()).results.length, 1);
  });

  it('reports provider faults as identifiers with the upstream status', async () => {
    const auth = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', CHAT_BODY, { headers: { ...bearer(OPENAI_KEY) } }), {
      ...deps(),
      fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => fetch(url, { ...init, headers: { ...(/** @type {Record<string, string>} */ (init.headers)), 'x-fake-fault': '401' } }),
    });
    assert.deepEqual(await errorOf(auth), { status: 401, error: 'invalid_api_key', upstreamStatus: 401 });
    const limited = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', { ...CHAT_BODY, messages: [{ role: 'user', content: 'x [[fake-fault:429]]' }] }, { headers: bearer(OPENAI_KEY) }), deps());
    assert.deepEqual(await errorOf(limited), { status: 429, error: 'rate_limit_exceeded', upstreamStatus: 429 });
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });
});

describe('relay route wiring', () => {
  it('serves GET and POST and refuses every other method with 405', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      const res = await relayRoute[/** @type {'PUT'} */ (method)]();
      assert.deepEqual(await errorOf(res), { status: 405, error: 'method_not_allowed' }, method);
      assert.equal(res.headers.get('allow'), 'GET, POST');
    }
    const res = await relayRoute.POST(siteRequest('/api/relay/openai/v1/chat/completions', { headers: { origin: undefined, 'sec-fetch-site': undefined } }));
    assert.deepEqual(await errorOf(res), { status: 403, error: 'origin_required' });
  });

  it('keeps vercel.json and the relay deadline in step', () => {
    const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    assert.deepEqual(vercel.functions['api/relay.js'], { maxDuration: RELAY_FUNCTION_MAX_MS / 1000, supportsCancellation: true });
    assert.deepEqual(vercel.rewrites, [{ source: '/api/relay/:provider/:path*', destination: '/api/relay' }]);
    assert.ok(RELAY_LIMITS.idleMs === 90_000 && RELAY_LIMITS.maxStreamBytes === 16 * 1024 * 1024 && RELAY_LIMITS.maxBodyBytes === 4_000_000);
  });
});
