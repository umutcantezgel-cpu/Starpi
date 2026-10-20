// @ts-check
// Tools on the code blocks of rendered answers: Copy, Download, Open in canvas, and a Preview of
// HTML, SVG and mermaid blocks in the sandboxed render frame; plus copying a whole answer as text or
// Markdown. Sanitized Markdown cannot carry buttons, classes or data attributes (render.js), so the
// tools are added afterwards with DOM APIs, in a bar above the code that holds nothing but buttons
// (its language label is CSS). The source check skips <pre> and every button that is not a citation
// (grounding-view.js), so the tools never change a verdict.
import { citationLabel } from './core/labels.js';
import { onAction } from './dom.js';
import { refreshIcons } from './icons.js';
import { setText, t } from './i18n/index.js';
import { enhanceRendered, MAX_PREVIEW_CHARS, mountRenderFrame } from './render.js';

/**
 * The event "Open in canvas" dispatches on the code block; it bubbles to document. detail:
 * { code, language, title }. The canvas listens for it and calls enableCanvas() once it does, so the
 * button only appears where something opens the code.
 */
export const OPEN_CANVAS_EVENT = 'starpi:open-canvas';
/** Blocks longer than this many lines are canvas candidates whatever their language. */
const CANVAS_MIN_LINES = 15;
/** Fence languages the render frame previews, by kind. */
const PREVIEW_LANGUAGES = /** @type {Record<string, import('./render.js').PreviewKind>} */ ({ html: 'html', htm: 'html', xhtml: 'html', svg: 'svg', mermaid: 'mermaid', mmd: 'mermaid' });
/** File name extensions for downloads, by fence language (anything else is .txt). */
const EXTENSIONS = /** @type {Record<string, string>} */ ({
  javascript: 'js',
  js: 'js',
  mjs: 'mjs',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  python: 'py',
  py: 'py',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yml',
  toml: 'toml',
  xml: 'xml',
  svg: 'svg',
  markdown: 'md',
  md: 'md',
  mermaid: 'mmd',
  mmd: 'mmd',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  powershell: 'ps1',
  sql: 'sql',
  java: 'java',
  kotlin: 'kt',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'cs',
  cs: 'cs',
  go: 'go',
  rust: 'rs',
  rs: 'rs',
  ruby: 'rb',
  rb: 'rb',
  php: 'php',
  swift: 'swift',
  r: 'r',
  lua: 'lua',
  csv: 'csv',
  ini: 'ini',
  dockerfile: 'Dockerfile',
  makefile: 'mk',
});

/** @type {WeakMap<HTMLElement, ReturnType<typeof setTimeout>>} */
const labelResets = new WeakMap();
/** Open previews, by code block. @type {WeakMap<HTMLElement, ReturnType<typeof mountRenderFrame>>} */
const previews = new WeakMap();
/** Markdown sources of answers, for copyAnswer(). @type {WeakMap<Element, string>} */
const answerSources = new WeakMap();
let canvasEnabled = false;
/** Numbers the preview panels (their ids tie them to their button). */
let previewCount = 0;

/**
 * Called by the canvas once it listens for OPEN_CANVAS_EVENT: code blocks decorated from then on get
 * "Open in canvas".
 * @param {boolean} [enabled]
 */
export function enableCanvas(enabled = true) {
  canvasEnabled = enabled;
}

/**
 * What a decorated code block holds.
 * @param {Element} el  the block or anything inside it
 * @returns {{ block: HTMLElement, pre: HTMLElement, code: string, language: string, title: string } | null}
 */
