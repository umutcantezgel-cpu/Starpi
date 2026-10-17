// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// Numbers in a sentence, for the sentence gate (gate.js) and the spoken form (spoken.js): numbers
// written in digits, numbers written as words, the identifiers that contain digits without being
// numbers, and the places where numbers are joined so that a reader would hear another number than
// the one written.
//
// Number words come from the language packs (lang/, `gate.numberWords`). Each word is tagged:
//   cardinal    "twelve", "zweihundert"            a claim
//   fraction    "a quarter", "drei Viertel"        a claim
//   multiplier  "twice", "dreifach"                a claim
//   ordinal     "first", "dritte", "3rd"           never a claim
//   adverb      "once", "einmal", "einfach"        never a claim
// "half" and "double" (each pack's `contextual` words) are claims only when a unit or a counted
// thing follows within two words: "half an hour" states a quantity, "double-check" does not. "one"
// and the German article "ein" state nothing on their own, only inside a larger number ("one
// hundred", "einhundert"), and neither does a scale word in the plural ("Millionen Menschen"). A
// language that writes a number as one word (German) has its words read by splitting them into the
// pack's cardinals, scales and joiners, with the pack's endings for ordinals ("zwanzigste"),
// fractions ("Viertel") and multipliers ("dreifach", "zehnmal").
//
// Digits are read as written. "1.200" and "2,500" (one separator before exactly three digits) mean
// a thousand times more in one convention than in the other, so they only ever match the same
// written form; every other form has the same value in every convention. Dates, times, versions and
// addresses ("28.08.2026", "14:30", "1.2.3") are compound forms with no single value.
//
// Pure: no DOM, runs in the browser, in workers and in Node.
import { parseNumber } from './facts.js';
import { anyOf, fromPacks, languagePack } from './lang/index.js';

/** @typedef {import('./lang/index.js').LanguagePack} LanguagePack */
/** @typedef {'cardinal' | 'fraction' | 'multiplier' | 'ordinal' | 'adverb'} NumberWordKind */

/** The five kinds of number words; the first three state a quantity. */
export const NUMBER_WORD_KINDS = Object.freeze(/** @type {NumberWordKind[]} */ (['cardinal', 'fraction', 'multiplier', 'ordinal', 'adverb']));

/**
 * @typedef {object} NumberItem      a number written in digits
 * @property {'number'} type
 * @property {string} raw            as written, with its sign and scale word
 * @property {number} start
 * @property {number} end
 * @property {string} written        the form to match when the value is ambiguous or absent
 * @property {number | null} value   null for compound forms (dates, times, versions)
 * @property {boolean} ambiguous     "1.200": the value depends on the convention
 * @property {number} scale          1, or the factor of the scale word after it ("4.5 million")
 */

/**
 * @typedef {object} WordItem        a number written as words
 * @property {'word'} type
 * @property {string} raw
 * @property {number} start
 * @property {number} end
 * @property {NumberWordKind} kind
 * @property {number} value
 * @property {boolean} claim         it states a quantity
 */

/**
 * @typedef {object} IdentifierItem  a code with digits that is no number ("ISO 9001", "COVID-19", "IPv6")
 * @property {'identifier'} type
 * @property {string} raw
 * @property {number} start
 * @property {number} end
 * @property {string[]} keys         lowercase forms, any of which in a source supports it
 */

/**
 * @typedef {object} JoinedItem      digits a reader would hear as another number ("4 80", "5OO", "10³", "5 hundred", "5‚5", ".5")
 * @property {'joined'} type
 * @property {string} raw
 * @property {number} start
 * @property {number} end
 * @property {boolean} [lookalike]   letters that pass for digits ("5OO", "l5"); fine when a cited excerpt has the same token
 */

/** @typedef {NumberItem | WordItem | IdentifierItem | JoinedItem} ScanItem */

/**
 * @typedef {object} ScanOptions
 * @property {string | null} [locale]    read number words in this language only; without one, in every registered language
 * @property {boolean} [lenient]         for sources: contextual words count without a unit after them
 * @property {RegExp[]} [identifierPatterns]  more identifiers; digits inside a match are no numbers
 */

