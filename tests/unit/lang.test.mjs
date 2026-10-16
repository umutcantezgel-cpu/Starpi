// Language packs (src/js/core/lang): the built-in English and German packs feed the source check,
// retrieval and sentence splitting, a pack is checked before it is registered, and a registered pack
// takes part in every check. The golden and eval tests pin that the built-in packs changed nothing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractFacts, guessLanguage } from '../../src/js/core/facts.js';
import { anyOf, fromPacks, LANGUAGES, languagePack, languagePacks, registerLanguage, union } from '../../src/js/core/lang/index.js';
import { canonicalText, negationInversion, sourceClauses } from '../../src/js/core/polarity.js';
import { splitSentences } from '../../src/js/core/sentences.js';
import { STOPWORDS, STOPWORDS_DE, STOPWORDS_EN, tokenize } from '../../src/js/rag/bm25.js';

/** @param {string} text */
const facts = (text) => extractFacts(text).map((f) => `${f.kind} ${f.values.join(',')}`);

/** A small Dutch pack, enough to show that a registered language reaches every module. */
const DUTCH = {
  code: 'nl',
  name: 'Dutch',
  months: { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 },
  monthAbbreviations: { jan: 1, feb: 2, mrt: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 },
  weekdays: { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7 },
  monthContext: ['in', 'op', 'tot', 'vanaf', 'sinds'],
  numberFormat: { decimal: ',', group: '.' },
  scales: [[1e6, ['miljoen']], [1e9, ['miljard']]],
  percentWords: ['procent'],
  unitWords: ['dagen', 'weken', 'medewerkers'],
  numberWords: { twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12, twintig: 20 },
  stopwords: ['de', 'het', 'een', 'en', 'van', 'is', 'niet', 'op', 'met', 'voor', 'dat', 'zijn', 'wordt', 'naar', 'om'],
  abbreviations: ['blz', 'bijv', 'enz'],
  polarity: {
    negators: ['niet', 'geen', 'nooit', 'zonder'],
    plainNegators: ['niet', 'geen', 'nooit'],
    clauseJoiners: ['en', 'of', 'maar'],
    leadingWords: ['en', 'of', 'maar'],
    antonyms: /** @type {Array<[RegExp, string, boolean]>} */ ([[/\buitgeschakeld\b/g, 'ingeschakeld', true]]),
  },
};

const SOURCE = 'De export naar het archief draait elke nacht om middernacht.';
const NEGATED = 'De export naar het archief draait niet elke nacht om middernacht.';

