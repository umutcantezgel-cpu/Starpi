// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// Sentence gate: the last step between a model's streamed answer and anything that shows or speaks
// it as checked. Text goes through the streaming releaser (release.js), which hands over a unit (a
// sentence, list item, table row, heading or code block) only once it can no longer change; the gate
// judges each unit exactly once and either releases it or withholds it with a reason. A released
// unit is a frozen object only this module creates, and isReleased() tells it apart from anything
// else, so a speech queue can refuse text that did not pass the gate.
//
// What is judged is the canonical text of the unit (canonical.js): the very text that is shown and,
// with its abbreviations written out (spoken.js), spoken. Citation labels are taken out of it and
// reported as `cites`. The rules:
//   - chars:  every character must be on the allowlist (Latin letters, digits, common signs and the
//             letters of the registered language packs); other scripts, digit systems, look-alike
//             signs and invisible marks withhold the unit in every mode.
//   - link:   a URL, a bare domain or a Markdown link target withholds the unit in every mode.
//   - sources mode: every number (number-words.js) must appear with the same value in an excerpt
//             the same unit cites. There is no tolerance. A form whose value depends on the
//             convention ("1.200", "2,500") and a compound form (date, time, version) must appear as
//             written. Number words that state a quantity (cardinal, fraction, multiplier) are
//             numbers too; ordinals and adverbs ("first", "once", "einmal") never withhold. A unit
//             with a number and no citation, or citing a label that is not one of the sources,
//             is withheld.
//   - identifiers: codes with digits ("ISO 9001", "IPv6", "GPT-4o", "COVID-19", "MP3", "A4") are
//             not numbers. With `identifiers: 'verbatim'` (the default) each must appear literally
//             in a cited excerpt or in the question; with 'any' they pass.
//   - joined: digits a listener would hear as another number ("4 80", "5OO", "10³", "5 hundred",
//             ".5") withhold the unit in sources and web mode.
//   - web mode: every number must lie inside a grounded segment of the answer that has at least
//             one http(s) source.
//   - free mode: only the character and link rules apply.
//   - spoken form: the expansion of abbreviations and units must leave the numbers as they are;
//             otherwise the canonical text is spoken ('strict' withholds the unit instead).
//
// Pure: no DOM, runs in the browser, in workers and in Node.
import { blankRanges, canonicalize, canonicalText, describeChar, firstDisallowed } from './canonical.js';
import { guessLanguage } from './facts.js';
import { labelName, parseLabel } from './labels.js';
import { languagePack } from './lang/index.js';
import { scanNumbers, valueKey } from './number-words.js';
import { createSentenceReleaser, TRAILING_LABEL } from './release.js';
import { spokenForm } from './spoken.js';

/** @typedef {'sources' | 'web' | 'free'} GateMode */
/**
 * Why a unit was withheld.
 * @typedef {'unsupported_number' | 'number_word' | 'identifier' | 'chars' | 'joined' | 'link' | 'unknown_source'
 *   | 'spoken_mismatch' | 'web_ungrounded'} WithheldReason
 */

/** Every reason, in the order the rules are applied. */
export const WITHHELD_REASONS = Object.freeze(
  /** @type {WithheldReason[]} */ (['unknown_source', 'chars', 'link', 'joined', 'unsupported_number', 'number_word', 'identifier', 'web_ungrounded', 'spoken_mismatch']),
);

/**
 * @typedef {object} GateSource
 * @property {number} [index]  the number `cites` reports for it; its position in the list when left out
 * @property {string} label    how a sentence cites it: "[Doc: plan.md, Chunk: 2]", "[S1]" or any other bracketed label
 * @property {'doc' | 'web' | 'note' | 'tool'} [kind]
 * @property {string} text     the excerpt as the model was given it
 */

/**
 * Where a web answer is grounded: segments of the answer (UTF-16 offsets into the whole streamed
 * text) and the sources each one rests on (indexes into `sources`).
 * @typedef {object} GateGrounding
 * @property {Array<{ start: number, end: number, sources: number[] }>} segments
 * @property {Array<{ uri: string, title?: string }>} sources
 */

