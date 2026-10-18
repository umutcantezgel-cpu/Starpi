// @ts-check
// Module `mcp`: an MCP server (revision 2025-06-18, Streamable HTTP, stateless, JSON answers) for
// desktop MCP clients on this machine, with the read-only tools of tools.js. A client reaches it
// through the stdio bridge (bin/mcp-stdio.mjs) with a token the owner made for it.
//   POST   /v1/mcp               MCP client token only: one JSON-RPC message per request
//   GET    /v1/mcp               405 (the server sends no messages of its own)
//   GET    /v1/mcp/clients       owner  the clients (never a token)
//   POST   /v1/mcp/clients       owner  { label, tools? } -> { client, token } (the token is shown once)
//   DELETE /v1/mcp/clients/:id   owner  revokes a client
// Bearer only: a request with a cookie, with a paired browser session or with an Origin header is
// refused, whatever else it carries, so no web page can reach the tools. Every tool call is a
// record in the audit chain (client, tool, outcome, number of items), never its arguments or result.
// Configuration (`modules.mcp`): { "maxClass": "personal", "callsPerMinute": 120 }.
import { text } from '../contracts/check.js';
import { codeOf, fail } from '../lib/errors.js';
import { VERSION } from '../version.js';
import { actorOf, bodyOf, checkBody, intIn, moduleConfig, notFound } from '../setup/kit.js';
import { CLIENTS_NAMESPACE, createClientStore, MAX_CLIENTS } from './clients.js';
import { argumentProblems, errorOf, negotiate, PROTOCOL_VERSIONS, readMessage, resultOf, RPC } from './jsonrpc.js';
import { describeTool, SERVER_TOOL_NAMES, SERVER_TOOLS } from './tools.js';

export const MCP_MODULE = 'mcp';
export const MCP_CLASSES = Object.freeze(['public', 'personal', 'sensitive']);
const INSTRUCTIONS = 'Read-only access to the documents, notes and agenda the user keeps in Starpi Core on this computer. Cite the document title and passage number when you use a passage.';

/** A JSON-RPC answer as bytes, so nothing is added to the message. @param {unknown} message */
const rpc = (message) => ({ raw: { type: 'application/json', data: Buffer.from(JSON.stringify(message), 'utf8') } });

/** @param {unknown} v */
const toolsRule = (v) => (Array.isArray(v) && v.length > 0 && new Set(v).size === v.length && v.every((t) => SERVER_TOOL_NAMES.includes(/** @type {string} */ (t))) ? null : `a list of ${SERVER_TOOL_NAMES.join(', ')}`);

