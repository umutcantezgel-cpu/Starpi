#!/usr/bin/env node
// Minimal static server for dist/ that applies the same response headers as production
// (vercel.json), so local previews and end-to-end tests run under the real CSP. With --functions it
// also serves the NVIDIA proxy routes from api/ as Vercel does (npm run preview, npm run dev); the
// end-to-end tests run without it, so they never reach NVIDIA even when NVIDIA_API_KEYS is set.
//
// Usage: node scripts/serve.mjs [--port 3000] [--dir dist] [--functions]
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argValue = (/** @type {string} */ name, /** @type {string} */ fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(argValue('--port', process.env.PORT ?? '3000'));
const DIR = path.resolve(ROOT, argValue('--dir', 'dist'));

const MIME = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

// Vercel Functions by route; loaded only with --functions.
const functions = new Map(
  argv.includes('--functions')
    ? [
        ['/api/chat/nvidia', await import('../api/chat/nvidia.js')],
        ['/api/models/nvidia', await import('../api/models/nvidia.js')],
      ]
    : [],
);
// Address headers from the client are dropped; the function sees the socket address, as on Vercel.
const FORWARDING_HEADERS = /^(?:forwarded|x-real-ip|x-forwarded-.+)$/;

/**
 * Host names the functions answer for. A page whose own name was rebound to this machine (DNS
 * rebinding) sends a matching Origin and Host, which the same-origin check accepts; such names are
 * neither localhost nor an IP address, so they get no function, and no request with the developer's
 * keys. Other names can be allowed through NVIDIA_ALLOWED_ORIGINS.
 * @param {string | undefined} host the Host header
 */
function functionHostAllowed(host) {
  if (!host) return false;
  const name = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
  if (name === 'localhost' || isIP(name) !== 0) return true;
  const allowed = (process.env.NVIDIA_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  return allowed.some((origin) => {
    try {
      return new URL(origin).hostname === name;
    } catch {
      return false;
    }
  });
}

/**
 * Runs a Web-standard route handler (exports named by HTTP method) for a Node request and streams the
 * response with backpressure. A client that disconnects aborts the request and cancels the response.
 * @param {Record<string, unknown>} route
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function runFunction(route, req, res, url) {
  let hostAllowed = false;
  try {
    hostAllowed = functionHostAllowed(req.headers.host);
  } catch {
    // an unparseable Host header
  }
  if (!hostAllowed) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'host_not_allowed' }));
    return;
  }
  const method = req.method ?? 'GET';
  const handler = route[method];
  if (typeof handler !== 'function') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Method not allowed');
    return;
  }
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || FORWARDING_HEADERS.test(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  headers.set('x-real-ip', req.socket.remoteAddress ?? '');
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const request = new Request(new URL(url.pathname + url.search, `http://127.0.0.1:${PORT}`), {
    method,
    headers,
    signal: controller.signal,
    ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
  });

  const response = await handler(request);
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body || method === 'HEAD') {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  // Cancelling the response stream also cancels the upstream request behind it.
  const stop = () => reader.cancel().catch(() => {});
  if (controller.signal.aborted) stop();
  else controller.signal.addEventListener('abort', stop, { once: true });
  for (;;) {
    const { done, value } = await reader.read();
    if (done || res.destroyed) break;
    if (!res.write(value)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
  }
  if (!res.destroyed) res.end();
}

/**
 * Converts the vercel.json source patterns used here ("/(.*)", "/assets/(.*)", "/sw.js") to RegExps:
 * "(.*)" is the only wildcard, everything else matches literally.
 * @param {string} source
 */
function toRegExp(source) {
  const escaped = source
    .split('(.*)')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(.*)');
  return new RegExp(`^${escaped}$`);
}

const vercel = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
const headerRules = (vercel.headers ?? []).map((/** @type {{ source: string, headers: Array<{ key: string, value: string }> }} */ rule) => ({
  re: toRegExp(rule.source),
  headers: rule.headers,
}));

/** @param {string} urlPath */
async function resolveFile(urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const candidates = [clean, `${clean}.html`, path.join(clean, 'index.html')];
  for (const candidate of candidates) {
    const file = path.join(DIR, candidate);
    if (!file.startsWith(DIR)) return null;
    try {
      const info = await stat(file);
      if (info.isFile()) return file;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    for (const rule of headerRules) {
      if (rule.re.test(url.pathname)) for (const h of rule.headers) res.setHeader(h.key, h.value);
    }
    const route = functions.get(url.pathname);
    if (route) {
      await runFunction(route, req, res, url);
      return;
    }
    const file = await resolveFile(url.pathname === '/' ? '/index.html' : url.pathname);
    if (!file) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch (err) {
    // A streamed function response may already have sent its head.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.statusCode = 500;
    res.end(String(err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${path.relative(ROOT, DIR) || '.'} with production headers at http://127.0.0.1:${PORT}`);
});
