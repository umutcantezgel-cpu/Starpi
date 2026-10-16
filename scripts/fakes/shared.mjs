// Shared plumbing of the local fake providers in scripts/fakes: an HTTP server bound to 127.0.0.1
// with request recording, CORS, scripted faults and a server-sent-events writer; neutral answer
// texts, purpose fixtures and placeholder values for JSON schemas; tiny audio and image payloads.
//
// Every fake can be steered per request, so tests and the e2e suite need no restart:
//   fault     header x-fake-fault, query ?fault=, or [[fake-fault:<fault>]] in the last user message
//             429 (with Retry-After), 401, 404, 500, 503, slow-first-byte, cut-mid-stream,
//             stall-mid-stream, invalid-json, hang
//   scenario  header x-fake-scenario, query ?scenario=, or [[fake:<scenario>]] in the last user message
//             each fake documents its own (text, reasoning, tool, search, refusal, length, ...)
//   timing    header x-fake-delay-ms (slow-first-byte delay), x-fake-retry-after (seconds)
//   purpose   [[<marker>:<name>]] in the system message picks a fixture; the marker defaults to
//             starpi-purpose and is set with --marker
// Control endpoints (no auth): GET /__fake/health, GET /__fake/requests (auth values redacted),
// POST /__fake/reset.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOST = '127.0.0.1';
export const DEFAULT_MARKER = 'starpi-purpose';
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const FAULTS = Object.freeze(['429', '401', '404', '500', '503', 'slow-first-byte', 'cut-mid-stream', 'stall-mid-stream', 'invalid-json', 'hang']);
/** Default pause before the first byte for the slow-first-byte fault. */
export const SLOW_FIRST_BYTE_MS = 1500;
/** Default Retry-After of the 429 fault, in seconds. */
export const DEFAULT_RETRY_AFTER_S = 2;
const MAX_RECORDED = 200;
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'xi-api-key', 'x-subscription-token', 'api-key', 'cookie']);
const EXPOSED_HEADERS = 'request-id, x-request-id, retry-after, mcp-session-id';

/**
 * @typedef {{ fault: string | null, scenario: string | null, delayMs: number, retryAfterS: number }} Control
 *
 * @typedef {{ event?: string, data: unknown, id?: string } | { raw: string }} SseItem
 *
 * @typedef {object} Recorded
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} query
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {any} body      parsed JSON, or null
 * @property {number} bytes  size of the raw body
 *
 * @typedef {object} FakeContext
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {URL} url
 * @property {string} path            pathname without trailing slashes
 * @property {Buffer} raw
 * @property {any} json               parsed JSON body (undefined when absent or unreadable)
 * @property {Control} control
 * @property {Record<string, string>} cors  CORS headers for this request (empty when not allowed)
 * @property {(status: number, body: unknown, headers?: Record<string, string>) => void} send       JSON answer; applies invalid-json and cut-mid-stream to 2xx
 * @property {(status: number, bytes: Buffer, type: string, headers?: Record<string, string>) => void} sendBytes
 * @property {(items: SseItem[], headers?: Record<string, string>) => Promise<void>} sse           event stream; applies the stream faults
 * @property {(status: number, kind: string) => void} fail  provider-shaped error answer
 *
 * @typedef {object} FakeDefinition
 * @property {string} name
 * @property {(ctx: { req: import('node:http').IncomingMessage, url: URL, json: any }) => string[]} [texts]  last user text first; scanned for [[fake...]] markers
 * @property {(ctx: { req: import('node:http').IncomingMessage, url: URL, path: string }) => 'ok' | 'missing' | 'in_query'} [auth]
 * @property {(status: number, kind: string, control: Control | null) => unknown} errorBody  provider-shaped error body
 * @property {(req: import('node:http').IncomingMessage) => boolean} [cors]
 * @property {(ctx: FakeContext) => Promise<boolean | void> | boolean | void} handle  false: no route (404)
 *
 * @typedef {object} FakeOptions
 * @property {number} [gapMs]        pause between two streamed events (default 5)
 * @property {number} [latencyMs]    pause before every answer (default 0)
 * @property {boolean} [cors]        answer cross-origin browser calls (default true)
 * @property {(line: string) => void} [log]
 *
 * @typedef {object} Fake
 * @property {import('node:http').Server} server
 * @property {Recorded[]} requests
 * @property {(port?: number) => Promise<{ port: number, url: string }>} listen
 * @property {() => Promise<void>} close
 * @property {() => string} url
 */

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} max
 * @returns {Promise<Buffer | null>} null when the body is larger than max
 */
