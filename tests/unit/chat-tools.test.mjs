// The chat's request hook for tools: which tools a request offers. Built-in groups follow their
// switches, memory waits for the memory feature and for memory to be on, an MCP tool counts only
// while its approval stands, and a Gemini web turn keeps its own search without declared functions.
// The tool runner answers memory_lookup with the notes of the turn's conversation, and an answer
// written from a web pack comes back with its web check in the thread's shape.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { webPack } from '../../src/js/ai/search.js';
import { installChatTools, setMemoryLookup, switchOnTools, verifiedWebAnswer } from '../../src/js/chat/tools.js';
import { requestHooks, single } from '../../src/js/chat/hooks.js';

/** @typedef {import('../../src/js/ai/contract.js').AiRequest} AiRequest */

const ctx = /** @type {import('../../src/js/chat/hooks.js').TurnContext} */ (/** @type {unknown} */ ({ conversationId: 'c1', question: 'What time is it?', mode: 'free', route: 'free', target: null, locale: 'en', attachments: [] }));

/**
 * The tools a request offers after the hooks ran.
 * @param {Partial<AiRequest>} over
 */
function offered(over) {
  /** @type {AiRequest} */
  let req = { provider: 'openai', model: 'gpt-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], ...over };
  for (const hook of requestHooks) req = hook(req, ctx);
  return (req.tools ?? []).map((t) => t.name);
}

describe('tools offered by the chat', () => {
  const runtime = installChatTools();

  it('offers the switched-on groups, and memory only once the memory feature answers it and memory is on', () => {
    assert.deepEqual(offered({}), ['datetime', 'calculator']);
    let on = false;
    const off = setMemoryLookup({ enabled: () => on, lookup: async () => [] });
    assert.deepEqual(offered({}), ['datetime', 'calculator'], 'memory is off by default: the tool is not offered');
    on = true;
    assert.deepEqual(offered({}), ['datetime', 'calculator', 'memory_lookup']);
    off();
    assert.deepEqual(offered({}), ['datetime', 'calculator']);
    runtime.setSwitches({ workspace_search: true, calculator: false });
    assert.deepEqual(offered({}), ['datetime', 'workspace_search']);
    runtime.setSwitches({ workspace_search: false, calculator: true });
  });

  it('keeps a Gemini web turn to its own search, without declared functions', () => {
    assert.deepEqual(offered({ provider: 'gemini', model: 'gemini-2.5-flash', search: { enabled: true } }), []);
    assert.deepEqual(offered({ provider: 'gemini', model: 'gemini-2.5-flash' }), ['datetime', 'calculator']);
    // Other providers combine their search with tools.
    assert.deepEqual(offered({ search: { enabled: true } }), ['datetime', 'calculator']);
  });

  it('offers an MCP tool only while its server holds the approval it was registered with', () => {
    const off = runtime.registry.register({
      name: 'mcp_Gone_lookup',
      origin: 'mcp',
      effect: 'read',
      description: 'l',
      schema: { type: 'object', properties: {} },
      server: { id: 'gone1', name: 'Gone', tool: 'lookup', hash: `sha256:${'e'.repeat(64)}` },
      run: async () => ({ content: '' }),
    });
    try {
      assert.ok(!offered({}).includes('mcp_Gone_lookup'));
    } finally {
      off();
    }
  });

  it("answers memory_lookup with the notes of the turn's conversation", async () => {
    /** @type {Array<[string, number, string | null]>} */
    const asked = [];
    const off = setMemoryLookup({ enabled: () => true, lookup: async (query, limit, id) => (asked.push([query, limit, id]), [{ text: 'Prefers metric units.' }]) });
    const realFetch = globalThis.fetch;
    // The round after the tool call fails at once: only the tool's run matters here.
    globalThis.fetch = async () => {
      throw new TypeError('offline');
    };
    try {
      const req = /** @type {AiRequest} */ ({ provider: 'openai', model: 'gpt-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'How tall am I in cm?' }] }] });
      let offeredReq = req;
      for (const hook of requestHooks) offeredReq = hook(offeredReq, ctx);
      assert.ok(offeredReq.tools?.some((t) => t.name === 'memory_lookup'));
      const result = /** @type {any} */ ({ text: '', reasoning: '', toolCalls: [{ id: 'call_1', name: 'memory_lookup', args: { query: 'height' }, argsText: '{"query":"height"}' }], citations: [], images: [], opaque: [], usage: null, stopReason: 'tool_call', model: 'gpt-5', provider: 'openai', error: null });
      await single.tools?.({ result, request: async () => offeredReq, ctx: { ...ctx, conversationId: 'conv-project' }, signal: new AbortController().signal });
      assert.deepEqual(asked, [['height', 8, 'conv-project']]);
    } finally {
      globalThis.fetch = realFetch;
      off();
    }
  });

  it('switches on the built-in tools an assistant names and leaves the others as they are', () => {
    runtime.setSwitches({ web_search: false, calculator: true, workspace_search: false });
    switchOnTools(['web', 'thinking', 'web_search']);
    assert.equal(runtime.switches().web_search, true);
    assert.equal(runtime.switches().calculator, true, 'a tool the assistant does not name keeps its setting');
    assert.equal(runtime.switches().workspace_search, false);
    runtime.setSwitches({ web_search: false });
  });
});

describe('the verified web answer', () => {
  const results = [
    { title: 'Tides explained', url: 'https://example.org/tides', snippet: 'Tides are caused mainly by the gravity of the Moon.' },
    { title: 'Ocean basics', url: 'https://example.com/ocean', snippet: 'The ocean covers most of the surface of the Earth.' },
  ];
  const pack = webPack('What causes tides?', results);
  /** @param {string} text */
  const answer = (text) => /** @type {any} */ ({ text, reasoning: '', toolCalls: [], citations: [], images: [], opaque: [], usage: null, stopReason: 'end', model: 'm', provider: 'local', error: null });

  it('drops the markers, links the supported statements and reports n of m as a checked web check', () => {
    const out = verifiedWebAnswer(answer('Tides are caused mainly by the gravity of the Moon. [W1] The ocean holds 42 billion whales in 1999. [W2]'), pack);
    assert.doesNotMatch(out.text, /\[W\d\]/);
    assert.deepEqual(out.webCheck, { kind: 'checked', pages: 2, supported: 1, flagged: 1, total: 2 });
    assert.deepEqual(out.citations.map((c) => c.url), ['https://example.org/tides']);
  });

  it('says there was nothing to compare when the answer cites no result', () => {
    const out = verifiedWebAnswer(answer('I do not know.'), pack);
    assert.equal(out.text, 'I do not know.');
    assert.deepEqual(out.webCheck, { kind: 'checked', pages: 0, supported: 0, flagged: 0, total: 0 });
  });
});
