// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// Canonical text for the sentence gate (gate.js): the single form of a sentence that is judged, shown
// and spoken, so nothing the gate did not read can hide or join a number afterwards. The steps:
//   1. Markdown marks go: list markers, heading and quote marks at the start of a line, emphasis
//      (* _ outside words), code ticks, strikethrough with its text, backslash escapes, HTML tags;
//      table cells are joined with "; ". A fenced code block keeps its lines and loses its fences.
//   2. Invisible and private characters go: default-ignorable code points (zero-width characters,
//      bidi controls, variation selectors, soft hyphens, tags), other format and control
//      characters, private-use and unassigned code points.
//   3. A small explicit normalisation: the minus sign and the Unicode hyphens become "-", fullwidth
//      ASCII becomes ASCII (fullwidth digits are then read as digits), the Greek mu becomes the micro
//      sign; then NFC, never NFKC (NFKC would turn "m²" into "m2" and "½" into "1⁄2").
//   4. White space collapses to single spaces, without a space before . , ; : ! ? ) ] or after ( [
//      (but " .5" keeps its space: the dot belongs to the number).
//
// The character allowlist says what a released sentence may contain: Latin letters (ASCII, Latin-1
// and Latin Extended-A), the digits 0–9, the space, a fixed set of punctuation and signs, and the
// extra characters of every registered language pack (lang/, `gate.chars`). Anything else, such as
// other scripts and digit systems, combining marks, superscripts other than ² and ³, vulgar
// fractions or look-alike dots and dashes, keeps a sentence from being released.
//
// Pure: no DOM, runs in the browser, in workers and in Node.
import { fromPacks } from './lang/index.js';

/**
 * Text with, for each of its UTF-16 code units, the index in the input it came from.
 * @typedef {object} Canonical
 * @property {string} text
 * @property {number[]} map
 */

/** @typedef {'sentence' | 'item' | 'row' | 'heading' | 'code'} UnitKind */

/** Signs and punctuation of the shared allowlist, beyond ASCII letters and digits. */
const SHARED_SIGNS = ` .,;:!?'"()[]-/%&+=<>#@$~_°±²³µ§€£¥¢©®×÷«»–—‘’‚“”„‹›…•™Ω`;

/** ASCII lookup: 1 when the code point is allowed. */
const ASCII_ALLOWED = new Uint8Array(128);
for (let c = 0; c < 128; c += 1) {
  const ch = String.fromCharCode(c);
  if (/[A-Za-z0-9]/.test(ch) || SHARED_SIGNS.includes(ch)) ASCII_ALLOWED[c] = 1;
}

/** The extra characters of all registered packs, with the shared signs outside ASCII. */
const extraChars = fromPacks((packs) => new Set([...SHARED_SIGNS, ...packs.flatMap((p) => [...p.gate.chars])].filter((ch) => ch.charCodeAt(0) >= 128)));

/**
 * Whether one code point may appear in a released sentence.
 * @param {number} cp
 */
export function isAllowedChar(cp) {
  if (cp < 128) return ASCII_ALLOWED[cp] === 1;
  // Latin-1 letters (without × and ÷, which are signs below) and Latin Extended-A.
  if ((cp >= 0xc0 && cp <= 0x17f && cp !== 0xd7 && cp !== 0xf7)) return true;
  return extraChars().has(String.fromCodePoint(cp));
}

/**
 * The first character that keeps a canonical text from being released, or null.
 * @param {string} text
 * @returns {{ index: number, char: string } | null}
 */
export function firstDisallowed(text) {
  for (let i = 0; i < text.length; i += 1) {
    const cp = /** @type {number} */ (text.codePointAt(i));
    if (!isAllowedChar(cp)) return { index: i, char: String.fromCodePoint(cp) };
    if (cp > 0xffff) i += 1;
  }
  return null;
}

/** Describes a character for a reason: the character and its code point. */
export function describeChar(/** @type {string} */ char) {
  return `${char} U+${(/** @type {number} */ (char.codePointAt(0))).toString(16).toUpperCase().padStart(4, '0')}`;
}

