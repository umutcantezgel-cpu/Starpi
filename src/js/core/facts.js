// @ts-check
// Facts for the source check: the numbers, dates, times, weekdays, months, codes and quotations a
// sentence states, and an index of the same facts in an excerpt.
//
// Claim mode (answer sentences) is strict and extracts only what it is sure about. Source mode
// (excerpts) is lenient and records every plausible reading. A fact copied verbatim, or rewritten
// between English and German formats ("480.000" / "480,000", "28.08.2026" / "August 28, 2026"),
// therefore always matches, while a changed value does not. The names, number words and units of
// each language come from the language packs (lang/), read together. Pure: no DOM, runs in Node too.
import { tokenize } from '../rag/bm25.js';
import { anyOf, fromPacks, union } from './lang/index.js';
import { LOOSE_LABEL_PATTERN } from './labels.js';

/** @typedef {'number' | 'date' | 'time' | 'weekday' | 'month' | 'code' | 'quote'} FactKind */

/**
 * @typedef {object} Fact
 * @property {FactKind} kind
 * @property {string} surface   the fact as written in the sentence
 * @property {number} start     offset in the sentence
 * @property {number} end
 * @property {string[]} values  canonical readings; the fact is found when any of them is in a source
 * @property {number[]} nums    numeric readings (numbers only)
 * @property {boolean} approx   "about 480,000": a source number within ±5 % counts, as approximate
 * @property {number} sig       significant digits of a number written with a scale word ("4.5 million"), else 0
 */

/**
 * @typedef {object} SourceIndex
 * @property {Set<string>} values   canonical fact readings
 * @property {number[]} nums        every number, for approximate matches
 * @property {string} words         folded words joined by single spaces, padded with spaces
 * @property {Set<string>} tokens   folded content tokens
 * @property {Map<string, string[]>} prefixes  content tokens of 5+ characters by their first 5
 * @property {string[]} long        content tokens of 5+ characters
 * @property {import('./lang/index.js').LanguageCode | null} lang
 */

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

const alternation = (/** @type {Iterable<string>} */ words) => [...words].sort((a, b) => b.length - a.length).join('|');

/** Currency signs and ISO codes, the same in every language (currency names come from the packs). */
const CURRENCY_SIGNS = ['€', '\\$', '£', 'eur', 'usd', 'chf', 'gbp'];
/** Unit symbols, the same in every language (unit words come from the packs). */
const UNIT_SYMBOLS = ['x', 'h', 'min', 's', 'ms', 'kg', 'g', 't', 'km', 'm', 'cm', 'mm', 'gb', 'mb', 'tb', 'kb', 'px', 'pt', '°'];
/** Words of the app's own citation labels ("[Doc: …, Chunk: n]"), which are English in every language. */
const LABEL_WORDS = ['chunk', 'doc'];
const CURRENCY_BEFORE = new RegExp(`(?:${CURRENCY_SIGNS.join('|')})\\s?$`, 'iu');

/**
 * @param {string} letters
 * @returns {RegExp | null}
 */
const letterClass = (letters) => (letters ? new RegExp(`[${letters.replace(/[\\\]^[-]/g, '\\$&')}]`) : null);

/**
 * The word lists and patterns of all registered language packs (lang/index.js), merged so a fact
 * written in one language is read in the others too. Rebuilt when a pack is registered.
 */
