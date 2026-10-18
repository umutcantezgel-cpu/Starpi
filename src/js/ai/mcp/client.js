// @ts-check
// MCP client for the browser: the Streamable HTTP transport (protocol 2025-06-18) to servers that
// allow cross-origin calls, the servers the user added, and the bridge that offers their approved
// tools to the models.
//
// Transport: every JSON-RPC message is one POST to the server's endpoint with
// `Accept: application/json, text/event-stream`; the answer is JSON, or an event stream that carries
// it. initialize opens a session (Mcp-Session-Id), notifications/initialized follows, and every later
// request carries the session and MCP-Protocol-Version; DELETE ends the session. A server that sends
// no CORS headers cannot be reached from a page (the call fails before any answer: `cors`).
//
// Servers ({ id, name, url, mode, enabled, slot, pins, allowed }) live in localStorage. A bearer
// token, when the server needs one, lives in the key store like a provider key (slots mcp1…mcp8), so
// the key vault encrypts it. Tools are pinned (pin.js): only tools the user approved with their
// current pin are offered, a changed one waits for a new approval, and every call asks first
// (tools/approval.js).
//
// Provider-side servers: Anthropic's MCP connector (beta mcp-client-2025-11-20, `mcp_servers` with an
// `mcp_toolset` tool) and the OpenAI Responses `mcp` tool let the provider call a public server
// itself, for servers without CORS. That is behind a capability flag (off by default) and limited to
// the tool names the user allowed for the server; the provider then runs them without asking per call.
import { readLocalJson, writeLocalJson } from '../../storage.js';
import { MCP_SLOTS } from '../keys.js';
import { readSse, readText } from '../sse.js';
import { effectFromHints, isRecord } from '../tools/registry.js';
import { approvePin, comparePins, readPins, restatePins, revokePin } from './pin.js';

/** @typedef {import('../transport.js').FetchLike} FetchLike */
/** @typedef {import('../transport.js').BuiltRequest} BuiltRequest */
/** @typedef {import('../stream.js').Adapter} Adapter */
/** @typedef {import('../stream.js').WireAdapter} WireAdapter */
/** @typedef {import('../contract.js').ProviderId} ProviderId */
/** @typedef {import('../tools/registry.js').ToolDef} ToolDef */
/** @typedef {import('../tools/registry.js').ToolOutput} ToolOutput */
/** @typedef {import('../tools/registry.js').ToolRegistry} ToolRegistry */
/** @typedef {import('./pin.js').ServerPins} ServerPins */
/** @typedef {import('./pin.js').PinCheck} PinCheck */
/** @typedef {import('./pin.js').ListedTool} ListedTool */

export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26']);
export const MCP_CONNECTOR_BETA = 'mcp-client-2025-11-20';
export const MCP_SERVERS_KEY = 'starpi_mcp_servers_v1';
const CLIENT_INFO = Object.freeze({ name: 'starpi', title: 'Starpi', version: '3' });
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOOLS = 128;
const MAX_PAGES = 10;
export const MAX_SERVERS = MCP_SLOTS.length;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * cors: no answer at all (no CORS headers, or not reachable); auth: 401/403; session: the server
 * forgot the session; http: another failed status; protocol: an answer that is not JSON-RPC; rpc: a
 * JSON-RPC error; timeout; aborted.
 * @typedef {'cors' | 'auth' | 'session' | 'http' | 'protocol' | 'rpc' | 'timeout' | 'aborted' | 'bad_url'} McpErrorCode
 */

