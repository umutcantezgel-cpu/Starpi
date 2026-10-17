// @ts-check
// Lazy rendering extras: syntax highlighting (highlight.js, its common languages) and math (KaTeX,
// MathML output). A chunk of its own that render.js loads the first time an answer has a fenced code
// block or math, so neither library is part of the first load.
//
// Both work on Markdown that renderMarkdown() has already sanitized, and their output passes a
// second sanitizer of its own (one DOMPurify instance each, so their hooks stay apart):
// - Highlighting reads the code's textContent and keeps nothing but <span class="hljs-…">.
// - Math reads the placeholder's TeX and keeps MathML with the html and mathMl profiles, never a style,
//   class, id or link attribute. MathML needs no inline styles, so the app's style-src 'self' holds.
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';

/** Longer code stays plain: highlighting runs again on every streamed frame. */
export const MAX_HIGHLIGHT_CHARS = 100_000;
/** Fence languages highlight.js knows under another name. */
const LANGUAGE_ALIASES = /** @type {Record<string, string>} */ ({ svg: 'xml', htm: 'xml', vue: 'xml', jsonc: 'json', zsh: 'bash', console: 'bash', sh: 'bash', shell: 'bash' });
const HLJS_CLASS = /^hljs-[\w-]{1,40}$/;

const highlightPurifier = DOMPurify(window);
highlightPurifier.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName !== 'class') return;
  const kept = data.attrValue.split(/\s+/).filter((name) => HLJS_CLASS.test(name));
  if (kept.length === 0) data.keepAttr = false;
  else data.attrValue = kept.join(' ');
});
const HIGHLIGHT_CONFIG = { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false };

const mathPurifier = DOMPurify(window);
const MATH_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true },
  FORBID_TAGS: ['style', 'script', 'img', 'svg', 'a', 'form', 'input', 'button', 'iframe', 'mglyph', 'malignmark', 'maction'],
  FORBID_ATTR: ['style', 'class', 'id', 'href', 'xlink:href', 'src', 'srcset'],
  // The TeX annotation goes with its content: it would show as text once <semantics> is unwrapped.
  ADD_FORBID_CONTENTS: ['annotation', 'annotation-xml'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/**
 * Keeps only <span> elements whose classes are highlight.js token classes, with their text.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHighlight(html) {
  return /** @type {string} */ (/** @type {unknown} */ (highlightPurifier.sanitize(html, HIGHLIGHT_CONFIG)));
}

/**
 * Keeps MathML (and plain HTML text structure) without styles, classes, ids, links or event handlers.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeMathMl(html) {
  return /** @type {string} */ (/** @type {unknown} */ (mathPurifier.sanitize(html, MATH_CONFIG)));
}

/**
 * A small LRU cache: streamed answers re-render many times with the same blocks.
 * @param {number} size
 */
function cache(size) {
  /** @type {Map<string, string | null>} */
  const map = new Map();
  return {
    /** @param {string} key @param {() => string | null} make */
    get(key, make) {
      if (map.has(key)) {
        const value = /** @type {string | null} */ (map.get(key));
        map.delete(key);
        map.set(key, value);
        return value;
      }
      const value = make();
      map.set(key, value);
      if (map.size > size) map.delete(/** @type {string} */ (map.keys().next().value));
      return value;
    },
  };
}

const highlighted = cache(120);
const typeset = cache(400);

/**
 * The highlight.js name of a fence language, or null when it has none.
 * @param {string} language
 */
export function highlightLanguage(language) {
  const name = LANGUAGE_ALIASES[language] ?? language;
  return name && hljs.getLanguage(name) ? name : null;
}

/**
 * Highlighted, sanitized HTML for code, or null (unknown language, too long).
 * @param {string} code
 * @param {string} language  a fence language
 * @returns {string | null}
 */
export function highlightCode(code, language) {
  const name = highlightLanguage(language);
  if (!name || !code || code.length > MAX_HIGHLIGHT_CHARS) return null;
  return highlighted.get(`${name}\u0000${code}`, () => {
    try {
      return sanitizeHighlight(hljs.highlight(code, { language: name, ignoreIllegals: true }).value);
    } catch {
      return null;
    }
  });
}

/**
 * Sanitized MathML for TeX, or null when KaTeX cannot parse it (the TeX stays as text then).
 * @param {string} tex
 * @param {boolean} display
 * @returns {string | null}
 */
export function renderMath(tex, display) {
  if (!tex.trim()) return null;
  return typeset.get(`${display ? 'D' : 'I'}${tex}`, () => {
    try {
      // trust: false keeps \href, \url, \includegraphics and the \html… commands out; throwOnError
      // keeps KaTeX's error markup (an inline style) out.
      const html = katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: true, trust: false, strict: 'ignore', maxSize: 50, maxExpand: 300 });
      return sanitizeMathMl(html);
    } catch {
      return null;
    }
  });
}

/**
 * Highlights every fenced code block with a known language and typesets every math placeholder under
 * root, in place. Finished elements are marked (class hljs, math-rendered or math-error) and skipped
 * when called again.
 * @param {ParentNode} root  sanitized rendered Markdown (an element or a template's content)
 */
export function enhance(root) {
  for (const code of root.querySelectorAll('pre > code[class*="language-"]:not(.hljs)')) {
    const language = /(?:^|\s)language-([\w#+.-]+)/.exec(code.className)?.[1] ?? '';
    const html = highlightCode(code.textContent ?? '', language);
    if (html === null) continue;
    code.innerHTML = html;
    code.classList.add('hljs');
  }
  for (const el of root.querySelectorAll('.math-inline:not(.math-rendered):not(.math-error), .math-display:not(.math-rendered):not(.math-error)')) {
    const tex = el.textContent ?? '';
    const html = renderMath(tex, el.classList.contains('math-display'));
    if (html === null) {
      el.classList.add('math-error');
      continue;
    }
    // The TeX stays on the element for copying the answer as Markdown (code-blocks.js).
    el.setAttribute('data-tex', tex);
    el.innerHTML = html;
    el.classList.add('math-rendered');
  }
}
