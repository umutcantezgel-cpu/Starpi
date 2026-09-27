// @ts-check
// Facts for the source check: the numbers, dates, times, weekdays, months, codes and quotations a
// sentence states, and an index of the same facts in an excerpt.
//
// Claim mode (answer sentences) is strict and extracts only what it is sure about. Source mode
// (excerpts) is lenient and records every plausible reading. A fact copied verbatim, or rewritten
// between English and German formats ("480.000" / "480,000", "28.08.2026" / "August 28, 2026"),
// therefore always matches, while a changed value does not. Pure: no DOM, runs in Node too.
import { STOPWORDS_DE, STOPWORDS_EN, tokenize } from '../rag/bm25.js';
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
 * @property {'en' | 'de' | null} lang
 */

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

const MONTHS = new Map(
  Object.entries({
    january: 1, jan: 1, januar: 1, jänner: 1, jaenner: 1,
    february: 2, feb: 2, februar: 2,
    march: 3, mar: 3, märz: 3, maerz: 3, mär: 3,
    april: 4, apr: 4,
    may: 5, mai: 5,
    june: 6, jun: 6, juni: 6,
    july: 7, jul: 7, juli: 7,
    august: 8, aug: 8,
    september: 9, sep: 9, sept: 9,
    october: 10, oct: 10, oktober: 10, okt: 10,
    november: 11, nov: 11,
    december: 12, dec: 12, dezember: 12, dez: 12,
  }),
);
const alternation = (/** @type {Iterable<string>} */ words) => [...words].sort((a, b) => b.length - a.length).join('|');
const MONTH_ALT = alternation(MONTHS.keys());
const FULL_MONTH_ALT = alternation([...MONTHS.keys()].filter((m) => (m.length >= 4 && m !== 'sept') || m === 'may' || m === 'mai'));

const WEEKDAYS = new Map(
  Object.entries({
    monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
    montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6, sonntag: 7,
  }),
);
const WEEKDAY_ALT = alternation(WEEKDAYS.keys());

/** Words before a month name that make it a date ("in August", "bis Mai"), not a name or verb. */
const MONTH_CONTEXT = 'in|im|on|by|until|till|bis|ab|seit|since|from|vom|von|of|early|late|mid|end|ende|anfang|mitte|during|während|next|last|this|nächsten|kommenden|zum|per';

const SCALES = /** @type {Array<[RegExp, number]>} */ ([
  [/^\s?(?:k|tsd\.?|tausend|thousand)(?![\p{L}])/iu, 1e3],
  [/^\s?(?:mio\.?|millionen|million|millions|mn)(?![\p{L}])/iu, 1e6],
  [/^\s?(?:mrd\.?|milliarden|milliarde|billion|billions|bn)(?![\p{L}])/iu, 1e9],
]);
const PERCENT = /^\s?(?:%|prozent|percent|per\s?cent)(?![\p{L}])/iu;
const CURRENCY_AFTER = /^\s?(?:€|\$|£|eur|euro|usd|dollar|chf|gbp)(?![\p{L}])/iu;
const CURRENCY_BEFORE = /(?:€|\$|£|eur|usd|chf|gbp)\s?$/iu;
const UNIT_AFTER =
  /^\s?(?:x|h|std|min|s|sek|ms|tage?n?|days?|wochen?|weeks?|monate?n?|months?|jahre?n?|years?|kg|g|t|km|m|cm|mm|gb|mb|tb|kb|px|pt|°|stück|pcs|personen|people|mitarbeiter(?:innen)?|employees|users?|nutzer(?:innen)?|teams?|sprints?|phasen?|phases?|stufen?|stages?)(?![\p{L}])/iu;
const ORDINAL_AFTER = /^(?:st|nd|rd|th)(?![\p{L}])/iu;
const APPROX_BEFORE =
  /(?:about|around|approximately|approx\.?|roughly|nearly|almost|some|over|more than|less than|under|up to|circa|ca\.|rund|etwa|ungefähr|ungefaehr|fast|knapp|über|mehr als|weniger als|bis zu|~|≈)\s*(?:[€$£]\s?)?$/iu;

