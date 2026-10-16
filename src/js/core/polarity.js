// @ts-check
// Polarity of clauses, for the negation gate of the source check (version 2): whether a statement
// says the opposite of the source passage it matches ("Power over Ethernet is supported" when the
// excerpt says "Power over Ethernet is not supported"), in English and German.
//
// A clause's polarity elements are its negators (not, never, no, without, nicht, kein, nie, ohne,
// …) and the words that mean the negation of another word (disabled = not enabled, verboten = not
// erlaubt, decreased = not increased, open question = not resolved, unless = if not). Each element
// is anchored to the word it negates: the next content word, or the previous one when the negator
// ends its clause (German "… gilt die Spezifikation nicht"). Two clauses that state the same thing
// have the same parity of elements anchored on words they share; a different parity means one of
// them is negated. Elements anchored on a word the other clause does not have say nothing about it
// and are not counted ("GW-31 has not been updated yet" against "GW-31 still runs 4.1.8").
//
// The negators, antonyms and conjunctions of each language come from its language pack (lang/);
// this module compiles the rules of every registered pack together.
//
// Pure: no DOM, runs in the browser, in workers and in Node.
import { contentTokens, fold, indexSource, tokenMatches } from './facts.js';
import { anyOf, fromPacks, union } from './lang/index.js';
import { sentenceSpans } from './sentences.js';

/** Marker that replaces the negative half of an antonym pair ("disabled" → "notx enabled"). */
const NEG_MARK = 'notx';

/**
 * The polarity rules of all registered language packs (lang/index.js), compiled into the patterns
 * below. Rebuilt when a pack is registered.
 */
