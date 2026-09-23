#!/usr/bin/env node
// Minimal static server for dist/ that applies the same response headers as production
// (vercel.json), so local previews and end-to-end tests run under the real CSP.
//
// Usage: node scripts/serve.mjs [--port 3000] [--dir dist]
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
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
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

/** Converts the vercel.json source patterns used here ("/(.*)", "/assets/(.*)", "/sw.js") to RegExps. */
function toRegExp(source) {
  const escaped = source.replace(/[.+?^${}|[\]\\]/g, '\\$&').replace(/\\?\(\.\*\)/g, '(.*)');
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
    res.statusCode = 500;
    res.end(String(err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${path.relative(ROOT, DIR) || '.'} with production headers at http://127.0.0.1:${PORT}`);
});