export function readBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {Buffer} raw
 * @param {string | undefined} type
 */
function parseJson(raw, type) {
  if (!raw.length || !/json/i.test(type ?? 'application/json')) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 * @param {string[]} texts
 * @returns {Control}
 */
export function readControl(req, url, texts) {
  /**
   * @param {string} headerName
   * @param {string} queryName
   * @param {RegExp} marker
   */
  const pick = (headerName, queryName, marker) => {
    const h = req.headers[headerName];
    if (typeof h === 'string' && h.trim()) return h.trim().toLowerCase();
    const q = url.searchParams.get(queryName);
    if (q) return q.trim().toLowerCase();
    for (const text of texts) {
      const m = marker.exec(text);
      if (m) return m[1].toLowerCase();
    }
    return null;
  };
  const num = (/** @type {string} */ name, /** @type {number} */ fallback) => {
    const value = Number(req.headers[name]);
    return req.headers[name] !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    fault: pick('x-fake-fault', 'fault', /\[\[fake-fault:([a-z0-9-]+)\]\]/i),
    scenario: pick('x-fake-scenario', 'scenario', /\[\[fake:([a-z0-9-]+)\]\]/i),
    delayMs: Math.min(60_000, num('x-fake-delay-ms', SLOW_FIRST_BYTE_MS)),
    retryAfterS: Math.min(600, num('x-fake-retry-after', DEFAULT_RETRY_AFTER_S)),
  };
}

/**
 * Header values with the credentials replaced, for /__fake/requests.
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
export function redactHeaders(headers) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name] = SENSITIVE_HEADERS.has(name) ? '[redacted]' : value;
  return out;
}

/** @param {SseItem} item */
function sseText(item) {
  if ('raw' in item) return item.raw;
  const data = typeof item.data === 'string' ? item.data : JSON.stringify(item.data);
  const lines = [];
  if (item.id !== undefined) lines.push(`id: ${item.id}`);
  if (item.event) lines.push(`event: ${item.event}`);
  for (const line of data.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * A fake provider server (not yet listening).
 * @param {FakeDefinition} def
 * @param {FakeOptions} [options]
 * @returns {Fake}
 */
export function createFakeServer(def, options = {}) {
  const gapMs = options.gapMs ?? 5;
  const latencyMs = options.latencyMs ?? 0;
  const corsOn = options.cors ?? true;
  const log = options.log ?? (() => {});
  /** @type {Recorded[]} */
  const requests = [];
  let boundUrl = '';

  /**
   * @param {import('node:http').IncomingMessage} req
   */
  const corsHeaders = (req) => {
    const origin = req.headers.origin;
    if (!corsOn || typeof origin !== 'string' || (def.cors && !def.cors(req))) return {};
    return { 'access-control-allow-origin': origin, 'access-control-expose-headers': EXPOSED_HEADERS, vary: 'origin' };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(req);
    // A cross-origin-isolated page (COEP require-corp) may also load answers without CORS, such as
    // audio in a media element.
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    /**
     * @param {number} status
     * @param {unknown} body
     * @param {Record<string, string>} [headers]
     */
    const writeJson = (status, body, headers = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors, ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
        // Preflight: allowed when this fake accepts the origin (and, for some, the requested headers).
        // A page on a public origin calling this loopback server also asks for private network access.
        const allowed = Object.keys(cors).length > 0;
        const privateNetwork = req.headers['access-control-request-private-network'] === 'true' ? { 'access-control-allow-private-network': 'true' } : {};
        res.writeHead(allowed ? 204 : 403, allowed
          ? { ...cors, ...privateNetwork, 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? ''), 'access-control-max-age': '600' }
          : {});
        res.end();
        return;
      }
      if (pathname === '/__fake/health') return writeJson(200, { ok: true, name: def.name });
      if (pathname === '/__fake/requests') return writeJson(200, requests.map((r) => ({ ...r, headers: redactHeaders(r.headers) })));
      if (pathname === '/__fake/reset' && req.method === 'POST') {
        requests.length = 0;
        return writeJson(200, { ok: true });
      }

      const raw = (await readBody(req)) ?? null;
      if (raw === null) return writeJson(413, def.errorBody(413, 'too_large', null));
      const json = parseJson(raw, req.headers['content-type']);
      /** @type {Recorded} */
      const entry = { method: req.method ?? 'GET', path: pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body: json ?? null, bytes: raw.length };
      requests.push(entry);
      if (requests.length > MAX_RECORDED) requests.shift();

      const authState = def.auth ? def.auth({ req, url, path: pathname }) : 'ok';
      const control = readControl(req, url, def.texts ? def.texts({ req, url, json }) : []);
      /** @param {number} status @param {string} kind */
      const fail = (status, kind) => {
        const headers = /** @type {Record<string, string>} */ ({});
        if (status === 429 || status === 503) headers['retry-after'] = String(control.retryAfterS);
        writeJson(status, def.errorBody(status, kind, control), headers);
      };
      if (authState === 'in_query') return fail(400, 'key_in_query');
      if (authState === 'missing') return fail(401, 'auth');

      if (latencyMs) await sleep(latencyMs);
      switch (control.fault) {
        case 'hang':
          return; // never answers; the client has to give up
        case 'slow-first-byte':
          await sleep(control.delayMs);
          break;
        case '429':
          return fail(429, 'rate_limited');
        case '401':
          return fail(401, 'auth');
        case '404':
          return fail(404, 'not_found');
        case '500':
          return fail(500, 'server');
        case '503':
          return fail(503, 'unavailable');
        default:
          break;
      }
      if (res.destroyed) return;

      /** @type {FakeContext} */
      const ctx = {
        req,
        res,
        url,
        path: pathname,
        raw,
        json,
        control,
        cors,
        fail,
        send(status, body, headers = {}) {
          if (status >= 300 || (control.fault !== 'invalid-json' && control.fault !== 'cut-mid-stream')) return writeJson(status, body, headers);
          const text = JSON.stringify(body);
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cors, ...headers });
          if (control.fault === 'invalid-json') res.end(text.slice(0, Math.max(1, Math.floor(text.length / 2))));
          else {
            res.write(text.slice(0, Math.max(1, Math.floor(text.length / 2))));
            setTimeout(() => res.destroy(), 10);
          }
        },
        sendBytes(status, bytes, type, headers = {}) {
          res.writeHead(status, { 'content-type': type, 'content-length': String(bytes.length), ...cors, ...headers });
          if (control.fault === 'cut-mid-stream') {
            res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
            setTimeout(() => res.destroy(), 10);
          } else res.end(bytes);
        },
        async sse(items, headers = {}) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors, ...headers });
          res.flushHeaders();
          const half = Math.max(1, Math.ceil(items.length / 2));
          for (let i = 0; i < items.length; i += 1) {
            if (res.destroyed) return;
            if (i === half && control.fault === 'cut-mid-stream') {
              res.destroy();
              return;
            }
            if (i === half && control.fault === 'stall-mid-stream') return; // stays open, sends nothing more
            res.write(sseText(items[i]));
            if (i === 0 && control.fault === 'invalid-json') res.write('data: {"unterminated": \n\n');
            if (gapMs) await sleep(gapMs);
          }
          res.end();
        },
      };
      const handled = await def.handle(ctx);
      if (handled === false && !res.headersSent) fail(404, 'not_found');
    } catch (err) {
      log(`${def.name}: ${err instanceof Error ? err.name : 'Error'}`);
      if (!res.headersSent) writeJson(500, def.errorBody(500, 'server', null));
      else res.destroy();
    } finally {
      log(`${def.name} ${req.method} ${pathname} ${res.statusCode}`);
    }
  });

  return {
    server,
    requests,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          const address = /** @type {import('node:net').AddressInfo} */ (server.address());
          boundUrl = `http://${HOST}:${address.port}`;
          resolve({ port: address.port, url: boundUrl });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
    url: () => boundUrl,
  };
}

