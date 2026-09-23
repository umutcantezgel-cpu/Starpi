// @ts-check
// Verifiable citations. Every answer registers the exact excerpts it was given; only labels that
// match one of those excerpts become clickable. Buttons are built with DOM APIs (never from model
// output), and the drawer shows the cited chunk highlighted inside its source text.
import { byId, onAction, setHidden } from '../dom.js';
import { refreshIcons } from '../icons.js';
import { formatNumber, setText, t } from '../i18n/index.js';
import { CITATION_PATTERN, citationLabel } from '../retrieval.js';
import { getChunkContext } from './workspace.js';

/** @typedef {import('../retrieval.js').Citation} Citation */

const MAX_SCOPES = 200;
/** @type {Map<string, Citation[]>} */
const scopes = new Map();
let scopeSeq = 0;

/**
 * Stores the citations of one answer and returns their scope id (null when there are none).
 * @param {Citation[]} citations
 */
export function registerCitations(citations) {
  if (!citations.length) return null;
  const id = `c${++scopeSeq}`;
  scopes.set(id, citations);
  if (scopes.size > MAX_SCOPES) scopes.delete(/** @type {string} */ (scopes.keys().next().value));
  return id;
}

/**
 * @param {string} scope
 * @param {string} doc
 * @param {number} chunk
 */
function findIndex(scope, doc, chunk) {
  const list = scopes.get(scope) ?? [];
  const label = citationLabel(doc, chunk);
  return list.findIndex((c) => c.label === label);
}

/**
 * @param {string} scope
 * @param {number} index
 * @param {'inline' | 'badge'} variant
 */
export function citationButton(scope, index, variant) {
  const c = /** @type {Citation} */ (scopes.get(scope)?.[index]);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.action = 'open-citation';
  btn.dataset.arg = `${scope}:${index}`;
  btn.className = variant === 'inline' ? 'citation-chip' : 'citation-chip citation-chip-lg';
  btn.setAttribute('data-i18n-aria', 'citation.open');
  btn.setAttribute('data-i18n-params', JSON.stringify({ doc: c.doc, chunk: c.chunk }));
  btn.setAttribute('aria-label', t('citation.open', { doc: c.doc, chunk: c.chunk }));
  const icon = document.createElement('i');
  icon.dataset.lucide = c.source === 'workspace' ? 'file-text' : 'database';
  icon.className = 'w-3 h-3';
  const label = document.createElement('span');
  label.textContent = `${c.doc} · ${c.chunk}`;
  btn.append(icon, label);
  return btn;
}

/**
 * Replaces citation labels in text nodes under root with buttons, for labels registered in scope.
 * Unknown labels stay plain text, so a model cannot fabricate a clickable source.
 * @param {HTMLElement} root
 * @param {string | null} scope
 */
export function linkifyCitations(root, scope) {
  if (!scope || !scopes.has(scope)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('code, pre, button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  /** @type {Text[]} */
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.nodeValue ?? '').includes('[Doc:')) nodes.push(/** @type {Text} */ (n));
  }
  for (const node of nodes) {
    const value = node.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let last = 0;
    let changed = false;
    for (const m of value.matchAll(CITATION_PATTERN)) {
      const index = findIndex(scope, m[1], Number(m[2]));
      if (index === -1) continue;
      const at = m.index ?? 0;
      if (at > last) frag.append(value.slice(last, at));
      frag.append(citationButton(scope, index, 'inline'));
      last = at + m[0].length;
      changed = true;
    }
    if (!changed) continue;
    if (last < value.length) frag.append(value.slice(last));
    node.replaceWith(frag);
  }
  refreshIcons(root);
}

/**
 * "Sources" row listing every excerpt the answer was based on.
 * @param {string | null} scope
 * @returns {HTMLElement | null}
 */
