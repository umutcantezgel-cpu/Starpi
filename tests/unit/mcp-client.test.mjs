// The MCP client against the MCP fake (Streamable HTTP, protocol 2025-06-18): sessions, tools/list
// and tools/call in JSON and event-stream answers, bearer tokens, a forgotten session; pinned tool
// definitions, and a changed definition that needs a new approval before the tool is offered again;
// the server list with tokens in the key store; provider-side servers.
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createMcpFake } from '../../scripts/fakes/mcp.mjs';
import { anthropicAdapter, anthropicWireAdapter } from '../../src/js/ai/adapters/anthropic.js';
import { createOpenAiResponsesAdapter } from '../../src/js/ai/adapters/openai-responses.js';
import {
  addProviderMcp,
  createMcpBridge,
  createMcpClient,
  createServerStore,
  MCP_CONNECTOR_BETA,
  McpError,
  mcpEndpoint,
  publicEndpoint,
  registryName,
  toolOutput,
  withProviderMcp,
} from '../../src/js/ai/mcp/client.js';
import { approvePin, comparePins, readPins, revokePin, toolPin } from '../../src/js/ai/mcp/pin.js';
import { createApprovalGate, memoryApprovalStore } from '../../src/js/ai/tools/approval.js';
import { runToolLoop } from '../../src/js/ai/tools/loop.js';
import { createToolRegistry } from '../../src/js/ai/tools/registry.js';

/** @type {{ gapMs: number, variant?: string }} */
const fakeOptions = { gapMs: 0 };
const fake = createMcpFake(fakeOptions);
const locked = createMcpFake({ gapMs: 0, token: 'secret-token' });
let endpoint = '';
let lockedEndpoint = '';

before(async () => {
  endpoint = `${(await fake.listen(0)).url}/mcp`;
  lockedEndpoint = `${(await locked.listen(0)).url}/mcp`;
});
after(async () => {
  await fake.close();
  await locked.close();
});

/** A key store in memory. */
function memoryKeys() {
  /** @type {Map<string, string>} */
  const keys = new Map();
  return {
    keys,
    getKey: (/** @type {string} */ slot) => keys.get(slot) ?? '',
    setKey: async (/** @type {string} */ slot, /** @type {string} */ key) => void keys.set(slot, key),
    removeKey: async (/** @type {string} */ slot) => void keys.delete(slot),
  };
}

/** A server store over a plain object. */
function memoryServers(keys = memoryKeys()) {
  /** @type {Record<string, unknown>} */
  const data = {};
  let n = 0;
  const store = createServerStore({ read: (k, fallback) => data[k] ?? fallback, write: (k, v) => ((data[k] = structuredClone(v)), true), keys, newId: () => `srv${(n += 1)}` });
  return { store, keys, data };
}