const tables = fromPacks((packs) => {
  /** @param {(p: import('./lang/index.js').LanguagePack) => string[]} pick */
  const all = (pick) => union(packs.map(pick));
  const months = new Map(packs.flatMap((p) => [...Object.entries(p.months), ...Object.entries(p.monthAbbreviations)]));
  const weekdays = new Map(packs.flatMap((p) => Object.entries(p.weekdays)));
  const spelled = new Map(packs.flatMap((p) => Object.entries(p.numberWords)));
  const meridiem = packs.flatMap((p) => (p.meridiem ? [p.meridiem] : []));
  // "am", "pm" and their dotted forms "a.m.", "p.m."
  const meridiemForms = [
    ...meridiem.flatMap((m) => [m.am, m.pm]),
    ...meridiem.flatMap((m) => [m.am, m.pm].map((w) => `${[...w].join('\\.')}\\.`)),
  ];
  /** @type {Map<number, string[]>} */
  const scales = new Map();
  for (const [factor, words] of packs.flatMap((p) => p.scales)) scales.set(factor, union([scales.get(factor) ?? [], words]));
  const joiners = anyOf(all((p) => p.numberJoiners));
  const numberWord = [alternation(spelled.keys()), ...all((p) => p.numberParts)].filter(Boolean).join('|') || '(?!)';
  const positions = all((p) => p.monthPosition);
  const links = all((p) => p.dayMonthLinks);
  const ordinals = all((p) => p.ordinalSuffixes);
  /** @param {import('./lang/index.js').LanguagePack} p */
  const ownWords = (p) => {
    const others = new Set(packs.filter((q) => q !== p).flatMap((q) => q.stopwords));
    return new Set(p.stopwords.filter((w) => !others.has(w)));
  };
  return {
    months,
    monthAlt: alternation(months.keys()),
    fullMonthAlt: alternation(all((p) => Object.keys(p.months))),
    /** lowercase month names that are only read as a month when capitalised */
    ambiguousMonths: new Set(all((p) => p.ambiguousMonths)),
    weekdays,
    weekdayAlt: alternation(weekdays.keys()),
    /** words before a month name that make it a date ("in August", "bis Mai"), not a name or verb */
    monthContext: anyOf(all((p) => p.monthContext)),
    monthPosition: positions.length ? `(?:(?:${positions.join('|')})\\s+)?` : '',
    dayMonthLink: links.length ? `(?:${anyOf(links)}\\s+)?` : '',
    ordinalSuffix: ordinals.length ? `(?:${ordinals.join('|')})?` : '',
    ordinalAfter: new RegExp(`^${anyOf(ordinals)}(?![\\p{L}])`, 'iu'),
    numericDateContext: all((p) => p.numericDateContext),
    clockWords: all((p) => p.clockWords),
    meridiemForms,
    am: new Set(meridiem.map((m) => m.am)),
    pm: new Set(meridiem.map((m) => m.pm)),
    scales: /** @type {Array<[RegExp, number]>} */ (
      [...scales].sort(([a], [b]) => a - b).map(([factor, words]) => [new RegExp(`^\\s?(?:${words.join('|')})(?![\\p{L}])`, 'iu'), factor])
    ),
    percent: new RegExp(`^\\s?(?:%|${all((p) => p.percentWords).join('|')})(?![\\p{L}])`, 'iu'),
    currencyAfter: new RegExp(`^\\s?(?:${[...CURRENCY_SIGNS, ...all((p) => p.currencyWords)].join('|')})(?![\\p{L}])`, 'iu'),
    unitAfter: new RegExp(`^\\s?(?:${[...UNIT_SYMBOLS, ...all((p) => p.unitWords)].join('|')})(?![\\p{L}])`, 'iu'),
    approxBefore: new RegExp(`(?:${[...all((p) => p.approxWords), '~', '≈'].join('|')})\\s*(?:[€$£]\\s?)?$`, 'iu'),
    /** words that make "10.4.12" a version rather than a date */
    versionContext: new RegExp(`${anyOf(all((p) => p.versionWords))}\\s*$`, 'iu'),
    spelled,
    spelledAlt: alternation(spelled.keys()) || '(?!)',
    spelledFolded: new Map([...spelled].map(([w, n]) => [fold(w), n])),
    // "and" joins two number words ("a hundred and twenty"); between other words it is just "and".
    spelledPartAfter: new RegExp(`^[\\s-]+(?:${joiners}\\s+)?(?:${numberWord})(?![\\p{L}])|^[\\s-]*\\d`, 'iu'),
    spelledPartBefore: new RegExp(`(?<![\\p{L}])(?:${numberWord})(?:\\s+${joiners})?[\\s-]+$|\\d[\\s-]*$`, 'iu'),
    /** words that describe the sources rather than stating something */
    boilerplate: new Set([...all((p) => p.boilerplate), ...LABEL_WORDS]),
    /** per language, the function words no other pack has, and its own letters */
    cues: packs.map((p) => ({ code: p.code, words: ownWords(p), letters: letterClass(p.letters) })),
  };
});

/**
 * Case, Unicode and typography folding shared by claims and sources: NFKC, lowercase, German
 * umlauts and ß spelled out, soft hyphens and PDF line-break hyphenation removed, quotes and dashes
 * unified.
 * @param {string} text
 */
export function fold(text) {
  return text
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/(\p{L})-\n(\p{L})/gu, '$1$2')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟«»″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-');
}

