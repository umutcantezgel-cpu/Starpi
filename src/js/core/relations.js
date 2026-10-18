// @ts-check
// Relations for the source check (version 3). A statement can repeat every value of its excerpt and
// still turn what the excerpt says around: "printed loans rose from 212,000 to 198,500", "the
// reading hall had more visits than the children's room", "version 8.1 came out before version
// 8.0", or, across two statements, "Revenue was 5.9 million EUR in the first quarter. In the second
// quarter it fell to 6.8 million EUR." This module finds such relations in a statement (and in the
// statement before it) and checks them against the values in the cited excerpts:
//
// - changes: "rose / fell / doubled / halved from A to B", "rose to B", "B, up from A" (and the
//   German "stieg / sank / verdoppelte sich von A auf B"), with factor phrases read by the verb
//   ("rose by half") and hedged factors as bounds ("more than doubled");
// - comparisons: "more / fewer / higher / lower … than", "twice as many … as" (and "mehr / weniger
//   / höher / niedriger … als", "doppelt so viele … wie"), between two values, two things or two
//   periods, whose values are looked up in the excerpts;
// - order in time: "before / after / earlier than / later than / followed / preceded" (and "bevor /
//   nachdem / vor / nach / früher als / später als / gefolgt von"), between two dated events, the
//   passive the other way round ("X was followed by Y");
// - carried-over values: "it rose to B", "that number shrank to B", "es waren weniger, nämlich B",
//   compared with the single value of the statement before;
// - shares: "X % of …" with both values in the statement.
//
// A relation is reported only when the excerpts decide it: both values (or dates) are found and
// bound to the two sides without ambiguity. It is "inverted" when the excerpts give the opposite
// direction or order, "unsupported" when they give the direction but not the stated factor or share
// (or two equal values for a comparison), "supported" otherwise. Negated and conditional clauses
// are left alone. The result depends only on the statements, their order and the excerpts they cite,
// so a receipt recomputes it.
//
// Pure: no DOM, runs in the browser, in workers and in Node.
import { contentTokens, extractFacts, fold, guessLanguage, indexSource, lookupFact, parseNumber, tokenMatches } from './facts.js';
import { sentenceSpans } from './sentences.js';

/** @typedef {import('./facts.js').Fact} Fact */
/** @typedef {import('./facts.js').SourceIndex} SourceIndex */

/**
 * One statement as the relation check reads it.
 * @typedef {object} RelationStatement
 * @property {string} text
 * @property {number[]} cites  excerpts the statement cites
 * @property {boolean} [context]  only context for the statement after it (a receipt statement that cannot be recomputed): not checked itself
 */

/**
 * @typedef {object} RelationFinding
 * @property {'comparative' | 'temporal' | 'reference'} kind
 * @property {number[]} sentences  one or two indexes into the statements, the statement that states the relation last
 * @property {number[]} cites  the excerpts the decision rests on
 * @property {'supported' | 'inverted' | 'unsupported'} verdict
 * @property {string} text  the words of the statement that state the relation
 * @property {string} found  the excerpt passages the decision rests on
 */

/**
 * @typedef {object} RelationOptions
 * @property {(sentence: string) => string[]} split  cuts a sentence into one part per value (grounding.js valueParts)
 */

/** Thresholds of the relation checks. */
export const RELATIONS = Object.freeze({
  /** relative distance between a stated factor or share and the one the values give */
  factorTolerance: 0.1,
  /** relative distance a factor stated as "nearly" ("nearly doubled", "knapp verdoppelt") may fall short */
  hedgeReach: 0.3,
  /** absolute distance in percentage points for "X % of" */
  shareTolerance: 0.5,
  /** characters of a statement quoted as the relation */
  textChars: 160,
  /** a value carried over from the statement before: at most this many statements back */
  referenceDistance: 1,
});

const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
/** @param {string} words @param {string} [flags] */
const words = (words, flags = 'giu') => new RegExp(`${L}(?:${words})${R}`, flags);

// --- Lexicons (English and German, as written; matched case-insensitively) ---------------------

const UP = 'rose|rises?|risen|rising|increased|increases?|increasing|grew|grows?|grown|growing|climbed|climbs?|climbing|jumped|jumps?|gained|soared|went up|gone up|goes up|moved up|stieg|stiegen|steigt|steigen|gestiegen|erhöhte|erhöhten|wuchs|wuchsen|gewachsen|wächst|kletterte|kletterten|zugenommen|zugelegt';
const DOWN = 'fell|falls?|fallen|falling|dropped|drops?|dropping|decreased|decreases?|decreasing|declined|declines?|declining|sank|sinks?|sunk|shrank|shrunk|shrinks?|went down|gone down|goes down|came down|lowered|sanken|sinkt|sinken|gesunken|fiel|fielen|fällt|gefallen|zurückgegangen|verringerte|verringerten|verringert|reduzierte|reduzierten|abgenommen|schrumpfte|schrumpften|geschrumpft';
/** Separable German verbs: the finite part and the particle that must close the clause. */
const SEPARABLE = [
  { re: words('ging|gingen|geht|gehen'), particle: /(?<![\p{L}])zurück(?![\p{L}])/iu, dir: -1 },
  { re: words('nahm|nahmen|nimmt|nehmen'), particle: /(?<![\p{L}])ab(?![\p{L}])/iu, dir: -1 },
  { re: words('nahm|nahmen|nimmt|nehmen|legte|legten|legt'), particle: /(?<![\p{L}])zu(?![\p{L}])/iu, dir: 1 },
];
/** Factor verbs: the factor they state. */
const FACTORS = /** @type {Array<[RegExp, number]>} */ ([
  [words('doubled|doubles|doubling|verdoppelte|verdoppelten|verdoppelt'), 2],
  [words('tripled|triples|tripling|verdreifachte|verdreifachten|verdreifacht'), 3],
  [words('quadrupled|quadruples|vervierfachte|vervierfachten|vervierfacht'), 4],
  [words('halved|halves|halving|cut in half|halbierte|halbierten|halbiert'), 0.5],
]);
/**
 * Factor phrases next to a change verb. "to a third" ("auf ein Drittel") names where the value went,
 * as a share of where it was; "by a third" ("um ein Drittel") names how much of it was gained or
 * lost, so its factor follows the verb: "fell by half" is 0.5, "rose by half" 1.5.
 */
const FACTOR_PHRASES = /** @type {Array<[RegExp, 'to' | 'by', number]>} */ ([
  [words('to (?:a|one) third|auf ein drittel'), 'to', 1 / 3],
  [words('to two thirds|auf zwei drittel'), 'to', 2 / 3],
  [words('to (?:a|one) quarter|auf ein viertel'), 'to', 1 / 4],
  [words('to three quarters|auf drei viertel'), 'to', 3 / 4],
  [words('to (?:a |one )?half|auf die hälfte'), 'to', 1 / 2],
  [words('by (?:a|one) third|um ein drittel'), 'by', 1 / 3],
  [words('by two thirds|um zwei drittel'), 'by', 2 / 3],
  [words('by (?:a|one) quarter|um ein viertel'), 'by', 1 / 4],
  [words('by three quarters|um drei viertel'), 'by', 3 / 4],
  [words('by (?:a |one )?half|um die hälfte'), 'by', 1 / 2],
]);
/**
 * Words right before a factor that make it a bound or an estimate: "more than doubled" (at least
 * the factor), "nearly tripled" (not quite), "roughly halved" (about). A bound is checked as a bound,
 * an estimate with twice the tolerance.
 * @typedef {'exact' | 'over' | 'under' | 'about'} Hedge
 */
