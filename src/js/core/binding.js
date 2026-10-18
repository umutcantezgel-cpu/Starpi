// @ts-check
// Binding of names and values to what a statement says about them, for the source check
// (version 2). A statement can use only names and values its excerpt contains and still be wrong,
// when it puts a name or value next to something else than the excerpt does ("Marcus Hale owns the
// specification" when the excerpt says "Priya Raman owns this specification; Marcus Hale maintains
// the network configuration"). The check splits statement and excerpt into units (sentences, parts
// joined by a conjunction or a semicolon), aligns each statement unit with the excerpt unit that
// shares most of its other words, and reports a name or value that the aligned unit does not
// contain while it contains another one in its place.
//
// Names are recognised without a list: in English, capitalised words inside a sentence; in both
// languages, runs of two or more capitalised words ("Lukas Hoffmann", "Werk Süd", "Recyclon GmbH")
// and words the excerpts themselves use as such. A single capitalised German noun is not a name:
// every German noun is capitalised.
//
// Pure: no DOM, runs in the browser, in workers and in Node.
import { contentTokens, extractFacts, fold, indexSource, lookupFact, tokenMatches } from './facts.js';
import { STOPWORDS } from '../rag/bm25.js';
import { sentenceSpans } from './sentences.js';

/** Months and weekdays are dates, which the fact check compares; German prepositions that open a sentence are not names. */
const NOT_NAMES = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'januar', 'februar', 'maerz', 'mai', 'juni', 'juli', 'oktober', 'dezember',
  'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag',
  'laut', 'gemaess', 'ausser', 'trotz', 'wegen', 'statt', 'zwischen', 'note', 'sources', 'source', 'quelle', 'quellen',
  // Titles and forms of address: "Frau Albers" and "Katrin Albers" name the same person.
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'frau', 'herr', 'herrn',
]);

/** Where a sentence is cut into units: a semicolon, or a conjunction that starts another statement. */
const UNIT_BREAK = /;\s+|,\s+(?=(?:and|but|while|whereas|so|und|aber|waehrend|während|wobei|sowie|dagegen|doch)\s)|\s+(?:while|whereas|während|wobei)\s+/giu;

/**
 * A capitalised word, possibly with an internal hyphen or apostrophe. A word joined to a number
 * ("GW-31", "EG-400", "LT-11") is a code, which the fact check compares, not a name.
 */
const CAPITAL = /(?<![\p{L}\p{N}'’-])\p{Lu}[\p{L}'’]*(?:-\p{L}[\p{L}'’]*)*(?![\p{L}\p{N}'’-]|-\p{N})/gu;

/**
 * @typedef {object} Unit
 * @property {string} text
 * @property {string[]} tokens  content tokens
 * @property {import('./facts.js').SourceIndex} index
 * @property {Set<string>} names  folded name-like words
 * @property {Set<string>} caps   folded capitalised words that are not stopwords
 * @property {Map<string, number>} runs  the run of capitalised words each of them belongs to
 * @property {import('./facts.js').Fact[]} facts
 * @property {boolean} record  a table row read as "column: value; …"
 */

/**
 * The capitalised words of a text, each with whether it is name-like on its own: a capitalised word
 * after the first word of its sentence in an English text, or any word of a run of two or more
 * capitalised words that does not start with a stopword.
 * @param {string} text
 * @param {import('./lang/index.js').LanguageCode | null} lang
 */
function capitalised(text, lang) {
  /** @type {Array<{ token: string, start: number, end: number, initial: boolean, brand: boolean }>} */
  const words = [];
  for (const m of text.matchAll(CAPITAL)) {
    const start = m.index ?? 0;
    const surface = m[0].replace(/['’]s$/u, '');
    const token = fold(surface);
    // The stopword list holds German words with their umlauts ("für"), folding writes them out ("fuer").
    if (STOPWORDS.has(token) || STOPWORDS.has(surface.toLowerCase()) || NOT_NAMES.has(token) || token.length < 2) continue;
    const before = text.slice(0, start);
    const initial = /(?:^|[.!?:;|•*-]|\n)\s*["'“‘(]?\s*$/u.test(before);
    // CamelCase ("TresorStore") and capitals ("IT", "GPU") mark product, vendor and unit names.
    const brand = /^\p{Lu}[\p{Ll}]+\p{Lu}/u.test(surface) || /^\p{Lu}{2,}$/u.test(surface);
    words.push({ token, start, end: start + m[0].length, initial, brand });
  }
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Map<string, number>} */
  const runs = new Map();
  let run = 0;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    const next = words[i + 1];
    const prev = words[i - 1];
    const joined = (/** @type {{ end: number }} */ a, /** @type {{ start: number }} */ b) => /^\s+$/.test(text.slice(a.end, b.start));
    if (!prev || !joined(prev, w)) run += 1;
    if (!runs.has(w.token)) runs.set(w.token, run);
    const inRun = (next && joined(w, next)) || (prev && joined(prev, w));
    if (inRun || w.brand || (lang === 'en' && !w.initial)) names.add(w.token);
  }
  return { caps: new Set(words.map((w) => w.token)), names, runs };
}

/**
 * Splits a text into units: sentences, cut at semicolons and at conjunctions that start another
 * statement.
 * @param {string} text
 * @param {import('./lang/index.js').LanguageCode | null} lang
 * @returns {Unit[]}
 */
export function unitsOf(text, lang) {
  /** @type {Unit[]} */
  const units = [];
  for (const span of sentenceSpans(text)) {
    const sentence = text.slice(span.start, span.end);
    // A table row read as "column: value; column: value" is one record: its parts belong together.
    const record = (sentence.match(/(?:^|;\s)[\p{L}][\p{L} ]{0,30}:\s/gu) ?? []).length >= 2;
    for (const part of record ? [sentence] : sentence.split(UNIT_BREAK)) {
      const t = part.trim();
      if (!t) continue;
      const tokens = contentTokens(t);
      const { caps, names, runs } = capitalised(t, lang);
      units.push({ text: t, tokens, index: indexSource(t), names, caps, runs, facts: extractFacts(t).filter((f) => f.kind !== 'quote'), record });
    }
  }
  return units;
}

/**
 * Name-like words of a set of excerpts: what they write as names (see capitalised()).
 * @param {Unit[]} units
 */
export function nameLexicon(units) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const u of units) for (const n of u.names) names.add(n);
  return names;
}

