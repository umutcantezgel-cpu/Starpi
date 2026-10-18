// @ts-check
// The provenance label of every answer, and what the checks after the stream add under it.
//
//   free      Free chat · not checked
//   grounded  Checked against your sources
//   mixed     Partly from sources (checked parts marked)
//   web       From the web · cited, not verified
//
// An embedding app passes its own wording per label (setAnswerLabelProfile): an i18n key of its
// own, or the text per language. While a grounded or mixed answer is checked after its stream, its
// label carries "checking…".
//
// Mixed answers get their checked parts marked (applyMixedMarks): every statement is compared with
// the excerpts it cites, and the list says which ones were found in the sources, which cite a
// source that does not hold them, and which are general knowledge (no source). Web answers get the
// outcome of the web check (rag/web-check.js) as one line under the label.
import { groundAnswer } from '../core/grounding.js';
import { getLocale, setText } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { blocksFromElement } from '../rag/grounding-view.js';
import { html, label as labelEl, provenanceBadge } from '../ui/kit.js';

/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../core/grounding.js').GroundingSource} GroundingSource */
/** @typedef {import('../core/grounding.js').GroundingReport} GroundingReport */
/** @typedef {import('../core/grounding.js').SentenceResult} SentenceResult */
/** @typedef {import('../rag/web-check.js').WebCheck} WebCheck */
/** @typedef {import('../ui/kit.js').Label} Label */
/** @typedef {'free' | 'grounded' | 'mixed' | 'web'} AnswerLabel */

/** The built-in labels: the provenance kind (colour and icon), the text and the tooltip. */
export const ANSWER_LABELS = Object.freeze({
  free: Object.freeze({ kind: /** @type {const} */ ('unchecked'), key: 'answers.label.free', hint: 'answers.label.hint_free' }),
  grounded: Object.freeze({ kind: /** @type {const} */ ('checked'), key: 'answers.label.grounded', hint: 'answers.label.hint_grounded' }),
  mixed: Object.freeze({ kind: /** @type {const} */ ('mixed'), key: 'answers.label.mixed', hint: 'answers.label.hint_mixed' }),
  web: Object.freeze({ kind: /** @type {const} */ ('web'), key: 'answers.label.web', hint: 'answers.label.hint_web' }),
});

/**
 * Wording an embedding app gives a label: an i18n key, or the text per language ("en", "de", …).
 * @typedef {string | Readonly<Record<string, string>>} LabelWording
 */

/** @type {Partial<Record<AnswerLabel, { text?: LabelWording, hint?: LabelWording }>>} */
let profile = {};

/**
 * Replaces the wording of labels (the others keep the built-in one). Returns a function that
 * restores the wording before.
 * @param {Partial<Record<AnswerLabel, { text?: LabelWording, hint?: LabelWording }>>} next
 */
export function setAnswerLabelProfile(next) {
  const before = profile;
  profile = { ...next };
  return () => {
    profile = before;
  };
}

/**
 * A wording as a kit Label.
 * @param {LabelWording | undefined} wording
 * @param {string} fallback  i18n key
 * @returns {Label}
 */
function asLabel(wording, fallback) {
  if (typeof wording === 'string' && wording) return wording;
  if (wording && typeof wording === 'object') {
    const lang = getLocale().slice(0, 2);
    const text = wording[lang] ?? wording.en ?? Object.values(wording)[0];
    if (typeof text === 'string' && text) return { text };
  }
  return fallback;
}

/**
 * The label of a stored answer: the one stored with it, else what its route and citations say.
 * @param {Pick<NodeRecord, 'label' | 'meta'>} node
 * @returns {AnswerLabel}
 */
export function answerLabelOf(node) {
  const meta = /** @type {Record<string, any>} */ (node.meta ?? {});
  if (typeof meta.answer_label === 'string' && Object.hasOwn(ANSWER_LABELS, meta.answer_label)) return /** @type {AnswerLabel} */ (meta.answer_label);
  if (node.label === 'mixed' || node.label === 'web') return node.label;
  if ((meta.chat_mode ?? node.label) === 'grounded') return 'grounded';
  return Array.isArray(meta.web_sources) && meta.web_sources.length ? 'web' : 'free';
}

/**
 * Shows the label of an answer at the top of its provenance slot (replacing one shown before).
 * @param {HTMLElement} messageEl
 * @param {AnswerLabel} name
 * @param {{ checking?: boolean }} [opts]  checking: the check after the stream is still running
 */
export function renderAnswerLabel(messageEl, name, opts = {}) {
  const slot = messageEl.querySelector('.message-provenance');
  if (!slot) return;
  slot.querySelector(':scope > .answer-label')?.remove();
  const def = ANSWER_LABELS[name] ?? ANSWER_LABELS.free;
  const own = profile[name];
  const row = document.createElement('p');
  row.className = 'answer-label mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500';
  row.dataset.answerLabel = name;
  row.insertAdjacentHTML('afterbegin', html`${provenanceBadge(def.kind, { label: asLabel(own?.text, def.key), hint: asLabel(own?.hint, def.hint) })}`.value);
  if (opts.checking) {
    row.dataset.checking = 'true';
    row.insertAdjacentHTML('beforeend', html`${labelEl('answers.label.checking', { className: 'answer-checking animate-pulse' })}`.value);
    row.setAttribute('aria-busy', 'true');
  }
  slot.prepend(row);
  refreshIcons(row);
}