/** Letters that pass for digits next to digits: O and o for 0, l and I for 1, and their kin. */
const LOOKALIKE = new Set([...'OoØøÒÓÔÕÖòóôõöŌōŎŏŐőlIıÌÍÎÏìíîïĪīĬĭĮįİĺļľŀł']);
/** Unit signs written straight after digits ("10kg", "5ms"). Case matters: "4K" is no "4k". */
const UNIT_SIGNS = new Set([
  'x', 'h', 'min', 's', 'ms', 'µs', 'ns', 'kg', 'g', 'mg', 't', 'km', 'm', 'cm', 'mm', 'µm', 'nm', 'ml', 'l', 'GB', 'MB', 'TB', 'KB',
  'kB', 'Gbit', 'Mbit', 'px', 'pt', 'Hz', 'kHz', 'MHz', 'GHz', 'kW', 'MW', 'kWh', 'MWh',
]);
/** Currency codes that make "EUR480" an amount rather than a code. */
const CURRENCY_CODES = new Set(['eur', 'usd', 'chf', 'gbp', 'jpy', 'cny', 'cad', 'aud']);
/** Bodies whose standard numbers are identifiers ("ISO 9001", "DIN EN ISO 13485", "RFC 9110"). */
const STANDARD_PREFIXES = new Set(['ISO', 'IEC', 'EN', 'DIN', 'RFC', 'IEEE', 'ANSI', 'ASTM', 'ECMA', 'ETSI', 'ITU-T', 'ITU-R', 'NIST', 'BS', 'CEN', 'VDE', 'VDI', 'JIS']);

