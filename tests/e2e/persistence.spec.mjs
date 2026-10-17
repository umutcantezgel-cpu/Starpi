// The persistent workspace in the browser: files added on the "Add knowledge" tab survive a reload
// (IndexedDB plus the origin private file system), the first file asks whether to keep them, "Forget
// all" removes them, "Memory only" keeps nothing, and Settings show the storage and the semantic
// search opt-in, which downloads nothing until it is turned on.
import { expect, mockSupabase, test } from './fixtures.mjs';

/** @param {import('@playwright/test').Page} page @param {string} tab */
async function openTab(page, tab) {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page.click(isMobile ? `#mobile-nav-${tab}` : `#nav-${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

const NOTES = { name: 'nebula-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Nebula notes\n\nThe approved budget for Project Nebula is 480000 EUR.\n\nThe steering group meets every Tuesday in room 4.') };

/** @param {import('@playwright/test').Page} page */
function modelRequests(page) {
  /** @type {string[]} */
  const urls = [];
  page.on('request', (req) => {
    if (/huggingface\.co|hf\.co/.test(req.url())) urls.push(req.url());
  });
  return urls;
}

test.describe('persistent workspace', () => {
  test('keeps files after a reload, answers from them and forgets them on request', async ({ page, diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const models = modelRequests(page);
    await page.goto('/');
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', NOTES);
    await expect(page.locator('#workspaceList li')).toHaveCount(1);

    // The first file asks; the answer defaults to keeping them.
    const prompt = page.locator('#workspacePersist [data-state="ask"]');
    await expect(prompt).toContainText('Keep files on this device after reload?');
    await prompt.locator('[data-action="workspace-keep"][data-arg="yes"]').click();
    await expect(page.locator('#workspacePersist [data-state="kept"]')).toContainText('Kept on this device');

    await page.reload();
    await openTab(page, 'ingest');
    await expect(page.locator('#workspaceList li')).toHaveCount(1);
    await expect(page.locator('#workspaceList')).toContainText('nebula-notes.md');
    await expect(page.locator('#workspacePersist [data-state="kept"]')).toBeVisible();

    // The index was rebuilt from the stored chunks.
    await page.fill('#workspaceQuery', 'Nebula budget');
    await page.press('#workspaceQuery', 'Enter');
    await expect(page.locator('#workspaceResults li')).toHaveCount(1);
    await expect(page.locator('#workspaceResults li').first()).toContainText('480000 EUR');

    // An answer cites the restored file, and the citation drawer reads its text back.
    await openTab(page, 'chat');
    await page.fill('#chatInput', 'What is the approved budget for Project Nebula?');
    await page.press('#chatInput', 'Enter');
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer).toContainText('480000 EUR');
    await answer.locator('.message-content [data-action="open-citation"]').first().click();
    const drawer = page.locator('#citationModal');
    await expect(drawer.locator('#citationModalDoc')).toHaveText('nebula-notes.md');
    await expect(drawer.locator('mark')).toContainText('480000 EUR');
    await page.keyboard.press('Escape');

    // One click forgets everything, also after the next reload.
    await openTab(page, 'ingest');
    await page.click('#workspacePersist [data-action="workspace-forget-all"]');
    await expect(page.locator('#workspaceList li')).toHaveCount(0);
    await page.reload();
    await openTab(page, 'ingest');
    await expect(page.locator('#workspaceEmpty')).toBeVisible();
    await expect(page.locator('#workspaceList li')).toHaveCount(0);

    // Files never leave the device, and no search model is downloaded without the opt-in.
    expect(calls.filter((c) => /480000|steering group/.test(`${c.url} ${c.body ?? ''}`))).toEqual([]);
    expect(models).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test('memory only keeps nothing after a reload', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', NOTES);
    await expect(page.locator('#workspaceList li')).toHaveCount(1);
    await page.click('#workspacePersist [data-action="workspace-keep"][data-arg="no"]');
    await expect(page.locator('#workspacePersist [data-state="memory"]')).toContainText('Memory only');

    await page.reload();
    await openTab(page, 'ingest');
    await expect(page.locator('#workspaceEmpty')).toBeVisible();
    // The answer is remembered: the next file is not kept and not asked about again.
    await page.setInputFiles('#workspaceFileInput', NOTES);
    await expect(page.locator('#workspaceList li')).toHaveCount(1);
    await expect(page.locator('#workspacePersist [data-state="memory"]')).toBeVisible();
    await expect(page.locator('#workspacePersist [data-state="ask"]')).toHaveCount(0);
    expect(diagnostics).toEqual([]);
  });

  test('settings show the storage, the keep choice and semantic search off until opted in', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const models = modelRequests(page);
    await page.goto('/');
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', NOTES);
    await expect(page.locator('#workspaceList li')).toHaveCount(1);

    await openTab(page, 'settings');
    const card = page.locator('#workspaceSettingsCard');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toContainText('Files on this device');
    await expect(card.locator('#wsUsage')).toContainText(/used by this site|does not report/);
    await expect(card.locator('#wsFiles')).toContainText('1 files kept');
    await expect(card.locator('#wsKeep')).toBeChecked();
    await expect(card.locator('#wsSemantic')).not.toBeChecked();
    await expect(card.locator('#wsSemanticStatus')).toHaveText('Off.');
    await expect(card.locator('#wsSemanticSize')).toContainText('136 MB');
    await expect(card.locator('#wsSemanticModel option')).toHaveCount(2);

    await card.locator('#wsForgetAll').click();
    await expect(card.locator('#wsFiles')).toHaveText('No workspace files are kept on this device.');
    await openTab(page, 'ingest');
    await expect(page.locator('#workspaceList li')).toHaveCount(0);
    expect(models).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});