const SPELLED = new Map(
  Object.entries({
    two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
    zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12,
    dreizehn: 13, vierzehn: 14, fünfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20,
    dreißig: 30, dreissig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90, hundert: 100,
  }),
);

const SPELLED_FOLDED = new Map([...SPELLED].map(([w, n]) => [fold(w), n]));
const NUMBER_WORD = `${alternation(SPELLED.keys())}|one|eins?|thousand|tausend|million|millionen|mio|billion|milliarden?|mrd|dozen|dutzend`;
// "and" joins two number words ("a hundred and twenty"); between other words it is just "and".
const SPELLED_PART_AFTER = new RegExp(`^[\\s-]+(?:(?:and|und)\\s+)?(?:${NUMBER_WORD})(?![\\p{L}])|^[\\s-]*\\d`, 'iu');
const SPELLED_PART_BEFORE = new RegExp(`(?<![\\p{L}])(?:${NUMBER_WORD})(?:\\s+(?:and|und))?[\\s-]+$|\\d[\\s-]*$`, 'iu');

/** Words that describe the sources rather than stating something. */
const BOILERPLATE = new Set([
  'according', 'laut', 'gemaess', 'source', 'sources', 'quelle', 'quellen', 'document', 'documents', 'dokument',
  'dokumente', 'dokumenten', 'excerpt', 'excerpts', 'auszug', 'auszuege', 'auszuegen', 'mentioned', 'genannt',
  'erwaehnt', 'states', 'stated', 'says', 'heisst', 'steht', 'chunk', 'doc', 'file', 'datei', 'text', 'based',
  'basierend', 'shown', 'angegeben', 'listed', 'aufgefuehrt',
  // words that qualify a number (the number itself is checked as a fact)
  'about', 'around', 'approximately', 'approx', 'roughly', 'nearly', 'almost', 'circa', 'rund', 'etwa', 'ungefaehr',
  'knapp', 'thousand', 'tausend', 'tsd', 'million', 'millions', 'millionen', 'mio', 'billion', 'billions', 'milliarde',
  'milliarden', 'mrd', 'percent', 'prozent',
]);

