import { WASM_CATALOG } from '../../src/js/models/wasm-catalog.js';
import { makePdf } from '../fixtures/pdf.mjs';
import { chooseLanguage, expect, mockSupabase, storedChatNodes, storedChatText, test } from './fixtures.mjs';

const WASM_LABELS = Object.values(WASM_CATALOG).map((src) => src.label);

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
    // Every response carries the production headers (workers enforce the CSP of their own script),
    // and hashed assets are immutable.
    const script = await page.locator('script[src]').first().getAttribute('src');
    for (const url of ['/index.html', '/sw.js', '/manifest.webmanifest', script ?? '']) {
      const headers = (await page.request.get(url)).headers();
      expect(headers['content-security-policy'], url).toContain("default-src 'self'");
      expect(headers['x-content-type-options'], url).toBe('nosniff');
    }
    expect((await page.request.get(script ?? '')).headers()['cache-control']).toBe('public, max-age=31536000, immutable');

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
    await page.fill('#pvLocalUrl', 'http://evil.example/v1');
    await page.click('[data-action="providers-save-key"][data-arg="local"]');
    await expect(page.locator('[data-pv-result="local"]')).toHaveText(/^Only https:\/\//);
    // The rejected URL must not have been persisted.
    expect(await page.evaluate(() => localStorage.getItem('starpi_llm_url'))).toBeNull();
    expect(diagnostics).toEqual([]);
  });
});

test.describe('knowledge graph view', () => {
  test('says the graph cannot be reached when its view does not load, and draws it after a reload', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // The graph view is a chunk the page loads when the tab first opens; refuse it once.
    let refuse = true;
    let refused = 0;
    await page.route(/\/assets\/chunk-[A-Z0-9]+\.js$/, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (refuse && body.includes('graphEntityList')) {
        refused += 1;
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
      }
      return route.fulfill({ response, body });
    });
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');
    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    await expect(page.locator('#graphStatus')).toHaveText(/cannot be reached/);
    expect(refused).toBe(1);

    // The browser keeps a failed module import for the page's lifetime; after a reload the tab
    // draws the (empty) graph.
    refuse = false;
    await page.reload();
    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    await expect(page.locator('#graphStatus')).toHaveText('The graph has no entities yet.');
    // The tab's own buttons reach the view.
    await page.click('[data-action="open-entity-modal"]');
    await expect(page.locator('#entityModal')).toBeVisible();
    await expect(page.locator('#newEntityName')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#entityModal')).toBeHidden();
    expect(diagnostics).toEqual([]);
  });
});

test.describe('saving settings', () => {
  /** @param {import('@playwright/test').Page} page */
  async function saveAndReadDialog(page) {
    await openTab(page, 'settings');
    await page.selectOption('#cfgStrength', 'fast');
    /** @type {string[]} */
    const messages = [];
    page.on('dialog', (d) => {
      messages.push(d.message());
      void d.dismiss();
    });
    await page.click('[data-action="save-settings"]');
    await expect.poll(() => messages.length).toBe(1);
    return messages[0];
  }

  test('confirms only what the browser stored', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: false, anonymousAuth: false });
    await page.goto('/');
    expect(await saveAndReadDialog(page)).toBe('Settings saved.');
    expect(await page.evaluate(() => localStorage.getItem('starpi_model_strength_v1'))).toBe('fast');
    expect(diagnostics).toEqual([]);
  });

  test('says so when the browser refuses to store settings', async ({ page, diagnostics }) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('Storage is disabled', 'SecurityError');
      };
    });
    await mockSupabase(page, { hardened: false, anonymousAuth: false });
    await page.goto('/');
    expect(await saveAndReadDialog(page)).toMatch(/^Some settings could not be saved/);
    expect(diagnostics).toEqual([]);
  });
});

test.describe('hardened schema with anonymous session', () => {
  test('keeps chats on the device (no plaintext chat sync) and uses full-text search', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    await ask(page, 'Wann ist der Launch?');
    await expect(page.locator('#chatMessages')).toContainText('3. März geplant');

    // Both turns are stored in the browser; the chat table is never written.
    await expect.poll(async () => (await storedChatNodes(page)).map((n) => n.role)).toEqual(['user', 'assistant']);
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/chat_history'))).toEqual([]);
    expect(calls.some((c) => c.url.startsWith('/rest/v1/rpc/search_knowledge'))).toBe(true);
    expect(diagnostics).toEqual([]);
  });
});

