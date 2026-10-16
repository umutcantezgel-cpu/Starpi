#!/usr/bin/env node
// Production build: Tailwind (v3 CLI) -> esbuild bundle (JS, workers, CSS, fonts) -> hashed assets
// plus the ONNX Runtime binary, rewritten index.html, generated service worker and a build manifest
// consumed by verify-dist.mjs.
//
// The header profile (STARPI_HEADER_PROFILE, default "public") picks the response headers of
// scripts/headers.json. Their digest is part of the build version, so a changed header reaches every
// installed service worker, and the manifest records profile and digest for serve.mjs and
// verify-dist.mjs. A build for a profile the companion serves also gets dist/headers.json.
//
// Optional sources join the build once they exist: the lazy rendering extras
// (src/js/render-extras.js), the blocking theme script (src/js/theme-boot.js, a classic script in
// <head> so the first paint has the right theme) and the scripts of the sandboxed frames
// (public/render-frame.js, public/grounding-frame.js, bundled into one classic file each).
//
// Usage: node scripts/build.mjs [--watch] [--serve]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { buildVersion } from './lib/build-version.mjs';
import { BUILD_PROFILES, CORE_PROFILES, DEFAULT_PROFILE, headersDigest, resolveHeaderRules } from './lib/headers.mjs';
import { injectThemeBoot } from './lib/html.mjs';
import { assertPublicKey } from './lib/supabase-key.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(ROOT, '.build');
const ASSETS = path.join(DIST, 'assets');

const args = new Set(process.argv.slice(2));
const WATCH = args.has('--watch');
const SERVE = args.has('--serve');

// Public, RLS-protected project defaults. Forks override them at build time.
const SUPABASE_URL = process.env.STARPI_SUPABASE_URL || 'https://behnltoogscnbjhvixmw.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.STARPI_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlaG5sdG9vZ3NjbmJqaHZpeG13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NzMwMTgsImV4cCI6MjA5NDM0OTAxOH0.NNdRrOYLzucKuQfz4bVPPWOhYvgVswDiEtvCrtphF0I';

const APP_VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

const WORKER_PLACEHOLDER = '__STARPI_WEBLLM_WORKER_URL__';
const INGEST_WORKER_PLACEHOLDER = '__STARPI_INGEST_WORKER_URL__';
const WASM_WORKER_PLACEHOLDER = '__STARPI_WASM_WORKER_URL__';
const ORT_WASM_PLACEHOLDER = '__STARPI_ORT_WASM_URL__';
const RENDER_EXTRAS_PLACEHOLDER = '__STARPI_RENDER_EXTRAS_URL__';

const RENDER_EXTRAS = 'src/js/render-extras.js';
const THEME_BOOT = 'src/js/theme-boot.js';
/** Scripts of the sandboxed frames: served at these exact paths, under their own header rules. */
const FRAME_SCRIPTS = ['render-frame.js', 'grounding-frame.js'];

assertPublicKey(SUPABASE_ANON_KEY);

const PROFILE = process.env.STARPI_HEADER_PROFILE || DEFAULT_PROFILE;
if (!BUILD_PROFILES.includes(PROFILE)) {
  throw new Error(`STARPI_HEADER_PROFILE is "${PROFILE}", expected one of ${BUILD_PROFILES.join(', ')} (scripts/headers.json)`);
}
const HEADER_RULES = resolveHeaderRules(PROFILE);
const HEADERS_DIGEST = headersDigest(HEADER_RULES);

/** @param {string} file relative to the repository root */
const present = (file) => existsSync(path.join(ROOT, file));

/** Packages the license gate skips because the browser build never bundles them (scripts/license-allowlist.json). */
const NOT_SHIPPED = Object.keys(JSON.parse(await readFile(path.join(ROOT, 'scripts', 'license-allowlist.json'), 'utf8')).notShipped ?? {});

/**
 * Fails when a bundle contains code of a package the license gate assumes is never shipped.
 * @param {import('esbuild').Metafile} metafile
 */
function assertNotShipped(metafile) {
  for (const input of Object.keys(metafile.inputs)) {
    const name = NOT_SHIPPED.find((pkg) => input.includes(`node_modules/${pkg}/`));
    if (name) throw new Error(`${input} is bundled, but scripts/license-allowlist.json lists ${name} as never shipped`);
  }
}