const EN_ONLY = new Set([...STOPWORDS_EN].filter((w) => !STOPWORDS_DE.has(w)));
const DE_ONLY = new Set([...STOPWORDS_DE].filter((w) => !STOPWORDS_EN.has(w)));

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
  const month = (/** @type {string} */ name) => MONTHS.get(fold(name).replace(/\.$/, '')) ?? MONTHS.get(name.toLowerCase().replace(/\.$/, '')) ?? 0;
  /** @type {Array<[RegExp, (m: RegExpExecArray) => Array<{ y: number, mo: number, d: number }> | null, boolean?]>} */
  const patterns = [
    [new RegExp(`${B}(\\d{4})-(\\d{1,2})-(\\d{1,2})${E}`, 'gu'), (m) => [{ y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }]],
    [new RegExp(`${B}(\\d{1,2})\\.\\s?(\\d{1,2})\\.\\s?(\\d{4}|\\d{2})${E}`, 'gu'), (m) => [{ y: fullYear(m[3]), mo: Number(m[2]), d: Number(m[1]) }]],
    [
      new RegExp(`${B}(\\d{1,2})\\.\\s*(${MONTH_ALT})\\.?(?:\\s+(\\d{4}))?${E}`, 'giu'),
      (m) => [{ y: m[3] ? Number(m[3]) : 0, mo: month(m[2]), d: Number(m[1]) }],
    ],
    [
      new RegExp(`${B}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?${E}`, 'giu'),
      (m) => (m[2] === 'may' ? null : [{ y: m[3] ? Number(m[3]) : 0, mo: month(m[2]), d: Number(m[1]) }]),
    ],
    [
      new RegExp(`${B}(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${E}`, 'giu'),
      (m) => (m[1] === 'may' ? null : [{ y: m[3] ? Number(m[3]) : 0, mo: month(m[1]), d: Number(m[2]) }]),
    ],
    [new RegExp(`${B}(${MONTH_ALT})\\.?\\s+(\\d{4})${E}`, 'giu'), (m) => (m[1] === 'may' ? null : [{ y: Number(m[2]), mo: month(m[1]), d: 0 }])],
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
      new RegExp(`(?<![\\p{L}])(?:am|vom|bis|ab|zum|seit|den|dem)\\s+(\\d{1,2})\\.(\\d{1,2})\\.(?![\\p{N}])`, 'giu'),
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
  const ampm = (/** @type {number} */ h, /** @type {string | undefined} */ suffix) => {
    const s = (suffix ?? '').toLowerCase().replace(/\./g, '');
    if (s === 'pm' && h < 12) return h + 12;
    if (s === 'am' && h === 12) return 0;
    return h;
  };
  /** @type {RegExpExecArray | null} */
  let m;
  const colon = new RegExp(`${B}([01]?\\d|2[0-3]):([0-5]\\d)(?:\\s*(uhr|h|am|pm|a\\.m\\.|p\\.m\\.))?(?![\\p{N}])`, 'giu');
  while ((m = colon.exec(text)) !== null) push(m, ampm(Number(m[1]), m[3]), Number(m[2]));
  const dotUhr = new RegExp(`${B}([01]?\\d|2[0-3])\\.([0-5]\\d)\\s*uhr${E}`, 'giu');
  while ((m = dotUhr.exec(text)) !== null) push(m, Number(m[1]), Number(m[2]));
  const hourOnly = new RegExp(`${B}(1[0-2]|0?[1-9])\\s*(am|pm|a\\.m\\.|p\\.m\\.)(?![\\p{L}])|${B}([01]?\\d|2[0-3])\\s*uhr${E}`, 'giu');
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
  const days = new RegExp(`${B}(${WEEKDAY_ALT})s?${E}`, 'giu');
  while ((m = days.exec(text)) !== null) {
    const v = `w:${WEEKDAYS.get(m[1].toLowerCase())}`;
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0], claim: [v], source: [v], nums: [] });
  }
  const months = claim
    ? new RegExp(`(?<![\\p{L}])(?:${MONTH_CONTEXT})\\s+(?:(?:early|late|mid|end of|ende|anfang|mitte)\\s+)?(${FULL_MONTH_ALT})${E}`, 'giu')
    : new RegExp(`${B}(${FULL_MONTH_ALT})${E}`, 'giu');
  while ((m = months.exec(text)) !== null) {
    if (claim && m[1] === 'may') continue;
    const n = MONTHS.get(m[1].toLowerCase()) ?? MONTHS.get(fold(m[1]));
    if (!n) continue;
    const v = `mo:${pad2(n)}`;
    const start = m.index + m[0].length - m[1].length;
    out.push({ start, end: m.index + m[0].length, surface: m[1], claim: [v], source: [v], nums: [] });
  }
  return out;
}

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
    if (ORDINAL_AFTER.test(rest)) continue;
    if (/^\p{L}/u.test(rest) && !SCALES.some(([s]) => s.test(rest)) && !UNIT_AFTER.test(rest) && !PERCENT.test(rest)) continue;
    let scale = 1;
    for (const [s, factor] of SCALES) {
      const sm = s.exec(rest);
      if (sm) {
        scale = factor;
        end += sm[0].length;
        break;
      }
    }
    if (scale === 1 && /^m(?![\p{L}])/iu.test(rest) && /[€$£]\s?$/u.test(before)) {
      scale = 1e6;
      end += 1;
    }
    const hasUnit = scale !== 1 || PERCENT.test(rest) || CURRENCY_AFTER.test(rest) || CURRENCY_BEFORE.test(before) || UNIT_AFTER.test(rest);
    // Claims take the dominant reading (a separator before exactly three digits groups thousands);
    // sources keep every reading.
    const readings = (claim ? parsed.readings.slice(0, 1) : parsed.readings).map((r) => r * scale);
    const integer = !/[.,]/.test(blob) || parsed.readings[0] >= 1000;
    if (claim) {
      // A lone single digit ("3 risks", "phase 2") is too ambiguous; list numbering is not a claim.
      if (integer && parsed.readings[0] < 10 && !hasUnit) continue;
      if (/^\s*$/.test(text.slice(0, start)) && /^[.)]/.test(rest) && !/[.,]/.test(blob)) continue;
    }
    const approx = claim && APPROX_BEFORE.test(before);
    const sig = scale !== 1 ? parsed.digits.replace(/^0+/, '').replace(/0+$/, '').length || 1 : 0;
    const values = claim ? readings.map(numKey) : [...readings, ...parsed.readings].map(numKey);
    out.push({ start, end, surface: text.slice(start, end).trim(), claim: values, source: values, nums: claim ? readings : [...readings, ...parsed.readings], approx, sig });
  }
  return out;
}

