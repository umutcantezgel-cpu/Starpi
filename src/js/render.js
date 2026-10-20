// @ts-check
// Escaping and sanitized Markdown rendering. Every piece of Markdown that reaches innerHTML
// (database content, model output, chat history) must go through renderMarkdown().
//
// Syntax highlighting (highlight.js) and math (KaTeX, as MathML) live in the lazy chunk
// render-extras.js, which loads the first time an answer has a fenced code block or math. Both work
// on the output of the sanitizer below and pass a second, narrower sanitizer of their own. Math is
// cut out of the Markdown by a tokenizer extension ($…$, $$…$$, \(…\), \[…\]) so marked never reads
// emphasis or escapes inside it; until the chunk is there, math shows as its TeX source.
//
// Diagrams and HTML/SVG previews never render in the app's DOM: mountRenderFrame() shows them in the
// sandboxed render frame (public/render-frame.html), and mountGroundingFrame() shows search
// suggestions in the grounding frame (public/grounding-frame.html).
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { t } from './i18n/index.js';

/** @type {Record<string, string>} */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };

/**
 * Escapes text for use in HTML text nodes and quoted attribute values.
 * @param {unknown} value
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Makes untrusted text inert inside a Markdown document: escapes Markdown/HTML control characters
 * and collapses line breaks so values cannot open links, images, headings or HTML blocks. Its
 * escaped parentheses and brackets never open math (looksLikeTex); dollar signs stay as written,
 * and prices never meet the rules of $…$ math (inlineDollar). The source check parses this output
 * (core/grounding.js), so its form stays as it is.
 * @param {unknown} value
 */