/** Words, numbers and codes: letters and digits, joined inside by - . , : ' ’ or /. */
const TOKEN = /[\p{L}\p{Nd}]+(?:[-.,:'’/][\p{L}\p{Nd}]+)*/gu;
/** Digit groups after a one- to three-digit number, separated by single spaces ("480 000", "1 234,5"). */
const SPACE_GROUPS = /(?: \d{3}(?=[\s.,;:!?)\]\-–—/%]|$))+(?:[.,]\d+)?(?![\p{L}\p{Nd}])/uy;
/** Signs between two numbers in digits that make them read as one ("5‚5", "5.,5", "5…5"); a single "." "," "'" or "’" is already part of the number. */
const SEPARATOR_GAP = /^[.,'’‘‚´`…]+$/;
/** Words before a standard number that name its body, at most ("DIN EN ISO 13485"). */
const MAX_BODY_WORDS = 4;
const DIGIT = /\d/;
/** White space of a canonical text (and of plain text). */
const isSpaceCode = (/** @type {number} */ c) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x202f;
/** A letter right at `at`, or after one space: only then can a scale word follow a number. */
const letterAt = (/** @type {string} */ text, /** @type {number} */ at) => LETTER.test(text[at] ?? '') || (text[at] === ' ' && LETTER.test(text[at + 1] ?? ''));
const LETTER = /\p{L}/u;
const ALNUM = /[\p{L}\p{Nd}]/u;

/**
 * Canonical key of a value: six decimals, the sign kept.
 * @param {number} n
 */
export function valueKey(n) {
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * @typedef {object} Morpheme
 * @property {string} w
 * @property {number} v
 * @property {'unit' | 'scale' | 'joiner'} role
 */

/**
 * @typedef {object} WordTag
 * @property {NumberWordKind} kind
 * @property {number} value
 * @property {'unit' | 'ten' | 'hundred' | 'group'} shape  how it combines with the next word
 * @property {boolean} scale       a scale word ("thousand")
 * @property {boolean} alone       no claim when it stands alone ("one", "ein", "Millionen")
 * @property {boolean} contextual  a claim only with a unit or counted thing after it
 */

/**
 * @typedef {object} PackTable
 * @property {string} code
 * @property {Map<string, WordTag>} words
 * @property {Morpheme[]} morphemes      for splitting compound words, longest first
 * @property {Array<{ s: string, kind: NumberWordKind }>} suffixes  longest first
 * @property {boolean} compound
 * @property {Set<string>} joiners
 * @property {Set<string>} countNouns
 * @property {Set<string>} fractionLeads
 * @property {Set<string>} negative
 * @property {RegExp} unitWord           a whole word that is a unit, percent or currency word of the pack
 */

/**
 * @param {number} value
 * @param {boolean} scale
 * @returns {WordTag['shape']}
 */
function shapeOf(value, scale) {
  if (scale) return value >= 1000 ? 'group' : 'hundred';
  return value >= 20 && value < 100 && value % 10 === 0 ? 'ten' : 'unit';
}

/**
 * @param {LanguagePack} pack
 * @returns {PackTable}
 */
function compile(pack) {
  const n = pack.gate.numberWords;
  const parts = new Set(n.parts);
  const contextual = new Set(n.contextual);
  const scales = Object.entries(n.scales);
  /** @type {Map<string, WordTag>} */
  const words = new Map();
  const put = (/** @type {string} */ w, /** @type {NumberWordKind} */ kind, /** @type {number} */ value, scale = false) => {
    if (words.has(w)) return;
    // A scale word in the plural: a singular with the same value is a prefix of it ("Million", "Millionen").
    const plural = scale && scales.some(([u, v]) => v === value && u !== w && w.startsWith(u));
    words.set(w, { kind, value, shape: shapeOf(value, scale), scale, alone: parts.has(w) || plural, contextual: contextual.has(w) });
  };
  // Adverbs first: "einfach" is no multiplier and "einmal" no count.
  for (const w of n.adverbs) put(w, 'adverb', 0);
  for (const [w, v] of Object.entries(n.fractions)) put(w, 'fraction', v);
  for (const [w, v] of Object.entries(n.multipliers)) put(w, 'multiplier', v);
  for (const [w, v] of Object.entries(n.ordinals)) put(w, 'ordinal', v);
  for (const [w, v] of scales) put(w, 'cardinal', v, true);
  for (const [w, v] of Object.entries(n.cardinals)) put(w, 'cardinal', v);
  /** @type {Morpheme[]} */
  const morphemes = [
    ...Object.entries(n.cardinals).map(([w, v]) => /** @type {Morpheme} */ ({ w, v, role: 'unit' })),
    ...scales.map(([w, v]) => /** @type {Morpheme} */ ({ w, v, role: 'scale' })),
    ...n.joiners.map((w) => /** @type {Morpheme} */ ({ w, v: 0, role: 'joiner' })),
  ].sort((a, b) => b.w.length - a.w.length);
  const suffixes = /** @type {const} */ (['ordinal', 'fraction', 'multiplier'])
    .flatMap((kind) => n.suffixes[kind].map((s) => ({ s, kind: /** @type {NumberWordKind} */ (kind) })))
    .sort((a, b) => b.s.length - a.s.length);
  return {
    code: pack.code,
    words,
    morphemes,
    suffixes,
    compound: n.compound,
    joiners: new Set(n.joiners),
    countNouns: new Set(n.countNouns),
    fractionLeads: new Set(n.fractionLeads),
    negative: new Set(n.negative),
    unitWord: new RegExp(`^(?:${anyOf([...pack.unitWords, ...pack.percentWords, ...pack.currencyWords])})$`, 'iu'),
  };
}

/** Compiled tables of every registered pack and the patterns they share; rebuilt on registration. */
const tables = fromPacks((packs) => {
  const byCode = new Map(packs.map((p) => [p.code, compile(p)]));
  /** @type {Array<[string, number]>} */
  const scaleWords = packs.flatMap((p) => p.scales.flatMap(([factor, words]) => words.map((w) => /** @type {[string, number]} */ ([w, factor]))));
  for (const p of packs) for (const [w, v] of Object.entries(p.gate.numberWords.scales)) if (v >= 1000) scaleWords.push([w, v]);
  /** @param {Array<[string, number]>} list @param {string} flags */
  const scaleRe = (list, flags) => ({
    re: list.length ? new RegExp(`(?:${list.map(([w]) => `(${w})`).join('|')})(?![\\p{L}\\p{Nd}])`, flags) : null,
    factors: list.map(([, f]) => f),
  });
  return {
    byCode,
    all: [...byCode.values()],
    // Single letters ("k") match in their case only; words in any case ("Mio.", "million").
    scales: [scaleRe(scaleWords.filter(([w]) => /^\p{L}$/u.test(w)), 'uy'), scaleRe(scaleWords.filter(([w]) => !/^\p{L}$/u.test(w)), 'iuy')],
    ordinalSuffixes: new Set(packs.flatMap((p) => p.ordinalSuffixes)),
    meridiem: new Set(packs.flatMap((p) => (p.meridiem ? [p.meridiem.am, p.meridiem.pm] : []))),
    currencyWord: new RegExp(`^(?:${anyOf(packs.flatMap((p) => p.currencyWords))})$`, 'iu'),
    unitWord: new RegExp(`^(?:${anyOf(packs.flatMap((p) => p.unitWords))})$`, 'iu'),
  };
});

/**
 * The packs to read number words with: the one of `locale`, or every registered pack.
 * @param {string | null | undefined} locale
 * @returns {PackTable[]}
 */
function tablesFor(locale) {
  const t = tables();
  const pack = locale ? languagePack(locale) : null;
  const one = pack ? t.byCode.get(pack.code) : undefined;
  return one ? [one] : t.all;
}

/**
 * Splits a word of a compound language into cardinals, scales and joiners
 * ("dreihundertfünfundzwanzig": drei hundert fünf und zwanzig), or null.
 * @param {string} word
 * @param {PackTable} t
 * @returns {Morpheme[] | null}
 */
function split(word, t) {
  if (word.length > 80) return null;
  /** @type {Morpheme[]} */
  const parts = [];
  /** @type {Set<number>} */
  const dead = new Set();
  const go = (/** @type {number} */ i) => {
    if (i === word.length) return true;
    if (dead.has(i)) return false;
    for (const m of t.morphemes) {
      if (!word.startsWith(m.w, i)) continue;
      // A joiner stands only between two numbers.
      if (m.role === 'joiner' && (parts.length === 0 || parts[parts.length - 1].role === 'joiner' || i + m.w.length === word.length)) continue;
      parts.push(m);
      if (go(i + m.w.length)) return true;
      parts.pop();
    }
    dead.add(i);
    return false;
  };
  return go(0) && parts.some((p) => p.role !== 'joiner') ? parts : null;
}

/**
 * The value of a sequence of cardinals and scales: "two hundred thousand five" is 200,005.
 * @param {Array<{ v: number, role: Morpheme['role'] }>} parts
 */
function accumulate(parts) {
  let total = 0;
  let current = 0;
  for (const p of parts) {
    if (p.role === 'joiner') continue;
    if (p.role === 'scale') {
      if (p.v >= 1000) {
        total += (current || 1) * p.v;
        current = 0;
      } else current = (current || 1) * p.v;
    } else current += p.v;
  }
  return total + current;
}

/**
 * The cardinal value of a word of one pack: a listed cardinal or scale, or in a compound language
 * a word split into them.
 * @param {string} word
 * @param {PackTable} t
 * @returns {{ value: number, scale: boolean } | null}
 */
function cardinalOf(word, t) {
  const direct = t.words.get(word);
  if (direct) return direct.kind === 'cardinal' ? { value: direct.value, scale: direct.scale } : null;
  if (!t.compound) return null;
  const parts = split(word, t);
  return parts ? { value: accumulate(parts), scale: parts[parts.length - 1].role === 'scale' } : null;
}

/**
 * Tags one lowercase word in one pack.
 * @param {string} word
 * @param {PackTable} t
 * @returns {WordTag | null}
 */
function tagIn(word, t) {
  const hit = t.words.get(word);
  if (hit) return hit;
  if (word.length > 80) return null;
  for (const { s, kind } of t.suffixes) {
    if (word.length <= s.length || !word.endsWith(s)) continue;
    const stem = cardinalOf(word.slice(0, -s.length), t);
    if (stem && stem.value > 0) {
      return { kind, value: kind === 'fraction' ? 1 / stem.value : stem.value, shape: 'unit', scale: false, alone: false, contextual: false };
    }
  }
  if (!t.compound) return null;
  const c = cardinalOf(word, t);
  return c ? { kind: 'cardinal', value: c.value, shape: shapeOf(c.value, c.scale), scale: false, alone: false, contextual: false } : null;
}

/**
 * The kind and value of a number word ("twelve": cardinal 12, "einmal": adverb, "Viertel":
 * fraction 0.25), in the language of `locale` or, without one, in the first language that has it.
 * @param {string} word
 * @param {string | null} [locale]
 * @returns {{ kind: NumberWordKind, value: number } | null}
 */
export function numberWordTag(word, locale = null) {
  const w = String(word ?? '').toLowerCase();
  for (const t of tablesFor(locale)) {
    const tag = tagIn(w, t);
    if (tag) return { kind: tag.kind, value: tag.value };
  }
  return null;
}

/**
 * Whether `next` continues the number that ends with `last` ("twenty" "five", "two" "hundred",
 * "hundred" "five", "zwei" "Millionen") rather than starting another one.
 * @param {WordTag} last
 * @param {WordTag} next
 */
function continues(last, next) {
  if (last.kind !== 'cardinal' || next.kind !== 'cardinal') return false;
  if (next.scale) return last.shape !== 'group' || next.value > last.value;
  if (last.shape === 'hundred' || last.shape === 'group') return next.value < 100;
  if (last.shape === 'ten') return next.value > 0 && next.value < 10;
  return false;
}

/**
 * One token, or one hyphenated part of a word, in text order.
 * @typedef {object} Element
 * @property {'word' | 'digits' | 'mixed' | 'custom' | 'used'} t
 * @property {string} text      lowercase for words
 * @property {number} start
 * @property {number} end
 * @property {boolean} tight    only white space (or the hyphen of the same word) since the previous element
 */

/**
 * Reads a digits-only form ("480", "1.200", "1'000", "480 000") into a number item.
 * @param {string} raw
 * @param {number} start
 * @returns {NumberItem}
 */
function digitsItem(raw, start) {
  const written = raw.includes('’') ? raw.replace(/’/g, "'") : raw;
  /** @type {NumberItem} */
  const item = { type: 'number', raw, start, end: start + raw.length, written, value: null, ambiguous: false, scale: 1 };
  if (/^\d+$/.test(written)) item.value = Number(written);
  else if (/^\d{1,3}(?:(?:'\d{3})+|(?: \d{3})+|(?:[.,]\d{3})+)(?:[.,]\d+)?$/.test(written) || /^\d+[.,]\d+$/.test(written)) {
    const parsed = parseNumber(written);
    if (parsed && parsed.readings.length === 1) item.value = parsed.readings[0];
    else if (parsed) item.ambiguous = true;
  }
  return item;
}

/**
 * Splits a text into elements: words (and the parts of hyphenated words), digit tokens, tokens
 * that mix letters and digits, and the identifiers the caller's patterns match.
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {Element[]}
 */
function elementsOf(text, patterns) {
  /** @type {Array<[number, number]>} */
  const custom = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of text.matchAll(re)) if (m[0]) custom.push([/** @type {number} */ (m.index), /** @type {number} */ (m.index) + m[0].length]);
  }
  custom.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  /** @type {Element[]} */
  const out = [];
  let prevEnd = -1;
  const tightAt = (/** @type {number} */ at) => {
    if (prevEnd < 0) return false;
    for (let k = prevEnd; k < at; k += 1) if (!isSpaceCode(text.charCodeAt(k))) return false;
    return true;
  };
  const push = (/** @type {Element['t']} */ t, /** @type {string} */ s, /** @type {number} */ start, /** @type {boolean} */ tight) => {
    out.push({ t, text: t === 'word' ? s.toLowerCase() : s, start, end: start + s.length, tight });
  };
  let c = 0;
  TOKEN.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = TOKEN.exec(text)) !== null) {
    let raw = m[0];
    const start = m.index;
    while (c < custom.length && custom[c][1] <= start) {
      if (custom[c][0] >= prevEnd) {
        push('custom', text.slice(custom[c][0], custom[c][1]), custom[c][0], tightAt(custom[c][0]));
        prevEnd = custom[c][1];
      }
      c += 1;
    }
    if (c < custom.length && custom[c][0] < start + raw.length) {
      // Part of an identifier the caller named: the whole match is one element.
      const [s, e] = custom[c];
      if (s >= prevEnd) {
        push('custom', text.slice(s, e), s, tightAt(s));
        prevEnd = e;
      }
      c += 1;
      if (e > TOKEN.lastIndex) TOKEN.lastIndex = e;
      continue;
    }
    if (/^\d{1,3}$/.test(raw)) {
      SPACE_GROUPS.lastIndex = start + raw.length;
      const g = SPACE_GROUPS.exec(text);
      if (g) {
        raw += g[0];
        TOKEN.lastIndex = start + raw.length;
      }
    }
    const tight = tightAt(start);
    if (/^\d+$/.test(raw)) push('digits', raw, start, tight);
    else if (!DIGIT.test(raw)) {
      if (!raw.includes('-')) push('word', raw, start, tight);
      else {
        let offset = 0;
        raw.split('-').forEach((part, i) => {
          if (part) push('word', part, start + offset, i === 0 ? tight : true);
          offset += part.length + 1;
        });
      }
    } else if (!LETTER.test(raw)) {
      // A hyphen between digits is a range ("3-5"), except in an ISO date.
      const parts = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? [raw] : raw.split('-');
      let offset = 0;
      parts.forEach((part, i) => {
        if (part) push('digits', part, start + offset, i === 0 ? tight : false);
        offset += part.length + 1;
      });
    } else if (/^\d+(?:[.,]\d+)?-\p{L}+(?:-\p{L}+)*$/u.test(raw)) {
      // A count before a word: "3-year", "24-hour", "5-Sterne-Hotel".
      const [digits, ...words] = raw.split('-');
      push('digits', digits, start, tight);
      let offset = digits.length + 1;
      for (const w of words) {
        push('word', w, start + offset, true);
        offset += w.length + 1;
      }
    } else push('mixed', raw, start, tight);
    prevEnd = start + raw.length;
  }
  for (; c < custom.length; c += 1) {
    if (custom[c][0] >= prevEnd) {
      push('custom', text.slice(custom[c][0], custom[c][1]), custom[c][0], tightAt(custom[c][0]));
      prevEnd = custom[c][1];
    }
  }
  return out;
}

