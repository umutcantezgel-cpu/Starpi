// The lazy rendering extras: highlight.js output and KaTeX MathML pass their own sanitizers, so no
// script, style attribute, event handler or link survives, and the code and formulas keep their text.
/* global document */
import './setup.mjs';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/render-extras.js')} */
let extras;
/** @type {typeof import('../../src/js/render.js')} */
let render;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'DOMParser']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key], configurable: true, writable: true });
  }
  render = await import('../../src/js/render.js');
  extras = await import('../../src/js/render-extras.js');
  assert.equal(await render.loadRenderExtras(), await import('../../src/js/render-extras.js'), 'render.js loads this very module');
});

/** @param {string} html */
function parse(html) {
  const box = document.createElement('div');
  box.innerHTML = html;
  return box;
}

/**
 * Fails when markup carries anything active: scripts, styles, event handlers, links, ids or classes
 * other than the allowed ones.
 * @param {string} html
 * @param {RegExp} [classes] allowed class names
 */
function assertInert(html, classes = /^$/) {
  const box = parse(html);
  assert.equal(box.querySelectorAll('script, style, img, iframe, a, svg, form, object, embed, mglyph').length, 0, html);
  for (const el of box.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      assert.doesNotMatch(attr.name, /^(?:on|style$|href$|xlink:href$|src$|srcset$|id$)/i, `${el.tagName} ${attr.name}`);
      if (attr.name === 'class') for (const name of attr.value.split(/\s+/)) assert.match(name, classes, `${el.tagName}.${name}`);
    }
  }
  assert.doesNotMatch(html, /javascript:|<script|\sstyle=/i);
}

describe('highlight sanitization', () => {
  it('keeps only spans with highlight.js token classes, and all text', () => {
    const html = extras.sanitizeHighlight(
      '<span class="hljs-keyword">const</span> <span class="evil hljs-title function_" onclick="x()" style="color:red" id="a">f</span><img src=x onerror=alert(1)><a href="javascript:alert(1)">link</a><b>bold</b><script>alert(1)</script><span class="fixed inset-0">z</span>',
    );
    assert.equal(html, '<span class="hljs-keyword">const</span> <span class="hljs-title">f</span>linkbold<span>z</span>');
    assertInert(html, /^hljs-[\w-]+$/);
  });

  it('highlights known languages and keeps the code text exactly', () => {
    const code = 'const a = "</code><script>alert(1)</script><img src=x onerror=alert(2)>"; // <b>x</b>\nlet b = `${a}`;';
    const html = /** @type {string} */ (extras.highlightCode(code, 'js'));
    assert.match(html, /<span class="hljs-keyword">const<\/span>/);
    assert.equal(parse(html).textContent, code);
    assertInert(html, /^hljs-[\w-]+$/);
    // Aliases and names highlight.js knows; unknown languages, empty and oversized code stay plain.
    assert.ok(extras.highlightCode('<svg><rect/></svg>', 'svg'));
    assert.ok(extras.highlightCode('echo hi', 'sh'));
    assert.equal(extras.highlightCode('x', 'no-such-language'), null);
    assert.equal(extras.highlightCode('', 'js'), null);
    assert.equal(extras.highlightCode('x'.repeat(extras.MAX_HIGHLIGHT_CHARS + 1), 'js'), null);
  });
});