const HEDGES = /** @type {Array<[RegExp, Hedge]>} */ ([
  [/(?<![\p{L}])(?:more than|at least|well over|over|mehr als|mindestens|gut)\s+$/iu, 'over'],
  [/(?<![\p{L}])(?:nearly|almost|close to|just under|less than|fast|beinahe|nahezu|annähernd|knapp|weniger als)\s+$/iu, 'under'],
  [/(?<![\p{L}])(?:about|roughly|around|approximately|some|etwa|rund|ungefähr|circa|ca\.)\s+$/iu, 'about'],
]);
const MORE = 'more|higher|greater|larger|bigger|longer|warmer|hotter|heavier|older|mehr|höher(?:e[nmrs]?)?|größer(?:e[nmrs]?)?|länger(?:e[nmrs]?)?|wärmer(?:e[nmrs]?)?|häufiger|öfter|stärker(?:e[nmrs]?)?|älter(?:e[nmrs]?)?';
const LESS = 'less|fewer|lower|smaller|shorter|colder|cooler|lighter|younger|weniger|niedriger(?:e[nmrs]?)?|geringer(?:e[nmrs]?)?|kleiner(?:e[nmrs]?)?|kürzer(?:e[nmrs]?)?|kälter(?:e[nmrs]?)?|seltener(?:e[nmrs]?)?';
const EARLIER = 'earlier|sooner|früher';
const LATER = 'later|später';
const THAN = words('than|als', 'iu');
/** "twice as many … as", "doppelt so viele … wie": the factor and the word that closes the comparison. */
const AS_FACTORS = /** @type {Array<[RegExp, number]>} */ ([
  [words('twice as|two times as|doppelt so|zweimal so', 'giu'), 2],
  [words('three times as|dreimal so', 'giu'), 3],
  [words('half as|halb so', 'giu'), 0.5],
]);
const AS = words('as|wie', 'iu');
/** Right after "more than" / "mehr als": a factor, not the other side of a comparison ("more than doubled", "mehr als doppelt so viele"). */
const FACTOR_AFTER = new RegExp(`^\\s*(?:${[...FACTORS, ...AS_FACTORS].map(([re]) => re.source).join('|')}|${L}(?:double|triple|half|twice|thrice|doppelt|halb|die hälfte|das doppelte|das dreifache)${R})`, 'iu');
/**
 * Order in time: the side that comes first is `left` (before) or `right` (after). `voice`: the cue is
 * an active verb whose passive or participle turns the order around ("X followed Y" against "X was
 * followed by Y" and "X, followed by Y").
 */
const TEMPORAL = /** @type {Array<{ re: RegExp, order: 1 | -1, prep: boolean, lang: 'en' | 'de' | null, dated: boolean, voice?: boolean }>} */ ([
  { re: words('before|prior to|ahead of|bevor'), order: -1, prep: false, lang: null, dated: true },
  { re: words('after|following|nachdem'), order: 1, prep: false, lang: null, dated: true },
  { re: words('preceded'), order: -1, prep: false, lang: null, dated: false, voice: true },
  { re: words('followed'), order: 1, prep: false, lang: null, dated: false, voice: true },
  { re: words('folgte auf|folgten auf'), order: 1, prep: false, lang: null, dated: false },
  // "X, gefolgt von Y": the participle, X first.
  { re: words('gefolgt vo[nm]'), order: -1, prep: false, lang: null, dated: false },
  // German prepositions: only before a noun phrase that names a dated event of the excerpts.
  { re: words('vor'), order: -1, prep: true, lang: 'de', dated: true },
  { re: words('nach'), order: 1, prep: true, lang: 'de', dated: true },
]);
/** Before "followed" / "preceded": an auxiliary (with an adverb) or a comma make it a passive or a participle. */
const PASSIVE_BEFORE = /(?:(?<![\p{L}])(?:am|is|are|was|were|be|been|being|get|gets|got)(?:\s+\p{L}+ly)?|,)\s*$/iu;
/** After "followed" / "preceded": "by" names the other side of a passive. */
const PASSIVE_BY = /^\s+by(?![\p{L}])/iu;
/** A relation in a clause with one of these is not checked: negated or conditional. */
const GUARD = words("not|n't|never|no|none|nobody|neither|nor|without|unless|if|whether|nicht|nie|niemals|kein|keine|keinen|keinem|keiner|keines|ohne|wenn|falls|sofern|ob");
/** Words that refer back to the statement before ("it", "that number", "es", "ihre Zahl"). */
const REFERENCE = new Set(['it', 'they', 'this', 'that', 'these', 'those', 'number', 'figure', 'total', 'amount', 'er', 'sie', 'es', 'dieser', 'diese', 'dieses', 'diesen', 'zahl', 'wert', 'anzahl', 'betrag']);
/** Words of the lexicons and function words that never tell two sides apart. */
const NOT_KEYS = new Set([
  ...['more', 'less', 'fewer', 'higher', 'lower', 'greater', 'larger', 'bigger', 'smaller', 'longer', 'shorter', 'warmer', 'colder', 'earlier', 'later', 'than', 'twice', 'half', 'times', 'mehr', 'weniger', 'hoeher', 'niedriger', 'groesser', 'kleiner', 'geringer', 'laenger', 'kuerzer', 'waermer', 'kaelter', 'haeufiger', 'frueher', 'spaeter', 'doppelt', 'halb', 'dreimal', 'zweimal', 'als', 'wie'],
  ...['before', 'after', 'prior', 'ahead', 'following', 'followed', 'preceded', 'gefolgt', 'bevor', 'nachdem', 'vor', 'nach', 'folgte', 'folgten', 'erst', 'noch', 'bereits', 'schon', 'also', 'damit', 'weeks', 'days', 'months', 'wochen', 'tage', 'monate', 'year', 'jahr'],
  ...['eur', 'euro', 'euros', 'usd', 'dollar', 'dollars', 'chf', 'gbp', 'percent', 'prozent', 'million', 'millionen', 'billion', 'milliarden', 'mio', 'mrd'],
  ...['third', 'thirds', 'quarter', 'quarters', 'drittel', 'viertel', 'haelfte', 'two', 'three', 'zwei', 'drei'],
]);
/** Words before a number that make it a version or an identifier, not a quantity. */
const VERSION_BEFORE = /(?:version|versions|firmware|release|v|build|nr|no|number|nummer)\.?\s*$/iu;

const UP_RE = words(UP);
const DOWN_RE = words(DOWN);
const MORE_RE = words(MORE);
const LESS_RE = words(LESS);
const EARLIER_RE = words(EARLIER);
const LATER_RE = words(LATER);
const FROM = words('from|von', 'iu');
const TO = words('to|auf', 'iu');
const UP_FROM = words('up from|down from', 'giu');
/** Clause boundaries: a relation and its values stay within one. */
const CLAUSE = /[;:]\s+|,\s+|\s+(?:while|whereas|but|während|wobei|aber|sowie)\s+|\s[–—-]\s/giu;
/** Boundaries of the right side of a comparison or of an order in time (not the dot or comma of a number). */
const SIDE_END = /[;:!?]|[.,](?!\d)|\s(?:and|but|while|whereas|und|aber|während|wobei|sowie)\s|\s[–—-]\s/iu;
/** Punctuation that ends a clause (not the dot or comma of a number). */
const PUNCT = /[;:!?]|[.,](?!\d)/u;

// --- Values -------------------------------------------------------------------------------------

/**
 * The value of a number fact, or null.
 * @param {Fact} f
 */
const valueOf = (f) => (f.kind === 'number' && f.nums.length ? f.nums[0] : null);

/**
 * A year that names a period ("in 2025", "the 2024 budget"): a label, not a quantity.
 * @param {Fact} f
 */
const isYear = (f) => f.kind === 'number' && /^\d{4}$/.test(f.surface.trim()) && Number(f.surface) >= 1900 && Number(f.surface) <= 2100;

/**
 * A number that is a quantity: not a year, not a version or identifier.
 * @param {string} text
 * @param {Fact} f
 */
function isQuantity(text, f) {
  return f.kind === 'number' && valueOf(f) !== null && !isYear(f) && !VERSION_BEFORE.test(text.slice(Math.max(0, f.start - 12), f.start));
}

