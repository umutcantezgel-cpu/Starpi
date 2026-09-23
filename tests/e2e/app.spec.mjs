import { expect, mockSupabase, test } from './fixtures.mjs';

/** @param {import('@playwright/test').Page} page @param {string} tab */
async function openTab(page, tab) {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page.click(isMobile ? `#mobile-nav-${tab}` : `#nav-${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

test.describe('migration pending, anonymous sign-ins disabled', () => {
  test('boots under the CSP, degrades gracefully and never writes chats to Supabase', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: false, anonymousAuth: false });
    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'");

    await expect(page.locator('#dbStatusBadge')).toHaveText(/(Migration offen|Migration Pending)/);
    await page.fill('#chatInput', 'Wann ist der Launch von Projekt Beta?');
    await page.press('#chatInput', 'Enter');
    await expect(page.locator('#chatMessages')).toContainText('3. März geplant');
    await expect(page.locator('#chatMessages')).toContainText(/(ohne KI Modell|without an AI model)/);

    await openTab(page, 'settings');
    await expect(page.locator('#chatSyncStatusText')).toContainText('Nur auf diesem Gerät');

    expect(calls.filter((c) => c.url.startsWith('/rest/v1/chat_history'))).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test('renders hostile database content inertly', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: false, anonymousAuth: false });
    await page.goto('/');
    await openTab(page, 'library');
    const card = page.locator('[data-action="view-doc"]').first();
    await expect(card).toContainText('<img src=x onerror="window.__xss=1">Quartalsbericht');
    await card.click();
    await expect(page.locator('#modalDocContent')).toContainText('Normaler Text.');
    await expect(page.locator('#modalDocContent img')).toHaveCount(0);
    await expect(page.locator('#modalDocContent a[href^="javascript:"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await openTab(page, 'chat');
    await page.fill('#chatInput', 'Welche Dokumente sind hinterlegt?');
    await page.press('#chatInput', 'Enter');
    await expect(page.locator('#chatMessages')).toContainText(/(Verfügbare Dokumente|Available Documents)/);

    expect(await page.evaluate(() => /** @type {any} */ (window).__xss)).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  test('shows an honest empty state when the graph tables are missing', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: false, anonymousAuth: false });
    await page.goto('/');
    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    await expect(page.locator('#selectedEntityBadge')).toHaveText('Info');
    expect(diagnostics).toEqual([]);
  });

  test('rejects insecure own-server URLs', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: false, anonymousAuth: false });
    await page.goto('/');
    await openTab(page, 'settings');
    await page.click('summary');
    await page.fill('#cfgLlmUrl', 'http://evil.example/v1');
    /** @type {string[]} */
    const messages = [];
    page.on('dialog', (d) => {
      messages.push(d.message());
      void d.dismiss();
    });
    await page.click('[data-action="save-settings"]');
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatch(/(Nur https:\/\/|Only https:\/\/)/);
    // The rejected URL must not have been persisted.
    expect(await page.evaluate(() => localStorage.getItem('starpi_llm_url'))).toBeNull();
    expect(diagnostics).toEqual([]);
  });
});

test.describe('hardened schema with anonymous session', () => {
  test('syncs chats through RLS-scoped requests and uses full-text search', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    await page.fill('#chatInput', 'Wann ist der Launch?');
    await page.press('#chatInput', 'Enter');
    await expect(page.locator('#chatMessages')).toContainText('3. März geplant');

    await expect.poll(() => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/chat_history')).length).toBe(2);
    const inserts = calls.filter((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/chat_history'));
    for (const insert of inserts) {
      expect(insert.auth).toBe('Bearer test-access-token');
      expect(insert.body).not.toContain('owner_id');
    }
    expect(calls.some((c) => c.url.startsWith('/rest/v1/rpc/search_knowledge'))).toBe(true);
    expect(diagnostics).toEqual([]);
  });
});

test.describe('local mode without WebGPU', () => {
  test('explains why on-device inference is unavailable and keeps answering', async ({ page, diagnostics }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    });
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await page.selectOption('#engineSelector', 'client');
    await expect(page.locator('#chatMessages')).toContainText(/(Lokaler Modus nicht verfügbar|Local mode unavailable|not supported|unavailable)/i);
    await expect(page.locator('#privacyNotice')).toContainText(/(Lokaler Modus|Local Mode)/);

    await page.fill('#chatInput', 'Wann ist der Launch von Projekt Beta?');
    await page.press('#chatInput', 'Enter');
    await expect(page.locator('#chatMessages')).toContainText('3. März geplant');
    // Local mode: the question is ranked in the browser, never sent to the search RPC or chat table.
    expect(calls.some((c) => c.url.startsWith('/rest/v1/rpc/search_knowledge'))).toBe(false);
    expect(calls.some((c) => c.url.startsWith('/rest/v1/chat_history') && c.method === 'POST')).toBe(false);
    expect(diagnostics).toEqual([]);
  });
});

test.describe('internationalization (i18n)', () => {
  test('defaults to English and toggles reactively to German and persists', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');

    // Defaults to English
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Ask your knowledge base...');

    // Switch to German
    await page.click('[data-action="set-locale"][data-arg="de"]');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Frage an die Wissensbasis...');

    // Switch back to English
    await page.click('[data-action="set-locale"][data-arg="en"]');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Ask your knowledge base...');

    expect(diagnostics).toEqual([]);
  });
});
