// Settings → Tools and connections, rendered in a DOM: an MCP tool shows all the user approves (its
// whole description, the class its hints give it, its input schema with the argument notes), and
// the tools the user chose "Always allow" for are listed to forget again, one by one or all.
/* global document */
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/ai/mcp/view.js')} */
let view;
/** @type {typeof import('../../src/js/ai/mcp/client.js')} */
let client;
/** @type {typeof import('../../src/js/ai/mcp/pin.js')} */
let pin;
/** @type {typeof import('../../src/js/ai/tools/approval.js')} */
let approval;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;
/** @type {JSDOM} */
let jsdom;
const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'SVGElement', 'NodeFilter', 'Text', 'localStorage', 'sessionStorage'];

before(async () => {
  jsdom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example/' });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  view = await import('../../src/js/ai/mcp/view.js');
  client = await import('../../src/js/ai/mcp/client.js');
  pin = await import('../../src/js/ai/mcp/pin.js');
  approval = await import('../../src/js/ai/tools/approval.js');
});

after(() => {
  for (const key of GLOBALS) delete (/** @type {any} */ (globalThis))[key];
});

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe('tools settings view', () => {
  it('shows the whole definition of an MCP tool and lists "Always allow" choices to forget', async () => {
    /** @type {Record<string, unknown>} */
    const data = {};
    const servers = client.createServerStore({ read: (k, fallback) => data[k] ?? fallback, write: (k, v) => ((data[k] = structuredClone(v)), true), newId: () => 'srv1' });
    const server = await servers.add({ name: 'Files', url: 'https://mcp.example.com/mcp' });
    const tool = {
      name: 'delete_file',
      description: `${'Deletes one file. '.repeat(30)}TAIL-OF-THE-DESCRIPTION`,
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'NOTE-ON-THE-ARGUMENT' } }, required: ['path'] },
      annotations: { destructiveHint: true },
    };
    const other = { name: 'delete', description: 'Short.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };
    const checks = await pin.comparePins({}, [tool, other]);
    const gate = approval.createApprovalGate({ store: approval.memoryApprovalStore() });
    gate.store.set('tool:calculator', {});
    gate.store.set(approval.mcpApprovalKey(server.id, 'delete'), { hash: `sha256:${'a'.repeat(64)}` });
    gate.store.set(approval.mcpApprovalKey(server.id, 'delete_file'), { hash: `sha256:${'b'.repeat(64)}` });
    /** @type {Array<() => void>} */
    const listeners = [];
    const runtime = /** @type {any} */ ({
      switches: () => ({ datetime: true, calculator: true, workspace_search: false, memory_lookup: true, web_search: false, generate_image: false }),
      setSwitches: () => {},
      servers,
      gate,
      bridge: { last: () => [{ server: servers.get(server.id), status: 'ok', error: null, tools: pin.restatePins(servers.get(server.id)?.pins ?? {}, checks), info: null }] },
      onChange: (/** @type {() => void} */ fn) => void listeners.push(fn),
      syncServers: async () => [],
    });
    const host = document.createElement('div');
    document.body.append(host);
    view.mountToolsView(host, { onAction: dom.onAction, onChange: dom.onChange }, { runtime, keys: { getKey: () => '', setKey: async () => {}, removeKey: async () => {}, keyLocation: () => null }, testSearch: async () => [] });

    const row = /** @type {HTMLElement} */ (host.querySelector('[data-mcp-tool="delete_file"]'));
    // Past the first few hundred characters too, and the schema with its argument notes.
    assert.match(row.querySelector('[data-mcp-desc]')?.textContent ?? '', /TAIL-OF-THE-DESCRIPTION$/);
    assert.match(row.querySelector('[data-mcp-schema]')?.textContent ?? '', /NOTE-ON-THE-ARGUMENT/);
    assert.ok(row.querySelector('[data-mcp-effect="high"]'));
    assert.ok(host.querySelector('[data-mcp-tool="delete"] [data-mcp-effect="read"]'));

    // Three remembered choices; approving "delete" forgets that one only (not "delete_file").
    const remembered = () => [...host.querySelectorAll('[data-remembered]')].map((el) => /** @type {HTMLElement} */ (el).dataset.remembered);
    assert.equal(remembered().length, 3);
    assert.equal(host.querySelector('[data-remembered="tool:calculator"] [data-i18n]')?.getAttribute('data-i18n'), 'tools.builtin.calculator');
    assert.match(host.querySelector('[data-remembered="mcp:srv1:delete_file"] [data-i18n]')?.getAttribute('data-i18n-params') ?? '', /"server":"Files"/);
    /** @type {HTMLElement} */ (host.querySelector('[data-mcp-tool="delete"] [data-action="mcp-approve"]')).click();
    await settle();
    assert.equal(gate.store.get('mcp:srv1:delete'), null);
    assert.ok(gate.store.get('mcp:srv1:delete_file'));
    for (const fn of listeners) fn();
    assert.deepEqual(remembered().sort(), ['mcp:srv1:delete_file', 'tool:calculator']);

    // Forget one, then all.
    /** @type {HTMLElement} */ (host.querySelector('[data-remembered="tool:calculator"] [data-action="tools-forget-approval"]')).click();
    await settle();
    assert.deepEqual(remembered(), ['mcp:srv1:delete_file']);
    /** @type {HTMLElement} */ (host.querySelector('[data-action="tools-forget-approvals"]')).click();
    await settle();
    assert.deepEqual(remembered(), []);
    assert.deepEqual(gate.remembered(), []);
    assert.equal(host.querySelector('[data-ts="remembered"] [data-i18n]')?.getAttribute('data-i18n'), 'tools.settings.remembered_empty');
    host.remove();
  });
});