/** @param {string} text */
function wordsOf(text) {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Canonical string for a number: at most six decimals, no trailing zeros.
 * @param {number} n
 */
export function numKey(n) {
  return `n:${Math.round(Math.abs(n) * 1e6) / 1e6}`;
}

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Readings of a digit run such as "480.000", "1,5", "1.234,56" or "3 100". A single separator
 * followed by exactly three digits is ambiguous (thousands in German, decimals in odd English), so
 * both readings are returned, thousands first.
 * @param {string} blob digits with separators, trimmed of trailing punctuation
 * @returns {{ readings: number[], digits: string } | null}
 */
export function parseNumber(blob) {
  const cleaned = blob.replace(/['’\u00A0\u202F\u2009 ]/g, '');
  if (!/^\d[\d.,]*$/.test(cleaned)) return null;
  const seps = cleaned.match(/[.,]/g) ?? [];
  if (seps.length === 0) return { readings: [Number(cleaned)], digits: cleaned };
  const kinds = new Set(seps);
  if (kinds.size === 2) {
    const last = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
    const intPart = cleaned.slice(0, last);
    const frac = cleaned.slice(last + 1);
    const thousands = cleaned[last] === '.' ? ',' : '.';
    const groups = intPart.split(thousands);
    if (intPart.includes(cleaned[last]) || groups.slice(1).some((g) => g.length !== 3) || !/^\d+$/.test(frac)) return null;
    return { readings: [Number(`${groups.join('')}.${frac}`)], digits: `${groups.join('')}${frac}` };
  }
  const parts = cleaned.split(/** @type {string} */ (seps[0]));
  if (parts.some((p) => p === '')) return null;
  if (parts.length > 2) {
    if (parts.slice(1).some((p) => p.length !== 3)) return null; // "1.2.3": a version, not a number
    return { readings: [Number(parts.join(''))], digits: parts.join('') };
  }
  const [a, b] = parts;
  if (b.length === 3 && a !== '0' && a.length <= 3) {
    return { readings: [Number(a + b), Number(`${a}.${b}`)], digits: a + b };
  }
  return { readings: [Number(`${a}.${b}`)], digits: `${a}${b}` };
}

/**
 * @param {string} text
 * @param {Array<[number, number]>} ranges
 */
function mask(text, ranges) {
  let out = text;
  for (const [s, e] of ranges) out = out.slice(0, s) + ' '.repeat(e - s) + out.slice(e);
  return out;
}

/**
 * @param {number} y
 * @param {number} m
 * @param {number} d
 */
function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  if (y === 0) return true;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1;
}

/** @param {string} y two- or four-digit year */
const fullYear = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/**
 * @typedef {{ start: number, end: number, surface: string, claim: string[], source: string[], nums: number[] }} Found
 */

/**
 * Dates in `text`. `claim` holds the readings a sentence must match; `source` also holds the
 * partial readings a lenient excerpt offers (month and day without the year, month and year, year).
 * @param {string} text
 * @returns {Found[]}
 */
function findDates(text) {
  /** @type {Found[]} */
  const out = [];
  let masked = text;
  /**
   * @param {RegExpExecArray} m
   * @param {Array<{ y: number, mo: number, d: number }>} readings  y = 0 without a year, d = 0 without a day
   * @param {boolean} [alsoNumber]  the text is also a decimal number
   */
  const add = (m, readings, alsoNumber = false) => {
    const valid = readings.filter((r) => validDate(r.y, r.mo, r.d === 0 ? 1 : r.d));
    if (!valid.length) return;
    /** @type {Set<string>} */
    const claim = new Set();
    /** @type {Set<string>} */
    const source = new Set();
    /** @type {number[]} */
    const nums = [];
    for (const { y, mo, d } of valid) {
      const mm = pad2(mo);
      if (d && y) claim.add(`d:${y}-${mm}-${pad2(d)}`);
      else if (d) claim.add(`d:--${mm}-${pad2(d)}`);
      else claim.add(`m:${y}-${mm}`);
      if (d && y) source.add(`d:${y}-${mm}-${pad2(d)}`);
      if (d) source.add(`d:--${mm}-${pad2(d)}`);
      if (y) source.add(`m:${y}-${mm}`);
      source.add(`mo:${mm}`);
      if (d) nums.push(d);
      if (y) nums.push(y);
      nums.push(mo);
    }
    if (alsoNumber) {
      // "4.05." ends an English sentence as often as "14.09." is a German date: both readings count.
      const n = numKey(Number(m[0].replace(/\.$/, '')));
      claim.add(n);
      source.add(n);
    }
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0].trim(), claim: [...claim], source: [...source], nums });
    masked = mask(masked, [[m.index, m.index + m[0].length]]);
  };
  const t = tables();
  const month = (/** @type {string} */ name) => t.months.get(fold(name).replace(/\.$/, '')) ?? t.months.get(name.toLowerCase().replace(/\.$/, '')) ?? 0;
  const ambiguous = (/** @type {string} */ name) => t.ambiguousMonths.has(name);
  /** @type {Array<[RegExp, (m: RegExpExecArray) => Array<{ y: number, mo: number, d: number }> | null, boolean?]>} */
  const patterns = [
    [new RegExp(`${B}(\\d{4})-(\\d{1,2})-(\\d{1,2})${E}`, 'gu'), (m) => [{ y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }]],
    [new RegExp(`${B}(\\d{1,2})\\.\\s?(\\d{1,2})\\.\\s?(\\d{4}|\\d{2})${E}`, 'gu'), (m) => [{ y: fullYear(m[3]), mo: Number(m[2]), d: Number(m[1]) }]],
    [
      new RegExp(`${B}(\\d{1,2})\\.\\s*(${t.monthAlt})\\.?(?:\\s+(\\d{4}))?${E}`, 'giu'),
      (m) => [{ y: m[3] ? Number(m[3]) : 0, mo: month(m[2]), d: Number(m[1]) }],
    ],
    [
      new RegExp(`${B}(\\d{1,2})${t.ordinalSuffix}\\s+${t.dayMonthLink}(${t.monthAlt})\\.?(?:,?\\s+(\\d{4}))?${E}`, 'giu'),
      (m) => (ambiguous(m[2]) ? null : [{ y: m[3] ? Number(m[3]) : 0, mo: month(m[2]), d: Number(m[1]) }]),
    ],
    [
      new RegExp(`${B}(${t.monthAlt})\\.?\\s+(\\d{1,2})${t.ordinalSuffix}(?:,?\\s+(\\d{4}))?${E}`, 'giu'),
      (m) => (ambiguous(m[1]) ? null : [{ y: m[3] ? Number(m[3]) : 0, mo: month(m[1]), d: Number(m[2]) }]),
    ],
    [new RegExp(`${B}(${t.monthAlt})\\.?\\s+(\\d{4})${E}`, 'giu'), (m) => (ambiguous(m[1]) ? null : [{ y: Number(m[2]), mo: month(m[1]), d: 0 }])],
    [
      new RegExp(`${B}(\\d{1,2})/(\\d{1,2})/(\\d{4}|\\d{2})${E}`, 'gu'),
      (m) => {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const y = fullYear(m[3]);
        return a <= 12 && b <= 12 && a !== b ? [{ y, mo: a, d: b }, { y, mo: b, d: a }] : [{ y, mo: a > 12 ? b : a, d: a > 12 ? a : b }];
      },
    ],
    [new RegExp(`${B}(\\d{1,2})/(\\d{4})${E}`, 'gu'), (m) => [{ y: Number(m[2]), mo: Number(m[1]), d: 0 }]],
    [new RegExp(`${B}(\\d{1,2})\\.(\\d{2})\\.(?![\\p{N}])`, 'gu'), (m) => [{ y: 0, mo: Number(m[2]), d: Number(m[1]) }], true],
    [
      new RegExp(`(?<![\\p{L}])${anyOf(t.numericDateContext)}\\s+(\\d{1,2})\\.(\\d{1,2})\\.(?![\\p{N}])`, 'giu'),
      (m) => [{ y: 0, mo: Number(m[2]), d: Number(m[1]) }],
    ],
  ];
  for (const [re, read, alsoNumber] of patterns) {
    re.lastIndex = 0;
    let m;
    const snapshot = masked;
    while ((m = re.exec(snapshot)) !== null) {
      if (masked.slice(m.index, m.index + m[0].length).trim() !== m[0].trim()) continue; // overlaps an earlier date
      const readings = read(m);
      if (readings) add(m, readings, alsoNumber);
    }
  }
  return out;
}