describe('language packs', () => {
  it('registers English and German, found by code or language tag', () => {
    assert.deepEqual([...LANGUAGES], ['en', 'de']);
    assert.deepEqual(languagePacks().map((p) => p.code), ['en', 'de']);
    assert.equal(languagePack('de-AT')?.name, 'German');
    assert.equal(languagePack('EN_gb')?.code, 'en');
    assert.equal(languagePack('fr'), null);
    assert.equal(languagePack(/** @type {any} */ (42)), null);
  });

  it('freezes the packs, their lists and their rules', () => {
    const en = /** @type {import('../../src/js/core/lang/index.js').LanguagePack} */ (languagePack('en'));
    assert.ok(Object.isFrozen(en) && Object.isFrozen(en.stopwords) && Object.isFrozen(en.polarity.negators) && Object.isFrozen(en.months));
    assert.throws(() => /** @type {string[]} */ (en.stopwords).push('x'), TypeError);
  });

  it('gives retrieval the stop words of both packs', () => {
    assert.deepEqual([...STOPWORDS_EN], languagePack('en')?.stopwords);
    assert.deepEqual([...STOPWORDS_DE], languagePack('de')?.stopwords);
    assert.deepEqual(STOPWORDS, new Set(union(languagePacks().map((p) => [...p.stopwords]))));
  });

  it('joins pattern fragments and lists', () => {
    assert.equal(anyOf(['a']), 'a');
    assert.equal(anyOf(['a', 'b']), '(?:a|b)');
    assert.equal(new RegExp(anyOf([])).test(''), false);
    assert.deepEqual(union([['a', 'b'], ['b', 'c'], ['a']]), ['a', 'b', 'c']);
  });

  it('refuses a pack it cannot use, before registering anything', () => {
    const bad = [
      [{ code: 'EN' }, /ISO 639/],
      [{ code: 'english' }, /ISO 639/],
      [{ code: 'en' }, /already registered/],
      [{ code: 'xa', stopwords: 'de het' }, /"stopwords" must be a list/],
      [{ code: 'xa', unitWords: ['(dagen)'] }, /capturing groups/],
      [{ code: 'xa', approxWords: ['ongeveer('] }, /invalid pattern/],
      [{ code: 'xa', months: { mei: 5.5 } }, /whole numbers/],
      [{ code: 'xa', scales: [['miljoen', 1e6]] }, /\[factor, words\]/],
      [{ code: 'xa', meridiem: { am: 'a.m', pm: 'pm' } }, /meridiem/],
      [{ code: 'xa', polarity: { antonyms: [[/\buit\b/, 'aan', true]] } }, /global RegExp/],
      [{ code: 'xa', polarity: { bounds: { negators: [''] } } }, /empty or non-text/],
    ];
    for (const [pack, message] of bad) assert.throws(() => registerLanguage(/** @type {any} */ (pack)), message, JSON.stringify(pack));
    assert.deepEqual([...LANGUAGES], ['en', 'de']);
  });

  it('reads a registered language in every module, and rebuilds what it derived', () => {
    let builds = 0;
    const codes = fromPacks((packs) => {
      builds += 1;
      return packs.map((p) => p.code).join(',');
    });
    assert.equal(codes(), 'en,de');
    assert.equal(codes(), 'en,de');
    // Before: Dutch dates, weekdays, scales, stop words, abbreviations and negations are not read.
    assert.deepEqual(facts('De lancering is op 3 augustus 2026 met twaalf medewerkers.'), ['number n:2026']);
    assert.deepEqual(tokenize('het plan van de afdeling'), ['het', 'plan', 'van', 'de', 'afdeling']);
    assert.deepEqual(splitSentences('Zie blz. 4 voor details. Daarna volgt meer.'), ['Zie blz.', '4 voor details.', 'Daarna volgt meer.']);
    assert.equal(negationInversion(NEGATED, [{ index: 0, clauses: sourceClauses(SOURCE) }]), null);
    assert.equal(guessLanguage(SOURCE), null);

    const pack = registerLanguage(DUTCH);
    assert.equal(pack.name, 'Dutch');
    assert.deepEqual(pack.ordinalSuffixes, [], 'missing lists are empty');
    assert.deepEqual([...LANGUAGES], ['en', 'de', 'nl']);
    assert.equal(languagePack('nl-BE'), pack);
    assert.equal(codes(), 'en,de,nl');
    assert.equal(builds, 2);

    assert.deepEqual(facts('De lancering is op 3 augustus 2026 met twaalf medewerkers.'), facts('The launch is on 3 August 2026 with twelve employees.'));
    assert.deepEqual(facts('Het overleg is op maandag.'), facts('The meeting is on Monday.'));
    assert.deepEqual(facts('Het budget is 4 miljoen euro, 30 procent.'), facts('The budget is 4 million euro, 30 percent.'));
    assert.deepEqual(tokenize('het plan van de afdeling'), ['plan', 'afdeling']);
    assert.deepEqual(splitSentences('Zie blz. 4 voor details. Daarna volgt meer.'), ['Zie blz. 4 voor details.', 'Daarna volgt meer.']);
    assert.deepEqual(negationInversion(NEGATED, [{ index: 0, clauses: sourceClauses(SOURCE) }]), { index: 0, sentence: SOURCE });
    assert.equal(canonicalText('De back-up is uitgeschakeld.'), 'de back-up is notx ingeschakeld.');
    assert.equal(guessLanguage(SOURCE), 'nl');
    // The built-in languages read as before.
    assert.equal(guessLanguage('The budget was approved by the steering group and it is final.'), 'en');
    assert.deepEqual(facts('Am 3. März 2027 um 14 Uhr'), ['date d:2027-03-03', 'time t:14:00']);
  });
});
