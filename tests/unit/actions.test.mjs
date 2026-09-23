// Every data-action / data-change used in markup or templates must have a registered handler,
// every registered handler must be reachable, every icon must be bundled, and the UI must not use
// emoji (icons come from Lucide).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/** @param {string} dir */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && /\.(js|html|json)$/.test(d.name))
    .map((d) => path.join(d.parentPath, d.name));
}

const sourceFiles = files(SRC);
const code = sourceFiles
  .filter((f) => !f.endsWith('.json'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
const html = readFileSync(path.join(SRC, 'index.html'), 'utf8');

/** @param {RegExp} re */
const collect = (re) => new Set([...code.matchAll(re)].map((m) => m[1]));

describe('delegated actions', () => {
  const usedClicks = new Set([...collect(/data-action="([\w-]+)"/g), ...collect(/dataset\.action = '([\w-]+)'/g)]);
  const usedChanges = collect(/data-change="([\w-]+)"/g);
  const registeredClicks = collect(/onAction\('([\w-]+)'/g);
  const registeredChanges = collect(/onChange\('([\w-]+)'/g);

  it('has a handler for every data-action and data-change', () => {
    assert.deepEqual([...usedClicks].filter((a) => !registeredClicks.has(a)), []);
    assert.deepEqual([...usedChanges].filter((a) => !registeredChanges.has(a)), []);
  });

  it('has no unreachable handlers', () => {
    assert.deepEqual([...registeredClicks].filter((a) => !usedClicks.has(a)), []);
    assert.deepEqual([...registeredChanges].filter((a) => !usedChanges.has(a)), []);
  });

  it('uses no inline event handler attributes anywhere in the sources', () => {
    assert.doesNotMatch(code, /\son(click|change|submit|keydown|input|drop|dragover|dragleave|load|error)=["']/i);
  });
});

describe('icons', () => {
  const iconsSrc = readFileSync(path.join(SRC, 'js/icons.js'), 'utf8');
  const pascal = (/** @type {string} */ n) => n.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
  const used = new Set([
    ...collect(/data-lucide="([a-z0-9-]+)"/g),
    ...collect(/dataset\.lucide = '([a-z0-9-]+)'/g),
    ...collect(/icon: '([a-z0-9-]+)'/g),
    // names chosen at runtime (device type, privacy notice, workspace file kind, graph edge direction,
    // trace phases, provider test result)
    ...collect(/'(laptop|tablet|smartphone|lock|server|cloud|library|file-text|braces|file|database|arrow-right|arrow-left|loader-2|upload|info|alert-circle|search|sparkles|clipboard-list|zap)'/g),
  ]);
  const registered = new Set([...iconsSrc.matchAll(/^ {2}([A-Z]\w*),$/gm)].map((m) => m[1]));

  it('bundles every lucide icon referenced by the markup and templates', () => {
    const missing = [...used].filter((n) => !registered.has(pascal(n)));
    assert.deepEqual(missing, []);
  });

  it('bundles no icon that is never used', () => {
    const usedPascal = new Set([...used].map(pascal));
    assert.deepEqual([...registered].filter((n) => !usedPascal.has(n)), []);
  });
});

describe('design system', () => {
  it('contains no emoji or decorative pictographs in markup, templates or dictionaries', () => {
    const pictograph = /[\p{Extended_Pictographic}\u2726\u2728\u{1F300}-\u{1FAFF}]/u;
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      const hit = text.split('\n').findIndex((line) => pictograph.test(line.replace(/[©®™]/g, '')));
      assert.equal(hit, -1, `${path.relative(SRC, file)}:${hit + 1} contains an emoji`);
    }
  });

  it('gives every icon-only button an accessible name', () => {
    for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const [, attrs, inner] = m;
      const visibleText = inner.replace(/<i [^>]*><\/i>/g, '').replace(/<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>[^<]*<\/span>/g, 'x').replace(/<[^>]+>/g, '').trim();
      if (visibleText) continue;
      assert.match(attrs, /aria-label="[^"]+"/, `button without text or aria-label: <button${attrs}>`);
    }
  });

  it('labels every static aria-label for translation', () => {
    for (const m of html.matchAll(/<[a-z]+\b([^>]*\saria-label="[^"]+"[^>]*)>/g)) {
      const attrs = m[1];
      if (/lang="(en|de)"/.test(attrs)) continue; // the EN/DE buttons are named in their own language
      assert.match(attrs, /data-i18n-aria="[\w.]+"/, `untranslated aria-label: ${attrs.trim().slice(0, 120)}`);
    }
  });
});
