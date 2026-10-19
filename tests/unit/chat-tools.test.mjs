// The chat's request hook for tools: which tools a request offers. Built-in groups follow their
// switches, memory waits for the memory feature and for memory to be on, an MCP tool counts only
// while its approval stands, and a Gemini web turn keeps its own search without declared functions.
// The tool runner answers memory_lookup with the notes of the turn's conversation, and an answer
// written from a web pack comes back with its web check in the thread's shape; the pack stays for
// the turn's later answers, and one that cites nothing from it is left to its own citations.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { webPack, writeSearchSettings } from '../../src/js/ai/search.js';
import { installChatTools, setMemoryLookup, switchOnTools, verifiedWebAnswer } from '../../src/js/chat/tools.js';
import { requestHooks, single, turnNoteHooks } from '../../src/js/chat/hooks.js';
import { getAssistant, getWebSearch, setAssistant, setWebSearch } from '../../src/js/state.js';

/** @typedef {import('../../src/js/ai/contract.js').AiRequest} AiRequest */

const ctx = /** @type {import('../../src/js/chat/hooks.js').TurnContext} */ (/** @type {unknown} */ ({ conversationId: 'c1', question: 'What time is it?', mode: 'free', route: 'free', target: null, locale: 'en', attachments: [] }));

/**
 * The tools a request offers after the hooks ran.
 * @param {Partial<AiRequest>} over
 * @param {Partial<import('../../src/js/chat/hooks.js').TurnContext>} [turn]  changes to the turn
 */