/**
 * @typedef {object} GateOptions
 * @property {GateMode} [mode]                     default 'sources'
 * @property {string | null} [locale]              language of the answer ("en", "de-AT"); guessed per unit when left out
 * @property {GateSource[]} [sources]              the excerpts the answer may cite (sources mode)
 * @property {string} [question]                   identifiers in it count as given
 * @property {GateGrounding | null} [grounding]    web mode; may instead be passed to end() when it arrives after the text
 * @property {'verbatim' | 'any'} [identifiers]    default 'verbatim'
 * @property {RegExp[]} [identifierPatterns]       more identifiers; digits inside a match are no numbers
 * @property {'markdown' | 'none'} [blocks]        units of the releaser, default 'markdown'
 * @property {'expand' | 'canonical' | 'strict'} [spoken]  the spoken form: expanded (default), the canonical text, or
 *   expanded with a unit withheld when the expansion would change a number
 */

/**
 * A number of a released unit: as written, and its value (null for a date, time or version, or a
 * form whose value depends on the convention).
 * @typedef {{ raw: string, value: number | null }} ReleasedNumber
 */

/**
 * A unit that passed the gate. Frozen; isReleased() is true only for objects the gate made.
 * @typedef {object} Released
 * @property {string} text      canonical text without citation labels: what to show
 * @property {string} spoken    what to speak
 * @property {number[]} cites   indexes of the cited sources
 * @property {ReleasedNumber[]} numbers  the numbers and number words that state a quantity
 * @property {import('./canonical.js').UnitKind} kind
 * @property {number} start     offsets of the unit in the whole streamed text
 * @property {number} end
 * @property {number} line      1-based line of its start
 */

/**
 * A unit that did not pass, with the first rule it broke.
 * @typedef {object} Withheld
 * @property {string} text      canonical text, labels included
 * @property {WithheldReason} reason
 * @property {string} token     what broke the rule: the number, word, identifier, link, label or character
 * @property {import('./canonical.js').UnitKind} kind
 * @property {number} start
 * @property {number} end
 * @property {number} line
 */

/**
 * @typedef {object} GateCounts
 * @property {number} released
 * @property {number} withheld
 * @property {Partial<Record<WithheldReason, number>>} reasons  withheld units by reason
 * @property {number} spokenFallback  released units spoken as their canonical text because an expansion would have changed a number
 */

/**
 * @typedef {object} GateResult
 * @property {Released[]} released   end(): the units this call released (the rest of the stream); checkText(): all of them
 * @property {Withheld[]} withheld   every unit withheld over the whole stream, in order
 * @property {GateCounts} counts     totals over the whole stream
 */

/**
 * @typedef {object} SentenceGate
 * @property {(delta: string) => Released[]} push   adds streamed text; returns the units it released, in order
 * @property {(final?: { grounding?: GateGrounding | null }) => GateResult} end  the stream is complete
 * @property {() => GateResult & { dropped: number }} abort  the stream stopped: open units are dropped unjudged
 */

/** Objects made by this module; nothing else passes isReleased(). */
const RELEASED = new WeakSet();

/**
 * Whether a value is a unit released by a sentence gate (and not a look-alike object or a string).
 * @param {unknown} value
 * @returns {value is Released}
 */
export function isReleased(value) {
  return typeof value === 'object' && value !== null && RELEASED.has(value);
}

const MODES = new Set(['sources', 'web', 'free']);
const KINDS = new Set(['doc', 'web', 'note', 'tool']);