/**
 * The unit written next to a number: a class for percent, currency and degrees, else the next word
 * (folded), else ''.
 * @param {string} text
 * @param {Fact} f
 */
function unitOf(text, f) {
  if (/[€$£]\s?$/u.test(text.slice(Math.max(0, f.start - 2), f.start))) return 'currency';
  const m = /^\s?(%|‰|€|\$|£|°\s?[CF]|[\p{L}]+)/u.exec(text.slice(f.end));
  if (!m) return '';
  const w = fold(m[1].replace(/\s/g, ''));
  if (w === '%' || w === 'percent' || w === 'prozent') return 'percent';
  if (['€', '$', '£', 'eur', 'euro', 'euros', 'usd', 'dollar', 'dollars', 'chf', 'gbp'].includes(w)) return 'currency';
  if (/^°[cf]$/.test(w) || w === 'grad') return 'degrees';
  return w;
}

const STRONG = new Set(['percent', 'currency', 'degrees']);

/**
 * Whether two units can measure the same thing: equal, or one of them unwritten; percent, currency
 * and degrees only go with themselves.
 * @param {string} a
 * @param {string} b
 */
function unitsMatch(a, b) {
  if (a === b || !a || !b) return true;
  return !STRONG.has(a) && !STRONG.has(b);
}

/**
 * The scale written with a number ("6.8 million" → 1,000,000), or 1.
 * @param {Fact} f
 */
function scaleOf(f) {
  const v = valueOf(f);
  if (v === null || !f.sig) return 1;
  const lead = /^[\d.,\s]+/.exec(f.surface)?.[0]?.trim() ?? '';
  const plain = lead ? parseNumber(lead)?.readings?.[0] : undefined;
  return plain ? Math.round(v / plain) || 1 : 1;
}

/**
 * Two numbers of one change or comparison on the same scale: "von 0,9 auf 1,8 Millionen" is 0.9 and
 * 1.8 million.
 * @param {Fact} a
 * @param {Fact} b
 * @returns {[number, number]}
 */
function aligned(a, b) {
  const va = /** @type {number} */ (valueOf(a));
  const vb = /** @type {number} */ (valueOf(b));
  const sa = scaleOf(a);
  const sb = scaleOf(b);
  if (sa === 1 && sb > 1 && Math.abs(va) < 1000) return [va * sb, vb];
  if (sb === 1 && sa > 1 && Math.abs(vb) < 1000) return [va, vb * sa];
  return [va, vb];
}

/** @param {number} a @param {number} b */
const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * The day a date fact names, as a comparable number, and whether it has a year.
 * @param {Fact} f
 * @returns {{ key: number, year: boolean } | null}
 */
