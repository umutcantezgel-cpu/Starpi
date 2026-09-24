// End-to-end tests for the features that make answers checkable: the sample files, the source
// check, answer receipts, and the privacy and accessibility guarantees around them.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, mockSupabase, test } from './fixtures.mjs';

const BUDGET_MD = '# Budget\n\nThe approved budget for Project Nebula is 480,000 EUR. The steering group meets every Tuesday at 10:00.';

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

/** @param {import('@playwright/test').Page} page @param {string} name @param {string} content */
async function attach(page, name, content) {
  await page.setInputFiles('#chatFileInput', { name, mimeType: 'text/markdown', buffer: Buffer.from(content) });
  await expect(page.locator('#attachedFileName')).toContainText(name);
  await expect(page.locator('#attachedFileName')).toContainText('chunk');
}

/**
 * Answers every Gemini request with `text` and records the prompts sent.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
async function mockGemini(page, text) {
  await page.addInitScript(() => sessionStorage.setItem('starpi_gemini_key', 'test-key'));
  /** @type {string[]} */
  const prompts = [];
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    prompts.push(route.request().postData() ?? '');
    return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) });
  });
  return prompts;
}

test.describe('sample files', () => {
  test('load in one click and answer with citations that pass the source check', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await page.locator('#chatMessages [data-action="load-samples"]').click();
    await expect(page.getByText('Sample files ready')).toBeVisible({ timeout: 20_000 });

    await page.locator('[data-arg="demo.q_budget_question"]').click();
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer).toContainText('480,000 EUR');
    const bar = answer.locator('.grounding-bar');
    await expect(bar).toHaveClass(/grounding-ok/);
    await expect(bar.locator('summary')).toContainText(/(\d+)\/\1 statements match their cited excerpts/);
    await expect(answer.locator('.citation-chip-flag')).toHaveCount(0);
  });

  test('show the source check flagging a deliberate error, with its reason and a highlight', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await page.locator('#chatMessages [data-action="load-samples"]').click();
    await page.locator('[data-action="demo-check"]').click();
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer).toContainText('deliberate error');
    const bar = answer.locator('.grounding-bar');
    await expect(bar).toHaveClass(/grounding-review/);
    await expect(bar).toHaveAttribute('open', '');
    await expect(bar).toContainText('2/3 statements match their cited excerpts');
    await expect(bar).toContainText(/520,000 is not in \[Doc: nebula-plan\.md, Chunk: \d+\]/);
    await expect(answer.locator('.message-content .citation-chip-flag')).toHaveCount(1);
    expect(await page.evaluate(() => CSS.highlights.get('starpi-review')?.size ?? 0)).toBe(1);
  });
});

test.describe('chat', () => {
  test('answers a question that starts with a greeting from the sources', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await page.locator('#chatMessages [data-action="load-samples"]').click();
    await expect(page.getByText('Sample files ready')).toBeVisible({ timeout: 20_000 });
    await ask(page, 'Hi, what is the approved budget for Project Nebula?');
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer).toContainText('480,000 EUR');
    await expect(answer.locator('.grounding-bar')).toHaveClass(/grounding-ok/);
  });

  test('keeps a wide table inside the answer instead of scrolling the conversation sideways', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const head = Array.from({ length: 8 }, (_, i) => `Column heading ${i + 1}`);
    const table = `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n| ${head.map((_, i) => `value-${i}-with-some-length`).join(' | ')} |`;
    await mockGemini(page, `Here is the overview:\n\n${table}`);
    await page.goto('/');
    await ask(page, 'Show the overview as a table.');
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer.locator('table')).toBeVisible();
    const overflow = await page.locator('#chatMessages').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('grows the message box with multi-line questions', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    const input = page.locator('#chatInput');
    const before = await input.evaluate((el) => el.clientHeight);
    await input.fill('First line\nSecond line\nThird line\nFourth line');
    const after = await input.evaluate((el) => el.clientHeight);
    expect(after).toBeGreaterThan(before + 30);
  });
});

test.describe('source check on model answers', () => {
  test('flags a changed number and weekday and names them, and supports correct statements', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const label = '[Doc: budget.md, Chunk: 1]';
    await mockGemini(page, `The approved budget is 520,000 EUR ${label}. The steering group meets every Friday ${label}. It meets at 10:00 ${label}.`);
    await page.goto('/');
    await attach(page, 'budget.md', BUDGET_MD);
    await ask(page, 'What is the budget and when does the group meet?');

    const answer = page.locator('#chatMessages > div').last();
    const bar = answer.locator('.grounding-bar');
    await expect(bar).toContainText('1/3 statements match their cited excerpts');
    await expect(bar).toContainText(`520,000 is not in ${label}.`);
    await expect(bar).toContainText(`Friday is not in ${label}.`);
    await expect(answer.locator('.message-content .citation-chip-flag')).toHaveCount(2);
  });

  test('accepts the same facts in another format', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const label = '[Doc: budget.md, Chunk: 1]';
    await mockGemini(page, `Das freigegebene Budget beträgt 480.000 € ${label}. Die Gruppe tagt dienstags um 10:00 Uhr ${label}.`);
    await page.goto('/');
    await attach(page, 'budget.md', BUDGET_MD);
    await ask(page, 'Budget?');
    const bar = page.locator('#chatMessages > div').last().locator('.grounding-bar');
    await expect(bar).toHaveClass(/grounding-ok/);
    await expect(bar).toContainText('2/2 statements');
  });
});

