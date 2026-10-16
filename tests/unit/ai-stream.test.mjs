// The generic stream driver with a scripted adapter and a scripted transport: event order (one
// start first, one end last), text, reasoning, tool calls and usage, the end of reading at the
// adapter's end, errors as end events, Stop, the idle limit and the deadline, JSON answers, and
// SDK adapters with the transport's fetch injected.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textPart } from '../../src/js/ai/contract.js';
import { AiError } from '../../src/js/ai/errors.js';
import { validateEventSequence } from '../../src/js/ai/index.js';
import { stream } from '../../src/js/ai/stream.js';

const encoder = new TextEncoder();

/** @returns {import('../../src/js/ai/contract.js').AiRequest} */
const request = (extra = {}) => ({ provider: 'openai', model: 'fake-model', messages: [{ role: 'user', content: [textPart('Hello')] }], ...extra });

/**
 * A wire adapter for a tiny test dialect: each SSE data line is JSON `{ t, ... }`.
 * @param {Partial<import('../../src/js/ai/stream.js').WireAdapter>} [overrides]
 * @returns {import('../../src/js/ai/stream.js').WireAdapter}
 */
function testAdapter(overrides = {}) {
  return {
    kind: 'wire',
    id: 'openai',
    dialect: 'test',
    buildRequest: (req) => ({ path: '/v1/test', method: 'POST', headers: { accept: 'text/event-stream' }, body: { model: req.model } }),
    createState: () => ({ calls: 0 }),
    parseEvent(sse, state) {
      state.calls += 1;
      const m = JSON.parse(sse.data);
      switch (m.t) {
        case 'start':
          return [{ type: 'start', provider: 'openai', model: m.model }];
        case 'text':
          return [{ type: 'text', delta: m.v }];
        case 'think':
          return [{ type: 'reasoning', delta: m.v }];
        case 'tool':
          return [
            { type: 'tool_call', id: m.id, name: m.name, argsDelta: m.args, final: false },
            { type: 'tool_call', id: m.id, name: m.name, final: true },
          ];
        case 'usage':
          return [{ type: 'usage', input: m.input, output: m.output }];
        case 'end':
          return [{ type: 'end', stopReason: m.stop }];
        case 'boom':
          throw new Error('adapter bug');
        default:
          return [];
      }
    },
    ...overrides,
  };
}

/** @param {Record<string, unknown>} m */
const sse = (m) => `data: ${JSON.stringify(m)}\n\n`;

/**
 * A scripted transport answering with an event stream (or another body). It records what it was
 * asked and whether its body was cancelled, and errors the body when the signal aborts, as fetch does.
 * @param {{ chunks?: string[], status?: number, headers?: Record<string, string>, hold?: boolean, gapMs?: number, failAfter?: number, body?: string }} [script]
 */
function scriptedTransport(script = {}) {
  const log = { calls: 0, built: /** @type {any} */ (null), signal: /** @type {AbortSignal | null} */ (null), cancelled: false };
  const transport = /** @type {import('../../src/js/ai/transport.js').Transport} */ (
    Object.assign(
      async (/** @type {unknown} */ _adapter, /** @type {any} */ built, /** @type {{ signal?: AbortSignal }} */ options = {}) => {
        log.calls += 1;
        log.built = built;
        log.signal = options.signal ?? null;
        if (options.signal?.aborted) throw options.signal.reason;
        const chunks = script.body !== undefined ? [script.body] : (script.chunks ?? []);
        let i = 0;
        const body = new ReadableStream({
          start(controller) {
            options.signal?.addEventListener('abort', () => controller.error(options.signal?.reason), { once: true });
          },
          async pull(controller) {
            if (script.gapMs) await new Promise((r) => setTimeout(r, script.gapMs));
            if (script.failAfter !== undefined && i === script.failAfter) return controller.error(new TypeError('terminated'));
            if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
            else if (!script.hold) controller.close();
            else await new Promise(() => {});
          },
          cancel() {
            log.cancelled = true;
          },
        });
        return new Response(body, { status: script.status ?? 200, headers: { 'content-type': 'text/event-stream', ...script.headers } });
      },
      { kind: /** @type {const} */ ('direct'), provider: null, baseURL: 'http://127.0.0.1:1', fetch: async () => new Response('') },
    )
  );
  return { transport, log };
}