export class McpError extends Error {
  /**
   * @param {McpErrorCode} code
   * @param {{ status?: number, rpcCode?: number, cause?: unknown }} [info]
   */
  constructor(code, info = {}) {
    super(info.status ? `${code} (HTTP ${info.status})` : code, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'McpError';
    /** @type {McpErrorCode} */
    this.code = code;
    this.status = info.status ?? 0;
    this.rpcCode = info.rpcCode ?? null;
  }
}

/**
 * A server address the browser may call: https, or http on this machine only (a token never goes
 * to another host in the clear); no credentials or fragment. Null for anything else.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function mcpEndpoint(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === 'https:') return url.href;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname) ? url.href : null;
}

/**
 * Whether a provider can reach the address: https on a public host name (not this machine, not a
 * private network address).
 * @param {string} raw
 */
export function publicEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (LOOPBACK.has(host) || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') || !host.includes('.')) return false;
  if (/^(?:10|127)\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\.|^0\./.test(host)) return false;
  return !host.startsWith('[');
}

/**
 * @typedef {object} McpClientOptions
 * @property {string} url
 * @property {string | null} [token]
 * @property {FetchLike} [fetch]
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {object} ServerInfo
 * @property {string} name
 * @property {string} title
 * @property {string} version
 * @property {string} protocolVersion
 * @property {string} instructions   the server's own instructions (untrusted; shown, never sent to a model)
 */

/**
 * A client for one server. connect() runs initialize; listTools() and callTool() connect first when
 * needed and open a new session once when the server forgot the old one.
 * @param {McpClientOptions} opts
 */
export function createMcpClient(opts) {
  const endpoint = mcpEndpoint(opts.url);
  const fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  /** @type {string | null} */
  let session = null;
  let version = PROTOCOL_VERSION;
  let nextId = 1;
  /** @type {ServerInfo | null} */
  let info = null;
  /** @type {Promise<ServerInfo> | null} */
  let connecting = null;

  /**
   * @param {AbortSignal | undefined} signal
   */
  const timed = (signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) return timeout;
    const controller = new AbortController();
    const stop = (/** @type {AbortSignal} */ s) => controller.abort(s.reason);
    if (signal.aborted) stop(signal);
    signal.addEventListener('abort', () => stop(signal), { once: true });
    timeout.addEventListener('abort', () => stop(timeout), { once: true });
    return controller.signal;
  };

  /**
   * @param {'POST' | 'DELETE'} method
   * @param {unknown} body
   * @param {AbortSignal} signal
   * @param {boolean} initializing
   */
  const send = async (method, body, signal, initializing) => {
    if (!endpoint) throw new McpError('bad_url');
    const headers = new Headers({ accept: 'application/json, text/event-stream' });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
    if (session && !initializing) headers.set('mcp-session-id', session);
    if (!initializing) headers.set('mcp-protocol-version', version);
    try {
      return await fetchImpl(endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error', credentials: 'omit', mode: 'cors' });
    } catch (err) {
      const name = err && typeof err === 'object' ? /** @type {{ name?: unknown }} */ (err).name : '';
      if (signal.aborted) throw new McpError(name === 'TimeoutError' || /** @type {any} */ (signal.reason)?.name === 'TimeoutError' ? 'timeout' : 'aborted', { cause: err });
      throw new McpError('cors', { cause: err });
    }
  };

  /**
   * The JSON-RPC response with `id` in an answer (JSON or an event stream).
   * @param {Response} res
   * @param {number} id
   */
  const readResponse = async (res, id) => {
    const type = res.headers.get('content-type') ?? '';
    /** @param {unknown} msg */
    const matches = (msg) => isRecord(msg) && msg.jsonrpc === '2.0' && msg.id === id && ('result' in msg || 'error' in msg);
    if (/text\/event-stream/i.test(type)) {
      for await (const ev of readSse(res.body, { maxBytes: MAX_RESPONSE_BYTES })) {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (matches(msg)) return /** @type {Record<string, any>} */ (msg);
      }
      throw new McpError('protocol');
    }
    const text = await readText(res.body, { maxBytes: MAX_RESPONSE_BYTES });
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      throw new McpError('protocol', { cause: err });
    }
    if (Array.isArray(msg)) msg = msg.find(matches);
    if (!matches(msg)) throw new McpError('protocol');
    return /** @type {Record<string, any>} */ (msg);
  };