test.describe('answer receipts', () => {
  test('download a receipt whose fingerprints match the file, and verify it in the app', async ({ page, diagnostics: _diagnostics }, testInfo) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await attach(page, 'budget.md', BUDGET_MD);
    await ask(page, 'What is the approved budget?');
    const answer = page.locator('#chatMessages > div').last();
    await expect(answer.locator('.grounding-bar')).toBeVisible();

    await answer.locator('[data-action="open-receipt"]').click();
    const dialog = page.locator('#receiptModal');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#receiptCounts')).toContainText('1 workspace');
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.locator('[data-action="download-receipt"]').click()]);
    const receiptPath = testInfo.outputPath('receipt.json');
    await download.saveAs(receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.schema).toBe('starpi.receipt/v1');
    expect(receipt.citations[0].document.fileSha256).toBe(createHash('sha256').update(BUDGET_MD).digest('hex'));

    const mdPath = testInfo.outputPath('budget.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(mdPath, BUDGET_MD);
    await dialog.locator('#receiptFile').setInputFiles(receiptPath);
    await dialog.locator('#receiptSources').setInputFiles(mdPath);
    await dialog.locator('[data-action="verify-receipt"]').click();
    await expect(dialog.locator('#receiptVerifyResult')).toContainText('1/1 workspace excerpts reproduced from your files');
    await expect(dialog.locator('#receiptVerifyResult')).toContainText('exact passage found in budget.md');

    writeFileSync(mdPath, BUDGET_MD.replace('480,000', '520,000'));
    await dialog.locator('#receiptSources').setInputFiles(mdPath);
    await dialog.locator('[data-action="verify-receipt"]').click();
    await expect(dialog.locator('#receiptVerifyResult')).toContainText('none of the chosen files has the recorded fingerprint');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(answer.locator('[data-action="open-receipt"]')).toBeFocused();
  });
});

test.describe('privacy of on-device turns', () => {
  test('never sends a turn that used the workspace to a cloud provider as history', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.addInitScript(() => sessionStorage.setItem('starpi_openrouter_key', 'test-key'));
    /** @type {Array<{ messages: Array<{ role: string, content: string }> }>} */
    const bodies = [];
    await page.route('https://openrouter.ai/**', async (route) => {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      bodies.push(JSON.parse(route.request().postData() ?? '{}'));
      return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ choices: [{ message: { content: 'Noted.' } }] }) });
    });
    await page.goto('/');
    await attach(page, 'salary.md', '# Contract\n\nThe annual salary of Jane Roe is 187,500 EUR.');
    await ask(page, 'What is the salary of Jane Roe?');
    await expect(page.locator('#chatMessages > div').last()).toContainText('Noted.');
    await ask(page, 'Thanks. What else should I know?');
    await expect.poll(() => bodies.length).toBe(2);
    const second = JSON.stringify(bodies[1].messages);
    expect(second).not.toContain('Jane Roe');
    expect(second).not.toContain('187,500');
  });
});

test.describe('without a browser session', () => {
  test('reads published knowledge and explains why saving is off instead of failing', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: false });
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Public knowledge');
    await expect(page.locator('#dbStatusDetail')).toContainText('Published documents');
    const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
    await page.click(isMobile ? '#mobile-nav-ingest' : '#nav-ingest');
    await expect(page.locator('#ingestBtn')).toBeDisabled();
    await expect(page.locator('#tab-ingest .session-note')).toBeVisible();
  });
});

test.describe('accessibility', () => {
  test('has no serious or critical axe violations in the main views', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await page.locator('#chatMessages [data-action="load-samples"]').click();
    await page.locator('[data-action="demo-check"]').click();
    await expect(page.locator('.grounding-bar').last()).toBeVisible();
    const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
    for (const tab of ['chat', 'library', 'graph', 'ingest', 'bench', 'settings']) {
      await page.click(isMobile ? `#mobile-nav-${tab}` : `#nav-${tab}`);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious.map((v) => `${tab}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    }
  });

  test('reaches the attach button by keyboard and keeps focus inside an open dialog', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await page.locator('#chatInput').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('[data-action="pick-chat-file"]')).toBeFocused();

    await attach(page, 'budget.md', BUDGET_MD);
    await ask(page, 'What is the approved budget?');
    const chip = page.locator('#chatMessages > div').last().locator('.message-content [data-action="open-citation"]').first();
    await chip.click();
    const drawer = page.locator('#citationModal');
    await expect(drawer).toBeVisible();
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(chip).toBeFocused();
  });
});
