// Tools on code blocks: added once per block, Copy (with its selection fallback), Download, Open in
// canvas (an event), Preview in the sandboxed render frame with "Run preview"; copying a whole answer
// as text or Markdown; and the source check of the answer stays exactly as it was.
/* global document, window, Node */
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
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://starpi.test/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'NodeFilter', 'Text', 'MutationObserver', 'CustomEvent']) {
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
  content.innerHTML = render.renderMarkdown(markdown, { extras: false });
  citations.linkifyCitations(content, scope);
  document.body.append(content);
  return content;
}

/** @param {Element} wrap */
const actions = (wrap) => [...wrap.querySelectorAll('.code-head button')].map((b) => /** @type {HTMLElement} */ (b).dataset.action);

const CODE = "Here you go:\n\n```python\nprint('hi')\n```\n\nAnd a shell line:\n\n```\nls -la\n```";
const PAGE = '<!doctype html><h1 id="t">Hi</h1><script>document.getElementById("t").textContent = "ran"</script>';

describe('decorateCodeBlocks', () => {
  it('adds a tool bar of buttons above each code block, once', async () => {
    const content = answer(CODE);
    await blocks.decorateCodeBlocks(content);
    await blocks.decorateCodeBlocks(content);
    const wraps = content.querySelectorAll('.code-block');
    assert.equal(wraps.length, 2);
    for (const wrap of wraps) {
      assert.deepEqual([...wrap.children].map((c) => c.className || c.tagName), ['code-head', 'PRE']);
      assert.deepEqual(actions(wrap), ['copy-code', 'download-code']);
      // The bar holds no text of its own outside its buttons (the language label is CSS).
      const head = /** @type {HTMLElement} */ (wrap.querySelector('.code-head'));
      assert.equal([...head.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).length, 0);
      const copy = /** @type {HTMLButtonElement} */ (wrap.querySelector('.code-copy'));
      assert.equal(copy.type, 'button');
      assert.equal(copy.getAttribute('aria-label'), 'Copy code');
      assert.equal(copy.getAttribute('data-i18n-aria'), 'chat.copy_code');
      assert.equal(copy.querySelector('.code-action-label')?.textContent, 'Copy');
      assert.ok(copy.querySelector('svg'), 'the copy icon is rendered');
      const download = /** @type {HTMLButtonElement} */ (wrap.querySelector('[data-action="download-code"]'));
      assert.equal(download.getAttribute('aria-label'), 'Download code as a file');
      assert.equal(download.textContent, 'Download');
    }
    assert.equal(/** @type {HTMLElement} */ (wraps[0].querySelector('.code-head')).dataset.lang, 'python');
    assert.equal(/** @type {HTMLElement} */ (wraps[1].querySelector('.code-head')).dataset.lang, undefined);
    // The lazy chunk highlighted the Python block in place.
    assert.ok(wraps[0].querySelector('pre code.hljs .hljs-built_in'));
    assert.equal(wraps[0].querySelector('pre')?.textContent, "print('hi')\n");

    const plain = answer('No code here.');
    const html = plain.innerHTML;
    await blocks.decorateCodeBlocks(plain);
    assert.equal(plain.innerHTML, html);
  });

  it('offers a preview for HTML, SVG and diagrams, and "Open in canvas" once the canvas listens', async () => {
    const long = Array.from({ length: 16 }, (_, i) => `line ${i}`).join('\n');
    const md = `\`\`\`html\n${PAGE}\n\`\`\`\n\n\`\`\`svg\n<svg/>\n\`\`\`\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n\`\`\`md title="Notes"\n# x\n\`\`\`\n\n\`\`\`text\n${long}\n\`\`\`\n\n\`\`\`js\nshort()\n\`\`\``;
    const before = answer(md);
    await blocks.decorateCodeBlocks(before);
    assert.deepEqual([...before.querySelectorAll('.code-block')].map(actions), [
      ['copy-code', 'download-code', 'preview-code'],
      ['copy-code', 'download-code', 'preview-code'],
      ['copy-code', 'download-code', 'preview-code'],
      ['copy-code', 'download-code'],
      ['copy-code', 'download-code'],
      ['copy-code', 'download-code'],
    ]);
    blocks.enableCanvas();
    try {
      const after = answer(md);
      await blocks.decorateCodeBlocks(after);
      assert.deepEqual([...after.querySelectorAll('.code-block')].map(actions), [
        ['copy-code', 'download-code', 'canvas-code', 'preview-code'],
        ['copy-code', 'download-code', 'canvas-code', 'preview-code'],
        ['copy-code', 'download-code', 'canvas-code', 'preview-code'],
        ['copy-code', 'download-code', 'canvas-code'],
        ['copy-code', 'download-code', 'canvas-code'],
        ['copy-code', 'download-code'],
      ]);
      const preview = /** @type {HTMLElement} */ (after.querySelector('[data-action="preview-code"]'));
      assert.equal(preview.getAttribute('aria-pressed'), 'false');
      assert.equal(preview.textContent, 'Preview');
    } finally {
      blocks.enableCanvas(false);
    }
  });

  it('does not change the source-check blocks', async () => {
    const hits = [{ documentId: 'a', documentTitle: 'plan.md', heading: '', content: 'The approved budget is 480,000 EUR.', tags: [], rank: 1 }];
    const list = retrieval.assignCitations(hits, { excerptChars: 1600 });
    const scope = /** @type {string} */ (citations.registerCitations(list));
    const sources = list.map((c) => ({ label: c.label, doc: c.doc }));
    const content = answer(
      'The approved budget is 480,000 EUR [Doc: plan.md, Chunk: 1].\n\n```\nbudget = 999_999\n```\n\n- One item\n- Another item [Doc: plan.md, Chunk: 1]\n\n```html\n<p>const x = 1;</p>\n```',
      scope,
    );
    const beforeCheck = view.blocksFromElement(content, scope, sources);
    await blocks.decorateCodeBlocks(content);
    assert.equal(content.querySelectorAll('.code-copy').length, 2);
    blocks.togglePreview(/** @type {HTMLElement} */ (content.querySelector('[data-action="preview-code"]')));
    const afterCheck = view.blocksFromElement(content, scope, sources);
    assert.equal(JSON.stringify(afterCheck.blocks), JSON.stringify(beforeCheck.blocks));
    assert.equal(afterCheck.chips.length, beforeCheck.chips.length);
    assert.doesNotMatch(JSON.stringify(afterCheck.blocks), /999_999|Copy|Download|Preview|html/);
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
      const label = btn.querySelector('.code-action-label');
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
        assert.equal(btn.querySelector('.code-action-label')?.textContent, 'Selected, copy by hand');
      }
    } finally {
      mock.timers.reset();
    }
  });
});

