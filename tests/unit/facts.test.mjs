import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentTokens, extractFacts, fold, guessLanguage, indexSource, lookupFact, parseNumber, tokenMatches } from '../../src/js/core/facts.js';

/** @param {string} sentence */
const facts = (sentence) => extractFacts(sentence).map((f) => `${f.kind}:${f.values.join('|')}${f.approx ? '~' : ''}`);

describe('parseNumber', () => {
  it('reads thousands and decimal separators in English and German', () => {
    assert.deepEqual(parseNumber('480,000')?.readings, [480000, 480]);
    assert.deepEqual(parseNumber('480.000')?.readings, [480000, 480]);
    assert.deepEqual(parseNumber('1.234.567')?.readings, [1234567]);
    assert.deepEqual(parseNumber('1.234,56')?.readings, [1234.56]);
    assert.deepEqual(parseNumber('1,234.56')?.readings, [1234.56]);
    assert.deepEqual(parseNumber('1,5')?.readings, [1.5]);
    assert.deepEqual(parseNumber('0.125')?.readings, [0.125]);
    assert.deepEqual(parseNumber('3 100')?.readings, [3100]);
    assert.deepEqual(parseNumber("3'100")?.readings, [3100]);
  });

  it('rejects version-like and malformed runs', () => {
    assert.equal(parseNumber('1.2.3'), null);
    assert.equal(parseNumber('1,,2'), null);
  });
});

describe('extractFacts (claims)', () => {
  it('extracts numbers with scale words, percent and currency, taking the dominant reading', () => {
    assert.deepEqual(facts('The budget is 480,000 EUR.'), ['number:n:480000']);
    assert.deepEqual(facts('Das Budget beträgt 480.000 €.'), ['number:n:480000']);
    assert.deepEqual(facts('It costs €480k and 3,2 Mrd. Euro, up 12.5%.'), ['number:n:480000', 'number:n:3200000000', 'number:n:12.5']);
    assert.deepEqual(facts('Revenue reached $3.2bn.'), ['number:n:3200000000']);
    assert.deepEqual(facts('It costs 480.000,- EUR.'), ['number:n:480000']);
  });

  it('marks approximate numbers', () => {
    assert.deepEqual(facts('It has about 4.5 million users.'), ['number:n:4500000~']);
    assert.deepEqual(facts('Es kostet rund 500.000 €.'), ['number:n:500000~']);
  });

  it('ignores list numbering, single digits without a unit, ordinals and numbers inside labels', () => {
    assert.deepEqual(facts('1. Phase 2 lists 3 risks [Doc: plan.pdf, Chunk: 12].'), []);
    assert.deepEqual(facts('It takes 3 weeks.'), ['number:n:3']);
    assert.deepEqual(facts('The 3rd release.'), []);
  });

  it('reads dates in ISO, German and English forms', () => {
    assert.deepEqual(facts('Kickoff was on 2026-09-14.'), ['date:d:2026-09-14']);
    assert.deepEqual(facts('Kickoff am 14.09.2026.'), ['date:d:2026-09-14']);
    assert.deepEqual(facts('Start am 12. Mai 2027.'), ['date:d:2027-05-12']);
    assert.deepEqual(facts('Launch on May 12, 2027.'), ['date:d:2027-05-12']);
    assert.deepEqual(facts('Launch on 12 May 2027.'), ['date:d:2027-05-12']);
    assert.deepEqual(facts('Launch in August 2027.'), ['date:m:2027-08']);
    assert.deepEqual(facts('Review on 28 August.'), ['date:d:--08-28']);
    assert.deepEqual(facts('Due 03/04/2026.'), ['date:d:2026-03-04|d:2026-04-03']);
  });

  it('reads times, weekdays, months with a preposition and codes', () => {
    assert.deepEqual(facts('The team meets every Friday at 2:30 pm in room A320.'), ['weekday:w:5', 'time:t:14:30', 'code:c:a320']);
    assert.deepEqual(facts('Der Lenkungskreis tagt dienstags um 10:00 Uhr.'), ['weekday:w:2', 'time:t:10:00']);
    assert.deepEqual(facts('The decision is due in June; the team may decide.'), ['month:mo:06']);
    assert.deepEqual(facts('Planned for Q3.'), ['code:c:q3']);
    assert.deepEqual(facts('Risk R-02 and ISO-27001 apply.'), ['code:c:r02', 'code:c:iso27001']);
    assert.deepEqual(facts('Risk R‑03 and R–04 apply.'), ['code:c:r03', 'code:c:r04']);
  });

  it('reads numbers written as words by the same rule as digits', () => {
    assert.deepEqual(facts('The beta has twelve users.'), ['number:n:12']);
    assert.deepEqual(facts('Der Start verschiebt sich um zwei Wochen.'), ['number:n:2']);
    assert.deepEqual(facts('Two of the risks are high.'), []);
    assert.deepEqual(facts('About twenty-five people and two hundred users.'), []);
    assert.deepEqual(facts('Five designers and twelve developers.'), ['number:n:12']);
    assert.deepEqual(facts('The pilot lasts two weeks and fifteen users take part.'), ['number:n:2', 'number:n:15']);
    assert.deepEqual(facts('A hundred and twenty users.'), []);
  });

  it('reads quotations of two or more words', () => {
    assert.deepEqual(facts('He said „das Budget ist freigegeben“.'), ['quote:das budget ist freigegeben']);
    assert.deepEqual(facts('The word "yes" alone.'), []);
  });
});