/**
 * @param {string} text
 * @returns {Found[]}
 */
function findTimes(text) {
  /** @type {Found[]} */
  const out = [];
  const push = (/** @type {RegExpExecArray} */ m, /** @type {number} */ h, /** @type {number} */ min) => {
    if (h > 23 || min > 59) return;
    const v = `t:${pad2(h)}:${pad2(min)}`;
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0].trim(), claim: [v], source: [v], nums: h > 0 ? [h] : [] });
  };
  const t = tables();
  const ampm = (/** @type {number} */ h, /** @type {string | undefined} */ suffix) => {
    const s = (suffix ?? '').toLowerCase().replace(/\./g, '');
    if (t.pm.has(s) && h < 12) return h + 12;
    if (t.am.has(s) && h === 12) return 0;
    return h;
  };
  // The 12-hour markers ("pm", "p.m.") and the words after a time of day ("Uhr"); a pattern whose
  // words no pack has never matches, so the capture groups keep their numbers.
  const meridiem = `(${t.meridiemForms.join('|') || '(?!)'})`;
  const clock = anyOf(t.clockWords);
  /** @type {RegExpExecArray | null} */
  let m;
  const colon = new RegExp(`${B}([01]?\\d|2[0-3]):([0-5]\\d)(?:\\s*(${[...t.clockWords, 'h', ...t.meridiemForms].join('|')}))?(?![\\p{N}])`, 'giu');
  while ((m = colon.exec(text)) !== null) push(m, ampm(Number(m[1]), m[3]), Number(m[2]));
  const dotClock = new RegExp(`${B}([01]?\\d|2[0-3])\\.([0-5]\\d)\\s*${clock}${E}`, 'giu');
  while ((m = dotClock.exec(text)) !== null) push(m, Number(m[1]), Number(m[2]));
  const dotAmPm = new RegExp(`${B}(1[0-2]|0?[1-9])\\.([0-5]\\d)\\s*${meridiem}(?![\\p{L}])`, 'giu');
  while ((m = dotAmPm.exec(text)) !== null) push(m, ampm(Number(m[1]), m[3]), Number(m[2]));
  const hourOnly = new RegExp(`${B}(1[0-2]|0?[1-9])\\s*${meridiem}(?![\\p{L}])|${B}([01]?\\d|2[0-3])\\s*${clock}${E}`, 'giu');
  while ((m = hourOnly.exec(text)) !== null) {
    const at = m.index;
    if (out.some((f) => at >= f.start && at < f.end)) continue;
    push(m, m[1] ? ampm(Number(m[1]), m[2]) : Number(m[3]), 0);
  }
  return out;
}