describe('MCP client', () => {
  it('opens a session, lists the tools and calls one', async () => {
    const client = createMcpClient({ url: endpoint });
    const info = await client.connect();
    assert.equal(info.protocolVersion, '2025-06-18');
    assert.equal(info.name, 'fake-mcp');
    assert.equal(fake.sessions.size, 1);
    const tools = /** @type {any[]} */ (await client.listTools());
    assert.deepEqual(tools.map((t) => t.name), ['define_word', 'convert_units']);
    const out = await client.callTool('define_word', { word: 'latency' });
    assert.deepEqual(JSON.parse(out.content), { word: 'latency', definition: 'The delay between a request and its answer.' });
    const failed = await client.callTool('define_word', { word: 'zzz' });
    assert.equal(failed.isError, true);
    // Every request after initialize carried the session and the protocol version.
    const last = fake.requests.at(-1);
    assert.ok(last?.headers['mcp-session-id']);
    assert.equal(last?.headers['mcp-protocol-version'], '2025-06-18');
    assert.match(String(last?.headers.accept), /application\/json/);
    assert.match(String(last?.headers.accept), /text\/event-stream/);
    await client.close();
    assert.equal(fake.sessions.size, 0);
  });

  it('reads answers sent as an event stream', async () => {
    const client = createMcpClient({ url: `${endpoint}?sse=1` });
    const out = await client.callTool('convert_units', { value: 1, from: 'km', to: 'm' });
    assert.deepEqual(JSON.parse(out.content), { value: 1000, unit: 'm' });
    await client.close();
  });

  it('sends the bearer token and reports a refused one', async () => {
    await assert.rejects(createMcpClient({ url: lockedEndpoint, token: 'wrong' }).connect(), (/** @type {any} */ err) => err instanceof McpError && err.code === 'auth' && err.status === 401);
    const client = createMcpClient({ url: lockedEndpoint, token: 'secret-token' });
    assert.equal((await client.listTools()).length, 2);
    await client.close();
  });

  it('opens a new session when the server forgot the old one', async () => {
    const client = createMcpClient({ url: endpoint });
    await client.connect();
    fake.sessions.clear();
    const out = await client.callTool('define_word', { word: 'browser' });
    assert.match(out.content, /loads and shows web pages/);
    await client.close();
  });

  it('reports a server that cannot be reached, and refuses unsafe addresses', async () => {
    const client = createMcpClient({ url: 'http://127.0.0.1:9/mcp', fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await assert.rejects(client.connect(), (/** @type {any} */ err) => err.code === 'cors');
    await assert.rejects(createMcpClient({ url: 'http://example.com/mcp' }).connect(), (/** @type {any} */ err) => err.code === 'bad_url');
    assert.equal(mcpEndpoint('https://mcp.example.com/mcp'), 'https://mcp.example.com/mcp');
    assert.equal(mcpEndpoint('http://localhost:4616/mcp'), 'http://localhost:4616/mcp');
    assert.equal(mcpEndpoint('http://mcp.example.com/mcp'), null);
    assert.equal(mcpEndpoint('https://user:pw@mcp.example.com/'), null);
    assert.equal(mcpEndpoint('javascript:alert(1)'), null);
    assert.equal(publicEndpoint('https://mcp.example.com/mcp'), true);
    for (const bad of ['https://localhost/mcp', 'https://192.168.1.4/mcp', 'https://10.0.0.1/', 'https://printer.local/', 'http://mcp.example.com/', 'https://intranet/']) assert.equal(publicEndpoint(bad), false, bad);
  });

  it('turns tool results into text for the model', () => {
    assert.deepEqual(toolOutput({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'resource', resource: { text: 'r' } }] }), { content: 'a\n[image]\nr' });
    assert.deepEqual(toolOutput({ content: [], structuredContent: { n: 1 }, isError: true }), { content: '{"n":1}', isError: true });
    assert.deepEqual(toolOutput({}), { content: '(no content)' });
  });
});

