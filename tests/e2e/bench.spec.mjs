// Bench tab → Benchmark history in the built app: on this browser (no WebGPU) the benchmark offers a
// processor model, a seeded history changes the recommendation and shows up in the chart and the
// table, the JSON export holds every run, "Clear history" asks first, and the tab has no serious axe
// violations with the history shown, in the light and the dark theme.
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { expect, mockSupabase, test } from './fixtures.mjs';

/** @param {import('@playwright/test').Page} page */
const isMobile = (page) => (page.viewportSize()?.width ?? 1280) < 768;

/** @param {import('@playwright/test').Page} page */
async function openBench(page) {
  await page.click(isMobile(page) ? '#mobile-nav-bench' : '#nav-bench');
  await expect(page.locator('#tab-bench')).toBeVisible();
  await expect(page.locator('[data-bh-root]')).toBeVisible();
}

/**
 * Stores runs in the app database's bench store, as the benchmark would.
 * @param {import('@playwright/test').Page} page
 * @param {object[]} runs
 */
async function seed(page, runs) {
  await page.evaluate(
    (records) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('starpi');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('bench', 'readwrite');
          for (const r of records) tx.objectStore('bench').put(r);
          tx.oncomplete = () => {
            open.result.close();
            resolve(undefined);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    runs,
  );
}

/**
 * @param {string} ref
 * @param {string} deviceClass
 * @param {number} tokPerSec
 * @param {number} i
 */
const run = (ref, deviceClass, tokPerSec, i) => ({
  id: `seed-${ref}-${i}`,
  modelId: `seed/${ref}`,
  ref,
  label: ref,
  runtime: ref.split(':')[0],
  deviceClass,
  browser: 'Chrome 141',
  tokPerSec,
  ttftMs: 900 + i,
  loadMs: null,
  failures: 0,
  at: Date.UTC(2026, 9, 1 + i),
});

/** @param {import('@playwright/test').Page} page @param {string} label */
async function axe(page, label) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe('benchmark history', () => {
  test('a seeded history changes the recommendation, is charted and exported, and clears after confirming', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openBench(page);
    await expect(page.locator('#btnRunBenchmark')).toBeEnabled();
    await expect(page.locator('#benchModelHint')).toContainText('processor (WASM) model');
    await expect(page.locator('[data-bh-root]')).toContainText('No runs yet');
    await expect(page.locator('[data-action="bench-history-export"]')).toBeDisabled();

    // What the device gets without measurements, and the class it is in.
    const local = page.locator('[data-bh-local]');
    await expect(local).toHaveAttribute('data-bh-local', /^wasm:/);
    const pick = /** @type {string} */ (await local.getAttribute('data-bh-local'));
    const cls = 'cpu-only';

    await seed(page, [run(pick, cls, 2.5, 1), run(pick, cls, 3, 2), run(pick, cls, 3.5, 3), run('wasm:smollm2-135m', 'laptop', 30, 4)]);
    await page.reload();
    await openBench(page);

    await expect(page.locator('[data-bh-step-down]')).toHaveAttribute('data-bh-step-down', pick);
    await expect(page.locator('[data-bh-step-down]')).toContainText('measured 3 tok/s here, below 8 tok/s');
    await expect(local).not.toHaveAttribute('data-bh-local', pick);
    const chart = page.locator('[data-bh="chart"] svg[role="img"]');
    await expect(chart).toHaveAttribute('aria-label', /Median decode rate per model/);
    await expect(chart.locator('g[data-bar]')).toHaveCount(1);
    await expect(page.locator(`[data-bh-row="${pick}"]`)).toContainText('3');
    await expect(page.locator(`[data-bh-trend="${pick}"] svg`)).toHaveCount(1);
    await expect(page.locator('[data-bh-root]')).toContainText('1 run from another device class is kept in the export');
    // The chart fits its card.
    const box = await chart.boundingBox();
    const card = await page.locator('[data-bh-root]').boundingBox();
    expect(box && card && box.width <= card.width).toBe(true);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="bench-history-export"]')]);
    expect(download.suggestedFilename()).toMatch(/^starpi-bench-history-\d{4}-\d{2}-\d{2}\.json$/);
    const exported = JSON.parse(await readFile(/** @type {string} */ (await download.path()), 'utf8'));
    expect(exported.format).toBe('starpi.bench-history/v1');
    expect(exported.runs).toHaveLength(4);
    await expect(page.locator('[data-bh="result"]')).toContainText('Exported 4 runs');

    /** @type {string[]} */
    const dialogs = [];
    page.once('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.click('[data-action="bench-history-clear"]');
    await expect.poll(() => dialogs.length).toBe(1);
    await expect(page.locator('[data-bh-root]')).toHaveAttribute('data-runs', '4');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.click('[data-action="bench-history-clear"]');
    await expect(page.locator('[data-bh-root]')).toHaveAttribute('data-runs', '0');
    await expect(page.locator('[data-bh-root]')).toContainText('No runs yet');
    expect(dialogs[0]).toContain('Delete every saved benchmark run');
    expect(diagnostics).toEqual([]);
  });

  for (const scheme of ['light', 'dark']) {
    test(`the bench tab with a history has no serious axe violations (${scheme})`, async ({ page, diagnostics }) => {
      await page.addInitScript((theme) => localStorage.setItem('starpi_theme', theme), scheme);
      await mockSupabase(page, { hardened: true, anonymousAuth: true });
      await page.goto('/');
      await openBench(page);
      const pick = /** @type {string} */ (await page.locator('[data-bh-local]').getAttribute('data-bh-local'));
      await seed(page, [run(pick, 'cpu-only', 4, 1), run(pick, 'cpu-only', 5, 2), run('wasm:smollm2-135m', 'cpu-only', 26, 3)]);
      await page.reload();
      await openBench(page);
      await expect(page.locator('[data-bh="chart"] svg[role="img"] g[data-bar]')).toHaveCount(2);
      await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /dark/ : /^(?!.*dark)/);
      await axe(page, `${scheme} bench`);
      expect(diagnostics).toEqual([]);
    });
  }
});