const rules = fromPacks((packs) => {
  const rule = packs.map((p) => p.polarity);
  /** @param {(r: import('./lang/index.js').PolarityRules) => string[]} pick */
  const all = (pick) => union(rule.map(pick));
  const words = (/** @type {string[]} */ list) => `\\b${anyOf(list)}\\b`;
  const joiners = anyOf(all((r) => r.clauseJoiners));
  const time = anyOf(all((r) => r.timeConditions));
  /** @type {Map<string, string>} the positive word a "nothing against" phrase stands for, by its first word or the whole phrase */
  const allowedBy = new Map();
  for (const r of rule) for (const w of [...r.nothingAgainst.nothing, ...r.nothingAgainst.phrases]) allowedBy.set(w, r.nothingAgainst.allowed);
  const verbs = all((r) => r.nothingAgainst.verbs);
  const timed = rule.filter((r) => r.timeBounds.negators.length && r.timeBounds.words.length);
  return {
    /** Stop words as canonicalText writes them ("für" → "fuer"), for clause texts that are already folded. */
    stopwords: new Set(packs.flatMap((p) => p.stopwords).map((w) => fold(w))),
    /**
     * Words that state the negation of a positive word, as [pattern on folded text, replacement]. The
     * replacement puts the marker before the positive word, so "disabled" and "not enabled" read the
     * same, and "enabled" in another clause matches the word inside the scope.
     * @type {Array<[RegExp, string]>}
     */
    antonyms: rule.flatMap((r) => r.antonyms.map(([pattern, word, negative]) => /** @type {[RegExp, string]} */ ([pattern, negative ? (word ? `${NEG_MARK} ${word}` : NEG_MARK) : word]))),
    /** Words skipped when looking for the word a negator negates: they qualify it, they are not it. */
    qualifiers: new Set(all((r) => r.qualifiers)),
    /**
     * Negators that negate what follows them. Conditional ones (unless, es sei denn) are left out:
     * they restrict a rule rather than reverse it.
     */
    negators: new Set([...all((r) => r.negators), NEG_MARK]),
    contractions: rule.flatMap((r) => r.contractions),
    // "do-not-disturb", "not-null": the negator of a hyphenated word counts like a separate one.
    infix: new RegExp(`-(${all((r) => r.infixNegators).join('|') || '(?!)'})-`, 'g'),
    prefix: new RegExp(`\\b(${all((r) => r.prefixNegators).join('|') || '(?!)'})-(?=\\p{L})`, 'gu'),
    rewrites: rule.flatMap((r) => r.rewrites),
    /** A negation of a whole clause, before the clause it negates: "it is not true that …". */
    sentenceNegation: new RegExp(all((r) => r.clauseNegations).join('|') || '(?!)', 'g'),
    /** "Nothing speaks against it": a double negation that allows. */
    nothingAgainst: new RegExp(
      [
        `\\b${anyOf(all((r) => r.nothingAgainst.nothing))}\\s+${verbs.length ? `(?:${anyOf(verbs)}\\s+)?` : ''}${anyOf(all((r) => r.nothingAgainst.against))}\\b`,
        ...all((r) => r.nothingAgainst.phrases).map((phrase) => `\\b${phrase}\\b`),
      ].join('|'),
      'g',
    ),
    allowedBy,
    /**
     * Word sequences that contain a negator but bound a quantity or extend a list instead of negating
     * ("no later than", "not only", "nicht mehr als"): the negator is removed before counting. "No
     * longer" and "nicht mehr" without "than" or "als" are negations ("no longer supported"). "Not
     * before" bounds a time unless a modal verb makes it a prohibition ("darf nicht nach 18 Uhr …").
     */
    notNegations: new RegExp(
      [
        ...rule.flatMap(({ bounds: b }) =>
          b.negators.length
            ? [`\\b${anyOf(b.negators)}\\s+${anyOf(b.comparatives)}\\s+${anyOf(b.than)}\\b`, `\\b${anyOf(b.negators)}\\s+${anyOf(b.additives)}\\b`]
            : [],
        ),
        ...(timed.length
          ? [`(?<!\\b${anyOf(all((r) => r.modals))}\\s)\\b${anyOf(timed.map((r) => `${anyOf(r.timeBounds.negators)}\\s+${anyOf(r.timeBounds.words)}`))}\\b`]
          : []),
        ...all((r) => r.idioms),
      ].join('|') || '(?!)',
      'gu',
    ),
    /** the negators inside those sequences */
    boundNegator: new RegExp(words(all((r) => [...r.bounds.negators, ...r.timeBounds.negators])), 'g'),
    /**
     * A time condition ("until", "before", "bis", "bevor"): "not connected until it is updated" says
     * that it is connected after the update, the same as "connected only after it is updated". In a
     * clause with such a word (not a range like "from Monday until Friday" or "bis zu drei Tagen"),
     * and in the clauses next to one that starts with it ("Bevor X, werden Y nicht bezahlt"),
     * negations are not counted.
     */
    timeCondition: new RegExp(`\\b${time}\\b`),
    timeClause: new RegExp(`^${time}\\b`),
    timeRange: new RegExp(`\\b${anyOf(all((r) => r.rangeStarts))}\\s+(?:[\\p{L}\\p{N}.:-]+\\s+){0,4}${anyOf(all((r) => r.rangeEnds))}\\b`, 'u'),
    /** the negators a time condition cancels */
    negationWord: new RegExp(`\\b(?:${[...all((r) => r.plainNegators), NEG_MARK].join('|')})\\b`, 'g'),
    /**
     * Clause boundaries: sentence ends, semicolons, colons, commas and conjunctions that join two
     * statements. Adverbs that can also join clauses (German aber, jedoch, dagegen) stand inside a
     * clause too often to split at; after a comma they are dropped as a leading word.
     */
    clauseBreak: new RegExp(`[.;:!?]\\s+|,\\s+|\\s+${joiners}\\s+`, 'g'),
    /** clauseBreak with the boundary kept, to rebuild the text */
    clauseSplit: new RegExp(`([.;:!?]\\s+|,\\s+|\\s+${joiners}\\s+)`),
    leadingWord: new RegExp(`^${anyOf(all((r) => r.leadingWords))}\\s+`),
    /**
     * Words that restrict a statement to a case ("only after the update", "nur im Testnetz"): a clause
     * with one of them restates a negated rule positively ("prohibited unless …" → "only allowed
     * if …"), so a clause pair where only one side has it is not compared.
     */
    restrictive: new RegExp(words(all((r) => r.restrictive))),
    /** "Without a wipe certificate, a gateway is not sent back": the phrase belongs to its clause. */
    without: new RegExp(`^${anyOf(all((r) => r.without))}\\s`),
  };
});

/**
 * Removes the negations that a time condition turns into a "not before" (see rules().timeCondition).
 * @param {string} sentence  canonical text of one sentence
 */
function withoutTimedNegations(sentence) {
  const r = rules();
  const parts = sentence.split(r.clauseSplit);
  const clauses = parts.filter((_, i) => i % 2 === 0);
  const drop = clauses.map((c) => r.timeCondition.test(c) && !r.timeRange.test(c));
  clauses.forEach((c, i) => {
    if (!r.timeClause.test(c.trim()) || r.timeRange.test(c)) return;
    if (i > 0) drop[i - 1] = true;
    if (i + 1 < clauses.length) drop[i + 1] = true;
  });
  return parts.map((p, i) => (i % 2 === 0 && drop[i / 2] ? p.replace(r.negationWord, ' ') : p)).join('');
}

/**
 * Folds a text and rewrites negated antonyms and contractions, so negation reads the same in every
 * form: "isn't" → "is not", "disabled" → "notx enabled".
 * @param {string} text
 */
