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
// Pure: no DOM, runs in the browser, in workers and in Node.
import { contentTokens, fold, indexSource, tokenMatches } from './facts.js';
import { STOPWORDS } from '../rag/bm25.js';
import { sentenceSpans } from './sentences.js';

/** Stop words as canonicalText writes them ("für" → "fuer"), for clause texts that are already folded. */
const FOLDED_STOPWORDS = new Set([...STOPWORDS].map((w) => fold(w)));

/** Marker that replaces the negative half of an antonym pair ("disabled" → "notx enabled"). */
const NEG_MARK = 'notx';

/**
 * Words that state the negation of a positive word, as [pattern on folded text, replacement]. The
 * replacement puts the marker before the positive word, so "disabled" and "not enabled" read the
 * same, and "enabled" in another clause matches the word inside the scope.
 * @type {Array<[RegExp, string]>}
 */
const ANTONYMS = [
  // English
  [/\b(?:disabled|disables|disable|switched off|turned off)\b/g, `${NEG_MARK} enabled`],
  [/\b(?:enables|enable|switched on|turned on)\b/g, 'enabled'],
  [/\b(?:prohibited|forbidden|barred|banned|not permitted|not allowed|(?:may|must|should) not)\b/g, `${NEG_MARK} allowed`],
  [/\b(?:permitted|allowed)\b|(?<!\d\s)\bmay\b(?!\s+\d)/g, 'allowed'],
  [/\b(?:rejected|rejects|reject)\b/g, `${NEG_MARK} accepted`],
  [/\b(?:accepts|accept)\b/g, 'accepted'],
  [/\b(?:failed|fails|fail)\b/g, `${NEG_MARK} passed`],
  [/\b(?:passes|pass|succeeded)\b/g, 'passed'],
  [/\boffline\b/g, `${NEG_MARK} online`],
  [/\bunsupported\b/g, `${NEG_MARK} supported`],
  [/\bunavailable\b/g, `${NEG_MARK} available`],
  [/\b(?:decreased|decreases|decrease|fell|falls|dropped|drops|reduced|reduces|reduce|cut|cuts|lowered)\b/g, `${NEG_MARK} increased`],
  [/\b(?:increases|increase|rose|rises|rise|grew|grows|raised)\b/g, 'increased'],
  [/\bopen (?=questions?\b)/g, `${NEG_MARK} resolved `],
  [/\b(?:resolved|settled|clarified|answered|decided)\b/g, 'resolved'],
  [/\bexcluded\b/g, `${NEG_MARK} included`],
  [/\bdenied\b/g, `${NEG_MARK} granted`],
  [/\b(?:unless|except when|except if)\b/g, NEG_MARK],
  [/\b(?:held back|withheld|kept back)\b/g, NEG_MARK],
  [/\b(?:exempt|exempted)\b/g, NEG_MARK],
  [/\bun(used|encrypted|signed|authori[sz]ed|approved|planned|changed|limited|restricted|locked|reachable|monitored|managed|disputed|resolved|necessary|known|verified|protected|paid|assigned|documented|tested|connected|published|licensed|certified|affected|acceptable|able|safe|secure|stable|sure|clear|likely|usual|official|attended|modified|readable|aware|solved|answered|confirmed|scheduled|heated|finished|complete)\b/g, `${NEG_MARK} $1`],
  [/\bin(active|complete|valid|correct|accessible|sufficient|accurate|compatible|eligible|secure|consistent|dependent|visible|applicable|effective|frequent)\b/g, `${NEG_MARK} $1`],
  [/\bim(possible|proper|plausible|mature|precise|practical)\b/g, `${NEG_MARK} $1`],
  [/\bil(legal|logical)\b/g, `${NEG_MARK} $1`],
  [/\bir(relevant|regular|reversible|responsible)\b/g, `${NEG_MARK} $1`],
  [/\bdis(allowed|connected|approved|continued|qualified)\b/g, `${NEG_MARK} $1`],
  // A word followed by "less" ("wireless" stays a word when the other text never says "wire"). The
  // boundaries are written out: \b is ASCII-only, which made the pattern quadratic on long words
  // that mix ASCII and other letters.
  [/(?<![\p{L}\p{N}])(\p{L}{3,})less(?![\p{L}\p{N}])/gu, `${NEG_MARK} $1`],
  // German (folded: ä → ae, ö → oe, ü → ue, ß → ss)
  [/\b(?:deaktiviert|deaktivieren|abgeschaltet|ausgeschaltet)\b/g, `${NEG_MARK} aktiviert`],
  [/\b(?:aktivieren|eingeschaltet)\b/g, 'aktiviert'],
  [/\b(?:verboten|untersagt|unzulaessig|gesperrt|(?:darf|duerfen|soll|sollen) (?:\p{L}+ ){0,4}?nicht)\b/gu, `${NEG_MARK} erlaubt`],
  [/\b(?:zulaessig|gestattet|freigeschaltet|darf|duerfen)\b/g, 'erlaubt'],
  [/\b(?:abgelehnt|zurueckgewiesen)\b/g, `${NEG_MARK} akzeptiert`],
  [/\b(?:durchgefallen|fehlgeschlagen|gescheitert)\b/g, `${NEG_MARK} bestanden`],
  [/\b(?:gesunken|sinkt|sank|sinken|verringert|reduziert|gesenkt)\b/g, `${NEG_MARK} gestiegen`],
  [/\b(?:steigt|stieg|steigen|erhoeht)\b/g, 'gestiegen'],
  [/\boffene (?=fragen?\b)/g, `${NEG_MARK} geklaert `],
  [/\b(?:geklaert|entschieden|beantwortet)\b/g, 'geklaert'],
  [/\bausgeschlossen\b/g, `${NEG_MARK} eingeschlossen`],
  [/\b(?:es sei denn|ausser wenn|ausser falls)\b,?/g, NEG_MARK],
  [/\b(?:zurueckgehalten|einbehalten)\b/g, NEG_MARK],
  [/\b(?:ausgenommen|befreit)\b/g, NEG_MARK],
  [/\bun(genutzt|verschluesselt|signiert|verbraucht|veraendert|befugt|genehmigt|geplant|begrenzt|gesperrt|erreichbar|ueberwacht|bekannt|noetig|erlaubt|vollstaendig|moeglich|verwaltet|beheizt|geklaert|gueltig|wirksam|sicher|bestaetigt|berechtigt|geprueft|verfuegbar|abhaengig|eingeschraenkt|getestet|dokumentiert|bezahlt|verbunden|benutzt|geloest|beantwortet|entschieden|klar|wahrscheinlich|ueblich|regelmaessig|beschaedigt|verschlossen|beaufsichtigt|veroeffentlicht|lizenziert|zertifiziert|betroffen|stabil|zuverlaessig|vollendet)(e|er|es|en|em)?\b/g, `${NEG_MARK} $1$2`],
  [/\bin(aktiv|kompatibel|konsistent|effizient|korrekt|valide)\b/g, `${NEG_MARK} $1`],
  [/\bil(legal|loyal)\b/g, `${NEG_MARK} $1`],
  [/\bir(relevant|reversibel|regulaer)\b/g, `${NEG_MARK} $1`],
  [/(?<![\p{L}\p{N}])(\p{L}{3,})los(?![\p{L}\p{N}])/gu, `${NEG_MARK} $1`],
];

