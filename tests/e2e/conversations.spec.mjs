// The conversation list in the sidebar: a chat kept by 2.x in localStorage is moved into the app
// database on the first start, new chats appear under Today, and every row can be opened, renamed
// (by keyboard), pinned, searched, exported and deleted. On phones the list lives in the drawer,
// which closes when a chat is chosen. Accessibility is checked with the list and a row menu open.
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { chooseLanguage, expect, mockSupabase, storedChatNodes, test } from './fixtures.mjs';

const LEGACY_ID = 'starpi_legacy-tides-0001';
const DAY_MS = 86_400_000;

/** @param {import('@playwright/test').Page} page */
const isMobile = (page) => (page.viewportSize()?.width ?? 1280) < 768;

/**
 * Puts a 2.x chat (a month old) into localStorage before the app starts, once per tab, the way 2.x
 * stored it.
 * @param {import('@playwright/test').Page} page
 */
async function seedLegacyChat(page) {
  const at = Date.now() - 30 * DAY_MS;
  await page.addInitScript(
    ({ id, at }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      const chats = {
        [id]: {
          updatedAt: at,
          messages: [
            { role: 'user', content: 'How do tides work?', sources: [], metadata: { chat_mode: 'free', local_only: false }, created_at: new Date(at - 60_000).toISOString() },
            { role: 'assistant', content: 'Tides follow the pull of the moon.', sources: [], metadata: { chat_mode: 'free', engine: 'cloud', local_only: true }, created_at: new Date(at).toISOString() },
          ],
        },
      };
      localStorage.setItem('starpi_local_chats_v1', JSON.stringify(chats));
    },
    { id: LEGACY_ID, at },
  );
}

/** @param {import('@playwright/test').Page} page */
async function showList(page) {
  if (isMobile(page) && (await page.locator('#menuButton').getAttribute('aria-expanded')) !== 'true') await page.click('#menuButton');
  await expect(page.locator('#chat-sidebar [data-action="new-chat"]')).toBeVisible();
}