// --- answers ---------------------------------------------------------------------------------

const GERMAN = /\b(?:und|der|die|das|ist|nicht|ich|wie|was|warum|bitte|ein|eine|mit|für)\b|[äöüß]/i;

/** @param {string} text */
export function looksGerman(text) {
  return GERMAN.test(text);
}

/** @param {string} text */
function withoutMarkers(text) {
  return text.replace(/\[\[[a-z0-9-]+:[a-z0-9_.-]+\]\]/gi, '').replace(/\s+/g, ' ').trim();
}

/**
 * The fake's plain answer: it says it is simulated and repeats the start of the question.
 * @param {string} userText
 */
export function defaultAnswer(userText) {
  const question = withoutMarkers(userText);
  const snippet = question.length > 80 ? `${question.slice(0, 77)}...` : question;
  if (looksGerman(question)) return snippet ? `Dies ist eine simulierte Antwort des lokalen Testanbieters. Ihre Frage war: "${snippet}".` : 'Dies ist eine simulierte Antwort des lokalen Testanbieters.';
  return snippet ? `This is a simulated answer from the local test provider. You asked: "${snippet}".` : 'This is a simulated answer from the local test provider.';
}

export const REASONING_TEXT = 'The question is short. I recall the key facts first, then answer in one or two sentences.';