describe('pinned tool definitions', () => {
  const tool = { name: 'define_word', description: 'Looks up a word.', inputSchema: { type: 'object', properties: { word: { type: 'string' } } }, annotations: { readOnlyHint: true, title: 'ignored' } };

  it('hash the definition canonically, including the hints', async () => {
    const pin = await toolPin(tool);
    assert.match(pin, /^sha256:[0-9a-f]{64}$/);
    assert.equal(await toolPin({ ...tool, inputSchema: { properties: { word: { type: 'string' } }, type: 'object' } }), pin);
    assert.equal(await toolPin({ ...tool, annotations: { readOnlyHint: true, title: 'other' } }), pin);
    assert.notEqual(await toolPin({ ...tool, description: 'Looks up a word and sends it elsewhere.' }), pin);
    assert.notEqual(await toolPin({ ...tool, annotations: { readOnlyHint: false } }), pin);
  });

  it('compare what a server lists with what the user approved', async () => {
    const pin = await toolPin(tool);
    let pins = approvePin({}, 'define_word', pin, () => new Date('2026-01-01T00:00:00Z'));
    pins = approvePin(pins, 'gone_tool', `sha256:${'c'.repeat(64)}`);
    const checks = await comparePins(pins, [tool, { name: 'other', inputSchema: { type: 'object' } }, { name: 'dup', inputSchema: {} }, { name: 'dup', inputSchema: {} }, { name: 'noschema' }]);
    assert.deepEqual(
      checks.map((c) => [c.name, c.status]),
      [
        ['define_word', 'approved'],
        ['other', 'new'],
        ['dup', 'invalid'],
        ['gone_tool', 'removed'],
        ['', 'invalid'],
      ],
    );
    const changed = await comparePins(pins, [{ ...tool, description: 'Changed.' }]);
    assert.equal(changed[0].status, 'changed');
    assert.deepEqual(Object.keys(revokePin(pins, 'gone_tool')), ['define_word']);
    assert.deepEqual(readPins({ ok: { hash: pin, approvedAt: 'x' }, bad: { hash: 'md5:1' }, worse: 3 }), { ok: { hash: pin, approvedAt: 'x' } });
    assert.throws(() => approvePin({}, 'x', 'nope'), /sha256/);
  });

  it('offer a tool only after approval, hold it back when the server changes it, and ask again', async () => {
    fakeOptions.variant = undefined;
    const { store } = memoryServers();
    const registry = createToolRegistry();
    const bridge = createMcpBridge({ store, registry });
    const server = await store.add({ name: 'Dictionary', url: endpoint });

    // Listed but not approved: nothing is offered.
    let sync = await bridge.sync();
    assert.equal(sync[0].status, 'ok');
    assert.deepEqual(sync[0].tools.map((t) => [t.name, t.status]), [
      ['define_word', 'new'],
      ['convert_units', 'new'],
    ]);
    assert.equal(registry.size, 0);

    // Approved: offered under a registry name, always asking first.
    const define = /** @type {import('../../src/js/ai/mcp/pin.js').PinCheck} */ (sync[0].tools.find((t) => t.name === 'define_word'));
    store.approve(server.id, 'define_word', /** @type {string} */ (define.hash));
    await bridge.sync();
    assert.deepEqual(registry.list().map((d) => [d.name, d.effect, d.origin]), [['mcp_Dictionary_define_word', 'read', 'mcp']]);
    const store2 = memoryApprovalStore();
    let asks = 0;
    const gate = createApprovalGate({ store: store2, ask: async () => (asks += 1, 'always') });
    let n = 0;
    /** @type {typeof import('../../src/js/ai/index.js').complete} */
    const complete = () => {
      n += 1;
      const res = n % 2 === 1
        ? { text: '', toolCalls: [{ id: `c${n}`, name: 'mcp_Dictionary_define_word', args: { word: 'protocol' }, argsText: '' }], stopReason: /** @type {const} */ ('tool_call') }
        : { text: 'A protocol is a set of rules.', toolCalls: [], stopReason: /** @type {const} */ ('end_turn') };
      return { events: (async function* () {})(), result: Promise.resolve({ reasoning: '', reasoningTokens: 0, citations: [], images: [], opaque: [], provider: 'openai', model: 'm', requestId: null, usage: null, error: null, ...res }), abort: () => {} };
    };
    const request = /** @type {import('../../src/js/ai/contract.js').AiRequest} */ ({ provider: 'openai', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'Define protocol' }] }], tools: registry.specs() });
    const first = await runToolLoop({ request, registry, gate, signal: new AbortController().signal, complete });
    assert.equal(first.calls[0].status, 'done');
    assert.equal(asks, 1);
    await runToolLoop({ request, registry, gate, signal: new AbortController().signal, complete });
    assert.equal(asks, 1, 'remembered for the approved definition');

    // The server changes the description: the tool is held back until the user approves it again.
    fakeOptions.variant = 'changed';
    sync = await bridge.sync();
    const changed = /** @type {import('../../src/js/ai/mcp/pin.js').PinCheck} */ (sync[0].tools.find((t) => t.name === 'define_word'));
    assert.equal(changed.status, 'changed');
    assert.equal(registry.size, 0);
    store.approve(server.id, 'define_word', /** @type {string} */ (changed.hash));
    await bridge.sync();
    assert.equal(registry.size, 1);
    // The remembered answer belonged to the old definition: the call asks again.
    await runToolLoop({ request, registry, gate, signal: new AbortController().signal, complete });
    assert.equal(asks, 2);
    fakeOptions.variant = undefined;
    await bridge.close();
  });

  it('report a server that cannot be reached without offering anything', async () => {
    const { store } = memoryServers();
    const registry = createToolRegistry();
    const bridge = createMcpBridge({ store, registry, connect: (o) => createMcpClient({ ...o, fetch: async () => Promise.reject(new TypeError('blocked')) }) });
    await store.add({ name: 'Blocked', url: 'https://mcp.example.com/mcp' });
    const sync = await bridge.sync();
    assert.deepEqual([sync[0].status, sync[0].error], ['error', 'cors']);
    assert.equal(registry.size, 0);
  });
});