/**
 * @param {string} text
 * @param {boolean} claim
 * @returns {Found[]}
 */
function findWeekdaysAndMonths(text, claim) {
  /** @type {Found[]} */
  const out = [];
  let m;
  const t = tables();
  const days = new RegExp(`${B}(${t.weekdayAlt})s?${E}`, 'giu');
  while ((m = days.exec(text)) !== null) {
    const v = `w:${t.weekdays.get(m[1].toLowerCase())}`;
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0], claim: [v], source: [v], nums: [] });
  }
  const months = claim
    ? new RegExp(`(?<![\\p{L}])${t.monthContext}\\s+${t.monthPosition}(${t.fullMonthAlt})${E}`, 'giu')
    : new RegExp(`${B}(${t.fullMonthAlt})${E}`, 'giu');
  while ((m = months.exec(text)) !== null) {
    if (claim && t.ambiguousMonths.has(m[1])) continue;
    const n = t.months.get(m[1].toLowerCase()) ?? t.months.get(fold(m[1]));
    if (!n) continue;
    const v = `mo:${pad2(n)}`;
    const start = m.index + m[0].length - m[1].length;
    out.push({ start, end: m.index + m[0].length, surface: m[1], claim: [v], source: [v], nums: [] });
  }
  return out;
}


/**
 * Version numbers with three or four dotted parts ("4.2.1", "v3.9.4", "10.0.0.12"), read as codes
 * by version 2 of the source check (version 1 read "3.9.4 am" as the number 3.9 and the time 4 am).
 * One that could be a date ("10.4.12") is a version only after a word such as "firmware" or
 * "version", or with a "v" in front.
 * @param {string} text
 * @returns {Found[]}
 */
function findVersions(text) {
  /** @type {Found[]} */
  const out = [];
  const versionContext = tables().versionContext;
  const re = new RegExp(`${B}(v)?(\\d{1,4})\\.(\\d{1,4})\\.(\\d{1,4})(?:\\.(\\d{1,4}))?(?![\\p{L}\\p{N}]|\\.\\d)`, 'giu');
  let m;
  while ((m = re.exec(text)) !== null) {
    const parts = m.slice(2, 6).filter((x) => x !== undefined);
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const dateShape = parts.length === 3 && Number(parts[0]) >= 1 && Number(parts[0]) <= 31 && Number(parts[1]) >= 1 && Number(parts[1]) <= 12 && parts[2].length >= 2;
    // "4.480.000" groups thousands: a number, not a version.
    const thousands = parts.slice(1).every((x) => x.length === 3);
    if (thousands || (dateShape && !m[1] && !versionContext.test(before.trimEnd()))) continue;
    const v = `v:${parts.map((x) => String(Number(x))).join('.')}`;
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0], claim: [v], source: [v], nums: [] });
  }
  return out;
}

/**
 * The version reading of a date-shaped dotted triple with a two-digit last part ("4.2.10",
 * "12.3.45"): findVersions leaves it to the dates unless a version word stands before it, so the
 * same text can be a version on one side and a date on the other. Version 2 gives such a date its
 * version reading as well.
 * @param {string} surface
 * @returns {string | null}
 */
function dottedVersion(surface) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/.exec(surface.trim());
  return m ? `v:${m.slice(1).map((x) => String(Number(x))).join('.')}` : null;
}

/** Date-shaped dotted triples in a text, for dottedVersion. */
const DOTTED_TRIPLE = /(?<![\p{L}\p{N}.])\d{1,2}\.\d{1,2}\.\d{2}(?![\p{L}\p{N}]|\.\d)/gu;

/**
 * Codes that mix letters and digits (Q3, A320, 5G, v2), also with a hyphen between a short letter
 * prefix and the digits (R-02, ISO-27001, COVID-19); the hyphen is not part of the value, so
 * "R-02", "R 02" and "R02" match. Numbers with a unit or ordinal suffix ("480k", "10kg", "3rd") are
 * numbers, not codes.
 * @param {string} text
 * @returns {Found[]}
 */
function findCodes(text) {
  /** @type {Found[]} */
  const out = [];
  const re = new RegExp(`${B}(?:\\p{L}{1,6}[-‐‑‒–]\\d{1,6}|[\\p{L}\\p{N}]+)${E}`, 'gu');
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    if (!/\p{L}/u.test(token) || !/\p{N}/u.test(token)) continue;
    if (/^\d+(?:[.,]\d+)?\p{L}+$/u.test(token)) continue;
    const v = `c:${fold(token).replace('-', '')}`;
    out.push({ start: m.index, end: m.index + token.length, surface: token, claim: [v], source: [v], nums: [] });
  }
  return out;
}

