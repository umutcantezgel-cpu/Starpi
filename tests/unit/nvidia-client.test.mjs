// The browser's NVIDIA cloud client: the request it sends to Starpi's proxy, the streamed answer, the
// mapping of proxy error codes to messages (never the server's own text), timeouts and Stop, and the
// model catalog the proxy publishes. fetch is stubbed; nothing leaves the process.
import './setup.mjs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { splitReasoning } = await import('../../src/js/chat-stream.js');
const { t } = await import('../../src/js/i18n/index.js');
const { NVIDIA_DEFAULT_MODEL, NVIDIA_MODELS, publicCatalog } = await import('../../src/js/models/nvidia-catalog.js');
const { callNvidia, fetchNvidiaModels, getNvidiaCatalog, NVIDIA_CHAT_URL, NVIDIA_MODELS_URL, onNvidiaCatalog, parseNvidiaCatalog, ProviderError, resolveNvidiaModel } = await import(
  '../../src/js/providers.js'
);

const MODEL = NVIDIA_MODELS[1].id;
const LABEL = NVIDIA_MODELS[1].label;
const MESSAGES = /** @type {const} */ ([
  { role: 'system', content: 'You are Starpi.' },
  { role: 'user', content: 'Hello?' },
]);
/** Server text that must never reach the page. */
const LEAK = 'test-key-1 detail';

const encoder = new TextEncoder();

/** @param {Record<string, unknown>} delta @param {string | null} [finish] */
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';

/**
 * A text/event-stream response with the given chunks. With `close: false` the stream stays open after
 * them, like a model that stopped sending.
 * @param {string[]} chunks
 * @param {{ close?: boolean }} [opts]
 */
function sse(chunks, opts = {}) {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      if (opts.close !== false) controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }), state };
}

/**
 * Cancelling the decoded stream reaches the response body a few ticks later.
 * @param {{ cancelled: boolean }} state
 */
