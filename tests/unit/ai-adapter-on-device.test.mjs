// The in-browser adapters: the processor runtime's WasmEngineClient (driven over a scripted worker)
// and the engine controller of webgpu/engine.js (a stand-in with the same functions) stream their
// text as AiEvents, <think> reasoning becomes reasoning events, Stop interrupts the engine, and
// engine failures map to AI error codes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { localMessages } from '../../src/js/ai/adapters/on-device.js';
import { createWasmAdapter } from '../../src/js/ai/adapters/wasm.js';
import { createWebllmAdapter } from '../../src/js/ai/adapters/webllm.js';
import { collect, validateEventSequence } from '../../src/js/ai/index.js';
import { stream } from '../../src/js/ai/stream.js';
import { WasmEngineClient } from '../../src/js/wasm/client.js';
import { joined, ofType, request, run } from '../fixtures/ai/replay.mjs';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A worker that answers generate requests with scripted deltas, as src/js/wasm/worker.js does. */
class ScriptedWorker extends EventTarget {
  /** @param {string[]} pieces @param {number} [gapMs] */
  constructor(pieces, gapMs = 1) {
    super();
    this.pieces = pieces;
    this.gapMs = gapMs;
    /** @type {any[]} */
    this.posted = [];
    this.interruptedUpTo = 0;
  }

  /** @param {any} message */
  postMessage(message) {
    this.posted.push(message);
    if (message.type === 'interrupt') this.interruptedUpTo = message.upTo;
    if (message.type === 'generate') void this.answer(message.id);
  }

  /** @param {number} id */
  async answer(id) {
    let completion = 0;
    for (const text of this.pieces) {
      await sleep(this.gapMs);
      if (this.interruptedUpTo >= id) break;
      completion += 1;
      this.dispatchEvent(new MessageEvent('message', { data: { id, type: 'delta', text } }));
    }
    this.dispatchEvent(new MessageEvent('message', { data: { id, type: 'done', usage: { prompt_tokens: 7, completion_tokens: completion } } }));
  }
}

/**
 * A stand-in for the engine controller of webgpu/engine.js.
 * @param {{ pieces?: string[], status?: string, ref?: string, fail?: unknown }} [script]
 */
function controller(script = {}) {
  const calls = { interrupts: 0, /** @type {any[]} */ requests: [] };
  let stopped = false;
  return {
    calls,
    getEngineState: () => ({ status: script.status ?? 'ready', model: { ref: script.ref ?? 'webgpu:qwen-0.5b', runtime: 'webgpu' } }),
    interrupt: () => {
      calls.interrupts += 1;
      stopped = true;
    },
    /** @param {any} req */
    async generate(req) {
      calls.requests.push(req);
      if (script.fail) throw script.fail;
      let text = '';
      for (const piece of script.pieces ?? ['Hello', ' there.']) {
        await sleep(2);
        if (stopped) break;
        text += piece;
        req.onDelta(text);
      }
      return text;
    },
  };
}

