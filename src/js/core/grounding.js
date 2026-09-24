// @ts-check
// Source check: compares every statement of an answer with the excerpts it cites. It looks for the
// numbers, dates, times, weekdays, months, codes and quotations a statement contains in the cited
// excerpts, and measures word overlap between the two. It is a deterministic heuristic, not a
// second model: a match does not prove a statement correct, but a flag always names what is missing
// ("520,000 is not in [Doc: plan.pdf, Chunk: 1]"), so the reader knows exactly what to check.
//
// Input is the rendered answer as blocks of text and citation markers (see grounding-view.js for
// the DOM side, blocksFromMarkdown() for plain text) plus the excerpts, index-aligned with the
// citation markers. Pure: no DOM, runs in the browser, in workers and in Node.
import { contentTokens, extractFacts, guessLanguage, indexSource, lookupFact, tokenMatches } from './facts.js';
import { CITATION_PATTERN, LOOSE_LABEL_PATTERN, parseLabel } from './labels.js';
import { sentenceSpans } from './sentences.js';

export const GROUNDING = Object.freeze({ id: 'starpi-grounding', version: 1 });

export const THRESHOLDS = Object.freeze({
  /** share of a statement's content words that must appear in its cited excerpts */
  supportedOverlap: 0.5,
  /** below this many content words, overlap is not measured */
  minContentTokens: 3,
  /** relative distance for "about 480,000" */
  approxTolerance: 0.05,
  maxSentences: 300,
  maxChars: 20_000,
});

/**
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'cite', index: number }
 *   | { type: 'badcite', label: string, resolved: number | null }
 *   | { type: 'break' }
 *   | { type: 'sep' }} Segment
 */

/**
 * @typedef {object} Block
 * @property {'p' | 'li' | 'heading' | 'row' | 'header-row' | 'other'} kind
 * @property {Segment[]} segments
 * @property {number | null} leadIn  index of the block that introduces this list item ("…:"), if any
 */

/**
 * @typedef {object} GroundingSource
 * @property {string} label
 * @property {string} doc
 * @property {string} heading
 * @property {string} text       the excerpt text that was delivered to the model
 * @property {'full' | 'partial' | 'omitted'} delivered
 */

/** @typedef {'supported' | 'weak' | 'unsupported' | 'unchecked' | 'neutral'} Verdict */

/**
 * @typedef {'missing_fact' | 'fact_elsewhere' | 'uncited_found' | 'uncited_missing' | 'low_overlap'
 *   | 'unknown_citation' | 'label_mismatch' | 'quote_missing' | 'approximate' | 'from_conversation'
 *   | 'not_delivered'} ReasonCode
 */

/**
 * @typedef {object} Reason
 * @property {ReasonCode} code
 * @property {'weak' | 'unsupported'} level
 * @property {string} [fact]     the fact as written in the answer
 * @property {number[]} [cites]  source indexes cited by the statement
 * @property {number[]} [other]  source indexes that do contain the fact
 * @property {string} [found]    what the source says instead, or the offending label
 */

/**
 * @typedef {object} SentenceResult
 * @property {number} block
 * @property {number} start       offset in the block text
 * @property {number} end
 * @property {string} text
 * @property {number[]} cites     source indexes (own or inherited)
 * @property {'own' | 'block' | 'leadin' | 'answer' | null} citeSource
 * @property {Verdict} verdict
 * @property {Reason[]} reasons
 * @property {number | null} overlap
 * @property {boolean} crossLanguage  compared by facts only: the statement and its excerpts are in different languages
 */

/**
 * @typedef {object} GroundingReport
 * @property {{ id: string, version: number }} algorithm
 * @property {SentenceResult[]} sentences
 * @property {{ supported: number, weak: number, unsupported: number, unchecked: number }} counts
 * @property {boolean} crossLanguage  some statements were compared by facts only (answer and excerpt in different languages)
 * @property {null | 'too_long'} skipped
 */

/**
 * @typedef {object} Draft
 * @property {number} block
 * @property {Block['kind']} kind
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {number[]} own
 * @property {Array<{ label: string, resolved: number | null }>} bad
 */

/**
 * Text of a block with the position of every citation marker. Markers take no space.
 * @param {Block} block
 */
