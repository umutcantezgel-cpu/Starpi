#!/usr/bin/env node
// Production build: Tailwind (v3 CLI) -> esbuild bundle (JS, worker, CSS, fonts) -> hashed assets,
// rewritten index.html, generated service worker and a build manifest consumed by verify-dist.mjs.
//
// Usage: node scripts/build.mjs [--watch] [--serve]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

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

const WORKER_PLACEHOLDER = '__STARPI_WEBLLM_WORKER_URL__';
const INGEST_WORKER_PLACEHOLDER = '__STARPI_INGEST_WORKER_URL__';

assertAnonKey(SUPABASE_ANON_KEY);

/** Refuses to ship anything but an anon-role JWT (never a service_role key) to the browser. */
function assertAnonKey(jwt) {
  const [, payload] = jwt.split('.');
  let role;
  try {
    role = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role;
  } catch {
    throw new Error('STARPI_SUPABASE_ANON_KEY is not a valid JWT');
  }
  if (role !== 'anon') {
    throw new Error(`STARPI_SUPABASE_ANON_KEY must have role "anon", got "${role}"`);
  }
}

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

/** @type {import('esbuild').BuildOptions} */
const esbuildOptions = {
  absWorkingDir: ROOT,
  entryPoints: {
    main: 'src/js/main.js',
    'webllm-worker': 'src/js/webgpu/worker.js',
    'ingest-worker': 'src/js/rag/ingest.worker.js',
    app: 'src/styles/entry.css',
  },
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
  define: {
    __STARPI_SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
    __STARPI_SUPABASE_ANON_KEY__: JSON.stringify(SUPABASE_ANON_KEY),
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

/** @param {import('esbuild').BuildResult} result */
async function postProcess(result) {
  if (!result.metafile) throw new Error('esbuild did not return a metafile');
  const entries = outputsByEntry(result.metafile);
  const mainJs = entries['src/js/main.js'];
  const workerJs = entries['src/js/webgpu/worker.js'];
  const ingestWorkerJs = entries['src/js/rag/ingest.worker.js'];
  const appCss = entries['src/styles/entry.css'];
  if (!mainJs || !workerJs || !ingestWorkerJs || !appCss) throw new Error(`missing entry outputs: ${JSON.stringify(entries)}`);

  const outputs = Object.keys(result.metafile.outputs).map((f) => path.join(ROOT, f));
  const jsOutputs = outputs.filter((f) => f.endsWith('.js'));

  // The worker URL is only known after bundling; patch it into the chunk that references it.
  let patchedWebllm = 0;
  let patchedIngest = 0;
  for (const file of jsOutputs) {
    let code = await readFile(file, 'utf8');
    let changed = false;
    if (code.includes(WORKER_PLACEHOLDER)) {
      code = code.replaceAll(WORKER_PLACEHOLDER, workerJs);
      patchedWebllm += 1;
      changed = true;
    }
    if (code.includes(INGEST_WORKER_PLACEHOLDER)) {
      code = code.replaceAll(INGEST_WORKER_PLACEHOLDER, ingestWorkerJs);
      patchedIngest += 1;
      changed = true;
    }
    if (changed) {
      await writeFile(file, code);
    }
  }
  if (patchedWebllm === 0) throw new Error('worker URL placeholder not found in any output chunk');
  if (patchedIngest === 0) throw new Error('ingest worker URL placeholder not found in any output chunk');

  const publicFiles = await copyPublic();
  const assetUrls = outputs
    .filter((f) => !f.endsWith('.map') && !f.endsWith('.LEGAL.txt'))
    .map((f) => '/' + path.relative(DIST, f).split(path.sep).join('/'));

  const html = (await readFile(path.join(SRC, 'index.html'), 'utf8'))
    .replace('%STARPI_APP_CSS%', appCss)
    .replace('%STARPI_MAIN_JS%', mainJs);
  if (html.includes('%STARPI_')) throw new Error('unresolved placeholder in src/index.html');
  await writeFile(path.join(DIST, 'index.html'), html);

  const version = createHash('sha256')
    .update(html)
    .update(assetUrls.sort().join('\n'))
    .digest('hex')
    .slice(0, 12);

  // Precache only the app shell; lazily loaded chunks (WebLLM, fonts) are cached on first use.
  const shell = ['/', '/index.html', appCss, mainJs, ...directImports(result.metafile, mainJs), ...publicFiles];
  const sw = (await readFile(path.join(SRC, 'sw.js'), 'utf8'))
    .replace("'__STARPI_BUILD_VERSION__'", JSON.stringify(version))
    .replace("['__STARPI_PRECACHE__']", JSON.stringify([...new Set(shell)]));
  if (sw.includes('__STARPI_')) throw new Error('unresolved placeholder in src/sw.js');
  await writeFile(path.join(DIST, 'sw.js'), sw);

  await writeFile(
    path.join(DIST, 'build-manifest.json'),
    JSON.stringify({ version, entries: { mainJs, workerJs, ingestWorkerJs, appCss }, assets: assetUrls.sort(), precache: shell }, null, 2),
  );
  return { version, mainJs, workerJs, ingestWorkerJs, appCss };
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

async function buildOnce() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  runTailwind();
  const result = await esbuild.build(esbuildOptions);
  if (reportWarnings(result)) throw new Error('esbuild emitted warnings; the build treats warnings as errors');
  return postProcess(result);
}

async function main() {
  const started = performance.now();
  const info = await buildOnce();
  console.log(`built ${info.mainJs} ${info.appCss} (version ${info.version}) in ${Math.round(performance.now() - started)} ms`);

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
    spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs'), '--port', '3000'], { cwd: ROOT, stdio: 'inherit' });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
