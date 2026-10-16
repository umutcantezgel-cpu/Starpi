// @ts-check
// Language packs: the words, names and conventions the source check needs to read a language
// (month and weekday names, number words and formats, negation cues, stop words, abbreviations),
// kept apart from the rules that use them. facts.js, polarity.js, sentences.js and rag/bm25.js
// read every registered pack together, so an answer in one language is checked against excerpts in
// another. English and German are built in; registerLanguage() adds more.
//
// Most entries are plain words. Some are fragments of regular expressions (marked "pattern" below)
// because a word needs a condition ("bis" except in "bis zu"); they are joined with "|" into the
// patterns of the modules, so they must not contain capturing groups. Every pattern runs on text
// that is lowercased (and, for polarity, folded: ä → ae, ö → oe, ü → ue, ß → ss).
//
// Pure: no DOM, runs in the browser, in workers and in Node.
import { de } from './de.js';
import { en } from './en.js';

/**
 * Language codes of the built-in packs. guessLanguage() and the source check report these; a pack
 * added with registerLanguage() may report its own code.
 * @typedef {'en' | 'de'} LanguageCode
 */

/**
 * Rules for the negation gate (polarity.js). All of them run on folded text.
 * @typedef {object} PolarityRules
 * @property {string[]} negators         words that negate the word next to them ("not", "without")
 * @property {string[]} plainNegators    the negators a time condition cancels ("not connected until …")
 * @property {string[]} qualifiers       words between a negator and the word it negates ("not yet", "not always")
 * @property {Array<[RegExp, string]>} contractions  rewritten first ("isn't" → "is not")
 * @property {string[]} infixNegators    negators between hyphens ("do-not-disturb")
 * @property {string[]} prefixNegators   negators before a hyphen ("not-null")
 * @property {Array<[RegExp, string]>} rewrites  phrases rewritten to a plain negation or none ("neither … nor", "nothing but")
 * @property {string[]} clauseNegations  patterns: a negation of the whole clause after it ("it is not true that")
 * @property {{ nothing: string[], verbs: string[], against: string[], phrases: string[], allowed: string }} nothingAgainst
 *   a double negation that allows ("nothing against"); `allowed` is the positive word it stands for
 * @property {{ negators: string[], comparatives: string[], than: string[], additives: string[] }} bounds
 *   a negator that bounds a quantity ("no later than") or extends a list ("not only") instead of negating
 * @property {string[]} modals           verbs that turn "not before" into a prohibition
 * @property {{ negators: string[], words: string[] }} timeBounds  "not before", "not after": a bound on a time
 * @property {string[]} idioms           patterns: other phrases with a negator that do not negate ("whether or not")
 * @property {Array<[RegExp, string, boolean?]>} antonyms  [pattern, the positive word it means, whether it
 *   means the negation of that word]; an empty word with `true` leaves a bare negation
 * @property {string[]} timeConditions   patterns: words that start a time condition ("until", "before")
 * @property {string[]} rangeStarts      words that open a range that a time word closes ("from … until")
 * @property {string[]} rangeEnds
 * @property {string[]} clauseJoiners    conjunctions that join two statements
 * @property {string[]} leadingWords     conjunctions and adverbs dropped at the start of a clause
 * @property {string[]} restrictive      words that restrict a statement to a case ("only")
 * @property {string[]} without          the preposition "without", which belongs to its clause
 */

/**
 * @typedef {object} LanguagePack
 * @property {string} code               ISO 639-1 code, lowercase
 * @property {string} name               the language's name in English
 * @property {Record<string, number>} months             full month names (lowercase; also folded spellings) → 1–12
 * @property {Record<string, number>} monthAbbreviations short month names → 1–12; a dot after them does not end a sentence
 * @property {string[]} ambiguousMonths  month names that are also a common word ("may"): lowercase, they are not read as a month
 * @property {Record<string, number>} weekdays           weekday names → 1 (Monday) to 7
 * @property {string[]} monthContext     words before a month name that make it a date ("in August")
 * @property {string[]} monthPosition    words between those and the month ("early", "end of")
 * @property {string[]} dayMonthLinks    words between a day and its month ("28th of August")
 * @property {string[]} ordinalSuffixes  letters after a number that make it an ordinal ("3rd")
 * @property {string[]} numericDateContext  words before a day and month without a year ("am 3.4.")
 * @property {string[]} clockWords       a word after a time of day ("14 Uhr")
 * @property {{ am: string, pm: string } | null} meridiem  12-hour clock markers, also written with dots ("a.m.")
 * @property {{ decimal: string, group: string }} numberFormat  the usual decimal and digit-group separators
 * @property {Array<[number, string[]]>} scales  patterns: words for 1e3, 1e6 and 1e9 after a number
 * @property {string[]} percentWords     patterns
 * @property {string[]} currencyWords    patterns: currency names after an amount (symbols and ISO codes are shared)
 * @property {string[]} unitWords        patterns: units and counted things after a number (symbols are shared)
 * @property {string[]} approxWords      patterns: words before a number that make it approximate
 * @property {Record<string, number>} numberWords  numbers written as words, read as values
 * @property {string[]} numberParts      patterns: number words that only form part of a larger number
 * @property {string[]} numberJoiners    the word that joins two number words ("a hundred and twenty")
 * @property {string[]} boilerplate      folded words that describe the sources rather than state something
 * @property {string[]} stopwords        function words that carry no retrieval signal
 * @property {string[]} abbreviations    tokens that end with a dot without ending a sentence
 * @property {string} letters            lowercase letters that mark the language among the packs
 * @property {PolarityRules} polarity
 */

/** @type {Map<string, LanguagePack>} */
const PACKS = new Map();
let revision = 0;

