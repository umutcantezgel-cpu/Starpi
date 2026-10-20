// The persistent workspace in the browser: files added on the "Add knowledge" tab survive a reload
// (IndexedDB plus the origin private file system), the first file asks whether to keep them, "Forget
// all" removes them, "Memory only" keeps nothing, and Settings show the storage and the semantic
// search opt-in, which downloads nothing until it is turned on.
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_EMBED_MODEL, embedSource } from '../../src/js/models/embed-catalog.js';
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
    await expect(card.locator('#wsFiles')).toContainText('1 file kept');
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

// Semantic search end to end needs the model files (about 136 MB), which the suite does not
// download: point STARPI_EMBED_MODEL_DIR at a directory with config.json, tokenizer.json,
// tokenizer_config.json and onnx/model_quantized.onnx of the pinned revision to run it.
const MODEL_DIR = process.env.STARPI_EMBED_MODEL_DIR ?? '';

test.describe('semantic search on this device', () => {
  test.skip(!MODEL_DIR, 'STARPI_EMBED_MODEL_DIR is not set');

  test('embeds the workspace after the opt-in and finds a passage by meaning, also after a reload', async ({ page, diagnostics }) => {
    test.setTimeout(240_000);
    const src = embedSource(DEFAULT_EMBED_MODEL);
    /** @type {Set<string>} */
    const served = new Set();
    // The model files come from a local server: Hugging Face URLs (the worker's own fetches
    // included) are redirected to it, with the CORS and CORP headers the isolated page needs.
    const files = http.createServer((req, res) => {
      const file = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).slice(1);
      const headers = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' };
      try {
        const { size } = statSync(path.join(MODEL_DIR, file));
        served.add(file);
        res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': size });
        createReadStream(path.join(MODEL_DIR, file)).pipe(res);
      } catch {
        res.writeHead(404, headers);
        res.end();
      }
    });
    await new Promise((resolve) => files.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {import('node:net').AddressInfo} */ (files.address()).port;
    test.info().attach('model server', { body: `http://127.0.0.1:${port}/` });
    await page.route(/^https:\/\/huggingface\.co\//, (route) => {
      const url = new URL(route.request().url());
      const file = url.pathname.replace(new RegExp(`^/${src.repo}/resolve/(main|${src.revision})/`), '');
      return route.fulfill({ status: 302, headers: { location: `http://127.0.0.1:${port}/${file}`, 'access-control-allow-origin': '*' } });
    });
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', [
      NOTES,
      { name: 'policy.md', mimeType: 'text/markdown', buffer: Buffer.from('# Policy\n\nStaff may work remotely on two days per week after approval by their manager.') },
    ]);
    await expect(page.locator('#workspaceList li')).toHaveCount(2);
    // Before the opt-in nothing matches "home office": BM25 knows no such words.
    await page.fill('#workspaceQuery', 'home office');
    await page.press('#workspaceQuery', 'Enter');
    await expect(page.locator('#workspaceResults')).toContainText('No chunk matches this query.');

    await openTab(page, 'settings');
    const card = page.locator('#workspaceSettingsCard');
    await card.scrollIntoViewIfNeeded();
    await card.locator('#wsSemantic').check();
    await expect(card.locator('#wsSemanticStatus')).toHaveText(/can be found by meaning/, { timeout: 180_000 });
    expect([...served]).toEqual(expect.arrayContaining(['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']));

    await openTab(page, 'ingest');
    await page.fill('#workspaceQuery', 'home office');
    await page.press('#workspaceQuery', 'Enter');
    await expect(page.locator('#workspaceResults li').first()).toContainText('remotely', { timeout: 30_000 });

    // The vectors were stored with the files: after a reload only the question is embedded.
    await page.reload();
    await openTab(page, 'ingest');
    await expect(page.locator('#workspaceList li')).toHaveCount(2);
    // Until the model has started, a search falls back to keywords after the query timeout.
    await expect(async () => {
      await page.fill('#workspaceQuery', 'home office');
      await page.press('#workspaceQuery', 'Enter');
      await expect(page.locator('#workspaceResults li').first()).toContainText('remotely', { timeout: 4_000 });
    }).toPass({ timeout: 90_000 });
    files.close();
    expect(diagnostics).toEqual([]);
  });
});