/**
 * Transformers.js imports onnxruntime-web/webgpu, whose bundle uses new Function() (blocked by the
 * CSP and by verify-dist), and takes its Tensor class from a second copy of onnxruntime-common.
 * Starpi runs ONNX models on the processor only, so both resolve to the WASM build, which has the
 * same exports: one ONNX Runtime with one Tensor class ships.
 * @type {import('esbuild').Plugin}
 */
const ortWasmOnly = {
  name: 'ort-wasm-only',
  setup(build) {
    build.onResolve({ filter: /^(onnxruntime-web\/webgpu|onnxruntime-common)$/ }, async (args) => {
      const resolved = await build.resolve('onnxruntime-web/wasm', { kind: args.kind, resolveDir: args.resolveDir });
      return resolved.errors.length > 0 ? { errors: resolved.errors } : { path: resolved.path, namespace: resolved.namespace, sideEffects: resolved.sideEffects };
    });
  },
};

/** Placeholders for URLs that are only known after bundling, mapped to the output that replaces them. */
const URL_PLACEHOLDERS = Object.freeze({
  [WORKER_PLACEHOLDER]: 'src/js/webgpu/worker.js',
  [INGEST_WORKER_PLACEHOLDER]: 'src/js/rag/ingest.worker.js',
  [WASM_WORKER_PLACEHOLDER]: 'src/js/wasm/worker.js',
  [ORT_WASM_PLACEHOLDER]: 'ort-wasm-simd-threaded.wasm',
  [RENDER_EXTRAS_PLACEHOLDER]: RENDER_EXTRAS,
});
/** Placeholders a source may use but need not: their entry is optional, or nothing refers to it by URL. */
const OPTIONAL_PLACEHOLDERS = new Set([RENDER_EXTRAS_PLACEHOLDER]);
/** URLs to put in place of the placeholders in the current bundling pass (empty in the first). */
let urlValues = /** @type {Map<string, string>} */ (new Map());
/** Placeholders met in the current pass. */
const seenPlaceholders = new Set();

/**
 * Writes the worker and runtime URLs into the sources while esbuild loads them, so every output is
 * hashed with its final content. Patching the bundles afterwards would change a file without
 * changing its name, and browsers keep /assets/* for a year (immutable).
 * @type {import('esbuild').Plugin}
 */
const assetUrlPlugin = {
  name: 'starpi-asset-urls',
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]js[\\/].+\.js$/ }, async (args) => {
      const code = await readFile(args.path, 'utf8');
      const found = Object.keys(URL_PLACEHOLDERS).filter((placeholder) => code.includes(placeholder));
      if (found.length === 0) return undefined;
      let contents = code;
      for (const placeholder of found) {
        seenPlaceholders.add(placeholder);
        const url = urlValues.get(placeholder);
        if (url) contents = contents.replaceAll(placeholder, url);
      }
      return { contents, loader: 'js' };
    });
  },
};

