// A browser profile as Starpi 2.1 left it, opened by 3.0 for the first time: the chats 2.1 kept in
// localStorage, the provider keys it remembered in plain text, and its settings (compute mode, chat
// mode, language, own server). The first start moves the chats into the app database (one
// conversation each, every turn keeping its on-device flag), moves the keys into this tab's session
// storage and suggests a vault passphrase, turns the 2.x compute mode into a picker value, keeps the
// chat mode, the language and the open chat, and never reads or writes the 2.x plaintext chat table.
// A reload migrates nothing twice.
import { readFile } from 'node:fs/promises';
import { expect, mockSupabase, storedChatNodes, test } from './fixtures.mjs';

const CURRENT = 'starpi_profile-2-1-current';
const OLDER = 'starpi_profile-2-1-older';
const GEMINI = 'AIzaSyA-e2e-profile-21-0123456789abcd';
const OPENROUTER = 'sk-or-v1-e2e-profile-21-0123456789wxyz';
const OWN_SERVER = 'http://localhost:11434/v1';
const DAY_MS = 86_400_000;

/** @param {import('@playwright/test').Page} page */
const isMobile = (page) => (page.viewportSize()?.width ?? 1280) < 768;

/**
 * Seeds the 2.1 profile before the app starts, once per tab, the way 2.1 stored it.
 * @param {import('@playwright/test').Page} page
 */
async function seedProfile(page) {
  await page.addInitScript(
    ({ current, older, gemini, openrouter, ownServer, now, day }) => {
      if (sessionStorage.getItem('e2e_profile_seeded')) return;
      sessionStorage.setItem('e2e_profile_seeded', '1');
      const at = (/** @type {number} */ ms) => new Date(ms).toISOString();
      const chats = {
        [current]: {
          updatedAt: now - 3_600_000,
          messages: [
            { role: 'user', content: 'What does a lighthouse keeper do?', sources: [], metadata: { chat_mode: 'free', local_only: false }, created_at: at(now - 3_700_000) },
            { role: 'assistant', content: 'A lighthouse keeper tends the light and the lens.', sources: [], metadata: { chat_mode: 'free', engine: 'cloud', local_only: false }, created_at: at(now - 3_690_000) },
            { role: 'user', content: 'When does the harbour plan start?', sources: [], metadata: { chat_mode: 'grounded', local_only: true }, created_at: at(now - 3_650_000) },
            {
              role: 'assistant',
              content: 'The harbour plan starts on 3 March [Doc: harbour-plan.md, Chunk: 1].',
              sources: [{ title: 'harbour-plan.md', rank: 1 }],
              metadata: { chat_mode: 'grounded', engine: 'synthesizer', local_only: true },
              created_at: at(now - 3_600_000),
            },
          ],
        },
        [older]: {
          updatedAt: now - 40 * day,
          messages: [
            { role: 'user', content: 'How tall is the old tower?', sources: [], metadata: { chat_mode: 'free', local_only: false }, created_at: at(now - 40 * day - 60_000) },
            { role: 'assistant', content: 'The old tower is 32 metres tall.', sources: [], metadata: { chat_mode: 'free', engine: 'cloud', local_only: false }, created_at: at(now - 40 * day) },
          ],
        },
      };
      localStorage.setItem('starpi_local_chats_v1', JSON.stringify(chats));
      localStorage.setItem('starpi_chat_session_id', current);
      localStorage.setItem('starpi_gemini_key', gemini);
      localStorage.setItem('starpi_openrouter_key', openrouter);
      localStorage.setItem('starpi_remember_keys', '1');
      localStorage.setItem('starpi_compute_mode', 'council');
      localStorage.setItem('starpi_chat_mode', 'free');
      localStorage.setItem('starpi_locale', 'de');
      localStorage.setItem('starpi_llm_url', ownServer);
      localStorage.setItem('starpi_ai_tier', 'cluster_a');
    },
    { current: CURRENT, older: OLDER, gemini: GEMINI, openrouter: OPENROUTER, ownServer: OWN_SERVER, now: Date.now(), day: DAY_MS },
  );
}

/** @param {import('@playwright/test').Page} page */
function storage(page) {
  return page.evaluate(() => {
    /** @param {Storage} area */
    const dump = (area) => Object.fromEntries(Object.keys(area).map((k) => [k, area.getItem(k)]));
    return { local: dump(localStorage), session: dump(sessionStorage) };
  });
}

/**
 * The migration markers of the app database.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
function migrationMarkers(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('starpi');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction('settings').objectStore('settings').getAllKeys();
          all.onsuccess = () => {
            db.close();
            resolve(all.result.map(String).filter((k) => k.startsWith('migration:')).sort());
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** @param {import('@playwright/test').Page} page */
async function showList(page) {
  if (isMobile(page) && (await page.locator('#menuButton').getAttribute('aria-expanded')) !== 'true') await page.click('#menuButton');
  await expect(page.locator('#chat-sidebar [data-action="new-chat"]')).toBeVisible();
}

/** @param {import('@playwright/test').Page} page @param {string} id */
const row = (page, id) => page.locator(`#chat-sidebar li[data-conv-id="${id}"]`);