export function canonicalText(text) {
  const r = rules();
  let t = fold(text);
  for (const [pattern, replacement] of r.contractions) t = t.replace(pattern, replacement);
  t = t.replace(r.infix, ' $1 ').replace(r.prefix, '$1 ');
  // "neither A nor B" negates once ("not A or not B"); "nothing but" means "only".
  for (const [pattern, replacement] of r.rewrites) t = t.replace(pattern, replacement);
  t = t
    .replace(r.sentenceNegation, ` ${NEG_MARK} `)
    .replace(r.nothingAgainst, (m) => ` ${r.allowedBy.get(m.split(/\s+/)[0]) ?? r.allowedBy.get(m) ?? ''} `)
    .replace(r.notNegations, (m) => m.replace(r.boundNegator, ''));
  for (const [pattern, replacement] of r.antonyms) t = t.replace(pattern, replacement);
  return t
    .split(/(?<=[.;!?])\s+/)
    .map((sentence) => (r.timeCondition.test(sentence) ? withoutTimedNegations(sentence) : sentence))
    .join(' ');
}

/**
 * The clauses of a text (after canonicalText): parts between clause boundaries. A short label
 * before a colon ("Open question: …", "Offene Frage: …") stays with the clause after it.
 * @param {string} canonical
 * @param {boolean} [merge]  join parts with fewer than two content words to the next part
 * @returns {string[]}
 */
export function clausesOf(canonical, merge = false) {
  const r = rules();
  const labelled = canonical.replace(/^(\s*(?:[\p{L}\p{N}-]+\s+){0,2}[\p{L}\p{N}-]+):\s+/u, '$1 ');
  const parts = labelled
    .split(r.clauseBreak)
    .map((c) => c.trim().replace(r.leadingWord, '').replace(/[.!?]+$/, ''))
    .filter(Boolean);
  if (!merge) return parts;
  // A part with fewer than two content words ("Geklärt ist bereits", "Fahrerinnen") cannot be
  // matched with a source clause on its own: it is joined to the part after it. A short part with
  // a negator stays alone, so a condition ("Reicht das nicht, …") does not negate the clause after it.
  /** @type {string[]} */
  const out = [];
  let carry = '';
  const words = (/** @type {string} */ t) => contentTokens(t).filter((w) => !r.qualifiers.has(w)).length;
  const negated = (/** @type {string} */ t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []).some((w) => r.negators.has(w));
  for (const part of parts) {
    const joined = carry ? `${carry} ${part}` : part;
    // "Without a wipe certificate, a gateway is not sent back": the phrase belongs to its clause.
    if (r.without.test(part) && words(part) <= 3) carry = joined;
    else if (words(joined) < 2 && !negated(part)) carry = joined;
    else {
      if (carry && negated(part) && words(part) < 2) out.push(carry, part);
      else out.push(joined);
      carry = '';
    }
  }
  if (carry) out.push(carry);
  return out;
}

/**
 * @typedef {object} ClauseProfile
 * @property {string} text      canonical clause text
 * @property {string[]} tokens  content tokens, negators removed
 * @property {import('./facts.js').SourceIndex} index
 * @property {string[]} anchors  per polarity element, the content token it negates ('' when the clause has none)
 */

/**
 * Content tokens and polarity elements of one clause.
 * @param {string} clause  canonical clause text
 * @returns {ClauseProfile}
 */
export function profileClause(clause) {
  const words = clause.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  /** @type {string[]} */
  const tokens = [];
  /** @type {boolean[]} qualifiers among the tokens, skipped as anchors */
  const qualifier = [];
  /** @type {number[]} position of each negator in `tokens` */
  const marks = [];
  const r = rules();
  for (const w of words) {
    if (r.negators.has(w)) {
      marks.push(tokens.length);
      continue;
    }
    for (const t of contentTokens(w)) {
      if (r.stopwords.has(t)) continue;
      tokens.push(t);
      qualifier.push(r.qualifiers.has(t));
    }
  }
  const anchors = marks.map((at) => {
    for (let i = at; i < tokens.length; i += 1) if (!qualifier[i]) return tokens[i];
    for (let i = at - 1; i >= 0; i -= 1) if (!qualifier[i]) return tokens[i];
    return '';
  });
  const content = tokens.filter((_, i) => !qualifier[i]);
  return { text: clause, tokens: content, index: indexSource(content.join(' ')), anchors };
}

/**
 * How well clause `b` covers the content tokens of clause `a`: matched tokens and their share.
 * @param {ClauseProfile} a
 * @param {ClauseProfile} b
 */
export function coverage(a, b) {
  const matched = a.tokens.filter((t) => tokenMatches(t, b.index));
  return { matched: matched.length, share: a.tokens.length ? matched.length / a.tokens.length : 0, words: matched };
}

/**
 * The tokens of clause `a` that clause `b` contains, when they reach POLARITY.minShared and
 * POLARITY.minShare; 0 otherwise. Stops as soon as too many tokens are missing, which most clauses
 * of an excerpt are.
 * @param {ClauseProfile} a
 * @param {ClauseProfile} b
 */