function dayOf(f) {
  if (f.kind !== 'date') return null;
  for (const v of f.values) {
    const full = /^d:(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (full) return { key: Number(full[1]) * 10_000 + Number(full[2]) * 100 + Number(full[3]), year: true };
    const partial = /^d:--(\d{2})-(\d{2})$/.exec(v);
    if (partial) return { key: Number(partial[1]) * 100 + Number(partial[2]), year: false };
  }
  return null;
}

/**
 * Order of two dates: -1, 0 or 1, or null when one has a year and the other not.
 * @param {Fact} a
 * @param {Fact} b
 */
function compareDays(a, b) {
  const da = dayOf(a);
  const db = dayOf(b);
  if (!da || !db || da.year !== db.year) return null;
  return Math.sign(da.key - db.key);
}

// --- Excerpts -----------------------------------------------------------------------------------

/**
 * A part of an excerpt that states (at most) one value, with its words and facts.
 * @typedef {{ text: string, index: SourceIndex, facts: Fact[], source: number, id: number }} Part
 */

/**
 * A change an excerpt states.
 * @typedef {{ dir: 1 | -1 | 0, factor: number | null, hedge: Hedge, from: number | null, to: number | null, unit: string, words: SourceIndex, passage: string, source: number }} ExcerptChange
 */

/** @typedef {{ source: number, text: string, index: SourceIndex, parts: Part[], changes: ExcerptChange[] }} ExcerptModel */

/**
 * The clauses of a sentence, as offsets.
 * @param {string} text
 * @returns {Array<{ start: number, end: number }>}
 */
function clausesOf(text) {
  /** @type {Array<{ start: number, end: number }>} */
  const out = [];
  let start = 0;
  for (const m of text.matchAll(CLAUSE)) {
    const at = m.index ?? 0;
    if (at > start) out.push({ start, end: at });
    start = at + m[0].length;
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}

/**
 * The hedge written right before a factor at `start` ("more than doubled", "fast doppelt so viele").
 * @param {string} text
 * @param {number} start
 * @returns {Hedge}
 */
function hedgeBefore(text, start) {
  const before = text.slice(Math.max(0, start - 24), start);
  return HEDGES.find(([re]) => re.test(before))?.[1] ?? 'exact';
}

/**
 * Change verbs of a text with their direction or factor (and its hedge), in text order.
 * @param {string} text
 * @returns {Array<{ start: number, end: number, dir: 1 | -1, factor: number | null, hedge: Hedge, surface: string }>}
 */
function changeVerbs(text) {
  /** @type {Array<{ start: number, end: number, dir: 1 | -1, factor: number | null, hedge: Hedge, surface: string }>} */
  const out = [];
  const add = (/** @type {RegExpMatchArray} */ m, /** @type {1 | -1} */ dir, /** @type {number | null} */ factor) => {
    const start = m.index ?? 0;
    if (out.some((v) => start < v.end && v.start < start + m[0].length)) return;
    out.push({ start, end: start + m[0].length, dir, factor, hedge: factor === null ? 'exact' : hedgeBefore(text, start), surface: m[0] });
  };
  for (const [re, factor] of FACTORS) for (const m of text.matchAll(re)) add(m, factor > 1 ? 1 : -1, factor);
  for (const m of text.matchAll(UP_RE)) add(m, 1, null);
  for (const m of text.matchAll(DOWN_RE)) add(m, -1, null);
  for (const { re, particle, dir } of SEPARABLE) {
    for (const m of text.matchAll(re)) {
      const rest = text.slice((m.index ?? 0) + m[0].length);
      const end = rest.search(PUNCT);
      if (particle.test(end < 0 ? rest : rest.slice(0, end))) add(m, /** @type {1 | -1} */ (dir), null);
    }
  }
  out.sort((a, b) => a.start - b.start);
  // A factor phrase next to a change verb ("fell to a third", "rose by half") gives that verb its
  // factor.
  for (const v of out) {
    if (v.factor !== null) continue;
    const near = text.slice(v.end, v.end + 30);
    for (const [re, kind, share] of FACTOR_PHRASES) {
      re.lastIndex = 0;
      const m = re.exec(near);
      if (!m || (m.index ?? 0) > 4) continue;
      // "half a million", "a quarter of a million": an amount, not a factor. A rise "to two thirds"
      // is a share of something else (of the capacity), not of the value before.
      if (/^\s+(?:of\s+)?(?:a|an|one)\s+(?:hundred|thousand|million|billion|dozen)/iu.test(text.slice(v.end + (m.index ?? 0) + m[0].length))) continue;
      if (kind === 'to' && v.dir === 1) continue;
      v.factor = kind === 'to' ? share : 1 + v.dir * share;
    }
  }
  return out;
}

/**
 * The number right after a "from"/"to" word within a window of a text: the first quantity that
 * starts at most a currency sign away from the word.
 * @param {string} text
 * @param {Fact[]} facts
 * @param {RegExp} re  FROM or TO
 * @param {number} start
 * @param {number} end
 * @returns {Fact[]}
 */
function valuesAfter(text, facts, re, start, end) {
  /** @type {Fact[]} */
  const out = [];
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  for (const m of text.slice(start, end).matchAll(new RegExp(re.source, flags))) {
    const at = start + (m.index ?? 0) + m[0].length;
    const f = facts.find((x) => x.start >= at && x.start - at <= 3 && /^\s*[€$£]?\s*$/u.test(text.slice(at, x.start)));
    if (f && isQuantity(text, f)) out.push(f);
  }
  return out;
}

/**
 * The changes a text states: per change verb its direction or factor (with its hedge: "more than
 * doubled" is at least a factor of 2) and, where written, the value before ("from A", "up from A")
 * and after ("to B", or the value before "up from").
 * @param {string} text
 * @param {Fact[]} facts
 * @returns {Array<{ dir: 1 | -1, factor: number | null, hedge: Hedge, from: Fact | null, to: Fact | null, verb: { start: number, end: number, surface: string }, window: { start: number, end: number }, clause: { start: number, end: number } }>}
 */
export function changesIn(text, facts) {
  const out = [];
  const clauses = clausesOf(text);
  const verbs = changeVerbs(text);
  for (const [k, v] of verbs.entries()) {
    const clause = clauses.find((c) => v.start >= c.start && v.start < c.end) ?? { start: 0, end: text.length };
    const prev = verbs[k - 1];
    const next = verbs[k + 1];
    // A verb's values follow it, up to the next verb of its clause. Only the first verb of a clause
    // looks before itself too, for a German verb at the end ("ist von 64 % auf 41 % gesunken").
    const ahead = { start: v.end, end: next && next.start < clause.end ? next.start : clause.end };
    const behind = prev && prev.end > clause.start ? null : { start: clause.start, end: v.start };
    const window = { start: behind?.start ?? v.start, end: ahead.end };
    /** @returns {Fact | null} */
    const pick = (/** @type {RegExp} */ re, /** @type {Fact | null} */ after) => {
      const inAhead = valuesAfter(text, facts, re, ahead.start, ahead.end).filter((f) => !after || f.start > after.start);
      if (inAhead.length) return inAhead[0];
      const inBehind = behind ? valuesAfter(text, facts, re, behind.start, behind.end).filter((f) => !after || f.start > after.start) : [];
      return inBehind[0] ?? null;
    };
    const from = pick(FROM, null);
    /** @type {Fact | null} */
    let to = (from && pick(TO, from)) || pick(TO, null);
    // "182,400 visits, up from 151,900": the value before the phrase is where it went.
    if (/^(?:up|down) from$/iu.test(v.surface)) {
      to = [...facts].reverse().find((f) => f.end <= v.start && isQuantity(text, f) && v.start - f.end < 40) ?? null;
    }
    // "sanken um zwei Drittel, auf 90.000 Euro": the value after the comma that closes the clause.
    if (!to && !next) {
      const tail = /^,\s*(?:to|auf)\s+/iu.exec(text.slice(clause.end));
      if (tail) to = facts.find((f) => f.start === clause.end + tail[0].length && isQuantity(text, f)) ?? null;
    }
    if (from && to && from === to) to = null;
    out.push({ dir: v.dir, factor: v.factor, hedge: v.hedge, from, to, verb: { start: v.start, end: v.end, surface: v.surface }, window, clause });
  }
  // "up from" / "down from" are verbs of their own.
  for (const m of text.matchAll(UP_FROM)) {
    const start = m.index ?? 0;
    if (out.some((c) => c.verb.start === start)) continue;
    const clause = clauses.find((c) => start >= c.start && start < c.end) ?? { start: 0, end: text.length };
    const from = valuesAfter(text, facts, words('from', 'iu'), start, Math.min(text.length, start + m[0].length + 4))[0] ?? null;
    const to = [...facts].reverse().find((f) => f.end <= start && isQuantity(text, f) && start - f.end < 40) ?? null;
    out.push({ dir: /** @type {1 | -1} */ (/^up/iu.test(m[0]) ? 1 : -1), factor: null, hedge: /** @type {Hedge} */ ('exact'), from, to, verb: { start, end: start + m[0].length, surface: m[0] }, window: { start: to?.start ?? clause.start, end: Math.min(text.length, (from?.end ?? start + m[0].length)) }, clause });
  }
  return out;
}

/**
 * Content words of a span with its facts blanked out, without lexicon and unit words.
 * @param {string} text
 * @param {Fact[]} facts
 * @param {number} start
 * @param {number} end
 */
function spanWords(text, facts, start, end) {
  let plain = text.slice(start, end);
  for (const f of facts) {
    if (f.end <= start || f.start >= end) continue;
    const a = Math.max(f.start, start) - start;
    const b = Math.min(f.end, end) - start;
    plain = plain.slice(0, a) + ' '.repeat(b - a) + plain.slice(b);
  }
  return contentTokens(plain).filter((w) => !NOT_KEYS.has(w) && !UP_RE.test(w) && !DOWN_RE.test(w));
}

/**
 * The parts and changes of an excerpt.
 * @param {string} text
 * @param {number} source
 * @param {RelationOptions} options
 * @returns {ExcerptModel}
 */
function modelOf(text, source, options) {
  /** @type {Part[]} */
  const parts = [];
  /** @type {ExcerptChange[]} */
  const changes = [];
  for (const span of sentenceSpans(text)) {
    const sentence = text.slice(span.start, span.end);
    // Headings ("## Visits") and lines without a value say nothing about one.
    for (const part of options.split(sentence)) {
      const facts = extractFacts(part).filter((f) => f.kind !== 'quote');
      if (facts.length) parts.push({ text: part, index: indexSource(part), facts, source, id: parts.length });
    }
    const facts = extractFacts(sentence).filter((f) => f.kind !== 'quote');
    for (const c of changesIn(sentence, facts)) {
      /** @type {number | null} */
      let from = c.from ? valueOf(c.from) : null;
      /** @type {number | null} */
      let to = c.to ? valueOf(c.to) : null;
      if (c.from && c.to) [from, to] = aligned(c.from, c.to);
      const dir = from !== null && to !== null ? /** @type {1 | -1 | 0} */ (Math.sign(to - from)) : c.dir;
      changes.push({ dir, factor: c.factor, hedge: c.hedge, from, to, unit: c.to ? unitOf(sentence, c.to) : c.from ? unitOf(sentence, c.from) : '', words: indexSource(spanWords(sentence, facts, c.window.start, c.window.end).join(' ')), passage: sentence.slice(c.clause.start, c.clause.end), source });
    }
  }
  return { source, text, index: indexSource(text), parts, changes };
}

// --- Statements ---------------------------------------------------------------------------------

/**
 * Whether a span of a statement is negated or conditional.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 */
function guarded(text, start, end) {
  const re = new RegExp(GUARD.source, 'iu');
  return re.test(text.slice(start, end));
}

/**
 * The strong boundaries of a sentence around a position: the left side of a relation starts after
 * the last ';' or ':' before it (or at the start), its right side ends at the next SIDE_END.
 * @param {string} text
 * @param {number} pos
 */
function leftStart(text, pos) {
  const before = text.slice(0, pos);
  const m = [...before.matchAll(/[;:]\s+|[.!?]\s+/g)].pop();
  return m ? (m.index ?? 0) + m[0].length : 0;
}

/**
 * Where a side that starts at `pos` ends: at the next boundary (`re`) that is not inside a fact
 * (the dot of "3. März").
 * @param {string} text
 * @param {number} pos
 * @param {Fact[]} facts
 * @param {RegExp} [re]  SIDE_END, or PUNCT for a whole clause
 */
function rightEnd(text, pos, facts, re = SIDE_END) {
  let from = pos;
  for (;;) {
    const m = re.exec(text.slice(from));
    if (!m) return text.length;
    const at = from + (m.index ?? 0);
    const inside = facts.find((f) => at >= f.start && at < f.end);
    if (!inside) return at;
    from = inside.end;
  }
}

/**
 * A side of a relation: its words (with weights: names and numbers count double) and its own facts.
 * @typedef {{ start: number, end: number, keys: Array<{ token: string, weight: number }>, facts: Fact[], text: string }} Side
 */

/**
 * @param {string} text
 * @param {Fact[]} facts
 * @param {number} start
 * @param {number} end
 * @param {Set<string>} [skip]  words that belong to the relation itself (the attribute compared)
 * @returns {Side}
 */
function sideOf(text, facts, start, end, skip = new Set()) {
  const own = facts.filter((f) => f.start >= start && f.end <= end);
  const tokens = spanWords(text, facts, start, end).filter((t) => !skip.has(t));
  const capital = new Set(
    [...text.slice(start, end).matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}'’-]*/gu)].filter((m) => !/(?:^|[.!?:;]\s*)$/u.test(text.slice(0, start + (m.index ?? 0)))).map((m) => fold(m[0].replace(/['’]s$/u, ''))),
  );
  return { start, end, text: text.slice(start, end), facts: own, keys: [...new Set(tokens)].map((token) => ({ token, weight: capital.has(token) ? 2 : 1 })) };
}

