import { makePdf } from '../fixtures/pdf.mjs';
import { expect, mockSupabase, test } from './fixtures.mjs';

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

test.describe('migration pending, anonymous sign-ins disabled', () => {
  test('boots under the CSP, degrades gracefully and never writes chats to Supabase', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: false, anonymousAuth: false });
    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'");

    await expect(page.locator('#dbStatusBadge')).toHaveText('Migration pending');
    await ask(page, 'Wann ist der Launch von Projekt Beta?');
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer).toContainText('3. März geplant');
    await expect(answer).toContainText('no AI model was used');
    // The quoted sentence is cited, and the citation resolves to the excerpt the answer used.
    await expect(answer.locator('[data-action="open-citation"]').first()).toContainText('Projekt Beta Kickoff');

    await openTab(page, 'settings');
    await expect(page.locator('#chatSyncStatusText')).toContainText('This device only');

    // Icons are decorative SVGs hidden from assistive technology; the UI renders no emoji.
    await expect(page.locator('svg.lucide:not([aria-hidden="true"])')).toHaveCount(0);
    expect(await page.evaluate(() => /\p{Extended_Pictographic}/u.test(document.body.innerText))).toBe(false);

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
    await ask(page, 'Which documents are available?');
    await expect(page.locator('#chatMessages')).toContainText('Available documents (2)');

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
    await page.locator('details:has(#cfgLlmUrl) > summary').click();
    await page.fill('#cfgLlmUrl', 'http://evil.example/v1');
    /** @type {string[]} */
    const messages = [];
    page.on('dialog', (d) => {
      messages.push(d.message());
      void d.dismiss();
    });
    await page.click('[data-action="save-settings"]');
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatch(/^Only https:\/\//);
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

    await ask(page, 'Wann ist der Launch?');
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
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    });
  });

  test('explains why on-device inference is unavailable and keeps answering', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await page.selectOption('#engineSelector', 'client');
    await expect(page.locator('#chatMessages')).toContainText('On-device mode is not available');
    await expect(page.locator('#privacyNotice')).toContainText('On-device mode');

    await ask(page, 'Wann ist der Launch von Projekt Beta?');
    await expect(page.locator('#chatMessages')).toContainText('3. März geplant');
    // Local mode: the question is ranked in the browser, never sent to the search RPC or chat table.
    expect(calls.some((c) => c.url.startsWith('/rest/v1/rpc/search_knowledge'))).toBe(false);
    expect(calls.some((c) => c.url.startsWith('/rest/v1/chat_history') && c.method === 'POST')).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  test('diagnostics report the missing WebGPU support instead of numbers', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'bench');
    await expect(page.locator('#benchWebgpuStatusText')).toHaveText('WebGPU not supported');
    await expect(page.locator('#btnRunBenchmark')).toBeDisabled();
    await expect(page.locator('#benchModelHint')).toContainText('needs WebGPU');
    await expect(page.locator('#benchResultTTFT')).toHaveText('–');
    expect(diagnostics).toEqual([]);
  });
});

test.describe('internationalization', () => {
  test('defaults to English, switches to German without a reload and keeps the choice', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
    const settingsNav = page.locator(isMobile ? '#mobile-nav-settings' : '#nav-settings');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Ask a question…');
    await expect(settingsNav).toHaveText('Settings');
    await expect(page.locator('#privacyNotice')).toContainText('No model configured');
    await expect(page.locator('[data-action="set-locale"][data-arg="en"]')).toHaveAttribute('aria-pressed', 'true');

    /** @type {string[]} */
    const navigations = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.click('[data-action="set-locale"][data-arg="de"]');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Frage stellen…');
    await expect(settingsNav).toHaveText(isMobile ? 'Optionen' : 'Einstellungen');
    await expect(page.locator('#privacyNotice')).toContainText('Kein Modell eingerichtet');
    await expect(page.locator('#sendBtn')).toHaveAttribute('aria-label', 'Senden');
    await expect(page.locator('[data-action="set-locale"][data-arg="de"]')).toHaveAttribute('aria-pressed', 'true');
    expect(navigations).toEqual([]);

    // Quick prompts ask in the active language.
    await page.click('[data-action="quick-prompt"][data-arg="chat.prompt_docs_question"]');
    await expect(page.locator('#chatMessages')).toContainText('Welche Dokumente sind in der Wissensdatenbank verfügbar?');
    await expect(page.locator('#chatMessages')).toContainText('Verfügbare Dokumente (2)');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Frage stellen…');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    await page.click('[data-action="set-locale"][data-arg="en"]');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Ask a question…');
    await expect(settingsNav).toHaveText('Settings');
    expect(await page.evaluate(() => localStorage.getItem('starpi_locale'))).toBe('en');
    expect(diagnostics).toEqual([]);
  });
});

