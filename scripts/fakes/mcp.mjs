#!/usr/bin/env node
// Fake MCP server on 127.0.0.1 speaking the Streamable HTTP transport, protocol 2025-06-18:
// one endpoint (/mcp) that takes JSON-RPC messages by POST and answers with application/json, or
// with a one-event text/event-stream when ?sse=1 or --sse is set. initialize opens a session
// (Mcp-Session-Id header), later requests must carry it, DELETE ends it, GET answers 405 (no
// server-initiated stream). Browser calls get CORS headers when their Origin is a loopback origin
// (or one passed with --origin); other origins are refused with 403, as the transport requires.
//
// Two read-only tools: define_word and convert_units. ?variant=changed (or --variant changed)
// serves a changed description of define_word, for tests of pinned tool definitions. With --token
// every request needs `Authorization: Bearer <token>`. Faults: see shared.mjs.
//
// Usage: node scripts/fakes/mcp.mjs [--port 4616] [--sse] [--token secret] [--origin https://app.example]
import { randomUUID } from 'node:crypto';
import { createFakeServer, isMain, runStandalone } from './shared.mjs';

export const DEFAULT_PORT = 4616;
export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26']);
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

const GLOSSARY = /** @type {Record<string, string>} */ ({
  algorithm: 'A finite sequence of steps that solves a problem.',
  browser: 'A program that loads and shows web pages.',
  latency: 'The delay between a request and its answer.',
  protocol: 'A set of rules two programs follow to exchange messages.',
});

