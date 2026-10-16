// Production headers in the browser, against scripts/serve.mjs (the headers of scripts/headers.json
// for the profile of the build): header parity over every file the build ships, cross-origin
// isolation of the page and of its workers, the WASM runtime, pdf.js and CORS fetches (Supabase,
// the model hub) under COEP require-corp, and no CSP violation or console error on any main view.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedParity, FRAME_PATHS, headersFor, PARITY_HEADERS, parseCsp, resolveHeaderRules } from '../../scripts/lib/headers.mjs';
import { makePdf } from '../fixtures/pdf.mjs';
import { expect, mockSupabase, test } from './fixtures.mjs';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const ISOLATED = { crossOriginIsolated: true, sharedArrayBuffer: true, sharedWasmMemory: true };
const MAIN_VIEWS = ['chat', 'library', 'graph', 'ingest', 'bench', 'settings'];

/**
 * @typedef {{ version: string, profile: string, entries: Record<string, string | null>, assets: string[], public: string[], precache: string[] }} BuildManifest
 */

/**
 * @param {import('@playwright/test').APIRequestContext} request
 * @returns {Promise<BuildManifest>}
 */
async function buildManifest(request) {
  const res = await request.get('/build-manifest.json');
  if (!res.ok()) throw new Error('no /build-manifest.json; run npm run build first');
  return res.json();
}

/**
 * What cross-origin isolation unlocks, in whatever global it runs (page or worker). Self-contained:
 * it is serialized into the browser.
 */
function isolationProbe() {
  /** @param {() => boolean} check */
  const holds = (check) => {
    try {
      return check();
    } catch {
      return false;
    }
  };
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: holds(() => typeof SharedArrayBuffer === 'function' && new SharedArrayBuffer(8).byteLength === 8),
    sharedWasmMemory: holds(() => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer instanceof SharedArrayBuffer),
  };
}

/**
 * Compiles a string as code in a later task (DevTools evaluations may bypass the CSP) and reports
 * whether the CSP refused it. Self-contained.
 * @returns {Promise<'blocked' | 'allowed'>}
 */
function evalProbe() {
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        // eslint-disable-next-line no-new-func -- the probe: the CSP must refuse string compilation
        new Function('return 1')();
        resolve('allowed');
      } catch {
        resolve('blocked');
      }
    }, 0);
  });
}

/**
 * Starts a module worker from a URL of the build and returns its Playwright handle.
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 */
async function startWorker(page, url) {
  const absolute = new URL(url, page.url()).href;
  const [worker] = await Promise.all([
    page.waitForEvent('worker', (w) => w.url() === absolute),
    page.evaluate((src) => {
      const list = /** @type {Worker[]} */ ((/** @type {any} */ (window).__probeWorkers ??= []));
      list.push(new Worker(src, { type: 'module' }));
    }, url),
  ]);
  return worker;
}

/**
 * Terminates the workers startWorker() started.
 * @param {import('@playwright/test').Page} page
 */
async function stopWorkers(page) {
  await page.evaluate(() => {
    for (const worker of /** @type {Worker[]} */ ((/** @type {any} */ (window).__probeWorkers ?? []))) worker.terminate();
    /** @type {any} */ (window).__probeWorkers = [];
  });
}