export function citationSources(scope) {
  const list = scope ? scopes.get(scope) : undefined;
  if (!scope || !list?.length) return null;
  const row = document.createElement('div');
  row.className = 'mt-3 pt-2.5 border-t border-slate-200 flex flex-wrap items-center gap-1.5';
  const label = document.createElement('span');
  label.className = 'text-[11px] font-medium text-slate-500 mr-1';
  setText(label, 'chat.sources');
  row.append(label, ...list.map((_, i) => citationButton(scope, i, 'badge')));
  refreshIcons(row);
  return row;
}

/**
 * @param {HTMLElement} el
 * @param {{ before: string, match: string, after: string, cutStart: boolean, cutEnd: boolean }} parts
 */
function renderHighlighted(el, parts) {
  const mark = document.createElement('mark');
  mark.className = 'citation-mark';
  mark.textContent = parts.match;
  const pre = document.createElement('span');
  pre.className = 'text-slate-500';
  pre.textContent = `${parts.cutStart ? '…' : ''}${parts.before}`;
  const post = document.createElement('span');
  post.className = 'text-slate-500';
  post.textContent = `${parts.after}${parts.cutEnd ? '…' : ''}`;
  el.replaceChildren(pre, mark, post);
  mark.scrollIntoView?.({ block: 'center' });
}

/** @type {HTMLElement | null} */
let lastTrigger = null;

/**
 * @param {string} arg "<scope>:<index>"
 * @param {HTMLElement} trigger
 */
async function openCitation(arg, trigger) {
  const [scope, rawIndex] = arg.split(':');
  const c = scopes.get(scope)?.[Number(rawIndex)];
  const modal = byId('citationModal');
  const content = byId('citationModalContent');
  if (!c || !modal || !content) return;
  lastTrigger = trigger;

  const docEl = byId('citationModalDoc');
  if (docEl) docEl.textContent = c.doc;
  setText(byId('citationModalSource'), c.source === 'workspace' ? 'citation.source_workspace' : 'citation.source_knowledge');
  const chunkEl = byId('citationModalChunkIdx');
  if (chunkEl) chunkEl.textContent = String(c.chunk);
  const scoreEl = byId('citationModalScore');
  if (scoreEl) scoreEl.textContent = c.score === null ? '–' : formatNumber(c.score, { maximumFractionDigits: 3 });
  setText(byId('citationModalScoreLabel'), c.source === 'workspace' ? 'citation.score_bm25' : 'citation.score_rank');
  const offsets = byId('citationModalOffsets');
  if (offsets) offsets.textContent = c.span ? `${formatNumber(c.span.start)}–${formatNumber(c.span.end)}` : '–';
  const note = byId('citationModalNote');

  renderHighlighted(content, { before: '', match: c.text, after: '', cutStart: false, cutEnd: false });
  setText(note, c.source === 'workspace' ? 'citation.loading_context' : 'citation.note_knowledge');
  setHidden(modal, false);
  /** @type {HTMLElement | null} */ (modal.querySelector('[data-action="close-citation"]'))?.focus();

  if (c.span) {
    try {
      const ctx = await getChunkContext(c.span.docId, c.span.start, c.span.end);
      renderHighlighted(content, {
        before: ctx.before,
        match: ctx.match,
        after: ctx.after,
        cutStart: ctx.start - ctx.before.length > 0,
        cutEnd: ctx.end + ctx.after.length < ctx.length,
      });
      setText(note, 'citation.note_workspace', { length: formatNumber(ctx.length) });
    } catch {
      setText(note, 'citation.note_missing');
    }
  }
}

function closeCitation() {
  const modal = byId('citationModal');
  if (!modal || modal.classList.contains('hidden')) return;
  setHidden(modal, true);
  lastTrigger?.focus();
  lastTrigger = null;
}

export function initCitations() {
  onAction('open-citation', (el) => openCitation(el.dataset.arg ?? '', el));
  onAction('close-citation', () => closeCitation());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCitation();
  });
}