/** @param {string} userText */
export function refusalText(userText) {
  return looksGerman(userText) ? 'Bei dieser Anfrage kann ich nicht helfen.' : "I can't help with that request.";
}

/** Sources of the search scenario; reserved example domains only. */
export const SEARCH_SOURCES = Object.freeze([
  { url: 'https://example.com/articles/overview', title: 'Example overview', snippet: 'An overview that explains the topic in plain words.' },
  { url: 'https://example.org/reference/details', title: 'Example reference', snippet: 'A reference page that lists the details.' },
]);

/**
 * The answer of the search scenario as sentences, each backed by one source.
 * @param {string} userText
 * @returns {Array<{ text: string, source: number }>}
 */
export function searchSentences(userText) {
  return looksGerman(userText)
    ? [
        { text: 'Die Beispielübersicht erklärt das Thema in einfachen Worten.', source: 0 },
        { text: ' Die Referenzseite ergänzt die Einzelheiten.', source: 1 },
      ]
    : [
        { text: 'The example overview explains the topic in plain words.', source: 0 },
        { text: ' The reference page adds the details.', source: 1 },
      ];
}

/**
 * Pieces of a text for streaming: about two words each, spaces kept, so joining gives the text.
 * @param {string} text
 * @returns {string[]}
 */
export function chunkText(text) {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const out = [];
  for (let i = 0; i < words.length; i += 2) out.push(words.slice(i, i + 2).join(''));
  return out.length ? out : [text];
}

/**
 * A value that satisfies a (subset of) JSON Schema: const, enum, default, examples, type, object
 * properties (required ones, or all when none is required), arrays with minItems, string formats.
 * @param {any} schema
 * @param {number} [depth]
 * @returns {unknown}
 */
export function exampleFromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 8) return null;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants) && variants.length) return exampleFromSchema(variants.find((v) => v?.type !== 'null') ?? variants[0], depth + 1);
  if (Array.isArray(schema.allOf) && schema.allOf.length) return exampleFromSchema(Object.assign({}, ...schema.allOf), depth + 1);
  const type = Array.isArray(schema.type) ? (schema.type.find((/** @type {string} */ t) => t !== 'null') ?? 'null') : schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  switch (type) {
    case 'object': {
      /** @type {Record<string, unknown>} */
      const out = {};
      const props = schema.properties ?? {};
      const keys = Array.isArray(schema.required) && schema.required.length ? schema.required : Object.keys(props);
      for (const key of keys) out[key] = exampleFromSchema(props[key] ?? { type: 'string' }, depth + 1);
      return out;
    }
    case 'array': {
      const count = Math.max(1, Number(schema.minItems) || 0);
      return Array.from({ length: Math.min(count, 5) }, () => exampleFromSchema(schema.items ?? { type: 'string' }, depth + 1));
    }
    case 'integer':
    case 'number': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : null;
      const max = typeof schema.maximum === 'number' ? schema.maximum : null;
      let value = min ?? 1;
      if (max !== null && value > max) value = max;
      return type === 'integer' ? Math.round(value) : value;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    default: {
      if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (schema.format === 'date') return '2026-01-01';
      if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com/';
      if (schema.format === 'email') return 'someone@example.com';
      const base = 'example';
      const minLength = Number(schema.minLength) || 0;
      return base.length >= minLength ? base : base.padEnd(minLength, 'x');
    }
  }
}