/**
 * @param {{ hub: import('../setup/hub.js').Hub }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createMcpModule({ hub }) {
  /** @type {any} */
  let ctx = null;
  /** @type {import('./clients.js').ClientStore | null} */
  let clients = null;
  let settings = { maxClass: /** @type {import('../contracts/data-classes.js').DataClass} */ ('personal'), callsPerMinute: 120 };
  /** client id -> { window start, calls } */
  const windows = new Map();
  const live = () => {
    if (!clients) throw fail('module_stopped', 'the MCP server is not running', { status: 503 });
    return clients;
  };

  /** @param {string} clientId */
  function overLimit(clientId) {
    const now = ctx.clock.now();
    const w = windows.get(clientId);
    if (!w || now - w.start >= 60_000) {
      windows.set(clientId, { start: now, calls: 1 });
      return false;
    }
    w.calls += 1;
    return w.calls > settings.callsPerMinute;
  }

  /**
   * One tools/call.
   * @param {import('./clients.js').McpClient} client
   * @param {string | number} id
   * @param {Record<string, unknown>} params
   * @param {AbortSignal} signal
   */
  async function callTool(client, id, params, signal) {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = SERVER_TOOLS.find((t) => t.name === name);
    if (!tool || !client.tools.includes(tool.name)) return rpc(errorOf(id, RPC.badParams, `unknown tool ${name.slice(0, 64)}`));
    const args = /** @type {Record<string, unknown>} */ (params.arguments ?? {});
    const problems = argumentProblems(args, tool.inputSchema);
    if (problems.length > 0) return rpc(errorOf(id, RPC.badParams, problems.join('; ')));
    /** @param {string} outcome @param {number} items */
    const record = (outcome, items) => ctx.audit.append({ kind: 'mcp.call', subject: client.id, actor: `mcp:${client.id.slice(5, 13)}`, details: { tool: tool.name, outcome, items } });
    if (overLimit(client.id)) {
      record('rate_limited', 0);
      return rpc(resultOf(id, { content: [{ type: 'text', text: `Too many calls; at most ${settings.callsPerMinute} a minute.` }], isError: true }));
    }
    let out;
    try {
      out = await tool.run(args, { hub, maxClass: settings.maxClass, signal });
    } catch (err) {
      record(codeOf(err), 0);
      return rpc(resultOf(id, { content: [{ type: 'text', text: `The tool could not run (${codeOf(err)}).` }], isError: true }));
    }
    record('ok', out.items);
    live().used(client);
    return rpc(resultOf(id, { content: [{ type: 'text', text: out.text }], structuredContent: out.data, isError: false }));
  }

  return {
    id: MCP_MODULE,
    version: '1.0.0',
    title: 'MCP server (read-only)',
    namespaces: [CLIENTS_NAMESPACE],
    routes: [
      {
        method: 'POST',
        path: '/',
        access: 'public',
        maxBody: 64 * 1024,
        async handler(req) {
          const store = live();
          if (req.headers.cookie !== undefined || req.session?.kind === 'cookie') throw fail('bearer_only', 'the MCP endpoint takes an MCP client token, never a cookie', { status: 403 });
          if (req.headers.origin !== undefined) throw fail('origin_not_allowed', 'the MCP endpoint is for programs on this machine, not for web pages', { status: 403 });
          const token = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
          const client = token ? store.authenticate(token) : null;
          if (!client) return { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="starpi-companion-mcp"' }, body: { error: { code: 'mcp_token_invalid', message: 'an MCP client token is required' } } };
          const version = req.headers['mcp-protocol-version'];
          if (typeof version === 'string' && !PROTOCOL_VERSIONS.includes(version)) throw fail('mcp_version', `protocol version ${version.slice(0, 20)} is not supported`, { status: 400 });
          const msg = readMessage(req.body);
          if (msg.kind === 'invalid') return { status: 400, ...rpc(errorOf(msg.id, msg.code, msg.message)) };
          if (msg.kind === 'notification' || msg.kind === 'response') return { status: 202, raw: { type: 'application/json', data: Buffer.alloc(0) } };
          try {
            switch (msg.method) {
              case 'initialize':
                return rpc(resultOf(msg.id, { protocolVersion: negotiate(msg.params.protocolVersion), capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'starpi-companion', title: 'Starpi Core', version: VERSION }, instructions: INSTRUCTIONS }));
              case 'ping':
                return rpc(resultOf(msg.id, {}));
              case 'tools/list':
                return rpc(resultOf(msg.id, { tools: SERVER_TOOLS.filter((t) => client.tools.includes(t.name)).map(describeTool) }));
              case 'tools/call':
                return await callTool(client, msg.id, msg.params, req.signal);
              default:
                return rpc(errorOf(msg.id, RPC.unknownMethod, `method ${msg.method.slice(0, 64)} is not offered`));
            }
          } catch (err) {
            ctx.log('warn', 'mcp_failed', { code: codeOf(err) });
            return rpc(errorOf(msg.id, RPC.internal, 'internal error'));
          }
        },
      },
      {
        method: 'GET',
        path: '/',
        access: 'public',
        lane: 'status',
        handler: () => ({ status: 405, headers: { Allow: 'POST' }, body: { error: { code: 'method_not_allowed', message: 'the MCP server answers POST requests only' } } }),
      },
      {
        method: 'GET',
        path: '/clients',
        access: 'owner',
        handler: () => ({ body: { clients: live().list(), tools: SERVER_TOOL_NAMES, maxClass: settings.maxClass } }),
      },
      {
        method: 'POST',
        path: '/clients',
        access: 'owner',
        maxBody: 2048,
        handler(req) {
          const body = bodyOf(req);
          checkBody(body, { label: text(80), tools: toolsRule }, ['label']);
          if (live().count() >= MAX_CLIENTS) throw fail('mcp_clients_full', `at most ${MAX_CLIENTS} MCP clients`, { status: 409 });
          const made = live().create(/** @type {string} */ (body.label).trim(), /** @type {string[] | undefined} */ (body.tools) ?? [...SERVER_TOOL_NAMES]);
          ctx.audit.append({ kind: 'mcp.client_added', subject: made.client.id, actor: actorOf(req), details: { tools: made.client.tools } });
          return { status: 201, body: made };
        },
      },
      {
        method: 'DELETE',
        path: '/clients/:id',
        access: 'owner',
        handler(req) {
          if (!live().revoke(req.params.id)) throw notFound('mcp_client_unknown', 'MCP client');
          windows.delete(req.params.id);
          ctx.audit.append({ kind: 'mcp.client_revoked', subject: req.params.id, actor: actorOf(req) });
          return { body: { revoked: true } };
        },
      },
    ],
    start(context) {
      ctx = context;
      settings = moduleConfig(MCP_MODULE, ctx.config, { maxClass: (v) => (MCP_CLASSES.includes(/** @type {string} */ (v)) ? null : `one of ${MCP_CLASSES.join(', ')}`), callsPerMinute: intIn(1, 6000) }, settings);
      clients = createClientStore({ namespace: ctx.vault.namespace(CLIENTS_NAMESPACE), clock: ctx.clock });
    },
    stop() {
      clients = null;
      windows.clear();
    },
  };
}
