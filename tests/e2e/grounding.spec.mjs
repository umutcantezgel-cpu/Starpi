// End-to-end test of grounding version 3 in the chat: a model answer that turns a change of the
// attached file around is flagged with the relation and the excerpt passage, the relations are
// counted, a weak statement gets the on-device second opinion without anything being downloaded (and
// no AI judge, since the answer quotes a file on this device), and the receipt records the relation.
import { readFileSync } from 'node:fs';
import { expect, mockNvidia, mockSupabase, test, useNvidia } from './fixtures.mjs';

const COSTS_MD = '# Costs\n\nServer costs fell from 420,000 EUR to 210,000 EUR after the move to the new data centre on 1 May 2026.';

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

test.describe('grounding version 3', () => {
  test('flags a relation the file gives the other way round, offers a second opinion and records the relation in the receipt', async ({ page, diagnostics: _diagnostics }, testInfo) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await mockNvidia(page, {
      reply: { content: ['Server costs rose from 420,000 EUR to 210,000 EUR [Doc: costs.md, Chunk: 1]. ', 'Everyone praised the friendly support staff [Doc: costs.md, Chunk: 1].'] },
    });
    await useNvidia(page);
    await page.goto('/');
    await page.setInputFiles('#chatFileInput', { name: 'costs.md', mimeType: 'text/markdown', buffer: Buffer.from(COSTS_MD) });
    await expect(page.locator('#attachedFileName')).toContainText('chunk');
    await ask(page, 'How did the server costs change?');

    const answer = page.locator('#chatMessages > div').last();
    const bar = answer.locator('.grounding-bar');
    await expect(bar).toHaveClass(/grounding-partial/);
    await bar.locator('summary').click();
    await expect(bar.locator('[data-i18n="grounding.reason_relation_inverted"]')).toContainText('“rose from 420,000 EUR to 210,000 EUR” is the wrong way round: [Doc: costs.md, Chunk: 1] says “Server costs fell from 420,000 EUR to 210,000 EUR');
    await expect(bar).toContainText('1 relation between values or events compared with the excerpts; 1 the wrong way round or not supported.');

    // The second opinion is offered for the weak statements; nothing is downloaded before a click
    // (the diagnostics fixture fails the test on any request to another host). The answer quotes a
    // file attached on this device, so no AI judge (which would send the statements to the provider)
    // is offered.
    const panel = bar.locator('.grounding-second');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-second-opinion="nli"]')).toHaveText('Check on this device (downloads about 232 MB once)');
    await expect(panel.locator('[data-second-opinion="judge"]')).toHaveCount(0);

    await answer.locator('[data-action="open-receipt"]').click();
    const dialog = page.locator('#receiptModal');
    await expect(dialog).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.locator('[data-action="download-receipt"]').click()]);
    const receiptPath = testInfo.outputPath('receipt.json');
    await download.saveAs(receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.grounding.algorithm).toEqual({ id: 'starpi-grounding', version: 3 });
    expect(receipt.grounding.sentences[0].reasons.map((/** @type {{ code: string }} */ r) => r.code)).toContain('relation_inverted');
    expect(receipt.relations).toEqual([{ kind: 'comparative', sentences: [0], cites: [0], verdict: 'inverted', text: 'rose from 420,000 EUR to 210,000 EUR' }]);
    expect(receipt.secondOpinion).toBeUndefined();
  });
});