describe('download and canvas', () => {
  it('names downloads after the fence title and language', () => {
    assert.equal(blocks.downloadName({ language: 'python', title: '' }), 'code.py');
    assert.equal(blocks.downloadName({ language: 'html', title: 'Landing page.html' }), 'Landing-page.html');
    assert.equal(blocks.downloadName({ language: '', title: '../../etc/passwd' }), 'etc-passwd.txt');
    assert.equal(blocks.downloadName({ language: 'mermaid', title: 'Flow' }), 'Flow.mmd');
    assert.equal(blocks.downloadName({ language: 'no-such', title: '' }), 'code.txt');
  });

  it('saves the code of a block as a file', async () => {
    const content = answer('```js title="app.js"\nconsole.log(1);\n```');
    blocks.decorateCodeBlocks(content);
    /** @type {Blob[]} */
    const blobs = [];
    /** @type {Array<{ href: string, download: string }>} */
    const clicks = [];
    const url = mock.method(URL, 'createObjectURL', (/** @type {Blob} */ blob) => {
      blobs.push(blob);
      return 'blob:https://starpi.test/1';
    });
    const revoke = mock.method(URL, 'revokeObjectURL', () => {});
    const click = mock.method(window.HTMLElement.prototype, 'click', function () {
      clicks.push({ href: this.href, download: this.download });
    });
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      assert.equal(blocks.downloadCodeBlock(/** @type {HTMLElement} */ (content.querySelector('[data-action="download-code"]'))), 'app.js');
      assert.deepEqual(clicks, [{ href: 'blob:https://starpi.test/1', download: 'app.js' }]);
      assert.equal(await blobs[0].text(), 'console.log(1);');
      assert.equal(document.querySelectorAll('a[download]').length, 0, 'the link is removed again');
      mock.timers.tick(10_000);
      assert.equal(revoke.mock.callCount(), 1);
    } finally {
      mock.timers.reset();
      url.mock.restore();
      revoke.mock.restore();
      click.mock.restore();
    }
  });

  it('hands a block to the canvas through a bubbling event', () => {
    blocks.enableCanvas();
    try {
      const content = answer('```svg title="Logo"\n<svg/>\n```');
      blocks.decorateCodeBlocks(content);
      const btn = /** @type {HTMLElement} */ (content.querySelector('[data-action="canvas-code"]'));
      assert.equal(blocks.openInCanvas(btn), false, 'nobody took it');
      /** @type {unknown[]} */
      const seen = [];
      /** @param {Event} event */
      const listener = (event) => {
        seen.push(/** @type {CustomEvent} */ (event).detail);
        event.preventDefault();
      };
      document.addEventListener(blocks.OPEN_CANVAS_EVENT, listener);
      assert.equal(blocks.openInCanvas(btn), true);
      document.removeEventListener(blocks.OPEN_CANVAS_EVENT, listener);
      assert.deepEqual(seen, [{ code: '<svg/>', language: 'svg', title: 'Logo' }]);
    } finally {
      blocks.enableCanvas(false);
    }
  });
});

