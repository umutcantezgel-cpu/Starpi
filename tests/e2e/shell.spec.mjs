// The app shell: mount points, the light and dark themes (applied before the first paint and kept
// across reloads), the collapsible sidebar rail, the chat side panel, and accessibility of all of it
// in both themes.
import AxeBuilder from '@axe-core/playwright';
import { MOUNT_POINTS } from '../../src/js/features/registry.js';
import { expect, mockSupabase, test } from './fixtures.mjs';

const TABS = ['chat', 'research', 'library', 'ingest', 'graph', 'bench', 'settings'];
/** Mount points whose feature renders content. */
const RENDERED = new Set(['chat-sidebar', 'providerSettings', 'trustSettings', 'tab-research']);
const DARK_PAGE = 'rgb(11, 17, 32)';
const LIGHT_PAGE = 'rgb(248, 250, 252)';

/** @param {import('@playwright/test').Page} page */
const isMobile = (page) => (page.viewportSize()?.width ?? 1280) < 768;

/** @param {import('@playwright/test').Page} page @param {string} tab */
async function openTab(page, tab) {
  await page.click(isMobile(page) ? `#mobile-nav-${tab}` : `#nav-${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

/** @param {import('@playwright/test').Page} page @param {string} label */
async function axe(page, label) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/**
 * Opens the chat side panel from the toolbar and selects a tab.
 * @param {import('@playwright/test').Page} page
 * @param {string} tab
 */
async function openAside(page, tab) {
  await page.click('#chatAsideToggle');
  await expect(page.locator('#chat-aside')).toBeVisible();
  await expect(page.locator('#chatAsideToggle')).toHaveAttribute('aria-expanded', 'true');
  await page.click(`#chat-aside-tab-${tab}`);
}

test.describe('mount points', () => {
  test('are in the page, empty, and carry the features mounted into them', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    for (const id of MOUNT_POINTS) {
      const el = page.locator(`#${id}[data-mount]`);
      await expect(el, id).toHaveCount(1);
      // Features that render already fill their mount point; the stubs leave theirs empty.
      if (RENDERED.has(id)) await expect(el, id).not.toBeEmpty();
      else expect(await el.innerHTML(), id).toBe('');
    }
    await expect(page.locator('#providerSettings')).toHaveAttribute('data-mounted', 'providers');
    await expect(page.locator('#trustSettings')).toHaveAttribute('data-mounted', 'trust');
    await expect(page.locator('#chat-sidebar')).toHaveAttribute('data-mounted', 'conversations');
    // Mounted features carry their id, also those that render nothing yet.
    await expect(page.locator('#tab-research')).toHaveAttribute('data-mounted', 'research');
    await expect(page.locator('#liveSheet')).toHaveAttribute('data-mounted', 'live');
    // Companion stays out of the navigation until its feature shows it.
    await expect(page.locator(isMobile(page) ? '#mobile-nav-companion' : '#nav-companion')).toBeHidden();
    // The Research feature renders its tab; its side panel list stays empty until a chat starts a job.
    await openTab(page, 'research');
    await expect(page.locator('#researchQuestion')).toBeVisible();
    await expect(page.locator('#pageTitleText')).toHaveText('Research');
    expect(await page.locator('#chat-aside-research').innerHTML()).toBe('');
    expect(diagnostics).toEqual([]);
  });
});