/**
 * Numbers, number words, identifiers and joins in a text (a canonical sentence, see canonical.js),
 * in text order. Linear in the length of the text.
 * @param {string} text
 * @param {ScanOptions} [options]
 * @returns {ScanItem[]}
 */
export function scanNumbers(text, options = {}) {
  const t = tables();
  const packs = tablesFor(options.locale ?? null);
  const elements = elementsOf(text, options.identifierPatterns ?? []);
  /** @type {ScanItem[]} */
  const items = [];
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i];
    if (el.t === 'custom') {
      items.push({ type: 'identifier', raw: el.text, start: el.start, end: el.end, keys: [el.text.toLowerCase().replace(/\s+/g, ' ')] });
    } else if (el.t === 'mixed') {
      const item = mixedItem(el.text, el.start, t, packs);
      if (item.type === 'number') i = finishNumber(item, text, elements, i, packs, t, items);
      else items.push(item);
    } else if (el.t === 'digits') {
      // A standard number after the name of its body: "ISO 9001", "DIN EN ISO 13485".
      let j = i;
      while (j > 0 && i - j < MAX_BODY_WORDS && elements[j - 1].t === 'word' && isStandardBody(text.slice(elements[j - 1].start, elements[j - 1].end)) && text.slice(elements[j - 1].end, elements[j].start) === ' ') j -= 1;
      if (j < i) {
        const end = el.end;
        const keys = elements.slice(j, i).map((e) => text.slice(e.start, end).toLowerCase());
        items.push({ type: 'identifier', raw: text.slice(elements[j].start, end), start: elements[j].start, end, keys });
        for (let k = j; k <= i; k += 1) elements[k].t = 'used';
        continue;
      }
      // ".5", ",5" after no digit: a fraction a reader hears, not the 5 that would be checked.
      const lead = text.charCodeAt(el.start - 1);
      const beforeLead = text.charCodeAt(el.start - 2);
      if ((lead === 46 || lead === 44) && !(beforeLead >= 48 && beforeLead <= 57)) {
        items.push({ type: 'joined', raw: text.slice(el.start - 1, el.end), start: el.start - 1, end: el.end });
        el.t = 'used';
        continue;
      }
      const compound = !/^\d+$/.test(el.text) && (/[:/]|-/.test(el.text) || ((el.text.match(/[.,]/g)?.length ?? 0) > 1 && !/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?$/.test(el.text)));
      /** @type {NumberItem} */
      const item = compound
        ? { type: 'number', raw: el.text, start: el.start, end: el.end, written: el.text, value: null, ambiguous: false, scale: 1 }
        : digitsItem(el.text, el.start);
      i = finishNumber(item, text, elements, i, packs, t, items);
    }
  }
  /** @type {ScanItem[]} */
  const words = [];
  readWords(elements, words, packs, options.lenient ?? false);
  /** @type {ScanItem[]} */
  const joins = [];
  markJoins(items, words, joins, text);
  return merge(merge(items, words), joins);
}