describe('preview', () => {
  /**
   * The frame's side of the protocol, as seen by the app.
   * @param {HTMLIFrameElement} iframe
   * @param {Record<string, unknown>} data
   * @param {{ origin?: string, source?: Window | null }} [from]
   */
  const fromFrame = (iframe, data, { origin = 'null', source = iframe.contentWindow } = {}) =>
    window.dispatchEvent(new window.MessageEvent('message', { data, origin, source }));

  it('shows HTML without scripts in the sandboxed frame and runs them only on request', () => {
    const content = answer(`\`\`\`html\n${PAGE}\n\`\`\``);
    blocks.decorateCodeBlocks(content);
    const toggle = /** @type {HTMLElement} */ (content.querySelector('[data-action="preview-code"]'));
    assert.equal(blocks.togglePreview(toggle), true);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(toggle.textContent, 'Hide preview');
    const iframe = /** @type {HTMLIFrameElement} */ (content.querySelector('.code-preview iframe'));
    assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(iframe.getAttribute('src'), '/render-frame');
    assert.equal(iframe.getAttribute('srcdoc'), null);
    assert.equal(iframe.getAttribute('title'), 'Preview of the code block (sandboxed, no network)');
    assert.equal(iframe.getAttribute('data-i18n-title'), 'chat.code.preview_title');

    /** @type {unknown[]} */
    const sent = [];
    const frameWindow = /** @type {Window} */ (iframe.contentWindow);
    frameWindow.postMessage = (/** @type {unknown} */ message, /** @type {unknown} */ target) => sent.push([message, target]);
    // Messages from anything but this frame's window, or from a real origin, do not count.
    fromFrame(iframe, { type: 'starpi-render-ready' }, { source: window });
    fromFrame(iframe, { type: 'starpi-render-ready' }, { origin: 'https://starpi.test' });
    assert.equal(sent.length, 0);
    fromFrame(iframe, { type: 'starpi-render-ready' });
    fromFrame(iframe, { type: 'starpi-render-ready' });
    assert.deepEqual(sent, [[{ type: 'starpi-render', kind: 'html', source: PAGE, theme: 'light', run: false }, '*']], 'sent once');

    fromFrame(iframe, { type: 'starpi-render-height', height: 99_999 });
    assert.equal(iframe.style.height, '720px');
    fromFrame(iframe, { type: 'starpi-render-height', height: 180.4 });
    assert.equal(iframe.style.height, '180px');
    fromFrame(iframe, { type: 'starpi-render-height', height: 'x' });
    assert.equal(iframe.style.height, '180px');

    const run = /** @type {HTMLElement} */ (content.querySelector('[data-action="run-preview"]'));
    assert.equal(run.textContent, 'Run preview');
    assert.equal(blocks.runPreview(run), true);
    assert.deepEqual(sent.at(-1), [{ type: 'starpi-render', kind: 'html', source: PAGE, theme: 'light', run: true }, '*']);

    assert.equal(blocks.togglePreview(toggle), false);
    assert.equal(content.querySelector('.code-preview'), null);
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(blocks.runPreview(run), false);
    // The closed frame's listener is gone.
    fromFrame(iframe, { type: 'starpi-render-height', height: 300 });
    assert.equal(iframe.style.height, '180px');
  });

  it('follows the theme for diagrams and says when one cannot be drawn', () => {
    const content = answer('```mermaid\ngraph TD; A-->B\n```');
    blocks.decorateCodeBlocks(content);
    blocks.togglePreview(/** @type {HTMLElement} */ (content.querySelector('[data-action="preview-code"]')));
    assert.equal(content.querySelector('[data-action="run-preview"]'), null, 'diagrams have no scripts to run');
    const iframe = /** @type {HTMLIFrameElement} */ (content.querySelector('.code-preview iframe'));
    /** @type {Array<Record<string, unknown>>} */
    const sent = [];
    /** @type {Window} */ (iframe.contentWindow).postMessage = (/** @type {Record<string, unknown>} */ message) => sent.push(message);
    document.documentElement.classList.add('dark');
    try {
      fromFrame(iframe, { type: 'starpi-render-ready' });
      assert.equal(sent[0].theme, 'dark');
      fromFrame(iframe, { type: 'starpi-render-error', code: 'diagram' });
      const note = /** @type {HTMLElement} */ (content.querySelector('.code-preview-note'));
      assert.equal(note.hidden, false);
      assert.equal(note.textContent, 'This diagram could not be drawn here. Its source is shown above.');
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('refuses sources the frame would not take', () => {
    const host = document.createElement('div');
    assert.throws(() => render.mountRenderFrame(host, { kind: /** @type {never} */ ('pdf'), source: 'x', title: 't' }), TypeError);
    assert.throws(() => render.mountRenderFrame(host, { kind: 'html', source: 'x'.repeat(render.MAX_PREVIEW_CHARS + 1), title: 't' }), RangeError);
    assert.equal(host.children.length, 0);
  });

  it('mounts search suggestions in the grounding frame', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const remove = render.mountGroundingFrame(host, '<div style="color:red">Suggestions</div>', { title: 'Search suggestions' });
    const iframe = /** @type {HTMLIFrameElement} */ (host.querySelector('iframe'));
    assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    assert.equal(iframe.getAttribute('src'), '/grounding-frame');
    /** @type {unknown[]} */
    const sent = [];
    /** @type {Window} */ (iframe.contentWindow).postMessage = (/** @type {unknown} */ message) => sent.push(message);
    fromFrame(iframe, { type: 'starpi-grounding-ready' });
    assert.deepEqual(sent, [{ type: 'starpi-grounding', html: '<div style="color:red">Suggestions</div>' }]);
    fromFrame(iframe, { type: 'starpi-grounding-height', height: 900 });
    assert.equal(iframe.style.height, '480px');
    remove();
    assert.equal(host.children.length, 0);
    assert.equal(typeof render.mountGroundingFrame(host, ' ', { title: 't' }), 'function');
    assert.equal(host.children.length, 0, 'nothing to show, no frame');
    host.remove();
  });
});

describe('copyAnswer', () => {
  const MD = [
    '# Plan',
    '',
    'The **budget** is *480,000 EUR* with `x = 1` and $E = mc^2$, see [docs](https://example.com).',
    '',
    '- one',
    '- two',
    '  1. nested',
    '',
    '> quoted',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '$$',
    '\\frac{a}{b}',
    '$$',
  ].join('\n');

  it('copies the answer as text and as Markdown rebuilt from the page, tools left out', async () => {
    /** @type {string[]} */
    const copied = [];
    useClipboard(async (text) => {
      copied.push(text);
    });
    const message = document.createElement('div');
    const content = answer(MD);
    message.append(content);
    document.body.append(message);
    await blocks.decorateCodeBlocks(content);
    assert.equal(await blocks.copyAnswer(message), true);
    assert.equal(await blocks.copyAnswer(content, { format: 'markdown' }), true);
    assert.equal(
      copied[0],
      'Plan\n\nThe budget is 480,000 EUR with x = 1 and E = mc^2, see docs.\n\n- one\n- two\n  1. nested\n\nquoted\n\na\tb\n1\t2\n\nconst a = 1;\n\n\\frac{a}{b}',
    );
    assert.equal(
      copied[1],
      '# Plan\n\nThe **budget** is *480,000 EUR* with `x = 1` and $E = mc^2$, see [docs](https://example.com).\n\n- one\n- two\n  1. nested\n\n> quoted\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst a = 1;\n```\n\n$$\n\\frac{a}{b}\n$$',
    );
    message.remove();
  });

  it('copies the remembered Markdown source, keeps citations as labels, and reports a refused clipboard', async () => {
    /** @type {string[]} */
    const copied = [];
    useClipboard(async (text) => {
      copied.push(text);
    });
    const hits = [{ documentId: 'a', documentTitle: 'plan.md', heading: '', content: 'The budget is 480,000 EUR.', tags: [], rank: 1 }];
    const scope = citations.registerCitations(retrieval.assignCitations(hits, { excerptChars: 1600 }));
    const source = 'The budget is 480,000 EUR [Doc: plan.md, Chunk: 1].';
    const content = answer(source, scope);
    assert.ok(content.querySelector('[data-action="open-citation"]'));
    assert.equal(await blocks.copyAnswer(content), true);
    assert.equal(copied.at(-1), source);
    blocks.setAnswerSource(content, '*original*');
    await blocks.copyAnswer(content, { format: 'markdown' });
    assert.equal(copied.at(-1), '*original*');
    useClipboard(() => Promise.reject(new Error('denied')));
    assert.equal(await blocks.copyAnswer(content), false);
    content.remove();
  });
});