test.describe('on-device workspace', () => {
  test('indexes dropped files in a worker, answers with citations and shows the cited chunk', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'ingest');

    const pdf = [...makePdf(['Project Nebula launches on 12 May 2027.', 'The approved budget for Project Nebula is 480000 EUR.'])];
    const dataTransfer = await page.evaluateHandle((bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['# Nebula notes\n\nThe Nebula steering group meets every Tuesday in room 4.'], 'notes.md', { type: 'text/markdown' }));
      dt.items.add(new File([new Uint8Array(bytes)], 'plan.pdf', { type: 'application/pdf' }));
      return dt;
    }, pdf);
    await page.dispatchEvent('#dropZone', 'dragover', { dataTransfer });
    await page.dispatchEvent('#dropZone', 'drop', { dataTransfer });

    const list = page.locator('#workspaceList');
    await expect(list.locator('li')).toHaveCount(2);
    await expect(list).toContainText('notes.md');
    await expect(list).toContainText('plan.pdf');
    await expect(list).toContainText('1 pages · 1 chunks');

    // BM25 search panel: real scores, best match first.
    await page.fill('#workspaceQuery', 'Nebula budget');
    await page.press('#workspaceQuery', 'Enter');
    const results = page.locator('#workspaceResults li');
    await expect(results).toHaveCount(2);
    await expect(results.first()).toContainText('plan.pdf');
    await expect(results.first().locator('.workspace-score')).toHaveText(/^BM25 \d+\.\d{3}$/);

    await openTab(page, 'chat');
    await ask(page, 'What is the approved budget for Project Nebula?');
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer).toContainText('480000 EUR');
    const citation = answer.locator('.message-content [data-action="open-citation"]').first();
    await expect(citation).toContainText('plan.pdf · 1');

    await citation.click();
    const drawer = page.locator('#citationModal');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('#citationModalDoc')).toHaveText('plan.pdf');
    await expect(drawer.locator('#citationModalSource')).toHaveText('On-device workspace');
    await expect(drawer.locator('mark')).toContainText('The approved budget for Project Nebula is 480000 EUR.');
    await expect(drawer.locator('#citationModalOffsets')).toHaveText(/^0–\d+$/);
    await expect(drawer.locator('#citationModalScore')).toHaveText(/^\d+\.\d+$/);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // File contents never leave the device.
    const leaked = calls.filter((c) => /steering group|480000/.test(`${c.url} ${c.body ?? ''}`));
    expect(leaked).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test('keeps a question about an attached file and its answer on the device while chats sync', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    await page.setInputFiles('#chatFileInput', { name: 'orion-roadmap.md', mimeType: 'text/markdown', buffer: Buffer.from('# Orion\n\nThe Orion release ships in calendar week 38.') });
    await expect(page.locator('#attachedFileName')).toHaveText('orion-roadmap.md · 1 chunks');
    await ask(page, 'When does the Orion release ship?');
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer).toContainText('calendar week 38');

    const stored = await page.evaluate(() => localStorage.getItem('starpi_local_chats_v1') ?? '');
    expect(stored).toContain('orion-roadmap.md');
    expect(stored).toContain('calendar week 38');
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/chat_history'))).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test('rejects unsupported files with a clear message', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    await expect(page.locator('#workspaceStatus')).toHaveText('photo.png: this file type is not supported.');
    await expect(page.locator('#workspaceList li')).toHaveCount(0);
    expect(diagnostics).toEqual([]);
  });
});