// Markdown at the start of a line: quote marks, then a heading mark (with a section number) or a
// list marker (with a task box).
const LINE_START = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}(?=[ \t]|$)(?:[ \t]+\d{1,2}(?:\.\d{1,2})*\.(?=[ \t]))?|(?:[-*+•]|\d{1,9}[.)])(?=[ \t]|$)(?:[ \t]+\[[ xX]\](?=[ \t]|$))?)?/;
const HEADING_CLOSE = /[ \t]+#+[ \t]*$/;
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})/;
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g;
const STRIKE = /~~(?=\S)[^~\n]*?\S~~/g;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const IS_ALNUM = /[\p{L}\p{Nd}]/u;
const DROP_CHAR = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;
const SPACE_CHAR = /[\p{Zs}\u2028\u2029]/u;
const MARK = /\p{M}/u;

/** Signs that may be Markdown anywhere in a line, and the starts of lines that may be. */
const INLINE_MARKS = /[*_`~\\<|]/;
const BLOCK_MARKS = /(?:^|\n)[ \t]*(?:[>#|*+•-]|\d{1,9}[.)])/;
const NO_MARKS = { drop: new Uint8Array(0), swap: new Map() };

/**
 * Marks the Markdown of one unit: 1 drops a character, a string in `swap` replaces it.
 * @param {string} text
 * @param {UnitKind | undefined} kind
 * @returns {{ drop: Uint8Array, swap: Map<number, string> }}
 */
function markdownMarks(text, kind) {
  // Most sentences have no Markdown at all.
  if (kind !== 'code' && !INLINE_MARKS.test(text) && !BLOCK_MARKS.test(text)) return NO_MARKS;
  const drop = new Uint8Array(text.length);
  /** @type {Map<number, string>} */
  const swap = new Map();
  const dropRange = (/** @type {number} */ s, /** @type {number} */ e) => drop.fill(1, s, e);
  /** @type {Array<[number, number]>} */
  const lines = [];
  for (let s = 0; s <= text.length; ) {
    const nl = text.indexOf('\n', s);
    const e = nl < 0 ? text.length : nl;
    lines.push([s, e]);
    s = e + 1;
    if (nl < 0) break;
  }
  if (kind === 'code') {
    // The fences go; the code stays as written.
    const [first, last] = [lines[0], lines[lines.length - 1]];
    if (first && FENCE_LINE.test(text.slice(first[0], first[1]))) dropRange(first[0], first[1]);
    if (last && last !== first && /^[ \t]*(?:`{3,}|~{3,})[ \t]*$/.test(text.slice(last[0], last[1]))) dropRange(last[0], last[1]);
    return { drop, swap };
  }
  for (const [s, e] of lines) {
    const line = text.slice(s, e);
    if (/^\s*\|/.test(line) && TABLE_SEPARATOR.test(line) && line.includes('-')) {
      dropRange(s, e);
      continue;
    }
    const start = LINE_START.exec(line);
    if (start && start[0].length) dropRange(s, s + start[0].length);
    if (start && /#/.test(start[0])) {
      const close = HEADING_CLOSE.exec(line);
      if (close) dropRange(s + close.index, e);
    }
    // A table row: the outer pipes go, the inner ones separate cells.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('|')) {
      const first = s + line.indexOf('|');
      drop[first] = 1;
      const lastPipe = line.trimEnd().endsWith('|') ? s + line.trimEnd().length - 1 : -1;
      if (lastPipe > first) drop[lastPipe] = 1;
      for (let i = first + 1; i < (lastPipe > first ? lastPipe : e); i += 1) {
        if (text[i] === '|' && text[i - 1] !== '\\') swap.set(i, ';');
      }
    }
  }
  // HTML comments: found with indexOf, so a text full of unclosed "<!--" stays linear.
  for (let from = text.indexOf('<!--'); from >= 0; from = text.indexOf('<!--', from)) {
    const close = text.indexOf('-->', from + 4);
    if (close < 0) break;
    dropRange(from, close + 3);
    from = close + 3;
  }
  for (const m of text.matchAll(HTML_TAG)) {
    const at = /** @type {number} */ (m.index);
    if (drop[at]) continue;
    if (/^<br\b/i.test(m[0])) {
      swap.set(at, ' '); // a line break is a space
      dropRange(at + 1, at + m[0].length);
    } else dropRange(at, at + m[0].length);
  }
  for (const m of text.matchAll(STRIKE)) dropRange(/** @type {number} */ (m.index), /** @type {number} */ (m.index) + m[0].length);
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (drop[i]) continue;
    if (c === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      drop[i] = 1;
      i += 1; // the escaped character stays, whatever it is
      continue;
    }
    if (c === '`') drop[i] = 1;
    else if (c === '~' && text[i + 1] === '~') {
      drop[i] = 1;
      drop[i + 1] = 1;
      i += 1;
    } else if (c === '*' || c === '_') {
      let j = i;
      while (j < text.length && (text[j] === '*' || text[j] === '_')) j += 1;
      // Inside a word ("snake_case", "5*3") the run is text; at a word edge it is emphasis.
      const inside = i > 0 && IS_ALNUM.test(text[i - 1]) && j < text.length && IS_ALNUM.test(text[j]);
      if (!inside) dropRange(i, j);
      i = j - 1;
    }
  }
  return { drop, swap };
}

