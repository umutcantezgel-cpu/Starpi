// The spoken form of released units (src/js/core/spoken.js): abbreviations and units of the
// language written out, never a changed number.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { numberSignature, spokenForm, spokenText } from '../../src/js/core/spoken.js';

describe('spokenText', () => {
  const cases = [
    ['en', 'E.g. it takes ~5 min, i.e. 1 h and 20 GB etc.', 'For example it takes about 5 minutes, that is 1 hour and 20 gigabytes et cetera.'],
    ['en', 'It is 21 km, 1.5 km and 1 km at 30 km/h.', 'It is 21 kilometers, 1.5 kilometers and 1 kilometer at 30 kilometers per hour.'],
    ['en', 'It rose by 35 % to 20 °C.', 'It rose by 35 percent to 20 degrees Celsius.'],
    ['en', 'Dr. Smith vs. Prof. Jones.', 'Doctor Smith versus Professor Jones.'],
    ['de', 'Z. B. kostet es ca. 5 € bzw. 1 kg usw.', 'Zum Beispiel kostet es circa 5 Euro beziehungsweise 1 Kilogramm und so weiter.'],
    ['de', 'Das sind z.B. 5 Mio. Euro in 2 Std.', 'Das sind zum Beispiel 5 Millionen Euro in 2 Stunden.'],
    ['de', 'Der Raum ist 25 m² groß, Nr. 5 laut Abb. 3.', 'Der Raum ist 25 Quadratmeter groß, Nummer 5 laut Abbildung 3.'],
  ];
  for (const [locale, text, spoken] of cases) {
    it(`${locale}: ${text}`, () => assert.equal(spokenText(text, { locale }), spoken));
  }

  it('changes no word that only contains an abbreviation or unit', () => {
    assert.equal(spokenText('The kmh value and minimal etc', { locale: 'en' }), 'The kmh value and minimal etc');
    assert.equal(spokenText('A 5km run in 10min.', { locale: 'en' }), 'A 5 kilometers run in 10 minutes.');
    assert.equal(spokenText('Kilometer 5 km.', { locale: 'en' }), 'Kilometer 5 kilometers.');
  });

  it('guesses the language when none is given, and leaves text it cannot place unchanged', () => {
    assert.equal(spokenText('Das dauert ca. 5 min und ist z. B. kurz.'), 'Das dauert circa 5 Minuten und ist zum Beispiel kurz.');
    assert.equal(spokenText('5 km'), '5 km');
  });

  it('reports whether it expanded', () => {
    assert.deepEqual(spokenForm('It takes 5 min.', { locale: 'en' }), { text: 'It takes 5 minutes.', expanded: true, mismatch: false });
    assert.deepEqual(spokenForm('Nothing to do.', { locale: 'en' }), { text: 'Nothing to do.', expanded: false, mismatch: false });
  });
});

describe('numberSignature', () => {
  it('is the same for a text and its spoken form', () => {
    for (const [text, locale] of [['It is 4.5 million and ~5 km.', 'en'], ['Es sind 5 Mio. und 3 Tsd. Euro.', 'de']]) {
      assert.equal(numberSignature(spokenText(text, { locale }), locale), numberSignature(text, locale));
    }
  });

  it('differs when a number changes', () => {
    assert.notEqual(numberSignature('It is 5 km.', 'en'), numberSignature('It is 6 km.', 'en'));
    assert.notEqual(numberSignature('It is 5 km.', 'en'), numberSignature('It is 5 hundred km.', 'en'));
  });
});
