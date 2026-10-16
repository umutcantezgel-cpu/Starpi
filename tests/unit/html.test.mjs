// The built page (scripts/lib/html.mjs): where the theme script goes, and which scripts count
// toward the first-load budget of scripts/verify-dist.mjs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { injectThemeBoot, pageScripts, staticImports, THEME_BOOT_PLACEHOLDER } from '../../scripts/lib/html.mjs';

const PAGE = [
  '<!DOCTYPE html>',
  '<html><head>',
  '  <meta charset="UTF-8">',
  '  <link rel="manifest" href="/manifest.webmanifest">',
  '  <link rel="stylesheet" href="/assets/app.css">',
  '  <script type="module" src="/assets/main.js"></script>',
  '</head><body></body></html>',
].join('\n');

describe('injectThemeBoot', () => {
  it('puts the theme script first in <head>, before the stylesheet, as a classic script', () => {
    const html = injectThemeBoot(PAGE, '/assets/theme-boot-ABC.js');
    assert.ok(html.indexOf('<script src="/assets/theme-boot-ABC.js"></script>') < html.indexOf('rel="stylesheet"'));
    assert.deepEqual(pageScripts(html), ['/assets/theme-boot-ABC.js', '/assets/main.js']);
    assert.doesNotMatch(html.match(/<script src="\/assets\/theme-boot[^>]*>/)?.[0] ?? '', /module|defer|async/);
  });

  it('fills a placeholder the page names, and removes its tag while there is no theme script', () => {
    const withPlaceholder = PAGE.replace('  <link rel="stylesheet"', `  <script src="${THEME_BOOT_PLACEHOLDER}"></script>\n  <link rel="stylesheet"`);
    assert.deepEqual(pageScripts(injectThemeBoot(withPlaceholder, '/assets/theme-boot-XYZ.js')), ['/assets/theme-boot-XYZ.js', '/assets/main.js']);
    assert.equal(injectThemeBoot(withPlaceholder, null), PAGE);
    assert.equal(injectThemeBoot(PAGE, null), PAGE);
  });

  it('falls back to the end of <head> and needs one', () => {
    const noStylesheet = PAGE.replace('  <link rel="stylesheet" href="/assets/app.css">\n', '');
    assert.match(injectThemeBoot(noStylesheet, '/t.js'), /<script src="\/t\.js"><\/script>\n {2}<\/head>/);
    assert.throws(() => injectThemeBoot('<p>no head</p>', '/t.js'), /no <\/head>/);
  });
});

describe('staticImports', () => {
  it('finds the static imports of a minified module and leaves dynamic ones out', () => {
    const code = 'import{a as b}from"./chunk-AAA.js";import"./chunk-BBB.js";export{c}from"../x/chunk-CCC.js";const d=()=>import("./lazy-DDD.js");const s="from";';
    assert.deepEqual(staticImports(code, '/assets/main-1.js'), ['/assets/chunk-AAA.js', '/assets/chunk-BBB.js', '/x/chunk-CCC.js']);
    assert.deepEqual(staticImports('import { x } from "./a.js";\nimport * as y from \'./b.js\';', '/assets/m.js'), ['/assets/a.js', '/assets/b.js']);
  });
});