/** @param {AsyncIterable<import('../../src/js/ai/contract.js').AiEvent>} events */
async function all(events) {
  const out = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('stream() with a wire adapter', () => {
  it('turns the event stream into start, reasoning, text, tool call, usage and end', async () => {
    const { transport, log } = scriptedTransport({
      headers: { 'x-request-id': 'req-1' },
      chunks: [': comment\n\n', sse({ t: 'think', v: 'Plan.' }), sse({ t: 'text', v: 'Hel' }), sse({ t: 'text', v: 'lo' }), sse({ t: 'tool', id: 'c1', name: 'look_up', args: '{"q":1}' }), sse({ t: 'usage', input: 3, output: 4 }), sse({ t: 'end', stop: 'tool_call' })],
    });
    const events = await all(stream(testAdapter(), request(), transport));
    assert.deepEqual(validateEventSequence(events), []);
    assert.deepEqual(events.map((e) => e.type), ['start', 'reasoning', 'text', 'text', 'tool_call', 'tool_call', 'usage', 'end']);
    assert.deepEqual(events[0], { type: 'start', provider: 'openai', model: 'fake-model', requestId: 'req-1' });
    assert.deepEqual(events.at(-1), { type: 'end', stopReason: 'tool_call' });
    assert.deepEqual(log.built, { path: '/v1/test', method: 'POST', headers: { accept: 'text/event-stream' }, body: { model: 'fake-model' } });
  });

  it("keeps the adapter's start (the served model) and fills in the request id", async () => {
    const { transport } = scriptedTransport({ headers: { 'request-id': 'req-2' }, chunks: [sse({ t: 'start', model: 'served-model' }), sse({ t: 'start', model: 'ignored' }), sse({ t: 'text', v: 'x' }), sse({ t: 'end', stop: 'end_turn' })] });
    const events = await all(stream(testAdapter(), request(), transport));
    assert.deepEqual(events[0], { type: 'start', provider: 'openai', model: 'served-model', requestId: 'req-2' });
    assert.equal(events.filter((e) => e.type === 'start').length, 1);
  });

  it("stops reading at the adapter's end and releases the body", async () => {
    const { transport, log } = scriptedTransport({ hold: true, chunks: [sse({ t: 'text', v: 'a' }), sse({ t: 'end', stop: 'end_turn' }), sse({ t: 'text', v: 'never' })] });
    const events = await all(stream(testAdapter(), request(), transport));
    assert.deepEqual(events.map((e) => e.type), ['start', 'text', 'end']);
    assert.equal(log.cancelled, true);
  });

  it('reports a body that closes before the end as a cut stream', async () => {
    const { transport } = scriptedTransport({ chunks: [sse({ t: 'text', v: 'partial' })] });
    const events = await all(stream(testAdapter(), request(), transport));
    const end = /** @type {any} */ (events.at(-1));
    assert.equal(end.stopReason, 'error');
    assert.ok(end.error instanceof AiError);
    assert.equal(end.error.code, 'stream_cut');
    assert.deepEqual(events.map((e) => e.type), ['start', 'text', 'end']);
  });

  it('lets finish() emit the end a provider signals only by closing', async () => {
    const adapter = testAdapter({ finish: (state) => [{ type: 'end', stopReason: state.calls ? 'end_turn' : 'error' }] });
    const { transport } = scriptedTransport({ chunks: [sse({ t: 'text', v: 'whole' })] });
    assert.deepEqual((await all(stream(adapter, request(), transport))).at(-1), { type: 'end', stopReason: 'end_turn' });
  });

  it('maps a failed network read after the answer started to stream_cut', async () => {
    const { transport } = scriptedTransport({ chunks: [sse({ t: 'text', v: 'a' }), sse({ t: 'text', v: 'b' })], failAfter: 1 });
    const end = /** @type {any} */ ((await all(stream(testAdapter(), request(), transport))).at(-1));
    assert.equal(end.error.code, 'stream_cut');
  });

  it('turns an HTTP error into start and an end with the classified error', async () => {
    const { transport } = scriptedTransport({ status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' }, body: JSON.stringify({ error: { message: 'slow down, key sk-1', code: 'rate_limit_exceeded' } }) });
    const events = await all(stream(testAdapter(), request(), transport));
    assert.deepEqual(events.map((e) => e.type), ['start', 'end']);
    const end = /** @type {any} */ (events[1]);
    assert.equal(end.stopReason, 'error');
    assert.equal(end.error.code, 'rate_limited');
    assert.equal(end.error.retryAfterMs, 3000);
    assert.equal(end.error.provider, 'openai');
    assert.ok(!end.error.message.includes('sk-1'));
  });

  it('ends with the transport error when the request never got an answer', async () => {
    const transport = /** @type {any} */ (Object.assign(async () => {
      throw new AiError('cors', { provider: 'xai' });
    }, { kind: 'direct', baseURL: '', fetch: null }));
    const events = await all(stream(testAdapter(), request({ provider: 'xai' }), transport));
    assert.deepEqual(events[0], { type: 'start', provider: 'xai', model: 'fake-model', requestId: null });
    assert.equal(/** @type {any} */ (events[1]).error.code, 'cors');
  });

  it('stops on the caller signal with cancelled and aborts the transport', async () => {
    const { transport, log } = scriptedTransport({ hold: true, chunks: [sse({ t: 'text', v: 'a' })] });
    const ac = new AbortController();
    /** @type {any[]} */
    const events = [];
    for await (const ev of stream(testAdapter(), request(), transport, { signal: ac.signal })) {
      events.push(ev);
      if (ev.type === 'text') ac.abort();
    }
    assert.deepEqual(events.map((e) => e.type), ['start', 'text', 'end']);
    assert.equal(events[2].stopReason, 'cancelled');
    assert.equal(events[2].error.code, 'aborted');
    assert.equal(log.signal?.aborted, true);
  });

  it('does not call the transport when the signal is already aborted', async () => {
    const { transport, log } = scriptedTransport({ chunks: [] });
    const ac = new AbortController();
    ac.abort();
    const events = await all(stream(testAdapter(), request(), transport, { signal: ac.signal }));
    assert.equal(log.calls, 0);
    assert.equal(/** @type {any} */ (events[1]).stopReason, 'cancelled');
  });

  it('times out when the provider goes quiet', async () => {
    const { transport, log } = scriptedTransport({ hold: true, chunks: [sse({ t: 'text', v: 'a' })] });
    const events = await all(stream(testAdapter(), request(), transport, { idleTimeoutMs: 40 }));
    const end = /** @type {any} */ (events.at(-1));
    assert.equal(end.stopReason, 'timeout');
    assert.equal(end.error.code, 'timeout');
    assert.equal(log.signal?.aborted, true, 'the stalled request is released');
  });

  it('times out when the answer never starts, and releases the request', async () => {
    /** @type {AbortSignal | null} */
    let seen = null;
    const silent = /** @type {import('../../src/js/ai/transport.js').Transport} */ (
      Object.assign(
        (/** @type {unknown} */ _adapter, /** @type {unknown} */ _built, /** @type {{ signal?: AbortSignal }} */ options = {}) =>
          new Promise((_resolve, reject) => {
            seen = options.signal ?? null;
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
          }),
        { kind: /** @type {const} */ ('direct'), provider: null, baseURL: 'http://127.0.0.1:1', fetch: async () => new Response('') },
      )
    );
    const events = await all(stream(testAdapter(), request(), silent, { idleTimeoutMs: 40 }));
    assert.deepEqual(validateEventSequence(events), []);
    const end = /** @type {any} */ (events.at(-1));
    assert.equal(end.stopReason, 'timeout');
    assert.equal(end.error.code, 'timeout');
    assert.equal(/** @type {AbortSignal | null} */ (seen)?.aborted, true);
  });

  it('enforces the request deadline', async () => {
    const { transport } = scriptedTransport({ gapMs: 30, chunks: [sse({ t: 'text', v: 'a' }), sse({ t: 'text', v: 'b' }), sse({ t: 'text', v: 'c' }), sse({ t: 'end', stop: 'end_turn' })] });
    const end = /** @type {any} */ ((await all(stream(testAdapter(), request({ timeoutMs: 50 }), transport, { idleTimeoutMs: 0 }))).at(-1));
    assert.equal(end.stopReason, 'timeout');
  });

  it('rejects an invalid request before sending it', async () => {
    const { transport, log } = scriptedTransport();
    const events = await all(stream(testAdapter(), /** @type {any} */ ({ provider: 'openai', model: 'm', messages: [] }), transport));
    assert.equal(log.calls, 0);
    assert.equal(/** @type {any} */ (events[1]).error.code, 'bad_request');
  });

  it('maps an adapter that cannot read the answer to bad_response', async () => {
    const { transport } = scriptedTransport({ chunks: [sse({ t: 'boom' })] });
    assert.equal(/** @type {any} */ ((await all(stream(testAdapter(), request(), transport))).at(-1)).error.code, 'bad_response');
  });

  it('attaches an error to an adapter end that reports one without it', async () => {
    const { transport } = scriptedTransport({ chunks: [sse({ t: 'end', stop: 'error' })] });
    const end = /** @type {any} */ ((await all(stream(testAdapter(), request(), transport))).at(-1));
    assert.equal(end.stopReason, 'error');
    assert.equal(end.error.code, 'bad_response');
  });

  it('reads a JSON answer through parseResponse', async () => {
    const adapter = testAdapter({ parseResponse: (json) => [{ type: 'text', delta: /** @type {any} */ (json).text }] });
    const { transport } = scriptedTransport({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'whole answer' }) });
    const events = await all(stream(adapter, request(), transport));
    assert.deepEqual(events.slice(1), [{ type: 'text', delta: 'whole answer' }, { type: 'end', stopReason: 'end_turn' }]);
  });

  it('refuses a body that is neither an event stream nor readable JSON', async () => {
    const { transport } = scriptedTransport({ headers: { 'content-type': 'text/html' }, body: '<html></html>' });
    assert.equal(/** @type {any} */ ((await all(stream(testAdapter(), request(), transport))).at(-1)).error.code, 'bad_response');
  });

  it('aborts the request when the consumer leaves early', async () => {
    const { transport, log } = scriptedTransport({ hold: true, chunks: [sse({ t: 'text', v: 'a' })] });
    for await (const ev of stream(testAdapter(), request(), transport)) if (ev.type === 'text') break;
    assert.equal(log.signal?.aborted, true);
  });

  it('needs a transport and a known adapter kind', async () => {
    const noTransport = await all(stream(testAdapter(), request(), null));
    assert.equal(/** @type {any} */ (noTransport[1]).error.code, 'bad_request');
    const unknown = await all(stream(/** @type {any} */ ({ kind: 'other', id: 'openai' }), request(), null));
    assert.equal(/** @type {any} */ (unknown[1]).error.code, 'bad_request');
  });
});

describe('stream() with an SDK adapter', () => {
  it("passes the transport's fetch, base URL and an abort signal, and forwards the events", async () => {
    /** @type {any} */
    let seen = null;
    /** @type {import('../../src/js/ai/stream.js').SdkAdapter} */
    const adapter = {
      kind: 'sdk',
      id: 'anthropic',
      dialect: 'anthropic',
      async *stream(req, context) {
        seen = context;
        yield { type: 'start', provider: 'anthropic', model: `${req.model}-served`, requestId: 'r' };
        yield { type: 'text', delta: 'Hi' };
        yield { type: 'end', stopReason: 'end_turn' };
      },
    };
    const fetch = async () => new Response('');
    const transport = /** @type {any} */ (Object.assign(async () => new Response(''), { kind: 'relay', provider: 'anthropic', baseURL: 'https://app.example/api/relay/anthropic', fetch }));
    const events = await all(stream(adapter, request({ provider: 'anthropic', model: 'claude-sonnet-5-5' }), transport));
    assert.equal(seen.fetch, fetch);
    assert.equal(seen.baseURL, 'https://app.example/api/relay/anthropic');
    assert.ok(seen.signal instanceof AbortSignal);
    assert.deepEqual(events, [
      { type: 'start', provider: 'anthropic', model: 'claude-sonnet-5-5-served', requestId: 'r' },
      { type: 'text', delta: 'Hi' },
      { type: 'end', stopReason: 'end_turn' },
    ]);
  });

  it('classifies SDK errors by their status and a missing end as a cut stream', async () => {
    /** @param {() => AsyncGenerator<any>} gen */
    const sdk = (gen) => /** @type {import('../../src/js/ai/stream.js').SdkAdapter} */ ({ kind: 'sdk', id: 'anthropic', dialect: 'anthropic', stream: gen });
    const failing = sdk(async function* () {
      yield { type: 'text', delta: 'x' };
      throw Object.assign(new Error('401 invalid x-api-key sk-ant-test'), { status: 401, headers: {} });
    });
    const end = /** @type {any} */ ((await all(stream(failing, request({ provider: 'anthropic' }), null))).at(-1));
    assert.equal(end.error.code, 'auth');
    const short = sdk(async function* () {
      yield { type: 'text', delta: 'x' };
    });
    assert.equal(/** @type {any} */ ((await all(stream(short, request({ provider: 'anthropic' }), null))).at(-1)).error.code, 'stream_cut');
  });

  it('times out a stalled SDK and aborts its signal', async () => {
    /** @type {AbortSignal | null} */
    let signal = null;
    const adapter = /** @type {import('../../src/js/ai/stream.js').SdkAdapter} */ ({
      kind: 'sdk',
      id: 'anthropic',
      dialect: 'anthropic',
      async *stream(_req, context) {
        signal = context.signal;
        yield { type: 'text', delta: 'x' };
        await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason)));
      },
    });
    const end = /** @type {any} */ ((await all(stream(adapter, request({ provider: 'anthropic' }), null, { idleTimeoutMs: 30 }))).at(-1));
    assert.equal(end.stopReason, 'timeout');
    assert.equal(/** @type {AbortSignal | null} */ (signal)?.aborted, true);
  });
});
