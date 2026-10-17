// @ts-check
// Source check in the chat: reads the rendered answer (text and citation buttons), runs the pure
// check from core/grounding.js and shows the result under the answer. The flagged statements list
// is the accessible channel; statements that need review are also highlighted in the text with the
// CSS Custom Highlight API where the browser supports it (no DOM changes, no inline styles).
//
// Version 3 of the check also compares relations (changes, comparisons, orders in time, values
// carried over from the statement before); a relation the excerpts give the other way round is a
// reason of its statement, and a note counts the relations compared. Weak statements can get an
// advisory second opinion (core/entail.js) on request: from the entailment model on this device
// (wasm/nli.js, downloaded only after that click) or from the AI judge. It is shown next to the
// statement, recorded in the report (report.secondOpinion, which the receipt takes) and never
// changes a verdict.
import { refreshIcons } from '../icons.js';
import { formatNumber, setText, t } from '../i18n/index.js';
import { eligible, judgeResult, opinionReason, secondOpinions, shownVerdict } from '../core/entail.js';
import { groundAnswer, resolveLabel } from '../core/grounding.js';
import { LOOSE_LABEL_PATTERN } from '../core/labels.js';
import { citationButton } from './citations.js';

/** @typedef {import('../core/grounding.js').Block} Block */
/** @typedef {import('../core/grounding.js').Segment} Segment */
/** @typedef {import('../core/grounding.js').GroundingSource} GroundingSource */
/** @typedef {import('../core/grounding.js').GroundingReport} GroundingReport */
/** @typedef {import('../core/grounding.js').SentenceResult} SentenceResult */
/** @typedef {import('../core/grounding.js').SecondOpinion} SecondOpinion */
/** @typedef {import('../core/entail.js').OpinionEngine} OpinionEngine */
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
    // Typeset math: the check reads the TeX it was typeset from (as before typesetting), not the
    // MathML. It has no text node to highlight, so it takes part in the check only.
    if (node.classList.contains('math-rendered')) {
      const tex = node.getAttribute('data-tex') ?? '';
      if (tex) add(blockOf(node), { type: 'text', text: tex });
      return;
    }
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
    // A loose list (items separated by blank lines) puts each item's text in a <p> inside the <li>.
    const el = block.kind === 'li' ? elements[b] : block.kind === 'p' && elements[b].parentElement?.tagName === 'LI' ? elements[b].parentElement : null;
    if (!el || (el !== elements[b] && el.firstElementChild !== elements[b])) return;
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
  // Nothing compared (too long, or facts-only across languages without facts): no green "ok".
  const compared = total > 0 && !report.skipped;
  details.className = `grounding-bar ${unsupported ? 'grounding-review' : weak ? 'grounding-partial' : compared ? 'grounding-ok' : 'grounding-none'}`;
  const summary = document.createElement('summary');
  const icon = document.createElement('i');
  icon.dataset.lucide = unsupported ? 'shield-alert' : weak ? 'shield-question-mark' : compared ? 'shield-check' : 'shield';
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
  if (report.relations?.length) {
    const note = document.createElement('p');
    note.className = 'grounding-note';
    setText(note, 'grounding.relations', { n: report.relations.length, flagged: report.relations.filter((r) => r.verdict !== 'supported').length });
    body.append(note);
  }
  if (unchecked) {
    const note = document.createElement('p');
    note.className = 'grounding-note';
    setText(note, 'grounding.unchecked', { n: unchecked });
    body.append(note);
  }
  if (report.sentences.some((s) => eligible(s, input.sources))) body.append(secondOpinionPanel(report, input, run, details));
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

/**
 * The AI judge as a second-opinion engine: the purpose `entail_check` on the judge role, or null
 * when no model for it is set up. The AI layer loads on first use.
 * @returns {Promise<OpinionEngine | null>}
 */
async function judgeEngine() {
  const [{ planChain, routerDeps, runPurpose }, { getPurpose }] = await Promise.all([import('../ai/router.js'), import('../ai/purposes.js')]);
  const def = getPurpose('entail_check');
  if (!def || planChain(def, {}, routerDeps()).length === 0) return null;
  let model = 'judge';
  return {
    id: 'judge',
    get model() {
      return model;
    },
    classify: async (pairs, onProgress) => {
      /** @type {Array<import('../core/entail.js').OpinionResult | null>} */
      const out = [];
      for (const [k, pair] of pairs.entries()) {
        const res = await runPurpose('entail_check', { claim: pair.hypothesis, evidence: pair.premise }, { cache: 'off' });
        out.push(res.ok ? judgeResult(res.value) : null);
        if (res.ok && res.provider && res.model) model = `${res.provider}:${res.model}`;
        onProgress?.(k + 1, pairs.length);
      }
      return out;
    },
  };
}