/** Codes of the registered packs, in registration order. Reassigned (not mutated) on registration. */
export let LANGUAGES = /** @type {readonly string[]} */ (Object.freeze([]));

/**
 * Freezes plain objects and arrays all the way down. Regular expressions stay unfrozen: a global
 * pattern writes its lastIndex when it is used.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || value instanceof RegExp || Object.isFrozen(value)) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

const LIST_FIELDS = /** @type {const} */ ([
  'ambiguousMonths', 'monthContext', 'monthPosition', 'dayMonthLinks', 'ordinalSuffixes', 'numericDateContext', 'clockWords',
  'scales', 'percentWords', 'currencyWords', 'unitWords', 'approxWords', 'numberParts', 'numberJoiners', 'boilerplate',
  'stopwords', 'abbreviations',
]);
const MAP_FIELDS = /** @type {const} */ (['months', 'monthAbbreviations', 'weekdays', 'numberWords']);
const POLARITY_LISTS = /** @type {const} */ ([
  'negators', 'plainNegators', 'qualifiers', 'contractions', 'infixNegators', 'prefixNegators', 'rewrites', 'clauseNegations',
  'modals', 'idioms', 'antonyms', 'timeConditions', 'rangeStarts', 'rangeEnds', 'clauseJoiners', 'leadingWords', 'restrictive', 'without',
]);

/**
 * A complete pack from a partial one: missing lists are empty, so a pack only states what its
 * language has (German has no "a.m.", English no "Uhr").
 * @param {Partial<LanguagePack> & { code: string, polarity?: Partial<PolarityRules> }} pack
 * @returns {LanguagePack}
 */
function complete(pack) {
  const p = /** @type {Partial<PolarityRules>} */ (pack.polarity ?? {});
  const polarity = /** @type {PolarityRules} */ ({
    ...Object.fromEntries(POLARITY_LISTS.map((k) => [k, p[k] ?? []])),
    nothingAgainst: { nothing: [], verbs: [], against: [], phrases: [], allowed: '', ...p.nothingAgainst },
    bounds: { negators: [], comparatives: [], than: [], additives: [], ...p.bounds },
    timeBounds: { negators: [], words: [], ...p.timeBounds },
  });
  return /** @type {LanguagePack} */ ({
    ...Object.fromEntries(LIST_FIELDS.map((k) => [k, pack[k] ?? []])),
    ...Object.fromEntries(MAP_FIELDS.map((k) => [k, pack[k] ?? {}])),
    code: pack.code,
    name: pack.name ?? pack.code,
    meridiem: pack.meridiem ?? null,
    numberFormat: pack.numberFormat ?? { decimal: '.', group: ',' },
    letters: pack.letters ?? '',
    polarity,
  });
}

/**
 * Adds a language. Its words take part in every check from the next call on, also for text in the
 * other languages, so a new pack must be measured with the source-check eval before it ships. A
 * code can be registered once.
 * @param {Partial<LanguagePack> & { code: string, polarity?: Partial<PolarityRules> }} pack
 * @returns {LanguagePack} the registered pack, completed and frozen
 */
export function registerLanguage(pack) {
  if (!pack || typeof pack !== 'object' || typeof pack.code !== 'string' || !/^[a-z]{2,3}$/.test(pack.code)) {
    throw new TypeError('registerLanguage: a pack needs a lowercase ISO 639 code');
  }
  if (PACKS.has(pack.code)) throw new Error(`registerLanguage: "${pack.code}" is already registered`);
  const full = deepFreeze(complete(pack));
  for (const key of LIST_FIELDS) if (!Array.isArray(full[key])) throw new TypeError(`registerLanguage: "${key}" must be a list`);
  for (const key of POLARITY_LISTS) if (!Array.isArray(full.polarity[key])) throw new TypeError(`registerLanguage: "polarity.${key}" must be a list`);
  for (const key of MAP_FIELDS) {
    const map = full[key];
    if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.values(map).every((n) => Number.isInteger(n))) {
      throw new TypeError(`registerLanguage: "${key}" must map words to whole numbers`);
    }
  }
  PACKS.set(full.code, full);
  LANGUAGES = Object.freeze([...PACKS.keys()]);
  revision += 1;
  return full;
}

/**
 * The pack of a language, by code or language tag ("de", "de-AT"); null when none is registered.
 * @param {string} code
 * @returns {LanguagePack | null}
 */
export function languagePack(code) {
  if (typeof code !== 'string') return null;
  return PACKS.get(code.toLowerCase().split(/[-_]/)[0]) ?? null;
}

/**
 * Every registered pack, in registration order (the built-in English first, then German).
 * @returns {LanguagePack[]}
 */
export function languagePacks() {
  return [...PACKS.values()];
}

/**
 * A value derived from all registered packs (a word set, a compiled pattern), built on first use
 * and again after each registration.
 * @template T
 * @param {(packs: LanguagePack[]) => T} build
 * @returns {() => T}
 */
export function fromPacks(build) {
  let built = -1;
  /** @type {T} */
  let value;
  return () => {
    if (built !== revision) {
      value = build(languagePacks());
      built = revision;
    }
    return value;
  };
}

/**
 * Pattern fragments joined as alternatives: a bare fragment when there is one, a group when there
 * are several, and a pattern that never matches when there is none.
 * @param {string[]} fragments
 */
export function anyOf(fragments) {
  if (fragments.length === 0) return '(?!)';
  return fragments.length === 1 ? fragments[0] : `(?:${fragments.join('|')})`;
}

/**
 * Distinct entries of several lists, in first-seen order.
 * @template T
 * @param {T[][]} lists
 * @returns {T[]}
 */
export function union(lists) {
  return [...new Set(lists.flat())];
}

registerLanguage(en);
registerLanguage(de);
