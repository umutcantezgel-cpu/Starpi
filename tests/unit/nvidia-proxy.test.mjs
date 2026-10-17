// NVIDIA proxy (api/): key parsing, request validation (the shared vectors in
// backend/test_fixtures/nvidia_validation.json), the failover router, the stream relay, the request
// guards, the models route and the Vercel wiring (the chat route itself runs the pool handler, see
// pool.test.mjs). Upstream calls go to an injected fetch; timings are a few milliseconds and
// cooldowns use a fake clock.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseKeys, parseOrigins, positiveInt } from '../../api/_lib/env.js';
import { checkSameOrigin, clientIp, createRateLimiter, readJsonBody } from '../../api/_lib/guards.js';
import { handleModels, runtimeDeps } from '../../api/_lib/handlers.js';
import { validateChatRequest } from '../../api/_lib/nvidia-request.js';
import { createKeyRouter, parseRetryAfter } from '../../api/_lib/nvidia-router.js';
import { relayStream, sseError } from '../../api/_lib/nvidia-stream.js';
import { POOL_FUNCTION_MAX_MS } from '../../api/_lib/pool/handler.js';
import * as chatRoute from '../../api/chat/nvidia.js';
import * as modelsRoute from '../../api/models/nvidia.js';
import { NVIDIA_DEFAULT_MODEL, NVIDIA_MODELS, NVIDIA_PROXY, NVIDIA_UPSTREAM_URL } from '../../src/js/models/nvidia-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Valid-format keys are built at runtime, so no key-shaped literal exists in the repository. */
const key = (/** @type {number} */ n) => `nvapi-${'t'.repeat(63)}${n}`;
const TIMING = { ...NVIDIA_PROXY, attemptTimeoutMs: 40, failoverBudgetMs: 400, idleTimeoutMs: 40 };
const BODY = { model: NVIDIA_DEFAULT_MODEL, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16, stream: true };
const SSE = ['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n'];
const SECRET_BODY = 'UPSTREAM-SECRET-BODY';
const encoder = new TextEncoder();

// ---------------------------------------------------------------- fakes

/** A fake clock for cooldown arithmetic. */
function fakeClock(start = 1_700_000_000_000) {
  const clock = { t: start, now: () => clock.t };
  return clock;
}

/**
 * A body stream that records whether it was cancelled.
 * @param {string[]} chunks queued at start
 * @param {{ stall?: boolean, fail?: boolean }} [options] stall: never ends; fail: errors after the chunks
 */
function body(chunks, { stall = false, fail = false } = {}) {
  const state = { cancelled: false };
  const stream = new ReadableStream(
    {
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!stall && !fail) controller.close();
      },
      // Called only once the queued chunks are read (high-water mark 0).
      pull(controller) {
        if (fail) controller.error(new Error('connection reset'));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const sse = (chunks = SSE, headers = {}) => () => new Response(body(chunks).stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });

/**
 * Upstream responses with a fresh body per call; `state.cancelled` is true once every body was dropped.
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {string[]} chunks
 * @param {{ stall?: boolean }} [options]
 */
function responses(status, headers, chunks, options) {
  const bodies = /** @type {Array<{ cancelled: boolean }>} */ ([]);
  const respond = () => {
    const { stream, state } = body(chunks, options);
    bodies.push(state);
    return new Response(stream, { status, headers });
  };
  const state = {
    get cancelled() {
      return bodies.length > 0 && bodies.every((b) => b.cancelled);
    },
  };
  return Object.assign(respond, { state });
}

/** An upstream answer whose body must never be read or echoed. */
const answer = (status, headers = {}, contentType = 'application/json') => responses(status, { 'content-type': contentType, ...headers }, [SECRET_BODY]);

/** A 200 event stream that never sends a byte. */
const stalled = () => responses(200, { 'content-type': 'text/event-stream' }, [], { stall: true });

const networkError = () => () => {
  throw new TypeError('fetch failed');
};

/** A request that only ends when its signal aborts. */
const hanging = () => (/** @type {RequestInit} */ init) =>
  new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

/**
 * Fetch that plays the given answers in order (the last one repeats) and records each call.
 * @param {...(init: RequestInit) => Response | Promise<Response>} answers
 */
function fakeFetch(...answers) {
  /** @type {Array<{ url: string, init: RequestInit, key: string }>} */
  const calls = [];
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    const auth = /** @type {Record<string, string>} */ (init.headers).Authorization;
    calls.push({ url, init, key: auth.slice('Bearer '.length) });
    return answers[Math.min(calls.length - 1, answers.length - 1)](init);
  };
  return Object.assign(fetch, { calls });
}