describe('indexSource and lookupFact', () => {
  const idx = indexSource(
    'Budget: 480000 EUR. Kickoff am 28. August 2026, Treffen freitags 14:30 Uhr in Raum A 320. Marge 15 Prozent. Nutzer: 4.480.000. Das Team hat zwölf Personen.',
  );
  /** @param {string} sentence */
  const found = (sentence) => extractFacts(sentence).map((f) => lookupFact(f, idx).found);

  it('matches facts rewritten between formats and languages', () => {
    assert.deepEqual(found('The budget is 480,000 EUR.'), ['exact']);
    assert.deepEqual(found('Kickoff on August 28, 2026.'), ['exact']);
    assert.deepEqual(found('The team meets on Fridays at 2:30 pm.'), ['exact', 'exact']);
    assert.deepEqual(found('Room A320, margin 15 %.'), ['exact', 'exact']);
    assert.deepEqual(found('The team has 12 people.'), ['exact']);
  });

  it('rejects changed values', () => {
    assert.deepEqual(found('The budget is 520,000 EUR.'), [null]);
    assert.deepEqual(found('Kickoff on 29 August 2026.'), [null]);
    assert.deepEqual(found('They meet on Tuesdays.'), [null]);
    assert.deepEqual(found('Exactly 4.6 million users.'), [null]);
    assert.deepEqual(found('The team has eleven people.'), [null]);
  });

  it('offers the year of a date and the hour of a time as numbers, not the day or month', () => {
    const dates = indexSource('Second supplier under contract by 30.11.2026. Review at 10:30.');
    const lookup = (/** @type {string} */ s) => extractFacts(s).map((f) => lookupFact(f, dates).found);
    assert.deepEqual(lookup('A pilot with 30 drivers.'), [null]);
    assert.deepEqual(lookup('A pilot with 11 drivers.'), [null]);
    assert.deepEqual(lookup('Planned for 2026, with a check at 10 am.'), ['exact', null]);
    assert.deepEqual(lookup('Contracts are due in 2026, reviewed from 10 onwards.'), ['exact', 'exact']);
  });

  it('reads "4.05." at the end of a sentence as a decimal as well as a German date', () => {
    const rate = indexSource('The interest rate is 4.05 % per year. Kickoff: 14.09.');
    const lookup = (/** @type {string} */ s, /** @type {ReturnType<typeof indexSource>} */ idx = rate) => extractFacts(s).map((f) => lookup1(f, idx));
    const lookup1 = (/** @type {any} */ f, /** @type {ReturnType<typeof indexSource>} */ idx) => lookupFact(f, idx).found;
    assert.deepEqual(lookup('The interest rate is 4.05.'), ['exact']);
    assert.deepEqual(lookup('The interest rate is 4.06.'), [null]);
    assert.deepEqual(lookup('Kickoff on 14 September.'), ['exact']);
    assert.deepEqual(lookup('The rate is 4.05 % per year.', indexSource('The interest rate is 4.05.')), ['exact']);
  });

  it('matches codes written with or without a hyphen', () => {
    const codes = indexSource('id: R-02; risk: Drivers reject the new app');
    assert.deepEqual(extractFacts('Risk R02 is medium.').map((f) => lookupFact(f, codes).found), ['exact']);
    assert.deepEqual(extractFacts('Risk R-03 is medium.').map((f) => lookupFact(f, codes).found), [null]);
  });

  it('accepts rounding to the written digits and marked approximations as approximate', () => {
    assert.deepEqual(found('About 4.5 million users.'), ['approx']);
    assert.deepEqual(found('Roughly 470,000 EUR.'), ['approx']);
  });

  it('finds quotations as word sequences, and partial quotations as partial', () => {
    const quotes = indexSource('Der Lenkungskreis hat das Budget am 03.03.2026 freigegeben.');
    const [exact] = extractFacts('„das Budget am 03.03.2026 freigegeben“');
    const [partial] = extractFacts('„hat das Budget am 03.03.2026 heute freigegeben“');
    const [missing] = extractFacts('„die Kosten sind gestiegen“');
    assert.equal(lookupFact(exact, quotes).found, 'exact');
    assert.equal(lookupFact(partial, quotes).found, 'partial');
    assert.equal(lookupFact(missing, quotes).found, null);
  });
});

describe('words and languages', () => {
  it('folds umlauts, ß, soft hyphens, PDF hyphenation and typographic quotes', () => {
    assert.equal(fold('Größe­nordnung Ver-\nkehr „x“ – y'), 'groessenordnung verkehr "x" - y');
  });

  it('keeps content tokens without numbers or source boilerplate', () => {
    assert.deepEqual(contentTokens('According to the document, the budget is 480,000 EUR.'), ['budget', 'eur']);
  });

  it('tolerates inflection and German compounds', () => {
    const idx = indexSource('Die Planungszeiten der Projektbudgets wurden geprüft.');
    for (const token of ['planungszeit', 'projektbudget', 'budgets', 'geprueft']) assert.ok(tokenMatches(token, idx), token);
    assert.ok(!tokenMatches('umsatz', idx));
  });

  it('guesses English and German from function words', () => {
    assert.equal(guessLanguage('The budget was approved by the steering group and it is final.'), 'en');
    assert.equal(guessLanguage('Das Budget wurde vom Lenkungskreis freigegeben und ist nicht verhandelbar.'), 'de');
    assert.equal(guessLanguage('Budget 480000'), null);
    assert.equal(guessLanguage('Das Budget beträgt 480.000 €.'), 'de');
    assert.equal(guessLanguage('The budget'), 'en');
  });
});