/**
 * Shows one second opinion at its statement: a line in the flagged item (replacing an earlier one
 * of the same engine), and the item's colour as shownVerdict gives it (never better than before).
 * @param {HTMLElement} details
 * @param {GroundingReport} report
 * @param {GroundingSource[]} sources
 * @param {string} run
 * @param {SecondOpinion} opinion
 */
function showOpinion(details, report, sources, run, opinion) {
  const li = details.querySelector(`#${run}-${opinion.sentence}`);
  if (!li) return;
  li.querySelector(`[data-opinion="${opinion.engine}"]`)?.remove();
  const line = document.createElement('p');
  line.className = 'grounding-reason grounding-opinion';
  line.dataset.opinion = opinion.engine;
  line.dataset.result = opinion.result;
  const engine = t(`grounding.second_engine_${opinion.engine}`);
  const reason = opinionReason(opinion);
  if (reason) setText(line, `grounding.reason_${reason.code}`, { engine, label: labelsOf(sources, reason.cites) });
  else setText(line, `grounding.second_result_${opinion.result}`, { engine });
  li.append(line);
  const verdict = shownVerdict(report.sentences[opinion.sentence].verdict, opinion.result);
  li.className = `grounding-item grounding-item-${verdict}`;
}

/**
 * The second-opinion controls under a report with weak statements: what it is, and one button per
 * engine. Nothing runs, and nothing downloads, before a button is pressed.
 * @param {GroundingReport} report
 * @param {{ scope: string, sources: GroundingSource[] }} input
 * @param {string} run
 * @param {HTMLElement} details
 */
function secondOpinionPanel(report, input, run, details) {
  const box = document.createElement('div');
  box.className = 'grounding-second space-y-1.5 border-t border-slate-200 pt-2';
  const title = document.createElement('p');
  title.className = 'font-semibold text-slate-800';
  setText(title, 'grounding.second_title');
  const intro = document.createElement('p');
  intro.className = 'grounding-note';
  setText(intro, 'grounding.second_intro');
  const row = document.createElement('div');
  row.className = 'flex flex-wrap gap-1.5';
  const status = document.createElement('p');
  status.className = 'grounding-note';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  /** @type {HTMLButtonElement[]} */
  const buttons = [];
  const button = (/** @type {'nli' | 'judge'} */ engine) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost px-2 py-1 text-[11px]';
    b.dataset.secondOpinion = engine;
    b.addEventListener('click', () => void start(engine));
    buttons.push(b);
    row.append(b);
    return b;
  };

  /** @param {'nli' | 'judge'} engineId */
  const start = async (engineId) => {
    for (const b of buttons) b.disabled = true;
    const total = report.sentences.filter((s) => eligible(s, input.sources)).length;
    setText(status, 'grounding.second_running', { done: 0, total });
    /** @type {(() => void) | null} */
    let stopWatching = null;
    try {
      /** @type {OpinionEngine | null} */
      let engine;
      if (engineId === 'nli') {
        const nli = await import('../wasm/nli.js');
        stopWatching = nli.onNliChange((st) => {
          if (st.phase === 'loading') setText(status, 'grounding.second_loading', { percent: formatNumber(Math.round(st.progress * 100)) });
        });
        // The click on the button that names the download size is the consent to download.
        engine = nli.nliEngine({ consent: true });
      } else engine = await judgeEngine();
      if (!engine) {
        setText(status, 'grounding.second_unavailable');
        return;
      }
      const opinions = await secondOpinions(report, input.sources, engine, { onProgress: (done, n) => setText(status, 'grounding.second_running', { done, total: n }) });
      const kept = (report.secondOpinion ?? []).filter((o) => !opinions.some((n) => n.engine === o.engine && n.sentence === o.sentence));
      report.secondOpinion = [...kept, ...opinions];
      for (const o of opinions) showOpinion(details, report, input.sources, run, o);
      setText(status, 'grounding.second_done', { n: opinions.length, engine: t(`grounding.second_engine_${engine.id}`) });
    } catch (err) {
      setText(status, 'grounding.second_failed', { reason: err instanceof Error ? err.message : String(err) });
    } finally {
      stopWatching?.();
      for (const b of buttons) b.disabled = false;
    }
  };

  const nliButton = button('nli');
  nliButton.hidden = true;
  setText(button('judge'), 'grounding.second_judge');
  void import('../wasm/nli.js').then(async (nli) => {
    if (!nli.nliAvailable()) return;
    const stored = await nli.nliModelStored();
    if (stored === 'full') setText(nliButton, 'grounding.second_nli_stored');
    else setText(nliButton, 'grounding.second_nli', { size: formatNumber(nli.nliModel().approxDownloadMB) });
    nliButton.hidden = false;
  });
  box.append(title, intro, row, status);
  return box;
}
