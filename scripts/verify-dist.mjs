#!/usr/bin/env node
// Post-build gate: fails if dist/ would violate the production CSP, reference missing files, ship a
// key, outgrow its first-load budget or be served with headers other than scripts/headers.json.
// Checks: no inline scripts/handlers/styles, only same-origin script/style URLs, every referenced
// asset exists, the service worker has no unresolved placeholders and carries the build version
// (which covers the header digest), no eval-like constructs or provider keys ship, the WASM runtime
// stays out of the precache, the initial JavaScript stays within its budget, and the headers of the
// build's profile are strict, isolating and identical on every file except the sandboxed frames.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildVersion } from './lib/build-version.mjs';
import { BUILD_PROFILES, CORE_PROFILES, DEFAULT_PROFILE, expectedParity, FRAME_PATHS, headersDigest, headersFor, parityOf, parseCsp, resolveHeaderRules } from './lib/headers.mjs';
import { pageScripts, staticImports } from './lib/html.mjs';
import { credentialRules } from './lib/secret-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/**
 * Bytes of the JavaScript the page needs before it runs (its scripts and their static imports,
 * minified, uncompressed) in the 2.1.0 build: the baseline of the first-load budget.
 */
const INITIAL_JS_BASELINE_BYTES = 609_945;
/** The first load may grow by this share of the baseline. */
const INITIAL_JS_HEADROOM = 0.15;
const INITIAL_JS_BUDGET_BYTES = Math.floor(INITIAL_JS_BASELINE_BYTES * (1 + INITIAL_JS_HEADROOM));

/** The only Google source the CSP may name, and only in the profile public: the Gemini Live socket. */
const LIVE_SOCKET_SOURCE = 'wss://generativelanguage.googleapis.com';

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

