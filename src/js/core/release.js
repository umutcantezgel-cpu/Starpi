// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// Streaming sentence releaser: turns a streamed text (a model answer arriving in deltas) into units
// that can no longer change, hands each to `check(unit)` once, and returns what the check returned
// for every unit it lets through, in stream order. The sentence gate (gate.js) is one such check;
// read-aloud, research reports and other gates use the same releaser with their own.
//
// Units. With `blocks: 'markdown'` (the default) a list item (with its indented continuation
// lines), a table row, a heading and a fenced code block are each one unit, released whole; the
// text of a paragraph is released sentence by sentence. With `blocks: 'none'` every line is plain
// text. A line break always ends a sentence, as in the source check (sentences.js).
//
// When a unit is certain. A sentence ends at ".", "!", "?" or "…" followed by white space, except
// after an ordinal or an abbreviation of a language pack ("z. B.", "e.g.", "am 3. März"), the same
// rule as sentences.js. Citation labels right after the end still belong to the sentence ("… 480
// EUR. [Doc: plan.md, Chunk: 2]"), so a sentence is judged only when the next character after
// them arrives or its line ends; a streamed text therefore yields exactly the units the whole text
// yields, however it was split into deltas. A list item is certain when the next line starts
// something else, a row or heading at its line end, a code block at its closing fence.
//
// Linear time. Every character is looked at once by a small state machine; nothing already read
// is scanned again (a run of "!!!!" or of "z. z. z." costs the same per character as prose), and
// the buffer keeps only the text of the open unit.
//
// end() releases what is left: the last sentence even without a final dot, an unclosed code block
// as code with `closed: false`. abort() (stop) drops what is open unjudged and ignores later deltas:
// a sentence cut off mid-way is never released.
//
// Pure: no DOM, runs in the browser, in workers and in Node.
import { CITATION_PATTERN, LOOSE_LABEL_PATTERN } from './labels.js';
import { isAbbreviation } from './sentences.js';

/** @typedef {import('./canonical.js').UnitKind} UnitKind */

/**
 * A piece of the stream that can no longer change.
 * @typedef {object} Unit
 * @property {UnitKind} kind
 * @property {string} text     as streamed, without the white space around it
 * @property {number} start    offset of its first character in the whole stream
 * @property {number} end      offset after its last character
 * @property {number} line     1-based line of its start
 * @property {boolean} closed  its own end was seen (end punctuation, line end, closing fence); false when the stream ended first
 */

/**
 * @template T
 * @typedef {object} Releaser
 * @property {(delta: string) => T[]} push   adds text; returns what `check` returned for the units it released
 * @property {() => T[]} end                 the stream is complete: releases the rest
 * @property {() => { dropped: number }} abort  the stream stopped: drops the open units unjudged
 * @property {boolean} done                  end() or abort() was called
 */

/**
 * Labels that still belong to the sentence before them: "[Doc: name, Chunk: n]", the loose forms
 * the source check reports ("[Source: …]"), and short ones ("[S1]", "[2]", "[1, 3]").
 */
export const TRAILING_LABEL = new RegExp(
  `^(?:${CITATION_PATTERN.source}|${LOOSE_LABEL_PATTERN.source}|\\[[A-Z]{0,2}\\d{1,4}(?:\\s*[,;]\\s*[A-Z]{0,2}\\d{1,4})*\\])$`,
  'i',
);

/** Longest text between brackets that can still be a label. */
const MAX_LABEL = 320;