export function codeBlockInfo(el) {
  const block = /** @type {HTMLElement | null} */ (el.closest('.code-block'));
  const pre = /** @type {HTMLElement | null} */ (block?.querySelector(':scope > pre') ?? null);
  if (!block || !pre) return null;
  return {
    block,
    pre,
    code: (pre.textContent ?? '').replace(/\n$/, ''),
    language: /(?:^|\s)language-([\w#+.-]+)/.exec(pre.querySelector('code')?.className ?? '')?.[1] ?? '',
    title: pre.getAttribute('title') ?? '',
  };
}

/**
 * @param {{ action: string, icon: string, label: string, aria?: string, className?: string }} spec
 *   label: i18n key of the visible label; aria: of the accessible name when it says more
 */
function toolButton({ action, icon, label, aria, className = '' }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `code-action ${className}`.trim();
  btn.dataset.action = action;
  if (aria) {
    btn.setAttribute('data-i18n-aria', aria);
    btn.setAttribute('aria-label', t(aria));
  }
  const glyph = document.createElement('i');
  glyph.dataset.lucide = icon;
  glyph.className = 'w-3.5 h-3.5';
  const text = document.createElement('span');
  text.className = 'code-action-label';
  setText(text, label);
  btn.append(glyph, text);
  return btn;
}

/**
 * @param {string} code
 * @param {string} language
 * @param {string} title
 */
function canvasCandidate(code, language, title) {
  if (PREVIEW_LANGUAGES[language]) return true;
  if ((language === 'markdown' || language === 'md') && title) return true;
  return code.split('\n').length > CANVAS_MIN_LINES;
}

/**
 * Wraps every code block under root in a .code-block with its tools, then highlights the code and
 * typesets the math of root (render-extras.js, loaded on demand). Calling it again on the same
 * answer adds nothing.
 * @param {HTMLElement} root  the .message-content of an answer
 * @returns {Promise<boolean>} settles once highlighting and math are applied (false: the chunk failed to load)
 */
export function decorateCodeBlocks(root) {
  const blocks = [...root.querySelectorAll('pre')].filter((pre) => !pre.parentElement?.classList.contains('code-block'));
  for (const pre of blocks) {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.before(wrap);
    const head = document.createElement('div');
    head.className = 'code-head';
    wrap.append(head, pre);
    // Long lines scroll sideways; the keyboard needs a stop to scroll them.
    pre.tabIndex = 0;
    const info = /** @type {NonNullable<ReturnType<typeof codeBlockInfo>>} */ (codeBlockInfo(pre));
    if (info.language) head.dataset.lang = info.language;
    head.append(
      toolButton({ action: 'copy-code', icon: 'copy', label: 'chat.copy', aria: 'chat.copy_code', className: 'code-copy' }),
      toolButton({ action: 'download-code', icon: 'download', label: 'chat.code.download', aria: 'chat.code.download_aria' }),
    );
    if (canvasEnabled && canvasCandidate(info.code, info.language, info.title)) {
      head.append(toolButton({ action: 'canvas-code', icon: 'panel-right', label: 'chat.code.canvas' }));
    }
    const kind = PREVIEW_LANGUAGES[info.language];
    if (kind && info.code.trim() && info.code.length <= MAX_PREVIEW_CHARS) {
      const preview = toolButton({ action: 'preview-code', icon: 'monitor', label: 'chat.code.preview' });
      preview.setAttribute('aria-expanded', 'false');
      head.append(preview);
    }
  }
  if (blocks.length) refreshIcons(root);
  return enhanceRendered(root);
}

/**
 * Copies the code of the block the button belongs to. Without clipboard access (permission refused,
 * no secure context) the code is selected instead, so it can be copied by hand.
 * @param {HTMLElement} btn
 * @returns {Promise<boolean>} whether the code reached the clipboard
 */
export async function copyCodeBlock(btn) {
  const info = codeBlockInfo(btn);
  if (!info) return false;
  let copied = false;
  try {
    await navigator.clipboard.writeText(info.code);
    copied = true;
  } catch {
    window.getSelection()?.selectAllChildren(info.pre);
  }
  const label = btn.querySelector('.code-action-label');
  setText(label, copied ? 'chat.copied' : 'chat.copy_manual');
  clearTimeout(labelResets.get(btn));
  labelResets.set(btn, setTimeout(() => setText(label, 'chat.copy'), 2000));
  return copied;
}

/**
 * The file name a block downloads as: its fence title, else "code", with the language's extension.
 * @param {{ language: string, title: string }} info
 */
export function downloadName({ language, title }) {
  const ext = EXTENSIONS[language] ?? 'txt';
  const base =
    title
      .replace(/\.[\w-]{1,10}$/, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || 'code';
  return ext === 'Dockerfile' ? 'Dockerfile' : `${base}.${ext}`;
}

/**
 * Saves the code of the button's block as a file.
 * @param {HTMLElement} btn
 * @returns {string | null} the file name, or null without a block
 */
export function downloadCodeBlock(btn) {
  const info = codeBlockInfo(btn);
  if (!info) return null;
  const name = downloadName(info);
  const url = URL.createObjectURL(new Blob([info.code], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/**
 * Hands the button's block to the canvas (OPEN_CANVAS_EVENT).
 * @param {HTMLElement} btn
 * @returns {boolean} whether a listener took it (called preventDefault())
 */
export function openInCanvas(btn) {
  const info = codeBlockInfo(btn);
  if (!info) return false;
  const event = new CustomEvent(OPEN_CANVAS_EVENT, {
    bubbles: true,
    cancelable: true,
    detail: { code: info.code, language: info.language, title: info.title },
  });
  return !info.block.dispatchEvent(event);
}

/**
 * Shows or hides the preview of the button's block in the render frame. HTML previews start without
 * scripts; their "Run preview" button runs them.
 * @param {HTMLElement} btn
 * @returns {boolean} whether the preview is open now
 */
export function togglePreview(btn) {
  const info = codeBlockInfo(btn);
  const kind = info ? PREVIEW_LANGUAGES[info.language] : undefined;
  if (!info || !kind) return false;
  const open = previews.get(info.block);
  if (open) {
    open.destroy();
    previews.delete(info.block);
    info.block.querySelector(':scope > .code-preview')?.remove();
    btn.setAttribute('aria-expanded', 'false');
    btn.removeAttribute('aria-controls');
    return false;
  }
  const panel = document.createElement('div');
  panel.className = 'code-preview';
  panel.id = `code-preview-${++previewCount}`;
  const host = document.createElement('div');
  host.className = 'code-preview-frame';
  const note = document.createElement('p');
  note.className = 'code-preview-note';
  note.setAttribute('role', 'status');
  note.hidden = true;
  panel.append(host);
  if (kind === 'html') {
    const run = toolButton({ action: 'run-preview', icon: 'zap', label: 'chat.code.run_preview', aria: 'chat.code.run_preview_aria', className: 'code-run' });
    panel.append(run);
  }
  panel.append(note);
  info.block.append(panel);
  const frame = mountRenderFrame(host, {
    kind,
    source: info.code,
    title: t('chat.code.preview_title'),
    onError: (code) => {
      note.hidden = false;
      setText(note, code === 'diagram' ? 'chat.code.diagram_error' : 'chat.code.preview_error');
    },
  });
  frame.frame.setAttribute('data-i18n-title', 'chat.code.preview_title');
  previews.set(info.block, frame);
  btn.setAttribute('aria-expanded', 'true');
  btn.setAttribute('aria-controls', panel.id);
  refreshIcons(panel);
  return true;
}

/**
 * Runs the scripts of the open HTML preview the button belongs to (again, from the start).
 * @param {HTMLElement} btn
 * @returns {boolean}
 */
export function runPreview(btn) {
  const block = /** @type {HTMLElement | null} */ (btn.closest('.code-block'));
  const frame = block ? previews.get(block) : undefined;
  if (!frame) return false;
  frame.run();
  return true;
}

/**
 * Remembers the Markdown an answer was rendered from, so copyAnswer() can copy it exactly.
 * @param {Element} el  the message or its .message-content
 * @param {string} markdown
 */
export function setAnswerSource(el, markdown) {
  answerSources.set(el, String(markdown ?? ''));
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'DETAILS']);
/** Parts of a rendered answer that are not its text: tool bars, previews, frames. */
const SKIPPED = '.code-head, .code-preview, iframe, script, style, template';

/** @param {Element} el */
const isMath = (el) => el.classList.contains('math-inline') || el.classList.contains('math-display');

/** @param {Element} el */
function texOf(el) {
  return (el.getAttribute('data-tex') ?? el.textContent ?? '').trim();
}

/**
 * @param {string} text
 * @param {string} marker
 */
function wrapInline(text, marker) {
  const inner = text.trim();
  return inner ? text.replace(inner, `${marker}${inner}${marker}`) : text;
}

/**
 * The text of an inline node.
 * @param {Node} node
 * @param {boolean} md  Markdown (else plain text)
 * @returns {string}
 */
function inlineText(node, md) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (!(node instanceof Element) || node.matches(SKIPPED)) return '';
  if (isMath(node)) {
    const tex = texOf(node);
    if (!md) return tex;
    return node.classList.contains('math-display') ? `$$${tex}$$` : `$${tex}$`;
  }
  const inner = () => [...node.childNodes].map((child) => inlineText(child, md)).join('');
  switch (node.tagName) {
    case 'BR':
      return '\n';
    case 'BUTTON': {
      // A citation chip stands for its label; other buttons are tools.
      if (/** @type {HTMLElement} */ (node).dataset.action !== 'open-citation') return '';
      const doc = node.querySelector('.citation-chip-doc')?.textContent ?? '';
      const chunk = /\d+/.exec(node.querySelector('.citation-chip-num')?.textContent ?? '')?.[0];
      return doc && chunk ? citationLabel(doc, Number(chunk)) : (node.textContent ?? '');
    }
    case 'CODE': {
      const text = node.textContent ?? '';
      if (!md) return text;
      const ticks = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return ticks.length > 1 ? `${ticks} ${text} ${ticks}` : `\`${text}\``;
    }
    case 'STRONG':
    case 'B':
      return md ? wrapInline(inner(), '**') : inner();
    case 'EM':
    case 'I':
      return md ? wrapInline(inner(), '*') : inner();
    case 'DEL':
    case 'S':
      return md ? wrapInline(inner(), '~~') : inner();
    case 'A': {
      const href = node.getAttribute('href');
      const text = inner();
      return md && href ? `[${text}](${href})` : text;
    }
    default:
      return inner();
  }
}

/**
 * The blocks under parent, each as text; inline runs between block elements form paragraphs.
 * @param {Element} parent
 * @param {boolean} md
 * @returns {string[]}
 */
function blocksOf(parent, md) {
  /** @type {string[]} */
  const out = [];
  let run = '';
  const flush = () => {
    if (run.trim()) out.push(run.trim());
    run = '';
  };
  for (const child of parent.childNodes) {
    if (child instanceof Element && child.matches(SKIPPED)) continue;
    if (child instanceof Element && (BLOCK_TAGS.has(child.tagName) || (isMath(child) && child.tagName === 'DIV'))) {
      flush();
      const text = blockText(child, md);
      if (text) out.push(text);
    } else {
      run += inlineText(child, md);
    }
  }
  flush();
  return out;
}

/**
 * @param {string} text
 * @param {string} first  prefix of the first line
 * @param {string} rest   prefix of the other lines
 */
function prefixLines(text, first, rest) {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first : line ? rest : rest.trimEnd()) + line)
    .join('\n');
}

/**
 * @param {Element} el  a block element
 * @param {boolean} md
 * @returns {string}
 */
function blockText(el, md) {
  if (isMath(el)) return md ? `$$\n${texOf(el)}\n$$` : texOf(el);
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) {
    const text = inlineText(el, md).trim();
    return md ? `${'#'.repeat(Number(tag[1]))} ${text}` : text;
  }
  switch (tag) {
    case 'P':
      return inlineText(el, md).trim();
    case 'PRE': {
      const code = (el.textContent ?? '').replace(/\n$/, '');
      if (!md) return code;
      const language = /(?:^|\s)language-([\w#+.-]+)/.exec(el.querySelector('code')?.className ?? '')?.[1] ?? '';
      const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/^`{3,}/gm)].map((m) => m[0].length + 1)));
      return `${fence}${language}\n${code}\n${fence}`;
    }
    case 'UL':
    case 'OL': {
      const start = Number(el.getAttribute('start') ?? 1) || 1;
      return [...el.children]
        .filter((li) => li.tagName === 'LI')
        .map((li, i) => {
          const marker = tag === 'OL' ? `${start + i}. ` : '- ';
          return prefixLines(blocksOf(li, md).join('\n'), marker, ' '.repeat(marker.length));
        })
        .join('\n');
    }
    case 'BLOCKQUOTE': {
      const text = blocksOf(el, md).join('\n\n');
      return md ? prefixLines(text, '> ', '> ') : text;
    }
    case 'TABLE': {
      const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((cell) => inlineText(cell, md).trim().replace(/\n/g, ' ')));
      if (!md) return rows.map((row) => row.join('\t')).join('\n');
      if (rows.length === 0) return '';
      const line = (/** @type {string[]} */ row) => `| ${row.map((cell) => cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')).join(' | ')} |`;
      return [line(rows[0]), `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
    }
    case 'HR':
      return md ? '---' : '';
    default:
      return blocksOf(el, md).join('\n\n');
  }
}

/**
 * A rendered answer as plain text or Markdown, rebuilt from its DOM: paragraphs, headings, lists,
 * quotes, tables, code, math (as TeX) and citations (as their labels); tool bars and previews left
 * out.
 * @param {Element} content  the .message-content
 * @param {'text' | 'markdown'} format
 */
export function answerText(content, format) {
  return blocksOf(content, format === 'markdown')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Copies a whole answer. As Markdown it copies the source remembered by setAnswerSource() when there
 * is one, else the answer rebuilt from its DOM; as text, the rendered text.
 * @param {Element} messageEl  the message, or its .message-content
 * @param {{ format?: 'text' | 'markdown' }} [options]
 * @returns {Promise<boolean>} whether the text reached the clipboard
 */
export async function copyAnswer(messageEl, { format = 'text' } = {}) {
  const content = messageEl.classList.contains('message-content') ? messageEl : (messageEl.querySelector('.message-content') ?? messageEl);
  const source = answerSources.get(content) ?? answerSources.get(messageEl);
  const text = format === 'markdown' && source !== undefined ? source : answerText(content, format);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function initCodeBlocks() {
  onAction('copy-code', (el) => copyCodeBlock(el));
  onAction('download-code', (el) => downloadCodeBlock(el));
  onAction('canvas-code', (el) => openInCanvas(el));
  onAction('preview-code', (el) => togglePreview(el));
  onAction('run-preview', (el) => runPreview(el));
}