  /**
   * @param {Response} res
   */
  const failure = (res) => {
    void res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) return new McpError('auth', { status: res.status });
    if (res.status === 404 && session) return new McpError('session', { status: 404 });
    return new McpError('http', { status: res.status });
  };

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {AbortSignal | undefined} outer
   * @param {boolean} [initializing]
   */
  const request = async (method, params, outer, initializing = false) => {
    const signal = timed(outer);
    const id = nextId++;
    const res = await send('POST', { jsonrpc: '2.0', id, method, params }, signal, initializing);
    if (!res.ok) throw failure(res);
    const sid = res.headers.get('mcp-session-id');
    if (initializing && sid && /^[\x21-\x7e]{1,256}$/.test(sid)) session = sid;
    let msg;
    try {
      msg = await readResponse(res, id);
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw signal.aborted ? new McpError('timeout', { cause: err }) : new McpError('protocol', { cause: err });
    }
    if (msg.error) throw new McpError('rpc', { rpcCode: typeof msg.error.code === 'number' ? msg.error.code : 0 });
    return isRecord(msg.result) ? msg.result : {};
  };

  /**
   * @param {string} method
   * @param {AbortSignal | undefined} outer
   */
  const notify = async (method, outer) => {
    const res = await send('POST', { jsonrpc: '2.0', method }, timed(outer), false);
    void res.body?.cancel().catch(() => {});
    if (!res.ok && res.status !== 202) throw failure(res);
  };

  /** @param {AbortSignal} [signal] */
  const connect = (signal) => {
    connecting ??= (async () => {
      session = null;
      const result = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, signal, true);
      const offered = typeof result.protocolVersion === 'string' ? result.protocolVersion : '';
      if (!SUPPORTED_VERSIONS.has(offered)) throw new McpError('protocol');
      version = offered;
      await notify('notifications/initialized', signal);
      const server = isRecord(result.serverInfo) ? result.serverInfo : {};
      info = {
        name: typeof server.name === 'string' ? server.name.slice(0, 100) : '',
        title: typeof server.title === 'string' ? server.title.slice(0, 100) : '',
        version: typeof server.version === 'string' ? server.version.slice(0, 40) : '',
        protocolVersion: version,
        instructions: typeof result.instructions === 'string' ? result.instructions.slice(0, 2000) : '',
      };
      return info;
    })();
    const run = connecting;
    run.catch(() => {
      if (connecting === run) connecting = null;
    });
    return run;
  };

  /**
   * Runs a request in a session; a forgotten session is opened again once.
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {AbortSignal} [signal]
   */
  const inSession = async (method, params, signal) => {
    await connect(signal);
    try {
      return await request(method, params, signal);
    } catch (err) {
      if (!(err instanceof McpError) || err.code !== 'session') throw err;
      connecting = null;
      await connect(signal);
      return request(method, params, signal);
    }
  };

  return {
    connect,
    /** @returns {ServerInfo | null} */
    info: () => info,
    /**
     * The server's tools (every page, at most MAX_TOOLS).
     * @param {AbortSignal} [signal]
     * @returns {Promise<unknown[]>}
     */
    async listTools(signal) {
      /** @type {unknown[]} */
      const tools = [];
      /** @type {string | undefined} */
      let cursor;
      for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page += 1) {
        const result = await inSession('tools/list', cursor ? { cursor } : {}, signal);
        if (Array.isArray(result.tools)) tools.push(...result.tools);
        cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      return tools.slice(0, MAX_TOOLS);
    },
    /**
     * Calls a tool and returns its result as tool output for the model.
     * @param {string} name
     * @param {Record<string, unknown>} args
     * @param {AbortSignal} [signal]
     * @returns {Promise<ToolOutput>}
     */
    async callTool(name, args, signal) {
      return toolOutput(await inSession('tools/call', { name, arguments: args }, signal));
    },
    /** Ends the session (failures are ignored: the server forgets it anyway). */
    async close() {
      const had = session;
      connecting = null;
      if (!had) return;
      try {
        const res = await send('DELETE', undefined, timed(undefined), false);
        void res.body?.cancel().catch(() => {});
      } catch {
        // ignored
      }
      session = null;
    },
  };
}

