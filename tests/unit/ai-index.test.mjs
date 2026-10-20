// The AI facade: adapter registry, transport resolver, complete() with its two views (events and
// the assembled result), the result builder and the event-sequence check adapters are tested with.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  AiError,
  collect,
  complete,
  createResultBuilder,
  getAdapter,
  listAdapters,
  registerAdapter,
  setTransportResolver,
  textPart,
  validateEventSequence,
} from '../../src/js/ai/index.js';

/** @returns {import('../../src/js/ai/contract.js').AiRequest} */
const request = (provider = /** @type {import('../../src/js/ai/contract.js').ProviderId} */ ('groq')) => ({ provider, model: 'fake-model', messages: [{ role: 'user', content: [textPart('Hi')] }] });

/**
 * An SDK-kind adapter that yields the given events, optionally waiting for an abort first.
 * @param {any[]} events
 * @param {{ waitForAbort?: boolean, seen?: { signal?: AbortSignal, fetch?: unknown } }} [options]
 * @returns {import('../../src/js/ai/stream.js').SdkAdapter}
 */
function scripted(events, options = {}) {
  return {
    kind: 'sdk',
    id: 'groq',
    dialect: 'test',
    async *stream(_req, context) {
      if (options.seen) Object.assign(options.seen, { signal: context.signal, fetch: context.fetch });
      for (const ev of events) yield ev;
      if (options.waitForAbort) await new Promise((_r, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason)));
    },
  };
}

const unregister = /** @type {Array<() => void>} */ ([]);
afterEach(() => {
  for (const off of unregister.splice(0)) off();
  setTransportResolver(null);
});

describe('adapter registry', () => {
  it('registers, looks up and removes adapters', () => {
    const adapter = scripted([]);
    const off = registerAdapter('groq', adapter);
    assert.equal(getAdapter('groq'), adapter);
    assert.ok(listAdapters().includes('groq'));
    off();
    assert.equal(getAdapter('groq'), null);
  });

  it('refuses unknown ids and malformed adapters', () => {
    assert.throws(() => registerAdapter(/** @type {any} */ ('nope'), scripted([])), TypeError);
    assert.throws(() => registerAdapter('groq', /** @type {any} */ ({ kind: 'wire', buildRequest() {} })), TypeError);
    assert.throws(() => registerAdapter('groq', /** @type {any} */ ({ kind: 'sdk' })), TypeError);
  });
});