/** A bracketed text that may be a citation label. */
const BRACKET = /\[[^[\]\n]{1,320}\]/g;
/** A label part of the short form: "S1", "2", "W3". */
const SHORT_PART = /^\s*[A-Za-z]{0,2}\d{1,4}\s*$/;
/** The start of a label in the long forms ("[Doc: …", "[Source: …"), known or not. */
const LONG_LABEL = /^\[\s*(?:doc|dok|dokument|document|source|quelle)\s*:/i;
/** Links: a URL scheme, "www.", a Markdown link target, or a bare domain with a common top-level domain. */
const LINK = new RegExp(
  [
    String.raw`\b(?:https?|ftps?|file|wss?):\/\/\S*`,
    String.raw`\b(?:mailto|javascript|data|vbscript|tel|sms):(?=[^\s])\S*`,
    String.raw`\bwww\d{0,3}\.[\p{L}\p{N}-]\S*`,
    String.raw`\]\([^)\s]*\)`,
    String.raw`(?<![\p{L}\p{N}@.\-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+` +
      String.raw`(?:com|org|net|edu|gov|int|info|biz|io|ai|app|dev|co|me|tv|eu|de|at|ch|uk|fr|es|it|nl|be|pl|tr|ru|cn|jp|us|ca|au|ly|gl|link|site|online|xyz|top|shop)` +
      String.raw`(?![\p{L}\p{N}\-])(?:[/:?#]\S*)?`,
  ].join('|'),
  'iu',
);
const HTTP = /^https?:\/\//i;

/**
 * A link as reported: without the punctuation of the sentence after it, and without a closing
 * bracket it did not open.
 * @param {string} link
 */
function linkToken(link) {
  let token = link.replace(/[.,;:!?]+$/, '');
  const count = (/** @type {string} */ ch) => token.split(ch).length - 1;
  while ((token.endsWith(')') && count(')') > count('(')) || (token.endsWith(']') && count(']') > count('['))) token = token.slice(0, -1).replace(/[.,;:!?]+$/, '');
  return token || link;
}

/**
 * The key a label is found by: the document and chunk of the long form, read leniently, or the
 * bracketed text without spaces, in lowercase.
 * @param {string} label  canonical text of the label
 */
function labelKey(label) {
  const parsed = parseLabel(label);
  if (parsed) return `doc:${labelName(parsed.doc).toLowerCase()}#${parsed.chunk ?? ''}`;
  return `raw:${label.toLowerCase().replace(/\s+/g, '')}`;
}

/**
 * Whether `needle` occurs in `haystack` (both lowercase) as a whole token: no letter or digit right
 * before or after it.
 * @param {string} haystack
 * @param {string} needle
 */
function hasToken(haystack, needle) {
  if (!needle) return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? ' ';
    const after = haystack[at + needle.length] ?? ' ';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

/**
 * @typedef {object} SourceIndex
 * @property {Set<string>} values   value keys of every number and number word with one value
 * @property {Set<string>} written  numbers as written
 * @property {string} lower         canonical text, lowercase, for identifiers
 */

/**
 * @typedef {object} PreparedSource
 * @property {number} index
 * @property {string} label
 * @property {string} text
 * @property {SourceIndex | null} idx
 */

/**
 * Reads an excerpt once: its numbers (leniently: "half" counts without a unit), number words in
 * every language, and its text for identifiers.
 * @param {string} text
 * @param {RegExp[]} identifierPatterns
 * @returns {SourceIndex}
 */
function indexSource(text, identifierPatterns) {
  const canonical = canonicalText(text);
  /** @type {Set<string>} */
  const values = new Set();
  /** @type {Set<string>} */
  const written = new Set();
  for (const item of scanNumbers(canonical, { lenient: true, identifierPatterns })) {
    if (item.type === 'number') {
      written.add(item.written);
      if (item.value !== null && !item.ambiguous) values.add(valueKey(item.value));
    } else if (item.type === 'word' && item.claim) values.add(valueKey(item.value));
  }
  return { values, written, lower: canonical.toLowerCase() };
}

/**
 * Checks and copies the options.
 * @param {GateOptions} options
 */
function readOptions(options) {
  const o = options ?? {};
  const mode = o.mode ?? 'sources';
  if (!MODES.has(mode)) throw new TypeError("createSentenceGate: mode must be 'sources', 'web' or 'free'");
  if (o.identifiers !== undefined && o.identifiers !== 'verbatim' && o.identifiers !== 'any') throw new TypeError("createSentenceGate: identifiers must be 'verbatim' or 'any'");
  if (o.spoken !== undefined && !['expand', 'canonical', 'strict'].includes(o.spoken)) throw new TypeError("createSentenceGate: spoken must be 'expand', 'canonical' or 'strict'");
  if (o.locale !== undefined && o.locale !== null && typeof o.locale !== 'string') throw new TypeError('createSentenceGate: locale must be a language code');
  if (o.question !== undefined && typeof o.question !== 'string') throw new TypeError('createSentenceGate: question must be text');
  const patterns = o.identifierPatterns ?? [];
  if (!Array.isArray(patterns) || !patterns.every((p) => p instanceof RegExp)) throw new TypeError('createSentenceGate: identifierPatterns must be a list of RegExp');
  const list = o.sources ?? [];
  if (!Array.isArray(list)) throw new TypeError('createSentenceGate: sources must be a list');
  /** @type {PreparedSource[]} */
  const sources = list.map((s, i) => {
    if (!s || typeof s.label !== 'string' || !s.label.trim() || typeof s.text !== 'string') throw new TypeError(`createSentenceGate: source ${i} needs a label and a text`);
    if (s.kind !== undefined && !KINDS.has(s.kind)) throw new TypeError(`createSentenceGate: source ${i} has an unknown kind`);
    if (s.index !== undefined && !Number.isInteger(s.index)) throw new TypeError(`createSentenceGate: source ${i} has an index that is not a whole number`);
    return { index: s.index ?? i, label: s.label, text: s.text, idx: null };
  });
  return {
    mode: /** @type {GateMode} */ (mode),
    pack: o.locale ? languagePack(o.locale) : null,
    sources,
    question: o.question ? canonicalText(o.question).toLowerCase() : '',
    grounding: o.grounding === undefined ? undefined : o.grounding,
    verbatim: (o.identifiers ?? 'verbatim') === 'verbatim',
    patterns,
    blocks: o.blocks ?? 'markdown',
    spoken: o.spoken ?? 'expand',
  };
}

/**
 * The grounded segments that rest on at least one http(s) source, as [start, end] pairs. Entries
 * that are not well-formed are left out: a malformed grounding grounds nothing.
 * @param {GateGrounding | null | undefined} grounding
 * @returns {Array<[number, number]>}
 */
function groundedSegments(grounding) {
  if (!grounding || typeof grounding !== 'object' || !Array.isArray(grounding.segments) || !Array.isArray(grounding.sources)) return [];
  const web = grounding.sources.map((s) => Boolean(s && typeof s.uri === 'string' && HTTP.test(s.uri)));
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const seg of grounding.segments) {
    if (!seg || !Number.isInteger(seg.start) || !Number.isInteger(seg.end) || seg.end <= seg.start || !Array.isArray(seg.sources)) continue;
    if (seg.sources.some((i) => Number.isInteger(i) && web[i])) out.push([seg.start, seg.end]);
  }
  return out;
}

/**
 * Creates a gate for one streamed answer.
 * @param {GateOptions} [options]
 * @returns {SentenceGate}
 */
export function createSentenceGate(options = {}) {
  const opts = readOptions(options);
  const { mode, sources, patterns } = opts;
  /** @type {Map<string, PreparedSource[]>} */
  const byLabel = new Map();
  for (const s of sources) {
    const key = labelKey(canonicalText(s.label));
    const list = byLabel.get(key);
    if (list) list.push(s);
    else byLabel.set(key, [s]);
  }
  const knownLabels = new Set(sources.map((s) => s.label.replace(/\s+/g, ' ').trim().toLowerCase()));
  // A label right after a sentence's end still belongs to it: the usual forms and every source label.
  const trailer = { test: (/** @type {string} */ text) => TRAILING_LABEL.test(text) || knownLabels.has(text.replace(/\s+/g, ' ').trim().toLowerCase()) };

  /** @type {Array<[number, number]> | null} */
  let segments = mode === 'web' && opts.grounding !== undefined ? groundedSegments(opts.grounding) : null;
  /** @type {Withheld[]} */
  const withheld = [];
  /** @type {GateCounts} */
  const counts = { released: 0, withheld: 0, reasons: {}, spokenFallback: 0 };
  /** @type {import('./release.js').Unit[]} */
  const pending = [];

  /** @param {PreparedSource} s */
  const indexOf = (s) => {
    if (!s.idx) s.idx = indexSource(s.text, patterns);
    return s.idx;
  };

  /**
   * Citation labels in a canonical text: the sources they cite, the ranges to take out, and the
   * first label that names no source.
   * @param {string} text
   */
  const readLabels = (text) => {
    /** @type {Set<PreparedSource>} */
    const cited = new Set();
    /** @type {Array<[number, number]>} */
    const ranges = [];
    let unknown = '';
    for (const m of text.matchAll(BRACKET)) {
      const label = m[0];
      const at = /** @type {number} */ (m.index);
      const known = byLabel.get(labelKey(label));
      if (known) {
        known.forEach((s) => cited.add(s));
        ranges.push([at, at + label.length]);
        continue;
      }
      const parts = label.slice(1, -1).split(/[,;]/);
      if (parts.every((p) => SHORT_PART.test(p))) {
        for (const p of parts) {
          const hit = byLabel.get(`raw:[${p.trim().toLowerCase()}]`);
          if (hit) hit.forEach((s) => cited.add(s));
          else if (!unknown) unknown = label;
        }
        ranges.push([at, at + label.length]);
      } else if (LONG_LABEL.test(label)) {
        if (!unknown) unknown = label;
        ranges.push([at, at + label.length]);
      }
    }
    return { cited: [...cited], ranges, unknown };
  };

  /**
   * Judges one unit: the released object, or a withheld record.
   * @param {import('./release.js').Unit} unit
   * @returns {Released | Withheld | null}  null for a unit with nothing to show (a label alone)
   */
  const judge = (unit) => {
    const canonical = canonicalize(unit.text, { kind: unit.kind });
    const { cited, ranges, unknown } = readLabels(canonical.text);
    const bare = ranges.length ? blankRanges(canonical, ranges) : canonical;
    const base = { kind: unit.kind, start: unit.start, end: unit.end, line: unit.line };
    /** @type {(reason: WithheldReason, token: string) => Withheld} */
    const withhold = (reason, token) => ({ text: canonical.text, reason, token, ...base });
    if (mode === 'sources' && unknown) return withhold('unknown_source', unknown);
    if (!bare.text) return null;
    const bad = firstDisallowed(bare.text);
    if (bad) return withhold('chars', describeChar(bad.char));
    const link = LINK.exec(bare.text);
    if (link) return withhold('link', linkToken(link[0]));

    const locale = opts.pack?.code ?? guessLanguage(bare.text);
    const items = scanNumbers(bare.text, { locale, identifierPatterns: patterns });
    /** Offsets of an item in the whole stream. */
    const streamSpan = (/** @type {{ start: number, end: number }} */ item) => [unit.start + bare.map[item.start], unit.start + bare.map[item.end - 1] + 1];
    const grounded = (/** @type {{ start: number, end: number }} */ item) => {
      const [a, b] = streamSpan(item);
      return (segments ?? []).some(([s, e]) => s <= a && b <= e);
    };
    const citedIndexes = cited.map(indexOf);
    if (mode !== 'free') {
      // Joins first: "4 80" is withheld as a join, not for the 4 it starts with.
      for (const item of items) {
        if (item.type !== 'joined') continue;
        const raw = item.raw.toLowerCase();
        if (item.lookalike && mode === 'sources' && citedIndexes.some((idx) => hasToken(idx.lower, raw))) continue;
        return withhold('joined', item.raw);
      }
      for (const item of items) {
        if (item.type === 'joined') continue;
        if (item.type === 'identifier') {
          if (!opts.verbatim) continue;
          const given = item.keys.some((k) => hasToken(opts.question, k));
          const found = mode === 'sources' ? citedIndexes.some((idx) => item.keys.some((k) => hasToken(idx.lower, k))) : grounded(item);
          if (!given && !found) return withhold('identifier', item.raw);
          continue;
        }
        if (item.type === 'word' && !item.claim) continue;
        if (mode === 'web') {
          if (!grounded(item)) return withhold(item.type === 'word' ? 'number_word' : 'web_ungrounded', item.raw);
          continue;
        }
        // Same value, or the same written form when the value depends on the convention.
        const key = item.type === 'word' || (item.value !== null && !item.ambiguous) ? valueKey(/** @type {number} */ (item.value)) : null;
        const supported = citedIndexes.some((idx) => (item.type === 'number' && idx.written.has(item.written)) || (key !== null && idx.values.has(key)));
        if (!supported) return withhold(item.type === 'word' ? 'number_word' : 'unsupported_number', item.raw);
      }
    }

    let spoken = bare.text;
    if (opts.spoken !== 'canonical') {
      const form = spokenForm(bare.text, { locale });
      if (form.mismatch && opts.spoken === 'strict') return withhold('spoken_mismatch', form.text);
      if (form.mismatch) counts.spokenFallback += 1;
      spoken = form.text;
    }
    /** @type {ReleasedNumber[]} */
    const numbers = [];
    for (const item of items) {
      if (item.type === 'number') numbers.push(Object.freeze({ raw: item.raw, value: item.ambiguous ? null : item.value }));
      else if (item.type === 'word' && item.claim) numbers.push(Object.freeze({ raw: item.raw, value: item.value }));
    }
    const released = Object.freeze({
      text: bare.text,
      spoken,
      cites: Object.freeze([...new Set(cited.map((s) => s.index))].sort((a, b) => a - b)),
      numbers: Object.freeze(numbers),
      ...base,
    });
    RELEASED.add(released);
    return /** @type {Released} */ (/** @type {unknown} */ (released));
  };

  /**
   * Judges a unit and records the outcome; returns it when released.
   * @param {import('./release.js').Unit} unit
   * @returns {Released | null}
   */
  const decide = (unit) => {
    const result = judge(unit);
    if (!result) return null;
    if (isReleased(result)) {
      counts.released += 1;
      return result;
    }
    const w = /** @type {Withheld} */ (result);
    withheld.push(Object.freeze(w));
    counts.withheld += 1;
    counts.reasons[w.reason] = (counts.reasons[w.reason] ?? 0) + 1;
    return null;
  };

  const releaser = createSentenceReleaser({
    // Web mode without its grounding yet: units wait for end(), in order.
    check: (unit) => {
      if (segments === null && mode === 'web') {
        pending.push(unit);
        return null;
      }
      return decide(unit);
    },
    blocks: opts.blocks,
    trailer,
  });

  const summary = () => ({ withheld: [...withheld], counts: { ...counts, reasons: { ...counts.reasons } } });

  return {
    push(delta) {
      return releaser.push(delta);
    },
    end(final) {
      if (releaser.done) return { released: [], ...summary() };
      const tail = releaser.end();
      if (mode === 'web' && segments === null) {
        segments = groundedSegments(final?.grounding);
        for (const unit of pending.splice(0)) {
          const r = decide(unit);
          if (r) tail.push(r);
        }
      }
      return { released: tail, ...summary() };
    },
    abort() {
      const { dropped } = releaser.abort();
      const waiting = pending.splice(0).length;
      return { released: [], ...summary(), dropped: dropped + waiting };
    },
  };
}

/**
 * Judges a complete text at once: the same as pushing it into a new gate and ending it.
 * @param {string} text
 * @param {GateOptions} [options]
 * @returns {GateResult}
 */
export function checkText(text, options = {}) {
  const gate = createSentenceGate(options);
  const released = gate.push(String(text ?? ''));
  const result = gate.end();
  return { ...result, released: [...released, ...result.released] };
}