/**
 * Removes the words two sides share: what is left tells them apart ("Harbour" and "Northgate" in
 * "the Harbour branch … than the Northgate branch"). Labels (years, versions) tell them apart only
 * when both sides have one and they differ ("in 2025 than in 2024"); a label on one side only
 * ("than the children's room in 2025") is context of the whole statement.
 * @param {Side} a
 * @param {Side} b
 * @param {(f: Fact) => boolean} label
 */
function distinguish(a, b, label) {
  const ia = indexSource(a.keys.map((k) => k.token).join(' '));
  const ib = indexSource(b.keys.map((k) => k.token).join(' '));
  const la = a.facts.filter(label);
  const lb = b.facts.filter(label);
  const shared = (/** @type {Fact} */ f, /** @type {Fact[]} */ other) => other.some((g) => g.values.some((v) => f.values.includes(v)));
  const keep = (/** @type {Fact[]} */ other) => (/** @type {Fact} */ f) => !label(f) || (other.length > 0 && !shared(f, other));
  return {
    a: { ...a, keys: a.keys.filter((k) => !tokenMatches(k.token, ib)), facts: a.facts.filter(keep(lb)) },
    b: { ...b, keys: b.keys.filter((k) => !tokenMatches(k.token, ia)), facts: b.facts.filter(keep(la)) },
  };
}

/**
 * How well a part matches a side: the weights of the side's words it contains, plus 2 for each of
 * the side's own labels (a year, a version) it contains.
 * @param {Side} side
 * @param {Part} part
 * @param {(f: Fact) => boolean} label  facts of the side that label it rather than being its value
 */
function score(side, part, label) {
  let s = 0;
  for (const k of side.keys) {
    // The word itself counts in full, an inflected form or a compound that contains it ("Bibliothek"
    // for "Kinderbibliothek") by half.
    if (part.index.tokens.has(k.token) || part.index.words.includes(` ${k.token} `)) s += k.weight;
    else if (tokenMatches(k.token, part.index)) s += k.weight / 2;
  }
  for (const f of side.facts) if (label(f) && lookupFact(f, part.index, 0).found === 'exact') s += 2;
  return s;
}

/**
 * The value of a part for a side: its only fact of the wanted kind that is not one of the side's
 * labels, or null when it has none or several.
 * @param {Part} part
 * @param {Side} side
 * @param {'number' | 'date'} kind
 */