/**
 * Two lists in text order merged into one (by start, then end), in linear time.
 * @param {ScanItem[]} a
 * @param {ScanItem[]} b
 * @returns {ScanItem[]}
 */
function merge(a, b) {
  if (!b.length) return a;
  if (!a.length) return b;
  /** @type {ScanItem[]} */
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x.start < y.start || (x.start === y.start && x.end <= y.end)) {
      out.push(x);
      i += 1;
    } else {
      out.push(y);
      j += 1;
    }
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

/**
 * Sign, scale and exponent of a number item, then the item itself; returns the index of the last
 * element it took.
 * @param {NumberItem} item
 * @param {string} text
 * @param {Element[]} elements
 * @param {number} i
 * @param {PackTable[]} packs
 * @param {ReturnType<typeof tables>} t
 * @param {ScanItem[]} items
 */
function finishNumber(item, text, elements, i, packs, t, items) {
  elements[i].t = 'used';
  applySign(item, text, elements, i, packs);
  if (item.scale === 1 && (item.value !== null || item.ambiguous) && letterAt(text, item.end)) applyScale(item, text, t);
  let last = i;
  while (last + 1 < elements.length && elements[last + 1].start < item.end) {
    last += 1;
    elements[last].t = 'used';
  }
  // A superscript right after the digits is an exponent: "10³" is read as a thousand.
  const after = text.charCodeAt(item.end);
  if (after === 0xb2 || after === 0xb3) items.push({ type: 'joined', raw: text.slice(item.start, item.end + 1), start: item.start, end: item.end + 1 });
  else items.push(item);
  return last;
}