/**
 * Facts stated in an answer sentence (claim mode).
 * @param {string} sentence
 * @returns {Fact[]}
 */
export function extractFacts(sentence) {
  /** @type {Fact[]} */
  const facts = [];
  let text = sentence.replace(LOOSE_LABEL_PATTERN, (s) => ' '.repeat(s.length));
  for (const q of findQuotes(text)) {
    facts.push({ kind: 'quote', surface: q.surface, start: q.start, end: q.end, values: [q.words.join(' ')], nums: [], approx: false, sig: 0 });
    text = mask(text, [[q.start, q.end]]);
  }
  for (const d of findDates(text)) {
    facts.push({ kind: 'date', surface: d.surface, start: d.start, end: d.end, values: d.claim, nums: [], approx: false, sig: 0 });
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
  const re = new RegExp(`${B}(${alternation(SPELLED.keys())})${E}`, 'giu');
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = SPELLED.get(m[1].toLowerCase());
    const rest = text.slice(m.index + m[0].length);
    // Part of a larger number ("twenty-five", "two hundred", "ten thousand"): left to the reader.
    if (!n || n === 100 || SPELLED_PART_AFTER.test(rest) || SPELLED_PART_BEFORE.test(text.slice(0, m.index))) continue;
    if (n < 10 && !UNIT_AFTER.test(rest)) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0], claim: [numKey(n)], source: [numKey(n)], nums: [n], approx: APPROX_BEFORE.test(before) });
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
    .filter((w) => !BOILERPLATE.has(w) && !/\p{N}/u.test(w));
}

/**
 * Guesses English or German from function words that exist in only one of the two languages.
 * @param {string} text
 * @returns {'en' | 'de' | null}
 */
export function guessLanguage(text) {
  let en = 0;
  let de = 0;
  const lower = text.normalize('NFKC').toLowerCase();
  for (const w of lower.match(/\p{L}+/gu) ?? []) {
    if (EN_ONLY.has(w)) en += 1;
    else if (DE_ONLY.has(w)) de += 1;
  }
  if (/[äöüß]/.test(lower)) de += 1;
  // Short statements carry few function words: one clear signal and none for the other language
  // is enough; otherwise one language must clearly dominate.
  if (en > 0 && de === 0) return 'en';
  if (de > 0 && en === 0) return 'de';
  if (en >= 2 && en >= 2 * de) return 'en';
  if (de >= 2 && de >= 2 * en) return 'de';
  return null;
}

/**
 * Indexes an excerpt (source mode): every fact reading, every number, the folded word sequence and
 * the content tokens.
 * @param {string} text
 * @returns {SourceIndex}
 */
export function indexSource(text) {
  /** @type {Set<string>} */
  const values = new Set();
  /** @type {number[]} */
  const nums = [];
  let masked = text;
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
    const n = SPELLED_FOLDED.get(w);
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