function flatten(block) {
  let text = '';
  /** @type {Array<{ pos: number, index: number }>} */
  const cites = [];
  /** @type {Array<{ pos: number, label: string, resolved: number | null }>} */
  const bad = [];
  for (const seg of block.segments) {
    if (seg.type === 'text') text += seg.text;
    else if (seg.type === 'break') text += '\n';
    else if (seg.type === 'sep') text += ' | ';
    else if (seg.type === 'cite') cites.push({ pos: text.length, index: seg.index });
    else bad.push({ pos: text.length, label: seg.label, resolved: seg.resolved });
  }
  return { text, cites, bad };
}

/**
 * The sentence a marker at `pos` belongs to: the last sentence that starts before it. A marker right
 * after a sentence's final punctuation ("… EUR. [Doc…] Next") belongs to that sentence.
 * @param {Array<{ start: number, end: number }>} spans
 * @param {number} pos
 */
function owner(spans, pos) {
  let found = 0;
  spans.forEach((s, i) => {
    if (s.start < pos) found = i;
  });
  return found;
}

/**
 * Whether a block states nothing (only markers, punctuation and words like "Sources:").
 * @param {string} text
 */
function isContentless(text) {
  return contentTokens(text).length === 0 && extractFacts(text).length === 0;
}

/**
 * A statement as shown in the report: markers removed, whitespace collapsed, no space before
 * punctuation that a removed marker left behind.
 * @param {string} text
 */