/** @param {string} word */
function isStandardBody(word) {
  return STANDARD_PREFIXES.has(word) || (word.includes('/') && word.split('/').every((w) => STANDARD_PREFIXES.has(w)));
}

/**
 * A token that mixes letters and digits: a number with a unit, scale or ordinal ending ("10kg",
 * "480k", "3rd", "2pm"), an amount after a currency code ("EUR480"), digits disguised by look-alike
 * letters ("5OO", "l5"), digits glued to a number word ("5-hundred"), or an identifier ("IPv6",
 * "COVID-19", "GPT-4o", "MP3").
 * @param {string} raw
 * @param {number} start
 * @param {ReturnType<typeof tables>} t
 * @param {PackTable[]} packs
 * @returns {ScanItem}
 */
function mixedItem(raw, start, t, packs) {
  const end = start + raw.length;
  const tail = /^(\d+(?:[.,]\d+)?)(\p{L}+)$/u.exec(raw);
  if (tail) {
    const [, digits, letters] = tail;
    const lower = letters.toLowerCase();
    if (/^\d+$/.test(digits) && t.ordinalSuffixes.has(lower)) return { type: 'word', raw, start, end, kind: 'ordinal', value: Number(digits), claim: false };
    const scale = scaleOf(letters, t);
    if (scale) {
      const item = digitsItem(digits, start);
      Object.assign(item, { raw, end, scale, written: `${item.written}×${scale}`, value: item.value === null ? null : item.value * scale });
      return item;
    }
    if (UNIT_SIGNS.has(letters) || t.meridiem.has(lower) || (letters.length > 2 && t.unitWord.test(letters))) return digitsItem(digits, start);
  }
  const head = /^(\p{L}+)(\d+(?:[.,]\d+)*)$/u.exec(raw);
  if (head && (CURRENCY_CODES.has(head[1].toLowerCase()) || t.currencyWord.test(head[1]))) return digitsItem(head[2], start + head[1].length);
  const letters = [...raw].filter((ch) => LETTER.test(ch));
  if (letters.every((ch) => LOOKALIKE.has(ch))) return { type: 'joined', raw, start, end, lookalike: true };
  const parts = raw.toLowerCase().split('-');
  if (parts.some((p) => /^\d+$/.test(p)) && parts.some((p) => packs.some((pack) => tagIn(p, pack)?.kind === 'cardinal'))) return { type: 'joined', raw, start, end };
  return { type: 'identifier', raw, start, end, keys: identifierKeys(raw) };
}

