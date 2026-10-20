// End-to-end tests for the device-adaptive model picker: the recommendation per device class, the
// on-device group and the site's free models, consent before any download, the hardware badges in
// the settings, the migration of a stored 2.0 preference, language switches and switching while an
// answer is written.
import { NVIDIA_DEFAULT_MODEL, NVIDIA_MODELS } from '../../src/js/models/nvidia-catalog.js';
import { chooseLanguage, expect, mockNvidia, mockSupabase, test, useNvidia } from './fixtures.mjs';

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
    await expect(recommended).toHaveAttribute('label', 'Recommended for this device');
    await expect(recommended.locator('option').first()).toHaveAttribute('value', 'auto');
    const pick = recommended.locator('option[value^="webgpu:"]').first();
    await expect(pick).toHaveAttribute('value', 'webgpu:qwen-3b');
    await expect(pick).toContainText('Qwen 2.5 3B · GPU (WebGPU) · 1.9 GB download · recommended');
    await expect(page.locator(`${HEADER} option[value="webgpu:gemma-9b"]`)).toContainText('needs a strong GPU');
    // First run stays with Auto: nothing is picked or downloaded by itself.
    await expect(page.locator('#engineSelector')).toHaveValue('auto');
    // No keys, no free models on this server, no own server: Auto and this device only.
    expect(await groupLabels(page, HEADER)).toEqual(['Recommended for this device', 'On this device']);

    await page.selectOption('#engineSelector', 'wasm:smollm2-135m');
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('"SmolLM2 135M"');
    expect(dialogs[0]).toContain('15 MB');
    expect(await page.evaluate(() => localStorage.getItem('starpi_webgpu_model'))).toBe('wasm:smollm2-135m');
    expect(await page.evaluate(() => localStorage.getItem('starpi_assistant_v1'))).toBe('device');
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

    const first = page.locator(`${HEADER} optgroup[data-group="recommended"] option[value^="wasm:"]`).first();
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
    // The wider settings picker says more about Auto.
    await expect(page.locator(`${SETTINGS} option[value="auto"]`)).toHaveText("Auto · the best model that is set up: MiniMax M3.1 Flash when it is available, then your keys, the site's free models, your server, this device");
    await expect(page.locator(`${HEADER} option[value="auto"]`)).toHaveText('Auto · best available');
    const badges = page.locator('#cfgDeviceBadges');
    await expect(badges).toBeVisible();
    await expect(badges).toContainText('WebGPU with f16');
    await expect(badges).toContainText('8 GB RAM');
    await expect(badges).toContainText('Device class: desktop');

    await chooseLanguage(page, 'de');
    await expect(page.locator(`${SETTINGS} optgroup`).first()).toHaveAttribute('label', 'Empfohlen für dieses Gerät');
    await expect(page.locator(`${HEADER} optgroup`).nth(1)).toHaveAttribute('label', 'Auf diesem Gerät');
    await expect(page.locator(`${HEADER} option[value="webgpu:llama-3b"]`)).toContainText('Llama 3.2 3B · Grafikkarte (WebGPU) · 1,9 GB Download');
    await expect(page.locator(SETTINGS)).toHaveValue('webgpu:llama-3b');
    await expect(page.locator(HEADER)).toHaveValue('webgpu:llama-3b');
    await expect(badges).toContainText('WebGPU mit f16');
    await expect(badges).toContainText('8 GB Arbeitsspeicher');
    expect(dialogs).toEqual([]);
  });

  test('lists the free NVIDIA models the site offers and recommends its default', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: true });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await mockNvidia(page);
    await page.goto('/');

    const pools = page.locator(`${HEADER} optgroup[label="Free (via Starpi)"]`);
    // The default model is in the recommended group instead, so every value appears once.
    await expect(pools.locator('option')).toHaveCount(NVIDIA_MODELS.length - 1);
    await expect(pools.locator('option:disabled')).toHaveCount(0);
    const recommended = page.locator(`${HEADER} optgroup`).first();
    await expect(recommended.locator(`option[value="nvidia:${NVIDIA_DEFAULT_MODEL}"]`)).toHaveCount(1);
    const pick = /** @type {(typeof NVIDIA_MODELS)[number]} */ (NVIDIA_MODELS.find((m) => m.id !== NVIDIA_DEFAULT_MODEL));
    await expect(pools.locator(`option[value="nvidia:${pick.id}"]`)).toHaveText(`${pick.label} · free via Starpi`);
    const values = await optionValues(page, HEADER);
    expect(new Set(values).size).toBe(values.length);
    await expect(page.locator('#cfgPoolHealth [data-pool="nvidia"]')).toHaveAttribute('data-state', 'on');

    await page.selectOption('#engineSelector', `nvidia:${pick.id}`);
    await expect(page.locator('#cfgComputeMode')).toHaveValue(`nvidia:${pick.id}`);
    await expect(page.locator('#privacyNotice')).toContainText("go through Starpi's server to NVIDIA");
    expect(await page.evaluate(() => localStorage.getItem('starpi_assistant_v1'))).toBe(`nvidia:${pick.id}`);
  });

  test('offers no free models without the site pools and marks a stored NVIDIA model as not set up', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: true });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // The preview server has no pool routes: the pool list request gets a 404.
    const catalog = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/models/pool');
    await page.goto('/');
    expect((await catalog).status()).toBe(404);
    await expect(page.locator(`${HEADER} optgroup`)).toHaveCount(2);
    await expect(page.locator(`${HEADER} option[value^="nvidia:"]`)).toHaveCount(0);

    // A visitor who picked NVIDIA earlier still sees the choice, disabled and explained.
    await useNvidia(page);
    await page.reload();
    const stored = page.locator(`${HEADER} option[value="nvidia:${NVIDIA_DEFAULT_MODEL}"]`);
    await expect(stored).toHaveJSProperty('disabled', true);
    await expect(stored).toContainText('not set up on this server');
    await expect(page.locator('#assistantStatusText')).toHaveText('This model is not set up: add its key in Settings or pick another one');
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
    await page.route(
      (url) => url.pathname === '/api/pool' && url.searchParams.get('provider') === 'nvidia',
      async (route) => {
        asked = true;
        await held;
        await route.fallback();
      },
    );
    await useNvidia(page);
    const dialogs = captureDialogs(page);
    await page.goto('/');
    await expect(page.locator(HEADER)).toHaveValue(`nvidia:${NVIDIA_DEFAULT_MODEL}`);
    await page.click('[data-action="set-chat-mode"][data-arg="free"]');
    await ask(page, 'Hello?');
    await expect.poll(() => asked).toBe(true);

    await page.selectOption('#engineSelector', 'auto');
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toBe('Wait until the current answer is finished before switching the model.');
    await expect(page.locator('#engineSelector')).toHaveValue(`nvidia:${NVIDIA_DEFAULT_MODEL}`);
    expect(await page.evaluate(() => localStorage.getItem('starpi_assistant_v1'))).toBe(`nvidia:${NVIDIA_DEFAULT_MODEL}`);

    release();
    await expect(page.locator('#chatMessages')).toContainText('Hello from the cloud.');
    await page.selectOption('#engineSelector', 'auto');
    await expect(page.locator('#cfgComputeMode')).toHaveValue('auto');
    expect(await page.evaluate(() => localStorage.getItem('starpi_assistant_v1'))).toBe('auto');
    expect(dialogs).toHaveLength(1);
    // The question and, once answered, a title request with the same model; no second answer.
    expect(nvidia.bodies.filter((b) => !JSON.stringify(b.messages).includes('starpi-purpose'))).toHaveLength(1);
  });

  test('applies a pick made with the arrow keys once they rest, not at every step', async ({ page, diagnostics: _diagnostics }) => {
    await emulateDesktop(page, { gpu: false });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const dialogs = captureDialogs(page);
    await page.goto('/');
    await expect(page.locator(HEADER)).toHaveCount(1);
    await page.focus('#engineSelector');
    const start = await page.locator('#engineSelector').inputValue();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    const picked = await page.locator('#engineSelector').inputValue();
    expect(picked).not.toBe(start);
    // Stepping through the options switches nothing and asks nothing.
    expect(dialogs).toHaveLength(0);
    expect(await page.evaluate(() => localStorage.getItem('starpi_assistant_v1'))).toBe('auto');
    // Resting on an option applies it once, for the option it rests on.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('starpi_webgpu_model')), { timeout: 5_000 }).toBe(picked);
    await page.waitForTimeout(1_000);
    // A processor model asks once before its download; a GPU model cannot run here and asks nothing.
    expect(dialogs).toHaveLength(picked.startsWith('wasm:') ? 1 : 0);
  });
});