function readable(text) {
  return text.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

/**
 * Splits blocks into sentences and links citation markers to them, including inheritance: a
 * statement without its own marker inherits the nearest cited statement of its block, then the
 * markers of the block that introduces its list ("According to [A]:"), then answer-wide markers
 * ("Sources: [A], [B]").
 * @param {Block[]} blocks
 */
export function associate(blocks) {
  /** @type {Draft[]} */
  const drafts = [];
  /** @type {Set<number>} */
  const answerCites = new Set();
  /** @type {Map<number, number[]>} */
  const blockCites = new Map();

  blocks.forEach((block, b) => {
    const { text, cites, bad } = flatten(block);
    if (isContentless(text)) {
      cites.forEach((c) => answerCites.add(c.index));
      if (cites.length) blockCites.set(b, cites.map((c) => c.index));
      return;
    }
    const spans = sentenceSpans(text);
    if (!spans.length) return;
    const first = drafts.length;
    for (const s of spans) drafts.push({ block: b, kind: block.kind, start: s.start, end: s.end, text: readable(text.slice(s.start, s.end)), own: [], bad: [] });
    for (const c of cites) {
      const d = drafts[first + owner(spans, c.pos)];
      if (!d.own.includes(c.index)) d.own.push(c.index);
    }
    for (const c of bad) drafts[first + owner(spans, c.pos)].bad.push({ label: c.label, resolved: c.resolved });
    blockCites.set(b, [...new Set(cites.map((c) => c.index))]);
  });

  return drafts.map((d, i) => {
    if (d.own.length) return { ...d, cites: d.own.slice(), citeSource: /** @type {SentenceResult['citeSource']} */ ('own') };
    // Nearest cited statement in the same block: the next one first ("S1. S2 [A].") then the previous.
    for (const step of [1, -1]) {
      for (let j = i + step; j >= 0 && j < drafts.length && drafts[j].block === d.block; j += step) {
        if (drafts[j].own.length) return { ...d, cites: drafts[j].own.slice(), citeSource: /** @type {SentenceResult['citeSource']} */ ('block') };
      }
    }
    let lead = blocks[d.block].leadIn;
    for (let hops = 0; lead !== null && lead !== undefined && hops < 4; hops += 1) {
      const cites = blockCites.get(lead);
      if (cites?.length) return { ...d, cites: cites.slice(), citeSource: /** @type {SentenceResult['citeSource']} */ ('leadin') };
      lead = blocks[lead]?.leadIn ?? null;
    }
    if (answerCites.size) return { ...d, cites: [...answerCites], citeSource: /** @type {SentenceResult['citeSource']} */ ('answer') };
    return { ...d, cites: /** @type {number[]} */ ([]), citeSource: /** @type {SentenceResult['citeSource']} */ (null) };
  });
}

/**
 * @typedef {object} CheckContext
 * @property {GroundingSource[]} sources
 * @property {Array<import('./facts.js').SourceIndex | null>} indexes  null for omitted excerpts
 * @property {import('./facts.js').SourceIndex | null} given  the question and recent turns
 * @property {boolean} citedOnly  only statements with their own marker count (extractive answers)
 */

/**
 * Checks one statement.
 * @param {Draft & { cites: number[], citeSource: SentenceResult['citeSource'] }} draft
 * @param {CheckContext} ctx
 * @returns {SentenceResult}
 */
export function checkSentence(draft, ctx) {
  const base = { block: draft.block, start: draft.start, end: draft.end, text: draft.text, cites: draft.cites.slice(), citeSource: draft.citeSource };
  /** @type {SentenceResult} */
  const neutral = { ...base, verdict: 'neutral', reasons: [], overlap: null, crossLanguage: false };
  const facts = extractFacts(draft.text);
  const tokens = contentTokens(draft.text);
  const ownMarker = draft.own.length > 0 || draft.bad.length > 0;

  if ((draft.kind === 'heading' || draft.kind === 'header-row') && !ownMarker) return neutral;
  if (ctx.citedOnly && !ownMarker) return neutral;
  if (!draft.cites.length && !draft.bad.length && !facts.length) return neutral;
  if (!facts.length && tokens.length < THRESHOLDS.minContentTokens && !draft.bad.length) return neutral;

  /** @type {Reason[]} */
  const reasons = [];
  const cites = draft.cites.slice();
  for (const b of draft.bad) {
    if (b.resolved !== null && ctx.sources[b.resolved]) {
      if (!cites.includes(b.resolved)) cites.push(b.resolved);
      reasons.push({ code: 'label_mismatch', level: 'weak', found: b.label, cites: [b.resolved] });
    } else {
      reasons.push({ code: 'unknown_citation', level: 'unsupported', found: b.label });
    }
  }

  const delivered = cites.filter((i) => ctx.indexes[i]);
  const omitted = cites.filter((i) => ctx.sources[i] && !ctx.indexes[i]);
  if (cites.length && !delivered.length && omitted.length) reasons.push({ code: 'not_delivered', level: 'unsupported', cites: omitted });

  const others = ctx.indexes.map((_, i) => i).filter((i) => ctx.indexes[i] && !cites.includes(i));
  for (const fact of facts) {
    /** @type {{ index: number, detail?: string } | null} */
    let approx = null;
    let partial = false;
    let exact = false;
    for (const i of delivered) {
      const hit = lookupFact(fact, /** @type {import('./facts.js').SourceIndex} */ (ctx.indexes[i]), THRESHOLDS.approxTolerance);
      if (hit.found === 'exact') {
        exact = true;
        break;
      }
      if (hit.found === 'approx' && !approx) approx = { index: i, detail: hit.detail };
      if (hit.found === 'partial') partial = true;
    }
    if (exact) continue;
    if (approx) {
      reasons.push({ code: 'approximate', level: 'weak', fact: fact.surface, cites: [approx.index], found: approx.detail });
      continue;
    }
    /** @type {number[]} */
    const elsewhere = [];
    /** @type {string | undefined} */
    let elsewhereDetail;
    for (const i of others) {
      const hit = lookupFact(fact, /** @type {import('./facts.js').SourceIndex} */ (ctx.indexes[i]), THRESHOLDS.approxTolerance);
      if (hit.found === 'exact' || hit.found === 'approx') {
        elsewhere.push(i);
        if (hit.found === 'approx') elsewhereDetail ??= hit.detail;
      }
    }
    if (elsewhere.length) {
      const reason = /** @type {Reason} */ ({ code: delivered.length ? 'fact_elsewhere' : 'uncited_found', level: 'weak', fact: fact.surface, cites: delivered, other: elsewhere });
      if (elsewhereDetail) reason.found = elsewhereDetail;
      reasons.push(reason);
      continue;
    }
    if (ctx.given && lookupFact(fact, ctx.given).found === 'exact') {
      reasons.push({ code: 'from_conversation', level: 'weak', fact: fact.surface });
      continue;
    }
    if (fact.kind === 'quote') {
      reasons.push({ code: 'quote_missing', level: partial ? 'weak' : 'unsupported', fact: fact.surface, cites: delivered });
      continue;
    }
    if (!delivered.length && omitted.length) continue; // already reported as not delivered
    reasons.push({ code: delivered.length ? 'missing_fact' : 'uncited_missing', level: 'unsupported', fact: fact.surface, cites: delivered });
  }

  /** @type {number | null} */
  let overlap = null;
  let crossLanguage = false;
  if (delivered.length && tokens.length >= THRESHOLDS.minContentTokens) {
    const sentenceLang = guessLanguage(draft.text);
    const sourceLangs = delivered.map((i) => ctx.indexes[i]?.lang ?? null).filter(Boolean);
    crossLanguage = Boolean(sentenceLang && sourceLangs.length && sourceLangs.every((l) => l !== sentenceLang));
    if (!crossLanguage) {
      const matched = tokens.filter((t) => delivered.some((i) => tokenMatches(t, /** @type {import('./facts.js').SourceIndex} */ (ctx.indexes[i])))).length;
      overlap = Math.round((matched / tokens.length) * 1000) / 1000;
      if (overlap < THRESHOLDS.supportedOverlap) reasons.push({ code: 'low_overlap', level: 'weak', cites: delivered });
    }
  }

  /** @type {Verdict} */
  let verdict;
  if (reasons.some((r) => r.level === 'unsupported')) verdict = 'unsupported';
  else if (reasons.length) verdict = 'weak';
  else if (!cites.length) verdict = 'weak';
  else if (facts.length || overlap !== null) verdict = 'supported';
  else verdict = 'unchecked';
  if (verdict === 'weak' && !reasons.length) reasons.push({ code: 'uncited_found', level: 'weak' });
  return { ...base, cites, verdict, reasons, overlap, crossLanguage };
}

/**
 * Checks a whole answer.
 * @param {Block[]} blocks
 * @param {GroundingSource[]} sources  index-aligned with the `index` of cite segments
 * @param {{ given?: string[], citedOnly?: boolean }} [options]
 * @returns {GroundingReport}
 */
export function groundAnswer(blocks, sources, options = {}) {
  const counts = { supported: 0, weak: 0, unsupported: 0, unchecked: 0 };
  const report = { algorithm: { ...GROUNDING }, sentences: /** @type {SentenceResult[]} */ ([]), counts, crossLanguage: false, skipped: /** @type {null | 'too_long'} */ (null) };
  const chars = blocks.reduce((n, b) => n + b.segments.reduce((m, s) => m + (s.type === 'text' ? s.text.length : 0), 0), 0);
  if (chars > THRESHOLDS.maxChars) return { ...report, skipped: 'too_long' };
  const drafts = associate(blocks);
  if (drafts.length > THRESHOLDS.maxSentences) return { ...report, skipped: 'too_long' };

  const indexes = sources.map((s) => (s.delivered === 'omitted' ? null : indexSource(`${s.text}\n${s.doc}\n${s.heading}`)));
  const given = options.given?.length ? indexSource(options.given.join('\n')) : null;
  /** @type {CheckContext} */
  const ctx = { sources, indexes, given, citedOnly: Boolean(options.citedOnly) };
  for (const d of drafts) {
    const r = checkSentence(d, ctx);
    if (r.crossLanguage) report.crossLanguage = true;
    if (r.verdict !== 'neutral') counts[r.verdict] += 1;
    report.sentences.push(r);
  }
  return report;
}

/**
 * Which part of every excerpt reached the model: the context string actually sent (after any
 * trimming to fit the model) is parsed back into its excerpt blocks.
 * @param {Array<{ text: string }>} citations  the excerpts, in context order
 * @param {string} context  `<<<EXCERPT n [label]…>>>\ntext\n<<<END EXCERPT n>>>` blocks, possibly cut
 * @returns {Array<{ delivered: 'full' | 'partial' | 'omitted', text: string }>}
 */
export function contextCoverage(citations, context) {
  /** @type {Map<number, { text: string, complete: boolean }>} */
  const blocks = new Map();
  const header = /<<<EXCERPT (\d+) [^\n]*?>>>\n/g;
  const heads = [...context.matchAll(header)];
  heads.forEach((m, k) => {
    const n = Number(m[1]);
    const bodyStart = (m.index ?? 0) + m[0].length;
    const next = k + 1 < heads.length ? (heads[k + 1].index ?? context.length) : context.length;
    const body = context.slice(bodyStart, next);
    const end = body.indexOf(`\n<<<END EXCERPT ${n}>>>`);
    if (end >= 0) blocks.set(n, { text: body.slice(0, end), complete: true });
    else blocks.set(n, { text: body.replace(/\n?<<<[^>]*$/, '').replace(/…\s*$/, '').trimEnd(), complete: false });
  });
  return citations.map((c, i) => {
    const b = blocks.get(i + 1);
    if (!b || !b.text.trim()) return { delivered: 'omitted', text: '' };
    if (b.complete && b.text === c.text) return { delivered: 'full', text: c.text };
    // A fenced excerpt whose text was cut to fit ends in an ellipsis.
    const cut = !b.complete || b.text.endsWith('…');
    return { delivered: cut ? 'partial' : 'full', text: cut ? b.text.replace(/…\s*$/, '').trimEnd() : b.text };
  });
}

/**
 * Resolves a label the app did not register ("[doc: Plan.pdf, chunk 1]") to an excerpt, if one
 * matches by document name (case- and space-insensitive) and chunk number.
 * @param {string} label
 * @param {Array<{ doc: string, label: string }>} sources
 * @returns {number | null}
 */
export function resolveLabel(label, sources) {
  const parsed = parseLabel(label);
  if (!parsed) return null;
  const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const byDoc = sources.map((s, i) => ({ s, i })).filter(({ s }) => norm(s.doc) === norm(parsed.doc));
  if (parsed.chunk !== null) {
    const exact = byDoc.find(({ s }) => new RegExp(`Chunk:\\s*${parsed.chunk}\\]$`).test(s.label));
    return exact ? exact.i : null;
  }
  return byDoc.length === 1 ? byDoc[0].i : null;
}

/**
 * Blocks from plain Markdown, for tests and command-line checks. The browser uses the rendered DOM
 * instead (grounding-view.js), which knows exactly where Markdown put each citation.
 * @param {string} markdown
 * @param {Array<{ doc: string, label: string }>} sources
 * @returns {Block[]}
 */
export function blocksFromMarkdown(markdown, sources) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {number | null} */
  let lastPara = null;
  let lastParaLead = false;
  const labels = new Map(sources.map((s, i) => [s.label, i]));
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\\([[\]*_#`])/g, '$1');
    if (!line.trim()) continue;
    /** @type {Block['kind']} */
    let kind = 'p';
    let body = line;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      kind = 'heading';
      body = heading[1];
    } else if (item) {
      kind = 'li';
      body = item[1];
    } else if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s|:-]+\|?\s*$/.test(line)) continue;
      kind = 'row';
      body = line.trim().replace(/^\||\|$/g, '').split('|').join(' | ');
    }
    body = body.replace(/\*\*|__|(?<![\p{L}\p{N}])[*_](?![\s*_])|(?<![\s*_])[*_](?![\p{L}\p{N}])/gu, '');
    /** @type {Segment[]} */
    const segments = [];
    let pos = 0;
    const re = new RegExp(`${CITATION_PATTERN.source}|${LOOSE_LABEL_PATTERN.source}`, 'gi');
    let m;
    while ((m = re.exec(body)) !== null) {
      if (m.index > pos) segments.push({ type: 'text', text: body.slice(pos, m.index) });
      const index = labels.get(m[0]);
      if (index !== undefined) segments.push({ type: 'cite', index });
      else segments.push({ type: 'badcite', label: m[0], resolved: resolveLabel(m[0], sources) });
      pos = m.index + m[0].length;
    }
    if (pos < body.length) segments.push({ type: 'text', text: body.slice(pos) });
    const leadIn = kind === 'li' && lastParaLead ? lastPara : null;
    blocks.push({ kind, segments, leadIn });
    if (kind !== 'li') {
      lastPara = blocks.length - 1;
      lastParaLead = /:\s*$/.test(body);
    }
  }
  return blocks;
}