/**
 * Quotations of two or more words in „…“, “…”, "…" or «…».
 * @param {string} text
 * @returns {Array<{ start: number, end: number, surface: string, words: string[] }>}
 */
function findQuotes(text) {
  /** @type {Array<{ start: number, end: number, surface: string, words: string[] }>} */
  const out = [];
  const re = /[„“"«»‚]([^„“”"«»\n]{3,300})[“”"»«]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const words = wordsOf(m[1]);
    if (words.length >= 2) out.push({ start: m.index, end: m.index + m[0].length, surface: m[0], words });
  }
  return out;
}

/**
 * Numbers in `text` (dates, times, codes and labels must already be masked).
 * @param {string} text
 * @param {boolean} claim
 */
function findNumbers(text, claim) {
  /** @type {Array<Found & { approx: boolean, sig: number }>} */
  const out = [];
  const t = tables();
  const re = new RegExp(`${B}\\d(?:[\\d.,'’\\u00A0\\u202F\\u2009]|\\x20(?=\\d{3}(?![\\p{N}])))*`, 'gu');
  let m;
  while ((m = re.exec(text)) !== null) {
    const blob = m[0].replace(/[.,'’\s]+$/u, '');
    const start = m.index;
    let end = start + blob.length;
    const parsed = parseNumber(blob);
    if (!parsed) continue;
    const rest = text.slice(end);
    const before = text.slice(Math.max(0, start - 24), start);
    if (t.ordinalAfter.test(rest)) continue;
    if (/^\p{L}/u.test(rest) && !t.scales.some(([s]) => s.test(rest)) && !t.unitAfter.test(rest) && !t.percent.test(rest)) continue;
    let scale = 1;
    for (const [s, factor] of t.scales) {
      const sm = s.exec(rest);
      if (sm) {
        scale = factor;
        end += sm[0].length;
        break;
      }
    }
    // "$4.5m": an amount after a currency sign, in millions.
    if (scale === 1 && /^m(?![\p{L}])/iu.test(rest) && /[€$£]\s?$/u.test(before)) {
      scale = 1e6;
      end += 1;
    }
    const hasUnit = scale !== 1 || t.percent.test(rest) || t.currencyAfter.test(rest) || CURRENCY_BEFORE.test(before) || t.unitAfter.test(rest);
    // Claims take the dominant reading (a separator before exactly three digits groups thousands);
    // sources keep every reading.
    const readings = (claim ? parsed.readings.slice(0, 1) : parsed.readings).map((r) => r * scale);
    const integer = !/[.,]/.test(blob) || parsed.readings[0] >= 1000;
    if (claim) {
      // A lone single digit ("3 risks", "phase 2") is too ambiguous; list numbering is not a claim.
      if (integer && parsed.readings[0] < 10 && !hasUnit) continue;
      if (/^\s*$/.test(text.slice(0, start)) && /^[.)]/.test(rest) && !/[.,]/.test(blob)) continue;
    }
    const approx = claim && t.approxBefore.test(before);
    const sig = scale !== 1 ? parsed.digits.replace(/^0+/, '').replace(/0+$/, '').length || 1 : 0;
    const values = claim ? readings.map(numKey) : [...readings, ...parsed.readings].map(numKey);
    out.push({ start, end, surface: text.slice(start, end).trim(), claim: values, source: values, nums: claim ? readings : [...readings, ...parsed.readings], approx, sig });
  }
  return out;
}

/**
 * Facts stated in an answer sentence (claim mode).
 * @param {string} sentence
 * @param {{ version?: number }} [options]  version of the source-check rules (default 2); version 1 reads no version numbers
 * @returns {Fact[]}
 */
export function extractFacts(sentence, options = {}) {
  /** @type {Fact[]} */
  const facts = [];
  let text = sentence.replace(LOOSE_LABEL_PATTERN, (s) => ' '.repeat(s.length));
  for (const q of findQuotes(text)) {
    facts.push({ kind: 'quote', surface: q.surface, start: q.start, end: q.end, values: [q.words.join(' ')], nums: [], approx: false, sig: 0 });
    text = mask(text, [[q.start, q.end]]);
  }
  if ((options.version ?? 2) >= 2) {
    for (const v of findVersions(text)) {
      facts.push({ kind: 'code', surface: v.surface, start: v.start, end: v.end, values: v.claim, nums: [], approx: false, sig: 0 });
      text = mask(text, [[v.start, v.end]]);
    }
  }
  for (const d of findDates(text)) {
    const version = (options.version ?? 2) >= 2 ? dottedVersion(d.surface) : null;
    facts.push({ kind: 'date', surface: d.surface, start: d.start, end: d.end, values: version ? [...d.claim, version] : d.claim, nums: [], approx: false, sig: 0 });
    text = mask(text, [[d.start, d.end]]);
  }
  for (const t of findTimes(text)) {
    facts.push({ kind: 'time', surface: t.surface, start: t.start, end: t.end, values: t.claim, nums: [], approx: false, sig: 0 });
    text = mask(text, [[t.start, t.end]]);
  }
  for (const w of findWeekdaysAndMonths(text, true)) {
    facts.push({ kind: w.claim[0].startsWith('w:') ? 'weekday' : 'month', surface: w.surface, start: w.start, end: w.end, values: w.claim, nums: [], approx: false, sig: 0 });
  }
  for (const c of findCodes(text)) {
    facts.push({ kind: 'code', surface: c.surface, start: c.start, end: c.end, values: c.claim, nums: [], approx: false, sig: 0 });
    text = mask(text, [[c.start, c.end]]);
  }
  for (const n of findNumbers(text, true)) {
    facts.push({ kind: 'number', surface: n.surface, start: n.start, end: n.end, values: n.claim, nums: n.nums, approx: n.approx, sig: n.sig });
  }
  for (const n of findSpelledNumbers(text)) {
    facts.push({ kind: 'number', surface: n.surface, start: n.start, end: n.end, values: n.claim, nums: n.nums, approx: n.approx, sig: 0 });
  }
  return facts.sort((a, b) => a.start - b.start);
}

/**
 * Numbers written as words in a claim ("twelve users", "zwei Wochen"), under the same rule as
 * digits: from ten upwards always, below ten only with a unit.
 * @param {string} text
 */
function findSpelledNumbers(text) {
  /** @type {Array<Found & { approx: boolean }>} */
  const out = [];
  const t = tables();
  const re = new RegExp(`${B}(${t.spelledAlt})${E}`, 'giu');
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = t.spelled.get(m[1].toLowerCase());
    const rest = text.slice(m.index + m[0].length);
    // Part of a larger number ("twenty-five", "two hundred", "ten thousand"): left to the reader.
    if (!n || n === 100 || t.spelledPartAfter.test(rest) || t.spelledPartBefore.test(text.slice(0, m.index))) continue;
    if (n < 10 && !t.unitAfter.test(rest)) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0], claim: [numKey(n)], source: [numKey(n)], nums: [n], approx: t.approxBefore.test(before) });
  }
  return out;
}

