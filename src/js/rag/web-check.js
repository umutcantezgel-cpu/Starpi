// @ts-check
// The check of a free answer that searched the web. What can be checked depends on what the
// provider hands back with its citations (the AI layer normalises them to { url, title, citedText?,
// start?, end? }):
//
//   checked   the provider quotes the text of the page each citation rests on (Anthropic's
//             cited_text): the answer goes through the full source check (core/grounding.js
//             groundAnswer) against those quotes, each page as one excerpt.
//   segments  the provider marks which parts of the answer rest on which page, without the page's
//             text (Gemini's grounding supports; their text is the answer's own): the sentence gate in
//             web mode (core/gate.js) checks that every number lies inside such a part.
//   cited     pages are named and nothing more: the answer is labelled "cited, not checked".
//   none      no web page at all.
//
// The server never fetches a page for this, so nothing here reaches out to the web.
//
// Pure: no DOM, runs in the browser and in Node.
import { checkText } from '../core/gate.js';
import { blocksFromMarkdown, groundAnswer } from '../core/grounding.js';
import { citationLabel } from '../core/labels.js';

/** @typedef {import('../ai/index.js').CompletionResult} CompletionResult */
/** @typedef {CompletionResult['citations'][number]} WebCitation */
/** @typedef {'checked' | 'segments' | 'cited' | 'none'} WebCheckKind */

/**
 * The outcome of a web check, small enough to be stored with the answer.
 * @typedef {object} WebCheck
 * @property {WebCheckKind} kind
 * @property {number} pages        distinct http(s) pages cited
 * @property {number} [supported]  checked: statements found in the cited text
 * @property {number} [flagged]    checked: statements not or only partly found; segments: sentences withheld by the gate
 * @property {number} [total]      checked: statements compared; segments: sentences judged
 */

/** Longest quoted text of one page that is compared (the check's own limit is the answer's length). */
const PAGE_CHARS = 20_000;

const HTTP = /^https?:\/\//i;

/**
 * @param {readonly WebCitation[]} citations
 */
const webCitations = (citations) => citations.filter((c) => c && typeof c.url === 'string' && HTTP.test(c.url));

/**
 * What can be checked of an answer with these citations from this provider.
 * @param {string} provider
 * @param {readonly WebCitation[]} citations
 * @returns {WebCheckKind}
 */
export function webCheckKind(provider, citations) {
  const web = webCitations(citations);
  if (!web.length) return 'none';
  if (provider === 'anthropic' && web.some((c) => typeof c.citedText === 'string' && c.citedText.trim())) return 'checked';
  if (provider === 'gemini' && web.some((c) => typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start)) return 'segments';
  return 'cited';
}

/**
 * The cited pages as excerpts for the source check: one per page, its quotes joined, under a label
 * of the canonical shape (only the check sees it).
 * @param {readonly WebCitation[]} citations
 */
export function pageSources(citations) {
  /** @type {Map<string, { label: string, doc: string, heading: string, text: string, delivered: 'full' }>} */
  const pages = new Map();
  for (const c of webCitations(citations)) {
    const quote = typeof c.citedText === 'string' ? c.citedText.trim() : '';
    let page = pages.get(c.url);
    if (!page) {
      let name = c.title?.trim() || c.url;
      if (!c.title?.trim()) {
        try {
          name = new URL(c.url).host;
        } catch {
          // keep the address
        }
      }
      page = { label: citationLabel(name, pages.size + 1), doc: name, heading: '', text: '', delivered: 'full' };
      pages.set(c.url, page);
    }
    if (quote && !page.text.includes(quote) && page.text.length < PAGE_CHARS) page.text = `${page.text}${page.text ? '\n' : ''}${quote}`.slice(0, PAGE_CHARS);
  }
  return pages;
}

/**
 * The answer with each citation's label at the end of the text it backs (before trailing white
 * space, so the label stays with its last sentence).
 * @param {string} text
 * @param {readonly WebCitation[]} citations
 * @param {Map<string, { label: string }>} pages
 */
export function labelledAnswer(text, citations, pages) {
  /** @type {Map<number, string[]>} */
  const at = new Map();
  for (const c of webCitations(citations)) {
    const page = pages.get(c.url);
    if (!page || typeof c.end !== 'number') continue;
    let end = Math.min(Math.max(0, c.end), text.length);
    while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
    const list = at.get(end) ?? [];
    if (!list.includes(page.label)) list.push(page.label);
    at.set(end, list);
  }
  let out = text;
  for (const end of [...at.keys()].sort((a, b) => b - a)) out = `${out.slice(0, end)} ${(at.get(end) ?? []).join(' ')}${out.slice(end)}`;
  return out;
}

/**
 * Where the answer is grounded, in the gate's shape (segments of the answer and their pages).
 * @param {readonly WebCitation[]} citations
 * @returns {import('../core/gate.js').GateGrounding}
 */
export function gateGrounding(citations) {
  /** @type {import('../core/gate.js').GateGrounding['sources']} */
  const sources = [];
  /** @type {import('../core/gate.js').GateGrounding['segments']} */
  const segments = [];
  for (const c of webCitations(citations)) {
    let i = sources.findIndex((s) => s.uri === c.url);
    if (i < 0) i = sources.push({ uri: c.url, ...(c.title ? { title: c.title } : {}) }) - 1;
    if (typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start) segments.push({ start: c.start, end: c.end, sources: [i] });
  }
  return { segments, sources };
}

/**
 * Checks a free answer that cites web pages, as far as its citations allow.
 * @param {{ text: string, provider: string, citations: readonly WebCitation[], question?: string, locale?: string | null }} input
 * @returns {WebCheck}
 */
export function checkWebAnswer(input) {
  const kind = webCheckKind(input.provider, input.citations);
  const pages = pageSources(input.citations);
  if (kind === 'checked') {
    const sources = [...pages.values()];
    const marked = labelledAnswer(input.text, input.citations, pages);
    const report = groundAnswer(blocksFromMarkdown(marked, sources), sources, { given: input.question ? [input.question] : [] });
    const { supported, weak, unsupported } = report.counts;
    return { kind, pages: pages.size, supported, flagged: weak + unsupported, total: supported + weak + unsupported };
  }
  if (kind === 'segments') {
    const r = checkText(input.text, { mode: 'web', grounding: gateGrounding(input.citations), question: input.question, locale: input.locale ?? null });
    return { kind, pages: pages.size, flagged: r.counts.withheld, total: r.counts.released + r.counts.withheld };
  }
  return { kind, pages: pages.size };
}

/**
 * A stored web check as read back (null for anything else).
 * @param {unknown} value
 * @returns {WebCheck | null}
 */
export function readWebCheck(value) {
  const v = /** @type {Record<string, unknown> | null} */ (value && typeof value === 'object' ? value : null);
  if (!v || !['checked', 'segments', 'cited', 'none'].includes(String(v.kind))) return null;
  const count = (/** @type {unknown} */ n) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined);
  /** @type {WebCheck} */
  const out = { kind: /** @type {WebCheckKind} */ (v.kind), pages: count(v.pages) ?? 0 };
  for (const key of /** @type {const} */ (['supported', 'flagged', 'total'])) {
    const n = count(v[key]);
    if (n !== undefined) out[key] = n;
  }
  return out;
}
