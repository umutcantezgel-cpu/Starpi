// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// The spoken form of a released sentence: the canonical text (canonical.js) with the abbreviations
// and unit signs of its language written out ("z. B." → "zum Beispiel", "5 km" → "5 Kilometer",
// "~5" → "about 5"), so a speech engine does not guess. Only expansions a language pack lists are
// made (lang/, `gate.spoken`), and they hold letters only, never digits.
//
// The result is read again with the same number reader as the gate (number-words.js). When the
// numbers, number words or identifiers it reads differ from those of the canonical text in any way,
// the expansion is dropped and the canonical text is spoken unchanged: a spoken form may make a
// sentence easier to hear, never say another number than the one that was checked.
//
// Pure: no DOM, runs in the browser, in workers and in Node.
import { guessLanguage } from './facts.js';
import { fromPacks, languagePack } from './lang/index.js';
import { scanNumbers } from './number-words.js';

/**
 * @typedef {object} SpokenForm
 * @property {string} text       what to speak
 * @property {boolean} expanded  an expansion was made and kept
 * @property {boolean} mismatch  an expansion changed what the number reader reads, so the canonical text is spoken
 */

/** @param {string} s */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** @param {string} s */
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A pattern for one abbreviation as written: a space after an inner dot is optional ("z. B." also
 * matches "z.B."), and a lowercase abbreviation also matches with a capital first letter.
 * @param {string} abbreviation
 */
function abbreviationSource(abbreviation) {
  const body = escape(abbreviation).replace(/\\\.\s+/g, '\\.\\s?');
  const first = abbreviation.charAt(0);
  const upper = first.toUpperCase();
  return first !== upper ? `[${escape(first)}${escape(upper)}]${body.slice(escape(first).length)}` : body;
}

/**
 * The compiled expansions of each pack, rebuilt when a pack is registered.
 */
const compiled = fromPacks((packs) => {
  /** @type {Map<string, { abbreviations: RegExp | null, words: Map<string, string>, units: RegExp | null, forms: Map<string, [string, string]>, approx: string }>} */
  const byCode = new Map();
  for (const pack of packs) {
    const { abbreviations, units, approx } = pack.gate.spoken;
    const abbreviationKeys = Object.keys(abbreviations).sort((a, b) => b.length - a.length);
    const unitKeys = Object.keys(units).sort((a, b) => b.length - a.length);
    /** @type {Map<string, string>} */
    const words = new Map();
    for (const key of abbreviationKeys) words.set(key.replace(/\s+/g, '').toLowerCase(), abbreviations[key]);
    byCode.set(pack.code, {
      // Not after a letter or digit; after an abbreviation that ends in a letter, no letter or digit either.
      abbreviations: abbreviationKeys.length
        ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${abbreviationKeys.map(abbreviationSource).join('|')})(?:(?<=\\.)|(?![\\p{L}\\p{N}]))`, 'gu')
        : null,
      words,
      // A unit sign right after a number, with or without one space.
      units: unitKeys.length ? new RegExp(`(?<=\\d)( ?)(${unitKeys.map(escape).join('|')})(?:(?<=\\.)|(?![\\p{L}\\p{N}]))`, 'gu') : null,
      forms: new Map(unitKeys.map((k) => [k, units[k]])),
      approx,
    });
  }
  return byCode;
});

/**
 * What the number reader reads in a text, as one comparable string: numbers by their written form
 * and value, claims among the number words, identifiers and joins.
 * @param {string} text
 * @param {string | null} locale
 */
export function numberSignature(text, locale) {
  return scanNumbers(text, { locale })
    .filter((x) => x.type !== 'word' || x.claim)
    .map((x) => {
      if (x.type === 'number') return `n:${x.written}=${x.value}`;
      if (x.type === 'word') return `w:${x.kind}=${x.value}`;
      if (x.type === 'identifier') return `i:${x.raw.toLowerCase()}`;
      return `j:${x.raw}`;
    })
    .join('|');
}

/**
 * Whether the number right before `at` is exactly one ("1 km", but not "21 km", "1.5 km" or "0,1 km").
 * @param {string} text
 * @param {number} at  index right after the number's last digit
 */
function isOne(text, at) {
  return text[at - 1] === '1' && !/[\d.,'’]/.test(text[at - 2] ?? '');
}

/**
 * The spoken form of a canonical text, with how it came about.
 * @param {string} text  a canonical text (canonical.js), such as Released.text
 * @param {{ locale?: string | null }} [options]  the language of the text; guessed when left out
 * @returns {SpokenForm}
 */
export function spokenForm(text, options = {}) {
  const input = String(text ?? '');
  const pack = languagePack(options.locale ?? '') ?? languagePack(guessLanguage(input) ?? '');
  const rules = pack ? compiled().get(pack.code) : undefined;
  if (!pack || !rules || !input) return { text: input, expanded: false, mismatch: false };
  let out = input;
  if (rules.abbreviations) {
    out = out.replace(rules.abbreviations, (match, /** @type {number} */ at, /** @type {string} */ whole) => {
      const words = rules.words.get(match.replace(/\s+/g, '').toLowerCase());
      if (!words) return match;
      // At the start of a sentence a lowercase abbreviation is capitalised, and so are its words.
      const spoken = /^\p{Lu}/u.test(match) && !/^\p{Lu}/u.test(words) ? capitalize(words) : words;
      // The dot of an abbreviation at the end of the text also ended the sentence.
      return match.endsWith('.') && at + match.length === whole.length ? `${spoken}.` : spoken;
    });
  }
  if (rules.units) {
    out = out.replace(rules.units, (match, /** @type {string} */ _space, /** @type {string} */ sign, /** @type {number} */ at, /** @type {string} */ whole) => {
      const forms = rules.forms.get(sign);
      if (!forms) return match;
      const spoken = ` ${isOne(whole, at) ? forms[0] : forms[1]}`;
      return sign.endsWith('.') && at + match.length === whole.length ? `${spoken}.` : spoken;
    });
  }
  if (rules.approx) out = out.replace(/(?<![\p{L}\p{N}~])~ ?(?=\d)/gu, `${rules.approx} `);
  if (out === input) return { text: input, expanded: false, mismatch: false };
  if (numberSignature(out, pack.code) !== numberSignature(input, pack.code)) return { text: input, expanded: false, mismatch: true };
  return { text: out, expanded: true, mismatch: false };
}

/**
 * The text to speak for a canonical text: its abbreviations and units written out, or the text
 * unchanged when an expansion would change a number (see spokenForm).
 * @param {string} text
 * @param {{ locale?: string | null }} [options]
 */
export function spokenText(text, options = {}) {
  return spokenForm(text, options).text;
}
