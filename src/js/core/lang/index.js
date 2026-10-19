// @ts-check
// Language packs: the words, names and conventions the source check needs to read a language
// (month and weekday names, number words and formats, negation cues, stop words, abbreviations),
// kept apart from the rules that use them. facts.js, polarity.js, sentences.js and rag/bm25.js
// read every registered pack together, so an answer in one language is checked against excerpts in
// another. English and German are built in; registerLanguage() adds more.
//
// French, Spanish, Italian and Turkish ship as packs of their own (fr.js, es.js, it.js, tr.js) that
// loadShippedLanguages() registers on demand, so the app loads them after its first paint, not with
// it. The app calls it at start (main thread and ingest worker); Node callers call it themselves.
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
 * Language codes of the built-in and shipped packs. guessLanguage() and the source check report
 * these; a pack added with registerLanguage() may report its own code.
 * @typedef {'en' | 'de' | 'fr' | 'es' | 'it' | 'tr'} LanguageCode
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
 * @property {{ decimal: string, group: string }} numberFormat  the usual decimal and digit-group separators.
 *   The source check does not depend on it: it reads "480.000" and "480,000" both ways in every
 *   language, so a fact keeps matching when an answer switches convention.
 * @property {Array<[number, string[]]>} scales  patterns: words for 1e3, 1e6 and 1e9 after a number
 * @property {string[]} percentWords     patterns
 * @property {string[]} currencyWords    patterns: currency names after an amount (symbols and ISO codes are shared)
 * @property {string[]} unitWords        patterns: units and counted things after a number (symbols are shared)
 * @property {string[]} approxWords      patterns: words before a number that make it approximate
 * @property {string[]} versionWords     words before a dotted triple that make it a version ("firmware 10.4.12")
 * @property {Record<string, number>} numberWords  numbers written as words, read as values
 * @property {string[]} numberParts      patterns: number words that only form part of a larger number
 * @property {string[]} ownNumberParts   patterns: number words that make a number word of this pack next to them part
 *   of a larger number, but only this pack's: other languages write them as common words (French "sept" in
 *   "dix-sept" and English "Sept", Turkish "on" in "on beş" and English "on")
 * @property {string[]} numberJoiners    the word that joins two number words ("a hundred and twenty")
 * @property {string[]} boilerplate      folded words that describe the sources rather than state something
 * @property {string[]} stopwords        function words that carry no retrieval signal
 * @property {string[]} abbreviations    tokens that end with a dot without ending a sentence
 * @property {string} letters            lowercase letters that mark the language among the packs
 * @property {Record<string, string>} [caseFold]  letters this language lowercases differently from
 *   toLowerCase(), applied first by lowerCase() (Turkish: "I" → "ı", "İ" → "i"); empty for most
 * @property {boolean} [capitalisesNouns]  every noun starts with a capital (German), so a capital
 *   inside a sentence does not mark a name
 * @property {PolarityRules} polarity
 * @property {GateRules} gate
 */

/**
 * Numbers written as words, for the sentence gate (number-words.js). Every word is lowercase and
 * made of letters only. A word is tagged with one of five kinds: cardinal, fraction and multiplier
 * state a quantity (a claim the gate checks), ordinal and adverb do not ("first", "once").
 * @typedef {object} GateNumberWords
 * @property {Record<string, number>} cardinals    counts that combine into larger numbers ("twenty" and "five": "twenty-five")
 * @property {Record<string, number>} scales       words that multiply the count before them ("hundred", "thousand", "million")
 * @property {string[]} parts           cardinals that state nothing on their own, only inside a larger number ("one", the article "ein")
 * @property {string[]} joiners         words between the parts of one number ("a hundred and five"); inside a word in a compound language
 * @property {Record<string, number>} fractions     fraction words and their value ("quarter" 0.25)
 * @property {Record<string, number>} multipliers   multiplier words and their factor ("twice" 2)
 * @property {Record<string, number>} ordinals      ordinal words and their position ("third" 3)
 * @property {string[]} adverbs         words formed from a number that state no quantity ("once", "einfach")
 * @property {string[]} contextual      fractions and multipliers that are a claim only with a unit or count noun at most two words later ("half", "double")
 * @property {string[]} countNouns      units and counted things for that rule, in addition to the pack's unitWords, percentWords and currencyWords
 * @property {string[]} fractionLeads   words before an ordinal from three on that make it a fraction ("a third")
 * @property {string[]} negative        words before a number that make it negative ("minus")
 * @property {boolean} compound         numbers are written as one word ("einundzwanzig") and read by splitting the word into the words above
 * @property {Array<[number, number, number]>} [additions]  [a, from, to]: a cardinal of value `a` followed by one from `from`
 *   to `to` adds up to one number where the general rules would read two (French "dix-sept" [10, 1, 9] and
 *   "soixante-dix" [60, 10, 19], Turkish "on beş" [10, 1, 9], Spanish "mil doscientos" [1000, 1, 999])
 * @property {Array<[number, number]>} [products]  [a, b]: a cardinal of value `a` followed by one of value `b` is
 *   their product, a number of its own that the rules above go on from (French "quatre-vingts" [4, 20], so
 *   "quatre-vingt-cinq" is 85 and "quatre-vingt-dix-sept" 97 with the addition [80, 10, 19])
 * @property {string[]} [tenJoiners]     words between a ten and the unit it takes ("treinta y cinco", "vingt et un")
 * @property {boolean} [elision]         in a compound word a ten drops its last vowel before a unit that starts
 *   with a vowel (Italian "ventuno", "trentotto")
 * @property {{ ordinal: string[], fraction: string[], multiplier: string[] }} suffixes
 *   endings that turn a cardinal into another kind ("zwanzig" + "ste", "vier" + "tel", "drei" + "fach", "ten" + "fold")
 */