async function cancelled(state) {
  for (let i = 0; i < 50 && !state.cancelled; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  return state.cancelled;
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/** @type {typeof fetch} */
const realFetch = globalThis.fetch;
/** @type {Array<{ url: string, init: RequestInit }>} */
let calls = [];

/** @param {(url: string, init: RequestInit) => Response | Promise<Response>} handler */
function stubFetch(handler) {
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** @param {Partial<Parameters<typeof callNvidia>[1]>} [opts] */
const ask = (opts = {}) => callNvidia([...MESSAGES], { model: MODEL, maxTokens: 2048, temperature: 0.2, ...opts });

/**
 * Asserts that the call fails with a ProviderError carrying exactly this message.
 * @param {Promise<unknown>} promise
 * @param {string} message
 * @param {{ status?: number, notConfigured?: boolean }} [info]
 */
async function rejectsWith(promise, message, info = {}) {
  await assert.rejects(promise, (/** @type {unknown} */ err) => {
    assert.ok(err instanceof ProviderError, `not a ProviderError: ${err}`);
    assert.equal(err.message, message);
    assert.ok(!err.message.includes(LEAK), 'server text leaked');
    if ('status' in info) assert.equal(err.status, info.status);
    if ('notConfigured' in info) assert.equal(err.notConfigured, info.notConfigured);
    return true;
  });
}

describe('callNvidia request', () => {
  it('posts only model, messages, max_tokens and temperature to the same-origin proxy, without credentials of its own', async () => {
    stubFetch(() => sse([chunk({ content: 'Hi.' }, 'stop'), DONE]).res);
    const r = await ask({ maxTokens: 1024, temperature: 0.7 });
    assert.equal(r.text, 'Hi.');
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, NVIDIA_CHAT_URL);
    assert.equal(url, '/api/chat/nvidia');
    assert.equal(init.method, 'POST');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'same-origin');
    const headers = /** @type {Record<string, string>} */ (init.headers);
    assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'Content-Type']);
    assert.ok(!Object.keys(headers).some((h) => h.toLowerCase() === 'authorization'));
    const body = JSON.parse(String(init.body));
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
    assert.deepEqual(body, { model: MODEL, messages: MESSAGES, max_tokens: 1024, temperature: 0.7 });
  });

  it('streams the accumulated answer to onDelta', async () => {
    stubFetch(() => sse([chunk({ role: 'assistant' }), chunk({ content: 'Hel' }), ': ping\n\n', chunk({ content: 'lo' }), chunk({}, 'stop'), DONE]).res);
    /** @type {string[]} */
    const seen = [];
    const r = await ask({ onDelta: (text) => seen.push(text) });
    assert.deepEqual(seen, ['Hel', 'Hello']);
    assert.deepEqual(r, { text: 'Hello', model: MODEL, finishReason: 'stop', truncated: false });
  });

  it('returns the reasoning as a leading think block', async () => {
    stubFetch(() => sse([chunk({ reasoning_content: 'Plan the ' }), chunk({ reasoning_content: 'answer.' }), chunk({ content: 'Answer.' }, 'stop'), DONE]).res);
    /** @type {string[]} */
    const seen = [];
    const r = await ask({ onDelta: (text) => seen.push(text) });
    assert.equal(r.text, '<think>Plan the answer.</think>\n\nAnswer.');
    assert.equal(seen[0], '<think>Plan the </think>\n\n');
    assert.deepEqual(splitReasoning(r.text), { thoughts: 'Plan the answer.', answer: 'Answer.' });
  });

  it('accepts a reply that was not streamed', async () => {
    stubFetch(() => jsonResponse(200, { choices: [{ message: { content: 'Plain.', reasoning_content: 'Think.' }, finish_reason: 'stop' }] }));
    const r = await ask();
    assert.deepEqual(r, { text: '<think>Think.</think>\n\nPlain.', model: MODEL, finishReason: 'stop', truncated: false });
  });

  it('refuses a reply that is neither an event stream nor JSON', async () => {
    stubFetch(() => new Response('<!doctype html><title>Starpi</title>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await rejectsWith(ask(), t('provider.nvidia_bad_response'));
  });
});

describe('callNvidia errors', () => {
  const model = { model: LABEL };
  /** @type {Array<[string, number, string, Record<string, string | number>, boolean]>} code, status, key, params, notConfigured */
  const CASES = [
    ['nvidia_not_configured', 503, 'provider.nvidia_not_configured', {}, true],
    ['rate_limited', 429, 'provider.nvidia_rate_limited', { seconds: 30 }, false],
    ['all_keys_exhausted', 503, 'provider.nvidia_busy', { seconds: 30 }, false],
    ['model_not_allowed', 400, 'provider.nvidia_model_unavailable', model, false],
    ['model_unavailable', 502, 'provider.nvidia_model_unavailable', model, false],
    ['invalid_field', 400, 'provider.nvidia_invalid_request', {}, false],
    ['invalid_json', 400, 'provider.nvidia_invalid_request', {}, false],
    ['json_body_must_be_object', 400, 'provider.nvidia_invalid_request', {}, false],
    ['unsupported_media_type', 415, 'provider.nvidia_invalid_request', {}, false],
    ['method_not_allowed', 405, 'provider.nvidia_invalid_request', {}, false],
    ['length_required', 411, 'provider.nvidia_invalid_request', {}, false],
    ['payload_too_large', 413, 'provider.nvidia_too_long', {}, false],
    ['cross_site_request', 403, 'provider.nvidia_forbidden', {}, false],
    ['origin_required', 403, 'provider.nvidia_forbidden', {}, false],
    ['origin_not_allowed', 403, 'provider.nvidia_forbidden', {}, false],
    ['upstream_rejected', 502, 'provider.nvidia_upstream', { status: 502 }, false],
    ['upstream_timeout', 504, 'provider.nvidia_timeout', {}, false],
  ];

  for (const [code, status, key, params, notConfigured] of CASES) {
    it(`maps ${code} (${status}) to ${key}`, async () => {
      stubFetch(() => jsonResponse(status, { error: code, field: 'messages', message: LEAK }));
      await rejectsWith(ask(), t(key, params), { status, notConfigured });
    });
  }

  it('also reads a nested error code', async () => {
    stubFetch(() => jsonResponse(400, { error: { code: 'payload_too_large', message: LEAK } }));
    await rejectsWith(ask(), t('provider.nvidia_too_long'), { status: 400 });
  });

  it('shows the Retry-After seconds of a rate limit and never the server text', async () => {
    stubFetch(() => jsonResponse(429, { error: 'rate_limited', message: LEAK }, { 'retry-after': '7' }));
    await assert.rejects(ask(), (/** @type {Error} */ err) => {
      assert.equal(err.message, t('provider.nvidia_rate_limited', { seconds: 7 }));
      assert.match(err.message, /\b7 s\b/);
      assert.ok(!err.message.includes('test-key-1'));
      return true;
    });
  });

  it('clamps Retry-After to between 1 s and 1 h and reads HTTP dates', async () => {
    for (const [header, seconds] of /** @type {Array<[string, number]>} */ ([
      ['0', 1],
      ['999999', 3600],
      ['soon', 30],
      [new Date(Date.now() + 120_000).toUTCString(), 120],
    ])) {
      stubFetch(() => jsonResponse(503, { error: 'all_keys_exhausted' }, { 'retry-after': header }));
      await assert.rejects(ask(), (/** @type {Error} */ err) => {
        const shown = Number(err.message.match(/(\d+) s$/)?.[1]);
        assert.ok(Math.abs(shown - seconds) <= 1, `${header}: ${err.message}`);
        return true;
      });
    }
  });

  it('decides by the status when the code is unknown or text', async () => {
    stubFetch(() => jsonResponse(429, { error: 'Key test-key-1 detail is cooling down' }, { 'retry-after': '5' }));
    await rejectsWith(ask(), t('provider.nvidia_rate_limited', { seconds: 5 }), { status: 429 });
    stubFetch(() => jsonResponse(503, { error: 'something_new' }));
    await rejectsWith(ask(), t('provider.nvidia_busy', { seconds: 30 }), { status: 503 });
    stubFetch(() => jsonResponse(500, { error: { code: 'something_new', message: LEAK } }));
    await rejectsWith(ask(), t('provider.nvidia_upstream', { status: 500 }), { status: 500, notConfigured: false });
  });

  it('treats a 404 or a page that is not JSON as no proxy at this address', async () => {
    stubFetch(() => new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    await rejectsWith(ask(), t('provider.nvidia_not_available'), { status: 404, notConfigured: true });
    stubFetch(() => jsonResponse(404, { message: LEAK }));
    await rejectsWith(ask(), t('provider.nvidia_not_available'), { status: 404, notConfigured: true });
    stubFetch(() => new Response(`Bad gateway ${LEAK}`, { status: 502, headers: { 'content-type': 'text/plain' } }));
    await rejectsWith(ask(), t('provider.nvidia_not_available'), { status: 502, notConfigured: true });
  });

  it('reports an unreachable proxy', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await rejectsWith(ask(), t('provider.nvidia_unreachable'));
  });
});

describe('callNvidia streams that end early', () => {
  it('marks an answer without [DONE] or finish reason as truncated', async () => {
    stubFetch(() => sse([chunk({ content: 'Half an ' }), chunk({ content: 'answer' })]).res);
    assert.deepEqual(await ask(), { text: 'Half an answer', model: MODEL, finishReason: null, truncated: true });
  });

  it('marks an answer cut by the token limit as truncated', async () => {
    stubFetch(() => sse([chunk({ content: 'Long' }, 'length'), DONE]).res);
    assert.equal((await ask()).truncated, true);
  });

  it('keeps the answer before an error event, and reports an interruption without one', async () => {
    const error = (/** @type {string} */ code) => `\n\ndata: ${JSON.stringify({ error: { code } })}\n\n`;
    stubFetch(() => sse([chunk({ content: 'Partial' }), error('upstream_interrupted'), chunk({ content: ' ignored' })], { close: false }).res);
    assert.deepEqual(await ask(), { text: 'Partial', model: MODEL, finishReason: null, truncated: true });

    stubFetch(() => sse([chunk({ reasoning_content: 'Thinking' }), error('upstream_interrupted')]).res);
    await rejectsWith(ask(), t('provider.nvidia_interrupted'), { status: 502 });
    stubFetch(() => sse([`event: error\ndata: ${JSON.stringify({ error: { code: 'stream_too_large', message: LEAK } })}\n\n`]).res);
    await rejectsWith(ask(), t('provider.nvidia_interrupted'), { status: 502 });
    stubFetch(() => sse([error('stream_timeout')]).res);
    await rejectsWith(ask(), t('provider.nvidia_timeout'), { status: 502 });
  });

  it('returns the partial answer on Stop, and an AbortError when nothing arrived', async () => {
    const stop = new AbortController();
    const stream = sse([chunk({ content: 'So far' })], { close: false });
    stubFetch(() => stream.res);
    const r = await ask({ signal: stop.signal, onDelta: () => stop.abort() });
    assert.deepEqual(r, { text: 'So far', model: MODEL, finishReason: null, truncated: true });
    assert.equal(await cancelled(stream.state), true);

    const early = new AbortController();
    const silent = sse([chunk({ reasoning_content: 'Hmm' })], { close: false });
    stubFetch(() => silent.res);
    const pending = ask({ signal: early.signal });
    setTimeout(() => early.abort(), 20);
    await assert.rejects(pending, (/** @type {unknown} */ err) => err instanceof DOMException && err.name === 'AbortError');
    assert.equal(await cancelled(silent.state), true);

    const before = new AbortController();
    before.abort();
    calls = [];
    await assert.rejects(ask({ signal: before.signal }), { name: 'AbortError' });
    assert.equal(calls.length, 0);
  });

  it('gives up on a silent stream after the idle timeout, keeping what arrived', async () => {
    stubFetch(() => sse([': ping\n\n'], { close: false }).res);
    await rejectsWith(ask({ timeouts: { idle: 20 } }), t('provider.nvidia_timeout'), { status: 504 });
    stubFetch(() => sse([chunk({ content: 'Started' })], { close: false }).res);
    assert.deepEqual(await ask({ timeouts: { idle: 20 } }), { text: 'Started', model: MODEL, finishReason: null, truncated: true });
  });

  it('gives up when the proxy sends no first byte in time', async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    await rejectsWith(ask({ timeouts: { firstByte: 20 } }), t('provider.nvidia_timeout'), { status: 504 });
  });

  it('reports a reply that holds only reasoning, or nothing', async () => {
    stubFetch(() => sse([chunk({ reasoning_content: 'Let me think about it.' }), chunk({}, 'length'), DONE]).res);
    await rejectsWith(ask(), t('provider.nvidia_only_reasoning'));
    stubFetch(() => sse([chunk({ content: '<think>Inline reasoning that never ends' }), DONE]).res);
    await rejectsWith(ask(), t('provider.nvidia_only_reasoning'));
    stubFetch(() => sse([chunk({ content: '  ' }, 'stop'), DONE]).res);
    await rejectsWith(ask(), t('provider.empty_answer'));
  });
});