/**
 * Built-in fixtures for the app's own purposes. They only keep the fakes useful out of the box;
 * tests that need exact shapes pass their own fixtures, and a request with a JSON schema gets a
 * value built from the schema instead.
 * @type {Record<string, (input: { user: string }) => { text?: string, json?: unknown }>}
 */
export const BUILTIN_FIXTURES = Object.freeze({
  title_chat: ({ user }) => {
    const words = withoutMarkers(user).replace(/[^\p{L}\p{N}\s-]/gu, '').split(/\s+/).filter(Boolean).slice(0, 6);
    return { text: words.length ? words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ') : 'New conversation' };
  },
  summarize_doc: () => ({ text: 'The document introduces its topic, explains it in a few short sections and ends with a brief conclusion.' }),
  describe_image: () => ({ text: 'The image shows a simple illustration with a few shapes on a light background.' }),
  ocr_image: () => ({ text: 'Sample text recognised in the image.' }),
  query_rewrite: ({ user }) => ({ json: { queries: [withoutMarkers(user) || 'example question'] } }),
  extract_graph: () => ({ json: { entities: [], relations: [] } }),
  entail_check: () => ({ json: { verdict: 'supported', confidence: 0.9 } }),
  council_judge: () => ({ json: { chosen: 0, reasons: ['The first answer is the most complete.'] } }),
  research_brief: () => ({ json: { summary: 'A short simulated summary.', details: [], sources: [], open_questions: [] } }),
});

/**
 * Fixtures from a directory: one `<name>.json` per purpose holding `{ "variants": [...] }`, each
 * variant `{ "text": "..." }` or `{ "json": ... }`; variants are served in turn.
 * @param {string} dir
 * @returns {Map<string, Array<{ text?: string, json?: unknown }>>}
 */
export function loadFixtureDir(dir) {
  /** @type {Map<string, Array<{ text?: string, json?: unknown }>>} */
  const out = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const value = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    if (!Array.isArray(value?.variants) || value.variants.length === 0) throw new Error(`fixture ${file}: needs a non-empty "variants" list`);
    out.set(path.basename(file, '.json'), value.variants);
  }
  return out;
}

/**
 * @typedef {object} FixtureOptions
 * @property {string} [marker]  purpose marker name (default starpi-purpose)
 * @property {Map<string, Array<{ text?: string, json?: unknown }>> | Record<string, Array<{ text?: string, json?: unknown }>>} [fixtures]
 * @property {string} [fixturesDir]
 */

/**
 * Picks the answer text for a request: a caller fixture for the purpose, else a value built from
 * the requested JSON schema, else a built-in fixture, else the plain simulated answer.
 * @param {FixtureOptions} [options]
 */