/**
 * The spoken form of released sentences (spoken.js): only expansions that cannot change a number.
 * @typedef {object} GateSpoken
 * @property {Record<string, string>} abbreviations  abbreviation as written (spaces inside optional) → the words spoken for it
 * @property {Record<string, [string, string]>} units  unit sign after a number → the words spoken after one and after any other number
 * @property {string} approx            the word spoken for "~" before a number
 */

/**
 * What the sentence gate (gate.js) needs from a language.
 * @typedef {object} GateRules
 * @property {string} chars             characters the language writes beyond the shared allowlist of canonical.js (Latin letters, digits, common signs)
 * @property {GateNumberWords} numberWords
 * @property {GateSpoken} spoken
 */

/**
 * A pack as written: every entry except the code may be left out, and so may the parts of the
 * polarity and gate rules.
 * @typedef {Omit<Partial<LanguagePack>, 'polarity' | 'gate'> & {
 *   code: string,
 *   polarity?: Partial<PolarityRules>,
 *   gate?: { chars?: string, numberWords?: Partial<GateNumberWords>, spoken?: Partial<GateSpoken> },
 * }} PackInput
 */

/** @type {Map<string, LanguagePack>} */
const PACKS = new Map();
let revision = 0;

/**
 * Codes of the registered packs, in registration order. Read-only for callers: registerLanguage()
 * appends to this same array, so a copy taken by destructuring stays current too.
 * @type {readonly string[]}
 */
export const LANGUAGES = [];

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
  'scales', 'percentWords', 'currencyWords', 'unitWords', 'approxWords', 'versionWords', 'numberParts', 'ownNumberParts', 'numberJoiners',
  'boilerplate', 'stopwords', 'abbreviations',
]);
const MAP_FIELDS = /** @type {const} */ (['months', 'monthAbbreviations', 'weekdays', 'numberWords']);
const POLARITY_LISTS = /** @type {const} */ ([
  'negators', 'plainNegators', 'qualifiers', 'contractions', 'infixNegators', 'prefixNegators', 'rewrites', 'clauseNegations',
  'modals', 'idioms', 'antonyms', 'timeConditions', 'rangeStarts', 'rangeEnds', 'clauseJoiners', 'leadingWords', 'restrictive', 'without',
]);

/**
 * A complete pack from a partial one: missing lists are empty, so a pack only states what its
 * language has (German has no "a.m.", English no "Uhr").
 * @param {PackInput} pack
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
    caseFold: pack.caseFold ?? {},
    capitalisesNouns: pack.capitalisesNouns ?? false,
    polarity,
    gate: completeGate(pack.gate),
  });
}

const NUMBER_WORD_MAPS = /** @type {const} */ (['cardinals', 'scales', 'fractions', 'multipliers', 'ordinals']);
const NUMBER_WORD_LISTS = /** @type {const} */ (['parts', 'joiners', 'adverbs', 'contextual', 'countNouns', 'fractionLeads', 'negative', 'tenJoiners']);
const SUFFIX_KINDS = /** @type {const} */ (['ordinal', 'fraction', 'multiplier']);