const manifestText = await readFile(path.join(DIST, 'build-manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const html = await readFile(path.join(DIST, 'index.html'), 'utf8');

// 0. The build names a known header profile, and its headers have not changed since the build.
const profile = typeof manifest.profile === 'string' ? manifest.profile : '';
if (!BUILD_PROFILES.includes(profile)) problems.push(`build-manifest.json names no known header profile (got "${profile}", expected one of ${BUILD_PROFILES.join(', ')})`);
const rules = resolveHeaderRules(BUILD_PROFILES.includes(profile) ? profile : DEFAULT_PROFILE);
const digest = headersDigest(rules);
if (manifest.headersDigest !== digest) problems.push(`header digest ${manifest.headersDigest} does not match scripts/headers.json (${digest}); rebuild`);

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
// The theme script runs before the first paint, so it is a classic script and the first one.
const { themeBootJs } = manifest.entries;
if (themeBootJs) {
  const tag = [...html.matchAll(/<script\b([^>]*)>/gi)].find((m) => m[1].includes(`src="${themeBootJs}"`));
  if (!tag) problems.push(`index.html does not load the theme script ${themeBootJs}`);
  else if (/\b(?:type="module"|async|defer)\b/.test(tag[1])) problems.push('the theme script must be a classic, blocking script');
  if (pageScripts(html)[0] !== themeBootJs) problems.push('the theme script must be the first script of the page');
  if (!manifest.precache.includes(themeBootJs)) problems.push('the theme script is not precached');
}

// 2. Every local URL referenced by index.html and the precache list exists.
const localRefs = [...html.matchAll(/\b(?:src|href)="(\/[^"#?]*)"/g)].map((m) => m[1]).filter((u) => u !== '/');
for (const ref of [...new Set([...localRefs, ...manifest.precache.filter((/** @type {string} */ u) => u !== '/')])]) {
  if (!(await exists(ref))) problems.push(`missing file referenced by the build: ${ref}`);
}

// 3. Service worker placeholders resolved and version injected.
const sw = await readFile(path.join(DIST, 'sw.js'), 'utf8');
if (sw.includes('__STARPI_')) problems.push('unresolved placeholder in sw.js');
if (!sw.includes(manifest.version)) problems.push('sw.js does not carry the build version');
// The version covers the page, the hashed assets, every public file, the service worker and the
// header digest, so a changed manifest, icon, sample document or header reaches returning visitors.
const publicFiles = await Promise.all(
  (manifest.public ?? []).map(async (/** @type {string} */ url) => ({ url, bytes: await readFile(path.join(DIST, url.slice(1))) })),
);
const expected = buildVersion({
  html,
  assetUrls: manifest.assets,
  publicFiles,
  swTemplate: await readFile(path.join(ROOT, 'src', 'sw.js'), 'utf8'),
  headersDigest: digest,
});
if (!manifest.public?.length) problems.push('build-manifest.json lists no public files');
if (expected !== manifest.version) problems.push(`build version ${manifest.version} does not match the dist contents (${expected})`);

// The workspace must work offline, and only "/" may be the offline page (a redirected /index.html
// breaks offline navigation on hosts with clean URLs).
if (!manifest.precache.includes(manifest.entries.ingestWorkerJs)) problems.push('the ingest worker is not precached');
if (manifest.precache.includes('/index.html')) problems.push('/index.html is precached; use "/" as the only shell page');

// The source check highlights statements with ::highlight(); the rule must survive the CSS build.
const css = await readFile(path.join(DIST, manifest.entries.appCss.slice(1)), 'utf8');
if (!css.includes('::highlight(starpi-review)')) problems.push('app CSS lacks the ::highlight(starpi-review) rule');

// 4. JavaScript bundles: no unresolved placeholders, no eval-like constructs (CSP has no 'unsafe-eval').
// Provider keys live only in the server environment or the user's browser, so no shipped file may
// contain one: the key and token rules of .gitleaks.toml run over every script, the frame scripts,
// the page, the service worker and the manifest.
const keyRules = credentialRules(ROOT);
if (!keyRules.some((rule) => rule.id === 'starpi-nvidia-api-key')) problems.push('.gitleaks.toml has no starpi-nvidia-api-key rule');
/**
 * @param {string} file
 * @param {string} text
 */
const scanKeys = (file, text) => {
  for (const rule of keyRules) if (rule.re.test(text)) problems.push(`${rule.id} matches in ${file}`);
};
const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
for (const asset of manifest.assets.filter((/** @type {string} */ a) => a.endsWith('.js'))) {
  const code = await readFile(path.join(DIST, asset), 'utf8');
  if (code.includes('__STARPI_')) problems.push(`unresolved placeholder in ${asset}`);
  if (/\bnew Function\s*\(/.test(code)) problems.push(`new Function() in ${asset}`);
  if (/(^|[^.\w$])eval\s*\(/.test(code)) problems.push(`eval() in ${asset}`);
  scanKeys(asset, code);
}
for (const frame of frames) {
  const code = await readFile(path.join(DIST, frame.slice(1)), 'utf8').catch(() => null);
  if (code === null) problems.push(`the frame script ${frame} is missing`);
  else scanKeys(frame, code);
}
for (const [file, text] of [['index.html', html], ['sw.js', sw], ['build-manifest.json', manifestText]]) scanKeys(file, text);

// 5. The processor (WASM) runtime loads on first use only: the worker and the self-hosted ONNX
// Runtime binary exist, the service worker keeps the binary once cached, and neither of them nor
// any code of Transformers.js or ONNX Runtime is part of the precached app shell.
const { wasmWorkerJs, ortWasm } = manifest.entries;
if (!wasmWorkerJs || !(await exists(wasmWorkerJs))) problems.push(`the WASM worker is missing: ${wasmWorkerJs}`);
if (typeof ortWasm !== 'string' || !/^\/assets\/ort-wasm-simd-threaded-[0-9a-f]{16}\.wasm$/.test(ortWasm)) {
  problems.push(`unexpected ONNX Runtime binary URL: ${ortWasm}`);
} else if (!(await exists(ortWasm))) {
  problems.push(`the ONNX Runtime binary is missing: ${ortWasm}`);
} else {
  const magic = (await readFile(path.join(DIST, ortWasm.slice(1)))).subarray(0, 4);
  if (!magic.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) problems.push(`${ortWasm} is not a WebAssembly binary`);
  if (!manifest.assets.includes(ortWasm)) problems.push('the ONNX Runtime binary is not listed in the build assets');
}
for (const url of [wasmWorkerJs, ortWasm, manifest.entries.renderExtrasJs].filter(Boolean)) {
  if (manifest.precache.includes(url)) problems.push(`${url} is precached; it loads on first use`);
}
const scripts = manifest.assets.filter((/** @type {string} */ a) => a.endsWith('.js'));
const sources = new Map(await Promise.all(scripts.map(async (/** @type {string} */ a) => /** @type {const} */ ([a, await readFile(path.join(DIST, a), 'utf8')]))));
if (![...sources.values()].some((code) => code.includes(ortWasm))) problems.push('no script references the ONNX Runtime binary');
// Markers of Transformers.js (its download path template) and of ONNX Runtime (its binary's name).
for (const url of manifest.precache.filter((/** @type {string} */ u) => u.endsWith('.js'))) {
  const code = sources.get(url) ?? '';
  if (code.includes('{model}/resolve/{revision}/') || code.includes('ort-wasm-simd-threaded.wasm')) problems.push(`${url} is precached but contains the WASM runtime`);
}

// 6. First-load budget: the scripts of the page and everything they import statically.
/** @type {Set<string>} */
const initial = new Set();
const pending = pageScripts(html).filter((src) => src.startsWith('/assets/'));
while (pending.length > 0) {
  const url = /** @type {string} */ (pending.pop());
  if (initial.has(url)) continue;
  initial.add(url);
  const code = sources.get(url);
  if (code === undefined) {
    problems.push(`the page loads ${url}, which is not a script of the build`);
    continue;
  }
  pending.push(...staticImports(code, url));
}
const initialBytes = [...initial].reduce((sum, url) => sum + Buffer.byteLength(sources.get(url) ?? ''), 0);
if (initialBytes > INITIAL_JS_BUDGET_BYTES) {
  problems.push(
    `initial JavaScript is ${initialBytes} bytes, over its budget of ${INITIAL_JS_BUDGET_BYTES} (2.1.0 baseline ${INITIAL_JS_BASELINE_BYTES} + ${INITIAL_JS_HEADROOM * 100} %); load the new code lazily`,
  );
}
for (const url of initial) if (!manifest.precache.includes(url)) problems.push(`${url} is part of the first load but not precached`);
// The workspace works offline only when everything the ingest worker imports statically is precached.
const workerScripts = new Set();
const workerPending = [manifest.entries.ingestWorkerJs];
while (workerPending.length > 0) {
  const url = /** @type {string} */ (workerPending.pop());
  if (workerScripts.has(url)) continue;
  workerScripts.add(url);
  workerPending.push(...staticImports(sources.get(url) ?? '', url));
}
for (const url of workerScripts) if (!manifest.precache.includes(url)) problems.push(`${url} is loaded by the ingest worker but not precached`);

// 7. The headers of the build profile are strict and isolating: the page's CSP, cross-origin
// isolation (COOP + COEP, CORP same-origin), no referrer, and Google named only by the profile
// public, as exactly the Live socket.
const page = headersFor(rules, '/');
const csp = page.get('content-security-policy')?.value;
if (!csp) problems.push(`header profile ${profile} has no Content-Security-Policy for /`);
else {
  if (/'unsafe-(?:inline|eval|hashes)'/.test(csp)) problems.push('the page CSP allows unsafe-inline, unsafe-eval or unsafe-hashes');
  const directives = parseCsp(csp);
  if (!isDeepStrictEqual(directives['script-src'], ["'self'", "'wasm-unsafe-eval'"])) problems.push(`unexpected script-src: ${directives['script-src']?.join(' ')}`);
  for (const name of ['object-src', 'base-uri', 'frame-ancestors', 'form-action']) {
    if (!isDeepStrictEqual(directives[name], ["'none'"])) problems.push(`CSP ${name} must be 'none'`);
  }
  for (const name of ['worker-src', 'frame-src']) if (!isDeepStrictEqual(directives[name], ["'self'"])) problems.push(`CSP ${name} must be 'self'`);
  if ((directives['img-src'] ?? []).some((source) => /^https?:/.test(source) || source === '*')) problems.push('CSP img-src allows remote images (exfiltration beacons)');
  const connect = directives['connect-src'] ?? [];
  if (connect.some((source) => /^(?:\*|wss?:|http:)$/.test(source))) problems.push('CSP connect-src allows every host of a scheme');
  const google = connect.filter((source) => /google/i.test(source));
  if (!isDeepStrictEqual(google, profile === 'public' ? [LIVE_SOCKET_SOURCE] : [])) problems.push(`CSP connect-src of profile ${profile} names Google as ${google.join(' ') || 'nothing'}`);
}
for (const [name, value] of /** @type {const} */ ([
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-embedder-policy', 'require-corp'],
  ['cross-origin-resource-policy', 'same-origin'],
  ['origin-agent-cluster', '?1'],
  ['referrer-policy', 'no-referrer'],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
])) {
  if (page.get(name)?.value !== value) problems.push(`profile ${profile} must send ${name}: ${value} (got ${page.get(name)?.value ?? 'nothing'})`);
}

// 8. Header parity: every file of the build is served with the page's security headers, except the
// sandboxed frames by their exact paths, whose own rules are checked here.
for (const url of FRAME_PATHS) {
  const own = headersFor(rules, url);
  const frameCsp = own.get('content-security-policy')?.value;
  if (url.startsWith('/grounding-frame') && CORE_PROFILES.includes(profile)) {
    if (frameCsp !== csp) problems.push(`profile ${profile} must not serve a grounding frame (${url} has headers of its own)`);
    continue;
  }
  const directives = parseCsp(frameCsp ?? '');
  const sandbox = directives.sandbox;
  if (!sandbox || sandbox.includes('allow-same-origin')) problems.push(`${url} must be sandboxed into an opaque origin (CSP sandbox without allow-same-origin)`);
  if (!isDeepStrictEqual(directives['default-src'], ["'none'"])) problems.push(`${url}: CSP default-src must be 'none'`);
  if (!isDeepStrictEqual(directives['frame-ancestors'], ["'self'"])) problems.push(`${url}: CSP frame-ancestors must be 'self'`);
  if ((directives['connect-src'] ?? ["'none'"]).join(' ') !== "'none'") problems.push(`${url}: the frame must not connect anywhere`);
  if (!(directives['script-src'] ?? []).includes("'self'")) problems.push(`${url}: CSP script-src must allow the frame's own script`);
  if (own.get('x-frame-options')?.value !== 'SAMEORIGIN') problems.push(`${url} must send X-Frame-Options: SAMEORIGIN`);
  if (own.get('cross-origin-resource-policy')?.value !== 'cross-origin') problems.push(`${url} must send Cross-Origin-Resource-Policy: cross-origin`);
  if (own.get('cross-origin-embedder-policy')?.value !== 'require-corp') problems.push(`${url} must keep Cross-Origin-Embedder-Policy: require-corp`);
}
for (const entry of await readdir(DIST, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const url = `/${path.relative(DIST, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')}`;
  for (const served of url === '/index.html' ? ['/', url] : [url]) {
    if (!isDeepStrictEqual(parityOf(headersFor(rules, served)), expectedParity(rules, served))) problems.push(`${served} is served with other security headers than the page`);
  }
}
const vercel = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
if (!isDeepStrictEqual(vercel.headers, resolveHeaderRules(DEFAULT_PROFILE))) problems.push('vercel.json headers differ from scripts/headers.json; run npm run headers:gen');
// The companion applies the rules it finds next to the build.
if (CORE_PROFILES.includes(profile)) {
  const served = await readFile(path.join(DIST, 'headers.json'), 'utf8').then((text) => JSON.parse(text)).catch(() => null);
  if (!served || served.profile !== profile || served.digest !== digest || !isDeepStrictEqual(served.rules, rules)) problems.push('dist/headers.json is missing or differs from scripts/headers.json; rebuild');
}

if (problems.length > 0) {
  console.error(`verify-dist: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
const share = ((initialBytes / INITIAL_JS_BASELINE_BYTES - 1) * 100).toFixed(1);
console.log(
  `verify-dist: OK (version ${manifest.version}, profile ${profile}, ${manifest.assets.length} assets, ${manifest.precache.length} precached, initial JS ${initialBytes} bytes = ${share} % against 2.1.0, budget ${INITIAL_JS_BUDGET_BYTES})`,
);
