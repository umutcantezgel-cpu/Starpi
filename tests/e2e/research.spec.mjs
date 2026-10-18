// The Research tab without any model: a job searches the (mocked) library, quotes the matching
// sentence with its citation, and keeps the report with a Markdown export and a receipt. A job that
// runs while the page reloads comes back interrupted and finishes on retry; the header badge counts
// running jobs. "Research this" in the library's document dialog fills the question box.
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, mockSupabase, PLAIN_DOC, test } from './fixtures.mjs';

const QUESTION = 'Wann ist der Launch von Projekt Beta geplant?';
const CITED = 'Der Launch von Projekt Beta ist für den 3. März geplant.';
const LABEL = '[Doc: Projekt Beta Kickoff, Chunk: 1]';

/** @param {import('@playwright/test').Page} page */
const isMobile = (page) => (page.viewportSize()?.width ?? 1280) < 768;

/** @param {import('@playwright/test').Page} page @param {string} tab */
async function openTab(page, tab) {
  await page.click(isMobile(page) ? `#mobile-nav-${tab}` : `#nav-${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

/** @param {import('@playwright/test').Page} page */
const firstJob = (page) => page.locator('#researchJobList > li').first();

test.describe('research', () => {
  test('a job quotes the library with its citation and keeps the report, Markdown and receipt', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'research');
    await page.click('#researchStart');
    await expect(page.locator('#researchFormStatus')).toHaveText('Enter a question first.');
    await page.fill('#researchQuestion', QUESTION);
    await page.click('#researchStart');
    await expect(page.locator('#researchFormStatus')).toHaveText('Research started. It keeps running in the background.');
    const job = firstJob(page);
    await expect(job).toContainText(QUESTION);
    await expect(job.locator('.chip')).toHaveText('Done');
    // The report opens with the job started here.
    const report = job.locator('[id^="researchReport-"]');
    await expect(report).toBeVisible();
    await expect(report).toContainText('From your documents');
    await expect(report).toContainText('Quoted from your documents: no model was available');
    await expect(report).toContainText(CITED);
    await expect(report.locator('.citation-chip').first()).toContainText('Projekt Beta Kickoff');
    await expect(report).not.toContainText('From the web');
    const results = await new AxeBuilder({ page }).include('#tab-research').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
    // The citation opens the excerpt in the citation drawer.
    await report.locator('.citation-chip').first().click();
    await expect(page.locator('#citationModal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#citationModal')).toBeHidden();
    // Markdown export.
    const [download] = await Promise.all([page.waitForEvent('download'), report.getByRole('button', { name: 'Download Markdown' }).click()]);
    const markdown = readFileSync(/** @type {string} */ (await download.path()), 'utf8');
    for (const piece of ['# Research report', `${CITED} ${LABEL}`, '## Sources', 'The answer receipt covers the part from the documents']) expect(markdown).toContain(piece);
    // The receipt of the documents part opens in the receipt dialog.
    await report.locator('[data-action="open-receipt"]').click();
    await expect(page.locator('#receiptModal')).toBeVisible();
    await expect(page.locator('#receiptCounts')).toContainText('1');
    await page.keyboard.press('Escape');
    // Closing and reopening the report reads it back and checks it again.
    await job.getByRole('button', { name: 'Close report' }).click();
    await expect(report).toBeHidden();
    await job.getByRole('button', { name: 'Open report' }).click();
    await expect(report).toContainText(CITED);
    // The job is stored: it is still there after a reload.
    await page.reload();
    await openTab(page, 'research');
    await expect(firstJob(page).locator('.chip')).toHaveText('Done');
    await firstJob(page).getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('#researchJobList > li')).toHaveCount(0);
    await expect(page.locator('#researchEmpty')).toBeVisible();
    expect(diagnostics).toEqual([]);
  });

  test('a job running during a reload comes back interrupted and finishes on retry; the badge counts it', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    let hold = true;
    // Registered after the Supabase mock, so it sees the search first: held while `hold` is set.
    await page.route(/\/rest\/v1\/rpc\/search_knowledge/, async (route) => {
      if (!hold) return route.fallback();
      await new Promise(() => {});
    });
    await page.goto('/');
    await openTab(page, 'research');
    await page.fill('#researchQuestion', QUESTION);
    await page.click('#researchStart');
    const job = firstJob(page);
    await expect(job.locator('.chip')).toHaveText('Running');
    await expect(job).toContainText('Searching your documents');
    await expect(page.locator('#researchBadge')).toBeVisible();
    await expect(page.locator('#researchBadge')).toHaveText('1');
    await expect(page.locator('#researchBadge')).toHaveAttribute('aria-label', '1 research job running');

    await page.reload();
    hold = false;
    await openTab(page, 'research');
    await expect(firstJob(page).locator('.chip')).toHaveText('Interrupted');
    await expect(firstJob(page)).toContainText('The page was closed or reloaded while this job ran.');
    await expect(page.locator('#researchBadge')).toBeHidden();
    await firstJob(page).getByRole('button', { name: 'Retry' }).click();
    await expect(firstJob(page).locator('.chip')).toHaveText('Done');
    await firstJob(page).getByRole('button', { name: 'Open report' }).click();
    await expect(firstJob(page)).toContainText(CITED);
    expect(diagnostics).toEqual([]);
  });

  test('a running job can be cancelled', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.route(/\/rest\/v1\/rpc\/search_knowledge/, async () => {
      await new Promise(() => {});
    });
    await page.goto('/');
    await openTab(page, 'research');
    await page.fill('#researchQuestion', QUESTION);
    await page.click('#researchStart');
    const job = firstJob(page);
    await expect(job.locator('.chip')).toHaveText('Running');
    await job.getByRole('button', { name: 'Cancel' }).click();
    await expect(job.locator('.chip')).toHaveText('Cancelled');
    await expect(job.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(diagnostics).toEqual([]);
  });

  test('"Research this" in a library document puts its title into the question box', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'library');
    await page.locator(`[data-action="view-doc"][data-arg="${PLAIN_DOC.id}"]`).click();
    await expect(page.locator('#docModal')).toBeVisible();
    await page.locator('#docModal').getByRole('button', { name: 'Research this' }).click();
    await expect(page.locator('#docModal')).toBeHidden();
    await expect(page.locator('#tab-research')).toBeVisible();
    await expect(page.locator('#researchQuestion')).toHaveValue(PLAIN_DOC.title);
    await expect(page.locator('#researchQuestion')).toBeFocused();
    await expect(page.locator('#researchFocus')).toContainText(`About the document “${PLAIN_DOC.title}”`);
    await page.click('#researchFocusClear');
    await expect(page.locator('#researchFocus')).toBeHidden();
    expect(diagnostics).toEqual([]);
  });
});
