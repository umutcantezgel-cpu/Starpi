// Every ```mermaid block in the repository's Markdown must parse and render with the pinned Mermaid
// release (the major GitHub uses), so documentation diagrams cannot silently break.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MERMAID = path.join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js');
const SKIP = new Set(['node_modules', 'dist', '.git', '.build', 'playwright-report', 'test-results']);

/** @param {string} dir @returns {string[]} */
function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

/** @type {Array<{ where: string, source: string }>} */
const blocks = [];
for (const file of markdownFiles(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '```mermaid') continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end].trim() !== '```') end++;
    blocks.push({ where: `${path.relative(ROOT, file)}:${start}`, source: lines.slice(start, end).join('\n') });
    i = end;
  }
}

test.describe('documentation diagrams', () => {
  test.skip(({ isMobile }) => isMobile, 'rendering is viewport independent; run once');

  test('every Mermaid block parses and renders', async ({ page }) => {
    expect(blocks.length).toBeGreaterThan(0);
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ path: MERMAID });
    const failures = await page.evaluate(async (list) => {
      const mermaid = /** @type {any} */ (window).mermaid;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      /** @type {string[]} */
      const failed = [];
      for (const [index, block] of list.entries()) {
        try {
          await mermaid.parse(block.source);
          await mermaid.render(`diagram${index}`, block.source);
        } catch (err) {
          failed.push(`${block.where}: ${String(err instanceof Error ? err.message : err).split('\n')[0]}`);
        }
      }
      return failed;
    }, blocks);
    expect(failures).toEqual([]);
  });
});