function partValue(part, side, kind) {
  // A side's own value (a quantity, or a date in an order in time) is what is looked up, not a label.
  const labels = side.facts.filter((f) => (kind === 'date' ? f.kind !== 'date' : !isQuantity(side.text, f)));
  const candidates = part.facts.filter((f) => (kind === 'date' ? f.kind === 'date' : isQuantity(part.text, f)) && !labels.some((l) => lookupFact(l, indexSource(f.surface), 0).found === 'exact'));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Binds the two sides of a relation to two different excerpt parts: the pair with the highest
 * combined score, if it is the only pair with that score. Null when a side matches no part.
 * @param {Side} left
 * @param {Side} right
 * @param {Part[]} parts
 * @param {'number' | 'date'} kind
 * @returns {{ left: { part: Part, value: Fact }, right: { part: Part, value: Fact } } | null}
 */
function bind(left, right, parts, kind) {
  const label = (/** @type {Fact} */ f) => (kind === 'date' ? f.kind !== 'date' : !isQuantity(left.text + right.text, f) || f.kind !== 'number');
  const usable = parts.filter((p) => p.facts.some((f) => (kind === 'date' ? f.kind === 'date' : isQuantity(p.text, f))));
  const ls = usable.map((p) => ({ p, s: score(left, p, label) })).filter((x) => x.s > 0);
  const rs = usable.map((p) => ({ p, s: score(right, p, label) })).filter((x) => x.s > 0);
  /** @type {{ total: number, l: Part, r: Part } | null} */
  let best = null;
  let tie = false;
  for (const l of ls) {
    for (const r of rs) {
      if (l.p === r.p) continue;
      const total = l.s + r.s;
      if (!best || total > best.total) {
        best = { total, l: l.p, r: r.p };
        tie = false;
      } else if (total === best.total) tie = true;
    }
  }
  if (!best || tie) return null;
  const lv = partValue(best.l, left, kind);
  const rv = partValue(best.r, right, kind);
  return lv && rv ? { left: { part: best.l, value: lv }, right: { part: best.r, value: rv } } : null;
}

/**
 * Whether a fact of a statement is in one of the excerpts.
 * @param {Fact} f
 * @param {ExcerptModel[]} models
 */
function foundIn(f, models) {
  return models.filter((m) => lookupFact(f, m.index, 0).found === 'exact').map((m) => m.source);
}

/**
 * The end of a relation's words: after a unit sign or word that follows the value there.
 * @param {string} text
 * @param {number} end
 */
function withUnit(text, end) {
  const m = /^\s?(?:%|‰|°\s?[CF]|€|EUR|Euro|USD|CHF|GBP|percent|Prozent)(?![\p{L}])/iu.exec(text.slice(end));
  return m ? end + m[0].length : end;
}

/** @param {string} text */
function clip(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > RELATIONS.textChars ? `${flat.slice(0, RELATIONS.textChars - 1).trimEnd()}…` : flat;
}

/**
 * Whether a ratio of two values is the stated factor: within the tolerance, or with a hedge as far
 * as the hedge says. "More than doubled" wants at least about 2 (at most about 0.5 for "more than
 * halved"), "nearly doubled" a little less than 2 (down to hedgeReach), "roughly doubled" about 2
 * with twice the tolerance. The direction is checked before.
 * @param {number} factor
 * @param {number} ratio
 * @param {Hedge} hedge
 */
function factorFits(factor, ratio, hedge) {
  const tolerance = RELATIONS.factorTolerance * factor;
  const reach = RELATIONS.hedgeReach * factor;
  const grows = factor > 1;
  if (hedge === 'over') return grows ? ratio >= factor - tolerance : ratio <= factor + tolerance;
  if (hedge === 'under') return grows ? ratio >= factor - reach && ratio <= factor + tolerance : ratio <= factor + reach && ratio >= factor - tolerance;
  return Math.abs(ratio - factor) <= (hedge === 'about' ? 2 : 1) * tolerance;
}

/**
 * Verdict of a stated direction (and factor) against the values: inverted when they go the other
 * way, unsupported when the factor is off or they do not move, else supported.
 * @param {1 | -1} dir
 * @param {number | null} factor
 * @param {Hedge} hedge
 * @param {number} from
 * @param {number} to
 * @returns {RelationFinding['verdict']}
 */
function changeVerdict(dir, factor, hedge, from, to) {
  const moved = Math.sign(to - from);
  if (moved === 0) return 'unsupported';
  if (moved !== dir) return 'inverted';
  if (factor !== null && from !== 0 && !factorFits(factor, to / from, hedge)) return 'unsupported';
  return 'supported';
}

/**
 * Verdict of a comparison of two values: `dir` 1 says left > right, -1 left < right; `factor`
 * (twice as many) the ratio.
 * @param {1 | -1} dir
 * @param {number | null} factor
 * @param {Hedge} hedge
 * @param {number} left
 * @param {number} right
 * @returns {RelationFinding['verdict']}
 */
function compareVerdict(dir, factor, hedge, left, right) {
  const order = Math.sign(left - right);
  if (order === 0) return 'unsupported';
  if (order !== dir) return 'inverted';
  if (factor !== null && right !== 0 && !factorFits(factor, left / right, hedge)) return 'unsupported';
  return 'supported';
}

// --- The checks ---------------------------------------------------------------------------------

/**
 * @typedef {object} StatementView
 * @property {number} i
 * @property {string} text
 * @property {Fact[]} facts
 * @property {ExcerptModel[]} models  the excerpts it cites
 * @property {StatementView | null} prev  the statement before, as context for carried-over values
 */

/**
 * Changes ("rose from A to B", "fell to B", "doubled") checked against the values and the changes of
 * the excerpts, or against the value of the statement before ("it rose to B").
 * @param {StatementView} s
 * @returns {RelationFinding[]}
 */
function checkChanges(s) {
  /** @type {RelationFinding[]} */
  const out = [];
  for (const c of changesIn(s.text, s.facts)) {
    if (guarded(s.text, c.clause.start, c.clause.end)) continue;
    const words = indexSource(spanWords(s.text, s.facts, c.window.start, c.window.end).join(' '));
    const relationText = clip(s.text.slice(Math.min(c.verb.start, c.from?.start ?? Infinity, c.to?.start ?? Infinity), withUnit(s.text, Math.max(c.verb.end, c.from?.end ?? 0, c.to?.end ?? 0))));
    const changes = s.models.flatMap((m) => m.changes);
    if (c.from && c.to) {
      const where = [...new Set([...foundIn(c.from, s.models), ...foundIn(c.to, s.models)])];
      if (!foundIn(c.from, s.models).length || !foundIn(c.to, s.models).length) continue;
      const [from, to] = aligned(c.from, c.to);
      const e = changes.find((x) => x.from !== null && x.to !== null && ((same(x.from, from) && same(x.to, to)) || (same(x.from, to) && same(x.to, from))));
      if (e && e.from !== null && e.to !== null) {
        // The excerpt says which value came first.
        const swapped = same(e.from, to) && !same(e.from, from);
        const verdict = swapped ? 'inverted' : changeVerdict(c.dir, c.factor, c.hedge, from, to);
        out.push({ kind: 'comparative', sentences: [s.i], cites: [e.source], verdict, text: relationText, found: e.passage });
        continue;
      }
      // No order in the excerpt: the statement must at least agree with itself.
      const verdict = changeVerdict(c.dir, c.factor, c.hedge, from, to);
      if (verdict !== 'supported') out.push({ kind: 'comparative', sentences: [s.i], cites: where, verdict, text: relationText, found: s.models.filter((m) => where.includes(m.source)).map((m) => passageWith(m, [c.from, c.to])).join(' … ') });
      continue;
    }
    if (c.to && !c.from) {
      if (!foundIn(c.to, s.models).length) continue;
      const to = /** @type {number} */ (valueOf(c.to));
      const e = changes.find((x) => x.to !== null && same(x.to, to) && x.dir !== 0);
      if (e) {
        const verdict = e.from !== null ? changeVerdict(c.dir, c.factor, c.hedge, e.from, to) : e.dir !== c.dir ? 'inverted' : 'supported';
        out.push({ kind: 'comparative', sentences: [s.i], cites: [e.source], verdict, text: relationText, found: e.passage });
        continue;
      }
      const carried = carriedValue(s, c.to, c.clause);
      if (carried) {
        const verdict = changeVerdict(c.dir, c.factor, c.hedge, carried.value, to);
        out.push({ kind: 'reference', sentences: [carried.view.i, s.i], cites: carried.cites, verdict, text: relationText, found: carried.found });
      }
      continue;
    }
    if (c.from || c.to) continue;
    // Only a direction or a factor ("doubled", "server costs halved"): the excerpt's change of the
    // same thing decides.
    const e = matchChange(words, changes);
    if (!e) continue;
    /** @type {RelationFinding['verdict']} */
    let verdict;
    if (e.from !== null && e.to !== null) verdict = changeVerdict(c.dir, c.factor, c.hedge, e.from, e.to);
    else if (e.dir !== 0 && e.dir !== c.dir) verdict = 'inverted';
    // Two factors without values are compared only when neither is hedged ("more than doubled"
    // says too little against "tripled").
    else if (c.factor !== null && e.factor !== null && c.hedge === 'exact' && e.hedge === 'exact' && !factorFits(c.factor, e.factor, 'exact')) verdict = 'unsupported';
    else if (e.dir !== 0) verdict = 'supported';
    else continue;
    out.push({ kind: 'comparative', sentences: [s.i], cites: [e.source], verdict, text: relationText, found: e.passage });
  }
  return out;
}

/**
 * The excerpt change about the same thing as a statement's change: the one whose words cover most
 * of the statement's (at least 60 % and two of them, or the only one), if it is the only best one.
 * @param {SourceIndex} statementWords
 * @param {ExcerptChange[]} changes
 */
function matchChange(statementWords, changes) {
  const tokens = [...statementWords.tokens];
  if (!tokens.length) return null;
  /** @type {ExcerptChange | null} */
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const e of changes) {
    const s = tokens.filter((t) => tokenMatches(t, e.words)).length;
    if (s > bestScore) {
      best = e;
      bestScore = s;
      tie = false;
    } else if (s === bestScore && s > 0) tie = true;
  }
  const enough = bestScore >= Math.min(2, tokens.length) && bestScore >= Math.ceil(0.6 * tokens.length - 1e-9);
  return best && enough && !tie ? best : null;
}

/**
 * The sentence of an excerpt that holds the given facts, for a reason to quote.
 * @param {ExcerptModel} m
 * @param {Array<Fact | null>} facts
 */
function passageWith(m, facts) {
  for (const span of sentenceSpans(m.text)) {
    const sentence = m.text.slice(span.start, span.end);
    const index = indexSource(sentence);
    if (facts.every((f) => !f || lookupFact(f, index, 0).found === 'exact')) return sentence;
  }
  return m.parts.find((p) => facts.some((f) => f && lookupFact(f, p.index, 0).found === 'exact'))?.text ?? '';
}

/**
 * The value a statement carries over from the statement before ("it rose to B", "that number shrank
 * to B"): the statement refers back with a pronoun or "the number", and the statement before states
 * exactly one quantity of a matching unit, found in the excerpts either of them cites.
 * @param {StatementView} s
 * @param {Fact} value  the statement's own value
 * @param {{ start: number, end: number }} clause
 * @returns {{ view: StatementView, value: number, cites: number[], found: string } | null}
 */
function carriedValue(s, value, clause) {
  const p = s.prev;
  if (!p) return null;
  const refers = [...s.text.slice(clause.start, clause.end).matchAll(/[\p{L}]+/gu)].some((m) => REFERENCE.has(fold(m[0])));
  if (!refers) return null;
  const unit = unitOf(s.text, value);
  const theirs = p.facts.filter((f) => isQuantity(p.text, f) && unitsMatch(unitOf(p.text, f), unit));
  if (theirs.length !== 1) return null;
  const models = [...new Map([...p.models, ...s.models].map((m) => [m.source, m])).values()];
  const before = foundIn(theirs[0], models);
  const now = foundIn(value, models);
  if (!before.length || !now.length) return null;
  const [a] = aligned(theirs[0], value);
  const cites = [...new Set([...before, ...now])];
  return { view: p, value: a, cites, found: models.filter((m) => cites.includes(m.source)).map((m) => passageWith(m, [theirs[0]]) || passageWith(m, [value])).filter(Boolean).join(' … ') };
}

