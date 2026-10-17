// End-to-end check of model downloads in the browser: stored files of a processor model that do not
// match model-lock.json are hashed in the hashing worker, deleted from Cache Storage and refuse the
// load with a notice that names them; Settings › Trust › Model downloads shows the result and lets
// the user allow the model to load unverified after a warning. Nothing is fetched from a model host.
import { WASM_CATALOG, wasmFileUrl } from '../../src/js/models/wasm-catalog.js';
import { expect, mockSupabase, test } from './fixtures.mjs';

const SRC = WASM_CATALOG['smollm2-135m'];
const MODEL_ID = `wasm:${SRC.repo}`;
/** The files whose presence means "stored", with stand-in content no pinned hash matches. */
const TAMPERED = SRC.cacheProbe.map((file) => [wasmFileUrl(SRC, file), `tampered ${file}`]);

/**
 * A desktop browser without WebGPU, so the processor model is the one that runs.
 * @param {import('@playwright/test').Page} page
 */
async function emulateNoGpu(page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ mobile: false }), configurable: true });
  });
}

/** @param {import('@playwright/test').Page} page @param {string} tab */
async function openTab(page, tab) {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page.click(isMobile ? `#mobile-nav-${tab}` : `#nav-${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

test.describe('model download integrity', () => {
  test('a tampered stored model is deleted, refused and shown in Settings › Trust', async ({ page, diagnostics: _diagnostics }) => {
    await emulateNoGpu(page);
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    /** @type {string[]} */
    const dialogs = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
    /** @type {string[]} */
    const workers = [];
    page.on('worker', (worker) => void workers.push(worker.url()));
    await page.goto('/');
    await expect(page.locator('#engineSelector[data-ready="true"]')).toBeVisible();

    // The model's files are in the Transformers.js cache, as after a download from a hostile mirror.
    await page.evaluate(async (entries) => {
      const cache = await caches.open('transformers-cache');
      for (const [url, body] of entries) await cache.put(url, new Response(body));
    }, TAMPERED);

    await page.selectOption('#engineSelector', 'wasm:smollm2-135m');
    const notice = page.locator('#chatMessages').getByText('does not match the hash this app pinned for it');
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText('SmolLM2 135M');
    await expect(notice).toContainText('config.json');
    // Stored, so no download question; the files were hashed in the worker, not the page.
    expect(dialogs).toEqual([]);
    expect(workers.some((url) => /\/assets\/integrity-worker-[\w-]+\.js$/.test(url)), workers.join('\n')).toBe(true);
    expect(workers.some((url) => /wasm-worker/.test(url)), 'the model worker never started').toBe(false);

    // Every tampered file is gone from the cache.
    const left = await page.evaluate(async (urls) => {
      const cache = await caches.open('transformers-cache');
      return (await Promise.all(urls.map((url) => cache.match(url)))).filter(Boolean).length;
    }, TAMPERED.map(([url]) => url));
    expect(left).toBe(0);

    // Settings › Trust › Model downloads names the model and the deleted files.
    await openTab(page, 'settings');
    const item = page.locator(`#trustSettings [data-model-check="${MODEL_ID}"]`);
    await expect(item).toHaveAttribute('data-state', 'mismatch');
    await expect(item).toContainText('SmolLM2 135M');
    await expect(item).toContainText('File deleted');
    await expect(item).toContainText('onnx/model_quantized.onnx');

    // The override asks first and is stored.
    await item.locator('[data-action="model-integrity-allow"]').click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('Load SmolLM2 135M without matching pinned hashes?');
    await expect(item).toContainText('Allowed to load unverified');
    await expect(page.locator('#trustSettings [data-mi="result"]')).toContainText('SmolLM2 135M may load unverified');
    await item.locator('[data-action="model-integrity-revoke"]').click();
    await expect(item.locator('[data-action="model-integrity-allow"]')).toBeVisible();
  });
});
