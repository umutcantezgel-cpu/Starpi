// Every Mermaid code block (``` or ~~~ fenced) in the repository's Markdown must parse and render
// with the pinned Mermaid release (the major GitHub uses), so documentation diagrams cannot silently
// break.
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { markdownFiles, mermaidBlocks, ROOT } from '../../scripts/markdown.mjs';

const MERMAID = path.join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js');

const blocks = markdownFiles().flatMap((file) => mermaidBlocks(file).map((b) => ({ where: `${file}:${b.line}`, source: b.source })));

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
