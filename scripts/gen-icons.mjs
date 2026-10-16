#!/usr/bin/env node
// Renders the PNG app icons from the SVG sources in public/icons with the Chromium that Playwright
// provides, so no image library is needed. Run it after changing an icon SVG (npm run icons:gen)
// and commit the PNGs; the build copies public/ as it is and never renders anything.
//
//   icon.svg           (rounded tile, transparent corners)  -> icon-192.png, icon-512.png
//   icon-maskable.svg  (full bleed, motif in the safe zone)  -> icon-maskable-512.png, apple-touch-icon.png
//
// Usage: node scripts/gen-icons.mjs [--dir <icons directory>]
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE picks another Chromium binary.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What to render: source SVG, output PNG, edge length in pixels, and whether the corners stay
 * transparent (a maskable or Apple touch icon must be opaque: the platform applies its own mask).
 * @type {ReadonlyArray<{ svg: string, png: string, size: number, transparent: boolean }>}
 */
export const ICON_TARGETS = Object.freeze([
  { svg: 'icon.svg', png: 'icon-192.png', size: 192, transparent: true },
  { svg: 'icon.svg', png: 'icon-512.png', size: 512, transparent: true },
  { svg: 'icon-maskable.svg', png: 'icon-maskable-512.png', size: 512, transparent: false },
  { svg: 'icon-maskable.svg', png: 'apple-touch-icon.png', size: 180, transparent: false },
]);

/**
 * A page that shows one SVG at exactly `size` pixels in the top left corner.
 * @param {Buffer} svg
 * @param {number} size
 */
export function iconPage(svg, size) {
  const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  return `<!DOCTYPE html><html><body style="margin:0;background:transparent"><img alt="" src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`;
}

async function main() {
  const i = process.argv.indexOf('--dir');
  const dir = path.resolve(i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join(ROOT, 'public', 'icons'));
  for (const target of ICON_TARGETS) await stat(path.join(dir, target.svg));
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    for (const target of ICON_TARGETS) {
      const page = await browser.newPage({ viewport: { width: target.size, height: target.size }, deviceScaleFactor: 1 });
      await page.setContent(iconPage(await readFile(path.join(dir, target.svg)), target.size));
      // The image must be decoded before the screenshot, or the PNG can come out empty.
      await page.locator('img').evaluate((img) => /** @type {HTMLImageElement} */ (img).decode());
      await page.screenshot({
        path: path.join(dir, target.png),
        omitBackground: target.transparent,
        clip: { x: 0, y: 0, width: target.size, height: target.size },
      });
      await page.close();
      console.log(`icons: ${target.svg} -> ${target.png} (${target.size} x ${target.size})`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