describe('NVIDIA catalog', () => {
  it('parseNvidiaCatalog reads the published shape and drops what it does not know', () => {
    const body = publicCatalog(true);
    const parsed = parseNvidiaCatalog({ ...body, keys: ['test-key-1'], keyCount: 20 });
    assert.equal(parsed.configured, true);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.defaultModel, NVIDIA_DEFAULT_MODEL);
    assert.deepEqual(parsed.limits, body.limits);
    assert.deepEqual(parsed.models, body.models);
    assert.deepEqual(Object.keys(parsed).sort(), ['configured', 'defaultModel', 'limits', 'models', 'reachable', 'version']);
  });

  it('parseNvidiaCatalog accepts ids as strings, skips invalid and repeated ids, and is not configured unless it says so', () => {
    const parsed = parseNvidiaCatalog({
      configured: 'yes',
      defaultModel: 'not an id',
      limits: { maxMessages: 40, maxBodyBytes: -1, extra: 5 },
      models: [
        MODEL,
        { id: MODEL, label: 'Duplicate' },
        { id: 'vendor/new-model', label: 'x'.repeat(200), vendor: 'Vendor', reasoning: 'true', secret: 1 },
        { id: '../etc/passwd' },
        { id: 'no-slash' },
        42,
        null,
      ],
    });
    assert.equal(parsed.configured, false);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.defaultModel, null);
    assert.deepEqual(parsed.limits, { maxMessages: 40 });
    assert.deepEqual(
      parsed.models.map((m) => m.id),
      [MODEL, 'vendor/new-model'],
    );
    // A bare id gets the bundled numbers; the label in the UI always comes from the bundled catalog.
    assert.equal(parsed.models[0].label, MODEL);
    assert.equal(parsed.models[0].defaultMaxTokens, NVIDIA_MODELS[1].defaultMaxTokens);
    assert.deepEqual(parsed.models[1], { id: 'vendor/new-model', label: 'x'.repeat(80), vendor: 'Vendor', reasoning: false, vision: false, maxOutputTokens: 4096, defaultMaxTokens: 1024 });
  });

  it('parseNvidiaCatalog treats anything but an object as no proxy', () => {
    for (const body of [null, 'Not found', [], 42]) {
      assert.deepEqual(parseNvidiaCatalog(body), { configured: false, reachable: false, version: null, defaultModel: null, limits: null, models: [] });
    }
  });

  it('resolveNvidiaModel keeps an offered choice, else falls back to the default or the first model and says so', () => {
    const catalog = parseNvidiaCatalog(publicCatalog(true));
    assert.deepEqual(resolveNvidiaModel(catalog, MODEL), { model: MODEL, replaced: false });
    assert.deepEqual(resolveNvidiaModel(catalog, 'vendor/removed'), { model: NVIDIA_DEFAULT_MODEL, replaced: true });
    assert.deepEqual(resolveNvidiaModel(catalog, ''), { model: NVIDIA_DEFAULT_MODEL, replaced: false });
    const noDefault = { ...catalog, defaultModel: 'vendor/gone', models: catalog.models.slice(2, 4) };
    assert.deepEqual(resolveNvidiaModel(noDefault, MODEL), { model: catalog.models[2].id, replaced: true });
    assert.deepEqual(resolveNvidiaModel({ ...catalog, models: [] }, MODEL), { model: null, replaced: false });
  });

  it('fetchNvidiaModels asks the same-origin route and reads a missing proxy as unreachable', async () => {
    stubFetch(() => jsonResponse(200, publicCatalog(false)));
    const unconfigured = await fetchNvidiaModels();
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.reachable, true);
    assert.equal(unconfigured.models.length, NVIDIA_MODELS.length);
    assert.equal(calls[0].url, NVIDIA_MODELS_URL);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.ok(!JSON.stringify(calls[0].init.headers).toLowerCase().includes('authorization'));

    const unreachable = { configured: false, reachable: false, version: null, defaultModel: null, limits: null, models: [] };
    stubFetch(() => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    assert.deepEqual(await fetchNvidiaModels(), unreachable);
    // A static host that serves the app for every path.
    stubFetch(() => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    assert.deepEqual(await fetchNvidiaModels(), unreachable);
    stubFetch(() => new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }));
    assert.deepEqual(await fetchNvidiaModels(), unreachable);
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    assert.deepEqual(await fetchNvidiaModels(), unreachable);
  });

  it('getNvidiaCatalog shares one request, caches by state and tells its listeners', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      let configured = true;
      stubFetch(() => jsonResponse(200, publicCatalog(configured)));
      /** @type {boolean[]} */
      const heard = [];
      const stop = onNvidiaCatalog((c) => heard.push(c.configured));

      const [a, b] = await Promise.all([getNvidiaCatalog({ refresh: true }), getNvidiaCatalog()]);
      assert.equal(a, b);
      assert.equal(calls.length, 1);
      assert.deepEqual(heard, [true]);

      // Configured: five minutes.
      now += 4 * 60_000;
      assert.equal(await getNvidiaCatalog(), a);
      assert.equal(calls.length, 1);
      now += 2 * 60_000;
      configured = false;
      const c = await getNvidiaCatalog();
      assert.equal(c.configured, false);
      assert.equal(calls.length, 2);

      // Not configured: 30 seconds.
      now += 20_000;
      assert.equal(await getNvidiaCatalog(), c);
      now += 15_000;
      await getNvidiaCatalog();
      assert.equal(calls.length, 3);
      await getNvidiaCatalog({ refresh: true });
      assert.equal(calls.length, 4);
      assert.deepEqual(heard, [true, false, false, false]);

      stop();
      await getNvidiaCatalog({ refresh: true });
      assert.equal(heard.length, 4);
    } finally {
      Date.now = realNow;
    }
  });
});
