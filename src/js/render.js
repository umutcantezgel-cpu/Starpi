// @ts-check
// Escaping and sanitized Markdown rendering. Every piece of Markdown that reaches innerHTML
// (database content, model output, chat history) must go through renderMarkdown().
import DOMPurify from 'dompurify';
import { marked } from 'marked';
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
 * and collapses line breaks so values cannot open links, images, headings or HTML blocks.
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

let hooksInstalled = false;

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
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
 * Converts Markdown to sanitized HTML (no scripts, event handlers, styles, images, forms or unsafe links).
 * @param {unknown} markdown
 * @returns {string}
 */
export function renderMarkdown(markdown) {
  installHooks();
  const html = /** @type {string} */ (marked.parse(String(markdown ?? ''), { async: false, gfm: true }));
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/**
 * Replaces provider and model identifiers in status and error messages (connection tests, provider
 * failures) with a neutral label. Only whole words are replaced. Never applied to answers: they may
 * quote documents verbatim, and citations must match the source text exactly.
 * @param {unknown} str
 */
export function sanitizeModelNames(str) {
  if (!str) return '';
  const label = t('app.model_generic');
  return String(str)
    .replace(/\b(?:google|nvidia|liquid|openrouter|meta-llama|qwen|microsoft|deepseek)\/[^\s,)\]]+/gi, label)
    .replace(
      /\b(?:(?:Google\s+)?Gemini(?:[\s-]\d+(?:\.\d+)?)?(?:[\s-](?:Flash|Pro|Exp))?|OpenRouter|(?:Meta\s+)?Llama(?:[\s-]?\d+(?:\.\d+)?)?(?:-\d+(?:\.\d+)?B)?(?:-Instruct)?|Qwen\d*(?:\.\d+)?(?:-\d+(?:\.\d+)?B)?(?:-Instruct)?|DeepSeek(?:-R1)?|Nemotron|SmolLM2?|ChatGPT|GPT-[34][.\w-]*)\b/gi,
      label,
    );
}