/** Words skipped when looking for the word a negator negates: they qualify it, they are not it. */
const QUALIFIERS = new Set([
  'yet', 'also', 'always', 'still', 'really', 'even', 'automatically', 'longer', 'anymore', 'ever', 'currently', 'necessarily',
  'auch', 'noch', 'immer', 'bereits', 'schon', 'ebenfalls', 'dabei', 'mehr', 'automatisch', 'unbedingt', 'derzeit', 'jedoch',
]);

/**
 * Negators that negate what follows them. Conditional ones (unless, es sei denn) are left out: they
 * restrict a rule rather than reverse it.
 */
const NEGATORS = new Set([
  'not', 'no', 'never', 'none', 'nothing', 'nobody', 'neither', 'nor', 'without', 'cannot', NEG_MARK,
  'nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'keines', 'nie', 'niemals', 'nichts', 'niemand', 'weder', 'ohne',
]);

/**
 * Word sequences that contain a negator but bound a quantity or extend a list instead of negating
 * ("no later than", "not only", "nicht mehr als"): the negator is removed before counting. "No
 * longer" and "nicht mehr" without "than" or "als" are negations ("no longer supported"). "Not
 * before" bounds a time unless a modal verb makes it a prohibition ("darf nicht nach 18 Uhr …").
 */