/**
 * Comparisons ("more … than", "twice as many … as"): both sides' values, the statement's own or the
 * ones the excerpts bind to them.
 * @param {StatementView} s
 * @returns {RelationFinding[]}
 */
function checkComparisons(s) {
  /** @type {RelationFinding[]} */
  const out = [];
  /** @type {Array<{ start: number, end: number, dir: 1 | -1, factor: number | null, hedge: Hedge, temporal: boolean, close: RegExp }>} */
  const cues = [];
  for (const [re, dir, temporal] of /** @type {Array<[RegExp, 1 | -1, boolean]>} */ ([[MORE_RE, 1, false], [LESS_RE, -1, false], [EARLIER_RE, -1, true], [LATER_RE, 1, true]])) {
    for (const m of s.text.matchAll(re)) cues.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, dir, factor: null, hedge: 'exact', temporal, close: THAN });
  }
  for (const [re, factor] of AS_FACTORS) {
    for (const m of s.text.matchAll(re)) cues.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, dir: factor > 1 ? 1 : -1, factor, hedge: hedgeBefore(s.text, m.index ?? 0), temporal: false, close: AS });
  }
  for (const cue of cues) {
    // The word that closes the comparison within a few words, in the same clause.
    const ahead = s.text.slice(cue.end, cue.end + 60);
    const close = cue.close.exec(ahead);
    const stop = ahead.search(PUNCT);
    if (!close || (stop >= 0 && stop < (close.index ?? 0)) || ahead.slice(0, close.index ?? 0).split(/\s+/).filter(Boolean).length > 5) {
      if (!cue.temporal && cue.factor === null) out.push(...carriedComparison(s, cue));
      continue;
    }
    // A number right before the cue states a difference ("12 % fewer", "four more than").
    if (s.facts.some((f) => f.end <= cue.start && cue.start - f.end <= 3) || /(?:\bfour|\bthree|\btwo|\bone|zwei|drei|vier)\s+$/iu.test(s.text.slice(0, cue.start))) continue;
    const thanStart = cue.end + (close.index ?? 0);
    const thanEnd = thanStart + close[0].length;
    // "more than doubled", "less than half as many": a hedge of the factor that follows (checked
    // with that factor), not a comparison of two sides.
    if (cue.factor === null && FACTOR_AFTER.test(s.text.slice(thanEnd))) continue;
    const start = leftStart(s.text, cue.start);
    const end = rightEnd(s.text, thanEnd, s.facts);
    if (guarded(s.text, start, end)) continue;
    // The words between the cue and "than" name what is compared ("more visits than"): both sides
    // share them. A label there ("more rain in 2025 than in 2024") belongs to the left side.
    const attribute = new Set(spanWords(s.text, s.facts, cue.end, thanStart));
    const rawLeft = sideOf(s.text, s.facts, start, thanStart, attribute);
    const rawRight = sideOf(s.text, s.facts, thanEnd, end, attribute);
    const relationText = clip(s.text.slice(cue.start, end));
    const kind = cue.temporal ? 'date' : 'number';
    const ownL = rawLeft.facts.filter((f) => (kind === 'date' ? f.kind === 'date' : isQuantity(s.text, f)));
    const ownR = rawRight.facts.filter((f) => (kind === 'date' ? f.kind === 'date' : isQuantity(s.text, f)));
    // A threshold ("larger than 5 GB", "more than 55 °C"): a value on the right only.
    const rightOpens = rawRight.facts.length > 0 && /^\s*(?:the|a|an|der|die|das|den|dem|des|ein|eine|einen)?\s*[€$£]?\s*$/iu.test(s.text.slice(thanEnd, rawRight.facts[0].start));
    if (rightOpens && ownL.length !== 1) continue;
    /** @type {{ left: Fact, right: Fact, cites: number[], found: string } | null} */
    let pair = null;
    if (ownL.length === 1 && ownR.length === 1) {
      const where = [...new Set([...foundIn(ownL[0], s.models), ...foundIn(ownR[0], s.models)])];
      if (foundIn(ownL[0], s.models).length && foundIn(ownR[0], s.models).length) pair = { left: ownL[0], right: ownR[0], cites: where, found: s.models.filter((m) => where.includes(m.source)).map((m) => passageWith(m, [ownL[0], ownR[0]]) || passageWith(m, [ownL[0]])).join(' … ') };
    } else {
      const { a, b } = distinguish(rawLeft, rawRight, (f) => (kind === 'date' ? f.kind !== 'date' : !isQuantity(s.text, f)));
      if (!a.keys.length && !a.facts.length) continue;
      if (!b.keys.length && !b.facts.length) continue;
      const bound = bind(a, b, s.models.flatMap((m) => m.parts), kind);
      if (bound) {
        // A value the statement gives itself must be the one the excerpt binds to that side.
        if (ownL.length === 1 && lookupFact(ownL[0], indexSource(bound.left.value.surface), 0).found !== 'exact') continue;
        if (ownR.length === 1 && lookupFact(ownR[0], indexSource(bound.right.value.surface), 0).found !== 'exact') continue;
        if (kind === 'number' && !unitsMatch(unitOf(bound.left.part.text, bound.left.value), unitOf(bound.right.part.text, bound.right.value))) continue;
        pair = { left: bound.left.value, right: bound.right.value, cites: [...new Set([bound.left.part.source, bound.right.part.source])], found: `${bound.left.part.text.trim()} … ${bound.right.part.text.trim()}` };
      }
    }
    if (!pair) continue;
    /** @type {RelationFinding['verdict']} */
    let verdict;
    if (kind === 'date') {
      const order = compareDays(pair.left, pair.right);
      if (order === null || order === 0) continue;
      verdict = order === cue.dir ? 'supported' : 'inverted';
    } else {
      const [l, r] = aligned(pair.left, pair.right);
      verdict = compareVerdict(cue.dir, cue.factor, cue.hedge, l, r);
    }
    out.push({ kind: cue.temporal ? 'temporal' : 'comparative', sentences: [s.i], cites: pair.cites, verdict, text: relationText, found: pair.found });
  }
  return out;
}

/**
 * A comparison without "than" that refers back ("At the end of 2025 it had fewer staff, 38
 * people"): the statement's single quantity against the single quantity of the statement before.
 * @param {StatementView} s
 * @param {{ start: number, end: number, dir: 1 | -1 }} cue
 * @returns {RelationFinding[]}
 */
function carriedComparison(s, cue) {
  const start = leftStart(s.text, cue.start);
  const end = s.text.length;
  if (guarded(s.text, start, end)) return [];
  if (s.facts.some((f) => f.end <= cue.start && cue.start - f.end <= 3)) return [];
  const own = s.facts.filter((f) => isQuantity(s.text, f));
  if (own.length !== 1) return [];
  const carried = carriedValue(s, own[0], { start, end });
  if (!carried) return [];
  const [now] = aligned(own[0], own[0]);
  const verdict = compareVerdict(cue.dir, null, 'exact', now, carried.value);
  return [{ kind: 'reference', sentences: [carried.view.i, s.i], cites: carried.cites, verdict, text: clip(s.text.slice(cue.start, own[0].end > cue.start ? own[0].end : cue.end)), found: carried.found }];
}

/**
 * Order in time ("before", "after", "bevor", "nachdem", "followed"): the dates of both events, the
 * statement's own or the ones the excerpts bind to them.
 * @param {StatementView} s
 * @param {string | null} lang
 * @returns {RelationFinding[]}
 */