/**
 * @param {number} count
 * @param {ReturnType<typeof fakeFetch>} fetch
 * @param {{ now?: () => number }} [options]
 */
function makeRouter(count, fetch, { now = () => Date.now() } = {}) {
  /** @type {string[]} */
  const logs = [];
  const keys = Array.from({ length: count }, (_, i) => key(i + 1));
  const router = createKeyRouter({ keys, fetch, now, log: (line) => logs.push(line), timing: TIMING });
  return { router, logs, keys };
}

/** @param {ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>} source */
async function readAll(source) {
  const reader = 'getReader' in source ? source.getReader() : source;
  let text = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

/** @param {{ ok: true, first: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array> } | { ok: false }} opened */
async function streamText(opened) {
  assert.ok(opened.ok, `expected a stream, got ${JSON.stringify(opened)}`);
  return new TextDecoder().decode(opened.first) + (await readAll(opened.reader));
}

// ---------------------------------------------------------------- environment

describe('parseKeys', () => {
  it('accepts valid keys separated by commas, spaces or newlines', () => {
    assert.deepEqual(parseKeys(`${key(1)},${key(2)} ${key(3)}\n${key(4)}\t, ,${key(5)}`), { keys: [1, 2, 3, 4, 5].map(key), invalid: 0 });
  });

  it('drops duplicates', () => {
    assert.deepEqual(parseKeys(`${key(1)},${key(1)},${key(2)}`).keys, [key(1), key(2)]);
  });

  it('counts and drops short keys, wrong prefixes and keys with Markdown escapes', () => {
    const escaped = `nvapi-${'a\\_'.repeat(32)}`;
    const result = parseKeys([key(1), key(1).slice(0, -1), key(2).replace('nvapi-', 'nvapx-'), escaped, `${key(3)}x`].join(','));
    assert.deepEqual(result, { keys: [key(1)], invalid: 4 });
  });

  it('returns no keys for an unset or empty variable', () => {
    assert.deepEqual(parseKeys(undefined), { keys: [], invalid: 0 });
    assert.deepEqual(parseKeys(' , \n'), { keys: [], invalid: 0 });
  });
});

describe('parseOrigins and positiveInt', () => {
  it('keeps serialized http(s) origins only', () => {
    assert.deepEqual(parseOrigins(' https://starpi.app/ ,http://localhost:3000, ftp://x.example, not a url,, HTTPS://STARPI.APP'), ['https://starpi.app', 'http://localhost:3000']);
    assert.deepEqual(parseOrigins(undefined), []);
  });

  it('reads positive decimal integers and falls back otherwise', () => {
    assert.equal(positiveInt('30', 20), 30);
    assert.equal(positiveInt(' 7 ', 20), 7);
    for (const raw of [undefined, '', '0', '-3', '1.5', '1e3', 'abc', '99999999999999999999']) assert.equal(positiveInt(raw, 20), 20, String(raw));
  });
});

// ---------------------------------------------------------------- validation

/** Expands `{"$repeat": [text, n]}` placeholders of the shared vectors. */
function expand(/** @type {unknown} */ value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0][0] === '$repeat') {
      const [text, times] = /** @type {[string, number]} */ (entries[0][1]);
      return text.repeat(times);
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

describe('validateChatRequest', () => {
  const { vectors } = JSON.parse(readFileSync(path.join(ROOT, 'backend/test_fixtures/nvidia_validation.json'), 'utf8'));

  it('passes every shared vector (backend/test_fixtures/nvidia_validation.json)', () => {
    assert.ok(vectors.length >= 30, `only ${vectors.length} vectors`);
    for (const vector of vectors) {
      const result = validateChatRequest(expand(vector.body));
      if ('upstream' in vector.expect) {
        assert.ok(result.ok, `${vector.name}: ${JSON.stringify(result)}`);
        assert.deepEqual(result.body, expand(vector.expect.upstream), vector.name);
      } else {
        assert.ok(!result.ok, vector.name);
        assert.equal(result.status, 400, vector.name);
        assert.deepEqual({ error: result.error, field: result.field }, { field: undefined, ...vector.expect }, vector.name);
      }
    }
  });

  it('lets no catalog upstream field override the model, the messages, the token cap or streaming', () => {
    for (const model of NVIDIA_MODELS) {
      const result = validateChatRequest({ model: model.id, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1_000_000, stream: false });
      assert.ok(result.ok, model.id);
      assert.equal(result.body.model, model.id);
      assert.equal(result.body.stream, true);
      assert.equal(result.body.max_tokens, model.maxOutputTokens);
      assert.deepEqual(result.body.messages, [{ role: 'user', content: 'Hi' }]);
      assert.deepEqual(Object.keys(result.body).sort(), [...Object.keys(model.upstream ?? {}), 'max_tokens', 'messages', 'model', 'stream'].sort());
    }
  });
});

// ---------------------------------------------------------------- router

describe('createKeyRouter', () => {
  it('streams from the first key and sends it only in Authorization to the fixed URL with redirect error', async () => {
    const fetch = fakeFetch(sse());
    const { router } = makeRouter(2, fetch);
    const opened = await router.open(BODY, { deadline: Date.now() + 400 });
    assert.equal(await streamText(opened), SSE.join(''));
    assert.equal(fetch.calls.length, 1);
    const [{ url, init, key: used }] = fetch.calls;
    assert.equal(url, NVIDIA_UPSTREAM_URL);
    assert.equal(used, key(1));
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { Authorization: `Bearer ${key(1)}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' });
    assert.deepEqual(JSON.parse(String(init.body)), BODY);
    assert.ok(!String(init.body).includes('nvapi-'));
  });

  it('fails over on 429 and cools the key for its Retry-After seconds', async () => {
    const clock = fakeClock();
    const limited = answer(429, { 'retry-after': '12' });
    const fetch = fakeFetch(limited, sse());
    const { router } = makeRouter(2, fetch, clock);
    const opened = await router.open(BODY, { deadline: clock.t + 400 });
    assert.equal(await streamText(opened), SSE.join(''));
    assert.ok(opened.ok && opened.attempts === 2);
    assert.deepEqual(fetch.calls.map((c) => c.key), [key(1), key(2)]);
    assert.deepEqual(router.coolingUntil(), [clock.t + 12_000, 0]);
    assert.ok(limited.state.cancelled, 'the 429 body was not cancelled');
  });

  it('parses Retry-After as seconds and as an HTTP date and clamps the cooldown to 1..300 s', async () => {
    const clock = fakeClock();
    assert.equal(parseRetryAfter('12', clock.t), 12_000);
    assert.equal(parseRetryAfter(new Date(clock.t + 50_000).toUTCString(), clock.t), 50_000);
    assert.equal(parseRetryAfter(new Date(clock.t - 50_000).toUTCString(), clock.t), 0);
    for (const bad of [null, '', 'soon', '1.5', '-3', '2026-10-14', 'Wed, 99 Oct 2026 10:00:00 GMT']) assert.equal(parseRetryAfter(bad, clock.t), null, String(bad));

    const cases = [
      ['0', 1_000],
      ['9999', 300_000],
      [new Date(clock.t + 42_000).toUTCString(), 42_000],
      ['later', NVIDIA_PROXY.cooldownMs.rateLimitedDefault],
    ];
    for (const [retryAfter, expected] of cases) {
      const { router } = makeRouter(1, fakeFetch(answer(429, { 'retry-after': retryAfter })), clock);
      const result = await router.open(BODY, { deadline: clock.t + 400 });
      assert.equal(result.ok, false);
      assert.deepEqual(router.coolingUntil(), [clock.t + expected], retryAfter);
    }
  });

  it('fails over on 500, 502, 503, 408 and network errors with the transient cooldown', async () => {
    const clock = fakeClock();
    const fetch = fakeFetch(answer(500), answer(502), answer(503), answer(408), networkError(), sse());
    const { router } = makeRouter(6, fetch, clock);
    const opened = await router.open(BODY, { deadline: clock.t + 400 });
    assert.equal(await streamText(opened), SSE.join(''));
    const cooled = clock.t + NVIDIA_PROXY.cooldownMs.transient;
    assert.deepEqual(router.coolingUntil(), [cooled, cooled, cooled, cooled, cooled, 0]);
  });

  it('fails over when the first byte misses the attempt timeout', async () => {
    const clock = fakeClock();
    const slow = stalled();
    const fetch = fakeFetch(slow, sse());
    const { router } = makeRouter(2, fetch, clock);
    const opened = await router.open(BODY, { deadline: clock.t + 400 });
    assert.equal(await streamText(opened), SSE.join(''));
    assert.ok(slow.state.cancelled, 'the stalled upstream body was not cancelled');
    assert.ok(fetch.calls[0].init.signal?.aborted, 'the stalled upstream request was not aborted');
    assert.equal(router.coolingUntil()[0], clock.t + NVIDIA_PROXY.cooldownMs.transient);
  });

  it('fails over when a 200 stream ends before any byte', async () => {
    const fetch = fakeFetch(sse([]), sse(['', ...SSE]));
    const { router } = makeRouter(2, fetch);
    assert.equal(await streamText(await router.open(BODY, { deadline: Date.now() + 400 })), SSE.join(''));
    assert.equal(fetch.calls.length, 2);
  });

  it('parks 401 and 403 keys for 30 minutes and skips them on later requests', async () => {
    for (const status of [401, 403]) {
      const clock = fakeClock();
      const fetch = fakeFetch(sse(), answer(status), sse());
      const { router } = makeRouter(2, fetch, clock);
      for (let i = 0; i < 4; i++) assert.ok((await router.open(BODY, { deadline: clock.t + 400 })).ok);
      // Request 2 starts at key 2, which is rejected; requests 3 and 4 skip it.
      assert.deepEqual(fetch.calls.map((c) => c.key), [key(1), key(2), key(1), key(1), key(1)]);
      assert.deepEqual(router.coolingUntil(), [0, clock.t + 30 * 60_000]);
    }
  });

  it('returns 503 all_keys_exhausted with the soonest Retry-After when every key failed', async () => {
    const clock = fakeClock();
    const fetch = fakeFetch(answer(429, { 'retry-after': '12' }), answer(429, { 'retry-after': '7' }));
    const { router } = makeRouter(2, fetch, clock);
    assert.deepEqual(await router.open(BODY, { deadline: clock.t + 400 }), { ok: false, status: 503, error: 'all_keys_exhausted', retryAfterS: 7 });
  });

  it('answers 503 without any upstream request while all keys cool down', async () => {
    const clock = fakeClock();
    const fetch = fakeFetch(answer(429, { 'retry-after': '30' }));
    const { router } = makeRouter(2, fetch, clock);
    await router.open(BODY, { deadline: clock.t + 400 });
    assert.equal(fetch.calls.length, 2);
    clock.t += 10_500;
    assert.deepEqual(await router.open(BODY, { deadline: clock.t + 400 }), { ok: false, status: 503, error: 'all_keys_exhausted', retryAfterS: 20 });
    assert.equal(fetch.calls.length, 2);
    clock.t += 20_000;
    assert.equal((await router.open(BODY, { deadline: clock.t + 400 })).ok, false);
    assert.equal(fetch.calls.length, 4, 'keys are used again after the cooldown');
  });

  it('returns 504 upstream_timeout when every attempt timed out', async () => {
    const fetch = fakeFetch(hanging(), stalled());
    const { router } = makeRouter(2, fetch);
    assert.deepEqual(await router.open(BODY, { deadline: Date.now() + 400 }), { ok: false, status: 504, error: 'upstream_timeout' });
    assert.equal(fetch.calls.length, 2);
  });

  it('does not fail over on 400, 404, 422 or a 200 that is not SSE, and never echoes the upstream body', async () => {
    const cases = [
      [answer(400), 'upstream_rejected'],
      [answer(404), 'model_unavailable'],
      [answer(422), 'upstream_rejected'],
      [answer(200, {}, 'application/json'), 'upstream_rejected'],
    ];
    for (const [upstream, error] of cases) {
      const fetch = fakeFetch(upstream, sse());
      const { router, logs } = makeRouter(2, fetch);
      const result = await router.open(BODY, { deadline: Date.now() + 400 });
      assert.deepEqual(result, { ok: false, status: 502, error });
      assert.equal(fetch.calls.length, 1, error);
      assert.ok(upstream.state.cancelled, `${error}: the body was not cancelled`);
      assert.ok(!JSON.stringify(result).includes(SECRET_BODY) && !logs.join('\n').includes(SECRET_BODY));
      assert.deepEqual(router.coolingUntil(), [0, 0]);
    }
  });

  it('starts each request on the next key (round robin)', async () => {
    const fetch = fakeFetch(sse());
    const { router } = makeRouter(3, fetch);
    for (let i = 0; i < 4; i++) await streamText(await router.open(BODY, { deadline: Date.now() + 400 }));
    assert.deepEqual(fetch.calls.map((c) => c.key), [key(1), key(2), key(3), key(1)]);
  });

  it('does not park a key whose attempt only timed out because the budget ran short', async () => {
    // Real clock: 15 ms of budget is less than the 40 ms attempt time, and the stalled key times out.
    const fetch = fakeFetch(stalled());
    const { router } = makeRouter(1, fetch);
    const result = await router.open(BODY, { deadline: Date.now() + 15 });
    assert.deepEqual(result, { ok: false, status: 504, error: 'upstream_timeout' });
    assert.deepEqual(router.coolingUntil(), [0], 'the key was parked for a timeout it could not avoid');
  });

  it('stops failing over at the deadline', async () => {
    const clock = fakeClock();
    // Each upstream answer takes 150 ms on the fake clock; the budget is 400 ms.
    const slow429 = () => {
      clock.t += 150;
      return answer(429)();
    };
    const fetch = fakeFetch(slow429);
    const { router } = makeRouter(5, fetch, clock);
    const result = await router.open(BODY, { deadline: clock.t + 400 });
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(result, { ok: false, status: 503, error: 'all_keys_exhausted', retryAfterS: 1 });
  });

  it('returns client_closed and aborts upstream when the request signal aborts', async () => {
    for (const upstream of [hanging(), stalled()]) {
      const fetch = fakeFetch(upstream, sse());
      const { router } = makeRouter(2, fetch);
      const client = new AbortController();
      setTimeout(() => client.abort(), 10);
      const result = await router.open(BODY, { signal: client.signal, deadline: Date.now() + 400 });
      assert.deepEqual(result, { ok: false, status: 499, error: 'client_closed' });
      assert.equal(fetch.calls.length, 1);
      assert.ok(fetch.calls[0].init.signal?.aborted);
      assert.deepEqual(router.coolingUntil(), [0, 0], 'a client abort does not park the key');
    }
  });

  it('logs key indexes, never keys', async () => {
    const fetch = fakeFetch(answer(429), answer(401), answer(500), networkError(), stalled(), answer(404));
    const { router, logs, keys } = makeRouter(6, fetch);
    await router.open(BODY, { deadline: Date.now() + 400 });
    assert.equal(logs.length, 6);
    assert.match(logs[0], /^nvidia: key 1\/6 rate limited \(429\), cooling 20 s$/);
    assert.match(logs[5], /^nvidia: key 6\/6 got 404, not retried$/);
    const text = logs.join('\n');
    assert.ok(!text.includes('nvapi-') && keys.every((k) => !text.includes(k.slice(6, 20))));
  });
});

// ---------------------------------------------------------------- relay

/**
 * @param {ReturnType<typeof body>} upstream
 * @param {Partial<{ idleMs: number, hardDeadline: number, maxBytes: number, now: () => number }>} [options]
 */
async function relay(upstream, options = {}) {
  const reader = upstream.stream.getReader();
  const { value: first } = await reader.read();
  const aborted = { called: false };
  const stream = relayStream({
    first: /** @type {Uint8Array} */ (first),
    reader,
    abort: () => {
      aborted.called = true;
    },
    now: () => Date.now(),
    idleMs: 30,
    hardDeadline: Date.now() + 10_000,
    maxBytes: 1 << 20,
    ...options,
  });
  return { stream, aborted };
}

describe('relayStream', () => {
  it('passes the upstream bytes through unchanged', async () => {
    const upstream = body(['data: {"a":1}\n\n', 'data: {"b":"ü"}\n', '\n', 'data: [DONE]\n\n']);
    const { stream, aborted } = await relay(upstream);
    assert.equal(await readAll(stream), 'data: {"a":1}\n\ndata: {"b":"ü"}\n\ndata: [DONE]\n\n');
    assert.ok(aborted.called, 'the upstream request was not released');
  });

  it('ends with stream_timeout after an idle gap and cancels the upstream', async () => {
    const upstream = body(['data: 1\n\n'], { stall: true });
    const { stream, aborted } = await relay(upstream);
    assert.equal(await readAll(stream), `data: 1\n\n\n\ndata: {"error":{"code":"stream_timeout"}}\n\n`);
    assert.ok(upstream.state.cancelled && aborted.called);
  });

  it('ends with stream_timeout at the hard deadline', async () => {
    const upstream = body(['data: 1\n\n', 'data: 2\n\n']);
    const { stream } = await relay(upstream, { hardDeadline: Date.now() - 1 });
    assert.equal(await readAll(stream), 'data: 1\n\n\n\ndata: {"error":{"code":"stream_timeout"}}\n\n');
    assert.ok(upstream.state.cancelled);
  });

  it('ends with stream_too_large above the byte cap', async () => {
    const upstream = body(['data: 1\n\n', 'data: 22222222\n\n', 'data: 3\n\n']);
    const { stream } = await relay(upstream, { maxBytes: 16 });
    assert.equal(await readAll(stream), 'data: 1\n\n\n\ndata: {"error":{"code":"stream_too_large"}}\n\n');
    assert.ok(upstream.state.cancelled);
  });

  it('ends with upstream_interrupted on a read error', async () => {
    const { stream, aborted } = await relay(body(['data: 1\n\n'], { fail: true }));
    assert.equal(await readAll(stream), 'data: 1\n\n\n\ndata: {"error":{"code":"upstream_interrupted"}}\n\n');
    assert.ok(aborted.called);
  });

  it('starts every error event with a blank line', () => {
    for (const code of /** @type {const} */ (['stream_timeout', 'stream_too_large', 'upstream_interrupted'])) {
      assert.equal(new TextDecoder().decode(sseError(code)), `\n\ndata: {"error":{"code":"${code}"}}\n\n`);
    }
  });

  it('cancels the upstream when the browser cancels', async () => {
    const upstream = body(['data: 1\n\n'], { stall: true });
    const { stream, aborted } = await relay(upstream, { idleMs: 10_000 });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    assert.ok(upstream.state.cancelled && aborted.called);
  });
});

// ---------------------------------------------------------------- guards and models route

const HOST = 'starpi.test';
const SAME_ORIGIN = { origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' };

/**
 * @param {{ headers?: Record<string, string | undefined>, body?: BodyInit, ip?: string }} [options]
 */
function chatRequest({ headers = {}, body = JSON.stringify(BODY), ip = '203.0.113.7' } = {}) {
  const all = { host: HOST, 'content-type': 'application/json', 'x-real-ip': ip, ...SAME_ORIGIN, ...headers };
  const defined = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));
  return new Request(`http://${HOST}/api/chat/nvidia`, { method: 'POST', headers: /** @type {Record<string, string>} */ (defined), body, duplex: 'half' });
}

/**
 * @param {{ router?: ReturnType<typeof createKeyRouter> | null }} [options]
 */
function deps({ router = null } = {}) {
  return { router };
}

/** @param {Response} res */
async function errorOf(res) {
  return { status: res.status, ...(await res.json()) };
}

describe('request guards', () => {
  it('refuse foreign, missing and cross-site origins', () => {
    const cases = [
      [{ origin: 'https://evil.example', 'sec-fetch-site': undefined }, 'origin_not_allowed'],
      [{ origin: `https://${HOST}.evil.example`, 'sec-fetch-site': undefined }, 'origin_not_allowed'],
      [{ origin: 'null', 'sec-fetch-site': undefined }, 'origin_not_allowed'],
      [{ origin: undefined, 'sec-fetch-site': undefined }, 'origin_required'],
      [{ 'sec-fetch-site': 'cross-site' }, 'cross_site_request'],
      [{ 'sec-fetch-site': 'same-site' }, 'cross_site_request'],
    ];
    for (const [headers, error] of cases) assert.deepEqual(checkSameOrigin(chatRequest({ headers }), []), { status: 403, error }, JSON.stringify(headers));
  });

  it('accept same-origin requests, the forwarded host and extra origins', () => {
    const allowed = [
      SAME_ORIGIN,
      { origin: `http://${HOST}`, 'sec-fetch-site': undefined },
      { origin: 'https://www.starpi.app', host: 'internal.vercel', 'x-forwarded-host': 'www.starpi.app' },
      { origin: 'https://starpi.app', 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of allowed) assert.equal(checkSameOrigin(chatRequest({ headers }), ['https://starpi.app']), null, JSON.stringify(headers));
    assert.equal(checkSameOrigin(chatRequest({ headers: { origin: 'https://starpi.app', 'sec-fetch-site': 'cross-site' } }), [])?.error, 'cross_site_request');
  });

  it('read the client address from x-real-ip, then x-forwarded-for', () => {
    assert.equal(clientIp(chatRequest({ ip: '198.51.100.1' })), '198.51.100.1');
    assert.equal(clientIp(chatRequest({ headers: { 'x-real-ip': undefined, 'x-forwarded-for': '198.51.100.2, 10.0.0.1' } })), '198.51.100.2');
    assert.equal(clientIp(chatRequest({ headers: { 'x-real-ip': undefined } })), 'unknown');
  });

  it('check size before media type, then bytes, UTF-8, JSON and the top-level type', async () => {
    const big = 'x'.repeat(262_145);
    const streamed = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(encoder.encode(big.slice(0, 60_000)));
        controller.close();
      },
    });
    const cases = [
      [{ headers: { 'content-length': '262145', 'content-type': 'text/plain' } }, 413, 'payload_too_large'],
      [{ headers: { 'content-type': 'text/plain' } }, 415, 'unsupported_media_type'],
      [{ headers: { 'content-type': undefined } }, 415, 'unsupported_media_type'],
      [{ body: streamed }, 413, 'payload_too_large'],
      [{ body: '{' }, 400, 'invalid_json'],
      [{ body: '' }, 400, 'invalid_json'],
      [{ body: new Uint8Array([0x7b, 0xff, 0x7d]) }, 400, 'invalid_json'],
      [{ body: '[1,2]' }, 400, 'json_body_must_be_object'],
      [{ body: 'null' }, 400, 'json_body_must_be_object'],
    ];
    for (const [options, status, error] of cases) {
      const read = await readJsonBody(chatRequest(options), 262_144);
      assert.deepEqual(read.ok ? read : { status: read.status, error: read.error }, { status, error }, error);
    }
    assert.deepEqual(await readJsonBody(chatRequest({ headers: { 'content-type': 'application/json; charset=UTF-8' } }), 1024), { ok: true, data: BODY });
  });

  it('limit requests per IP and window, with a retry time', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now });
    assert.ok(limiter.hit('198.51.100.1').ok);
    clock.t += 15_000;
    assert.ok(limiter.hit('198.51.100.1').ok);
    assert.deepEqual(limiter.hit('198.51.100.1'), { ok: false, retryAfterS: 45 });
    assert.ok(limiter.hit('198.51.100.2').ok, 'another IP is not limited');
    clock.t += 45_000;
    assert.ok(limiter.hit('198.51.100.1').ok, 'a new window starts');
  });

  it('forget expired windows, then the oldest, when the limiter is full', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock.now, maxEntries: 2 });
    assert.ok(limiter.hit('a').ok && !limiter.hit('a').ok);
    assert.ok(limiter.hit('b').ok);
    assert.ok(limiter.hit('c').ok, 'a third address fits after dropping the oldest');
    assert.ok(limiter.hit('a').ok, 'the dropped address starts a new window');
  });
});