test.describe('offline start', () => {
  test('reconnects when the browser is back online and then answers from the knowledge base', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const supabase = /\.supabase\.co\//;
    /** @param {import('@playwright/test').Route} route */
    const unreachable = (route) => route.abort('internetdisconnected');
    await page.route(supabase, unreachable);
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Offline');

    await page.unroute(supabase, unreachable);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    await ask(page, 'Wann ist der Launch?');
    await expect(page.locator('#chatMessages')).toContainText('3. März geplant');
    expect(calls.some((c) => c.url.startsWith('/rest/v1/rpc/search_knowledge'))).toBe(true);
    await expect.poll(async () => (await storedChatNodes(page)).length).toBe(2);
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/chat_history'))).toEqual([]);

    // The browser logs the requests that failed while Supabase was unreachable; nothing else may be logged.
    const expected = (/** @type {string} */ p) => /^console\.error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/.test(p);
    expect(diagnostics.some(expected)).toBe(true);
    diagnostics.splice(0, diagnostics.length, ...diagnostics.filter((p) => !expected(p)));
    expect(diagnostics).toEqual([]);
  });

  test('shows the offline state when the Supabase library does not load, and connects once it does', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // The library is a lazy entry of its own (scripts/build.mjs), loaded on the first connect;
    // answer it with a 404 as a server does for a file of an older deploy. The browser keeps a
    // failed module import, so the retry must ask for it under another URL.
    let missing = true;
    /** @type {string[]} */
    const requested = [];
    await page.route(/\/assets\/supabase-[A-Z0-9]+\.js(?:\?|$)/, (route) => {
      requested.push(new URL(route.request().url()).search);
      return missing ? route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }) : route.fallback();
    });
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Offline');
    expect(requested).toEqual(['']);
    // The views and the chat stay usable.
    await openTab(page, 'library');
    await openTab(page, 'chat');

    missing = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');
    // Every attempt (the library view tried once more) asked under a URL of its own.
    expect(requested.length).toBeGreaterThan(1);
    expect(new Set(requested).size).toBe(requested.length);
    // The 404 is logged by the browser and filtered as a mocked 4xx; nothing else may be logged.
    expect(diagnostics).toEqual([]);
  });

  test('goes offline and restores the local chat when the Supabase library stalls, and uses it once it arrives', async ({ page, diagnostics }) => {
    // One Supabase timeout (12 s) to the offline state, then the reconnect.
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('starpi_chat_session_id', 'starpi_stalled-session');
      localStorage.setItem(
        'starpi_local_chats_v1',
        JSON.stringify({
          'starpi_stalled-session': {
            updatedAt: Date.now(),
            messages: [
              { role: 'user', content: 'Where is the kickoff?', sources: [], metadata: { local_only: true }, created_at: '2026-10-01T10:00:00Z' },
              { role: 'assistant', content: 'The kickoff is in room Aurora.', sources: [], metadata: { local_only: true }, created_at: '2026-10-01T10:00:01Z' },
            ],
          },
        }),
      );
    });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // A stalled network: the library's download never finishes, until the test lets it.
    /** @type {import('@playwright/test').Route[]} */
    const held = [];
    /** @type {string[]} */
    const requested = [];
    await page.route(/\/assets\/supabase-[A-Z0-9]+\.js(?:\?|$)/, (route) => {
      requested.push(new URL(route.request().url()).search);
      held.push(route);
    });
    await page.goto('/');
    // The load gets the time of a Supabase request; then the app is offline and finishes booting.
    await expect(page.locator('#dbStatusBadge')).toHaveText('Offline', { timeout: 20_000 });
    await expect(page.locator('#chatMessages')).toContainText('The kickoff is in room Aurora.');
    expect(requested).toEqual(['']);

    // The reconnect asks under another URL, and that download stalls as well; the first one then
    // arrives after all and is used.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => requested).toEqual(['', '?attempt=1']);
    await held[0].fallback();
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');
    await held[1].fallback();
    expect(diagnostics).toEqual([]);
  });
});

