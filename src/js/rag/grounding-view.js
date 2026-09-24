// @ts-check
// Source check in the chat: reads the rendered answer (text and citation buttons), runs the pure
// check from core/grounding.js and shows the result under the answer. The flagged statements list
// is the accessible channel; statements that need review are also highlighted in the text with the
// CSS Custom Highlight API where the browser supports it (no DOM changes, no inline styles).
import { refreshIcons } from '../icons.js';
import { formatNumber, setText } from '../i18n/index.js';
import { groundAnswer, resolveLabel } from '../core/grounding.js';
import { LOOSE_LABEL_PATTERN } from '../core/labels.js';
import { citationButton } from './citations.js';

/** @typedef {import('../core/grounding.js').Block} Block */
/** @typedef {import('../core/grounding.js').Segment} Segment */
/** @typedef {import('../core/grounding.js').GroundingSource} GroundingSource */
/** @typedef {import('../core/grounding.js').GroundingReport} GroundingReport */
/** @typedef {import('../core/grounding.js').SentenceResult} SentenceResult */
/** @typedef {{ node: Text, nodeOffset: number, from: number, to: number }} TextPiece */

const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, tr, blockquote, dd, dt';
const HIGHLIGHT_NAME = 'starpi-review';

/** @type {Highlight | null} */
let highlight = null;
let reportSeq = 0;

/** @param {Element} el */
function kindOf(el) {
  const tag = el.tagName;
  if (tag === 'P') return 'p';
  if (tag === 'LI') return 'li';
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'TR') return el.querySelector('td') ? 'row' : 'header-row';
  return 'other';
}

/**
 * Reads the answer DOM into blocks for the check, plus, per block, where each character of the
 * block text lives in the DOM (to highlight statements later).
 * @param {HTMLElement} root  the .message-content element
 * @param {string} scope      citation scope of this answer
 * @param {Array<{ doc: string, label: string }>} sources
 * @returns {{ blocks: Block[], pieces: TextPiece[][], elements: Element[], chips: Array<{ block: number, pos: number, el: HTMLElement }> }}
 */
export function blocksFromElement(root, scope, sources) {
  /** @type {Map<Element, number>} */
  const index = new Map();
  /** @type {Block[]} */
  const blocks = [];
  /** @type {TextPiece[][]} */
  const pieces = [];
  /** @type {Element[]} */
  const elements = [];
  /** @type {number[]} */
  const lengths = [];
  /** @type {Array<{ block: number, pos: number, el: HTMLElement }>} */
  const chips = [];

  /** @param {Node} node */
  const blockOf = (node) => {
    let el = node instanceof Element ? node : node.parentElement;
    while (el && el !== root && !el.matches(BLOCK_SELECTOR)) el = el.parentElement;
    const key = el && el !== root ? el : root;
    let b = index.get(key);
    if (b === undefined) {
      b = blocks.length;
      index.set(key, b);
      blocks.push({ kind: key === root ? 'other' : /** @type {Block['kind']} */ (kindOf(key)), segments: [], leadIn: null });
      pieces.push([]);
      elements.push(key);
      lengths.push(0);
    }
    return b;
  };

  /**
   * @param {number} b
   * @param {Segment} seg
   */
  const add = (b, seg) => {
    blocks[b].segments.push(seg);
    if (seg.type === 'text') lengths[b] += seg.text.length;
    else if (seg.type === 'break') lengths[b] += 1;
    else if (seg.type === 'sep') lengths[b] += 3;
  };

  /** @param {Text} node */
  const addText = (node) => {
    const value = node.nodeValue ?? '';
    if (!value) return;
    // Formatting whitespace between lists, tables and paragraphs belongs to no statement.
    if (!value.trim() && (node.parentElement === root || node.parentElement?.matches('ul, ol, table, thead, tbody, tfoot, tr'))) return;
    const b = blockOf(node);
    let last = 0;
    for (const m of value.matchAll(LOOSE_LABEL_PATTERN)) {
      const at = m.index ?? 0;
      if (at > last) {
        pieces[b].push({ node, nodeOffset: last, from: lengths[b], to: lengths[b] + at - last });
        add(b, { type: 'text', text: value.slice(last, at) });
      }
      add(b, { type: 'badcite', label: m[0], resolved: resolveLabel(m[0], sources) });
      last = at + m[0].length;
    }
    if (last < value.length) {
      pieces[b].push({ node, nodeOffset: last, from: lengths[b], to: lengths[b] + value.length - last });
      add(b, { type: 'text', text: value.slice(last) });
    }
  };

  /** @param {Node} node */
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      addText(/** @type {Text} */ (node));
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === 'PRE') return;
    if (node.tagName === 'BUTTON') {
      const el = /** @type {HTMLElement} */ (node);
      if (el.dataset.action === 'open-citation') {
        const [s, i] = (el.dataset.arg ?? '').split(':');
        if (s === scope && /^\d+$/.test(i ?? '')) {
          const b = blockOf(el);
          chips.push({ block: b, pos: lengths[b], el });
          add(b, { type: 'cite', index: Number(i) });
        }
      }
      return;
    }
    if (node.tagName === 'BR') {
      add(blockOf(node), { type: 'break' });
      return;
    }
    if ((node.tagName === 'TD' || node.tagName === 'TH') && node.previousElementSibling) add(blockOf(node), { type: 'sep' });
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);

  // A list introduced by "…:" (a paragraph or the enclosing list item) inherits its citations.
  blocks.forEach((block, b) => {
    const el = elements[b];
    if (block.kind !== 'li') return;
    const list = el.parentElement;
    const intro = list?.previousElementSibling ?? (list?.parentElement?.tagName === 'LI' ? list.parentElement : null);
    const introIndex = intro ? index.get(intro) : undefined;
    if (introIndex === undefined) return;
    const text = blocks[introIndex].segments.map((s) => (s.type === 'text' ? s.text : '')).join('');
    if (/:\s*$/.test(text)) block.leadIn = introIndex;
  });
  return { blocks, pieces, elements, chips };
}