test.describe('dark mode', () => {
  test('a stored dark theme is on the page before the app script runs', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.addInitScript(() => localStorage.setItem('starpi_theme', 'dark'));
    /** @type {import('@playwright/test').Route[]} */
    const held = [];
    await page.route(/\/assets\/main-[\w-]+\.js$/, (route) => void held.push(route));
    await page.goto('/', { waitUntil: 'commit' });
    await expect.poll(() => held.length).toBe(1);
    // The stylesheet has painted the dark page while the app module is still on hold: no icon is
    // rendered yet, so nothing of the app has run.
    await page.waitForFunction((bg) => document.body && getComputedStyle(document.body).backgroundColor === bg, DARK_PAGE);
    expect(await page.evaluate(() => [document.documentElement.className, document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'), document.querySelectorAll('svg.lucide').length])).toEqual(['dark', 'dark', 0]);
    await held[0].continue();
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');
    await expect(page.locator('html')).toHaveClass('dark');
    expect(diagnostics).toEqual([]);
  });

  test('follows the system setting by default and keeps a choice made in Settings', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass('dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(DARK_PAGE);

    await openTab(page, 'settings');
    const control = page.locator('#themeControl');
    await expect(control.locator('[aria-pressed="true"]')).toHaveAttribute('data-arg', 'system');
    await control.locator('[data-arg="light"]').click();
    await expect(page.locator('html')).toHaveClass('light');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(LIGHT_PAGE);
    await page.reload();
    await expect(page.locator('html')).toHaveClass('light');

    // Back to "System": the page follows the operating system again, also when it changes.
    await openTab(page, 'settings');
    await page.locator('#themeControl [data-arg="system"]').click();
    await expect(page.locator('html')).toHaveClass('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveClass('light');
    expect(await page.evaluate(() => localStorage.getItem('starpi_theme'))).toBeNull();
    expect(diagnostics).toEqual([]);
  });
});

test.describe('sidebar', () => {
  test('collapses to an icon rail that survives a reload', async ({ page, diagnostics }) => {
    test.skip(isMobile(page), 'the rail exists from md up; phones use the drawer and the bottom bar');
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    const sidebar = page.locator('#sidebar');
    const toggle = page.locator('#sidebarCollapseBtn');
    expect((await sidebar.boundingBox())?.width).toBe(256);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'collapsed');
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(68);
    await expect(toggle).toHaveAttribute('aria-label', 'Expand sidebar');
    // Labels stay readable by name and as tooltips; navigation still works.
    await expect(page.locator('#nav-settings')).toHaveAttribute('title', 'Settings');
    await expect(page.locator('#nav-settings')).toHaveAccessibleName('Settings');
    await openTab(page, 'library');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'collapsed');
    expect((await sidebar.boundingBox())?.width).toBe(68);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(256);
    expect(await page.evaluate(() => localStorage.getItem('starpi_sidebar'))).toBeNull();
    expect(diagnostics).toEqual([]);
  });

  test('opens as a drawer on phones and closes again', async ({ page, diagnostics }) => {
    test.skip(!isMobile(page), 'the drawer is the phone layout');
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await expect(page.locator('#menuButton')).toHaveAttribute('aria-expanded', 'false');
    await page.click('#menuButton');
    await expect(page.locator('#nav-research')).toBeVisible();
    await expect(page.locator('#menuButton')).toHaveAttribute('aria-expanded', 'true');
    await page.click('#nav-research');
    await expect(page.locator('#tab-research')).toBeVisible();
    await expect(page.locator('#menuButton')).toHaveAttribute('aria-expanded', 'false');
    expect(diagnostics).toEqual([]);
  });
});

test.describe('chat side panel', () => {
  test('opens on a tab, moves between tabs with the arrow keys and closes with Escape', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await expect(page.locator('#chat-aside')).toBeHidden();
    await openAside(page, 'sources');
    await expect(page.locator('#chat-aside-tab-sources')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#chat-aside-tab-sources')).toBeFocused();
    await expect(page.locator('#chat-aside-panel-sources')).toBeVisible();
    await expect(page.locator('#chat-aside-panel-sources')).toContainText('Nothing to show here yet.');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#chat-aside-tab-compare')).toBeFocused();
    await expect(page.locator('#chat-aside-panel-compare')).toBeVisible();
    await expect(page.locator('#chat-aside-panel-sources')).toBeHidden();
    await page.keyboard.press('End');
    await expect(page.locator('#chat-aside-tab-research')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#chat-aside')).toBeHidden();
    await expect(page.locator('#chatAsideToggle')).toBeFocused();
    await expect(page.locator('#chatAsideToggle')).toHaveAttribute('aria-expanded', 'false');
    // The toggle reopens it on the last tab.
    await page.click('#chatAsideToggle');
    await expect(page.locator('#chat-aside-tab-research')).toBeFocused();
    await page.click('[data-action="close-chat-aside"]');
    await expect(page.locator('#chat-aside')).toBeHidden();
    expect(diagnostics).toEqual([]);
  });

  test('speaks German after a language switch (namespace strings load with the language)', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await page.click('[data-action="set-locale"][data-arg="de"]');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await openAside(page, 'canvas');
    await expect(page.locator('#chat-aside-tab-sources')).toHaveText('Quellen');
    await expect(page.locator('[data-action="close-chat-aside"]')).toHaveAttribute('aria-label', 'Seitenbereich schließen');
    if (!isMobile(page)) await expect(page.locator('#sidebarCollapseBtn')).toHaveAttribute('aria-label', 'Seitenleiste einklappen');
    expect(diagnostics).toEqual([]);
  });
});

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
  test.describe(`accessibility (${scheme})`, () => {
    test(`has no serious or critical axe violations in the shell and the main views`, async ({ page, diagnostics: _diagnostics }) => {
      test.setTimeout(90_000);
      await mockSupabase(page, { hardened: true, anonymousAuth: true });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/');
      await expect(page.locator('html')).toHaveClass(scheme);
      // An answer with citations and a flagged statement, so the source check is part of the scan.
      await page.locator('#chatMessages [data-action="load-samples"]').click();
      await page.locator('[data-action="demo-check"]').click();
      await expect(page.locator('.grounding-bar').last()).toBeVisible();
      for (const tab of TABS) {
        await openTab(page, tab);
        await axe(page, `${scheme} ${tab}`);
      }
      await openTab(page, 'chat');
      await openAside(page, 'sources');
      await axe(page, `${scheme} side panel`);
      await page.keyboard.press('Escape');
      if (!isMobile(page)) {
        await page.click('#sidebarCollapseBtn');
        await axe(page, `${scheme} rail`);
      } else {
        await page.click('#menuButton');
        await expect(page.locator('#nav-chat')).toBeVisible();
        await axe(page, `${scheme} drawer`);
      }
    });
  });
}
