// Copy buttons on code blocks: added once per block, copy the code, fall back to a selection, and
// leave the source check of the answer exactly as it was.
/* global document, window */
import './setup.mjs';
import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';
import { JSDOM } from 'jsdom';

/** @type {typeof import('../../src/js/code-blocks.js')} */
let blocks;
/** @type {typeof import('../../src/js/rag/grounding-view.js')} */
let view;
/** @type {typeof import('../../src/js/rag/citations.js')} */
let citations;
/** @type {typeof import('../../src/js/render.js')} */
let render;
/** @type {typeof import('../../src/js/retrieval.js')} */
let retrieval;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'NodeFilter', 'Text']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key], configurable: true, writable: true });
  }
  render = await import('../../src/js/render.js');
  citations = await import('../../src/js/rag/citations.js');
  view = await import('../../src/js/rag/grounding-view.js');
  retrieval = await import('../../src/js/retrieval.js');
  blocks = await import('../../src/js/code-blocks.js');
});

/**
 * Replaces the browser's clipboard for one test.
 * @param {((text: string) => Promise<void>) | null} writeText  null: no clipboard API at all
 */
function useClipboard(writeText) {
  Object.defineProperty(globalThis, 'navigator', { value: writeText ? { clipboard: { writeText } } : {}, configurable: true, writable: true });
}

/** @param {string} markdown @param {string | null} [scope] */
function answer(markdown, scope = null) {
  const content = document.createElement('div');
  content.className = 'message-content';
  content.innerHTML = render.renderMarkdown(markdown);
  citations.linkifyCitations(content, scope);
  document.body.append(content);
  return content;
}

const CODE = "Here you go:\n\n```python\nprint('hi')\n```\n\nAnd a shell line:\n\n```\nls -la\n```";

describe('decorateCodeBlocks', () => {
  it('adds one copy button per code block and is idempotent', () => {
    const content = answer(CODE);
    blocks.decorateCodeBlocks(content);
    blocks.decorateCodeBlocks(content);
    const wraps = content.querySelectorAll('.code-block');
    assert.equal(wraps.length, 2);
    for (const wrap of wraps) {
      assert.deepEqual([...wrap.children].map((c) => c.tagName), ['PRE', 'BUTTON']);
      const btn = /** @type {HTMLButtonElement} */ (wrap.querySelector('button'));
      assert.equal(btn.type, 'button');
      assert.equal(btn.className, 'code-copy');
      assert.equal(btn.dataset.action, 'copy-code');
      assert.equal(btn.getAttribute('aria-label'), 'Copy code');
      assert.equal(btn.getAttribute('data-i18n-aria'), 'chat.copy_code');
      assert.equal(btn.querySelector('.code-copy-label')?.textContent, 'Copy');
      assert.ok(btn.querySelector('svg'), 'the copy icon is rendered');
    }
    const plain = answer('No code here.');
    const before = plain.innerHTML;
    blocks.decorateCodeBlocks(plain);
    assert.equal(plain.innerHTML, before);
  });

  it('does not change the source-check blocks', () => {
    const hits = [{ documentId: 'a', documentTitle: 'plan.md', heading: '', content: 'The approved budget is 480,000 EUR.', tags: [], rank: 1 }];
    const list = retrieval.assignCitations(hits, { excerptChars: 1600 });
    const scope = /** @type {string} */ (citations.registerCitations(list));
    const sources = list.map((c) => ({ label: c.label, doc: c.doc }));
    const content = answer(
      'The approved budget is 480,000 EUR [Doc: plan.md, Chunk: 1].\n\n```\nbudget = 999_999\n```\n\n- One item\n- Another item [Doc: plan.md, Chunk: 1]\n\n```js\nconst x = 1;\n```',
      scope,
    );
    const beforeCheck = view.blocksFromElement(content, scope, sources);
    blocks.decorateCodeBlocks(content);
    assert.equal(content.querySelectorAll('.code-copy').length, 2);
    const afterCheck = view.blocksFromElement(content, scope, sources);
    assert.equal(JSON.stringify(afterCheck.blocks), JSON.stringify(beforeCheck.blocks));
    assert.equal(afterCheck.chips.length, beforeCheck.chips.length);
    assert.doesNotMatch(JSON.stringify(afterCheck.blocks), /999_999|Copy/);
  });
});

describe('copyCodeBlock', () => {
  it('copies the code text without the trailing newline and resets its label', async () => {
    /** @type {string[]} */
    const copied = [];
    useClipboard(async (text) => {
      copied.push(text);
    });
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const content = answer(CODE);
      blocks.decorateCodeBlocks(content);
      const btn = /** @type {HTMLElement} */ (content.querySelector('.code-copy'));
      assert.equal(await blocks.copyCodeBlock(btn), true);
      assert.deepEqual(copied, ["print('hi')"]);
      const label = btn.querySelector('.code-copy-label');
      assert.equal(label?.textContent, 'Copied');
      mock.timers.tick(1999);
      assert.equal(label?.textContent, 'Copied');
      mock.timers.tick(1);
      assert.equal(label?.textContent, 'Copy');
    } finally {
      mock.timers.reset();
    }
  });

  it('falls back to selecting the code when the clipboard is refused or missing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      for (const writeText of [() => Promise.reject(new DOMException('Denied', 'NotAllowedError')), null]) {
        useClipboard(writeText);
        const content = answer(CODE);
        blocks.decorateCodeBlocks(content);
        const btn = /** @type {HTMLElement} */ (content.querySelectorAll('.code-copy')[1]);
        window.getSelection()?.removeAllRanges();
        assert.equal(await blocks.copyCodeBlock(btn), false);
        assert.equal(window.getSelection()?.toString().trim(), 'ls -la');
        assert.equal(btn.querySelector('.code-copy-label')?.textContent, 'Selected, copy by hand');
      }
    } finally {
      mock.timers.reset();
    }
  });
});