/** @param {number} c */
function isSpace(c) {
  return c === 32 || c === 9 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
/** . ! ? … */
const isEnd = (/** @type {number} */ c) => c === 46 || c === 33 || c === 63 || c === 0x2026;
/** " ' ) ” ’ » › after the end punctuation */
const isCloser = (/** @type {number} */ c) => c === 34 || c === 39 || c === 41 || c === 0x201d || c === 0x2019 || c === 0xbb || c === 0x203a;

const TEXT = 0;
const RUN = 1;
const CLOSE = 2;
const AFTER = 3;
const BRACKET = 4;

/**
 * The block a complete Markdown line starts.
 * @param {string} line
 * @param {boolean} inItem
 * @param {number} indent
 * @returns {{ type: 'blank' | 'rule' | 'fence' | 'heading' | 'row' | 'separator' | 'item' | 'continuation' | 'para', fence?: { char: string, len: number } }}
 */
function lineType(line, inItem, indent) {
  const rest = line.trim();
  if (!rest) return { type: 'blank' };
  if (inItem && indent >= 2 && !/^(?:[-*+•]|\d{1,9}[.)])(?:[ \t]|$)/.test(rest)) return { type: 'continuation' };
  const fence = /^(`{3,}|~{3,})(.*)$/.exec(rest);
  if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) return { type: 'fence', fence: { char: fence[1][0], len: fence[1].length } };
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return { type: 'heading' };
  if (/^([-*_])(?:[ \t]*\1){2,}$/.test(rest) || /^=+$/.test(rest)) return { type: 'rule' };
  if (rest.startsWith('|')) return { type: /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(rest) ? 'separator' : 'row' };
  if (/^(?:[-*+•]|\d{1,9}[.)])(?:[ \t]|$)/.test(rest)) return { type: 'item' };
  return { type: 'para' };
}

/**
 * Whether the first characters of a line already decide it: 'para' (sentences can be released
 * while the line streams), 'hold' (a block, decided at its line end), or null (not yet known).
 * @param {string} head  up to 16 characters after the indentation
 * @param {boolean} indentedInItem
 * @returns {'para' | 'hold' | null}
 */
function lineStart(head, indentedInItem) {
  if (indentedInItem) return 'hold';
  if (/^(?:`{3}|~{3}|#{1,6}[ \t]|\||(?:[-*+•]|\d{1,9}[.)])[ \t])/.test(head)) return 'hold';
  if (/^(?:`{1,2}|~{1,2}|#{1,6}|[-*+•]|\d{1,9}[.)]?)$/.test(head) || /^([-*_=])(?:[ \t]*\1)*[ \t]*$/.test(head)) return null;
  return 'para';
}

/**
 * Creates a releaser.
 * @template T
 * @param {{ check: (unit: Unit) => T | null | undefined | false, blocks?: 'markdown' | 'none', trailer?: { test: (text: string) => boolean }, abbreviation?: (token: string) => boolean }} options
 *   check: judges a unit and returns what to release, or null/false to withhold it;
 *   trailer: whether a bracketed text after a sentence end still belongs to the sentence (default TRAILING_LABEL);
 *   abbreviation: whether a dot after a (lowercase) token leaves the sentence open (default: sentences.js)
 * @returns {Releaser<T>}
 */
export function createSentenceReleaser(options) {
  if (!options || typeof options.check !== 'function') throw new TypeError('createSentenceReleaser: check must be a function');
  const blocks = options.blocks ?? 'markdown';
  if (blocks !== 'markdown' && blocks !== 'none') throw new TypeError("createSentenceReleaser: blocks must be 'markdown' or 'none'");
  const { check } = options;
  const markdown = blocks === 'markdown';
  const trailer = options.trailer ?? TRAILING_LABEL;
  const abbreviation = options.abbreviation ?? isAbbreviation;

  let buf = '';
  let bufStart = 0;
  let pos = 0;
  let done = false;
  /** @type {T[]} */
  let out = [];

  // The current line.
  let lineNo = 1;
  let lineBegin = 0;
  /** @type {'para' | 'hold' | null} */
  let kind = null;
  let indent = 0;
  let head = '';
  let ink = -1; // first non-space character of the line
  let lastInk = -1; // last non-space character of the stream

  // The paragraph scanner.
  let state = TEXT;
  let sentStart = -1;
  let sentLine = 1;
  let token = '';
  let runToken = '';
  let runDot = false;
  let runLen = 0;
  let candEnd = -1;
  let afterLabel = false;
  let bracketStart = -1;
  let depth = 0;

  // Open blocks.
  /** @type {{ start: number, end: number, line: number, cut: boolean } | null} */
  let item = null;
  /** @type {{ char: string, len: number, start: number, line: number } | null} */
  let fence = null;

  const slice = (/** @type {number} */ a, /** @type {number} */ b) => buf.slice(a - bufStart, b - bufStart);

  /** Drops the buffer before `keep`, which no open unit needs. */
  const trim = (/** @type {number} */ keep) => {
    if (keep > bufStart) {
      buf = buf.slice(keep - bufStart);
      bufStart = keep;
    }
  };

  /**
   * @param {UnitKind} unitKind
   * @param {number} start
   * @param {number} end
   * @param {number} line
   * @param {boolean} closed
   */
  const emit = (unitKind, start, end, line, closed) => {
    if (end <= start) return;
    const result = check(Object.freeze({ kind: unitKind, text: slice(start, end), start, end, line, closed }));
    if (result !== null && result !== undefined && result !== false) out.push(result);
  };

  const closeItem = () => {
    if (!item) return;
    const it = item;
    item = null;
    emit('item', it.start, it.end, it.line, !it.cut);
  };

  /** The token before a dot, lowercase; a long token keeps only its end. */
  const addToToken = (/** @type {number} */ c) => {
    token += String.fromCharCode(c);
    if (token.length > 64) token = `x${token.slice(-32)}`;
  };

  /**
   * @param {number} end
   * @param {boolean} closed
   */
  const emitSentence = (end, closed) => {
    const start = sentStart;
    sentStart = -1;
    state = TEXT;
    token = '';
    if (start >= 0) emit('sentence', start, end, sentLine, closed);
  };

  /** End punctuation followed by white space at `p`: a sentence end, unless an abbreviation. */
  const endCandidate = (/** @type {number} */ p) => {
    if (runDot && runLen === 1 && abbreviation(runToken.toLowerCase())) {
      state = TEXT;
      token = '';
      return;
    }
    candEnd = p;
    afterLabel = false;
    state = AFTER;
  };

  /**
   * One character of a paragraph line.
   * @param {number} c
   * @param {number} p
   */
  const para = (c, p) => {
    switch (state) {
      case TEXT:
        if (isSpace(c)) {
          token = '';
          return;
        }
        if (sentStart < 0) {
          sentStart = p;
          sentLine = lineNo;
        }
        if (isEnd(c)) {
          runToken = token;
          runDot = c === 46;
          runLen = 1;
          state = RUN;
        }
        addToToken(c);
        return;
      case RUN:
        if (isEnd(c)) {
          runLen += 1;
          runDot = false;
          addToToken(c);
        } else if (isCloser(c)) {
          state = CLOSE;
          addToToken(c);
        } else if (isSpace(c)) endCandidate(p);
        else {
          state = TEXT; // "3.5", "e.g", "Node.js": no end
          addToToken(c);
        }
        return;
      case CLOSE:
        if (isCloser(c)) addToToken(c);
        else if (isSpace(c)) endCandidate(p);
        else {
          state = TEXT;
          addToToken(c);
        }
        return;
      case AFTER:
        if (isSpace(c)) return;
        if (c === 91) {
          bracketStart = p;
          depth = 1;
          state = BRACKET;
          return;
        }
        if (afterLabel && (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63)) {
          candEnd = p + 1; // "… [Doc: a, Chunk: 1]." keeps its dot
          return;
        }
        emitSentence(candEnd, true);
        trim(p);
        para(c, p);
        return;
      case BRACKET:
        if (c === 91) depth += 1;
        else if (c === 93) depth -= 1;
        if (depth === 0) {
          if (trailer.test(slice(bracketStart, p + 1))) {
            candEnd = p + 1;
            afterLabel = true;
            state = AFTER;
          } else notALabel(p);
        } else if (p - bracketStart > MAX_LABEL) notALabel(p);
        return;
      default:
    }
  };

  /** The bracket after a sentence end is no label: the sentence ends before it, the bracket starts the next. */
  const notALabel = (/** @type {number} */ p) => {
    const from = bracketStart;
    emitSentence(candEnd, true);
    trim(from);
    for (let q = from; q <= p; q += 1) para(buf.charCodeAt(q - bufStart), q);
  };

  /** The paragraph line ends at `p`; at the end of the stream when `final`. */
  const finishParagraph = (/** @type {boolean} */ final) => {
    if (sentStart < 0) return;
    if (state === AFTER) emitSentence(candEnd, true);
    else emitSentence(lastInk + 1, !final || state === RUN || state === CLOSE);
  };

  /** A complete line that was held until its end ("hold" or not decided yet). */
  const heldLine = (/** @type {number} */ p, /** @type {boolean} */ final) => {
    const line = slice(lineBegin, p);
    /** @type {ReturnType<typeof lineType>} */
    const t = markdown ? lineType(line, item !== null, indent) : { type: line.trim() ? 'para' : 'blank' };
    const start = ink;
    const end = lastInk + 1;
    switch (t.type) {
      case 'continuation':
        if (item) {
          item.end = end;
          item.cut = final;
        }
        return;
      case 'item':
        closeItem();
        item = { start, end, line: lineNo, cut: final };
        return;
      case 'fence':
        closeItem();
        fence = { char: t.fence?.char ?? '`', len: t.fence?.len ?? 3, start, line: lineNo };
        return;
      case 'heading':
      case 'row':
        closeItem();
        emit(t.type, start, end, lineNo, !final);
        return;
      case 'para':
        closeItem();
        for (let q = ink; q < p; q += 1) para(buf.charCodeAt(q - bufStart), q);
        finishParagraph(final);
        return;
      default:
        closeItem(); // blank line, rule, table separator
    }
  };

  /** The line that started at lineBegin ends at `p` (a line break, or the end of the stream). */
  const endLine = (/** @type {number} */ p, /** @type {boolean} */ final) => {
    if (fence) {
      const f = fence;
      const line = slice(lineBegin, p);
      const closing = new RegExp(`^[ \\t]{0,3}${f.char === '`' ? '`' : '~'}{${f.len},}[ \\t]*$`);
      if (lineBegin > f.start && closing.test(line)) {
        fence = null;
        emit('code', f.start, lastInk + 1, f.line, true);
      }
    } else if (kind === 'para') finishParagraph(final);
    else if (ink >= 0 || item) heldLine(p, final);
    if (final) return;
    lineNo += 1;
    lineBegin = p + 1;
    kind = null;
    indent = 0;
    head = '';
    ink = -1;
    state = TEXT;
    token = '';
    trim(Math.min(item ? item.start : Infinity, fence ? fence.start : Infinity, lineBegin));
  };

  /** @param {string} delta */
  const feed = (delta) => {
    buf += delta;
    for (let i = 0; i < delta.length; i += 1) {
      const p = pos + i;
      const c = delta.charCodeAt(i);
      if (c === 10) {
        endLine(p, false);
        continue;
      }
      const space = isSpace(c);
      if (!space) lastInk = p;
      if (fence) {
        if (!space && ink < 0) ink = p;
        continue;
      }
      if (kind === null) {
        if (ink < 0) {
          if (space) {
            indent += c === 9 ? 4 : 1;
            continue;
          }
          ink = p;
        }
        if (head.length < 16) head += delta[i];
        const decided = markdown ? lineStart(head, item !== null && indent >= 2) : 'para';
        if (decided === null) continue;
        kind = decided;
        if (decided === 'para') {
          closeItem();
          for (let q = ink; q <= p; q += 1) para(buf.charCodeAt(q - bufStart), q);
        }
        continue;
      }
      if (kind === 'para') para(c, p);
    }
    pos += delta.length;
  };

  return {
    push(delta) {
      if (done) return [];
      out = [];
      feed(String(delta ?? ''));
      return out;
    },
    end() {
      if (done) return [];
      done = true;
      out = [];
      endLine(pos, true);
      closeItem();
      if (fence) {
        const f = fence;
        fence = null;
        emit('code', f.start, lastInk + 1, f.line, false);
      }
      buf = '';
      return out;
    },
    abort() {
      if (done) return { dropped: 0 };
      done = true;
      const dropped = (sentStart >= 0 ? 1 : 0) + (item ? 1 : 0) + (fence ? 1 : 0) + (kind !== 'para' && ink >= 0 && !fence ? 1 : 0);
      buf = '';
      item = null;
      fence = null;
      sentStart = -1;
      return { dropped };
    },
    get done() {
      return done;
    },
  };
}
