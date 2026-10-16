// The AI data contract: requests, parts per role, tool specs, capabilities and events validate as
// documented, and opaque provider state is dropped only for other providers.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isProviderId,
  messageText,
  PROVIDER_IDS,
  textPart,
  validateCaps,
  validateEvent,
  validateMessage,
  validatePart,
  validateRequest,
  validateToolSpec,
  withoutForeignOpaque,
} from '../../src/js/ai/contract.js';
import { AiError } from '../../src/js/ai/errors.js';

/** @returns {import('../../src/js/ai/contract.js').AiRequest} */
const request = () => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  system: 'You are helpful.',
  messages: [
    { role: 'user', content: [textPart('What is in the picture?'), { type: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' }] },
    { role: 'assistant', content: [{ type: 'opaque', provider: 'anthropic', model: 'claude-sonnet-5-5', block: { type: 'thinking', signature: 's' } }, { type: 'tool_call', id: 'c1', name: 'look_up', args: { q: 'x' } }] },
    { role: 'tool', content: [{ type: 'tool_result', id: 'c1', content: 'found' }] },
  ],
  tools: [{ name: 'look_up', description: 'Looks something up.', schema: { type: 'object' }, sideEffects: false }],
  toolChoice: 'auto',
  thinking: { mode: 'on', effort: 'high', show: true },
  search: { enabled: true, maxUses: 3, allowDomains: ['example.com'] },
  responseFormat: { type: 'json_schema', schema: { type: 'object' } },
  maxOutputTokens: 1024,
  temperature: 0.2,
  timeoutMs: 60_000,
});

const CAPS = {
  text: true,
  vision: true,
  pdf: false,
  tools: true,
  parallelTools: true,
  reasoning: 'adaptive',
  reasoningVisible: true,
  search: 'native',
  imageOut: false,
  audioIn: false,
  live: false,
  json: true,
  contextTokens: 200_000,
  maxOutput: 64_000,
  priceIn: 2,
  latency: 'normal',
  free: false,
  local: false,
  verified: true,
};

describe('validateRequest', () => {
  it('accepts a full request', () => {
    assert.deepEqual(validateRequest(request()), []);
  });

  it('names each problem by its path', () => {
    const req = /** @type {any} */ (request());
    req.provider = 'unknown';
    req.messages[0].content[1].mime = 'image/bmp';
    req.toolChoice = { type: 'tool', name: 'look_up' };
    req.thinking = { mode: 'always' };
    req.maxOutputTokens = 0;
    const problems = validateRequest(req);
    assert.ok(problems.some((p) => p.startsWith('provider:')));
    assert.ok(problems.some((p) => p.startsWith('messages[0].content[1].mime')));
    assert.ok(problems.some((p) => p.startsWith('toolChoice')), 'a forced tool choice is not part of the contract');
    assert.ok(problems.some((p) => p.startsWith('thinking.mode')));
    assert.ok(problems.some((p) => p.startsWith('maxOutputTokens')));
  });

  it('rejects empty conversations, duplicate tools and both domain lists', () => {
    assert.ok(validateRequest({ ...request(), messages: [] }).length);
    const req = request();
    req.tools = [...(req.tools ?? []), ...(req.tools ?? [])];
    assert.ok(validateRequest(req).some((p) => p.includes('unique')));
    assert.ok(validateRequest({ ...request(), search: { enabled: true, allowDomains: ['a.example'], blockDomains: ['b.example'] } }).length);
    assert.ok(validateRequest({ ...request(), search: { enabled: true, allowDomains: ['not a host'] } }).length);
    assert.deepEqual(validateRequest(null), ['request: not an object']);
  });
});

describe('validatePart and validateMessage', () => {
  it('check each part type', () => {
    assert.deepEqual(validatePart(textPart('hi')), []);
    assert.ok(validatePart({ type: 'image', mime: 'image/png', data: 'not base64!' }).length);
    assert.ok(validatePart({ type: 'file', mime: 'application/pdf', data: 'JVBERi0=' }).length, 'a file needs a name');
    assert.deepEqual(validatePart({ type: 'file', mime: 'application/pdf', data: 'JVBERi0=', name: 'a.pdf' }), []);
    assert.ok(validatePart({ type: 'tool_call', id: 'x', name: 'has space', args: {} }).length);
    assert.ok(validatePart({ type: 'tool_result', id: 'x', content: 'ok', isError: 'yes' }).length);
    assert.ok(validatePart({ type: 'opaque', provider: 'other', model: 'm', block: {} }).length);
    assert.ok(validatePart({ type: 'audio' }).length);
  });

  it('allow each part type only in its roles', () => {
    assert.ok(validateMessage({ role: 'user', content: [{ type: 'tool_call', id: 'c', name: 't', args: {} }] }).length);
    assert.ok(validateMessage({ role: 'system', content: [{ type: 'image', mime: 'image/png', data: 'AAAA' }] }).length);
    assert.ok(validateMessage({ role: 'tool', content: [textPart('x')] }).length);
    assert.ok(validateMessage({ role: 'user', content: [] }).length);
    assert.deepEqual(validateMessage({ role: 'assistant', content: [textPart('fine')] }), []);
  });
});

describe('validateToolSpec and validateCaps', () => {
  it('check tool specs', () => {
    assert.deepEqual(validateToolSpec({ name: 'get_time', description: 'Tells the time.', schema: { type: 'object' }, sideEffects: false }), []);
    assert.equal(validateToolSpec({ name: 'x'.repeat(65), description: '', schema: [], sideEffects: 'no' }).length, 4);
  });

  it('check capability records', () => {
    assert.deepEqual(validateCaps(CAPS), []);
    assert.ok(validateCaps({ ...CAPS, reasoning: 'deep' }).length);
    assert.ok(validateCaps({ ...CAPS, contextTokens: 0 }).length);
    assert.ok(validateCaps({ ...CAPS, priceOut: -1 }).length);
    assert.ok(validateCaps({ ...CAPS, text: false }).length);
  });
});

describe('validateEvent', () => {
  it('accepts every event type in its documented shape', () => {
    const events = [
      { type: 'start', provider: 'openai', model: 'm', requestId: 'r1' },
      { type: 'text', delta: 'Hi' },
      { type: 'reasoning', delta: 'thinking' },
      { type: 'reasoning', tokens: 12 },
      { type: 'tool_call', id: 'c1', name: 'look_up', argsDelta: '{"q"', final: false },
      { type: 'tool_call', id: 'c1', name: 'look_up', args: { q: 'x' }, final: true },
      { type: 'citation', url: 'https://example.com/a', title: 'A', citedText: 'x', start: 0, end: 5 },
      { type: 'image', mime: 'image/png', data: 'AAAA' },
      { type: 'opaque', block: { signature: 's' } },
      { type: 'usage', input: 10, output: 5, reasoning: 2, cacheRead: 0, costUsd: 0.001 },
      { type: 'end', stopReason: 'end_turn' },
      { type: 'end', stopReason: 'error', error: new AiError('server') },
    ];
    for (const ev of events) assert.deepEqual(validateEvent(ev), [], JSON.stringify(ev));
  });

  it('rejects malformed events', () => {
    assert.ok(validateEvent({ type: 'reasoning', delta: 'x', tokens: 3 }).length, 'delta and tokens exclude each other');
    assert.ok(validateEvent({ type: 'citation', url: 'javascript:alert(1)', title: '' }).length);
    assert.ok(validateEvent({ type: 'citation', url: 'https://example.com', title: '', start: 9, end: 2 }).length);
    assert.ok(validateEvent({ type: 'end', stopReason: 'finished' }).length);
    assert.ok(validateEvent({ type: 'end', stopReason: 'error', error: 'boom' }).length);
    assert.ok(validateEvent({ type: 'usage', input: -1 }).length);
    assert.ok(validateEvent({ type: 'delta' }).length);
  });
});

describe('helpers', () => {
  it('knows the provider ids', () => {
    assert.ok(PROVIDER_IDS.every(isProviderId));
    assert.equal(isProviderId('constructor'), false);
  });

  it('joins message text', () => {
    assert.equal(messageText({ role: 'user', content: [textPart('a'), { type: 'image', mime: 'image/png', data: 'AA==' }, textPart('b')] }), 'ab');
  });

  it("drops other providers' opaque parts and messages left empty", () => {
    const messages = /** @type {import('../../src/js/ai/contract.js').Message[]} */ ([
      { role: 'user', content: [textPart('q')] },
      { role: 'assistant', content: [{ type: 'opaque', provider: 'gemini', model: 'g', block: 'sig' }] },
      { role: 'assistant', content: [{ type: 'opaque', provider: 'anthropic', model: 'old-model', block: 'b' }, textPart('a')] },
    ]);
    const forAnthropic = withoutForeignOpaque(messages, 'anthropic');
    assert.equal(forAnthropic.length, 2);
    assert.equal(forAnthropic[1], messages[2], 'same-provider state stays, even from another model');
    const forOpenAi = withoutForeignOpaque(messages, 'openai');
    assert.deepEqual(forOpenAi.map((m) => m.content.map((p) => p.type)), [['text'], ['text']]);
  });
});