test.describe('migration from a 2.1 profile', () => {
  test('moves chats, keys and settings of 2.1 into 3.0 once', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await seedProfile(page);
    await page.goto('/');

    // Language and connection: the stored language is applied before the first render.
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    // The chat that was open in 2.1 is open again, with both of its turns.
    await expect(page.locator('#chatMessages')).toContainText('A lighthouse keeper tends the light and the lens.');
    await expect(page.locator('#chatMessages')).toContainText('The harbour plan starts on 3 March');

    // Chats: one conversation per 2.1 session, the messages as one thread, each turn keeping its
    // on-device flag and its chat mode as the answer's label; localStorage no longer holds them.
    await expect.poll(async () => (await storedChatNodes(page)).length).toBe(6);
    const current = await storedChatNodes(page, CURRENT);
    expect(current.map((n) => [n.role, n.localOnly, n.parts[0]?.text?.slice(0, 18)])).toEqual([
      ['user', false, 'What does a lighth'],
      ['assistant', false, 'A lighthouse keepe'],
      ['user', true, 'When does the harb'],
      ['assistant', true, 'The harbour plan s'],
    ]);
    const records = /** @type {Array<Record<string, unknown>>} */ (/** @type {unknown} */ (current));
    expect(records.map((n) => n.label)).toEqual([null, 'free', null, 'grounded']);
    expect(records[3].sources).toEqual([{ title: 'harbour-plan.md', rank: 1 }]);
    expect(records.slice(1).map((n) => n.parentId)).toEqual(records.slice(0, 3).map((n) => n.id));

    // Keys: out of plaintext localStorage, into this tab's session storage; the "remember keys"
    // switch and the 2.0 tier are gone, the vault hint is set. The compute mode became a picker
    // value; chat mode and own server stay.
    await expect.poll(async () => (await storage(page)).local.starpi_gemini_key ?? null).toBeNull();
    const after = await storage(page);
    expect(after.local).toMatchObject({ starpi_assistant_v1: 'auto', starpi_chat_mode: 'free', starpi_llm_url: OWN_SERVER, starpi_locale: 'de', starpi_vault_hint: '1' });
    for (const gone of ['starpi_local_chats_v1', 'starpi_gemini_key', 'starpi_openrouter_key', 'starpi_remember_keys', 'starpi_ai_tier']) {
      expect(after.local[gone], gone).toBeUndefined();
    }
    expect(after.session).toMatchObject({ starpi_gemini_key: GEMINI, starpi_openrouter_key: OPENROUTER });
    expect(JSON.stringify(after.local)).not.toContain(GEMINI);
    expect(JSON.stringify(after.local)).not.toContain(OPENROUTER);
    await expect(page.locator('#engineSelector')).toHaveValue('auto');
    await expect(page.locator('[data-action="set-chat-mode"][data-arg="free"]').first()).toHaveAttribute('aria-pressed', 'true');

    // Both conversations are in the list.
    await showList(page);
    await expect(row(page, CURRENT).locator('[data-action="conv-open"]')).toHaveAttribute('aria-current', 'true');
    await expect(row(page, OLDER)).toContainText('How tall is the old tower?');

    // The older chat exports as starpi.chat/v2, without the internal on-device flags.
    await row(page, OLDER).locator('[data-action="conv-menu"]').click();
    const download = page.waitForEvent('download');
    await page.locator('[data-action="conv-export"][data-arg="json"]').click();
    const file = await download;
    const text = await readFile(await file.path(), 'utf8');
    const doc = JSON.parse(text);
    expect(doc.schema).toBe('starpi.chat/v2');
    expect(text).toContain('The old tower is 32 metres tall.');
    expect(text).not.toContain('localOnly');
    if (isMobile(page) && (await page.locator('#menuButton').getAttribute('aria-expanded')) === 'true') {
      await page.locator('#sidebar [data-action="toggle-sidebar"]').click();
    }

    // Settings › Model providers and keys: the moved keys last for this tab, with the hint to set a
    // vault passphrase (in German).
    await page.click(isMobile(page) ? '#mobile-nav-settings' : '#nav-settings');
    await expect(page.locator('[data-pv="suggest"]')).toContainText('wurden verschoben');
    await expect(page.locator('[data-pv-status="gemini"]')).toContainText('••••abcd');
    await expect(page.locator('[data-pv-status="openrouter"]')).toContainText('••••wxyz');

    // Plaintext chat sync is gone: nothing reads or writes the 2.x chat table.
    expect(calls.filter((c) => c.url.startsWith('/rest/v1/chat_history'))).toEqual([]);

    // A reload migrates nothing twice: the same records, both markers, the same open chat.
    expect(await migrationMarkers(page)).toEqual(['migration:legacy-keys-v1', 'migration:local-chats-v1']);
    await page.reload();
    await expect(page.locator('#chatMessages')).toContainText('A lighthouse keeper tends the light and the lens.');
    expect((await storedChatNodes(page)).length).toBe(6);
    expect((await storage(page)).session).toMatchObject({ starpi_gemini_key: GEMINI });
    expect(calls.filter((c) => c.url.startsWith('/rest/v1/chat_history'))).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});