/** @param {import('@playwright/test').Page} page @param {string} tab */
async function openTab(page, tab) {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page.click(isMobile ? `#mobile-nav-${tab}` : `#nav-${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

/**
 * Removes the diagnostics a test provoked on purpose and returns them.
 * @param {string[]} diagnostics
 * @param {RegExp[]} expected
 */
function takeExpected(diagnostics, expected) {
  const taken = diagnostics.filter((d) => expected.some((re) => re.test(d)));
  diagnostics.splice(0, diagnostics.length, ...diagnostics.filter((d) => !taken.includes(d)));
  return taken;
}

test.describe('header parity', () => {
  test('serves every file of the build with the security headers of scripts/headers.json', async ({ request }) => {
    const manifest = await buildManifest(request);
    const rules = resolveHeaderRules(manifest.profile);
    const entries = await readdir(DIST, { recursive: true, withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => `/${path.relative(DIST, path.join(e.parentPath, e.name)).split(path.sep).join('/')}`);
    for (const url of [...manifest.assets, ...manifest.public, '/index.html', '/sw.js']) expect(files).toContain(url);
    // Clean URLs of the frames the build ships (Vercel cleanUrls, serve.mjs alike).
    const cleanFrames = FRAME_PATHS.filter((p) => !/\.\w+$/.test(p) && files.includes(`${p}.html`));
    const urls = ['/', ...cleanFrames, ...files];

    /** @type {Record<string, Record<string, string | undefined>>} */
    const served = {};
    /** @type {Record<string, Record<string, string | undefined>>} */
    const wanted = {};
    for (const url of urls) {
      const res = await request.head(url);
      expect(res.status(), `HEAD ${url}`).toBe(200);
      served[url] = Object.fromEntries(PARITY_HEADERS.map((name) => [name, res.headers()[name]]));
      wanted[url] = expectedParity(rules, url);
    }
    expect(served).toEqual(wanted);

    const page = headersFor(rules, '/');
    expect(page.get('cross-origin-opener-policy')?.value).toBe('same-origin');
    expect(page.get('cross-origin-embedder-policy')?.value).toBe('require-corp');
    expect(page.get('cross-origin-resource-policy')?.value).toBe('same-origin');
    expect(page.get('referrer-policy')?.value).toBe('no-referrer');
    const csp = parseCsp(page.get('content-security-policy')?.value ?? '');
    expect(csp['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp['frame-src']).toEqual(["'self'"]);
    expect(csp['connect-src'].filter((s) => /google/i.test(s))).toEqual(manifest.profile === 'public' ? ['wss://generativelanguage.googleapis.com'] : []);
  });
});

test.describe('cross-origin isolation', () => {
  test('isolates the page and its workers, and the WASM runtime, pdf.js and CORS fetches keep working', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // A stand-in for the model hub that answers with CORS, as the real one does.
    const hub = 'https://huggingface.co/mlc-ai/probe/resolve/main/mlc-chat-config.json';
    await page.route(hub, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"probe":true}' }));
    await page.goto('/');
    // Supabase answers through CORS under COEP.
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');
    expect(await page.evaluate(isolationProbe)).toEqual(ISOLATED);

    const manifest = await buildManifest(page.request);
    for (const url of [manifest.entries.ingestWorkerJs, manifest.entries.wasmWorkerJs, manifest.entries.workerJs]) {
      const worker = await startWorker(page, /** @type {string} */ (url));
      expect(await worker.evaluate(isolationProbe), url ?? '').toEqual(ISOLATED);
      expect(await worker.evaluate(evalProbe), url ?? '').toBe('blocked');
      await stopWorkers(page);
    }
    // The self-hosted ONNX Runtime binary compiles in an isolated worker, with shared memory.
    const wasmWorker = await startWorker(page, /** @type {string} */ (manifest.entries.wasmWorkerJs));
    const compiled = await wasmWorker.evaluate(async (url) => {
      const module = await WebAssembly.compileStreaming(fetch(url));
      return WebAssembly.Module.imports(module).some((i) => i.kind === 'memory');
    }, /** @type {string} */ (manifest.entries.ortWasm));
    expect(compiled).toBe(true);
    await stopWorkers(page);

    // Model downloads (WebLLM, Transformers.js) are CORS fetches, which COEP admits without CORP.
    expect(await page.evaluate((url) => fetch(url).then((r) => r.json()), hub)).toEqual({ probe: true });

    // pdf.js parses in the isolated ingest worker the app starts.
    await openTab(page, 'ingest');
    const pdf = [...makePdf(['The isolation probe passed on 3 March.'])];
    const dataTransfer = await page.evaluateHandle((bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'probe.pdf', { type: 'application/pdf' }));
      return dt;
    }, pdf);
    await page.dispatchEvent('#dropZone', 'dragover', { dataTransfer });
    await page.dispatchEvent('#dropZone', 'drop', { dataTransfer });
    await expect(page.locator('#workspaceList')).toContainText('1 page · 1 chunk');

    // The page's own CSP refuses string compilation too; that refusal is the only diagnostic.
    expect(await page.evaluate(evalProbe)).toBe('blocked');
    expect(takeExpected(diagnostics, [/CSP_VIOLATION (?:script-src|eval)/, /unsafe-eval/]).length).toBeGreaterThan(0);
    expect(diagnostics).toEqual([]);
  });
});

test.describe('main views under the CSP', () => {
  test('shows every main view without a CSP violation or a console error', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const response = await page.goto('/');
    expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');
    for (const view of [...MAIN_VIEWS.slice(1), MAIN_VIEWS[0]]) {
      await openTab(page, view);
      // Let lazy work of the view (renders, idle callbacks) run before the next one.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100))));
    }
    expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
    expect(diagnostics).toEqual([]);
  });
});
