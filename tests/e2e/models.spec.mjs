// End-to-end tests for the device-adaptive model picker: the recommendation per device class, the
// on-device and NVIDIA groups, consent before any download, the hardware badges in the settings, the
// migration of a stored 2.0 preference, language switches and switching while an answer is written.
import { NVIDIA_DEFAULT_MODEL, NVIDIA_MODELS } from '../../src/js/models/nvidia-catalog.js';
import { expect, mockNvidia, mockSupabase, test, useNvidia } from './fixtures.mjs';

/**
 * Emulates a desktop with 8 GB of memory, with or without a WebGPU adapter (Intel, shader-f16, 2 GiB
 * buffers). The mobile project emulates a phone, so the user-agent hint is overridden as well.
 * @param {import('@playwright/test').Page} page
 * @param {{ gpu: boolean }} device
 */
async function emulateDesktop(page, { gpu }) {
  await page.addInitScript((withGpu) => {
    const adapter = {
      limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 },
      features: new Set(['shader-f16']),
      info: { vendor: 'intel', architecture: '', device: '', description: '' },
    };
    const gpuObject = { requestAdapter: async () => adapter };
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => (withGpu ? gpuObject : undefined), configurable: true });
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ mobile: false }), configurable: true });
  }, gpu);
}

/** @param {import('@playwright/test').Page} page @param {string} tab */
async function openTab(page, tab) {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page.click(isMobile ? `#mobile-nav-${tab}` : `#nav-${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

/**
 * Records every alert and confirm and dismisses it (declining any download).
 * @param {import('@playwright/test').Page} page
 */
function captureDialogs(page) {
  /** @type {string[]} */
  const dialogs = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return dialogs;
}

const HEADER = '#engineSelector[data-ready="true"]';
const SETTINGS = '#cfgComputeMode[data-ready="true"]';

/** @param {import('@playwright/test').Page} page @param {string} select */
const groupLabels = (page, select) => page.locator(`${select} optgroup`).evaluateAll((groups) => groups.map((g) => /** @type {HTMLOptGroupElement} */ (g).label));

/** @param {import('@playwright/test').Page} page @param {string} select */
const optionValues = (page, select) => page.locator(`${select} option`).evaluateAll((options) => options.map((o) => /** @type {HTMLOptionElement} */ (o).value));

test.describe('model picker', () => {
  test('recommends a WebGPU model on a capable desktop and asks before any download', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: true });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const dialogs = captureDialogs(page);
    await page.goto('/');

    const recommended = page.locator(`${HEADER} optgroup`).first();
    await expect(recommended).toHaveAttribute('label', 'Recommended for your device');
    await expect(recommended.locator('option').first()).toHaveAttribute('value', 'webgpu:qwen-3b');
    await expect(recommended.locator('option').first()).toContainText('Qwen 2.5 3B · GPU (WebGPU) · 1.9 GB download · recommended');
    await expect(page.locator(`${HEADER} option[value="webgpu:gemma-9b"]`)).toContainText('needs a strong GPU');
    await expect(page.locator(`${HEADER} option[value="council"]`)).toHaveCount(1);
    // First run stays with the cloud assistant: nothing is picked or downloaded by itself.
    await expect(page.locator('#engineSelector')).toHaveValue('council');
    expect(await groupLabels(page, HEADER)).toEqual(['Recommended for your device', 'In this browser (WebGPU/WASM)', 'Other assistants']);

    await page.selectOption('#engineSelector', 'wasm:smollm2-135m');
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('"SmolLM2 135M"');
    expect(dialogs[0]).toContain('15 MB');
    expect(await page.evaluate(() => localStorage.getItem('starpi_webgpu_model'))).toBe('wasm:smollm2-135m');
    expect(await page.evaluate(() => localStorage.getItem('starpi_compute_mode'))).toBe('client');
    await expect(page.locator('#engineSelector')).toHaveValue('wasm:smollm2-135m');
    await expect(page.locator('#cfgComputeMode')).toHaveValue('wasm:smollm2-135m');
    await expect(page.locator('#webgpuProgressContainer')).toBeHidden();
    await expect(page.locator('#privacyNotice')).toContainText('On-device mode');
    // Declined: no second question and nothing fetched (the fixture reports any huggingface.co request).
    expect(dialogs).toHaveLength(1);
  });

  test('warns before a large model that it needs a strong GPU', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: true });
    // Enough free storage for 5 GB, so the quota check lets the consent question through.
    await page.addInitScript(() => {
      StorageManager.prototype.estimate = async () => ({ quota: 100 * 1024 ** 3, usage: 0 });
    });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const dialogs = captureDialogs(page);
    await page.goto('/');
    await page.selectOption(HEADER, 'webgpu:gemma-9b');
    await expect.poll(() => dialogs.length).toBe(1);
    // The memory warning comes first, the download question last.
    expect(dialogs[0]).toMatch(/^This model needs a GPU with about [\d.]+ GB of free memory\.\n\nThe on-device model "Gemma 2 9B" will be downloaded once/);
    expect(dialogs[0]).toMatch(/Download now\?$/);
    await expect(page.locator('#webgpuProgressContainer')).toBeHidden();
  });

  test('falls back to WASM without WebGPU and migrates a stored 2.0 preference', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: false });
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('starpi_webgpu_model', 'qwen-1.5b');
    });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');

    const first = page.locator(`${HEADER} optgroup`).first().locator('option').first();
    await expect(first).toHaveAttribute('value', /^wasm:/);
    await expect(first).toContainText('CPU (WASM)');
    await expect(first).toContainText('recommended');
    await expect(page.locator(`${HEADER} option[value="webgpu:qwen-1.5b"]`)).toContainText('needs WebGPU');
    await expect(page.locator(`${HEADER} option[value="webgpu:qwen-1.5b"]`)).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('starpi_webgpu_model'))).toBe('webgpu:qwen-1.5b');
  });

  test('mirrors the header in Settings with hardware badges and re-labels groups on a language switch', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: true });
    // A returning visitor with an on-device model that is not cached: nothing is downloaded at start.
    await page.addInitScript(() => {
      localStorage.setItem('starpi_compute_mode', 'client');
      localStorage.setItem('starpi_webgpu_model', 'webgpu:llama-3b');
    });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const dialogs = captureDialogs(page);
    await page.goto('/');
    await openTab(page, 'settings');

    await expect(page.locator(SETTINGS)).toHaveValue('webgpu:llama-3b');
    await expect(page.locator(HEADER)).toHaveValue('webgpu:llama-3b');
    expect(await groupLabels(page, SETTINGS)).toEqual(await groupLabels(page, HEADER));
    expect(await optionValues(page, SETTINGS)).toEqual(await optionValues(page, HEADER));
    // The wider settings picker describes the other assistants in more detail.
    await expect(page.locator(`${SETTINGS} option[value="council"]`)).toHaveText('Cloud assistant · your own provider key');
    await expect(page.locator(`${HEADER} option[value="council"]`)).toHaveText('Cloud assistant');
    const badges = page.locator('#cfgDeviceBadges');
    await expect(badges).toBeVisible();
    await expect(badges).toContainText('WebGPU with f16');
    await expect(badges).toContainText('8 GB RAM');
    await expect(badges).toContainText('Device class: desktop');

    await page.click('[data-action="set-locale"][data-arg="de"]');
    await expect(page.locator(`${SETTINGS} optgroup`).first()).toHaveAttribute('label', 'Empfohlen für Ihr Gerät');
    await expect(page.locator(`${HEADER} optgroup`).nth(1)).toHaveAttribute('label', 'Lokal im Browser (WebGPU/WASM)');
    await expect(page.locator(`${HEADER} option[value="webgpu:llama-3b"]`)).toContainText('Llama 3.2 3B · Grafikkarte (WebGPU) · 1,9 GB Download');
    await expect(page.locator(SETTINGS)).toHaveValue('webgpu:llama-3b');
    await expect(page.locator(HEADER)).toHaveValue('webgpu:llama-3b');
    await expect(badges).toContainText('WebGPU mit f16');
    await expect(badges).toContainText('8 GB Arbeitsspeicher');
    expect(dialogs).toEqual([]);
  });

  test('lists the NVIDIA models the proxy offers and recommends its default', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: true });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await mockNvidia(page);
    await page.goto('/');

    const nvidiaGroup = page.locator(`${HEADER} optgroup[label="NVIDIA NIM cloud (fast & free)"]`);
    // The default model is in the recommended group instead, so every value appears once.
    await expect(nvidiaGroup.locator('option')).toHaveCount(NVIDIA_MODELS.length - 1);
    await expect(nvidiaGroup.locator('option:disabled')).toHaveCount(0);
    const recommended = page.locator(`${HEADER} optgroup`).first();
    await expect(recommended.locator(`option[value="nvidia:${NVIDIA_DEFAULT_MODEL}"]`)).toHaveCount(1);
    const pick = /** @type {(typeof NVIDIA_MODELS)[number]} */ (NVIDIA_MODELS.find((m) => m.id !== NVIDIA_DEFAULT_MODEL));
    await expect(nvidiaGroup.locator(`option[value="nvidia:${pick.id}"]`)).toHaveText(`${pick.label} · NVIDIA cloud, no download`);
    const values = await optionValues(page, HEADER);
    expect(new Set(values).size).toBe(values.length);

    await page.selectOption('#engineSelector', `nvidia:${pick.id}`);
    await expect(page.locator('#cfgComputeMode')).toHaveValue(`nvidia:${pick.id}`);
    await expect(page.locator('#privacyNotice')).toContainText("go through Starpi's server to NVIDIA");
    expect(await page.evaluate(() => [localStorage.getItem('starpi_compute_mode'), localStorage.getItem('starpi_nvidia_model')])).toEqual(['nvidia', pick.id]);
  });

  test('hides the NVIDIA group without a proxy and marks a stored NVIDIA model as unavailable', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: true });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // The preview server has no NVIDIA routes: the catalog request gets a 404.
    const catalog = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/models/nvidia');
    await page.goto('/');
    expect((await catalog).status()).toBe(404);
    await expect(page.locator(`${HEADER} optgroup`)).toHaveCount(3);
    await expect(page.locator(`${HEADER} option[value^="nvidia:"]`)).toHaveCount(0);

    // A visitor who picked NVIDIA earlier still sees the choice, disabled and explained.
    await useNvidia(page);
    await page.reload();
    await expect(page.locator('#assistantStatusText')).toHaveText('NVIDIA cloud is not available on this server');
    const stored = page.locator(`${HEADER} option[value="nvidia:${NVIDIA_DEFAULT_MODEL}"]`);
    await expect(stored).toHaveJSProperty('disabled', true);
    await expect(stored).toContainText('not set up on this server');
    await expect(page.locator(`${HEADER} option[value^="nvidia:"]`)).toHaveCount(1);
    await expect(page.locator('#engineSelector')).toHaveValue(`nvidia:${NVIDIA_DEFAULT_MODEL}`);
  });

  test('refuses to switch while an answer is being written', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: true });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const nvidia = await mockNvidia(page, { reply: { content: ['Hello from the cloud.'] } });
    // Holds the answer until the switch has been tried (registered last, so it runs first).
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    let asked = false;
    await page.route('**/api/chat/nvidia', async (route) => {
      asked = true;
      await held;
      await route.fallback();
    });
    await useNvidia(page);
    const dialogs = captureDialogs(page);
    await page.goto('/');
    await expect(page.locator(HEADER)).toHaveValue(`nvidia:${NVIDIA_DEFAULT_MODEL}`);
    await page.click('[data-action="set-chat-mode"][data-arg="free"]');
    await ask(page, 'Hello?');
    await expect.poll(() => asked).toBe(true);

    await page.selectOption('#engineSelector', 'council');
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toBe('Wait until the current answer is finished before switching the model.');
    await expect(page.locator('#engineSelector')).toHaveValue(`nvidia:${NVIDIA_DEFAULT_MODEL}`);
    expect(await page.evaluate(() => localStorage.getItem('starpi_compute_mode'))).toBe('nvidia');

    release();
    await expect(page.locator('#chatMessages')).toContainText('Hello from the cloud.');
    await page.selectOption('#engineSelector', 'council');
    await expect(page.locator('#cfgComputeMode')).toHaveValue('council');
    expect(await page.evaluate(() => localStorage.getItem('starpi_compute_mode'))).toBe('council');
    expect(dialogs).toHaveLength(1);
    expect(nvidia.bodies).toHaveLength(1);
  });
});