/**
 * @param {TextPiece[]} pieces
 * @param {number} start
 * @param {number} end
 */
function rangeFor(pieces, start, end) {
  const first = pieces.find((p) => p.to > start);
  const last = [...pieces].reverse().find((p) => p.from < end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, first.nodeOffset + Math.max(0, start - first.from));
  range.setEnd(last.node, last.nodeOffset + Math.min(last.to, end) - last.from);
  return range;
}

function reviewHighlight() {
  if (highlight) return highlight;
  const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
  if (typeof Highlight !== 'function' || !registry) return null;
  highlight = new Highlight();
  registry.set(HIGHLIGHT_NAME, highlight);
  return highlight;
}

/** Removes every statement highlight (new chat, replayed history). */
export function clearGroundingHighlights() {
  highlight?.clear();
}

/**
 * @param {GroundingSource[]} sources
 * @param {number[] | undefined} list
 */
function labelsOf(sources, list) {
  return (list ?? []).map((i) => sources[i]?.label).filter(Boolean).join(', ') || '–';
}

/** @param {string | undefined} value */
function formatFound(value) {
  if (value === undefined) return '';
  return /^-?\d+(\.\d+)?$/.test(value) ? formatNumber(Number(value)) : value;
}

/**
 * @param {SentenceResult} s
 * @param {GroundingSource[]} sources
 * @param {string} scope
 * @param {string} id
 */
function flaggedItem(s, sources, scope, id) {
  const li = document.createElement('li');
  li.id = id;
  li.className = `grounding-item grounding-item-${s.verdict}`;
  const quote = document.createElement('p');
  quote.className = 'grounding-statement';
  setText(quote, 'grounding.statement', { text: s.text.length > 160 ? `${s.text.slice(0, 159)}…` : s.text });
  li.append(quote);
  for (const r of s.reasons) {
    const reason = document.createElement('p');
    reason.className = 'grounding-reason';
    setText(reason, `grounding.reason_${r.code}`, {
      fact: r.fact ?? '',
      label: labelsOf(sources, r.cites ?? s.cites),
      other: labelsOf(sources, r.other),
      found: formatFound(r.found),
    });
    li.append(reason);
  }
  const refs = [...new Set([...(s.cites ?? []), ...s.reasons.flatMap((r) => r.other ?? [])])].filter((i) => sources[i]);
  if (refs.length) {
    const row = document.createElement('div');
    row.className = 'grounding-refs';
    row.append(...refs.map((i) => citationButton(scope, i, 'badge')));
    li.append(row);
  }
  return li;
}