/**
 * The gate rules of a pack, with what it leaves out empty.
 * @param {{ chars?: string, numberWords?: Partial<GateNumberWords>, spoken?: Partial<GateSpoken> } | undefined} gate
 * @returns {GateRules}
 */
function completeGate(gate) {
  const words = /** @type {Partial<GateNumberWords>} */ (gate?.numberWords ?? {});
  const spoken = /** @type {Partial<GateSpoken>} */ (gate?.spoken ?? {});
  return {
    chars: gate?.chars ?? '',
    numberWords: /** @type {GateNumberWords} */ ({
      ...Object.fromEntries(NUMBER_WORD_MAPS.map((k) => [k, words[k] ?? {}])),
      ...Object.fromEntries(NUMBER_WORD_LISTS.map((k) => [k, words[k] ?? []])),
      compound: words.compound ?? false,
      additions: words.additions ?? [],
      products: words.products ?? [],
      elision: words.elision ?? false,
      suffixes: { ordinal: [], fraction: [], multiplier: [], ...words.suffixes },
    }),
    spoken: { abbreviations: spoken.abbreviations ?? {}, units: spoken.units ?? {}, approx: spoken.approx ?? '' },
  };
}

/** A word of the gate lists: lowercase letters, nothing else. */
const GATE_WORD = /^[\p{Ll}\p{Lo}]+$/u;
/** Spoken words: letters and single spaces, no digits, so an expansion never adds a number of its own. */
const SPOKEN_WORDS = /^\p{L}+(?: \p{L}+)*$/u;

/**
 * Checks the gate rules of a completed pack.
 * @param {GateRules} gate
 */
function validateGate(gate) {
  const fail = (/** @type {string} */ message) => {
    throw new TypeError(`registerLanguage: "gate.${message}`);
  };
  if (typeof gate.chars !== 'string' || /[\p{N}\p{C}\p{Z}\p{M}]/u.test(gate.chars)) {
    fail('chars" must be text without digits, spaces, marks or control characters');
  }
  const words = gate.numberWords;
  for (const key of NUMBER_WORD_MAPS) {
    const map = words[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) fail(`numberWords.${key}" must map words to numbers`);
    for (const [w, n] of Object.entries(map)) {
      if (!GATE_WORD.test(w) || typeof n !== 'number' || !Number.isFinite(n) || n < 0) fail(`numberWords.${key}" must map lowercase words to finite numbers`);
    }
  }
  for (const key of NUMBER_WORD_LISTS) {
    if (!Array.isArray(words[key]) || !words[key].every((w) => typeof w === 'string' && GATE_WORD.test(w))) fail(`numberWords.${key}" must list lowercase words`);
  }
  if (typeof words.compound !== 'boolean') fail('numberWords.compound" must be true or false');
  if (typeof words.elision !== 'boolean') fail('numberWords.elision" must be true or false');
  const additions = /** @type {unknown} */ (words.additions);
  if (!Array.isArray(additions) || !additions.every((a) => Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(n) && n >= 0) && a[1] <= a[2])) {
    fail('numberWords.additions" must list [value, from, to] triples');
  }
  const products = /** @type {unknown} */ (words.products);
  if (!Array.isArray(products) || !products.every((a) => Array.isArray(a) && a.length === 2 && a.every((n) => Number.isFinite(n) && n > 0))) {
    fail('numberWords.products" must list [value, factor] pairs');
  }
  for (const kind of SUFFIX_KINDS) {
    const list = words.suffixes?.[kind];
    if (!Array.isArray(list) || !list.every((w) => typeof w === 'string' && GATE_WORD.test(w))) fail(`numberWords.suffixes.${kind}" must list lowercase endings`);
  }
  const { abbreviations, units, approx } = gate.spoken;
  if (!abbreviations || typeof abbreviations !== 'object' || Array.isArray(abbreviations)) fail('spoken.abbreviations" must map abbreviations to words');
  for (const [from, to] of Object.entries(abbreviations)) {
    if (!from.trim() || /\p{N}|\s$|^\s/u.test(from) || typeof to !== 'string' || !SPOKEN_WORDS.test(to)) fail('spoken.abbreviations" must map abbreviations without digits to words');
  }
  if (!units || typeof units !== 'object' || Array.isArray(units)) fail('spoken.units" must map unit signs to [singular, plural]');
  for (const [from, forms] of Object.entries(units)) {
    if (!from || /[\p{Nd}\s]/u.test(from) || !Array.isArray(forms) || forms.length !== 2 || !forms.every((f) => typeof f === 'string' && SPOKEN_WORDS.test(f))) {
      fail('spoken.units" must map unit signs to [singular, plural] words');
    }
  }
  if (typeof approx !== 'string' || (approx !== '' && !SPOKEN_WORDS.test(approx))) fail('spoken.approx" must be a word');
}