/** Conversions to a base unit per dimension. */
const UNITS = /** @type {Record<string, { dim: string, toBase: (v: number) => number, fromBase: (v: number) => number }>} */ ({
  m: { dim: 'length', toBase: (v) => v, fromBase: (v) => v },
  km: { dim: 'length', toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  ft: { dim: 'length', toBase: (v) => v * 0.3048, fromBase: (v) => v / 0.3048 },
  mi: { dim: 'length', toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
  kg: { dim: 'mass', toBase: (v) => v, fromBase: (v) => v },
  lb: { dim: 'mass', toBase: (v) => v * 0.45359237, fromBase: (v) => v / 0.45359237 },
  c: { dim: 'temperature', toBase: (v) => v, fromBase: (v) => v },
  f: { dim: 'temperature', toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32 },
});

/**
 * The tool list; `changed` alters one description.
 * @param {boolean} changed
 */
export function toolDefinitions(changed = false) {
  return [
    {
      name: 'define_word',
      title: 'Define a word',
      description: changed ? 'Looks up a short definition of an English word and lists related words.' : 'Looks up a short definition of an English word.',
      inputSchema: { type: 'object', properties: { word: { type: 'string', description: 'The word to define' } }, required: ['word'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { word: { type: 'string' }, definition: { type: 'string' } }, required: ['word', 'definition'] },
      annotations: { title: 'Define a word', readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'convert_units',
      title: 'Convert units',
      description: 'Converts a value between units of length (m, km, ft, mi), mass (kg, lb) or temperature (c, f).',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number' }, from: { type: 'string', enum: Object.keys(UNITS) }, to: { type: 'string', enum: Object.keys(UNITS) } },
        required: ['value', 'from', 'to'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', properties: { value: { type: 'number' }, unit: { type: 'string' } }, required: ['value', 'unit'] },
      annotations: { title: 'Convert units', readOnlyHint: true, openWorldHint: false },
    },
  ];
}

/**
 * @param {string} name
 * @param {any} args
 * @returns {{ content: Array<{ type: 'text', text: string }>, structuredContent?: Record<string, unknown>, isError: boolean } | null} null for an unknown tool
 */
export function callTool(name, args) {
  /** @param {string} text */
  const failed = (text) => ({ content: [{ type: /** @type {const} */ ('text'), text }], isError: true });
  if (name === 'define_word') {
    const word = typeof args?.word === 'string' ? args.word.trim().toLowerCase() : '';
    if (!word) return failed('word is required.');
    const definition = GLOSSARY[word];
    if (!definition) return failed(`No definition found for "${word.slice(0, 40)}".`);
    const structuredContent = { word, definition };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
  }
  if (name === 'convert_units') {
    const from = UNITS[String(args?.from ?? '').toLowerCase()];
    const to = UNITS[String(args?.to ?? '').toLowerCase()];
    if (typeof args?.value !== 'number' || !Number.isFinite(args.value) || !from || !to) return failed('value, from and to are required.');
    if (from.dim !== to.dim) return failed('The units measure different things.');
    const value = Math.round(to.fromBase(from.toBase(args.value)) * 1e6) / 1e6;
    const structuredContent = { value, unit: String(args.to).toLowerCase() };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
  }
  return null;
}

/**
 * Creates the fake (not yet listening).
 * @param {{ endpoint?: string, sse?: boolean, token?: string, origins?: string[], variant?: string, gapMs?: number, latencyMs?: number, cors?: boolean, log?: (line: string) => void }} [options]
 */
export function createMcpFake(options = {}) {
  const endpoint = options.endpoint ?? '/mcp';
  const token = options.token ?? null;
  const origins = new Set(options.origins ?? []);
  /** @type {Set<string>} */
  const sessions = new Set();
  /** @param {unknown} origin */
  const originAllowed = (origin) => typeof origin !== 'string' || LOOPBACK_ORIGIN.test(origin) || origins.has(origin);

  const fake = createFakeServer(
    {
      name: 'mcp',
      cors: (req) => originAllowed(req.headers.origin),
      auth: ({ req }) => (!token || req.headers.authorization === `Bearer ${token}` ? 'ok' : 'missing'),
      errorBody: (status, kind) => ({ jsonrpc: '2.0', id: null, error: { code: status === 401 ? -32001 : -32603, message: `Simulated ${kind} error.` } }),
      async handle(ctx) {
        if (ctx.path !== endpoint) return false;
        if (!originAllowed(ctx.req.headers.origin)) return ctx.send(403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed' } });
        const method = ctx.req.method;
        const sessionId = ctx.req.headers['mcp-session-id'];
        if (method === 'GET') return ctx.send(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'This server offers no event stream' } }, { allow: 'POST, DELETE' });
        if (method === 'DELETE') {
          if (typeof sessionId !== 'string' || !sessions.delete(sessionId)) return ctx.send(404, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unknown session' } });
          ctx.res.writeHead(204, ctx.cors).end();
          return;
        }
        if (method !== 'POST') return false;
        const accept = String(ctx.req.headers.accept ?? '');
        if (!/application\/json/.test(accept) || !/text\/event-stream/.test(accept)) {
          return ctx.send(406, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Accept must list application/json and text/event-stream' } });
        }
        const msg = ctx.json;
        if (msg === undefined) return ctx.send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        if (Array.isArray(msg) || !msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
          return ctx.send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request (one JSON-RPC message per POST)' } });
        }
        const isRequest = typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
        if (msg.method !== 'initialize') {
          if (typeof sessionId !== 'string') return ctx.send(400, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'Mcp-Session-Id header required' } });
          if (!sessions.has(sessionId)) return ctx.send(404, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'Unknown session' } });
          const version = ctx.req.headers['mcp-protocol-version'];
          if (version !== undefined && !SUPPORTED_VERSIONS.has(String(version))) return ctx.send(400, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'Unsupported protocol version' } });
        }
        if (!isRequest) {
          // Notifications and responses are accepted without a body.
          ctx.res.writeHead(202, ctx.cors).end();
          return;
        }
        /** @type {Record<string, string>} */
        const headers = {};
        /** @type {unknown} */
        let result;
        /** @type {{ code: number, message: string } | null} */
        let error = null;
        const changed = (ctx.url.searchParams.get('variant') ?? options.variant) === 'changed';
        switch (msg.method) {
          case 'initialize': {
            const requested = msg.params?.protocolVersion;
            const id = randomUUID();
            sessions.add(id);
            headers['mcp-session-id'] = id;
            result = {
              protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'fake-mcp', title: 'Local test MCP server', version: '1.0.0' },
              instructions: 'A local test server with two read-only tools.',
            };
            break;
          }
          case 'ping':
            result = {};
            break;
          case 'tools/list':
            result = { tools: toolDefinitions(changed) };
            break;
          case 'tools/call': {
            const out = callTool(String(msg.params?.name ?? ''), msg.params?.arguments ?? {});
            if (out) result = out;
            else error = { code: -32602, message: 'Unknown tool' };
            break;
          }
          default:
            error = { code: -32601, message: 'Method not found' };
        }
        const reply = error ? { jsonrpc: '2.0', id: msg.id, error } : { jsonrpc: '2.0', id: msg.id, result };
        const sse = options.sse === true || ctx.url.searchParams.get('sse') === '1';
        if (sse) return ctx.sse([{ event: 'message', id: `${msg.id}`, data: reply }], headers);
        return ctx.send(200, reply, headers);
      },
    },
    options,
  );
  return Object.assign(fake, { sessions });
}

if (isMain(import.meta.url)) {
  await runStandalone(
    'mcp',
    ({ args, ...common }) =>
      createMcpFake({
        ...common,
        sse: args.sse === 'true',
        token: args.token ?? process.env.FAKE_MCP_TOKEN,
        origins: args.origin ? [args.origin] : [],
        variant: args.variant,
        log: (l) => console.log(l),
      }),
    { envPort: 'FAKE_MCP_PORT', defaultPort: DEFAULT_PORT },
  );
}
