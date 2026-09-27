// @ts-check
// Sentence splitting with offsets. Deterministic on purpose (no Intl.Segmenter, whose rules depend
// on the ICU version of each browser and Node), so a receipt verified elsewhere splits the same way.

/** Tokens that end with a dot without ending a sentence (German and English). */
const ABBREVIATIONS = new Set([
  'z', 'b', 'bzw', 'ca', 'nr', 'dr', 'st', 'usw', 'vgl', 'inkl', 'ggf', 'evtl', 'etc', 'u', 'a', 'd', 'h', 'mio', 'mrd',
  'tsd', 'inc', 'corp', 'ltd', 'vs', 'e', 'g', 'i', 'mr', 'mrs', 'ms', 'prof', 'jr', 'sr', 'fig', 'approx', 'abs',
  'tel', 'jan', 'feb', 'mär', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'okt', 'oct', 'nov', 'dez', 'dec',
]);

/** @param {string} token lowercase, without the final dot */
function isAbbreviation(token) {
  const word = token.replace(/^[^\p{L}\p{N}]+/u, '');
  if (/^\d{1,2}$/.test(word)) return true; // ordinals: "am 3. März"; a year ends a sentence
  if (/^\d{1,2}\.\d{1,2}$/.test(word)) return true; // German day and month: "vom 1.6. bis 31.8."
  if (ABBREVIATIONS.has(word)) return true;
  // "e.g", "z.B", "u.a": the last dot-separated part decides.
  const last = word.includes('.') ? word.slice(word.lastIndexOf('.') + 1) : '';
  return last !== '' && ABBREVIATIONS.has(last);
}

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
    let start = 0;
    const ends = /[.!?]+(?=\s+\S)/g;
    let m;
    while ((m = ends.exec(content)) !== null) {
      const lastToken = (content.slice(start, m.index).match(/(\S+)$/)?.[1] ?? '').toLowerCase();
      if (m[0] === '.' && isAbbreviation(lastToken)) continue;
      push(base + start, base + m.index + m[0].length);
      start = m.index + m[0].length;
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
