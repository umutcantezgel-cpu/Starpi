// @ts-check
// Module `connectors`: tools of MCP servers on this machine for the chat. The owner names the
// servers in the configuration; the companion lists their tools, pins each description
// (pins.js) and offers a tool to a model only after the owner approved it with exactly the pin the
// server shows now. A server that changes a tool's description loses that tool until the owner
// approves the new description: the change is recorded in the audit chain and put in the inbox.
// Before every call the list is fetched again, so a change between two refreshes is caught too.
//   GET  /v1/connectors                              member  servers and their tools, pins and states
//   POST /v1/connectors/:server/refresh              owner   lists the server's tools again now
//   POST /v1/connectors/:server/approve              owner   { tool, pin, calls: 'ask' | 'allow' }
//   POST /v1/connectors/:server/revoke               owner   { tool }
//   GET  /v1/connectors/approvals                    member  calls waiting for a decision
//   POST /v1/connectors/approvals/:id                member  { decision: 'approve' | 'deny' }
// A tool approved with `calls: 'ask'` (the default) waits for a person at every call; `allow`
// runs without asking, except for calls a model writes after it saw a tool result in the same turn
// (outside data may steer it), which always wait. Arguments and results are never stored or logged;
// the audit chain records tool, outcome and how the call was approved.
// Configuration (`modules.connectors`):
//   { "servers": [{ "id": "files", "url": "http://127.0.0.1:8931/mcp", "title": "Local files",
//                   "resultClass": "personal", "maxClass": "personal" }],
//     "approvalSeconds": 60, "refreshMinutes": 5 }
// `maxClass`: the most protected class a conversation may have to send arguments to the server;
// `resultClass`: the class its results get (a turn that may use the server takes that class from
// its start, so every round goes to the same kind of model).
import { isRecord, NAME, text } from '../contracts/check.js';
import { classRank, isDataClass } from '../contracts/data-classes.js';
import { isoAt } from '../lib/clock.js';
import { codeOf, fail } from '../lib/errors.js';
import { actorOf, bodyOf, checkBody, intIn, moduleConfig, notFound } from '../setup/kit.js';
import { isLoopbackUrl } from '../setup/loopback.js';
import { createApprovals } from './approvals.js';
import { createMcpClient } from './client.js';
import { PIN, pinOf, pinState, readTool, TOOL_NAME } from './pins.js';

export const CONNECTORS_MODULE = 'connectors';
export const CONNECTORS_NAMESPACE = 'connectors';
export const MAX_SERVERS = 16;
export const MAX_TOOLS_PER_SERVER = 64;
const SERVER_ID = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * What the chat uses.
 * @typedef {object} ToolsService
 * @property {(dataClass: import('../contracts/data-classes.js').DataClass) => Array<{ name: string, description: string, inputSchema: unknown, resultClass: import('../contracts/data-classes.js').DataClass }>} offer
 * @property {(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal, tainted: boolean, onApproval?: (a: unknown) => void }) => Promise<{ text: string, isError: boolean }>} call
 */

/** @param {unknown} v */
function serversRule(v) {
  if (!Array.isArray(v) || v.length > MAX_SERVERS) return `a list of at most ${MAX_SERVERS} servers`;
  for (const [i, s] of v.entries()) {
    if (!isRecord(s)) return `[${i}] an object`;
    for (const k of Object.keys(s)) if (!['id', 'url', 'title', 'resultClass', 'maxClass'].includes(k)) return `[${i}] ${k} is not a member`;
    if (typeof s.id !== 'string' || !SERVER_ID.test(s.id)) return `[${i}] id: lower case, digits and -, 2 to 31 characters`;
    if (!isLoopbackUrl(s.url)) return `[${i}] url: http://127.0.0.1:<port>/<path> (servers on this machine only)`;
    if (s.title !== undefined && (typeof s.title !== 'string' || s.title.length > 80)) return `[${i}] title: at most 80 characters`;
    for (const k of ['resultClass', 'maxClass']) if (s[k] !== undefined && (!isDataClass(s[k]) || s[k] === 'secret')) return `[${i}] ${k}: public, personal or sensitive`;
  }
  return new Set(v.map((s) => s.id)).size === v.length ? null : 'server ids must be unique';
}