/**
 * Content tokens for the word-overlap score: BM25 tokens, folded, without source boilerplate and
 * without numbers (facts cover those).
 * @param {string} text
 */
export function contentTokens(text) {
  return tokenize(text.replace(LOOSE_LABEL_PATTERN, ' '))
    .map((w) => fold(w))
    .filter((w) => !tables().boilerplate.has(w) && !/\p{N}/u.test(w));
}

/**
 * Guesses the language of a text from function words that only one language pack has, and from
 * letters that only one pack uses (German ä, ö, ü, ß).
 * @param {string} text
 * @returns {import('./lang/index.js').LanguageCode | null}
 */
export function guessLanguage(text) {
  const { cues } = tables();
  const score = cues.map(() => 0);
  const lower = text.normalize('NFKC').toLowerCase();
  for (const w of lower.match(/\p{L}+/gu) ?? []) {
    const i = cues.findIndex((c) => c.words.has(w));
    if (i >= 0) score[i] += 1;
  }
  cues.forEach((c, i) => {
    if (c.letters?.test(lower)) score[i] += 1;
  });
  const ranked = score.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  const top = ranked[0]?.s ?? 0;
  const next = ranked[1]?.s ?? 0;
  // Short statements carry few function words: one clear signal and none for the other languages
  // is enough; otherwise one language must clearly dominate.
  if (top > 0 && next === 0) return /** @type {import('./lang/index.js').LanguageCode} */ (cues[ranked[0].i].code);
  if (top >= 2 && top >= 2 * next) return /** @type {import('./lang/index.js').LanguageCode} */ (cues[ranked[0].i].code);
  return null;
}

/**
 * Indexes an excerpt (source mode): every fact reading, every number, the folded word sequence and
 * the content tokens.
 * @param {string} text
 * @param {{ version?: number }} [options]  version of the source-check rules (default 2); version 1 reads no version numbers
 * @returns {SourceIndex}
 */
