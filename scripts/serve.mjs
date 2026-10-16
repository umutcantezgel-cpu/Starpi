#!/usr/bin/env node
// Static server for dist/ under the production response headers: scripts/headers.json, resolved by
// scripts/lib/headers.mjs for the profile the build was made for (dist/build-manifest.json), so
// local previews and end-to-end tests run under the real CSP and cross-origin isolation. With
// --functions it also serves the Vercel Functions of api/ by the route table of vercel.json
// (functions and rewrites, scripts/lib/routes.mjs), as Vercel does (npm run preview, npm run dev);
// the end-to-end tests run without it, so they never reach a provider even when keys are set.
//
// Usage: node scripts/serve.mjs [--port 3000] [--dir dist] [--profile <name>] [--functions]
//   --port 0 picks a free port; the line printed on start names it.
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUILD_PROFILES, DEFAULT_PROFILE, headersFor, resolveHeaderRules } from './lib/headers.mjs';
import { functionRoutes, matchRoute } from './lib/routes.mjs';

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
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
});

/**
 * The header profile: --profile, else the one the build recorded, else the default.
 * @returns {Promise<string>}
 */
async function headerProfile() {
  const chosen = argValue('--profile', '');
  if (chosen) return chosen;
  try {
    const manifest = JSON.parse(await readFile(path.join(DIR, 'build-manifest.json'), 'utf8'));
    if (typeof manifest.profile === 'string' && BUILD_PROFILES.includes(manifest.profile)) return manifest.profile;
  } catch {
    // no build yet: the default profile
  }
  return DEFAULT_PROFILE;
}

const PROFILE = await headerProfile();
const headerRules = resolveHeaderRules(PROFILE);

/**
 * Vercel Functions by the route table of vercel.json, loaded only with --functions.
 * @type {Array<{ route: import('./lib/routes.mjs').Route, module: Record<string, unknown> }>}
 */
const functions = [];
if (argv.includes('--functions')) {
  const vercel = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
  /** @type {Map<string, Record<string, unknown>>} */
  const modules = new Map();
  for (const route of functionRoutes(vercel)) {
    if (!modules.has(route.file)) modules.set(route.file, await import(pathToFileURL(path.join(ROOT, route.file)).href));
    functions.push({ route, module: /** @type {Record<string, unknown>} */ (modules.get(route.file)) });
  }
}
const routes = functions.map((f) => f.route);
// Address headers from the client are dropped; the function sees the socket address, as on Vercel.
const FORWARDING_HEADERS = /^(?:forwarded|x-real-ip|x-forwarded-.+)$/;

/** Origins (besides this host) the functions accept; NVIDIA_ and RELAY_ALLOWED_ORIGINS are aliases. */
function allowedOrigins() {
  return [process.env.STARPI_ALLOWED_ORIGINS, process.env.NVIDIA_ALLOWED_ORIGINS, process.env.RELAY_ALLOWED_ORIGINS]
    .flatMap((list) => (list ?? '').split(','))
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Host names the functions answer for. A page whose own name was rebound to this machine (DNS
 * rebinding) sends a matching Origin and Host, which the same-origin check accepts; such names are
 * neither localhost nor an IP address, so they get no function, and no request with the developer's
 * keys. Other names can be allowed through STARPI_ALLOWED_ORIGINS.
 * @param {string | undefined} host the Host header
 */
function functionHostAllowed(host) {
  if (!host) return false;
  const name = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
  if (name === 'localhost' || isIP(name) !== 0) return true;
  return allowedOrigins().some((origin) => {
    try {
      return new URL(origin).hostname === name;
    } catch {
      return false;
    }
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} error
 */
function sendError(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error }));
}

/**
 * Runs a Web-standard route handler (exports named by HTTP method) for a Node request and streams the
 * response with backpressure. A client that disconnects aborts the request and cancels the response.
 * The handler gets the original URL, also for a rewritten route.
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
    sendError(res, 403, 'host_not_allowed');
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
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const request = new Request(new URL(url.pathname + url.search, `http://127.0.0.1:${port}`), {
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
 * A request path that names one file under two spellings (an encoded slash or backslash, or a dot
 * segment) could be served with the headers of another path; such paths are refused.
 * @param {string} pathname as sent, still percent-encoded
 */
function ambiguousPath(pathname) {
  if (/%(?:2f|5c)/i.test(pathname)) return true;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((segment) => segment === '..' || segment === '.');
}

/** @param {string} urlPath decoded, without dot segments */
async function resolveFile(urlPath) {
  const clean = path.posix.normalize(urlPath);
  const candidates = [clean, `${clean}.html`, path.posix.join(clean, 'index.html')];
  for (const candidate of candidates) {
    const file = path.join(DIR, candidate);
    if (!file.startsWith(DIR + path.sep)) continue;
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
    for (const header of headersFor(headerRules, url.pathname).values()) res.setHeader(header.key, header.value);
    if (ambiguousPath(url.pathname)) {
      sendError(res, 400, 'bad_path');
      return;
    }
    const match = matchRoute(routes, url.pathname);
    if (match) {
      const fn = /** @type {(typeof functions)[number]} */ (functions.find((f) => f.route === match.route));
      await runFunction(fn.module, req, res, url);
      return;
    }
    const file = await resolveFile(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname));
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
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const extra = functions.length > 0 ? `, ${functions.length} function routes` : '';
  console.log(`serving ${path.relative(ROOT, DIR) || '.'} with the headers of profile ${PROFILE}${extra} at http://127.0.0.1:${port}`);
});
