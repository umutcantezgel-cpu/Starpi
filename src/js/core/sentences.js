// @ts-check
// Sentence splitting with offsets. Deterministic on purpose (no Intl.Segmenter, whose rules depend
// on the ICU version of each browser and Node), so a receipt verified elsewhere splits the same way.
import { fromPacks } from './lang/index.js';

/**
 * Tokens that end with a dot without ending a sentence: the abbreviations and short month names of
 * every registered language pack (lang/index.js).
 */
const abbreviations = fromPacks((packs) => new Set(packs.flatMap((p) => [...p.abbreviations, ...Object.keys(p.monthAbbreviations)])));

/**
 * Whether a dot after this token leaves the sentence open: an ordinal or a day and month ("3.",
 * "1.6."), or an abbreviation of a language pack. Also used by the streaming releaser (release.js).
 * @param {string} token lowercase, without the final dot
 */
export function isAbbreviation(token) {
  const word = token.replace(/^[^\p{L}\p{N}]+/u, '');
  if (/^\d{1,2}$/.test(word)) return true; // ordinals: "am 3. März"; a year ends a sentence
  if (/^\d{1,2}\.\d{1,2}$/.test(word)) return true; // German day and month: "vom 1.6. bis 31.8."
  const known = abbreviations();
  if (known.has(word)) return true;
  // "e.g", "z.B", "u.a": the last dot-separated part decides.
  const last = word.includes('.') ? word.slice(word.lastIndexOf('.') + 1) : '';
  return last !== '' && known.has(last);
}

/** A time of day with "h" between hours and minutes, at the end of a text ("12 h 00", "9h30"). */
const CLOCK_MINUTES = /(?<![\p{L}\p{N}])\d{1,2}\s?h\s?\d{2}$/iu;

/**
 * Units at the end of a text that decide CLOCK_MINUTES: its match is at most 7 units long and its
 * lookbehind reads one code point (2 units at most) before it. Testing only this tail keeps a long
 * run of abbreviations ("1. 2. 3. …") linear.
 */
const CLOCK_TAIL = 16;

/** One UTF-16 unit of whitespace, as `\s` reads it. */
const SPACE = /\s/;

/**
 * Sentence spans in `text`: offsets into the original string, trimmed of surrounding whitespace.
 * Line breaks always end a sentence; `.`, `!` and `?` end one when whitespace and more text follow,
 * except after ordinals, decimals and known abbreviations.
 * @param {string} text
 * @returns {Array<{ start: number, end: number }>}
 */
export function sentenceSpans(text) {
  /** @type {Array<{ start: number, end: number }>} */
  const out = [];
  const push = (/** @type {number} */ s, /** @type {number} */ e) => {
    while (s < e && /\s/.test(text[s])) s += 1;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    if (e > s) out.push({ start: s, end: e });
  };
  const lines = /[^\n]+/g;
  let line;
  while ((line = lines.exec(text)) !== null) {
    const base = line.index;
    const content = line[0];
    // Scanned by hand: the patterns /[.!?]+(?=\s+\S)/ and /(\S+)$/ backtrack in polynomial time on
    // long runs of punctuation, whitespace or one token (CodeQL js/polynomial-redos). Same spans.
    let last = content.length - 1; // the last unit that is not whitespace
    while (last >= 0 && SPACE.test(content[last])) last -= 1;
    let start = 0;
    const stops = /[.!?]+/g;
    let m;
    while ((m = stops.exec(content)) !== null) {
      const end = m.index + m[0].length;
      // A stop ends a sentence only when whitespace follows it and more text after that.
      if (end >= last || !SPACE.test(content[end])) continue;
      let from = m.index; // the token before the stop: the non-whitespace units since `start`
      while (from > start && !SPACE.test(content[from - 1])) from -= 1;
      const lastToken = content.slice(from, m.index).toLowerCase();
      // The minutes of a time written with "h" ("de 8 h 30 à 12 h 00.") are no ordinal: the dot ends the sentence.
      if (m[0] === '.' && isAbbreviation(lastToken) && !CLOCK_MINUTES.test(content.slice(Math.max(start, m.index - CLOCK_TAIL), m.index))) continue;
      push(base + start, base + end);
      start = end;
    }
    push(base + start, base + content.length);
  }
  return out;
}

/**
 * Splits text into sentences without breaking ordinals, decimals or abbreviations; whitespace inside
 * a sentence is collapsed.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return sentenceSpans(text)
    .map((s) => text.slice(s.start, s.end).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * The first `end` UTF-16 units of `text`, one fewer when that would split a surrogate pair (an
 * emoji), so the result stays well-formed Unicode for hashing and JSON.
 * @param {string} text
 * @param {number} end
 */
export function safeSlice(text, end) {
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}