describe('handleModels', () => {
  it('publishes the allowlist and whether keys are configured, nothing else', async () => {
    for (const router of [null, makeRouter(3, fakeFetch(sse())).router]) {
      const res = handleModels(deps({ router }));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const text = await res.text();
      const data = JSON.parse(text);
      assert.deepEqual(Object.keys(data), ['configured', 'version', 'defaultModel', 'limits', 'models']);
      assert.equal(data.configured, router !== null);
      assert.deepEqual(data.models.map((/** @type {{ id: string }} */ m) => m.id), NVIDIA_MODELS.map((m) => m.id));
      assert.ok(!text.includes('nvapi-') && !text.includes('upstream'));
    }
  });
});

// ---------------------------------------------------------------- Vercel wiring

describe('Vercel wiring', () => {
  const ENV = ['NVIDIA_API_KEYS', 'NVIDIA_RATE_LIMIT_PER_MINUTE', 'NVIDIA_ALLOWED_ORIGINS'];
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

  it('exports POST for the chat route and 405 with Allow for every other method', async () => {
    assert.equal(typeof chatRoute.POST, 'function');
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await chatRoute[/** @type {'GET'} */ (method)]();
      assert.deepEqual(await errorOf(res), { status: 405, error: 'method_not_allowed' }, method);
      assert.equal(res.headers.get('allow'), 'POST');
    }
  });

  it('exports GET for the models route and 405 with Allow for every other method', async () => {
    const res = await modelsRoute.GET();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).configured, false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const refused = await modelsRoute[/** @type {'POST'} */ (method)]();
      assert.equal(refused.status, 405, method);
      assert.equal(refused.headers.get('allow'), 'GET');
    }
  });

  it('answers 503 nvidia_not_configured without keys, so tests never reach NVIDIA', async () => {
    process.env.NVIDIA_API_KEYS = '';
    assert.deepEqual(await errorOf(await chatRoute.POST(chatRequest())), { status: 503, error: 'nvidia_not_configured' });
  });

  it('builds the dependencies from the environment once and reports malformed keys by count only', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    process.env.NVIDIA_API_KEYS = `${key(1)}, not-a-key, ${key(2)}`;
    const first = runtimeDeps();
    assert.equal(first.router?.size, 2);
    assert.equal(runtimeDeps(), first, 'a warm instance keeps its cooldowns and rate windows');
    assert.equal(warn.mock.callCount(), 1);
    const message = String(warn.mock.calls[0].arguments[0]);
    assert.match(message, /ignored 1 malformed/);
    assert.ok(!message.includes('not-a-key') && !message.includes('nvapi-'));
    process.env.NVIDIA_API_KEYS = key(3);
    const second = runtimeDeps();
    assert.notEqual(second, first);
    assert.equal(second.router?.size, 1);
  });

  it('keeps vercel.json and the proxy timings in step', () => {
    const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const chat = vercel.functions['api/chat/nvidia.js'];
    assert.equal(chat.maxDuration * 1000, POOL_FUNCTION_MAX_MS);
    assert.equal(chat.supportsCancellation, true);
    assert.equal(vercel.functions['api/models/nvidia.js'].maxDuration, 10);
    assert.ok(POOL_FUNCTION_MAX_MS - 3000 >= NVIDIA_PROXY.streamMaxMs, 'the stream must end before the function is stopped');
    assert.ok(NVIDIA_PROXY.failoverBudgetMs < NVIDIA_PROXY.streamMaxMs);
    const csp = vercel.headers.flatMap((/** @type {{ headers: Array<{ key: string, value: string }> }} */ h) => h.headers).find((/** @type {{ key: string }} */ h) => h.key === 'Content-Security-Policy').value;
    assert.match(csp, /connect-src 'self'/);
  });

  it('deploys api/ and src/ (the functions import the catalog from src/)', () => {
    const ignored = readFileSync(path.join(ROOT, '.vercelignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    for (const dir of ['api', 'src']) {
      assert.ok(!ignored.some((pattern) => pattern.replace(/^\//, '').replace(/\/?\*?$/, '') === dir), `.vercelignore excludes ${dir}/`);
    }
  });
});
