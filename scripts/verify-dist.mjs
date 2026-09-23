#!/usr/bin/env node
// Post-build gate: fails if dist/ would violate the production CSP or reference missing files.
// Checks: no inline scripts/handlers/styles, only same-origin script/style URLs, every referenced
// asset exists, the service worker has no unresolved placeholders, and no eval-like constructs ship.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
/** @type {string[]} */
const problems = [];

/** @param {string} urlPath */
async function exists(urlPath) {
  try {
    return (await stat(path.join(DIST, urlPath.replace(/^\//, '')))).isFile();
  } catch {
    return false;
  }
}

const manifest = JSON.parse(await readFile(path.join(DIST, 'build-manifest.json'), 'utf8'));
const html = await readFile(path.join(DIST, 'index.html'), 'utf8');

// 1. index.html must be compatible with script-src 'self' / style-src 'self'.
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1];
  const src = attrs.match(/\bsrc="([^"]+)"/)?.[1];
  if (!src) problems.push('inline <script> block in index.html');
  else if (!src.startsWith('/assets/')) problems.push(`external or unexpected script: ${src}`);
  if (m[2].trim()) problems.push('script tag with inline content in index.html');
}
if (/<style\b/i.test(html)) problems.push('<style> block in index.html');
for (const m of html.matchAll(/\s(on[a-z]+)\s*=\s*["']/gi)) problems.push(`inline event handler attribute: ${m[1]}`);
if (/\sstyle\s*=\s*["']/i.test(html)) problems.push('inline style attribute in index.html');
for (const m of html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)) {
  if (!m[1].startsWith('/assets/')) problems.push(`external stylesheet: ${m[1]}`);
}
if (/javascript:/i.test(html)) problems.push('javascript: URL in index.html');

// 2. Every local URL referenced by index.html and the precache list exists.
const localRefs = [...html.matchAll(/\b(?:src|href)="(\/[^"#?]*)"/g)].map((m) => m[1]).filter((u) => u !== '/');
for (const ref of [...new Set([...localRefs, ...manifest.precache.filter((/** @type {string} */ u) => u !== '/')])]) {
  if (!(await exists(ref))) problems.push(`missing file referenced by the build: ${ref}`);
}

// 3. Service worker placeholders resolved and version injected.
const sw = await readFile(path.join(DIST, 'sw.js'), 'utf8');
if (sw.includes('__STARPI_')) problems.push('unresolved placeholder in sw.js');
if (!sw.includes(manifest.version)) problems.push('sw.js does not carry the build version');

// 4. JavaScript bundles: no unresolved placeholders, no eval-like constructs (CSP has no 'unsafe-eval').
for (const asset of manifest.assets.filter((/** @type {string} */ a) => a.endsWith('.js'))) {
  const code = await readFile(path.join(DIST, asset), 'utf8');
  if (code.includes('__STARPI_')) problems.push(`unresolved placeholder in ${asset}`);
  if (/\bnew Function\s*\(/.test(code)) problems.push(`new Function() in ${asset}`);
  if (/(^|[^.\w$])eval\s*\(/.test(code)) problems.push(`eval() in ${asset}`);
}

// 5. The production CSP is configured.
const vercel = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
const csp = vercel.headers
  ?.flatMap((/** @type {{ headers: Array<{ key: string, value: string }> }} */ h) => h.headers)
  .find((/** @type {{ key: string }} */ h) => h.key === 'Content-Security-Policy')?.value;
if (!csp) problems.push('vercel.json has no Content-Security-Policy header');
else if (/'unsafe-(inline|eval)'/.test(csp)) problems.push('CSP allows unsafe-inline or unsafe-eval');

if (problems.length > 0) {
  console.error(`verify-dist: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`verify-dist: OK (version ${manifest.version}, ${manifest.assets.length} assets, ${manifest.precache.length} precached)`);