export function indexSource(text, options = {}) {
  /** @type {Set<string>} */
  const values = new Set();
  /** @type {number[]} */
  const nums = [];
  let masked = text;
  if ((options.version ?? 2) >= 2) {
    for (const v of findVersions(masked)) {
      v.source.forEach((x) => values.add(x));
      masked = mask(masked, [[v.start, v.end]]);
    }
    for (const m of masked.matchAll(DOTTED_TRIPLE)) {
      const version = dottedVersion(m[0]);
      if (version) values.add(version);
    }
  }
  // A date offers its year and a time its hour as plain numbers ("in 2026", "at 10"); the day and
  // month do not, or "30 drivers" would match "30.11.2026".
  for (const d of findDates(masked)) {
    d.source.forEach((v) => values.add(v));
    nums.push(...d.nums.filter((n) => n >= 1000));
    masked = mask(masked, [[d.start, d.end]]);
  }
  for (const t of findTimes(masked)) {
    t.source.forEach((v) => values.add(v));
    nums.push(...t.nums);
    masked = mask(masked, [[t.start, t.end]]);
  }
  for (const w of findWeekdaysAndMonths(masked, false)) w.source.forEach((v) => values.add(v));
  const codes = findCodes(masked);
  for (const c of codes) c.source.forEach((v) => values.add(v));
  // "ISO 27001" or "Q 3" in a source matches the code "ISO27001" / "Q3" in a claim.
  const tokens = [...fold(masked).matchAll(/[\p{L}\p{N}]+/gu)].map((x) => x[0]);
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const [a, b] = [tokens[i], tokens[i + 1]];
    if ((/^\p{L}{1,6}$/u.test(a) && /^\d+$/.test(b)) || (/^\d+$/.test(a) && /^\p{L}{1,3}$/u.test(b))) values.add(`c:${a}${b}`);
  }
  for (const c of codes) masked = mask(masked, [[c.start, c.end]]);
  for (const n of findNumbers(masked, false)) {
    n.source.forEach((v) => values.add(v));
    nums.push(...n.nums);
  }
  for (const w of wordsOf(text)) {
    const n = tables().spelledFolded.get(w);
    if (n) {
      values.add(numKey(n));
      nums.push(n);
    }
  }
  for (const n of nums) values.add(numKey(n));

  const content = new Set(contentTokens(text));
  /** @type {Map<string, string[]>} */
  const prefixes = new Map();
  const long = [];
  for (const tok of content) {
    if (tok.length < 5) continue;
    long.push(tok);
    const p = tok.slice(0, 5);
    const list = prefixes.get(p);
    if (list) list.push(tok);
    else prefixes.set(p, [tok]);
  }
  return { values, nums, words: ` ${wordsOf(text).join(' ')} `, tokens: content, prefixes, long, lang: guessLanguage(text) };
}

/**
 * Whether a content token occurs in the index, tolerating inflection (shared prefix of 5+
 * characters, at most 4 characters left over) and German compounds.
 * @param {string} token
 * @param {SourceIndex} index
 */
export function tokenMatches(token, index) {
  if (index.tokens.has(token)) return true;
  if (token.length < 5) return false;
  for (const cand of index.prefixes.get(token.slice(0, 5)) ?? []) {
    let common = 0;
    while (common < cand.length && common < token.length && cand[common] === token[common]) common += 1;
    if (common >= Math.max(5, Math.max(cand.length, token.length) - 4)) return true;
  }
  for (const cand of index.long) {
    if ((token.length >= 8 && token.includes(cand)) || (cand.length >= 8 && cand.includes(token))) return true;
  }
  return false;
}

/**
 * Looks a claim fact up in an excerpt index.
 * @param {Fact} fact
 * @param {SourceIndex} index
 * @param {number} [tolerance] relative tolerance for approximate numbers
 * @returns {{ found: 'exact' | 'approx' | 'partial' | null, detail?: string }}
 */
export function lookupFact(fact, index, tolerance = 0.05) {
  if (fact.kind === 'quote') {
    const phrase = fact.values[0];
    if (index.words.includes(` ${phrase} `)) return { found: 'exact' };
    const words = phrase.split(' ');
    const present = words.filter((w) => index.words.includes(` ${w} `)).length;
    return present / words.length >= 0.8 ? { found: 'partial' } : { found: null };
  }
  if (fact.values.some((v) => index.values.has(v))) return { found: 'exact' };
  if (fact.kind !== 'number' || !fact.nums.length) return { found: null };
  for (const n of fact.nums) {
    for (const s of index.nums) {
      if (s === 0 || n === 0) continue;
      const close = Math.abs(s - n) <= tolerance * Math.max(Math.abs(s), Math.abs(n));
      // "4.5 million" for 4,480,000: rounding to the digits written is an approximation, not an error.
      const rounded = fact.sig > 0 && roundSig(s, fact.sig) === roundSig(n, fact.sig);
      if ((fact.approx && close) || rounded) return { found: 'approx', detail: formatPlain(s) };
    }
  }
  return { found: null };
}

/**
 * @param {number} n
 * @param {number} digits
 */
function roundSig(n, digits) {
  if (n === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(n)));
  const factor = 10 ** (magnitude - digits + 1);
  return Math.round(Math.round(n / factor) * factor * 1e6) / 1e6;
}

/** @param {number} n */
function formatPlain(n) {
  return String(Math.round(n * 1e6) / 1e6);
}