/** @typedef {ReturnType<typeof createMcpClient>} McpClient */

/**
 * A tools/call result as tool output: its text items, the text of embedded text resources, its
 * structured content when there is no text, and a placeholder for anything else.
 * @param {Record<string, unknown>} result
 * @returns {ToolOutput}
 */
export function toolOutput(result) {
  /** @type {string[]} */
  const parts = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content.slice(0, 64)) {
    if (!isRecord(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'resource' && isRecord(item.resource) && typeof item.resource.text === 'string') parts.push(item.resource.text);
    else if (typeof item.type === 'string') parts.push(`[${item.type.slice(0, 20)}]`);
  }
  if (!parts.length && isRecord(result.structuredContent)) parts.push(JSON.stringify(result.structuredContent));
  return { content: parts.join('\n') || '(no content)', ...(result.isError === true ? { isError: true } : {}) };
}

// ---------------------------------------------------------------------------------------------
// The servers the user added
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} McpServer
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {'browser' | 'provider'} mode
 * @property {boolean} enabled
 * @property {string | null} slot     the key slot of its bearer token
 * @property {ServerPins} pins       browser mode: the approved tools and their pins
 * @property {string[]} allowed      provider mode: the tool names the provider may call
 */

/**
 * @typedef {object} ServerStoreDeps
 * @property {(key: string, fallback: unknown) => unknown} [read]
 * @property {(key: string, value: unknown) => boolean} [write]
 * @property {{ getKey(slot: string): string, setKey(slot: string, key: string, opts?: { remember?: boolean }): Promise<void>, removeKey(slot: string): Promise<void> }} [keys]
 * @property {() => string} [newId]
 */

/** @param {unknown} name */
const cleanName = (name) =>
  [...String(name ?? '')]
    .filter((ch) => ch >= ' ' && ch !== '<' && ch !== '>')
    .join('')
    .trim()
    .slice(0, 60);

/**
 * @param {unknown} raw
 * @returns {McpServer | null}
 */
function readServer(raw) {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !/^[a-z0-9]{1,16}$/.test(raw.id)) return null;
  const url = mcpEndpoint(raw.url);
  if (!url) return null;
  const mode = raw.mode === 'provider' ? 'provider' : 'browser';
  return {
    id: raw.id,
    name: cleanName(raw.name) || new URL(url).hostname,
    url,
    mode,
    enabled: raw.enabled !== false,
    slot: typeof raw.slot === 'string' && MCP_SLOTS.includes(raw.slot) ? raw.slot : null,
    pins: readPins(raw.pins),
    allowed: Array.isArray(raw.allowed) ? raw.allowed.filter((n) => typeof n === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(n)).slice(0, 64) : [],
  };
}

/**
 * The list of servers, with their tokens in the key store and the provider-side flag.
 * @param {ServerStoreDeps} [deps]
 */