/** Closes the drawer on phones (it covers the header there). @param {import('@playwright/test').Page} page */
async function hideList(page) {
  if (!isMobile(page)) return;
  await page.locator('#sidebar [data-action="toggle-sidebar"]').click();
  await expect(page.locator('#menuButton')).toHaveAttribute('aria-expanded', 'false');
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

/** @param {import('@playwright/test').Page} page @param {string} label */
async function axe(page, label) {
  const results = await new AxeBuilder({ page }).include('#sidebar').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** @param {import('@playwright/test').Page} page @param {string} id */
const row = (page, id) => page.locator(`#chat-sidebar li[data-conv-id="${id}"]`);
/** @param {import('@playwright/test').Page} page @param {string} name */
const group = (page, name) => page.locator('#chat-sidebar section').filter({ has: page.getByRole('heading', { name, exact: true }) });

test.describe('conversation list', () => {
  test('moves 2.x chats in, lists new chats, opens, renames, pins, searches and deletes them', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await seedLegacyChat(page);
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    // The 2.x chat is a conversation now, and localStorage no longer holds it.
    await showList(page);
    await expect(group(page, 'Older')).toContainText('How do tides work?');
    expect(await page.evaluate(() => localStorage.getItem('starpi_local_chats_v1'))).toBeNull();
    const migrated = await storedChatNodes(page, LEGACY_ID);
    expect(migrated.map((n) => [n.role, n.localOnly])).toEqual([
      ['user', false],
      ['assistant', true],
    ]);

    // A new question becomes a conversation under Today, titled after it and marked as current.
    if (isMobile(page)) await page.click('#chat-sidebar [data-action="new-chat"]');
    await expect(page.locator('#chatInput')).toBeVisible();
    await ask(page, 'Wann ist der Launch von Projekt Beta?');
    await expect(page.locator('#chatMessages')).toContainText('3. März geplant');
    await showList(page);
    const today = group(page, 'Today');
    await expect(today.locator('[data-action="conv-open"]')).toHaveText('Wann ist der Launch von Projekt Beta?');
    await expect(today.locator('[data-action="conv-open"]')).toHaveAttribute('aria-current', 'true');
    const betaId = /** @type {string} */ (await today.locator('li').getAttribute('data-conv-id'));

    // Opening the older chat shows its thread; on phones the drawer closes.
    await row(page, LEGACY_ID).locator('[data-action="conv-open"]').click();
    await expect(page.locator('#chatMessages')).toContainText('Tides follow the pull of the moon.');
    await expect(page.locator('#chatMessages')).not.toContainText('3. März geplant');
    if (isMobile(page)) await expect(page.locator('#menuButton')).toHaveAttribute('aria-expanded', 'false');
    await showList(page);
    await expect(row(page, LEGACY_ID).locator('[data-action="conv-open"]')).toHaveAttribute('aria-current', 'true');

    // Rename by keyboard: the menu button opens the menu on ArrowDown, Enter picks Rename.
    const menuButton = row(page, LEGACY_ID).locator('[data-action="conv-menu"]');
    await menuButton.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'Actions for How do tides work?' });
    await expect(menu).toBeVisible();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
    await axe(page, `menu open (${isMobile(page) ? 'drawer' : 'sidebar'})`);
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Pin' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    const input = page.getByRole('textbox', { name: 'New title for How do tides work?' });
    await expect(input).toBeFocused();
    await input.fill('Tides explained');
    await page.keyboard.press('Enter');
    await expect(row(page, LEGACY_ID).locator('[data-action="conv-open"]')).toHaveText('Tides explained');
    await expect(row(page, LEGACY_ID).locator('[data-action="conv-open"]')).toBeFocused();

    // Pin: the chat moves to the Pinned group; Escape closes a menu and returns to its button.
    await menuButton.click();
    await page.getByRole('menuitem', { name: 'Pin' }).click();
    await expect(group(page, 'Pinned')).toContainText('Tides explained');
    await row(page, betaId).locator('[data-action="conv-menu"]').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(row(page, betaId).locator('[data-action="conv-menu"]')).toBeFocused();

    // Search over titles and first questions, with a prefix match on the word being typed.
    await page.fill('#chatListSearch', 'proj');
    const results = group(page, 'Search results');
    await expect(results.locator('[data-action="conv-open"]')).toHaveText(['Wann ist der Launch von Projekt Beta?']);
    await expect(page.locator('#chatListStatus')).toHaveText('1 chat found');
    await page.fill('#chatListSearch', 'tides wor');
    await expect(results.locator('[data-action="conv-open"]')).toHaveText(['Pinned: Tides explained']);
    await page.press('#chatListSearch', 'Escape');
    await expect(group(page, 'Pinned')).toBeVisible();
    await axe(page, `list (${isMobile(page) ? 'drawer' : 'sidebar'})`);

    // Delete (not the current chat): confirmed, gone from the list and from the database.
    await row(page, betaId).locator('[data-action="conv-menu"]').click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.locator('#toastRegion')).toContainText('Chat deleted');
    await expect(row(page, betaId)).toHaveCount(0);
    expect(await storedChatNodes(page, betaId)).toEqual([]);

    // Both languages.
    await hideList(page);
    await chooseLanguage(page, 'de');
    await showList(page);
    await expect(page.locator('#chat-sidebar [data-action="new-chat"]')).toHaveText('Neuer Chat');
    await expect(group(page, 'Angeheftet')).toContainText('Tides explained');
    await expect(page.locator('#chatListSearch')).toHaveAttribute('placeholder', 'Chats durchsuchen');
    await hideList(page);
    await chooseLanguage(page, 'en');
    await expect(page.locator('#chat-sidebar [data-action="new-chat"]')).toHaveText('New chat');

    // After a reload the list and the open chat are the same.
    await page.reload();
    await expect(page.locator('#chatMessages')).toContainText('Tides follow the pull of the moon.');
    await showList(page);
    await expect(group(page, 'Pinned')).toContainText('Tides explained');
    await expect(page.locator('#chat-sidebar li[data-conv-id]')).toHaveCount(1);
    expect(diagnostics).toEqual([]);
  });

  test('is accessible in the dark theme with the current chat pinned and its menu open', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await seedLegacyChat(page);
    await page.addInitScript(() => localStorage.setItem('starpi_theme', 'dark'));
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await showList(page);
    await row(page, LEGACY_ID).locator('[data-action="conv-open"]').click();
    await expect(page.locator('#chatMessages')).toContainText('Tides follow the pull of the moon.');
    await showList(page);
    await row(page, LEGACY_ID).locator('[data-action="conv-menu"]').click();
    await page.getByRole('menuitem', { name: 'Pin' }).click();
    await expect(group(page, 'Pinned').locator('[aria-current="true"]')).toContainText('How do tides work?');
    await axe(page, 'dark list');
    await row(page, LEGACY_ID).locator('[data-action="conv-menu"]').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await axe(page, 'dark menu');
    expect(diagnostics).toEqual([]);
  });

  test('exports a conversation from its menu as starpi.chat/v2 and imports it back', async ({ page, diagnostics }, testInfo) => {
    test.skip(isMobile(page), 'the export is the same on phones; the drawer is covered above');
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await seedLegacyChat(page);
    await page.goto('/');
    await showList(page);

    await row(page, LEGACY_ID).locator('[data-action="conv-menu"]').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export as JSON' }).click()]);
    const file = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(file);
    expect(download.suggestedFilename()).toMatch(/^starpi-chat-\d{4}-\d{2}-\d{2}-legacy-t\.json$/);
    const text = readFileSync(file, 'utf8');
    const doc = JSON.parse(text);
    expect(doc.schema).toBe('starpi.chat/v2');
    expect(doc.conversation).toMatchObject({ id: LEGACY_ID, title: 'How do tides work?', mode: 'free' });
    expect(doc.nodes.map((/** @type {{ role: string }} */ n) => n.role)).toEqual(['user', 'assistant']);
    expect(doc.nodes[1]).toMatchObject({ parts: [{ type: 'text', text: 'Tides follow the pull of the moon.' }], engine: 'cloud', label: 'free' });
    expect(doc.activePath).toEqual(doc.nodes.map((/** @type {{ id: string }} */ n) => n.id));
    // Internal flags stay out of an export.
    expect(text).not.toContain('localOnly');

    await page.setInputFiles('#chat-sidebar [data-conv-import]', { name: 'chat.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(page.locator('#toastRegion')).toContainText('Chat imported: How do tides work?');
    // The copy is a conversation of its own, opened in the chat.
    await expect(page.locator('#chat-sidebar li[data-conv-id]')).toHaveCount(2);
    await expect(page.locator('#chat-sidebar [aria-current="true"]')).toHaveText('How do tides work?');
    await expect(row(page, LEGACY_ID).locator('[data-action="conv-open"]')).not.toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#chatMessages')).toContainText('Tides follow the pull of the moon.');
    expect(diagnostics).toEqual([]);
  });
});