/**
 * Whether a token occurs in a unit (content words, or its folded word sequence for short words).
 * @param {string} token
 * @param {Unit} unit
 */
export function inUnit(token, unit) {
  return tokenMatches(token, unit.index) || unit.index.words.includes(` ${token} `);
}

/**
 * Whether a name word occurs in a unit, also in the German genitive ("Werks Süd" for "Werk Süd",
 * "Lena Parks" for "Lena Park") and with a hyphen ("Sign-On", "Wi-Fi") that the unit's words split.
 * @param {string} token  folded name word
 * @param {Unit} unit
 */
function hasName(token, unit) {
  if (inUnit(token, unit)) return true;
  if (token.length > 3 && token.endsWith('s') && inUnit(token.slice(0, -1), unit)) return true;
  const parts = token.split('-').filter((p) => p.length > 1);
  return parts.length > 1 && parts.every((p) => inUnit(p, unit));
}

/** Thresholds of the binding checks, chosen on the development sets (docs/eval/v2-protocol.md). */
export const BINDING = Object.freeze({
  /** statement words, other than the names in question, a unit must share */
  minShared: 2,
  /** share of those words the excerpt unit contains */
  minShare: 0.6,
  /** share of the excerpt unit's words, other than its own names, the statement unit contains */
  minBack: 0.6,
  /** the same for a table row, whose other columns the statement need not repeat */
  minBackRecord: 0.3,
  /** words a name's own unit shares with the statement to count as where the statement took it from */
  home: 2,
  /** words a passage must share with a statement part to be where its value belongs */
  minRelated: 2,
  /** how many more words that passage must share than any passage holding the value */
  margin: 2,
});

/**
 * Whether a token is one of the given names (as folded words, allowing inflected forms).
 * @param {string} token
 * @param {string[]} names
 */
const isName = (token, names) => names.some((n) => token === n || token.startsWith(n) || n.startsWith(token));

/**
 * How many tokens a unit contains, or -1 as soon as fewer than `need` can be reached: most units of
 * an excerpt share hardly a word with the statement.
 * @param {string[]} tokens
 * @param {Unit} unit
 * @param {number} need
 */
function countUpTo(tokens, unit, need) {
  let matched = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (inUnit(tokens[i], unit)) matched += 1;
    else if (matched + tokens.length - i - 1 < need) return -1;
  }
  return matched >= need ? matched : -1;
}