export function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[\\`*_{}[\]()#+!|<>~&]/g, '\\$&');
}

const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  // data-* attributes would let stored content trigger the delegated UI actions (data-action="…").
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  FORBID_TAGS: ['style', 'img', 'picture', 'video', 'audio', 'source', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style', 'class', 'id', 'srcset'],
};

/** Class names the sanitizer keeps although classes are forbidden: they carry no styling of the app. */
const LANGUAGE_CLASS = /^language-[\w#+.-]{1,40}$/;
const MATH_CLASSES = new Set(['math-inline', 'math-display']);

/** Longest TeX source that becomes math; longer runs stay text. */
const MAX_TEX = 4000;

let hooksInstalled = false;

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // The two markers render-extras.js needs: the language of a fenced code block (marked writes it as
  // <code class="language-…"> inside <pre>) and the math placeholders written below.
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName !== 'class') return;
    const value = data.attrValue;
    const keep =
      (node.tagName === 'CODE' && node.parentElement?.tagName === 'PRE' && LANGUAGE_CLASS.test(value)) ||
      (node.tagName === 'SPAN' && MATH_CLASSES.has(value)) ||
      (node.tagName === 'DIV' && value === 'math-display');
    if (keep) data.forceKeepAttr = true;
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href') ?? '';
    let protocol;
    try {
      protocol = new URL(href, 'https://invalid.local/').protocol;
    } catch {
      protocol = '';
    }
    if (!href || !ALLOWED_LINK_PROTOCOLS.has(protocol) || href.startsWith('//')) {
      node.removeAttribute('href');
      return;
    }
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  });
}

/**
 * Inline `$…$` at the start of src, by the rules that keep prices plain text: a non-space follows
 * the opening $, and the first unescaped $ after it closes only when a non-space precedes it and no
 * digit follows it ("$5 and $10" stays text). Otherwise the opening $ is no math at all.
 * @param {string} src
 * @returns {{ raw: string, text: string } | null}
 */
function inlineDollar(src) {
  if (src[0] !== '$' || src[1] === '$' || !src[1] || /\s/.test(src[1])) return null;
  const end = Math.min(src.length, MAX_TEX + 2);
  for (let i = 1; i < end; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch !== '$') continue;
    if (/\s/.test(src[i - 1]) || /\d/.test(src[i + 1] ?? '')) return null;
    return { raw: src.slice(0, i + 1), text: src.slice(1, i) };
  }
  return null;
}

const INLINE_DISPLAY = new RegExp(String.raw`^\$\$((?:\\[\s\S]|[^$\\]){1,${MAX_TEX}}?)\$\$`);
const INLINE_PAREN = new RegExp(String.raw`^\\\(([\s\S]{1,${MAX_TEX}}?)\\\)`);
// A display block holds no blank line (TeX would end the formula there), so a stray $$ cannot swallow
// the paragraphs after it. Up to three spaces may indent it, and nothing but spaces may follow it.
const BLOCK_DOLLAR = new RegExp(String.raw`^ {0,3}\$\$((?:(?!\n[ \t]*\n)[\s\S]){1,${MAX_TEX}}?)\$\$[ \t]*(?:\n|$)`);
const BLOCK_BRACKET = new RegExp(String.raw`^ {0,3}\\\[((?:(?!\n[ \t]*\n)[\s\S]){1,${MAX_TEX}}?)\\\][ \t]*(?:\n|$)`);

/**
 * Whether text inside \( \) or \[ \] is TeX: an unescaped command (\alpha), ^, _, { or }. Markdown
 * writes "\(" for a plain parenthesis too, and escapeMarkdown() escapes every parenthesis, bracket,
 * backslash, underscore and brace of a value, so its output never passes; "\(x\)" without TeX stays
 * "(x)".
 * @param {string} text
 */
export function looksLikeTex(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      if (/[a-z]/i.test(text[i + 1] ?? '')) return true;
      i += 1;
    } else if (ch === '^' || ch === '_' || ch === '{' || ch === '}') {
      return true;
    }
  }
  return false;
}

/**
 * Inline \(…\) math at the start of src.
 * @param {string} src
 */
function inlineParen(src) {
  const m = INLINE_PAREN.exec(src);
  return m && m[1].trim() && looksLikeTex(m[1]) ? m : null;
}

/**
 * A display block at the start of src: $$…$$, or \[…\] around TeX or spread over lines (a value
 * escapeMarkdown() wrote never has a line break).
 * @param {string} src
 */
function blockMath(src) {
  const dollar = BLOCK_DOLLAR.exec(src);
  if (dollar) return dollar;
  const bracket = BLOCK_BRACKET.exec(src);
  return bracket && (looksLikeTex(bracket[1]) || /^[ \t]*\n/.test(bracket[1])) ? bracket : null;
}

/**
 * The tokenizer extension that protects math from marked. Its renderers write placeholders that the
 * sanitizer keeps (the TeX as escaped text); render-extras.js turns them into MathML.
 * @type {import('marked').TokenizerAndRendererExtension[]}
 */
export const mathExtensions = [
  {
    name: 'mathBlock',
    level: 'block',
    // A display block starts a line; a $$ inside a line is inline math.
    start(src) {
      const m = /(^|\n) {0,3}(?:\$\$|\\\[)/.exec(src);
      return m ? m.index + m[1].length : undefined;
    },
    tokenizer(src) {
      const m = blockMath(src);
      const text = m?.[1].trim();
      return m && text ? { type: 'mathBlock', raw: m[0], text } : undefined;
    },
    renderer(token) {
      return `<div class="math-display">${escapeHtml(token.text)}</div>\n`;
    },
  },
  {
    name: 'math',
    level: 'inline',
    start(src) {
      const i = src.search(/\$|\\\(/);
      return i === -1 ? undefined : i;
    },
    tokenizer(src) {
      const display = INLINE_DISPLAY.exec(src);
      if (display?.[1].trim()) return { type: 'math', raw: display[0], text: display[1].trim(), display: true };
      const paren = inlineParen(src);
      if (paren) return { type: 'math', raw: paren[0], text: paren[1].trim(), display: false };
      const dollar = inlineDollar(src);
      return dollar ? { type: 'math', raw: dollar.raw, text: dollar.text, display: false } : undefined;
    },
    renderer(token) {
      return `<span class="${token.display ? 'math-display' : 'math-inline'}">${escapeHtml(token.text)}</span>`;
    },
  },
];

/**
 * The language and title of a fence's info string ("html title=\"Landing page\"").
 * @param {string | undefined} info
 * @returns {{ language: string, title: string }}
 */
export function parseFenceInfo(info) {
  const text = String(info ?? '').trim();
  const language = (text.match(/^[^\s{]+/)?.[0] ?? '')
    .toLowerCase()
    .replace(/[^\w#+.-]/g, '')
    .slice(0, 40);
  const title = text.match(/\btitle=(?:"([^"]*)"|'([^']*)'|(\S+))/);
  return { language, title: (title?.[1] ?? title?.[2] ?? title?.[3] ?? '').trim().slice(0, 120) };
}

/**
 * Hides the inside of inline math from marked's search for emphasis delimiters ("*a $x*y$*" keeps
 * the formula whole). The mask keeps the length; only that search reads it.
 * @param {string} src
 */
export function maskInlineMath(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const next = src.slice(i).search(/\\[\s\S]|\$/);
    if (next === -1) break;
    const at = i + next;
    out += src.slice(i, at);
    if (src[at] === '\\' && src[at + 1] !== '(') {
      out += src.slice(at, at + 2);
      i = at + 2;
      continue;
    }
    const rest = src.slice(at);
    const raw = INLINE_DISPLAY.exec(rest)?.[0] ?? inlineParen(rest)?.[0] ?? inlineDollar(rest)?.raw;
    if (raw) {
      const open = raw.startsWith('$$') ? 2 : raw.startsWith('$') ? 1 : 2;
      out += raw.slice(0, open) + 'a'.repeat(raw.length - 2 * open) + raw.slice(-open);
      i = at + raw.length;
    } else {
      out += src[at];
      i = at + 1;
    }
  }
  return out + src.slice(i);
}

const md = new Marked({
  async: false,
  gfm: true,
  extensions: mathExtensions,
  hooks: { emStrongMask: maskInlineMath },
  renderer: {
    // As marked's own, plus the fence title on <pre> (code-blocks.js names downloads and canvas
    // documents after it).
    code({ text, lang, escaped }) {
      const { language, title } = parseFenceInfo(lang);
      const body = text ? `${text.replace(/\n$/, '')}\n` : '';
      const code = escaped ? body : escapeHtml(body);
      return `<pre${title ? ` title="${escapeHtml(title)}"` : ''}><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${code}</code></pre>\n`;
    },
  },
});

/** Sanitized HTML that render-extras.js has work for: a fenced code block with a language, or math. */
const EXTRAS_MARKER = /<code class="language-|class="math-(?:inline|display)"/;

/**
 * The lazy chunk's URL in a build (scripts/build.mjs writes it here); unbundled (tests, Node), the
 * module next to this one.
 */
const RENDER_EXTRAS_URL = '__STARPI_RENDER_EXTRAS_URL__';

/** @type {typeof import('./render-extras.js') | null} */
let extras = null;
/** @type {Promise<typeof import('./render-extras.js')> | null} */
let extrasLoad = null;

/**
 * Loads highlight.js and KaTeX (once). Rejects when the chunk cannot be fetched; the next call tries
 * again.
 * @returns {Promise<typeof import('./render-extras.js')>}
 */
export function loadRenderExtras() {
  if (extras) return Promise.resolve(extras);
  if (!extrasLoad) {
    const specifier = RENDER_EXTRAS_URL.startsWith('/') ? RENDER_EXTRAS_URL : './render-extras.js';
    extrasLoad = /** @type {Promise<typeof import('./render-extras.js')>} */ (import(specifier)).then(
      (module) => (extras = module),
      (err) => {
        extrasLoad = null;
        throw err;
      },
    );
  }
  return extrasLoad;
}

/**
 * Converts Markdown to sanitized HTML (no scripts, event handlers, styles, images, forms or unsafe
 * links). Code is highlighted and math typeset when the lazy chunk is loaded; otherwise this starts
 * loading it and returns the plain form (call enhanceRendered() on the inserted element, or render
 * again, to upgrade it).
 * @param {unknown} markdown
 * @param {{ extras?: boolean }} [options]  extras: false returns the plain form and loads nothing
 * @returns {string}
 */
export function renderMarkdown(markdown, { extras: useExtras = true } = {}) {
  installHooks();
  const html = /** @type {string} */ (md.parse(String(markdown ?? '')));
  const clean = /** @type {string} */ (/** @type {unknown} */ (DOMPurify.sanitize(html, PURIFY_CONFIG)));
  if (!useExtras || !EXTRAS_MARKER.test(clean)) return clean;
  if (!extras) {
    loadRenderExtras().catch(() => {});
    return clean;
  }
  const template = document.createElement('template');
  template.innerHTML = clean;
  extras.enhance(template.content);
  return template.innerHTML;
}

/**
 * Highlights the code and typesets the math of rendered Markdown already in the page, loading the
 * lazy chunk first when needed. Safe to call repeatedly: finished elements are skipped.
 * @param {ParentNode} root
 * @returns {Promise<boolean>} whether the chunk was available
 */
export async function enhanceRendered(root) {
  if (!root.querySelector('pre > code[class*="language-"], .math-inline, .math-display')) return true;
  try {
    (extras ?? (await loadRenderExtras())).enhance(root);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces provider and model identifiers in status and error messages (connection tests, provider
 * failures) with a neutral label. Only whole words are replaced. Never applied to answers: they may
 * quote documents verbatim, and citations must match the source text exactly. Not applied on the
 * NVIDIA cloud path either: the user picked that model, so badges and traces name it on purpose, and
 * its error messages come from i18n keys only, never from server text.
 * @param {unknown} str
 */
export function sanitizeModelNames(str) {
  if (!str) return '';
  const label = t('app.model_generic');
  return String(str)
    .replace(/\b(?:google|nvidia|liquid|openrouter|meta-llama|qwen|microsoft|deepseek|minimax)\/[^\s,)\]]+/gi, label)
    .replace(
      /\b(?:(?:Google\s+)?Gemini(?:[\s-]\d+(?:\.\d+)?)?(?:[\s-](?:Flash|Pro|Exp))?|OpenRouter|(?:Meta\s+)?Llama(?:[\s-]?\d+(?:\.\d+)?)?(?:-\d+(?:\.\d+)?B)?(?:-Instruct)?|Qwen\d*(?:\.\d+)?(?:-\d+(?:\.\d+)?B)?(?:-Instruct)?|DeepSeek(?:-R1)?|MiniMax(?:[\s-]M\d+(?:\.\d+)?(?:[\s-]Flash)?)?|Nemotron|SmolLM2?|ChatGPT|GPT-[34][.\w-]*)\b/gi,
      label,
    );
}

// --- Sandboxed frames ---------------------------------------------------------------------------
//
// Both frames are pages of their own under exact-path header rules (scripts/headers.json): an opaque
// origin (iframe sandbox without allow-same-origin, and the CSP sandbox directive), no network
// (connect-src 'none'), framed by the app only. Content arrives by postMessage, never by srcdoc
// (which would inherit the app's CSP and origin). Protocol: the frame posts { type: '<p>-ready' } to
// its parent; the app answers once with the content through iframe.contentWindow.postMessage(…, '*')
// (no other target matches an opaque origin); the frame reports { type: '<p>-height', height } and,
// for the render frame, { type: '<p>-error', code }. The app accepts a message only when its source
// is this very frame's window and its origin the opaque "null".

/** Clean URL of public/render-frame.html (the exact path of its header rule). */
export const RENDER_FRAME_URL = '/render-frame';
/** Clean URL of public/grounding-frame.html. */
export const GROUNDING_FRAME_URL = '/grounding-frame';
/** Scripts for the frame's own renderer; never allow-same-origin, never popups or top navigation. */
export const RENDER_FRAME_SANDBOX = 'allow-scripts';
/** Search suggestion links open a new browsing context outside the sandbox. */
export const GROUNDING_FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
/** What the render frame previews. */
export const PREVIEW_KINDS = Object.freeze(/** @type {const} */ (['html', 'svg', 'mermaid']));
/** Longest source the render frame takes (characters); public/render-frame.js refuses more. */
export const MAX_PREVIEW_CHARS = 512_000;
/** Search suggestions are a few kB; public/grounding-frame.js refuses more. */
export const MAX_SUGGESTIONS_CHARS = 100_000;

/** @typedef {(typeof PREVIEW_KINDS)[number]} PreviewKind */

/**
 * @param {HTMLElement} host  the frame replaces its children
 * @param {{ url: string, sandbox: string, title: string, prefix: string, maxHeight: number, content: () => Record<string, unknown>, onError?: (code: string) => void }} options
 */
function mountFrame(host, options) {
  const win = host.ownerDocument.defaultView ?? window;
  const iframe = host.ownerDocument.createElement('iframe');
  iframe.setAttribute('sandbox', options.sandbox);
  iframe.setAttribute('title', options.title);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.className = 'sandbox-frame';
  let ready = false;
  const send = () => iframe.contentWindow?.postMessage(options.content(), '*');
  /** @param {MessageEvent} event */
  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
    const data = /** @type {{ type?: unknown, height?: unknown, code?: unknown } | null} */ (event.data);
    if (!data || typeof data !== 'object') return;
    if (data.type === `${options.prefix}-ready`) {
      // Only the first: content that keeps announcing itself must not make the app resend forever.
      if (ready) return;
      ready = true;
      send();
    } else if (data.type === `${options.prefix}-height` && typeof data.height === 'number' && Number.isFinite(data.height)) {
      iframe.style.height = `${Math.round(Math.min(options.maxHeight, Math.max(0, data.height)))}px`;
    } else if (data.type === `${options.prefix}-error` && typeof data.code === 'string') {
      options.onError?.(data.code.slice(0, 40));
    }
  };
  // Before the frame loads: its "ready" arrives while its script runs.
  win.addEventListener('message', onMessage);
  iframe.src = options.url;
  host.replaceChildren(iframe);
  return {
    frame: iframe,
    /** Sends the content again (after it changed); a no-op until the frame is ready. */
    resend() {
      if (ready) send();
    },
    destroy() {
      win.removeEventListener('message', onMessage);
      iframe.remove();
    },
  };
}

/** @returns {'light' | 'dark'} */
const currentTheme = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

/**
 * Previews HTML, SVG or a mermaid diagram in a new render frame inside `host`. HTML shows without
 * its scripts until run() (a click on "Run preview"); diagrams follow the app's theme.
 * @param {HTMLElement} host
 * @param {{ kind: PreviewKind, source: string, title: string, onError?: (code: string) => void }} options
 *   onError: the frame could not show the content ('diagram' for a diagram it could not draw)
 * @returns {{ frame: HTMLIFrameElement, run(): void, destroy(): void }}
 */
export function mountRenderFrame(host, { kind, source, title, onError }) {
  if (!PREVIEW_KINDS.includes(kind)) throw new TypeError(`unknown preview kind ${kind}`);
  if (typeof source !== 'string' || source.length > MAX_PREVIEW_CHARS) throw new RangeError('preview source too large');
  let run = false;
  let theme = currentTheme();
  const frame = mountFrame(host, {
    url: RENDER_FRAME_URL,
    sandbox: RENDER_FRAME_SANDBOX,
    title,
    prefix: 'starpi-render',
    maxHeight: 720,
    content: () => {
      theme = currentTheme();
      return { type: 'starpi-render', kind, source, theme, run };
    },
    onError,
  });
  /** @type {MutationObserver | null} */
  let observer = null;
  if (kind === 'mermaid' && typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => {
      if (currentTheme() !== theme) frame.resend();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  return {
    frame: frame.frame,
    run() {
      if (kind !== 'html') return;
      run = true;
      frame.resend();
    },
    destroy() {
      observer?.disconnect();
      frame.destroy();
    },
  };
}

/**
 * Shows the search suggestions a provider returned with a grounded web answer, unchanged, in a new
 * grounding frame inside `host`. Nothing happens for empty or oversized HTML.
 * @param {HTMLElement} host
 * @param {string} html
 * @param {{ title: string }} options  title: accessible name of the frame
 * @returns {() => void}  removes the frame
 */
export function mountGroundingFrame(host, html, { title }) {
  if (typeof html !== 'string' || !html.trim() || html.length > MAX_SUGGESTIONS_CHARS) return () => {};
  const frame = mountFrame(host, {
    url: GROUNDING_FRAME_URL,
    sandbox: GROUNDING_FRAME_SANDBOX,
    title,
    prefix: 'starpi-grounding',
    maxHeight: 480,
    content: () => ({ type: 'starpi-grounding', html }),
  });
  return () => frame.destroy();
}