function reaches(a, b) {
  const allowed = a.tokens.length - Math.max(POLARITY.minShared, Math.ceil(POLARITY.minShare * a.tokens.length - 1e-9));
  let missed = 0;
  for (const t of a.tokens) {
    if (tokenMatches(t, b.index)) continue;
    missed += 1;
    if (missed > allowed) return 0;
  }
  return a.tokens.length - missed;
}

/**
 * Whether two aligned clauses differ in polarity: the parity of the elements of each clause whose
 * scope reaches a word of the other clause.
 * @param {ClauseProfile} a
 * @param {ClauseProfile} b
 */
export function polarityDiffers(a, b) {
  const anchored = (/** @type {ClauseProfile} */ x, /** @type {ClauseProfile} */ other) => x.anchors.filter((t) => t && tokenMatches(t, other.index)).length;
  // Both the elements anchored on shared words and all elements must differ in parity: when only
  // one count differs, the clauses negate different words ("not updated" against "the update
  // failed") and say nothing clear about each other.
  return anchored(a, b) % 2 !== anchored(b, a) % 2 && a.anchors.length % 2 !== b.anchors.length % 2;
}

/** Thresholds of the negation gate, chosen on the development sets (docs/eval/v2-protocol.md). */
export const POLARITY = Object.freeze({
  /** content words a statement clause and a source clause must share */
  minShared: 2,
  /** share of the statement clause's content words the source clause contains */
  minShare: 0.6,
  /** share of the source clause's content words the statement clause contains */
  minBack: 0.5,
});

/**
 * Numbers of a clause, as digits only, so 480,000 and 480.000 compare equal.
 * @param {string} text  canonical clause text
 */
const numbersOf = (text) => (text.match(/\d+(?:[.,:]\d+)*/g) ?? []).map((n) => n.replace(/\D/g, ''));

/**
 * @typedef {object} SourceClause
 * @property {ClauseProfile} profile
 * @property {string} sentence  the source sentence it is part of, as written
 * @property {boolean} restricted  the sentence restricts a rule to a case (see rules().restrictive)
 */

/**
 * The clauses of an excerpt, each with the sentence it stands in.
 * @param {string} text
 * @returns {SourceClause[]}
 */
export function sourceClauses(text) {
  /** @type {SourceClause[]} */
  const out = [];
  for (const span of sentenceSpans(text)) {
    const sentence = text.slice(span.start, span.end);
    const canonical = canonicalText(sentence);
    const restricted = rules().restrictive.test(canonical);
    for (const clause of clausesOf(canonical, true)) out.push({ profile: profileClause(clause), sentence, restricted });
  }
  return out;
}

/**
 * Whether a statement says the opposite of a clause of the excerpts it cites: a statement clause
 * that matches source clauses well in both directions and differs in polarity from every one of
 * them that matches it as well as the best. A question asserts nothing and is not checked; a source
 * clause that lacks one of the statement clause's numbers is about something else. Returns the
 * excerpt and the sentence of the clause.
 * @param {string} statement
 * @param {Array<{ index: number, clauses: SourceClause[] }>} cited  the delivered excerpts the statement cites
 * @returns {{ index: number, sentence: string } | null}
 */
export function negationInversion(statement, cited) {
  if (/\?\s*$/.test(statement)) return null;
  const canonical = canonicalText(statement);
  const restricted = rules().restrictive.test(canonical);
  for (const clause of clausesOf(canonical, true)) {
    const s = profileClause(clause);
    if (s.tokens.length < POLARITY.minShared) continue;
    const numbers = numbersOf(clause);
    /** @type {Array<{ index: number, c: SourceClause, matched: number }>} */
    const candidates = [];
    for (const { index, clauses } of cited) {
      for (const c of clauses) {
        const fwd = reaches(s, c.profile);
        if (!fwd) continue;
        if (coverage(c.profile, s).share < POLARITY.minBack) continue;
        const theirs = numbersOf(c.profile.text);
        if (!numbers.every((n) => theirs.includes(n))) continue;
        candidates.push({ index, c, matched: fwd });
      }
    }
    if (!candidates.length) continue;
    const best = Math.max(...candidates.map((x) => x.matched));
    const strongest = candidates.filter((x) => x.matched === best);
    // Only when every equally good match says the opposite: one that agrees means the statement
    // may simply restate it. A restriction in only one of the two sentences ("only after", "nur
    // wenn") restates a negated rule, also in its condition.
    if (!strongest.every((x) => x.c.restricted === restricted && polarityDiffers(s, x.c.profile))) continue;
    const pick = strongest[0];
    return { index: pick.index, sentence: pick.c.sentence };
  }
  return null;
}
