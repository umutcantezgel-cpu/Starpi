// The chat's request hook for tools: which tools a request offers. Built-in groups follow their
// switches, memory waits for the memory feature, an MCP tool counts only while its approval stands,
// and a Gemini web turn keeps its own search without declared functions.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installChatTools, setMemoryLookup } from '../../src/js/chat/tools.js';
import { requestHooks } from '../../src/js/chat/hooks.js';

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

  it('offers the switched-on groups, and memory only once the memory feature answers it', () => {
    assert.deepEqual(offered({}), ['datetime', 'calculator']);
    const off = setMemoryLookup(async () => []);
    assert.deepEqual(offered({}), ['datetime', 'calculator', 'memory_lookup']);
    off();
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
});