const NOT_NEGATIONS =
  /\b(?:no|not)\s+(?:later|earlier|more|less|fewer|longer|shorter)\s+than\b|\b(?:no|not)\s+(?:only|just)\b|\bnicht\s+(?:spaeter|frueher|mehr|weniger|laenger|kuerzer)\s+als\b|\bnicht\s+nur\b|(?<!\b(?:may|must|should|can|darf|duerfen|soll|sollen|muss|muessen|kann|koennen)\s)\b(?:not\s+(?:before|after)|nicht\s+(?:vor|nach))\b|\bwhether or not\b|\bob oder nicht\b|\bno\.(?=\s*\d)|\bgo\/no-go\b/gu;

/**
 * A time condition ("until", "before", "bis", "bevor"): "not connected until it is updated" says
 * that it is connected after the update, the same as "connected only after it is updated". In a
 * clause with such a word (not a range like "from Monday until Friday" or "bis zu drei Tagen"),
 * and in the clauses next to one that starts with it ("Bevor X, werden Y nicht bezahlt"),
 * negations are not counted.
 */
const TIME_CONDITION = /\b(?:until|till|before|bevor|ehe|bis(?!\s+zu\b))\b/;
const TIME_CLAUSE = /^(?:until|till|before|bevor|ehe|bis(?!\s+zu\b))\b/;
const TIME_RANGE = /\b(?:from|von)\s+(?:[\p{L}\p{N}.:-]+\s+){0,4}(?:until|till|bis)\b/u;
/** CLAUSE_BREAK with the boundary kept, to rebuild the text. */
const CLAUSE_SPLIT = /([.;:!?]\s+|,\s+|\s+(?:and|or|but|while|whereas|although|though|because|und|oder|waehrend|wobei|weil|sowie)\s+)/;

/**
 * Removes the negations that a time condition turns into a "not before" (see TIME_CONDITION).
 * @param {string} sentence  canonical text of one sentence
 */
function withoutTimedNegations(sentence) {
  const parts = sentence.split(CLAUSE_SPLIT);
  const clauses = parts.filter((_, i) => i % 2 === 0);
  const drop = clauses.map((c) => TIME_CONDITION.test(c) && !TIME_RANGE.test(c));
  clauses.forEach((c, i) => {
    if (!TIME_CLAUSE.test(c.trim()) || TIME_RANGE.test(c)) return;
    if (i > 0) drop[i - 1] = true;
    if (i + 1 < clauses.length) drop[i + 1] = true;
  });
  return parts.map((p, i) => (i % 2 === 0 && drop[i / 2] ? p.replace(NEGATION_WORD, ' ') : p)).join('');
}
const NEGATION_WORD = new RegExp(`\\b(?:not|no|never|nicht|kein|keine|keinen|keinem|keiner|keines|nie|niemals|${NEG_MARK})\\b`, 'g');

/** A negation of a whole clause, before the clause it negates: "it is not true that …". */
const SENTENCE_NEGATION = /\bit is not (?:true|the case|correct) that\b|\bes (?:ist|stimmt|trifft) nicht (?:so|zu)?,? dass\b|\bes stimmt nicht,? dass\b/g;

/** "Nothing speaks against it": a double negation that allows. */
const NOTHING_AGAINST = /\b(?:nothing|nichts)\s+(?:speaks\s+)?(?:dagegen|gegen|against)\b|\bno objection\b/g;

/**
 * Clause boundaries: sentence ends, semicolons, colons, commas and conjunctions that join two
 * statements. German adverbs that can also join clauses (aber, jedoch, dagegen) stand inside a
 * clause too often to split at; after a comma they are dropped as a leading word.
 */
const CLAUSE_BREAK = /[.;:!?]\s+|,\s+|\s+(?:and|or|but|while|whereas|although|though|because|und|oder|waehrend|wobei|weil|sowie)\s+/g;
const LEADING_CONJUNCTION = /^(?:and|or|but|while|whereas|although|though|because|so|then|und|oder|aber|jedoch|dagegen|allerdings|sondern|weil|denn|wobei|waehrend|sowie)\s+/;

/**
 * Folds a text and rewrites negated antonyms and contractions, so negation reads the same in every
 * form: "isn't" → "is not", "disabled" → "notx enabled".
 * @param {string} text
 */