export function createAnswerBook(options = {}) {
  const marker = options.marker ?? DEFAULT_MARKER;
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(marker)) throw new Error('marker: lower-case letters, digits and - only');
  const pattern = new RegExp(`\\[\\[${marker}:([a-z0-9_.-]+)\\]\\]`, 'i');
  /** @type {Map<string, Array<{ text?: string, json?: unknown }>>} */
  const custom = new Map(options.fixturesDir ? loadFixtureDir(options.fixturesDir) : []);
  const given = options.fixtures instanceof Map ? options.fixtures : new Map(Object.entries(options.fixtures ?? {}));
  for (const [name, variants] of given) custom.set(name, variants);
  /** @type {Map<string, number>} */
  const turns = new Map();
  return {
    marker,
    /** @param {string} text */
    purposeOf(text) {
      return pattern.exec(text)?.[1]?.toLowerCase() ?? null;
    },
    /**
     * @param {{ system: string, user: string, schema?: unknown }} input
     * @returns {{ text: string, purpose: string | null, json: boolean }}
     */
    answer({ system, user, schema }) {
      const purpose = this.purposeOf(system) ?? this.purposeOf(user);
      const variants = purpose ? custom.get(purpose) : undefined;
      if (purpose && variants) {
        const turn = turns.get(purpose) ?? 0;
        turns.set(purpose, turn + 1);
        const v = variants[turn % variants.length];
        return v.json !== undefined ? { text: JSON.stringify(v.json), purpose, json: true } : { text: String(v.text ?? ''), purpose, json: false };
      }
      if (schema && typeof schema === 'object') return { text: JSON.stringify(exampleFromSchema(schema)), purpose, json: true };
      const builtin = purpose && Object.hasOwn(BUILTIN_FIXTURES, purpose) ? BUILTIN_FIXTURES[purpose]({ user }) : null;
      if (builtin) return builtin.json !== undefined ? { text: JSON.stringify(builtin.json), purpose, json: true } : { text: String(builtin.text), purpose, json: false };
      return { text: defaultAnswer(user), purpose, json: false };
    },
  };
}

/**
 * A short deterministic id for fake objects.
 * @param {string} prefix
 * @param {number} n
 */
export function fakeId(prefix, n) {
  return `${prefix}${String(n).padStart(6, '0')}fake`;
}

// --- payloads ---------------------------------------------------------------------------------

/** A 1x1 transparent PNG. */
export const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Silent 16-bit mono PCM.
 * @param {number} ms
 * @param {number} rate
 */
export function pcmSilence(ms, rate = 24_000) {
  return Buffer.alloc(Math.max(2, Math.round((rate * ms) / 1000)) * 2);
}

/**
 * Silent 16-bit mono WAV.
 * @param {number} ms
 * @param {number} rate
 */
export function wavSilence(ms, rate = 16_000) {
  const data = pcmSilence(ms, rate);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/**
 * Silent MPEG-1 Layer III frames (128 kbit/s, 44.1 kHz, mono): a header and zeroed side info and
 * main data, which decoders play as silence. One frame lasts about 26 ms.
 * @param {number} ms
 */
export function mp3Silence(ms) {
  const frames = Math.max(1, Math.round(ms / 26));
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0xc0;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

// --- command line -----------------------------------------------------------------------------

/**
 * `--name value` and `--flag` arguments.
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out[arg.slice(2)] = 'true';
  }
  return out;
}

/** @param {string} importMetaUrl */
export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === importMetaUrl;
}

/**
 * Options every fake reads from the command line or the environment.
 * @param {Record<string, string>} args
 * @param {Record<string, string | undefined>} [env]
 */
export function commonOptions(args, env = process.env) {
  const gap = Number(args['gap-ms'] ?? env.FAKE_GAP_MS);
  const latency = Number(args['latency-ms'] ?? env.FAKE_LATENCY_MS);
  const cors = args.cors ?? env.FAKE_CORS;
  return {
    marker: args.marker ?? env.FAKE_MARKER ?? DEFAULT_MARKER,
    fixturesDir: args.fixtures ?? env.FAKE_FIXTURES_DIR,
    gapMs: Number.isFinite(gap) && gap >= 0 ? gap : undefined,
    latencyMs: Number.isFinite(latency) && latency >= 0 ? latency : undefined,
    cors: cors === undefined ? undefined : !/^(?:0|off|false|no)$/i.test(cors),
  };
}

/**
 * Starts one fake from the command line and prints its URL.
 * @param {string} name
 * @param {(options: ReturnType<typeof commonOptions> & { args: Record<string, string> }) => Fake} create
 * @param {{ envPort: string, defaultPort: number }} ports
 */
export async function runStandalone(name, create, { envPort, defaultPort }) {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? process.env[envPort] ?? defaultPort);
  const fake = create({ ...commonOptions(args), args });
  const { url } = await fake.listen(port);
  console.log(`${name} fake listening on ${url}`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