describe('on-device adapters', () => {
  it('stream the processor runtime client, with <think> reasoning apart and usage at the end', async () => {
    const worker = new ScriptedWorker(['<think>Short', ' plan.</think>', '\n\nThe answer', ' is two.']);
    const client = new WasmEngineClient(/** @type {any} */ (worker));
    const adapter = createWasmAdapter({ engine: client });
    const evs = await run(adapter, request('wasm', 'wasm:smollm2-135m', 'What is one plus one?', { system: 'Be brief.' }), null);
    assert.deepEqual(validateEventSequence(evs), []);
    assert.deepEqual(evs[0], { type: 'start', provider: 'wasm', model: 'wasm:smollm2-135m', requestId: null });
    assert.equal(joined(evs, 'reasoning'), 'Short plan.');
    assert.equal(joined(evs, 'text'), 'The answer is two.');
    assert.deepEqual(ofType(evs, 'usage')[0], { type: 'usage', input: 7, output: 4 });
    assert.equal(evs.at(-1).stopReason, 'end_turn');
    const generate = worker.posted.find((m) => m.type === 'generate');
    assert.deepEqual(generate.messages, [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is one plus one?' },
    ]);
    assert.equal(generate.maxTokens, 384, 'the preset caps the output');
  });

  it('interrupt the engine on Stop', async () => {
    const worker = new ScriptedWorker(['One', ' two', ' three', ' four', ' five'], 15);
    const adapter = createWasmAdapter({ engine: new WasmEngineClient(/** @type {any} */ (worker)) });
    const stop = new AbortController();
    const evs = [];
    for await (const ev of stream(adapter, request('wasm', 'wasm:smollm2-135m', 'Count'), null, { signal: stop.signal })) {
      evs.push(ev);
      if (ev.type === 'text') stop.abort();
    }
    assert.deepEqual(validateEventSequence(evs), []);
    assert.equal(evs.at(-1).stopReason, 'cancelled');
    assert.ok(worker.posted.some((m) => m.type === 'interrupt'));
  });

  it('stream through the engine controller as deltas of the cumulative text', async () => {
    const engine = controller({ pieces: ['Hel', 'lo', ' <thi', 'nk>x</think> there'] });
    const adapter = createWebllmAdapter({ loadController: async () => engine });
    const result = await collect(await run(adapter, request('webgpu', 'webgpu:qwen-0.5b', 'Hi', { temperature: 0.2 }), null));
    assert.equal(result.text, 'Hello there');
    assert.equal(result.reasoning, 'x');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(engine.calls.requests[0].temperature, 0.2);
    assert.equal(engine.calls.interrupts, 0, 'a finished answer leaves the engine alone');
  });

  it('refuse a model that is not loaded and map engine failures', async () => {
    const idle = await collect(await run(createWebllmAdapter({ loadController: async () => controller({ status: 'idle' }) }), request('webgpu', 'webgpu:qwen-0.5b', 'Hi'), null));
    assert.equal(idle.error?.code, 'not_found');
    const other = await collect(await run(createWebllmAdapter({ loadController: async () => controller({ ref: 'webgpu:llama-1b' }) }), request('webgpu', 'webgpu:qwen-0.5b', 'Hi'), null));
    assert.equal(other.error?.code, 'not_found');
    const any = await collect(await run(createWebllmAdapter({ loadController: async () => controller({ ref: 'webgpu:llama-1b' }) }), request('webgpu', 'auto', 'Hi'), null));
    assert.equal(any.stopReason, 'end_turn');
    for (const [kind, code] of [
      ['device-lost', 'server'],
      ['busy', 'rate_limited'],
      ['out-of-memory', 'server'],
    ]) {
      const fail = Object.assign(new Error('engine failure'), { kind });
      const r = await collect(await run(createWebllmAdapter({ loadController: async () => controller({ fail }) }), request('webgpu', 'auto', 'Hi'), null));
      assert.equal(r.error?.code, code, kind);
      assert.equal(r.error?.providerCode, kind.replace(/-/g, '_'));
    }
  });

  it('turn the conversation into text-only chat messages', () => {
    const messages = localMessages(
      /** @type {any} */ ({
        provider: 'webgpu',
        model: 'auto',
        system: 'Rules.',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'More rules.' }] },
          { role: 'user', content: [{ type: 'text', text: 'See file.' }, { type: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'file', mime: 'text/plain', data: Buffer.from('abc').toString('base64'), name: 'a.txt' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Seen.' }, { type: 'tool_call', id: 't', name: 'x', args: {} }] },
          { role: 'tool', content: [{ type: 'tool_result', id: 't', content: 'ignored' }] },
        ],
      }),
    );
    assert.deepEqual(messages, [
      { role: 'system', content: 'Rules.\n\nMore rules.' },
      { role: 'user', content: 'See file.\n\na.txt\n\nabc' },
      { role: 'assistant', content: 'Seen.' },
    ]);
  });
});