/** Lists of plain words that are looked up in a set, never joined into a pattern. */
const SET_FIELDS = new Set(['ambiguousMonths', 'boilerplate', 'stopwords', 'abbreviations']);

/**
 * Throws when a fragment would not compile, or would add a capturing group to the pattern it is
 * joined into (the modules read their matches by group number).
 * @param {unknown} fragment
 * @param {string} where
 */
function checkFragment(fragment, where) {
  if (typeof fragment !== 'string' || !fragment) throw new TypeError(`registerLanguage: "${where}" holds an empty or non-text entry`);
  let groups;
  try {
    groups = /** @type {RegExpExecArray} */ (new RegExp(`|(?:${fragment})`, 'u').exec('')).length - 1;
  } catch {
    throw new TypeError(`registerLanguage: "${where}" holds an invalid pattern: ${fragment}`);
  }
  if (groups > 0) throw new TypeError(`registerLanguage: "${where}" must not use capturing groups: ${fragment}`);
}

/**
 * Throws unless every rule is [global pattern, replacement] (or [pattern, word, negative?] for antonyms).
 * @param {unknown} list
 * @param {string} where
 */
function checkRewrites(list, where) {
  if (!Array.isArray(list)) throw new TypeError(`registerLanguage: "${where}" must be a list`);
  for (const rule of list) {
    if (!Array.isArray(rule) || !(rule[0] instanceof RegExp) || !rule[0].global || typeof rule[1] !== 'string') {
      throw new TypeError(`registerLanguage: "${where}" entries are [global RegExp, text]`);
    }
  }
}

/**
 * Checks a completed pack before it is frozen and registered.
 * @param {LanguagePack} pack
 */
function validate(pack) {
  for (const key of LIST_FIELDS) {
    const list = pack[key];
    if (!Array.isArray(list)) throw new TypeError(`registerLanguage: "${key}" must be a list`);
    if (key === 'scales') {
      for (const entry of list) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'number' || !Array.isArray(entry[1])) {
          throw new TypeError('registerLanguage: "scales" entries are [factor, words]');
        }
        for (const w of entry[1]) checkFragment(w, 'scales');
      }
    } else if (SET_FIELDS.has(key)) {
      if (!list.every((w) => typeof w === 'string' && w)) throw new TypeError(`registerLanguage: "${key}" must list words`);
    } else {
      for (const w of list) checkFragment(w, key);
    }
  }
  for (const key of MAP_FIELDS) {
    const map = pack[key];
    if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.values(map).every((n) => Number.isInteger(n))) {
      throw new TypeError(`registerLanguage: "${key}" must map words to whole numbers`);
    }
    for (const w of Object.keys(map)) checkFragment(w, key);
  }
  const fold = /** @type {unknown} */ (pack.caseFold);
  if (!fold || typeof fold !== 'object' || Array.isArray(fold) || !Object.entries(fold).every(([from, to]) => [...from].length === 1 && /^\p{Lu}$/u.test(from) && typeof to === 'string' && /^\p{Ll}+$/u.test(to))) {
    throw new TypeError('registerLanguage: "caseFold" maps single capital letters to lowercase letters');
  }
  if (pack.meridiem !== null && !(/^\p{L}+$/u.test(pack.meridiem?.am ?? '') && /^\p{L}+$/u.test(pack.meridiem?.pm ?? ''))) {
    throw new TypeError('registerLanguage: "meridiem" is null or { am, pm } in letters');
  }
  const { polarity } = pack;
  for (const key of POLARITY_LISTS) {
    if (key === 'contractions' || key === 'rewrites' || key === 'antonyms') checkRewrites(polarity[key], `polarity.${key}`);
    else if (!Array.isArray(polarity[key])) throw new TypeError(`registerLanguage: "polarity.${key}" must be a list`);
    else for (const w of polarity[key]) checkFragment(w, `polarity.${key}`);
  }
  const groups = /** @type {const} */ ([
    ['nothingAgainst', ['nothing', 'verbs', 'against', 'phrases']],
    ['bounds', ['negators', 'comparatives', 'than', 'additives']],
    ['timeBounds', ['negators', 'words']],
  ]);
  for (const [group, keys] of groups) {
    const rule = /** @type {Record<string, unknown>} */ (polarity[group]);
    for (const key of keys) {
      const list = rule[key];
      if (!Array.isArray(list)) throw new TypeError(`registerLanguage: "polarity.${group}.${key}" must be a list`);
      for (const w of list) checkFragment(w, `polarity.${group}.${key}`);
    }
  }
  if (typeof polarity.nothingAgainst.allowed !== 'string') throw new TypeError('registerLanguage: "polarity.nothingAgainst.allowed" must be a word');
  validateGate(pack.gate);
}