/**
 * @param {Unit} u
 * @param {Unit[]} units  units of the cited excerpts
 * @param {Set<string>} lexicon
 * @param {(name: string) => boolean} known
 * @returns {{ unit: Unit, names: string[] } | null}
 */
function nameInPlace(u, units, lexicon, known) {
  const candidates = [...new Set([...u.names, ...[...u.caps].filter((t) => lexicon.has(t))])].filter((t) => !known(t));
  if (!candidates.length) return null;
  /** @type {{ unit: Unit, names: string[], matched: number } | null} */
  let best = null;
  for (const c of units) {
    const missing = candidates.filter((t) => !hasName(t, c));
    // A unit with every name of the statement and its other words supports it. A name of several
    // words counts as one: "Nordwall Service GmbH" would otherwise outweigh what the statement says
    // about it.
    if (!missing.length) {
      const words = u.tokens.filter((t) => !isName(t, candidates));
      const names = new Set(candidates.map((t) => u.runs.get(t) ?? t)).size;
      const shared = words.filter((t) => inUnit(t, c)).length + names;
      if (shared >= BINDING.minShared && shared / (words.length + names) >= BINDING.minShare) return null;
      continue;
    }
    const theirs = [...new Set([...c.names, ...[...c.caps].filter((t) => lexicon.has(t))])].filter((t) => !hasName(t, u));
    if (!theirs.length) continue;
    // At least BINDING.minShared of the statement's other words and BINDING.minShare of them, and
    // more than the best unit so far.
    const rest = u.tokens.filter((t) => !isName(t, missing));
    const matched = countUpTo(rest, c, Math.max(BINDING.minShared, Math.ceil(BINDING.minShare * rest.length - 1e-9), best ? best.matched + 1 : 0));
    if (matched < 0) continue;
    const cRest = c.tokens.filter((t) => !isName(t, theirs));
    const back = cRest.length ? cRest.filter((t) => inUnit(t, u)).length / cRest.length : 0;
    if (back >= (c.record ? BINDING.minBackRecord : BINDING.minBack)) best = { unit: c, names: missing, matched };
  }
  if (!best) return null;
  // A name with a unit of its own that shares the statement's other words: the statement joins two
  // passages, it does not move the name.
  const found = best;
  const rest = u.tokens.filter((t) => !isName(t, found.names));
  if (found.names.every((n) => units.some((c) => c !== found.unit && hasName(n, c) && rest.filter((t) => inUnit(t, c)).length >= BINDING.home))) return null;
  return { unit: found.unit, names: found.names };
}

/**
 * The run of capitalised words a name word belongs to, as the text writes it ("Marcus Hale" for
 * "hale", "Nordwall Service GmbH" for "nordwall").
 * @param {string} text
 * @param {string} token  folded name word
 * @returns {string | null}
 */