/**
 * The forms of an identifier a source may contain to support it: the whole token, and every run
 * of its hyphenated parts with letters and digits ("COVID-19-related": "covid-19-related",
 * "covid-19"). A run of digits alone is not enough: "XYZ-19" is not supported by "COVID-19".
 * @param {string} raw
 * @returns {string[]}
 */
export function identifierKeys(raw) {
  const lower = raw.toLowerCase();
  const parts = lower.split('-');
  if (parts.length === 1 || parts.length > 8) return [lower];
  /** @type {string[]} */
  const keys = [lower];
  for (let a = 0; a < parts.length; a += 1) {
    for (let b = a + 1; b <= parts.length; b += 1) {
      if (a === 0 && b === parts.length) continue;
      const run = parts.slice(a, b).join('-');
      if (DIGIT.test(run) && LETTER.test(run)) keys.push(run);
    }
  }
  return keys;
}

/**
 * The factor of a whole scale word ("k", "Mio", "million"), or 0.
 * @param {string} word
 * @param {ReturnType<typeof tables>} t
 */
function scaleOf(word, t) {
  for (const { re, factors } of t.scales) {
    if (!re) continue;
    re.lastIndex = 0;
    const s = re.exec(word);
    if (s && s[0].length === word.length) return factors[s.slice(1).findIndex((x) => x !== undefined)];
  }
  return 0;
}

/**
 * A "-" or "+" right before the digits ("-5", "(+3)"), or a sign word ("minus 5"), signs the number.
 * A dash after another number is a range or an operator instead ("3-5", "10 - 5").
 * @param {NumberItem} item
 * @param {string} text
 * @param {Element[]} elements
 * @param {number} i
 * @param {PackTable[]} packs
 */
function applySign(item, text, elements, i, packs) {
  const before = text[item.start - 1];
  let negative = false;
  let signed = false;
  if (before === '-' || before === '+') {
    let k = item.start - 2;
    while (k >= 0 && text[k] === ' ') k -= 1;
    const prev = k >= 0 ? text[k] : '';
    if (!(text[item.start - 2] && ALNUM.test(text[item.start - 2])) && !/\d/.test(prev)) {
      negative = before === '-';
      signed = true;
      item.start -= 1;
    }
  } else {
    const prev = elements[i - 1];
    if (prev && prev.t === 'word' && /^\s+$/.test(text.slice(prev.end, item.start)) && packs.some((p) => p.negative.has(prev.text))) {
      negative = true;
      signed = true;
      item.start = prev.start;
      prev.t = 'used';
    }
  }
  if (signed) item.raw = text.slice(item.start, item.end);
  if (negative) {
    item.written = `-${item.written}`;
    if (item.value !== null) item.value = -item.value;
  }
}

/**
 * A scale word after the number ("4.5 million", "5 Mio.", "480k") multiplies it.
 * @param {NumberItem} item
 * @param {string} text
 * @param {ReturnType<typeof tables>} t
 */
function applyScale(item, text, t) {
  for (const gap of [0, 1]) {
    if (gap === 1 && text[item.end] !== ' ') continue;
    for (const { re, factors } of t.scales) {
      if (!re) continue;
      re.lastIndex = item.end + gap;
      const s = re.exec(text);
      if (!s) continue;
      const factor = factors[s.slice(1).findIndex((x) => x !== undefined)];
      item.scale = factor;
      item.written = `${item.written}×${factor}`;
      if (item.value !== null) item.value *= factor;
      item.end += gap + s[0].length;
      item.raw = text.slice(item.start, item.end);
      return;
    }
  }
}

/**
 * Number words in the elements: sequences ("two hundred and five", "zwei Millionen"), counts of
 * fractions ("drei Viertel", "two thirds", "a third"), and the contextual words with a unit or
 * counted thing after them.
 * @param {Element[]} elements
 * @param {ScanItem[]} items
 * @param {PackTable[]} packs
 * @param {boolean} lenient
 */