/**
 * Runs the source check on a rendered answer and shows the result.
 * @param {HTMLElement} messageEl  the message element returned by appendMessage / createStreamingMessage
 * @param {{ scope: string, sources: GroundingSource[], given?: string[], citedOnly?: boolean }} input
 * @returns {GroundingReport | null}
 */
export function applyGrounding(messageEl, input) {
  const content = /** @type {HTMLElement | null} */ (messageEl.querySelector('.message-content'));
  const slot = messageEl.querySelector('.message-provenance');
  if (!content || !slot || !input.sources.length) return null;
  const { blocks, pieces, chips } = blocksFromElement(content, input.scope, input.sources);
  const report = groundAnswer(blocks, input.sources, { given: input.given, citedOnly: input.citedOnly });
  const { supported, weak, unsupported, unchecked } = report.counts;
  const total = supported + weak + unsupported;
  if (!total && !unchecked && !report.skipped) return report;

  const run = `grd-${++reportSeq}`;
  const details = document.createElement('details');
  details.className = `grounding-bar ${unsupported ? 'grounding-review' : weak ? 'grounding-partial' : 'grounding-ok'}`;
  const summary = document.createElement('summary');
  const icon = document.createElement('i');
  icon.dataset.lucide = unsupported ? 'shield-alert' : weak ? 'shield-question-mark' : 'shield-check';
  icon.className = 'w-3.5 h-3.5 flex-shrink-0';
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'font-semibold';
  setText(title, 'grounding.title');
  const counts = document.createElement('span');
  counts.className = 'grounding-counts';
  if (report.skipped) setText(counts, 'grounding.too_long');
  else if (total) setText(counts, 'grounding.summary', { ok: supported, total });
  else setText(counts, 'grounding.only_unchecked');
  summary.append(icon, title, counts);
  for (const [n, key, cls] of /** @type {Array<[number, string, string]>} */ ([
    [unsupported, 'grounding.review', 'badge-review'],
    [weak, 'grounding.partial', 'badge-partial'],
  ])) {
    if (!n) continue;
    const badge = document.createElement('span');
    badge.className = `badge ${cls}`;
    setText(badge, key, { n });
    summary.append(badge);
  }
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'grounding-body';
  const flagged = report.sentences
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.verdict === 'unsupported' || s.verdict === 'weak')
    .sort((a, b) => (a.s.verdict === b.s.verdict ? a.i - b.i : a.s.verdict === 'unsupported' ? -1 : 1));
  if (flagged.length) {
    const list = document.createElement('ol');
    list.className = 'grounding-list';
    for (const { s, i } of flagged) list.append(flaggedItem(s, input.sources, input.scope, `${run}-${i}`));
    body.append(list);
  }
  if (unchecked) {
    const note = document.createElement('p');
    note.className = 'grounding-note';
    setText(note, 'grounding.unchecked', { n: unchecked });
    body.append(note);
  }
  const disclaimer = document.createElement('p');
  disclaimer.className = 'grounding-note';
  setText(disclaimer, 'grounding.disclaimer');
  body.append(disclaimer);
  details.append(body);
  slot.replaceChildren(details);
  if (unsupported) details.open = true;

  // Flag the citation buttons that belong to statements needing review (a button belongs to the
  // last statement of its block that starts before it, as in the check), and highlight the statements.
  for (const chip of chips) {
    let owner = -1;
    report.sentences.forEach((s, i) => {
      if (s.block === chip.block && (owner === -1 || s.start < chip.pos)) owner = i;
    });
    if (owner >= 0 && report.sentences[owner].verdict === 'unsupported') {
      chip.el.classList.add('citation-chip-flag');
      chip.el.setAttribute('aria-describedby', `${run}-${owner}`);
    }
  }
  const marks = reviewHighlight();
  report.sentences.forEach((s) => {
    if (s.verdict !== 'unsupported' || !marks) return;
    const range = rangeFor(pieces[s.block], s.start, s.end);
    if (range) marks.add(range);
  });
  refreshIcons(details);
  return report;
}