export function createServerStore(deps = {}) {
  const read = deps.read ?? readLocalJson;
  const write = deps.write ?? writeLocalJson;
  const newId = deps.newId ?? (() => crypto.randomUUID().replace(/-/g, '').slice(0, 12));
  /** @type {Set<() => void>} */
  const listeners = new Set();

  const load = () => {
    const raw = /** @type {Record<string, unknown> | null} */ (read(MCP_SERVERS_KEY, null));
    const servers = (Array.isArray(raw?.servers) ? raw.servers : []).map(readServer).filter((s) => s !== null);
    return { providerSide: raw?.providerSide === true, servers: /** @type {McpServer[]} */ (servers).slice(0, MAX_SERVERS) };
  };
  /** @param {{ providerSide: boolean, servers: McpServer[] }} state */
  const save = (state) => {
    const ok = write(MCP_SERVERS_KEY, state);
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // a listener's failure must not stop the others
      }
    }
    return ok;
  };
  /**
   * @param {string} id
   * @param {(s: McpServer) => McpServer} change
   */
  const update = (id, change) => {
    const state = load();
    const i = state.servers.findIndex((s) => s.id === id);
    if (i < 0) return null;
    state.servers[i] = change(state.servers[i]);
    save(state);
    return state.servers[i];
  };

  return {
    list: () => load().servers,
    /** @param {string} id */
    get: (id) => load().servers.find((s) => s.id === id) ?? null,
    /** Whether servers may be attached provider-side (the capability flag). */
    providerSide: () => load().providerSide,
    /** @param {boolean} on */
    setProviderSide(on) {
      const state = load();
      state.providerSide = on === true;
      return save(state);
    },
    /**
     * Adds a server. Throws 'bad_url', 'too_many' or a key store error.
     * @param {{ name?: string, url: string, mode?: 'browser' | 'provider', token?: string, rememberToken?: boolean }} input
     * @returns {Promise<McpServer>}
     */
    async add(input) {
      const url = mcpEndpoint(input.url);
      if (!url) throw new McpError('bad_url');
      const mode = input.mode === 'provider' ? 'provider' : 'browser';
      if (mode === 'provider' && !publicEndpoint(url)) throw new McpError('bad_url');
      const state = load();
      if (state.servers.length >= MAX_SERVERS) throw new Error('too_many');
      const used = new Set(state.servers.map((s) => s.slot));
      /** @type {string | null} */
      let slot = null;
      if (input.token?.trim()) {
        slot = MCP_SLOTS.find((s) => !used.has(s)) ?? null;
        if (!slot || !deps.keys) throw new Error('too_many');
        await deps.keys.setKey(slot, input.token.trim(), { remember: input.rememberToken === true });
      }
      /** @type {McpServer} */
      const server = { id: newId(), name: cleanName(input.name) || new URL(url).hostname, url, mode, enabled: true, slot, pins: {}, allowed: [] };
      state.servers.push(server);
      save(state);
      return server;
    },
    /** @param {string} id */
    async remove(id) {
      const state = load();
      const server = state.servers.find((s) => s.id === id);
      if (!server) return;
      state.servers = state.servers.filter((s) => s.id !== id);
      save(state);
      if (server.slot && deps.keys) await deps.keys.removeKey(server.slot).catch(() => {});
    },
    /** @param {string} id @param {boolean} on */
    setEnabled: (id, on) => update(id, (s) => ({ ...s, enabled: on })),
    /** @param {string} id @param {string} name @param {string} hash */
    approve: (id, name, hash) => update(id, (s) => ({ ...s, pins: approvePin(s.pins, name, hash) })),
    /** @param {string} id @param {string} name */
    revoke: (id, name) => update(id, (s) => ({ ...s, pins: revokePin(s.pins, name) })),
    /** @param {string} id @param {string[]} names */
    setAllowed: (id, names) => update(id, (s) => ({ ...s, allowed: names.filter((n) => /^[A-Za-z0-9_.-]{1,128}$/.test(n)).slice(0, 64) })),
    /** @param {McpServer} server */
    token: (server) => (server.slot && deps.keys ? deps.keys.getKey(server.slot) : ''),
    /** @param {() => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createServerStore>} ServerStore */

// ---------------------------------------------------------------------------------------------
// The bridge: approved tools of browser-mode servers in the tool registry
// ---------------------------------------------------------------------------------------------

/**
 * The name a server's tool goes by in the registry: mcp_<server>_<tool>, letters, digits, _ and -
 * only, at most 64 characters, unique among `taken`.
 * @param {string} server
 * @param {string} tool
 * @param {Set<string>} taken
 */
export function registryName(server, tool, taken) {
  const part = (/** @type {string} */ s, /** @type {number} */ n) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, n) || 'x';
  const base = `mcp_${part(server, 16)}_${part(tool, 40)}`.slice(0, 64);
  let name = base;
  for (let i = 2; taken.has(name); i += 1) name = `${base.slice(0, 60)}_${i}`;
  taken.add(name);
  return name;
}

