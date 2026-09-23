// @ts-check
// Escaping and sanitized Markdown rendering. Every piece of Markdown that reaches innerHTML
// (database content, model output, chat history) must go through renderMarkdown().
import DOMPurify from 'dompurify';
import { marked } from 'marked';

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
 * Replaces model and provider names in user-facing text with neutral labels.
 * @param {unknown} str
 */
export function sanitizeModelNames(str) {
  if (!str) return '';
  return String(str)
    .replace(/\b(Google\s+)?Gemini(\s+2\.\d+)?(\s+Flash|\s+Pro|\s+Exp)?/gi, 'Inferenzinstanz')
    .replace(/\bOpenRouter(\s+Cloud\s+AI)?/gi, 'Redundanzknoten')
    .replace(/\b(Meta\s+)?Llama(-3(\.\d+)?)?(-[0-9]+(\.[0-9]+)?B)?(-Instruct)?/gi, 'Kompaktmodell')
    .replace(/\b(Alibaba\s+)?Qwen(2(\.\d+)?)?(-[0-9]+(\.[0-9]+)?B)?(-Instruct)?/gi, 'Hochpräzisionsmodell')
    .replace(/\b(DeepSeek)(-R1)?(-Distill)?(-Qwen)?/gi, 'Logikinstanz')
    .replace(/\b(Nvidia\s+)?Nemotron(-[0-9]+(\.[0-9]+)?)?(-lightning)?/gi, 'Inferenzknoten')
    .replace(/\bLiquid(\s+LFM)?(-[0-9]+(\.[0-9]+)?)?/gi, 'Inferenzknoten')
    .replace(/\bSmolLM2?(-[0-9]+(\.[0-9]+)?B)?(-Instruct)?/gi, 'Kompaktmodell')
    .replace(/\b(Nous\s+)?Hermes(-[0-9]+)?/gi, 'Logikmodell')
    .replace(/\b(Microsoft\s+)?Phi(-3(\.\d+)?)?(-mini)?(-instruct)?/gi, 'Reasoningmodell')
    .replace(/\b(ChatGPT|GPT-4[o\w]*|GPT-3\.5|OpenAI)/gi, 'Assistent')
    .replace(/liquid\/[^\s,)]+/gi, 'Redundanzknoten')
    .replace(/nvidia\/[^\s,)]+/gi, 'Redundanzknoten')
    .replace(/google\/[^\s,)]+/gi, 'Primärknoten')
    .replace(/openrouter\/[^\s,)]+/gi, 'Autoknoten');
}
