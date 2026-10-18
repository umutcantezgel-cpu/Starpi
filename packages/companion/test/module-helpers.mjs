// Helpers of the module tests: a companion with standard modules, a paired client, tiny local
// servers on free ports (a chat model, an embedding server) and polling.
import { createServer } from 'node:http';
import { createHub } from '../src/setup/hub.js';
import { standardModules } from '../src/setup/standard.js';
import { pairOver, startTest } from './helpers.mjs';

export const APP = 'https://www.starpi.app';

/**
 * Starts a companion with standard modules.
 * @param {string} root
 * @param {{ only?: string[], raw?: Record<string, unknown>, modules?: any[], options?: Record<string, unknown> }} [setup]
 */
export async function startModules(root, { only, raw = {}, modules, options = {} } = {}) {
  const hub = createHub();
  const list = modules ?? standardModules({ hub, only });
  const started = await startTest(root, raw, { modules: list, ...options });
  return { ...started, hub };
}

/**
 * A client paired as owner (or member) with a bearer token; it sends no Origin, like a script on
 * this machine.
 * @param {import('../src/service.js').Companion} companion
 * @param {{ role?: 'owner' | 'member' }} [options]
 */
export async function client(companion, { role = 'owner' } = {}) {
  const { body } = await pairOver(companion, { origin: APP, role });
  const token = body.token;
  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, raw?: Uint8Array | string, type?: string, headers?: Record<string, string> }} [options]
   */
  async function request(method, path, options = {}) {
    /** @type {Record<string, string>} */
    const headers = { authorization: `Bearer ${token}`, ...(options.headers ?? {}) };
    /** @type {BodyInit | undefined} */
    let payload;
    if (options.raw !== undefined) {
      headers['content-type'] = options.type ?? 'application/octet-stream';
      payload = typeof options.raw === 'string' ? options.raw : Buffer.from(options.raw);
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const res = await fetch(`${companion.url}${path}`, { method, headers, body: payload });
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    return {
      status: res.status,
      headers: res.headers,
      buffer,
      text,
      json: () => JSON.parse(text),
    };
  }
  return {
    token,
    session: body.session,
    request,
    /** @param {string} path */
    get: (path) => request('GET', path),
    /** @param {string} path @param {unknown} [b] */
    post: (path, b = {}) => request('POST', path, { body: b }),
    /** @param {string} path @param {unknown} b */
    put: (path, b) => request('PUT', path, { body: b }),
    /** @param {string} path */
    del: (path) => request('DELETE', path),
    /**
     * Reads a server-sent event stream until `until` returns true for the events so far.
     * @param {string} method
     * @param {string} path
     * @param {{ body?: unknown, until?: (events: Array<{ event: string, data: any }>) => boolean, timeoutMs?: number }} [options]
     */
    async stream(method, path, { body: b, until = () => false, timeoutMs = 10_000 } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      /** @type {Record<string, string>} */
      const headers = { authorization: `Bearer ${token}`, accept: 'text/event-stream' };
      if (b !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${companion.url}${path}`, { method, headers, body: b === undefined ? undefined : JSON.stringify(b), signal: controller.signal });
      /** @type {Array<{ event: string, data: any }>} */
      const events = [];
      if (!res.ok || !res.body) {
        clearTimeout(timer);
        return { status: res.status, events, text: await res.text() };
      }
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event && data !== undefined) events.push({ event, data: JSON.parse(data) });
          }
          if (until(events)) break;
        }
      } catch (err) {
        if (!controller.signal.aborted) throw err;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      return { status: res.status, events, text: '' };
    },
  };
}

/**
 * Polls until `check` returns a truthy value.
 * @template T
 * @param {() => Promise<T> | T} check
 * @param {{ timeoutMs?: number, everyMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function eventually(check, { timeoutMs = 10_000, everyMs = 20 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/**
 * A local HTTP server on a free loopback port; the handler gets the parsed JSON body.
 * @param {(req: import('node:http').IncomingMessage, body: any, res: import('node:http').ServerResponse) => void | Promise<void>} handler
 */
export async function localServer(handler) {
  /** @type {Array<{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders, body: any }>} */
  const seen = [];
  const server = createServer((req, res) => {
    /** @type {Buffer[]} */
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(parts);
      let body = raw;
      if (String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          body = raw;
        }
      }
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      try {
        await handler(req, body, res);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    seen,
    close: () => new Promise((resolve) => {
      server.close(() => resolve(undefined));
      server.closeAllConnections();
    }),
  };
}

/**
 * A chat model on a free port that speaks the OpenAI-shaped streaming route. `reply` decides the
 * text for each request (it sees the messages).
 * @param {(messages: Array<{ role: string, content: string }>, call: number) => string | { text: string, stop?: string }} reply
 */
export async function chatModel(reply) {
  let calls = 0;
  const server = await localServer((req, body, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }));
      return;
    }
    calls += 1;
    const out = reply(body.messages, calls);
    const { text, stop = 'stop' } = typeof out === 'string' ? { text: out } : out;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Split into small deltas, the way a model streams.
    const pieces = text.match(/[\s\S]{1,7}/g) ?? [];
    for (const piece of pieces) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: stop }], model: 'test-model' })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  return { ...server, calls: () => calls };
}

/**
 * An embedding server on a free port: a tiny bag-of-letters vector, so similar words land near
 * each other.
 * @param {{ fail?: boolean }} [options]
 */
export async function embeddingServer(options = {}) {
  return localServer((req, body, res) => {
    if (options.fail) {
      res.writeHead(503);
      res.end();
      return;
    }
    const input = Array.isArray(body.input) ? body.input : [body.input];
    const data = input.map((/** @type {string} */ text, /** @type {number} */ index) => {
      const vec = new Array(26).fill(0);
      for (const ch of String(text).toLowerCase()) {
        const code = ch.charCodeAt(0) - 97;
        if (code >= 0 && code < 26) vec[code] += 1;
      }
      vec[0] += 0.001;
      return { object: 'embedding', index, embedding: vec };
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data, model: body.model }));
  });
}