export function canonicalText(text) {
  let t = fold(text)
    .replace(/\bcan'?t\b/g, 'can not')
    .replace(/\bwon'?t\b/g, 'will not')
    .replace(/n't\b/g, ' not')
    .replace(/\bcannot\b/g, 'can not')
    // "do-not-disturb", "not-null": the negator of a hyphenated word counts like a separate one.
    .replace(/-(not|nicht)-/g, ' $1 ')
    .replace(/\b(not|no|nicht|kein)-(?=\p{L})/gu, '$1 ')
    // "neither A nor B" negates once: "not A or B".
    .replace(/\bneither\b([^.;:!?]*?)\bnor\b/g, 'not$1or not')
    .replace(/\bweder\b([^.;:!?]*?)\bnoch\b/g, 'nicht$1oder nicht')
    .replace(/\bnothing but\b/g, 'only')
    .replace(/\bnichts als\b/g, 'nur')
    .replace(/\b(?:stopped|ceased)\s+(?=\p{L}+ing\b)/gu, 'not ')
    .replace(SENTENCE_NEGATION, ` ${NEG_MARK} `)
    .replace(NOTHING_AGAINST, (m) => (/nichts/.test(m) ? ' erlaubt ' : ' allowed '))
    .replace(NOT_NEGATIONS, (m) => m.replace(/\b(?:no|not|nicht)\b/g, ''));
  for (const [pattern, replacement] of ANTONYMS) t = t.replace(pattern, replacement);
  return t
    .split(/(?<=[.;!?])\s+/)
    .map((sentence) => (TIME_CONDITION.test(sentence) ? withoutTimedNegations(sentence) : sentence))
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
  const labelled = canonical.replace(/^(\s*(?:[\p{L}\p{N}-]+\s+){0,2}[\p{L}\p{N}-]+):\s+/u, '$1 ');
  const parts = labelled
    .split(CLAUSE_BREAK)
    .map((c) => c.trim().replace(LEADING_CONJUNCTION, '').replace(/[.!?]+$/, ''))
    .filter(Boolean);
  if (!merge) return parts;
  // A part with fewer than two content words ("Geklärt ist bereits", "Fahrerinnen") cannot be
  // matched with a source clause on its own: it is joined to the part after it. A short part with
  // a negator stays alone, so a condition ("Reicht das nicht, …") does not negate the clause after it.
  /** @type {string[]} */
  const out = [];
  let carry = '';
  const words = (/** @type {string} */ t) => contentTokens(t).filter((w) => !QUALIFIERS.has(w)).length;
  const negated = (/** @type {string} */ t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []).some((w) => NEGATORS.has(w));
  for (const part of parts) {
    const joined = carry ? `${carry} ${part}` : part;
    // "Without a wipe certificate, a gateway is not sent back": the phrase belongs to its clause.
    if (/^(?:without|ohne)\s/.test(part) && words(part) <= 3) carry = joined;
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
  for (const w of words) {
    if (NEGATORS.has(w)) {
      marks.push(tokens.length);
      continue;
    }
    for (const t of contentTokens(w)) {
      if (FOLDED_STOPWORDS.has(t)) continue;
      tokens.push(t);
      qualifier.push(QUALIFIERS.has(t));
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
 * Words that restrict a statement to a case ("only after the update", "nur im Testnetz"): a clause
 * with one of them restates a negated rule positively ("prohibited unless …" → "only allowed
 * if …"), so a clause pair where only one side has it is not compared.
 */
const RESTRICTIVE = /\b(?:only|solely|exclusively|merely|nur|ausschliesslich|lediglich|erst)\b/;

/**
 * Numbers of a clause, as digits only, so 480,000 and 480.000 compare equal.
 * @param {string} text  canonical clause text
 */
const numbersOf = (text) => (text.match(/\d+(?:[.,:]\d+)*/g) ?? []).map((n) => n.replace(/\D/g, ''));

/**
 * @typedef {object} SourceClause
 * @property {ClauseProfile} profile
 * @property {string} sentence  the source sentence it is part of, as written
 * @property {boolean} restricted  the sentence restricts a rule to a case (see RESTRICTIVE)
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
    const restricted = RESTRICTIVE.test(canonical);
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
  const restricted = RESTRICTIVE.test(canonical);
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