/**
 * Shows the outcome of a web check under the label (replacing one shown before).
 * @param {HTMLElement} messageEl
 * @param {WebCheck | null} check
 */
export function renderWebCheck(messageEl, check) {
  const slot = messageEl.querySelector('.message-provenance');
  if (!slot || !check || check.kind === 'none') return;
  slot.querySelector(':scope > .web-check')?.remove();
  const line = document.createElement('p');
  line.className = 'web-check mt-1 text-[11px] text-slate-600';
  line.dataset.webCheck = check.kind;
  if (check.kind === 'checked') {
    if (check.total) setText(line, 'answers.web.checked', { ok: check.supported ?? 0, total: check.total });
    else setText(line, 'answers.web.checked_none');
  } else if (check.kind === 'segments') {
    if (check.flagged) setText(line, 'answers.web.segments_flagged', { n: check.flagged });
    else setText(line, 'answers.web.segments_ok');
  } else setText(line, 'answers.web.cited');
  const label = slot.querySelector(':scope > .answer-label');
  if (label) label.after(line);
  else slot.prepend(line);
}

/**
 * What a statement of a mixed answer is: found in the sources, citing a source that does not hold
 * it, or general knowledge (no source); null for statements that are not compared.
 * @param {SentenceResult} s
 * @returns {'from_sources' | 'cited_not_found' | 'not_in_sources' | null}
 */
export function mixedMark(s) {
  if (s.verdict === 'neutral' || s.verdict === 'unchecked') return null;
  if (s.verdict === 'supported') return 'from_sources';
  return s.cites.length ? 'cited_not_found' : 'not_in_sources';
}

/**
 * Marks the checked parts of a mixed answer: the source check runs on the rendered answer and a list
 * under it says, per statement, whether it was found in the sources. Replaces the provenance slot's
 * content (as the grounded source check does); returns the report for the receipt.
 * @param {HTMLElement} messageEl
 * @param {{ scope: string, sources: GroundingSource[], given?: string[] }} input
 * @returns {GroundingReport | null}
 */
export function applyMixedMarks(messageEl, input) {
  const content = /** @type {HTMLElement | null} */ (messageEl.querySelector('.message-content'));
  const slot = messageEl.querySelector('.message-provenance');
  if (!content || !slot || !input.sources.length) return null;
  const { blocks } = blocksFromElement(content, input.scope, input.sources);
  const report = groundAnswer(blocks, input.sources, { given: input.given });
  const marked = report.sentences.map((s) => ({ s, mark: mixedMark(s) })).filter((x) => x.mark);
  const found = marked.filter((x) => x.mark === 'from_sources').length;
  const wrong = marked.filter((x) => x.mark === 'cited_not_found').length;
  const details = document.createElement('details');
  details.className = `grounding-bar mixed-marks ${wrong ? 'grounding-review' : found ? 'grounding-partial' : 'grounding-none'}`;
  const summary = document.createElement('summary');
  const icon = document.createElement('i');
  icon.dataset.lucide = wrong ? 'shield-alert' : 'shield';
  icon.className = 'w-3.5 h-3.5 flex-shrink-0';
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'font-semibold';
  setText(title, 'answers.mixed.title');
  const counts = document.createElement('span');
  counts.className = 'grounding-counts';
  if (marked.length) setText(counts, 'answers.mixed.summary', { ok: found, total: marked.length });
  else setText(counts, 'answers.mixed.none');
  summary.append(icon, title, counts);
  details.append(summary);
  const body = document.createElement('div');
  body.className = 'grounding-body';
  if (marked.length) {
    const list = document.createElement('ol');
    list.className = 'grounding-list';
    for (const { s, mark } of marked) {
      const li = document.createElement('li');
      li.className = `grounding-item grounding-item-${mark === 'from_sources' ? 'supported' : mark === 'cited_not_found' ? 'unsupported' : 'weak'}`;
      li.dataset.mark = /** @type {string} */ (mark);
      const quote = document.createElement('p');
      quote.className = 'grounding-statement';
      setText(quote, 'grounding.statement', { text: s.text.length > 160 ? `${s.text.slice(0, 159)}…` : s.text });
      const tag = document.createElement('span');
      tag.className = `badge ${mark === 'from_sources' ? 'badge-muted' : mark === 'cited_not_found' ? 'badge-review' : 'badge-partial'}`;
      setText(tag, `answers.mixed.${mark}`);
      li.append(quote, tag);
      list.append(li);
    }
    body.append(list);
  }
  const note = document.createElement('p');
  note.className = 'grounding-note';
  setText(note, 'answers.mixed.note');
  body.append(note);
  details.append(body);
  slot.replaceChildren(details);
  if (wrong) details.open = true;
  refreshIcons(details);
  return report;
}

/** Lets the "checking…" label paint before a check that runs in one go. */
export function nextPaint() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