describe('server list', () => {
  it('keeps tokens in key slots and frees them again', async () => {
    const { store, keys } = memoryServers();
    const a = await store.add({ name: 'A', url: endpoint, token: 'tok-a' });
    const b = await store.add({ name: 'B', url: endpoint, token: ' tok-b ' });
    const c = await store.add({ name: '<b>C</b>', url: endpoint });
    assert.deepEqual([a.slot, b.slot, c.slot], ['mcp1', 'mcp2', null]);
    assert.equal(c.name, 'bC/b');
    assert.equal(store.token(/** @type {any} */ (store.get(b.id))), 'tok-b');
    await store.remove(a.id);
    assert.equal(keys.keys.has('mcp1'), false);
    const d = await store.add({ name: 'D', url: endpoint, token: 'tok-d' });
    assert.equal(d.slot, 'mcp1');
    await assert.rejects(store.add({ url: 'ftp://x' }), McpError);
    await assert.rejects(store.add({ url: endpoint, mode: 'provider' }), McpError);
    store.setEnabled(d.id, false);
    assert.equal(store.get(d.id)?.enabled, false);
    store.setAllowed(d.id, ['ok_tool', 'bad tool']);
    assert.deepEqual(store.get(d.id)?.allowed, ['ok_tool']);
    assert.equal(store.providerSide(), false);
    store.setProviderSide(true);
    assert.equal(store.providerSide(), true);
    for (let i = store.list().length; i < 8; i += 1) await store.add({ url: endpoint });
    await assert.rejects(store.add({ url: endpoint }), /too_many/);
  });

  it('names registry tools uniquely within the contract pattern', () => {
    const taken = new Set(['calculator']);
    assert.equal(registryName('My Server!', 'look up', taken), 'mcp_My_Server_look_up');
    assert.equal(registryName('My Server!', 'look up', taken), 'mcp_My_Server_look_up_2');
    const long = registryName('s'.repeat(40), 't'.repeat(80), taken);
    assert.ok(long.length <= 64 && /^[A-Za-z0-9_-]+$/.test(long));
  });
});

describe('provider-side servers', () => {
  const servers = [
    { name: 'Docs Server', url: 'https://mcp.example.com/mcp', token: 'tok', allowed: ['search_docs', 'read_page'] },
    { name: 'Local', url: 'https://localhost/mcp', token: '', allowed: ['x'] },
    { name: 'Nothing allowed', url: 'https://other.example.com/mcp', token: '', allowed: [] },
  ];
  const req = /** @type {import('../../src/js/ai/contract.js').AiRequest} */ ({ provider: 'anthropic', model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] });

  it('attach public servers with their allowed tools to Anthropic calls (MCP connector beta)', () => {
    const adapter = /** @type {any} */ (withProviderMcp(anthropicWireAdapter, servers));
    const built = adapter.buildRequest(req);
    assert.deepEqual(built.body.mcp_servers, [{ type: 'url', url: 'https://mcp.example.com/mcp', name: 'Docs-Server', authorization_token: 'tok' }]);
    assert.deepEqual(built.body.tools.at(-1), { type: 'mcp_toolset', mcp_server_name: 'Docs-Server', default_config: { enabled: false }, configs: { search_docs: { enabled: true }, read_page: { enabled: true } } });
    assert.ok(built.headers['anthropic-beta'].split(',').includes(MCP_CONNECTOR_BETA));
    assert.equal(withProviderMcp(anthropicAdapter, servers), null, 'the SDK form cannot carry them');
  });

  it('attach them as the mcp tool of OpenAI Responses calls', () => {
    const adapter = /** @type {any} */ (withProviderMcp(createOpenAiResponsesAdapter(), servers));
    const built = adapter.buildRequest({ ...req, provider: 'openai', model: 'gpt-5' });
    assert.deepEqual(built.body.tools, [{ type: 'mcp', server_label: 'Docs-Server', server_url: 'https://mcp.example.com/mcp', allowed_tools: ['search_docs', 'read_page'], require_approval: 'never', headers: { Authorization: 'Bearer tok' } }]);
  });

  it('leave a request alone without a usable server or dialect', () => {
    const built = { path: '/v1/messages', body: { model: 'm' } };
    assert.equal(addProviderMcp(built, 'anthropic', [servers[1], servers[2]]), built);
    assert.equal(addProviderMcp(built, 'gemini', servers), built);
  });
});