/**
 * @typedef {object} ServerSync
 * @property {McpServer} server
 * @property {'ok' | 'error' | 'off'} status
 * @property {McpErrorCode | null} error
 * @property {PinCheck[]} tools
 * @property {ServerInfo | null} info
 */

/**
 * Keeps the registry in step with the servers: connects to each enabled browser-mode server, pins
 * its tools and registers the approved ones (calls ask first, approval.js). sync() runs again after
 * a change; the result lists every server's tools with their pin status for the settings view.
 *
 * Syncs may overlap (a check, then a withdrawal while the check still waits for a server). Only the
 * newest one changes the registry and the last result, whichever finishes first. Between a change
 * and its sync, approved() and last() read the pins as stored now, so a withdrawn tool is neither
 * offered nor shown as approved.
 * @param {{ store: ServerStore, registry: ToolRegistry, connect?: (opts: McpClientOptions) => McpClient }} deps
 */
export function createMcpBridge(deps) {
  const connect = deps.connect ?? createMcpClient;
  /** @type {Map<string, { url: string, token: string, client: McpClient }>} */
  const clients = new Map();
  /** @type {Array<() => void>} */
  let registered = [];
  /** @type {ServerSync[]} */
  let last = [];
  /** Counts the syncs started; a sync that a later one overtook applies nothing. */
  let generation = 0;

  /** @param {McpServer} server */
  const clientFor = (server) => {
    const token = deps.store.token(server);
    const known = clients.get(server.id);
    if (known && known.url === server.url && known.token === token) return known.client;
    void known?.client.close();
    const client = connect({ url: server.url, token: token || null });
    clients.set(server.id, { url: server.url, token, client });
    return client;
  };

  return {
    /**
     * @param {AbortSignal} [signal]
     * @returns {Promise<ServerSync[]>}
     */
    async sync(signal) {
      const mine = (generation += 1);
      const servers = deps.store.list();
      /** @type {ServerSync[]} */
      const results = [];
      /** @type {ToolDef[]} */
      const defs = [];
      const taken = new Set(deps.registry.list().filter((d) => d.origin !== 'mcp').map((d) => d.name));
      for (const server of servers) {
        if (!server.enabled || server.mode !== 'browser') {
          results.push({ server, status: 'off', error: null, tools: [], info: null });
          continue;
        }
        const client = clientFor(server);
        try {
          const info = await client.connect(signal);
          const checks = await comparePins(server.pins, await client.listTools(signal));
          results.push({ server, status: 'ok', error: null, tools: checks, info });
          for (const check of checks) {
            if (check.status !== 'approved' || !check.tool || !check.hash) continue;
            const tool = check.tool;
            defs.push({
              name: registryName(server.name, tool.name, taken),
              origin: 'mcp',
              effect: effectFromHints(tool.annotations),
              description: `[${server.name}] ${typeof tool.description === 'string' ? tool.description : tool.name}`,
              schema: tool.inputSchema,
              server: { id: server.id, name: server.name, tool: tool.name, hash: check.hash },
              run: (args, ctx) => client.callTool(tool.name, args, ctx.signal),
            });
          }
        } catch (err) {
          clients.delete(server.id);
          results.push({ server, status: 'error', error: err instanceof McpError ? err.code : 'protocol', tools: [], info: null });
        }
      }
      // A later sync started meanwhile: its view of the store is newer than this one's.
      if (mine !== generation) return results;
      for (const off of registered) off();
      registered = [];
      for (const def of defs) {
        try {
          registered.push(deps.registry.register(def));
        } catch {
          // a name taken meanwhile: the tool is offered after the next sync
        }
      }
      last = results;
      return results;
    },
    /** The result of the last sync, with each tool's pin status as the store holds it now. */
    last: () =>
      last.map((entry) => {
        const server = deps.store.get(entry.server.id);
        return server && entry.status === 'ok' ? { ...entry, server, tools: restatePins(server.pins, entry.tools) } : entry;
      }),
    /**
     * Whether a registered MCP tool is still approved now: its server is stored, on and in browser
     * mode, and holds the pin the tool was registered with.
     * @param {ToolDef} def
     */
    approved(def) {
      if (!def.server) return false;
      const server = deps.store.get(def.server.id);
      if (!server || !server.enabled || server.mode !== 'browser') return false;
      const pin = Object.hasOwn(server.pins, def.server.tool) ? server.pins[def.server.tool] : null;
      return pin !== null && pin.hash === def.server.hash;
    },
    /** Closes every session. */
    async close() {
      for (const off of registered) off();
      registered = [];
      await Promise.all([...clients.values()].map((c) => c.client.close()));
      clients.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Provider-side servers
// ---------------------------------------------------------------------------------------------

/** Providers whose API can call an MCP server itself, and the dialect that carries it. */
export const PROVIDER_MCP = Object.freeze(/** @type {Partial<Record<ProviderId, { dialect: string }>>} */ ({ anthropic: { dialect: 'anthropic' }, openai: { dialect: 'openai-responses' } }));

/** @typedef {{ name: string, url: string, token: string, allowed: string[] }} ProviderMcpServer */

/**
 * A server's name as a provider label: letters, digits, _ and - only.
 * @param {string} name
 * @param {number} i
 */
const label = (name, i) => (name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'server') + (i ? `-${i + 1}` : '');

/**
 * A built request with provider-side MCP servers added (Anthropic MCP connector, OpenAI Responses
 * `mcp` tool). Each server offers only its allowed tools.
 * @param {BuiltRequest} built
 * @param {string} dialect
 * @param {readonly ProviderMcpServer[]} servers
 * @returns {BuiltRequest}
 */
export function addProviderMcp(built, dialect, servers) {
  const usable = servers.filter((s) => publicEndpoint(s.url) && s.allowed.length);
  if (!usable.length || !isRecord(built.body)) return built;
  const body = /** @type {Record<string, any>} */ ({ ...built.body });
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  const headers = { ...(built.headers ?? {}) };
  if (dialect === 'anthropic') {
    body.mcp_servers = usable.map((s, i) => ({ type: 'url', url: s.url, name: label(s.name, i), ...(s.token ? { authorization_token: s.token } : {}) }));
    for (const [i, s] of usable.entries()) {
      tools.push({ type: 'mcp_toolset', mcp_server_name: label(s.name, i), default_config: { enabled: false }, configs: Object.fromEntries(s.allowed.map((n) => [n, { enabled: true }])) });
    }
    const betas = (headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter(Boolean);
    if (!betas.includes(MCP_CONNECTOR_BETA)) betas.push(MCP_CONNECTOR_BETA);
    headers['anthropic-beta'] = betas.join(',');
  } else if (dialect === 'openai-responses') {
    for (const [i, s] of usable.entries()) {
      tools.push({ type: 'mcp', server_label: label(s.name, i), server_url: s.url, allowed_tools: [...s.allowed], require_approval: 'never', ...(s.token ? { headers: { Authorization: `Bearer ${s.token}` } } : {}) });
    }
  } else return built;
  body.tools = tools;
  return { ...built, headers, body };
}

/**
 * The wire adapter of a call with provider-side servers; null when the adapter cannot carry them.
 * @param {Adapter} base  a wire adapter (Anthropic's wire form, OpenAI Responses)
 * @param {readonly ProviderMcpServer[]} servers
 * @returns {WireAdapter | null}
 */
export function withProviderMcp(base, servers) {
  if (base.kind !== 'wire' || (base.dialect !== 'anthropic' && base.dialect !== 'openai-responses')) return null;
  return { ...base, buildRequest: (req) => addProviderMcp(base.buildRequest(req), base.dialect, servers) };
}
