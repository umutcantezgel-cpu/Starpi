// The knowledge graph found in workspace files: without an AI model the graph links the names a
// file mentions together, draws them as found (not added by hand), keeps them on this device across
// a reload, joins a found name with the same entity in the shared knowledge base, and removes them
// again on request, or with their files. With a model set up (the site's pool, mocked) passages
// leave the device only after the user agreed, and every relation is checked against its passage.
import { expect, mockNvidia, mockSupabase, test, useNvidia } from './fixtures.mjs';

const GARDEN = [
  '# Riverside garden',
  '',
  'Mara Jensen leads the Riverside garden. The Riverside garden buys solar pumps from Nordwind Energy.',
  '',
  'Tom Berger keeps the budget together with Mara Jensen.',
].join('\n');

const LIBRARY = 'Priya Natarajan runs the seed exchange at the Elm Street Library. The Elm Street Library lends seed packets to Mara Jensen.';

/**
 * The document ids whose results are stored in the app database.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
function storedResults(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('starpi');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const keys = db.transaction('settings', 'readonly').objectStore('settings').getAllKeys(IDBKeyRange.bound('graph.auto:', 'graph.auto:\uffff'));
          keys.onsuccess = () => {
            db.close();
            resolve(keys.result.map((k) => String(k).slice('graph.auto:'.length)));
          };
          keys.onerror = () => reject(keys.error);
        };
      }),
  );
}

/** @param {import('@playwright/test').Page} page @param {string} tab */
async function openTab(page, tab) {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page.click(isMobile ? `#mobile-nav-${tab}` : `#nav-${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

test.describe('knowledge graph from files', () => {
  test('finds names in a file without a model, marks them as found and keeps the ones added by hand', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // One entity added by hand in the shared knowledge base (routes added later answer first).
    await page.route(/supabase\.co\/rest\/v1\/knowledge_entities/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify([{ id: '6b1f0c3e-0000-4000-8000-000000000001', name: 'Mara Jensen', entity_type: 'person', description: 'Leads the garden.' }]),
      }),
    );
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');

    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', { name: 'garden.md', mimeType: 'text/markdown', buffer: Buffer.from(GARDEN) });
    await expect(page.locator('#workspaceList li')).toHaveCount(1);

    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    const status = page.locator('#graphFoundStatus');
    await expect(status).toContainText('Find the people, organizations and things your files name');
    const list = page.locator('#graphEntityList');
    await expect(list.locator('button')).toHaveCount(1);

    // No model is set up: nothing is asked, the names that share a sentence are linked.
    await page.click('#graphFindBtn');
    await expect(status).toContainText('From 1 file');
    await expect(status).toContainText('no AI model was used');
    await expect(list.getByRole('button', { name: 'Nordwind Energy (found in your files)' })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Tom Berger (found in your files)' })).toBeVisible();
    // The entity added by hand is the same node as the name found in the file.
    await expect(list.getByRole('button', { name: /^Mara Jensen/ })).toHaveCount(1);
    await expect(list.getByRole('button', { name: 'Mara Jensen', exact: true })).toBeVisible();

    await list.getByRole('button', { name: /^Nordwind Energy/ }).click();
    const details = page.locator('#entityDetailContent');
    await expect(details).toContainText('Found in your files');
    await expect(details).toContainText('Files: garden.md');
    await expect(details).toContainText('appears with');
    await expect(details).toContainText('garden.md, passage 1');
    await expect(details.locator('[data-action="ask-entity"]')).toHaveAttribute('data-scope', 'files');
    // Asking about it searches the file it was found in.
    await expect(details.locator('[data-action="ask-entity"]')).toHaveAttribute('data-docs', /^\["[\w:.-]+"\]$/);

    await list.getByRole('button', { name: 'Mara Jensen', exact: true }).click();
    await expect(details).toContainText('Added by hand and found in your files');
    await expect(details).toContainText('Leads the garden.');
    await expect(details.locator('[data-action="ask-entity"]')).not.toHaveAttribute('data-scope', 'files');

    // Kept on this device: a reload shows them without reading the file again.
    await page.reload();
    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    await expect(list.getByRole('button', { name: /^Nordwind Energy/ })).toBeVisible();
    await expect(page.locator('#graphFoundStatus')).toContainText('From 1 file');

    // Reading again finds nothing new; removing takes only what was found.
    await page.click('#graphFindBtn');
    await expect(page.locator('#graphFoundStatus')).toContainText('already read');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.click('#graphFoundClear');
    await expect(list.locator('button')).toHaveCount(1);
    await expect(list.getByRole('button', { name: 'Mara Jensen', exact: true })).toBeVisible();
    await expect(page.locator('#graphFoundClear')).toBeHidden();
    expect(diagnostics).toEqual([]);
  });

  test('what was found in a file goes with the file: removing it, and Forget all', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', { name: 'garden.md', mimeType: 'text/markdown', buffer: Buffer.from(GARDEN) });
    await expect(page.locator('#workspaceList li')).toHaveCount(1);
    await page.setInputFiles('#workspaceFileInput', { name: 'library.md', mimeType: 'text/markdown', buffer: Buffer.from(LIBRARY) });
    await expect(page.locator('#workspaceList li')).toHaveCount(2);

    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    await page.click('#graphFindBtn');
    const status = page.locator('#graphFoundStatus');
    await expect(status).toContainText('From 2 files');
    await expect.poll(() => storedResults(page).then((ids) => ids.length)).toBe(2);

    // Removing a file removes its result, on this device and in the open graph.
    await openTab(page, 'ingest');
    await page.locator('#workspaceList li', { hasText: 'library.md' }).locator('[data-action="workspace-remove"]').click();
    await expect(page.locator('#workspaceList li')).toHaveCount(1);
    await expect.poll(() => storedResults(page).then((ids) => ids.length)).toBe(1);
    await openTab(page, 'graph');
    await expect(status).toContainText('From 1 file');
    await expect(page.getByRole('button', { name: /^Priya Natarajan/ })).toHaveCount(0);

    // Forget all: nothing found in the files stays either.
    await openTab(page, 'ingest');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.click('[data-action="workspace-clear"]');
    await expect(page.locator('#workspaceList li')).toHaveCount(0);
    await expect.poll(() => storedResults(page)).toEqual([]);
    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    await expect(status).toContainText('Find the people, organizations and things your files name');
    await expect(page.locator('#graphEntityList button')).toHaveCount(0);
    expect(diagnostics).toEqual([]);
  });

  test('asks before passages go to the model, and keeps only the relations the cited passage supports', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const answer = {
      entities: [
        { name: 'Mara Jensen', type: 'person' },
        { name: 'Riverside garden', type: 'project' },
        { name: 'Nordwind Energy', type: 'organization' },
      ],
      relations: [
        { from: 'Mara Jensen', to: 'Riverside garden', label: 'leads', quote: 'Mara Jensen leads the Riverside garden', cite: { doc: 'd1', chunk: 0 } },
        { from: 'Riverside garden', to: 'Nordwind Energy', label: 'buys pumps from', quote: 'buys solar pumps from Nordwind Energy', cite: { doc: 'd1', chunk: 0 } },
        // The passage never names Atlantis Holdings: left out and counted.
        { from: 'Atlantis Holdings', to: 'Mara Jensen', label: 'funds', quote: 'Atlantis Holdings funds Mara Jensen', cite: { doc: 'd1', chunk: 0 } },
      ],
    };
    const pool = await mockNvidia(page, { reply: { content: [JSON.stringify(answer)] } });
    await useNvidia(page);
    await page.goto('/');
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', { name: 'garden.md', mimeType: 'text/markdown', buffer: Buffer.from(GARDEN) });
    await expect(page.locator('#workspaceList li')).toHaveCount(1);
    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    const status = page.locator('#graphFoundStatus');
    const passagesSent = () => pool.bodies.filter((b) => JSON.stringify(b.messages).includes('[doc=d1 chunk=0]')).length;

    // Declined: nothing leaves the device and nothing is found.
    /** @type {string[]} */
    const asked = [];
    page.once('dialog', (dialog) => {
      asked.push(dialog.message());
      void dialog.dismiss();
    });
    await page.click('#graphFindBtn');
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toContain('Passages of these files are sent to the model you set up');
    await expect(page.locator('#graphFindBtn')).toBeEnabled();
    expect(passagesSent()).toBe(0);
    await expect(status).toContainText('Find the people, organizations and things your files name');

    // Agreed: one call reads the file; the unsupported relation is left out.
    page.once('dialog', (dialog) => void dialog.accept());
    await page.click('#graphFindBtn');
    await expect(status).toContainText('Found by an AI model and checked against each cited passage');
    await expect(status).toContainText('1 unsupported relation was left out');
    expect(passagesSent()).toBe(1);
    const list = page.locator('#graphEntityList');
    await expect(list.getByRole('button', { name: /^Atlantis Holdings/ })).toHaveCount(0);
    await list.getByRole('button', { name: /^Riverside garden/ }).click();
    const details = page.locator('#entityDetailContent');
    await expect(details).toContainText('leads');
    await expect(details).toContainText('buys pumps from');
    await expect(details.locator('q', { hasText: 'Mara Jensen leads the Riverside garden' })).toHaveCount(1);
    await expect(details.locator('q', { hasText: 'buys solar pumps from Nordwind Energy' })).toHaveCount(1);
    await expect(details).toContainText('garden.md, passage 1');

    // Read by the model already: nothing is sent again.
    await page.click('#graphFindBtn');
    await expect(status).toContainText('already read');
    expect(passagesSent()).toBe(1);
    expect(diagnostics).toEqual([]);
  });

  test('in on-device mode no passage leaves the device, even with a model set up elsewhere', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const pool = await mockNvidia(page);
    await page.addInitScript(() => localStorage.setItem('starpi_assistant_v1', 'device'));
    await page.goto('/');
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', { name: 'garden.md', mimeType: 'text/markdown', buffer: Buffer.from(GARDEN) });
    await expect(page.locator('#workspaceList li')).toHaveCount(1);
    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    /** @type {string[]} */
    const asked = [];
    page.on('dialog', (dialog) => {
      asked.push(dialog.message());
      void dialog.dismiss();
    });
    await page.click('#graphFindBtn');
    await expect(page.locator('#graphFoundStatus')).toContainText('no AI model was used');
    expect(asked).toEqual([]);
    expect(pool.bodies).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test('shows what was found in files when the shared graph tables are missing', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: false, anonymousAuth: false });
    await page.goto('/');
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', { name: 'garden.md', mimeType: 'text/markdown', buffer: Buffer.from(GARDEN) });
    await expect(page.locator('#workspaceList li')).toHaveCount(1);

    await openTab(page, 'graph');
    await expect(page.locator('#graphLoading')).toBeHidden();
    await page.click('#graphFindBtn');
    await expect(page.locator('#graphFoundStatus')).toContainText('The shared knowledge base is not available');
    await expect(page.locator('#graphStatus')).toBeHidden();
    await expect(page.locator('#graphEntityList button')).not.toHaveCount(0);
    expect(diagnostics).toEqual([]);
  });
});
