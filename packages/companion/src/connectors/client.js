// @ts-check
// An MCP client (revision 2025-06-18, Streamable HTTP) for servers on this machine: initialize,
// tools/list and tools/call, nothing else (no resources, prompts, sampling or elicitation). The
// address must be loopback (setup/loopback.js). Requests go out with node:http; a redirect is an
// error, an answer above RESPONSE_MAX is cut off with an error, and an event-stream answer is read
// until the response to the request arrives (the server's own messages on that stream are
// ignored). The session id a server hands out at initialize goes with every later request; when the
// server forgets it (404), the next use starts a new session. A tool call is never repeated by
// itself. Arguments and results only pass through memory.
import { request } from 'node:http';
import { fail } from '../lib/errors.js';
import { VERSION } from '../version.js';
import { parseLoopbackUrl } from '../setup/loopback.js';

export const CLIENT_PROTOCOL = '2025-06-18';
export const ACCEPTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26']);
export const RESPONSE_MAX = 1024 * 1024;
export const LIST_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 60_000;
export const MAX_LIST_PAGES = 8;

/**
 * @param {string} url  http://127.0.0.1:<port>/<path>
 * @param {{ label?: string }} [options]
 */
export function createMcpClient(url, { label = 'connector' } = {}) {
  const target = parseLoopbackUrl(url, `${label}.url`);
  const path = target.path || '/';
  /** @type {string | null} */
  let sessionId = null;
  /** @type {string | null} */
  let protocol = null;
  let nextId = 1;

  /**
   * One HTTP exchange.
   * @param {'POST' | 'DELETE'} method
   * @param {unknown} message
   * @param {{ signal?: AbortSignal, timeoutMs: number, expectId?: number }} options
   * @returns {Promise<{ status: number, message: any }>}
   */
  function exchange(method, message, { signal, timeoutMs, expectId }) {
    return new Promise((resolve, reject) => {
      const body = message === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(message), 'utf8');
      /** @type {Record<string, string | number>} */
      const headers = { accept: 'application/json, text/event-stream', 'content-length': body.length };
      if (message !== undefined) headers['content-type'] = 'application/json';
      if (sessionId) headers['mcp-session-id'] = sessionId;
      if (protocol) headers['mcp-protocol-version'] = protocol;
      const limit = AbortSignal.timeout(timeoutMs);
      const abort = signal ? AbortSignal.any([signal, limit]) : limit;
      const req = request({ host: target.host, port: target.port, method, path, headers, signal: abort }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(fail('connector_redirect', `${label} answered with a redirect, which is refused`, { status: 502 }));
          return;
        }
        const fresh = res.headers['mcp-session-id'];
        if (typeof fresh === 'string' && /^[\x21-\x7e]{1,256}$/.test(fresh)) sessionId = fresh;
        const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        let size = 0;
        let text = '';
        let settled = false;
        /** @param {any} msg */
        const done = (msg) => {
          if (settled) return;
          settled = true;
          resolve({ status, message: msg });
          res.destroy();
        };
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > RESPONSE_MAX) {
            settled = true;
            res.destroy();
            reject(fail('connector_too_large', `${label} sent more than ${RESPONSE_MAX} bytes`, { status: 502 }));
            return;
          }
          text += chunk;
          if (type !== 'text/event-stream') return;
          let cut;
          while ((cut = text.search(/\r?\n\r?\n/)) >= 0) {
            const block = text.slice(0, cut);
            text = text.slice(cut).replace(/^\r?\n\r?\n/, '');
            const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            try {
              const msg = JSON.parse(data);
              if (msg && msg.id === expectId && ('result' in msg || 'error' in msg)) done(msg);
            } catch {
              // a block that is not JSON is skipped
            }
          }
        });
        res.on('end', () => {
          if (settled) return;
          if (type === 'application/json' && text.trim() !== '') {
            try {
              done(JSON.parse(text));
            } catch {
              settled = true;
              reject(fail('connector_bad_answer', `${label} sent an answer that is not JSON`, { status: 502 }));
            }
            return;
          }
          done(null);
        });
        res.on('error', (err) => {
          if (!settled) reject(fail('connector_unreachable', `${label} broke off the answer`, { status: 502, cause: err }));
        });
      });
      req.on('error', (err) => {
        if (limit.aborted) reject(fail('connector_timeout', `${label} did not answer in time`, { status: 504, cause: err }));
        else if (signal?.aborted) reject(err);
        else reject(fail('connector_unreachable', `${label} could not be reached`, { status: 502, cause: err }));
      });
      req.end(body);
    });
  }

  /**
   * A request with its result, or an error with a code.
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   */
  async function call(method, params, { signal, timeoutMs = LIST_TIMEOUT_MS } = {}) {
    const id = nextId++;
    const { status, message } = await exchange('POST', { jsonrpc: '2.0', id, method, params }, { signal, timeoutMs, expectId: id });
    if (status === 404 && sessionId) {
      sessionId = null;
      protocol = null;
      throw fail('connector_session_ended', `${label} ended the session`, { status: 502 });
    }
    if (status !== 200 || !message) throw fail('connector_http', `${label} answered ${status}`, { status: 502 });
    if (message.error) throw fail('connector_error', `${label} refused ${method} (${Number(message.error.code) || 'error'})`, { status: 502, details: { rpcCode: message.error.code } });
    return message.result;
  }

  async function initialize({ signal } = /** @type {{ signal?: AbortSignal }} */ ({})) {
    sessionId = null;
    protocol = null;
    const result = await call('initialize', { protocolVersion: CLIENT_PROTOCOL, capabilities: {}, clientInfo: { name: 'starpi-companion', version: VERSION } }, { signal });
    const agreed = typeof result?.protocolVersion === 'string' ? result.protocolVersion : null;
    if (!agreed || !ACCEPTED_PROTOCOLS.includes(agreed)) throw fail('connector_protocol', `${label} speaks protocol ${String(agreed).slice(0, 20)}, not ${ACCEPTED_PROTOCOLS.join(' or ')}`, { status: 502 });
    protocol = agreed;
    const { status } = await exchange('POST', { jsonrpc: '2.0', method: 'notifications/initialized' }, { signal, timeoutMs: LIST_TIMEOUT_MS });
    if (status !== 202 && status !== 200) throw fail('connector_http', `${label} answered ${status} to the initialized notice`, { status: 502 });
    return { protocol: agreed, server: typeof result?.serverInfo?.name === 'string' ? result.serverInfo.name.slice(0, 80) : null };
  }

  /** @param {{ signal?: AbortSignal }} [options] */
  async function ensure(options = {}) {
    if (!protocol) await initialize(options);
  }

  return {
    initialize,
    /**
     * Every tool the server lists (following its cursors).
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<unknown[]>}
     */
    async listTools(options = {}) {
      await ensure(options);
      /** @type {unknown[]} */
      const tools = [];
      /** @type {string | undefined} */
      let cursor;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await call('tools/list', cursor ? { cursor } : {}, options);
        if (Array.isArray(result?.tools)) tools.push(...result.tools);
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor.length <= 1024 ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      return tools;
    },
    /**
     * Calls a tool once.
     * @param {string} name
     * @param {Record<string, unknown>} args
     * @param {{ signal?: AbortSignal }} [options]
     */
    async callTool(name, args, options = {}) {
      await ensure(options);
      return call('tools/call', { name, arguments: args }, { signal: options.signal, timeoutMs: CALL_TIMEOUT_MS });
    },
    /** Ends the session at the server (best effort). */
    async close() {
      if (!sessionId) return;
      try {
        await exchange('DELETE', undefined, { timeoutMs: 2000 });
      } catch {
        // the server may be gone already
      }
      sessionId = null;
      protocol = null;
    },
    describe: () => ({ url: target.url, session: sessionId !== null, protocol }),
  };
}

/** @typedef {ReturnType<typeof createMcpClient>} McpClient */