function checkOrder(s, lang) {
  /** @type {RelationFinding[]} */
  const out = [];
  for (const t of TEMPORAL) {
    if (t.lang && t.lang !== lang) continue;
    for (const m of s.text.matchAll(t.re)) {
      const at = m.index ?? 0;
      // "X was followed by Y", "X, followed by Y": the passive or the participle of an active cue
      // turns the order around; a "by" right after it belongs to the cue.
      const by = t.voice ? PASSIVE_BY.exec(s.text.slice(at + m[0].length)) : null;
      const passive = Boolean(t.voice && (by || PASSIVE_BEFORE.test(s.text.slice(Math.max(0, at - 24), at))));
      const wanted = passive ? -t.order : t.order;
      const cueEnd = at + m[0].length + (by ? by[0].length : 0);
      // "Before Y, X": the connective opens the sentence and its clause ends at the first comma.
      const opens = /^\s*$/u.test(s.text.slice(leftStart(s.text, at), at));
      let left;
      let right;
      if (opens) {
        const comma = s.text.indexOf(',', cueEnd);
        if (comma < 0) continue;
        right = { start: cueEnd, end: comma };
        left = { start: comma + 1, end: rightEnd(s.text, comma + 1, s.facts, PUNCT) };
      } else {
        left = { start: leftStart(s.text, at), end: at };
        right = { start: cueEnd, end: rightEnd(s.text, cueEnd, s.facts) };
      }
      if (guarded(s.text, Math.min(left.start, right.start), Math.max(left.end, right.end))) continue;
      const after = s.text.slice(cueEnd);
      // "after 7 days", "nach 88.100", "after 20:00": a duration, a number or a time, not an event.
      const first = s.facts.find((f) => f.start >= cueEnd && /^\s*(?:the|der|die|das|dem|den)?\s*$/iu.test(s.text.slice(cueEnd, f.start)));
      if (first && first.kind !== 'date') continue;
      if (/^\s*(?:\p{N}|a few|several|some|einigen|wenigen|mehreren)/iu.test(after) && !(first && first.kind === 'date')) continue;
      const rawLeft = sideOf(s.text, s.facts, left.start, left.end);
      const rawRight = sideOf(s.text, s.facts, right.start, right.end);
      if (t.prep && !rawRight.keys.some((k) => k.weight === 2) && !(first && first.kind === 'date')) continue;
      const dateL = t.dated ? rawLeft.facts.filter((f) => f.kind === 'date') : [];
      const dateR = t.dated ? rawRight.facts.filter((f) => f.kind === 'date') : [];
      /** @type {{ left: Fact, right: Fact, cites: number[], found: string } | null} */
      let pair = null;
      const { a, b } = distinguish(
        { ...rawLeft, facts: t.dated ? rawLeft.facts : rawLeft.facts.filter((f) => f.kind !== 'date') },
        { ...rawRight, facts: t.dated ? rawRight.facts : rawRight.facts.filter((f) => f.kind !== 'date') },
        (f) => f.kind !== 'date',
      );
      const bound = (a.keys.length || a.facts.length) && (b.keys.length || b.facts.length) ? bind(a, b, s.models.flatMap((x) => x.parts), 'date') : null;
      if (bound) {
        if (dateL.length === 1 && compareDays(dateL[0], bound.left.value) !== 0) continue;
        if (dateR.length === 1 && compareDays(dateR[0], bound.right.value) !== 0) continue;
        pair = { left: bound.left.value, right: bound.right.value, cites: [...new Set([bound.left.part.source, bound.right.part.source])], found: `${bound.left.part.text.trim()} … ${bound.right.part.text.trim()}` };
      } else if (dateL.length === 1 && dateR.length === 1 && foundIn(dateL[0], s.models).length && foundIn(dateR[0], s.models).length) {
        const where = [...new Set([...foundIn(dateL[0], s.models), ...foundIn(dateR[0], s.models)])];
        pair = { left: dateL[0], right: dateR[0], cites: where, found: s.models.filter((x) => where.includes(x.source)).map((x) => passageWith(x, [dateL[0]])).join(' … ') };
      }
      if (!pair) continue;
      const order = compareDays(pair.left, pair.right);
      if (order === null || order === 0) continue;
      // `order` -1: left came first. "X before Y" wants -1, "X after Y" wants 1.
      const verdict = order === wanted ? 'supported' : 'inverted';
      out.push({ kind: 'temporal', sentences: [s.i], cites: pair.cites, verdict, text: clip(s.text.slice(opens ? at : at, right.end)), found: pair.found });
    }
  }
  return out;
}

/**
 * Shares with both values in the statement ("120 returns, 15 % of the 800 orders"): the share must
 * be what the two values give.
 * @param {StatementView} s
 * @returns {RelationFinding[]}
 */
function checkShares(s) {
  /** @type {RelationFinding[]} */
  const out = [];
  for (const f of s.facts) {
    if (unitOf(s.text, f) !== 'percent') continue;
    const tail = s.text.slice(f.end, f.end + 24);
    if (!/^\s?(?:%|percent|prozent)\s+(?:of|von|der|des|aller)\b/iu.test(tail)) continue;
    const clause = clausesOf(s.text).find((c) => f.start >= c.start && f.start < c.end) ?? { start: 0, end: s.text.length };
    if (guarded(s.text, clause.start, clause.end)) continue;
    const others = s.facts.filter((g) => g !== f && isQuantity(s.text, g) && unitOf(s.text, g) !== 'percent');
    if (others.length !== 2) continue;
    if (!others.every((g) => foundIn(g, s.models).length)) continue;
    const [a, b] = aligned(others[0], others[1]);
    const part = Math.min(a, b);
    const whole = Math.max(a, b);
    if (!whole) continue;
    const share = /** @type {number} */ (valueOf(f));
    const verdict = Math.abs((part / whole) * 100 - share) <= Math.max(RELATIONS.shareTolerance, share * 0.02) ? 'supported' : 'unsupported';
    const where = [...new Set(others.flatMap((g) => foundIn(g, s.models)))];
    out.push({ kind: 'comparative', sentences: [s.i], cites: where, verdict, text: clip(s.text.slice(f.start, f.end + 20)), found: s.models.filter((m) => where.includes(m.source)).map((m) => passageWith(m, others)).join(' … ') });
  }
  return out;
}

/**
 * Finds and checks the relations of a list of statements (in answer order) against the excerpts
 * they cite. `excerpts` is index-aligned with the statements' cites; null for an excerpt that was
 * not delivered or is not available.
 * @param {RelationStatement[]} statements
 * @param {Array<{ text: string, lang?: string | null } | null>} excerpts
 * @param {RelationOptions} options
 * @returns {RelationFinding[]}
 */
export function findRelations(statements, excerpts, options) {
  /** @type {Map<number, ExcerptModel>} */
  const models = new Map();
  const modelAt = (/** @type {number} */ i) => {
    const e = excerpts[i];
    if (!e) return null;
    let m = models.get(i);
    if (!m) models.set(i, (m = modelOf(e.text, i, options)));
    return m;
  };
  /** @type {StatementView[]} */
  const views = statements.map((st, i) => ({
    i,
    text: st.text,
    facts: extractFacts(st.text).filter((f) => f.kind !== 'quote'),
    models: [...new Set(st.cites)].map(modelAt).filter((m) => m !== null),
    prev: null,
  }));
  views.forEach((v, i) => {
    v.prev = i > 0 ? views[i - 1] : null;
  });
  /** @type {RelationFinding[]} */
  const out = [];
  for (const v of views) {
    if (statements[v.i].context || !v.models.length) continue;
    // A short statement may not tell its language; its excerpts do.
    const lang = guessLanguage(v.text) ?? v.models[0].index.lang ?? null;
    const found = [...checkChanges(v), ...checkComparisons(v), ...checkOrder(v, lang), ...checkShares(v)];
    // One finding per stated relation: the first wins.
    const seen = new Set();
    for (const f of found) {
      const key = `${f.kind}|${f.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}