describe('MathML sanitization', () => {
  it('strips styles, classes, ids, links, handlers and foreign markup from MathML', () => {
    const html = extras.sanitizeMathMl(
      '<span class="katex" style="color:red"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi style="x" onclick="alert(1)" href="javascript:alert(1)" id="mi" class="c">a</mi><mglyph src="https://example.com/x.png"></mglyph><mtext><img src=x onerror=alert(1)><style>*{}</style></mtext></mrow><annotation encoding="application/x-tex">\\alpha</annotation><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></semantics></math></span>',
    );
    assertInert(html);
    const box = parse(html);
    assert.ok(box.querySelector('math mrow mi'), html);
    assert.equal(box.querySelector('math')?.getAttribute('display'), 'block');
    // The TeX annotation goes with its content, so it never shows as text next to the formula.
    assert.doesNotMatch(box.textContent ?? '', /alpha/);
  });

  it('typesets TeX as MathML without inline styles', () => {
    const html = /** @type {string} */ (extras.renderMath('\\frac{a}{b} + \\sqrt{x^2} \\color{red}{y} \\boxed{z}', true));
    assertInert(html);
    const math = parse(html).querySelector('math');
    assert.equal(math?.getAttribute('display'), 'block');
    assert.ok(math?.querySelector('mfrac') && math.querySelector('msqrt'), html);
    assert.ok(parse(extras.renderMath('x', false) ?? '').querySelector('math:not([display])'));
  });

  it('keeps every active or untrusted command out', () => {
    const attacks = [
      '\\href{javascript:alert(1)}{x}',
      '\\url{javascript:alert(1)}',
      '\\htmlStyle{color:red;background:url(https://example.com/x)}{x}',
      '\\htmlClass{fixed inset-0}{x}',
      '\\htmlId{chatInput}{x}',
      '\\htmlData{action=clear-keys}{x}',
      '\\includegraphics{https://example.com/beacon.png}',
      '\\text{<script>alert(1)</script><img src=x onerror=alert(2)>}',
      '\\style{color:red}{x}',
      '\\def\\a{\\a\\a}\\a',
    ];
    for (const tex of attacks) {
      const html = extras.renderMath(tex, false);
      if (html !== null) assertInert(html);
      assert.doesNotMatch(html ?? '', /data-|beacon|clear-keys|chatInput|fixed inset/, tex);
    }
    assert.equal(extras.renderMath('\\frac{a', false), null, 'TeX KaTeX cannot read stays text');
    assert.equal(extras.renderMath('  ', false), null);
  });
});

describe('enhance', () => {
  it('highlights code and typesets math in place, once', () => {
    const box = parse(render.renderMarkdown('Area $\\pi r^2$ and $$\\oint$$\n\n```js\nconst x = 1;\n```\n\n```\nplain\n```\n\n$\\frac{a$ stays'));
    extras.enhance(box);
    const once = box.innerHTML;
    extras.enhance(box);
    assert.equal(box.innerHTML, once);
    const [inline, display, broken] = box.querySelectorAll('.math-inline, .math-display');
    assert.equal(inline.getAttribute('data-tex'), '\\pi r^2');
    assert.ok(inline.classList.contains('math-rendered') && inline.querySelector('math'));
    assert.ok(display.querySelector('math[display="block"]'));
    assert.ok(broken.classList.contains('math-error'));
    assert.equal(broken.textContent, '\\frac{a');
    const [js, plain] = box.querySelectorAll('pre code');
    assert.ok(js.classList.contains('hljs') && js.querySelector('.hljs-keyword'));
    assert.equal(js.textContent, 'const x = 1;\n');
    assert.equal(plain.innerHTML, 'plain\n');
  });

  it('renders model Markdown with math and code inertly once the chunk is loaded', () => {
    const html = render.renderMarkdown(
      '# T\n\n$x^2$ <b onclick="x()" style="color:red">b</b> <img src=x onerror=alert(1)> [l](javascript:alert(1))\n\n```html\n<script>alert(1)</script><div onclick="x()">x</div>\n```\n\n\\[\n\\href{javascript:alert(1)}{y}\n\\]',
    );
    const box = parse(html);
    assert.equal(box.querySelectorAll('script, img, style, iframe').length, 0, html);
    assert.equal(box.querySelectorAll('[style], [onclick], [onerror], a[href^="javascript"]').length, 0, html);
    assert.ok(box.querySelector('.math-inline math'));
    assert.equal(box.querySelector('pre code')?.textContent, '<script>alert(1)</script><div onclick="x()">x</div>\n');
    assert.ok(box.querySelector('pre code .hljs-tag'));
  });

  it('upgrades content rendered before the chunk was there', async () => {
    const box = parse(render.renderMarkdown('$a^2$\n\n```css\na { color: red }\n```', { extras: false }));
    document.body.append(box);
    assert.equal(box.querySelector('math'), null);
    assert.equal(await render.enhanceRendered(box), true);
    assert.ok(box.querySelector('.math-inline math'));
    assert.ok(box.querySelector('pre code.hljs .hljs-selector-tag'));
    assert.equal(await render.enhanceRendered(parse('<p>nothing to do</p>')), true);
    box.remove();
  });
});