function nameRun(text, token) {
  const words = [...text.matchAll(CAPITAL)]
    .map((m) => ({ surface: m[0].replace(/['’]s$/u, ''), start: m.index ?? 0 }))
    .map((w) => ({ ...w, end: w.start + w.surface.length, token: fold(w.surface) }))
    .filter((w) => !STOPWORDS.has(w.token) && !STOPWORDS.has(w.surface.toLowerCase()) && !NOT_NAMES.has(w.token));
  let first = words.findIndex((w) => w.token === token);
  if (first < 0) return null;
  let last = first;
  const joined = (/** @type {{ end: number }} */ a, /** @type {{ start: number }} */ b) => /^\s+$/.test(text.slice(a.end, b.start));
  while (first > 0 && joined(words[first - 1], words[first])) first -= 1;
  while (last < words.length - 1 && joined(words[last], words[last + 1])) last += 1;
  return text.slice(words[first].start, words[last].end);
}

/**
 * A name the statement puts where the excerpt has another one: the statement unit matches an
 * excerpt unit in its other words, but the excerpt unit has a different name and lacks the
 * statement's ("Marcus Hale owns the specification" against "Priya Raman, the OT lead, owns this
 * specification"). Units are checked whole, then cut at commas.
 * @param {string} statement
 * @param {import('./lang/index.js').LanguageCode | null} lang
 * @param {Array<{ index: number, units: Unit[] }>} cited
 * @param {Set<string>} lexicon  name-like words of all delivered excerpts
 * @param {(name: string) => boolean} [known]  names the question or the conversation already gave, not checked
 * @returns {{ index: number, name: string, passage: string } | null}
 */
export function misplacedName(statement, lang, cited, lexicon, known = () => false) {
  const units = cited.flatMap((c) => c.units);
  const indexOf = (/** @type {Unit} */ u) => cited.find((c) => c.units.includes(u))?.index ?? -1;
  const own = unitsOf(statement, lang);
  const parts = own.flatMap((u) => {
    const pieces = u.text.split(/,\s+/).filter((p) => p.trim());
    if (pieces.length < 2) return [];
    const subs = pieces.map((p) => unitsOf(p, lang)[0]).filter(Boolean);
    return subs.every((x) => x.tokens.length >= 2) ? subs : [];
  });
  for (const list of [own, parts]) {
    for (const u of list) {
      const hit = nameInPlace(u, units, lexicon, known);
      if (!hit) continue;
      return { index: indexOf(hit.unit), name: nameRun(u.text, hit.names[0]) ?? hit.names[0], passage: hit.unit.text };
    }
  }
  return null;
}

/** Currency and unit words: they stand next to a value everywhere. */
const UNIT_WORDS = new Set(['eur', 'euro', 'euros', 'usd', 'dollar', 'dollars', 'chf', 'gbp', 'uhr', 'am', 'pm']);

/**
 * Content words of a text without its facts and without currency and unit words.
 * @param {string} text
 */
function plainWords(text) {
  let plain = text;
  for (const f of extractFacts(text)) plain = plain.slice(0, f.start) + ' '.repeat(f.end - f.start) + plain.slice(f.end);
  return contentTokens(plain).filter((w) => !UNIT_WORDS.has(w));
}

/**
 * @typedef {object} ValuePassage
 * @property {string} text
 * @property {import('./facts.js').SourceIndex} index
 * @property {import('./facts.js').Fact[]} facts
 * @property {boolean} bare  scored by its whole sentence: a list element without words of its own
 *   ("GW-17" in "GW-17 and GW-31 are …") or a part of a table row, which is one record
 * @property {boolean} short  a sentence with one value and fewer than two other words ("Date: 14 September 2026")
 * @property {import('./facts.js').SourceIndex} sentence  the whole sentence
 * @property {import('./facts.js').SourceIndex | null} lead  for a later part with hardly any words of
 *   its own ("and to the supervisory authority within 72 hours"), the first part of its sentence,
 *   whose subject and verb it shares; not after a semicolon, which starts a clause of its own
 * @property {string[]} own  the part's content words without its facts
 */

/** A dot that ends a sentence after a version number ("… firmware 4.8. Automatic backups …"). */
const AFTER_VERSION = /(?<=\d\.\d+)\.\s+(?=\p{Lu})/u;

/**
 * The passages of an excerpt for the value check: each sentence cut into one part per value, as
 * valueParts does it, without the section heading (version 1 counted the heading as context of
 * every passage, which let a heading word clear a value).
 * @param {string} text
 * @param {(sentence: string) => string[]} split  valueParts
 * @returns {ValuePassage[]}
 */
export function valuePassages(text, split) {
  /** @type {ValuePassage[]} */
  const out = [];
  for (const span of sentenceSpans(text)) {
    for (const sentence of text.slice(span.start, span.end).split(AFTER_VERSION)) {
      const sentenceIndex = indexSource(sentence);
      const parts = split(sentence);
      const record = (sentence.match(/(?:^|;\s)[\p{L}][\p{L} ]{0,30}:\s/gu) ?? []).length >= 2;
      const first = parts.length > 1 ? indexSource(parts[0]) : null;
      parts.forEach((part, k) => {
        const own = plainWords(part);
        const words = own.length;
        // Words the part does not share with the first part ("within", "hours" in a list of
        // deadlines) are what it says of its own.
        const lead = k > 0 ? first : null;
        const elliptic = lead !== null && own.filter((w) => !tokenMatches(w, lead)).length < 3 && !/^\s*;/.test(part);
        out.push({ text: part, index: indexSource(part), facts: extractFacts(part).filter((f) => f.kind !== 'quote'), bare: words === 0 || record, short: parts.length === 1 && words < 2, sentence: sentenceIndex, lead: elliptic ? lead : null, own });
      });
    }
  }
  return out;
}

/** Per excerpt's passages, how many of them contain a word: the same words recur in every statement. */
/** @type {WeakMap<ValuePassage[], Map<string, number>>} */
const WITH_WORD = new WeakMap();

/**
 * @param {string} word
 * @param {ValuePassage[]} list  the passages of one excerpt
 */
function passagesWith(word, list) {
  let counts = WITH_WORD.get(list);
  if (!counts) WITH_WORD.set(list, (counts = new Map()));
  let n = counts.get(word);
  if (n === undefined) counts.set(word, (n = list.filter((p) => tokenMatches(word, p.index)).length));
  return n;
}

/**
 * Values of a statement part that its excerpts hold, but next to other words: a passage holds
 * another value of the same kind and shares the part's words, at least BINDING.minRelated of them
 * and BINDING.margin more than any passage holding the value, or at least one while no passage
 * holding the value shares any ("Port 8883 serves the local admin interface" against "| 8443 |
 * HTTPS | Local admin interface |"). The part's other values count as its words. A year that names
 * a period ("the 2026 budget") is a label, and a value whose sentence has hardly any other words
 * ("Date: 14 September 2026") says nothing about what else it could belong to: neither is checked.
 * @param {string} part  a statement part from valueParts
 * @param {Array<{ index: number, passages: ValuePassage[] }>} cited
 * @returns {Array<{ fact: import('./facts.js').Fact, index: number, passage: string }>}
 */
export function misplacedValues(part, cited) {
  const passages = cited.flatMap((c) => c.passages.map((p) => ({ ...p, source: c.index })));
  const facts = extractFacts(part).filter((f) => f.kind !== 'quote');
  if (!passages.length || !facts.length) return [];
  const words = plainWords(part);
  const own = indexSource(words.join(' '));
  // A word found in most passages (a column name repeated on every row) says nothing about where a
  // value belongs.
  const telling = words.filter((w) => cited.reduce((n, c) => n + passagesWith(w, c.passages), 0) * 2 <= passages.length);
  if (!telling.length) return [];
  /** @type {Array<{ fact: import('./facts.js').Fact, index: number, passage: string }>} */
  const out = [];
  for (const fact of facts) {
    if (fact.kind === 'number' && /^\d{4}$/.test(fact.surface.trim()) && Number(fact.surface) >= 1900 && Number(fact.surface) <= 2100) continue;
    const holders = passages.filter((p) => lookupFact(fact, p.index, 0).found === 'exact');
    if (!holders.length || holders.some((p) => p.short)) continue;
    const others = facts.filter((g) => g !== fact);
    const score = (/** @type {import('./facts.js').SourceIndex} */ index) => telling.filter((w) => tokenMatches(w, index)).length + others.filter((g) => lookupFact(g, index, 0).found === 'exact').length;
    // A part with hardly any words of its own shares those of the first part of its sentence, when
    // it has no word of its own beyond the first part's ("while firmware 4.1.8 does not") or the
    // statement repeats one ("to the supervisory authority within 72 hours"); otherwise the first
    // part's words belong to the first part's value ("Port 9443 dient der Weboberfläche, Port 4840
    // der Maschinenanbindung").
    const scoreHolder = (/** @type {ValuePassage} */ p) => {
      if (p.bare) return score(p.sentence);
      const mine = p.lead ? p.own.filter((w) => !tokenMatches(w, /** @type {import('./facts.js').SourceIndex} */ (p.lead))) : [];
      const lead = p.lead && (!mine.length || mine.some((w) => tokenMatches(w, own))) ? p.lead : null;
      if (!lead) return score(p.index);
      return telling.filter((w) => tokenMatches(w, p.index) || tokenMatches(w, lead)).length + others.filter((g) => lookupFact(g, p.index, 0).found === 'exact').length;
    };
    const held = Math.max(...holders.map(scoreHolder));
    /** @type {{ score: number } | null} */
    let related = null;
    for (const p of passages) {
      if (holders.includes(p)) continue;
      // Another value of the same kind, and not one the statement part names itself: a passage that
      // holds the part's other value is where that value belongs.
      if (!p.facts.some((g) => g.kind === fact.kind && !g.values.some((v) => fact.values.includes(v) || others.some((o) => o.values.includes(v))))) continue;
      const s = score(p.index);
      const strong = (s >= BINDING.minRelated && s >= held + BINDING.margin) || (held === 0 && s >= 1);
      if (strong && (!related || s > related.score)) related = { score: s };
    }
    if (!related) continue;
    const place = holders.reduce((a, b) => (scoreHolder(b) > scoreHolder(a) ? b : a));
    out.push({ fact, index: place.source, passage: place.text });
  }
  return out;
}