/**
 * Adds a language. Its words take part in every check from the next call on, also for text in the
 * other languages, so a new pack must be measured with the source-check eval before it ships. A
 * code can be registered once; the pack is checked, then frozen (its lists included).
 * @param {PackInput} pack
 * @returns {LanguagePack} the registered pack, completed and frozen
 */
export function registerLanguage(pack) {
  if (!pack || typeof pack !== 'object' || typeof pack.code !== 'string' || !/^[a-z]{2,3}$/.test(pack.code)) {
    throw new TypeError('registerLanguage: a pack needs a lowercase ISO 639 code');
  }
  if (PACKS.has(pack.code)) throw new Error(`registerLanguage: "${pack.code}" is already registered`);
  const full = complete(pack);
  validate(full);
  deepFreeze(full);
  PACKS.set(full.code, full);
  /** @type {string[]} */ (LANGUAGES).push(full.code);
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

/**
 * A text in lowercase as the language writes it: the pack's own capitals first (Turkish "I" → "ı",
 * "İ" → "i"), then toLowerCase(). Without a pack for the code, toLowerCase() alone.
 * @param {string} text
 * @param {string | null} [code]
 */
export function lowerCase(text, code = null) {
  const fold = code ? languagePack(code)?.caseFold : undefined;
  if (!fold || !Object.keys(fold).length) return text.toLowerCase();
  let out = '';
  for (const ch of text) out += fold[ch] ?? ch;
  return out.toLowerCase();
}

registerLanguage(en);
registerLanguage(de);

/**
 * The packs that ship with Starpi beyond the built-in ones. Each is a module of its own, so a
 * bundler puts it in a chunk of its own that loads only when asked for.
 * @type {Readonly<Record<string, () => Promise<PackInput>>>}
 */
const SHIPPED = Object.freeze({
  fr: () => import('./fr.js').then((m) => m.fr),
  es: () => import('./es.js').then((m) => m.es),
  it: () => import('./it.js').then((m) => m.it),
  tr: () => import('./tr.js').then((m) => m.tr),
});

/** Codes of every language Starpi ships a pack for: the built-in ones first. */
export const SHIPPED_LANGUAGES = Object.freeze(/** @type {LanguageCode[]} */ (['en', 'de', ...Object.keys(SHIPPED)]));

/** @type {Map<string, Promise<LanguagePack | null>>} */
const loadingPacks = new Map();

/**
 * Loads and registers shipped packs (all of them by default), each once; concurrent calls share the
 * work. A pack that cannot be loaded (offline before its chunk was cached) is left out with a
 * warning, and a later call tries again. Measured with the source-check eval: the shipped packs
 * leave every English and German verdict unchanged (tests/unit/lang-shipped.test.mjs).
 * @param {readonly string[]} [codes]
 * @returns {Promise<LanguagePack[]>} the packs of those codes that are registered afterwards
 */
export async function loadShippedLanguages(codes = Object.keys(SHIPPED)) {
  const packs = await Promise.all(
    codes.map((code) => {
      const known = PACKS.get(code);
      if (known) return Promise.resolve(known);
      const load = SHIPPED[code];
      if (!load) return Promise.resolve(null);
      let pending = loadingPacks.get(code);
      if (!pending) {
        pending = load()
          .then((pack) => PACKS.get(code) ?? registerLanguage(pack))
          .catch((err) => {
            console.warn(`[starpi] the ${code} language pack could not be loaded`, err);
            return null;
          })
          .finally(() => loadingPacks.delete(code));
        loadingPacks.set(code, pending);
      }
      return pending;
    }),
  );
  return packs.filter((p) => p !== null);
}
