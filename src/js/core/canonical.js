// @ts-check
// Origin: generic infrastructure first written for Fluid Systems (same author, MIT); re-expressed for Starpi.
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
//   4. White space collapses to single spaces, without a space before . , ; : ! ? ) ] or after ( [.
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
const HTML = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g;
const STRIKE = /~~(?=\S)[^~\n]*?\S~~/g;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const IS_ALNUM = /[\p{L}\p{Nd}]/u;
const DROP_CHAR = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;
const SPACE_CHAR = /[\p{Zs}  ]/u;
const MARK = /\p{M}/u;
/** No space before these, and none after an opening bracket. */
const NO_SPACE_BEFORE = new Set(['.', ',', ';', ':', '!', '?', ')', ']']);
const NO_SPACE_AFTER = new Set(['(', '[']);

/**
 * Marks the Markdown of one unit: 1 drops a character, a string in `swap` replaces it.
 * @param {string} text
 * @param {UnitKind | undefined} kind
 */
function markdownMarks(text, kind) {
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
  for (const m of text.matchAll(HTML)) {
    if (/^<br\b/i.test(m[0])) swap.set(/** @type {number} */ (m.index), ' ');
    else dropRange(/** @type {number} */ (m.index), /** @type {number} */ (m.index) + m[0].length);
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

/**
 * Collapses white space in a sequence of [text, input index] pieces into a canonical text.
 * @param {Array<[string, number]>} pieces  single code points
 * @returns {Canonical}
 */
function collapse(pieces) {
  /** @type {string[]} */
  const out = [];
  /** @type {number[]} */
  const map = [];
  let space = -1;
  let last = '';
  let marks = false;
  for (const [ch, at] of pieces) {
    if (ch === ' ') {
      if (space < 0) space = at;
      continue;
    }
    if (space >= 0 && out.length && !NO_SPACE_BEFORE.has(ch) && !NO_SPACE_AFTER.has(last)) {
      out.push(' ');
      map.push(space);
    }
    space = -1;
    out.push(ch);
    for (let k = 0; k < ch.length; k += 1) map.push(at);
    last = ch;
    if (!marks && ch.charCodeAt(0) >= 0x300 && MARK.test(ch)) marks = true;
  }
  if (!marks) return { text: out.join(''), map };
  // NFC, one base character with its marks at a time, so the map stays exact.
  /** @type {Array<[string, number]>} */
  const composed = [];
  let group = '';
  let groupAt = 0;
  const flush = () => {
    if (group) for (const ch of group.normalize('NFC')) composed.push([ch, groupAt]);
    group = '';
  };
  let pos = 0;
  for (const ch of out) {
    if (MARK.test(ch) && group) group += ch;
    else {
      flush();
      group = ch;
      groupAt = map[pos];
    }
    pos += ch.length;
  }
  flush();
  const text = composed.map(([ch]) => ch).join('');
  /** @type {number[]} */
  const composedMap = [];
  for (const [ch, at] of composed) for (let k = 0; k < ch.length; k += 1) composedMap.push(at);
  return { text, map: composedMap };
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
  /** @type {Array<[string, number]>} */
  const pieces = [];
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 128) {
      if (drop[i]) continue;
      const s = swap.get(i);
      if (s !== undefined) pieces.push([s, i]);
      else if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13) pieces.push([' ', i]);
      else if (code >= 32 && code !== 127) pieces.push([input[i], i]);
      continue;
    }
    const cp = /** @type {number} */ (input.codePointAt(i));
    const width = cp > 0xffff ? 2 : 1;
    if (drop[i]) {
      i += width - 1;
      continue;
    }
    const ch = String.fromCodePoint(cp);
    i += width - 1;
    if (SPACE_CHAR.test(ch)) pieces.push([' ', i - width + 1]);
    else if (DROP_CHAR.test(ch)) continue;
    else if (cp === 0x2212 || (cp >= 0x2010 && cp <= 0x2012)) pieces.push(['-', i]);
    else if (cp >= 0xff01 && cp <= 0xff5e) pieces.push([String.fromCharCode(cp - 0xfee0), i]);
    else if (cp === 0x3bc) pieces.push(['µ', i]);
    else if (cp === 0x2126) pieces.push(['Ω', i]);
    else pieces.push([ch, i - width + 1]);
  }
  return collapse(pieces);
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
  /** @type {Array<[string, number]>} */
  const pieces = [];
  const { text, map } = canonical;
  let r = 0;
  for (let i = from; i < to; i += 1) {
    while (r < ranges.length && ranges[r][1] <= i) r += 1;
    if (r < ranges.length && ranges[r][0] <= i) {
      if (ranges[r][0] === i || i === from) pieces.push([' ', map[i]]);
      continue;
    }
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < to) {
      pieces.push([text.slice(i, i + 2), map[i]]);
      i += 1;
    } else pieces.push([text[i], map[i]]);
  }
  return collapse(pieces);
}