/** No space before . , ; : ! ? ) ] (by code). */
const noSpaceBefore = (/** @type {number} */ c) => c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 41 || c === 93;

const KEEP = 0;
const SPACE = 1;
const DROP = 2;
const COMBINING = 3;
/** Classes of the code points outside ASCII seen so far (bounded, so a text of many scripts cannot grow it without end). */
const classes = new Map();

/**
 * Whether a code point outside ASCII is white space, dropped, a combining mark or kept.
 * @param {number} cp
 */
function classOf(cp) {
  let k = classes.get(cp);
  if (k === undefined) {
    const ch = String.fromCodePoint(cp);
    k = SPACE_CHAR.test(ch) ? SPACE : DROP_CHAR.test(ch) ? DROP : MARK.test(ch) ? COMBINING : KEEP;
    if (classes.size >= 4096) classes.clear();
    classes.set(cp, k);
  }
  return k;
}

/**
 * Builds a canonical text one character at a time: white space collapses to one space, with none
 * at either end, before closing punctuation or after an opening bracket; every UTF-16 unit keeps
 * the input index it came from. Characters taken over unchanged are copied as runs of the source
 * string, so plain text costs little more than its map.
 */
class Builder {
  /** @param {string} source  the string `keep` copies from */
  constructor(source) {
    this.source = source;
    /** @type {string[]} */
    this.parts = [];
    /** @type {number[]} */
    this.map = [];
    this.len = 0;
    this.runStart = 0;
    this.runEnd = -1;
    this.pending = -1; // map value of a pending space
    this.pendingAt = -1; // its source index, when it is a single ASCII space
    this.last = 0;
    this.marks = false;
  }

  /**
   * A space in the source.
   * @param {number} i   source index
   * @param {number} at  map value
   */
  space(i, at) {
    if (this.pending < 0) {
      this.pending = at;
      this.pendingAt = this.source.charCodeAt(i) === 32 ? i : -1;
    } else this.pendingAt = -1;
  }

  flushRun() {
    if (this.runEnd > this.runStart) this.parts.push(this.source.slice(this.runStart, this.runEnd));
    this.runEnd = -1;
  }

  /**
   * @param {number} code  the character that follows the pending space
   * @param {number} next  the code unit after that character (a digit after "." keeps the space: " .5")
   */
  flushSpace(code, next) {
    const at = this.pending;
    this.pending = -1;
    const decimal = (code === 46 || code === 44) && next >= 48 && next <= 57;
    if (!this.len || (noSpaceBefore(code) && !decimal) || this.last === 40 || this.last === 91) return;
    if (this.pendingAt >= 0 && this.pendingAt === this.runEnd) this.runEnd += 1; // the single space continues the run
    else {
      this.flushRun();
      this.parts.push(' ');
    }
    this.map[this.len++] = at;
  }

  /**
   * A character of the source, taken over unchanged.
   * @param {number} i      source index
   * @param {number} code   its first UTF-16 unit
   * @param {number} width  1, or 2 for a surrogate pair
   * @param {number} at     map value
   */
  keep(i, code, width, at) {
    if (this.pending >= 0) this.flushSpace(code, this.source.charCodeAt(i + 1));
    if (this.runEnd !== i) {
      this.flushRun();
      this.runStart = i;
    }
    this.runEnd = i + width;
    this.map[this.len++] = at;
    if (width === 2) this.map[this.len++] = at;
    this.last = code;
  }

  /**
   * A character that replaces the source (one UTF-16 unit).
   * @param {string} ch
   * @param {number} at  map value
   */
  char(ch, at) {
    const code = ch.charCodeAt(0);
    if (this.pending >= 0) this.flushSpace(code, -1);
    this.flushRun();
    this.parts.push(ch);
    this.map[this.len++] = at;
    this.last = code;
  }

  /** @returns {Canonical} */
  finish() {
    this.flushRun();
    const text = this.parts.length === 1 ? this.parts[0] : this.parts.join('');
    return this.marks ? compose(text, this.map) : { text, map: this.map };
  }
}