function offered(over, turn = {}) {
  /** @type {AiRequest} */
  let req = { provider: 'openai', model: 'gpt-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], ...over };
  for (const hook of requestHooks) req = hook(req, { ...ctx, ...turn });
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

  it('offers a question that stays on this device only the tools that keep it here, and searches the web for it nowhere', async () => {
    const before = { assistant: getAssistant(), web: getWebSearch() };
    // The search service's settings live in this browser's storage.
    const kept = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (/** @type {string} */ k) => kept.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => void kept.set(k, String(v)), removeItem: (/** @type {string} */ k) => void kept.delete(k) },
    });
    writeSearchSettings({ provider: 'searxng', searxngUrl: 'https://search.example.org' });
    runtime.setSwitches({ web_search: true, workspace_search: true });
    const off = setMemoryLookup({ enabled: () => true, lookup: async () => [] });
    const realFetch = globalThis.fetch;
    /** @type {string[]} */
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ results: [{ title: 'Garden notes', url: 'https://example.org/garden', content: 'Roses need water every second day.' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      assert.ok(offered({}).includes('web_search'), 'the web search is offered to a question that may leave');
      assert.deepEqual(offered({}, { localOnly: true }), ['datetime', 'calculator', 'workspace_search', 'memory_lookup']);
      // The web pack: the own server's model cannot search itself, so a question that may leave is
      // searched first; one that stays here goes to no search service.
      setAssistant('local:fake-model');
      setWebSearch(true);
      const notes = async (/** @type {Partial<import('../../src/js/chat/hooks.js').TurnContext>} */ turn) => {
        const out = [];
        for (const hook of turnNoteHooks) out.push(...(await hook({ ...ctx, question: 'How often do roses need water?', ...turn })));
        return out;
      };
      assert.deepEqual(await notes({ conversationId: 'c-held', localOnly: true }), []);
      assert.deepEqual(fetched, [], 'nothing went to the search service');
      const open = await notes({ conversationId: 'c-open' });
      assert.equal(open.length, 1);
      assert.match(open[0], /Roses need water every second day/);
      assert.equal(fetched.length, 1);
      assert.match(fetched[0], /^https:\/\/search\.example\.org\/search\?/);
    } finally {
      globalThis.fetch = realFetch;
      off();
      runtime.setSwitches({ web_search: false, workspace_search: false });
      writeSearchSettings({ provider: 'off', searxngUrl: '' });
      delete (/** @type {any} */ (globalThis)).localStorage;
      setAssistant(before.assistant);
      setWebSearch(before.web);
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

  it('leaves an answer that marks no statement with a result as it is, without a web check', () => {
    assert.equal(verifiedWebAnswer(answer('I do not know.'), pack), null);
    // Markers beyond the results count as no marker.
    assert.equal(verifiedWebAnswer(answer('Tides are caused mainly by the gravity of the Moon. [W7]'), pack), null);
  });

  it('leaves the check of an answer with pages of its own to all its citations together', () => {
    const own = { url: 'https://example.net/moon', title: 'Moon', citedText: 'The Moon pulls the oceans.', start: 0, end: 10 };
    const out = verifiedWebAnswer({ ...answer('Tides are caused mainly by the gravity of the Moon. [W1]'), citations: [own] }, pack);
    assert.ok(out);
    assert.doesNotMatch(out.text, /\[W\d\]/);
    assert.equal(out.webCheck, undefined, 'no count of the pack alone stands in for the check of its own pages');
    assert.deepEqual(out.citations.map((c) => c.url), ['https://example.net/moon', 'https://example.org/tides']);
  });
});

describe('the web pack of a question, kept for its later answers', () => {
  installChatTools();
  const question = 'How do tides work?';
  const turn = /** @type {import('../../src/js/chat/hooks.js').TurnContext} */ ({ ...ctx, conversationId: 'c-tides', question });
  /**
   * @param {string} provider
   * @param {string} text
   * @param {any[]} [citations]
   */
  const answer = (provider, text, citations = []) => /** @type {any} */ ({ text, reasoning: '', toolCalls: [], citations, images: [], opaque: [], usage: null, stopReason: 'end', model: 'm', provider, error: null });

  it('checks every answer that cites it and leaves the others to their own citations', async () => {
    const before = { assistant: getAssistant(), web: getWebSearch() };
    const kept = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (/** @type {string} */ k) => kept.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => void kept.set(k, String(v)), removeItem: (/** @type {string} */ k) => void kept.delete(k) },
    });
    writeSearchSettings({ provider: 'searxng', searxngUrl: 'https://search.example.org' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ title: 'Tide basics', url: 'https://example.com/tides', content: 'Tides are caused mainly by the Moon.' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const signal = new AbortController().signal;
    try {
      // The own server's model cannot search: the question gets a pack.
      setAssistant('local:fake-model');
      setWebSearch(true);
      const notes = [];
      for (const hook of turnNoteHooks) notes.push(...(await hook(turn)));
      assert.equal(notes.length, 1);
      const run = (/** @type {any} */ result) => single.tools?.({ result, request: async () => /** @type {any} */ ({}), ctx: turn, signal });
      // The thread's answer cites the pack: checked against it.
      const first = await run(answer('openai-compatible', 'Tides are caused mainly by the Moon. [W1]'));
      assert.deepEqual(first?.webCheck, { kind: 'checked', pages: 1, supported: 1, flagged: 0, total: 1 });
      // Written again from the same turn (Regenerate, a Compare column): the pack is still there.
      const again = await run(answer('openai-compatible', 'The Moon causes most of the tides. [W1]'));
      assert.equal(again?.webCheck?.total, 1);
      // An answer that cites nothing from it is left as it is: no check of nothing stands in.
      assert.equal(await run(answer('openai-compatible', 'Tides are a daily rise and fall of the sea.')), null);
      // A model that searched the web itself keeps its own citations, untouched.
      const own = [{ url: 'https://example.org/tides', title: 'Tides', citedText: 'Tides follow the Moon.', start: 0, end: 22 }];
      assert.equal(await run(answer('anthropic', 'Tides follow the Moon. The tide rises 900 meters every minute.', own)), null);
    } finally {
      globalThis.fetch = realFetch;
      writeSearchSettings({ provider: 'off', searxngUrl: '' });
      delete (/** @type {any} */ (globalThis)).localStorage;
      setAssistant(before.assistant);
      setWebSearch(before.web);
    }
  });
});
