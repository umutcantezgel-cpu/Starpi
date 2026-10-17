// Helpers the adapters share (the streaming <think> splitter, UTF-8 to UTF-16 offsets, the tool
// call tracker, usage events, in-stream error identifiers) and the built-in adapter registry.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { argsObject, base64Text, createThinkSplitter, createToolCalls, streamError, usageEvent, utf16Offset } from '../../src/js/ai/adapters/common.js';
import { createAdapter, registerBuiltInAdapters } from '../../src/js/ai/adapters/index.js';
import { PROVIDER_IDS } from '../../src/js/ai/contract.js';
import { getAdapter, listAdapters } from '../../src/js/ai/index.js';

/**
 * @param {string[]} deltas
 */
function split(deltas) {
  const s = createThinkSplitter();
  const out = deltas.flatMap((d) => s.push(d)).concat(s.flush());
  return {
    reasoning: out.filter((p) => p.type === 'reasoning').map((p) => p.delta).join(''),
    text: out.filter((p) => p.type === 'text').map((p) => p.delta).join(''),
  };
}

describe('think splitter', () => {
  it('separates a leading reasoning block from the answer, whatever the delta boundaries', () => {
    const whole = '<think>Plan the steps.</think>\n\nThe answer.';
    for (let size = 1; size <= whole.length; size += 3) {
      const deltas = [];
      for (let i = 0; i < whole.length; i += size) deltas.push(whole.slice(i, i + size));
      assert.deepEqual(split(deltas), { reasoning: 'Plan the steps.', text: 'The answer.' }, `size ${size}`);
    }
  });

  it('knows the other tag names, case-insensitively, and leaves lone angle brackets alone', () => {
    assert.deepEqual(split(['<Thought>x</THOUGHT>y']), { reasoning: 'x', text: 'y' });
    assert.deepEqual(split(['<denkprozess>a</denkprozess>b']), { reasoning: 'a', text: 'b' });
    assert.deepEqual(split(['1 < 2 and <b>bold</b>']), { reasoning: '', text: '1 < 2 and <b>bold</b>' });
    assert.deepEqual(split(['ends with <']), { reasoning: '', text: 'ends with <' });
    assert.deepEqual(split(['<think>never closed']), { reasoning: 'never closed', text: '' });
  });
});

describe('adapter helpers', () => {
  it('converts UTF-8 byte offsets into UTF-16 offsets', () => {
    const text = 'Grüße 👋 ok';
    const bytes = Buffer.from(text);
    for (const target of ['Grüße', '👋', 'ok']) {
      const at = text.indexOf(target);
      const byte = Buffer.byteLength(text.slice(0, at));
      assert.equal(utf16Offset(text, byte), at, target);
    }
    assert.equal(utf16Offset(text, bytes.length + 10), text.length);
    assert.equal(utf16Offset(text, 3), 2, 'the middle of a character rounds down');
  });

  it('tracks tool calls from pieces and closes each once', () => {
    const calls = createToolCalls();
    assert.deepEqual(calls.add(0, { argsDelta: '{"a"' }, () => 'x'), [], 'a piece before the name is dropped');
    const first = calls.add(0, { id: 'c1', name: 'lookup', argsDelta: '{"q":' }, () => 'x');
    assert.deepEqual(first, [
      { type: 'tool_call', id: 'c1', name: 'lookup', final: false },
      { type: 'tool_call', id: 'c1', name: 'lookup', argsDelta: '{"q":', final: false },
    ]);
    calls.add(0, { argsDelta: '"v"}' }, () => 'x');
    calls.add(1, { name: 'other', argsDelta: 'not json' }, () => 'generated');
    assert.deepEqual(calls.finish(), [
      { type: 'tool_call', id: 'c1', name: 'lookup', args: { q: 'v' }, final: true },
      { type: 'tool_call', id: 'generated', name: 'other', final: true },
    ]);
    assert.deepEqual(calls.finish(), []);
    assert.equal(calls.size, 2);
  });

  it('builds usage events from valid counts only, and parses argument objects', () => {
    assert.deepEqual(usageEvent({ input: 3, output: -1, reasoning: 1.5, cacheRead: 0 }), { type: 'usage', input: 3, cacheRead: 0 });
    assert.equal(usageEvent({}), null);
    assert.deepEqual(argsObject(''), {});
    assert.equal(argsObject('[1]'), undefined);
    assert.equal(argsObject('{'), undefined);
    assert.equal(base64Text(Buffer.from('häh').toString('base64')), 'häh');
  });

  it('maps in-stream error identifiers onto AI error codes and keeps only the identifier', () => {
    assert.equal(streamError('anthropic', 'overloaded_error').code, 'server');
    assert.equal(streamError('openai', 'rate_limit_exceeded').code, 'rate_limited');
    assert.equal(streamError('gemini', 'RESOURCE_EXHAUSTED').code, 'rate_limited');
    assert.equal(streamError('xai', 'context_length_exceeded').code, 'context_length');
    const unknown = streamError('groq', 'Something went <wrong> here');
    assert.equal(unknown.code, 'server');
    assert.equal(unknown.providerCode, null);
    assert.equal(unknown.provider, 'groq');
  });
});

describe('built-in adapters', () => {
  it('registers one adapter per provider and removes them again', () => {
    const remove = registerBuiltInAdapters();
    try {
      assert.deepEqual(listAdapters().sort(), [...PROVIDER_IDS].sort());
      for (const id of PROVIDER_IDS) assert.equal(getAdapter(id)?.id, id);
      assert.equal(getAdapter('anthropic')?.kind, 'sdk');
      assert.equal(getAdapter('groq')?.kind, 'wire');
    } finally {
      remove();
    }
    assert.deepEqual(listAdapters(), []);
    assert.throws(() => createAdapter(/** @type {any} */ ('nope')), TypeError);
  });
});