test.describe('local mode without WebGPU', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    });
  });

  test('explains why a WebGPU model is unavailable and keeps answering', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    // A WebGPU preset picked explicitly (the picker marks it): no silent switch to the processor.
    await expect(page.locator('#engineSelector[data-ready="true"] option[value="webgpu:llama-1b"]')).toContainText('needs WebGPU');
    await page.selectOption('#engineSelector', 'webgpu:llama-1b');
    await expect(page.locator('#chatMessages')).toContainText('On-device mode is not available');
    await expect(page.locator('#privacyNotice')).toContainText('On-device mode');

    await ask(page, 'Wann ist der Launch von Projekt Beta?');
    await expect(page.locator('#chatMessages')).toContainText('3. März geplant');
    // Local mode: the question is ranked in the browser, never sent to the search RPC or chat table.
    expect(calls.some((c) => c.url.startsWith('/rest/v1/rpc/search_knowledge'))).toBe(false);
    expect(calls.some((c) => c.url.startsWith('/rest/v1/chat_history') && c.method === 'POST')).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  test('offers a processor model instead and downloads nothing without consent', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    /** @type {string[]} */
    const dialogs = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.goto('/');
    // The device's recommendation comes first: a processor (WASM) model on a device without WebGPU;
    // which one depends on its memory.
    const recommended = page.locator('#engineSelector[data-ready="true"] optgroup[data-group="recommended"] option[value^="wasm:"]').first();
    const value = await recommended.getAttribute('value');
    expect(value).toMatch(/^wasm:/);
    await page.selectOption('#engineSelector', value ?? '');
    await expect.poll(() => dialogs.length).toBe(1);
    expect(WASM_LABELS.filter((label) => dialogs[0].includes(`"${label}"`))).toHaveLength(1);
    expect(dialogs[0]).toContain('plus 15 MB for the runtime');
    await expect(page.locator('#webgpuProgressContainer')).toBeHidden();
    await expect(page.locator('#privacyNotice')).toContainText('On-device mode');

    // Declined again when asking: the answer is quoted from the sources, and the fixture reports
    // any request to huggingface.co.
    await ask(page, 'Wann ist der Launch von Projekt Beta?');
    await expect(page.locator('#chatMessages')).toContainText('3. März geplant');
    expect(dialogs).toHaveLength(2);
    expect(dialogs[1]).toBe(dialogs[0]);
    expect(diagnostics).toEqual([]);
  });

  test('diagnostics report the missing WebGPU support and offer the processor benchmark instead', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'bench');
    await expect(page.locator('#benchWebgpuStatusText')).toHaveText('WebGPU not supported');
    await expect(page.locator('#benchModelHint')).toContainText('processor (WASM) model');
    await expect(page.locator('#btnRunBenchmark')).toBeEnabled();
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
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Ask anything…');
    await expect(settingsNav).toHaveText('Settings');
    await expect(page.locator('#privacyNotice')).toContainText('No model configured');
    await expect(page.locator('select[data-change="set-locale"]')).toHaveValue('en');

    /** @type {string[]} */
    const navigations = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await chooseLanguage(page, 'de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Fragen Sie, was Sie wollen…');
    await expect(settingsNav).toHaveText(isMobile ? 'Optionen' : 'Einstellungen');
    await expect(page.locator('#privacyNotice')).toContainText('Kein Modell eingerichtet');
    await expect(page.locator('#sendBtn')).toHaveAttribute('aria-label', 'Senden');
    await expect(page.locator('select[data-change="set-locale"]')).toHaveValue('de');
    expect(navigations).toEqual([]);

    // Quick prompts ask in the active language.
    await page.click('[data-action="quick-prompt"][data-arg="chat.prompt_docs_question"]');
    await expect(page.locator('#chatMessages')).toContainText('Welche Dokumente sind in der Wissensdatenbank verfügbar?');
    await expect(page.locator('#chatMessages')).toContainText('Verfügbare Dokumente (2)');

    // The quick prompt switched the composer to source mode, and that is kept as well.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Frage stellen…');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    await chooseLanguage(page, 'en');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Ask a question…');
    await expect(settingsNav).toHaveText('Settings');
    expect(await page.evaluate(() => localStorage.getItem('starpi_locale'))).toBe('en');
    expect(diagnostics).toEqual([]);
  });

  test('offers six languages and switches to French and Turkish without a reload', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
    const settingsNav = page.locator(isMobile ? '#mobile-nav-settings' : '#nav-settings');
    const select = page.locator('select[data-change="set-locale"]');
    await expect(select.locator('option')).toHaveText(['English', 'Deutsch', 'Français', 'Español', 'Italiano', 'Türkçe']);
    /** @type {string[]} */
    const navigations = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });

    await chooseLanguage(page, 'fr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Demandez ce que vous voulez…');
    await expect(settingsNav).toHaveText(isMobile ? 'Réglages' : 'Paramètres');
    await expect(page.locator('#privacyNotice')).toContainText('Aucun modèle configuré');
    await expect(page.locator('#sendBtn')).toHaveAttribute('aria-label', 'Envoyer');

    await chooseLanguage(page, 'tr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'İstediğinizi sorun…');
    await expect(settingsNav).toHaveText('Ayarlar');
    await expect(page.locator('#privacyNotice')).toContainText('Yapılandırılmış model yok');
    expect(navigations).toEqual([]);

    // The choice is kept, and its dictionary is loaded before the first render.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(select).toHaveValue('tr');
    await expect(settingsNav).toHaveText('Ayarlar');
    await chooseLanguage(page, 'en');
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
    await expect(list).toContainText('1 page · 1 chunk');

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

    // File contents never leave the device, and neither does a chat turn answered from them: the
    // question and the answer are both stored as on-device turns.
    const leaked = calls.filter((c) => /steering group|480000/.test(`${c.url} ${c.body ?? ''}`));
    expect(leaked).toEqual([]);
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/chat_history'))).toEqual([]);
    await expect.poll(async () => (await storedChatNodes(page)).length).toBe(2);
    const stored = await storedChatText(page);
    expect(stored).toContain('What is the approved budget for Project Nebula?');
    expect(stored).toContain('480000 EUR');
    expect((await storedChatNodes(page)).map((n) => n.localOnly)).toEqual([true, true]);
    expect(diagnostics).toEqual([]);
  });

  test('keeps a question about an attached file and its answer on the device', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    await page.setInputFiles('#chatFileInput', { name: 'orion-roadmap.md', mimeType: 'text/markdown', buffer: Buffer.from('# Orion\n\nThe Orion release ships in calendar week 38.') });
    await expect(page.locator('#attachedInfo')).toContainText('orion-roadmap.md · 1 chunk');
    await ask(page, 'When does the Orion release ship?');
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer).toContainText('calendar week 38');

    await expect.poll(async () => (await storedChatNodes(page)).length).toBe(2);
    const stored = await storedChatText(page);
    expect(stored).toContain('orion-roadmap.md');
    expect(stored).toContain('calendar week 38');
    expect((await storedChatNodes(page)).map((n) => n.localOnly)).toEqual([true, true]);
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/chat_history'))).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test('an earlier citation never opens a file added after the workspace was cleared', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', { name: 'alpha.md', mimeType: 'text/markdown', buffer: Buffer.from('# Alpha\n\nThe Alpha budget is 120000 EUR.') });
    await expect(page.locator('#workspaceList li')).toHaveCount(1);

    await openTab(page, 'chat');
    await ask(page, 'What is the Alpha budget?');
    const citation = page.locator('#chatMessages > div').last().locator('.message-content [data-action="open-citation"]').first();
    await expect(citation).toContainText('alpha.md');

    // Clearing replaces the worker; the next file must not inherit the cited file's id.
    await openTab(page, 'ingest');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.click('[data-action="workspace-clear"]');
    await expect(page.locator('#workspaceList li')).toHaveCount(0);
    await page.setInputFiles('#workspaceFileInput', { name: 'beta.md', mimeType: 'text/markdown', buffer: Buffer.from('# Beta\n\nThe Beta launch is planned for May.') });
    await expect(page.locator('#workspaceList li')).toHaveCount(1);

    await openTab(page, 'chat');
    await citation.click();
    const drawer = page.locator('#citationModal');
    await expect(drawer.locator('#citationModalNote')).toHaveText(/no longer in the workspace/);
    await expect(drawer).toContainText('120000 EUR');
    await expect(drawer).not.toContainText('Beta launch');
    expect(diagnostics).toEqual([]);
  });

  test('reports every file of a batch and does not index the same file twice', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'ingest');
    const notes = { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nThe steering group meets every Tuesday in room 4.') };
    await page.setInputFiles('#workspaceFileInput', [{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, notes]);
    const status = page.locator('#workspaceStatus');
    await expect(status).toContainText('notes.md added: 1 chunk indexed.');
    await expect(status).toContainText('photo.png: this file type is not supported.');

    await page.setInputFiles('#workspaceFileInput', notes);
    await expect(status).toContainText('notes.md is already in the workspace');
    await expect(page.locator('#workspaceList li')).toHaveCount(1);

    // A different file with the same name gets its own name, so citation labels stay unambiguous.
    await page.setInputFiles('#workspaceFileInput', { ...notes, buffer: Buffer.from('# Notes\n\nThe budget review is on Friday.') });
    await expect(page.locator('#workspaceList li')).toHaveCount(2);
    await expect(page.locator('#workspaceList')).toContainText('notes (2).md');
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