/** Composed forms of base characters with their marks seen so far (bounded). */
const composed = new Map();

/**
 * NFC, one base character with its combining marks at a time, so the map stays exact.
 * @param {string} text
 * @param {number[]} map
 * @returns {Canonical}
 */
function compose(text, map) {
  if (text.normalize('NFC') === text) return { text, map };
  /** @type {string[]} */
  const parts = [];
  /** @type {number[]} */
  const out = [];
  let len = 0;
  let i = 0;
  while (i < text.length) {
    const start = i;
    const first = /** @type {number} */ (text.codePointAt(i));
    i += first > 0xffff ? 2 : 1;
    const single = i;
    while (i < text.length) {
      const cp = /** @type {number} */ (text.codePointAt(i));
      if (cp < 0x300 || classOf(cp) !== COMBINING) break;
      i += cp > 0xffff ? 2 : 1;
    }
    if (i === single) {
      parts.push(text.slice(start, i));
      for (let k = start; k < i; k += 1) out[len++] = map[k];
      continue;
    }
    const raw = text.slice(start, i);
    let group = composed.get(raw);
    if (group === undefined) {
      group = raw.normalize('NFC');
      if (composed.size >= 1024) composed.clear();
      composed.set(raw, group);
    }
    parts.push(group);
    for (let k = 0; k < group.length; k += 1) out[len++] = map[start];
  }
  return { text: parts.join(''), map: out };
}

/**
 * The canonical form of one unit of text (a sentence, list item, table row, heading or code block),
 * with the input index of every character.
 * @param {string} text
 * @param {{ kind?: UnitKind }} [options]
 * @returns {Canonical}
 */
export function canonicalize(text, options = {}) {
  const input = String(text ?? '');
  const { drop, swap } = markdownMarks(input, options.kind);
  const b = new Builder(input);
  const swaps = swap.size > 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 128) {
      if (drop[i]) continue;
      const s = swaps ? swap.get(i) : undefined;
      if (s !== undefined) {
        if (s === ' ') b.space(i, i);
        else b.char(s, i);
      } else if (code === 32 || (code >= 9 && code <= 13)) b.space(i, i);
      else if (code > 32 && code !== 127) b.keep(i, code, 1, i);
      continue;
    }
    const cp = /** @type {number} */ (input.codePointAt(i));
    const at = i;
    const width = cp > 0xffff ? 2 : 1;
    i += width - 1;
    if (drop[at]) continue;
    const k = classOf(cp);
    if (k === SPACE) b.space(at, at);
    else if (k === DROP) continue;
    else if (cp === 0x2212 || (cp >= 0x2010 && cp <= 0x2012)) b.char('-', at);
    else if (cp >= 0xff01 && cp <= 0xff5e) b.char(String.fromCharCode(cp - 0xfee0), at);
    else if (cp === 0x3bc) b.char('µ', at);
    else if (cp === 0x2126) b.char('Ω', at);
    else {
      if (k === COMBINING) b.marks = true;
      b.keep(at, code, width, at);
    }
  }
  return b.finish();
}

/**
 * The canonical text of a unit (see canonicalize).
 * @param {string} text
 * @param {{ kind?: UnitKind }} [options]
 */
export function canonicalText(text, options = {}) {
  return canonicalize(text, options).text;
}

/**
 * A canonical text with some ranges blanked out (citation labels), white space collapsed again;
 * the map still points into the original input.
 * @param {Canonical} canonical
 * @param {Array<[number, number]>} ranges  sorted, non-overlapping [start, end) in canonical.text
 * @param {number} [from]  start of the part to keep
 * @param {number} [to]    end of the part to keep
 * @returns {Canonical}
 */
export function blankRanges(canonical, ranges, from = 0, to = canonical.text.length) {
  const { text, map } = canonical;
  const b = new Builder(text);
  let r = 0;
  for (let i = from; i < to; i += 1) {
    while (r < ranges.length && ranges[r][1] <= i) r += 1;
    if (r < ranges.length && ranges[r][0] <= i) {
      b.space(i, map[i]);
      b.pendingAt = -1;
      i = Math.min(ranges[r][1], to) - 1;
      continue;
    }
    const code = text.charCodeAt(i);
    if (code === 32) b.space(i, map[i]);
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < to) {
      b.keep(i, code, 2, map[i]);
      i += 1;
    } else b.keep(i, code, 1, map[i]);
  }
  return b.finish();
}