function readWords(elements, items, packs, lenient) {
  /** @param {number} last index of the number's last element @param {PackTable} pack */
  const unitAfter = (last, pack) => {
    for (let k = last + 1; k <= last + 2 && k < elements.length; k += 1) {
      const el = elements[k];
      if (el.t !== 'word' || !el.tight) return false;
      if (pack.countNouns.has(el.text) || pack.unitWord.test(el.text) || UNIT_SIGNS.has(el.text)) return true;
    }
    return false;
  };
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i];
    if (el.t !== 'word') continue;
    /** @type {{ tag: WordTag, pack: PackTable } | null} */
    let first = null;
    for (const pack of packs) {
      const tag = tagIn(el.text, pack);
      if (tag) {
        first = { tag, pack };
        break;
      }
    }
    if (!first) continue;
    const { pack } = first;
    /** @type {WordTag[]} */
    const run = [first.tag];
    let last = i;
    if (first.tag.kind === 'cardinal') {
      for (let k = i + 1; k < elements.length && elements[k].t === 'word' && elements[k].tight; k += 1) {
        const prev = run[run.length - 1];
        let at = k;
        // "hundred and five": a joiner between a scale and a smaller number.
        if (pack.joiners.has(elements[at].text) && (prev.shape === 'hundred' || prev.shape === 'group') && elements[at + 1]?.t === 'word' && elements[at + 1].tight) at += 1;
        const tag = tagIn(elements[at].text, pack);
        if (!tag) break;
        if (continues(prev, tag)) {
          run.push(tag);
          last = at;
          k = at;
          continue;
        }
        // "drei Viertel", "two thirds", "one third": a count of fractions ends the number.
        if (at === k && (tag.kind === 'fraction' || (tag.kind === 'ordinal' && tag.value >= 3))) {
          run.push(tag);
          last = at;
        }
        break;
      }
    }
    const end = run[run.length - 1];
    const cardinals = run.filter((r) => r.kind === 'cardinal');
    const count = accumulate(cardinals.map((r) => ({ v: r.value, role: r.scale ? 'scale' : 'unit' })));
    let start = el.start;
    /** @type {NumberWordKind} */
    let kind = end.kind;
    let value = end.value;
    let claim = false;
    if (end.kind === 'fraction' || (end.kind === 'ordinal' && cardinals.length > 0)) {
      kind = 'fraction';
      value = (cardinals.length ? count : 1) * (end.kind === 'fraction' ? end.value : 1 / end.value);
      claim = cardinals.length > 0 || !end.contextual || lenient || unitAfter(last, pack);
    } else if (end.kind === 'cardinal') {
      value = count;
      claim = run.length > 1 || !end.alone;
    } else if (end.kind === 'ordinal') {
      // "a third": a lead word before an ordinal from three on makes it a fraction.
      const prev = elements[i - 1];
      if (prev && prev.t === 'word' && el.tight && pack.fractionLeads.has(prev.text) && end.value >= 3) {
        kind = 'fraction';
        value = 1 / end.value;
        claim = true;
        start = prev.start;
      }
    } else if (end.kind === 'multiplier') {
      claim = !end.contextual || lenient || unitAfter(last, pack);
    }
    for (let k = i; k <= last; k += 1) elements[k].t = 'used';
    const finish = elements[last].end;
    items.push({ type: 'word', raw: '', start, end: finish, kind, value, claim });
    i = last;
  }
}

/**
 * Fills in the raw text of word items and lists the numbers a reader would hear as one: two numbers
 * in digits with nothing but white space between them ("4 80", "2024 500") or only separator signs
 * ("5‚5" with a low quote for a comma, "5.,5"), or digits next to a number word, also across a
 * hyphen ("5 hundred", "5-hundred", "twenty 5"). A hyphen between two numbers in digits is a range ("3-5").
 * @param {ScanItem[]} items  numbers, identifiers and joins in digits, in text order
 * @param {ScanItem[]} words  number words, in text order
 * @param {ScanItem[]} joins  receives the joins, in text order
 * @param {string} text
 */
function markJoins(items, words, joins, text) {
  for (const item of words) item.raw = text.slice(item.start, item.end);
  const numeric = merge(
    items.filter((x) => x.type === 'number'),
    words.filter((x) => x.type === 'word' && x.kind === 'cardinal'),
  );
  for (let k = 1; k < numeric.length; k += 1) {
    const a = numeric[k - 1];
    const b = numeric[k];
    if (b.start < a.end || (a.type === 'word' && b.type === 'word')) continue;
    const word = a.type === 'word' ? a : b.type === 'word' ? b : null;
    // A word that states nothing ("ein", "one") joins only a round number before it ("20 one").
    if (word && !word.claim && !(a.type === 'number' && a.value !== null && a.value % 10 === 0 && word === b)) continue;
    let blank = true;
    for (let k = a.end; k < b.start && blank; k += 1) {
      const c = text.charCodeAt(k);
      blank = isSpaceCode(c) || (word !== null && c === 45);
    }
    const joined = blank || (!word && b.start - a.end <= 4 && SEPARATOR_GAP.test(text.slice(a.end, b.start)));
    if (joined) joins.push({ type: 'joined', raw: text.slice(a.start, b.end), start: a.start, end: b.end });
  }
}