/**
 * @param {{ hub: import('../setup/hub.js').Hub }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createConnectorsModule({ hub }) {
  /** @type {any} */
  let ctx = null;
  /** @type {any} */
  let ns = null;
  let settings = { servers: /** @type {Array<Record<string, any>>} */ ([]), approvalSeconds: 60, refreshMinutes: 5 };
  /** @type {Map<string, { config: Record<string, any>, client: import('./client.js').McpClient, state: 'unknown' | 'up' | 'down', detail: string | null, tools: Map<string, { tool: import('./pins.js').ToolDescription, pin: string }>, refreshed: string | null, refreshing: Promise<void> | null }>} */
  const servers = new Map();
  /** @type {import('./approvals.js').Approvals | null} */
  let approvals = null;
  /** @type {Array<() => void>} */
  const undo = [];
  /** Changes already reported, so a change is reported once: server/tool -> pin. */
  const reported = new Map();

  /** @param {string} serverId @returns {Record<string, { pin: string, calls: 'ask' | 'allow', approved: string, by: string }>} */
  function approvedOf(serverId) {
    const value = ns?.getJson(`approved.${serverId}`);
    return isRecord(value) ? /** @type {any} */ (value) : {};
  }

  /** @param {string} serverId */
  function serverOf(serverId) {
    const s = servers.get(serverId);
    if (!s) throw notFound('connector_unknown', 'connector');
    return s;
  }

  /**
   * Lists a server's tools again and reports changed pins.
   * @param {string} serverId
   * @param {AbortSignal} [signal]
   */
  function refresh(serverId, signal) {
    const s = serverOf(serverId);
    s.refreshing ??= (async () => {
      try {
        const listed = await s.client.listTools({ signal });
        /** @type {Map<string, { tool: import('./pins.js').ToolDescription, pin: string }>} */
        const tools = new Map();
        for (const raw of listed.slice(0, MAX_TOOLS_PER_SERVER)) {
          const tool = readTool(raw);
          if (tool && !tools.has(tool.name)) tools.set(tool.name, { tool, pin: pinOf(tool) });
        }
        s.tools = tools;
        s.state = 'up';
        s.detail = null;
        const approved = approvedOf(serverId);
        for (const [name, entry] of Object.entries(approved)) {
          const state = pinState(tools.get(name)?.pin ?? null, entry.pin);
          const key = `${serverId}/${name}`;
          if (state === 'changed' && reported.get(key) !== tools.get(name)?.pin) {
            reported.set(key, /** @type {string} */ (tools.get(name)?.pin));
            ctx.audit.append({ kind: 'connectors.pin_changed', subject: key, details: { approved: entry.pin, now: tools.get(name)?.pin } });
            hub.get('notify')?.post({ kind: 'tool_changed', ref: serverId, title: `${serverId}.${name}`, dataClass: 'public' });
            ctx.log('warn', 'tool_pin_changed', { server: serverId, tool: name });
          }
        }
      } catch (err) {
        s.state = 'down';
        s.detail = codeOf(err);
        try {
          await s.client.close();
        } catch {
          // a session that cannot be closed is dropped anyway
        }
      } finally {
        s.refreshed = isoAt(ctx.clock.now());
        s.refreshing = null;
      }
    })();
    return s.refreshing;
  }

  /** @param {string} serverId */
  function view(serverId) {
    const s = serverOf(serverId);
    const approved = approvedOf(serverId);
    const names = new Set([...s.tools.keys(), ...Object.keys(approved)]);
    return {
      id: serverId,
      title: s.config.title ?? serverId,
      url: s.client.describe().url,
      state: s.state,
      detail: s.detail,
      refreshed: s.refreshed,
      resultClass: s.config.resultClass ?? 'personal',
      maxClass: s.config.maxClass ?? 'personal',
      tools: [...names].sort().map((name) => {
        const listed = s.tools.get(name) ?? null;
        const a = approved[name] ?? null;
        return { name, title: listed?.tool.title ?? '', description: listed?.tool.description ?? '', inputSchema: listed?.tool.inputSchema ?? null, annotations: listed?.tool.annotations ?? null, pin: listed?.pin ?? null, approvedPin: a?.pin ?? null, calls: a?.calls ?? null, state: pinState(listed?.pin ?? null, a?.pin ?? null) };
      }),
    };
  }

  /** @type {ToolsService} */
  const service = {
    offer(dataClass) {
      const out = [];
      for (const [serverId, s] of servers) {
        if (s.state !== 'up' || classRank(dataClass) > classRank(s.config.maxClass ?? 'personal')) continue;
        const approved = approvedOf(serverId);
        for (const [name, { tool, pin }] of s.tools) {
          if (approved[name]?.pin !== pin) continue;
          out.push({ name: `${serverId}.${name}`, description: tool.description || tool.title || name, inputSchema: tool.inputSchema, resultClass: s.config.resultClass ?? 'personal' });
        }
      }
      return out;
    },
    async call(name, args, { signal, tainted, onApproval }) {
      const cut = name.indexOf('.');
      const serverId = name.slice(0, cut);
      const toolName = name.slice(cut + 1);
      const s = servers.get(serverId);
      if (cut < 1 || !s || !TOOL_NAME.test(toolName)) throw fail('tool_unknown', 'no such connector tool', { status: 404 });
      /** @param {string} outcome @param {string} approval */
      const record = (outcome, approval) => ctx.audit.append({ kind: 'connectors.call', subject: `${serverId}/${toolName}`, details: { outcome, approval } });
      // The description may have changed since the last refresh: look again right before the call.
      await refresh(serverId, signal);
      const entry = approvedOf(serverId)[toolName];
      const listed = s.tools.get(toolName);
      if (!entry || !listed || entry.pin !== listed.pin) {
        record('pin_changed', 'none');
        throw fail('tool_pin_changed', 'the tool is not approved in the form the server describes it now', { status: 409 });
      }
      let approval = 'allow';
      if (entry.calls === 'ask' || tainted) {
        const decision = await /** @type {import('./approvals.js').Approvals} */ (approvals).ask({ server: serverId, tool: toolName, args, reason: tainted && entry.calls !== 'ask' ? 'after_result' : 'policy' }, { signal, onAsk: onApproval });
        if (decision.outcome !== 'approved') {
          record(decision.outcome, decision.outcome);
          throw fail(`tool_${decision.outcome}`, `the call was ${decision.outcome}`, { status: 409 });
        }
        approval = 'approved';
      }
      let result;
      try {
        result = await s.client.callTool(toolName, args, { signal });
      } catch (err) {
        record(codeOf(err), approval);
        throw err;
      }
      const parts = Array.isArray(result?.content) ? result.content : [];
      let textOut = parts.filter((/** @type {any} */ p) => p?.type === 'text' && typeof p.text === 'string').map((/** @type {any} */ p) => p.text).join('\n');
      if (!textOut && isRecord(result?.structuredContent)) textOut = JSON.stringify(result.structuredContent);
      const isError = result?.isError === true;
      record(isError ? 'tool_error' : 'ok', approval);
      return { text: textOut, isError };
    },
  };

  return {
    id: CONNECTORS_MODULE,
    version: '1.0.0',
    title: 'Connectors (MCP servers on this machine)',
    namespaces: [CONNECTORS_NAMESPACE],
    routes: [
      {
        method: 'GET',
        path: '/',
        access: 'member',
        handler: () => ({ body: { servers: [...servers.keys()].map(view) } }),
      },
      {
        method: 'GET',
        path: '/approvals',
        access: 'member',
        lane: 'status',
        handler: () => ({ body: { approvals: approvals?.list() ?? [] } }),
      },
      {
        method: 'POST',
        path: '/approvals/:id',
        access: 'member',
        lane: 'status',
        maxBody: 1024,
        handler(req) {
          const body = bodyOf(req);
          checkBody(body, { decision: (v) => (v === 'approve' || v === 'deny' ? null : 'approve or deny') }, ['decision']);
          if (!approvals?.decide(req.params.id, /** @type {'approve' | 'deny'} */ (body.decision), actorOf(req))) throw notFound('approval_unknown', 'waiting call');
          return { body: { decided: true, decision: body.decision } };
        },
      },
      {
        method: 'POST',
        path: '/:server/refresh',
        access: 'owner',
        async handler(req) {
          await refresh(serverOf(req.params.server).config.id, req.signal);
          return { body: { server: view(req.params.server) } };
        },
      },
      {
        method: 'POST',
        path: '/:server/approve',
        access: 'owner',
        maxBody: 2048,
        handler(req) {
          const body = bodyOf(req);
          checkBody(body, { tool: text(64), pin: (v) => (typeof v === 'string' && PIN.test(v) ? null : 'sha256:<64 hex>'), calls: (v) => (v === 'ask' || v === 'allow' ? null : 'ask or allow') }, ['tool', 'pin']);
          const s = serverOf(req.params.server);
          const listed = s.tools.get(/** @type {string} */ (body.tool));
          if (!listed) throw notFound('tool_unknown', 'tool of this server (refresh first)');
          if (listed.pin !== body.pin) throw fail('pin_mismatch', 'the server describes this tool differently now; look at the current description and approve its pin', { status: 409, details: { pin: listed.pin } });
          const approved = approvedOf(s.config.id);
          const calls = /** @type {'ask' | 'allow'} */ (body.calls ?? 'ask');
          approved[listed.tool.name] = { pin: listed.pin, calls, approved: isoAt(ctx.clock.now()), by: actorOf(req) };
          ns.putJson(`approved.${s.config.id}`, approved);
          reported.delete(`${s.config.id}/${listed.tool.name}`);
          ctx.audit.append({ kind: 'connectors.tool_approved', subject: `${s.config.id}/${listed.tool.name}`, actor: actorOf(req), details: { pin: listed.pin, calls } });
          return { body: { server: view(s.config.id) } };
        },
      },
      {
        method: 'POST',
        path: '/:server/revoke',
        access: 'owner',
        maxBody: 1024,
        handler(req) {
          const body = bodyOf(req);
          checkBody(body, { tool: text(64) }, ['tool']);
          const s = serverOf(req.params.server);
          const approved = approvedOf(s.config.id);
          const name = /** @type {string} */ (body.tool);
          if (!approved[name]) throw notFound('tool_unknown', 'approved tool');
          delete approved[name];
          ns.putJson(`approved.${s.config.id}`, approved);
          ctx.audit.append({ kind: 'connectors.tool_revoked', subject: `${s.config.id}/${name}`, actor: actorOf(req) });
          return { body: { server: view(s.config.id) } };
        },
      },
    ],
    start(context) {
      ctx = context;
      settings = moduleConfig(CONNECTORS_MODULE, ctx.config, { servers: serversRule, approvalSeconds: intIn(10, 600), refreshMinutes: intIn(1, 1440) }, settings);
      ns = ctx.vault.namespace(CONNECTORS_NAMESPACE);
      approvals = createApprovals({ clock: ctx.clock, timeoutMs: settings.approvalSeconds * 1000, onPending: (a) => hub.get('notify')?.post({ kind: 'tool_approval', ref: a.id, title: `${a.server}.${a.tool}`, dataClass: 'public' }) });
      for (const config of settings.servers) {
        if (!NAME.test(config.id)) continue;
        servers.set(config.id, { config, client: createMcpClient(config.url, { label: `connector ${config.id}` }), state: 'unknown', detail: null, tools: new Map(), refreshed: null, refreshing: null });
      }
      if (servers.size > 0) {
        // The first listing runs in the background, so a server that is down never delays the start.
        for (const id of servers.keys()) void ctx.scheduler.run('background', `connectors.refresh.${id}`, () => refresh(id)).catch(() => {});
        undo.push(ctx.scheduler.every('connectors.refresh', settings.refreshMinutes * 60_000, async () => {
          for (const id of servers.keys()) await refresh(id);
        }));
      }
      undo.push(hub.provide('tools', service));
    },
    async stop() {
      approvals?.cancelAll();
      for (const step of undo.splice(0).reverse()) step();
      await Promise.all([...servers.values()].map((s) => s.client.close()));
      servers.clear();
      ns = null;
    },
  };
}