describe('complete()', () => {
  it('streams events and resolves the assembled result', async () => {
    unregister.push(
      registerAdapter(
        'groq',
        scripted([
          { type: 'start', provider: 'groq', model: 'served', requestId: 'r-1' },
          { type: 'reasoning', delta: 'Think. ' },
          { type: 'reasoning', tokens: 7 },
          { type: 'text', delta: 'Hel' },
          { type: 'text', delta: 'lo' },
          { type: 'citation', url: 'https://example.com/a', title: 'A', start: 0, end: 5 },
          { type: 'tool_call', id: 'c1', name: 'look_up', argsDelta: '{"q":', final: false },
          { type: 'tool_call', id: 'c1', name: 'look_up', argsDelta: '"x"}', final: true },
          { type: 'tool_call', id: 'c2', name: 'other', args: { n: 1 }, final: true },
          { type: 'image', mime: 'image/png', data: 'AAAA' },
          { type: 'opaque', block: { signature: 's' } },
          { type: 'usage', input: 10, output: 2 },
          { type: 'usage', output: 5, cacheRead: 3 },
          { type: 'end', stopReason: 'tool_call' },
        ]),
      ),
    );
    const call = complete(request());
    const types = [];
    for await (const ev of call.events) types.push(ev.type);
    const result = await call.result;
    assert.equal(types[0], 'start');
    assert.equal(types.at(-1), 'end');
    assert.equal(result.text, 'Hello');
    assert.equal(result.reasoning, 'Think. ');
    assert.equal(result.reasoningTokens, 7);
    assert.deepEqual(result.toolCalls, [
      { id: 'c1', name: 'look_up', args: { q: 'x' }, argsText: '{"q":"x"}' },
      { id: 'c2', name: 'other', args: { n: 1 }, argsText: '{"n":1}' },
    ]);
    assert.deepEqual(result.citations, [{ url: 'https://example.com/a', title: 'A', start: 0, end: 5 }]);
    assert.deepEqual(result.images, [{ mime: 'image/png', data: 'AAAA' }]);
    assert.deepEqual(result.opaque, [{ type: 'opaque', provider: 'groq', model: 'served', block: { signature: 's' } }]);
    assert.deepEqual(result.usage, { input: 10, output: 5, reasoning: 0, cacheRead: 3 });
    assert.equal(result.stopReason, 'tool_call');
    assert.equal(result.model, 'served');
    assert.equal(result.requestId, 'r-1');
    assert.equal(result.error, null);
  });

  it('runs without anyone reading the events', async () => {
    unregister.push(registerAdapter('groq', scripted([{ type: 'text', delta: 'only result' }, { type: 'end', stopReason: 'end_turn' }])));
    const result = await complete(request()).result;
    assert.equal(result.text, 'only result');
    assert.equal(result.model, 'fake-model');
  });

  it('resolves with the error and the text so far when the call fails', async () => {
    unregister.push(registerAdapter('groq', scripted([{ type: 'text', delta: 'part' }, { type: 'end', stopReason: 'error', error: new AiError('server', { status: 503 }) }])));
    const result = await complete(request()).result;
    assert.equal(result.text, 'part');
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.code, 'server');
  });

  it('ends with an error result when no adapter is registered', async () => {
    const call = complete(request('mistral'));
    const events = await collect(call.events);
    const result = await call.result;
    assert.equal(result.error?.code, 'bad_request');
    assert.equal(events.stopReason, 'error');
    assert.equal(result.provider, 'mistral');
  });

  it('takes the transport from the resolver, and from the options first', async () => {
    const seen = /** @type {{ fetch?: unknown }} */ ({});
    unregister.push(registerAdapter('groq', scripted([{ type: 'end', stopReason: 'end_turn' }], { seen })));
    const resolved = /** @type {any} */ (Object.assign(async () => new Response(''), { kind: 'pool', provider: 'groq', baseURL: 'x', fetch: 'resolved-fetch' }));
    const given = /** @type {any} */ (Object.assign(async () => new Response(''), { kind: 'direct', provider: 'groq', baseURL: 'y', fetch: 'given-fetch' }));
    setTransportResolver(async (provider) => (provider === 'groq' ? resolved : null));
    await complete(request()).result;
    assert.equal(seen.fetch, 'resolved-fetch');
    await complete(request(), { transport: given }).result;
    assert.equal(seen.fetch, 'given-fetch');
  });

  it('turns a resolver failure into an error result', async () => {
    unregister.push(registerAdapter('groq', scripted([{ type: 'end', stopReason: 'end_turn' }])));
    setTransportResolver(() => {
      throw new AiError('auth', { provider: 'groq' });
    });
    const result = await complete(request()).result;
    assert.equal(result.error?.code, 'auth');
  });

  it('stops the call when the reader leaves the event loop, on abort() and on the signal', async () => {
    const seen = /** @type {{ signal?: AbortSignal }} */ ({});
    unregister.push(registerAdapter('groq', scripted([{ type: 'text', delta: 'a' }], { waitForAbort: true, seen })));
    const first = complete(request());
    for await (const ev of first.events) if (ev.type === 'text') break;
    assert.equal((await first.result).stopReason, 'cancelled');
    assert.equal(seen.signal?.aborted, true);

    const second = complete(request());
    setTimeout(() => second.abort(), 10);
    assert.equal((await second.result).stopReason, 'cancelled');

    const ac = new AbortController();
    const third = complete(request(), { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    assert.equal((await third.result).error?.code, 'aborted');
  });

  it('lets the events be read once', async () => {
    unregister.push(registerAdapter('groq', scripted([{ type: 'end', stopReason: 'end_turn' }])));
    const call = complete(request());
    call.events[Symbol.asyncIterator]();
    assert.throws(() => call.events[Symbol.asyncIterator](), TypeError);
    await call.result;
  });
});

describe('createResultBuilder', () => {
  it('keeps unreadable tool arguments as null and the raw text', () => {
    const b = createResultBuilder({ provider: 'openai', model: 'm' });
    b.add({ type: 'tool_call', id: 't', name: 'x', argsDelta: '{"broken', final: true });
    b.add({ type: 'tool_call', id: 'e', name: 'y', final: true });
    const r = b.result();
    assert.deepEqual(r.toolCalls, [
      { id: 't', name: 'x', args: null, argsText: '{"broken' },
      { id: 'e', name: 'y', args: {}, argsText: '' },
    ]);
    assert.equal(r.stopReason, 'error', 'no end event yet');
  });
});

describe('validateEventSequence', () => {
  it('demands one start first and one end last', () => {
    assert.deepEqual(validateEventSequence([{ type: 'start', provider: 'openai', model: 'm' }, { type: 'end', stopReason: 'end_turn' }]), []);
    assert.ok(validateEventSequence([{ type: 'text', delta: 'x' }]).length >= 2);
    assert.ok(validateEventSequence([{ type: 'start', provider: 'openai', model: 'm' }, { type: 'end', stopReason: 'end_turn' }, { type: 'end', stopReason: 'end_turn' }]).length);
  });
});