function runTailwind() {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');
  const result = spawnSync(
    bin,
    ['-c', 'tailwind.config.js', '-i', 'src/styles/app.css', '-o', '.build/tailwind.css', '--minify'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tailwindcss failed:\n${result.stderr}`);
  }
}

/**
 * Entry points of the module build. The rendering extras are a lazy entry of their own once the file
 * exists (a hashed URL the app can import on demand, never part of the first load).
 * @returns {Record<string, string>}
 */
function entryPoints() {
  return {
    main: 'src/js/main.js',
    'webllm-worker': 'src/js/webgpu/worker.js',
    'ingest-worker': 'src/js/rag/ingest.worker.js',
    'wasm-worker': 'src/js/wasm/worker.js',
    ...(present(RENDER_EXTRAS) ? { 'render-extras': RENDER_EXTRAS } : {}),
    app: 'src/styles/entry.css',
  };
}

/** @type {import('esbuild').BuildOptions} */
const esbuildOptions = {
  absWorkingDir: ROOT,
  outdir: ASSETS,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'chrome113', 'safari17', 'firefox121'],
  minify: true,
  sourcemap: 'linked',
  legalComments: 'linked',
  entryNames: '[name]-[hash]',
  chunkNames: 'chunk-[hash]',
  assetNames: '[name]-[hash]',
  metafile: true,
  logLevel: 'silent',
  loader: { '.woff2': 'file', '.woff': 'file' },
  plugins: [ortWasmOnly, assetUrlPlugin],
  define: {
    __STARPI_SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
    __STARPI_SUPABASE_ANON_KEY__: JSON.stringify(SUPABASE_ANON_KEY),
    __STARPI_VERSION__: JSON.stringify(APP_VERSION),
  },
};

/** @param {import('esbuild').Metafile} metafile */
function outputsByEntry(metafile) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const [outFile, meta] of Object.entries(metafile.outputs)) {
    if (meta.entryPoint) map[meta.entryPoint] = '/' + path.relative(DIST, path.join(ROOT, outFile)).split(path.sep).join('/');
  }
  return map;
}

/** Shared by the classic scripts: one file each, no imports at run time. */
const classicOptions = /** @type {const} */ ({
  absWorkingDir: ROOT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: esbuildOptions.target,
  minify: true,
  metafile: true,
  logLevel: 'silent',
});

/**
 * The theme script as a classic, render-blocking script in <head> (no module: it must run before the
 * first paint). Returns its URL, or null while src/js/theme-boot.js does not exist.
 * @returns {Promise<{ url: string, files: string[] } | null>}
 */
async function buildThemeBoot() {
  if (!present(THEME_BOOT)) return null;
  const result = await esbuild.build({
    ...classicOptions,
    entryPoints: { 'theme-boot': THEME_BOOT },
    outdir: ASSETS,
    entryNames: '[name]-[hash]',
    sourcemap: 'linked',
    legalComments: 'linked',
  });
  if (reportWarnings(result)) throw new Error('esbuild emitted warnings for the theme script');
  const files = Object.keys(/** @type {import('esbuild').Metafile} */ (result.metafile).outputs).map((f) => '/' + path.relative(DIST, path.join(ROOT, f)).split(path.sep).join('/'));
  const url = files.find((f) => f.endsWith('.js'));
  if (!url) throw new Error('the theme script produced no JavaScript');
  return { url, files };
}

/**
 * Bundles the frame scripts that exist in public/ into one classic file each, in place of the copy
 * in dist/. A sandboxed frame has an opaque origin, so it can load only its own exact-path script
 * (CORP cross-origin there); a frame script therefore never imports anything at run time.
 * @returns {Promise<string[]>} the bundled URLs
 */
async function bundleFrameScripts() {
  /** @type {string[]} */
  const bundled = [];
  for (const name of FRAME_SCRIPTS) {
    if (!present(`public/${name}`)) continue;
    const result = await esbuild.build({ ...classicOptions, entryPoints: [`public/${name}`], outfile: path.join(DIST, name), legalComments: 'eof' });
    if (reportWarnings(result)) throw new Error(`esbuild emitted warnings for public/${name}`);
    assertNotShipped(/** @type {import('esbuild').Metafile} */ (result.metafile));
    bundled.push(`/${name}`);
  }
  return bundled;
}

/**
 * @param {import('esbuild').BuildResult} result
 * @param {Map<string, string>} urls the URLs this pass wrote into the sources
 */
async function postProcess(result, urls) {
  if (!result.metafile) throw new Error('esbuild did not return a metafile');
  const entries = outputsByEntry(result.metafile);
  const mainJs = entries['src/js/main.js'];
  const workerJs = entries['src/js/webgpu/worker.js'];
  const ingestWorkerJs = entries['src/js/rag/ingest.worker.js'];
  const wasmWorkerJs = entries['src/js/wasm/worker.js'];
  const appCss = entries['src/styles/entry.css'];
  if (!mainJs || !workerJs || !ingestWorkerJs || !wasmWorkerJs || !appCss) throw new Error(`missing entry outputs: ${JSON.stringify(entries)}`);
  const renderExtrasJs = entries[RENDER_EXTRAS] ?? null;
  const ortWasm = /** @type {string} */ (urls.get(ORT_WASM_PLACEHOLDER));
  for (const placeholder of Object.keys(URL_PLACEHOLDERS)) {
    if (!seenPlaceholders.has(placeholder) && !OPTIONAL_PLACEHOLDERS.has(placeholder)) throw new Error(`${placeholder} not found in any source file`);
  }

  const outputs = Object.keys(result.metafile.outputs).map((f) => path.join(ROOT, f));

  const publicFiles = await copyPublic();
  const frameScripts = await bundleFrameScripts();
  const themeBoot = await buildThemeBoot();
  const assetUrls = [...outputs.map((f) => '/' + path.relative(DIST, f).split(path.sep).join('/')), ...(themeBoot?.files ?? [])].filter(
    (f) => !f.endsWith('.map') && !f.endsWith('.LEGAL.txt'),
  );
  assetUrls.push(ortWasm);
  const themeBootJs = themeBoot?.url ?? null;

  const page = (await readFile(path.join(SRC, 'index.html'), 'utf8')).replace('%STARPI_APP_CSS%', appCss).replace('%STARPI_MAIN_JS%', mainJs);
  const html = injectThemeBoot(page, themeBootJs);
  if (html.includes('%STARPI_')) throw new Error('unresolved placeholder in src/index.html');
  await writeFile(path.join(DIST, 'index.html'), html);

  const swTemplate = await readFile(path.join(SRC, 'sw.js'), 'utf8');
  const publicBytes = await Promise.all(publicFiles.map(async (url) => ({ url, bytes: await readFile(path.join(DIST, url.slice(1))) })));
  assetUrls.sort();
  const version = buildVersion({ html, assetUrls, publicFiles: publicBytes, swTemplate, headersDigest: HEADERS_DIGEST });

  // Precache the app shell: the page, its CSS and JS (the theme script included), the ingest worker
  // (the workspace must work offline), the Latin font and the public files. WebLLM, pdf.js, the WASM
  // worker (Transformers.js), the rendering extras and the ONNX Runtime binary are cached on first use.
  const latinFont = assetUrls.find((u) => /plus-jakarta-sans-latin-wght-normal-[\w-]+\.woff2$/.test(u));
  const shell = [
    '/',
    appCss,
    ...(themeBootJs ? [themeBootJs] : []),
    mainJs,
    ingestWorkerJs,
    ...(latinFont ? [latinFont] : []),
    ...directImports(result.metafile, mainJs),
    ...publicFiles,
  ];
  const sw = swTemplate
    .replace("'__STARPI_BUILD_VERSION__'", JSON.stringify(version))
    .replace("['__STARPI_PRECACHE__']", JSON.stringify([...new Set(shell)]))
    .replace("['__STARPI_ASSETS__']", JSON.stringify(assetUrls));
  if (sw.includes('__STARPI_')) throw new Error('unresolved placeholder in src/sw.js');
  await writeFile(path.join(DIST, 'sw.js'), sw);

  await writeFile(
    path.join(DIST, 'build-manifest.json'),
    JSON.stringify(
      {
        version,
        profile: PROFILE,
        headersDigest: HEADERS_DIGEST,
        entries: { mainJs, workerJs, ingestWorkerJs, wasmWorkerJs, ortWasm, appCss, themeBootJs, renderExtrasJs },
        assets: assetUrls,
        public: [...publicFiles].sort(),
        frames: frameScripts,
        precache: shell,
      },
      null,
      2,
    ),
  );
  // The companion serves its build itself and applies these rules to every response.
  if (CORE_PROFILES.includes(PROFILE)) {
    await writeFile(path.join(DIST, 'headers.json'), `${JSON.stringify({ profile: PROFILE, digest: HEADERS_DIGEST, rules: HEADER_RULES }, null, 2)}\n`);
  }
  return { version, mainJs, workerJs, ingestWorkerJs, wasmWorkerJs, ortWasm, appCss };
}

/**
 * Copies the ONNX Runtime binary from the package whose glue was bundled, so their versions always
 * match, to a content-hashed /assets URL.
 * @param {import('esbuild').Metafile} metafile
 */
async function copyOrtWasm(metafile) {
  const glue = Object.keys(metafile.inputs).find((p) => /(^|\/)onnxruntime-web\/dist\/ort\.wasm\.bundle\.min\.mjs$/.test(p));
  if (!glue) throw new Error('onnxruntime-web/wasm was not bundled (is the ort-wasm-only plugin active?)');
  const bytes = await readFile(path.join(ROOT, path.dirname(glue), 'ort-wasm-simd-threaded.wasm'));
  const url = `/assets/ort-wasm-simd-threaded-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.wasm`;
  await writeFile(path.join(DIST, url.slice(1)), bytes);
  return url;
}

/** Static chunks imported by the main entry (needed to boot offline). */
function directImports(metafile, mainUrl) {
  const mainKey = Object.keys(metafile.outputs).find((k) => k.endsWith(mainUrl.slice(1)));
  if (!mainKey) return [];
  return metafile.outputs[mainKey].imports
    .filter((i) => i.kind === 'import-statement' && !i.external)
    .map((i) => '/' + path.relative(DIST, path.join(ROOT, i.path)).split(path.sep).join('/'));
}

async function copyPublic() {
  const pub = path.join(ROOT, 'public');
  await cp(pub, DIST, { recursive: true });
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(pub, { recursive: true, withFileTypes: true });
  return files
    .filter((d) => d.isFile())
    .map((d) => '/' + path.relative(pub, path.join(d.parentPath, d.name)).split(path.sep).join('/'));
}

function reportWarnings(result) {
  if (result.warnings.length === 0) return false;
  const text = esbuild.formatMessagesSync(result.warnings, { kind: 'warning', color: process.stdout.isTTY });
  process.stderr.write(text.join('\n'));
  return true;
}

/**
 * The URLs of this pass's workers and of the ONNX Runtime binary (copied into dist here).
 * @param {import('esbuild').Metafile} metafile
 */
async function resolveUrls(metafile) {
  const entries = outputsByEntry(metafile);
  /** @type {Map<string, string>} */
  const urls = new Map();
  for (const [placeholder, entry] of Object.entries(URL_PLACEHOLDERS)) {
    const url = placeholder === ORT_WASM_PLACEHOLDER ? await copyOrtWasm(metafile) : entries[entry];
    if (!url && OPTIONAL_PLACEHOLDERS.has(placeholder) && !present(entry)) continue;
    if (!url) throw new Error(`no output for ${entry}`);
    urls.set(placeholder, url);
  }
  return urls;
}

/**
 * Bundles until the URLs written into the sources are the URLs of the outputs: a worker's name
 * depends on its content, which can contain another URL (the WASM worker holds the ONNX Runtime's),
 * so this takes three passes.
 */
async function buildOnce() {
  await mkdir(TMP, { recursive: true });
  runTailwind();
  urlValues = new Map();
  for (let pass = 1; ; pass++) {
    await rm(DIST, { recursive: true, force: true });
    seenPlaceholders.clear();
    const result = await esbuild.build({ ...esbuildOptions, entryPoints: entryPoints() });
    if (reportWarnings(result)) throw new Error('esbuild emitted warnings; the build treats warnings as errors');
    if (!result.metafile) throw new Error('esbuild did not return a metafile');
    assertNotShipped(result.metafile);
    const urls = await resolveUrls(result.metafile);
    if ([...urls].every(([placeholder, url]) => urlValues.get(placeholder) === url)) return postProcess(result, urls);
    if (pass === 4) throw new Error('worker URLs did not settle after 4 bundling passes');
    urlValues = urls;
  }
}

async function main() {
  const started = performance.now();
  const info = await buildOnce();
  console.log(`built ${info.mainJs} ${info.appCss} (version ${info.version}, header profile ${PROFILE}) in ${Math.round(performance.now() - started)} ms`);

  if (!WATCH) return;

  const { watch } = await import('node:fs');
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const next = await buildOnce();
        console.log(`rebuilt (version ${next.version})`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
      }
    }, 120);
  };
  watch(SRC, { recursive: true }, rebuild);
  watch(path.join(ROOT, 'public'), { recursive: true }, rebuild);

  if (SERVE) {
    spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs'), '--port', '3000', '--functions'], { cwd: ROOT, stdio: 'inherit' });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
