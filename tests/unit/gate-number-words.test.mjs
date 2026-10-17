// The number reader of the sentence gate (src/js/core/number-words.js): numbers in digits as
// written, number words tagged per language, identifiers that are no numbers, and joins.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { identifierKeys, NUMBER_WORD_KINDS, numberWordTag, scanNumbers, valueKey } from '../../src/js/core/number-words.js';

/**
 * The items of a text as short strings: "n:<written>=<value>", "w:<kind>=<value>[!]" (! for a
 * claim), "i:<raw>", "j:<raw>".
 * @param {string} text
 * @param {import('../../src/js/core/number-words.js').ScanOptions} [options]
 */
const scan = (text, options = { locale: 'en' }) =>
  scanNumbers(text, options).map((x) => {
    if (x.type === 'number') return `n:${x.written}=${x.value}${x.ambiguous ? '?' : ''}`;
    if (x.type === 'word') return `w:${x.raw}:${x.kind}=${Math.round(x.value * 1000) / 1000}${x.claim ? '!' : ''}`;
    if (x.type === 'identifier') return `i:${x.raw}`;
    return `j:${x.raw}`;
  });

describe('numberWordTag', () => {
  const cases = [
    ['twelve', 'en', 'cardinal', 12],
    ['quarter', 'en', 'fraction', 0.25],
    ['twice', 'en', 'multiplier', 2],
    ['tenfold', 'en', 'multiplier', 10],
    ['third', 'en', 'ordinal', 3],
    ['once', 'en', 'adverb', 0],
    ['zwölf', 'de', 'cardinal', 12],
    ['dreihundertfünfundzwanzig', 'de', 'cardinal', 325],
    ['zweitausendvierundzwanzig', 'de', 'cardinal', 2024],
    ['Viertel', 'de', 'fraction', 0.25],
    ['dreifach', 'de', 'multiplier', 3],
    ['zehnmal', 'de', 'multiplier', 10],
    ['zwanzigste', 'de', 'ordinal', 20],
    ['dritte', 'de', 'ordinal', 3],
    ['einmal', 'de', 'adverb', 0],
    ['einfach', 'de', 'adverb', 0],
  ];
  for (const [word, locale, kind, value] of cases) {
    it(`${word} (${locale})`, () => assert.deepEqual(numberWordTag(String(word), String(locale)), { kind, value }));
  }

  it('knows no number in ordinary words', () => {
    for (const word of ['achtung', 'often', 'someone', 'nonetheless', 'beachten', 'done']) assert.equal(numberWordTag(word, word === 'achtung' || word === 'beachten' ? 'de' : 'en'), null, word);
  });

  it('reads every language without a locale', () => {
    assert.deepEqual(numberWordTag('sieben'), { kind: 'cardinal', value: 7 });
    assert.equal(numberWordTag('sieben', 'en'), null);
    assert.deepEqual(NUMBER_WORD_KINDS, ['cardinal', 'fraction', 'multiplier', 'ordinal', 'adverb']);
  });
});

describe('scanNumbers', () => {
  it('reads digits as written, with the value when it does not depend on the convention', () => {
    assert.deepEqual(scan('Values 480, 1.5, 2,5, 480,000, 1.200, 1,234.5, 1.234,5, 1\'000 and 480 000.'), [
      'n:480=480', 'n:1.5=1.5', 'n:2,5=2.5', 'n:480,000=null?', 'n:1.200=null?', 'n:1,234.5=1234.5', 'n:1.234,5=1234.5', "n:1'000=1000", 'n:480 000=480000',
    ]);
  });

  it('keeps dates, times and versions as compound forms', () => {
    assert.deepEqual(scan('On 28.08.2026 at 14:30 with 1.2.3 and 2026-03-02.'), ['n:28.08.2026=null', 'n:14:30=null', 'n:1.2.3=null', 'n:2026-03-02=null']);
  });

  it('reads signs, scales and units', () => {
    assert.deepEqual(scan('minus 5, -3, +2, 4.5 million, 480k, 10kg, 2pm, 3 - 1, 3-5'), [
      'n:-5=-5', 'n:-3=-3', 'n:2=2', 'n:4.5×1000000=4500000', 'n:480×1000=480000', 'n:10=10', 'n:2=2', 'n:3=3', 'n:1=1', 'n:3=3', 'n:5=5',
    ]);
    assert.deepEqual(scan('5 Mio. Euro und 3 Tsd.', { locale: 'de' }), ['n:5×1000000=5000000', 'n:3×1000=3000']);
  });

  it('reads number words in sequences and fractions', () => {
    assert.deepEqual(scan('Two hundred and five people, a third of them, twenty-five more, ninety nine.'), [
      'w:Two hundred and five:cardinal=205!', 'w:a third:fraction=0.333!', 'w:twenty-five:cardinal=25!', 'w:ninety nine:cardinal=99!',
    ]);
    assert.deepEqual(scan('Drei Viertel, zweieinhalb Stunden, eine halbe Stunde, ein Drittel.', { locale: 'de' }), [
      'w:Drei Viertel:fraction=0.75!', 'w:zweieinhalb:cardinal=2.5!', 'w:eine halbe:fraction=0.5!', 'w:ein Drittel:fraction=0.333!',
    ]);
  });

  it('never makes ordinals and adverbs claims', () => {
    assert.deepEqual(scan('Once, first, the third, 3rd, firstly.'), ['w:Once:adverb=0', 'w:first:ordinal=1', 'w:third:ordinal=3', 'w:3rd:ordinal=3', 'w:firstly:adverb=0']);
    assert.deepEqual(scan('Einmal, einfach, die erste, die achte, achten Sie.', { locale: 'de' }), [
      'w:Einmal:adverb=0', 'w:einfach:adverb=0', 'w:erste:ordinal=1', 'w:achte:ordinal=8', 'w:achten:ordinal=8',
    ]);
  });

  it('makes half and double claims only with a unit or count noun within two words', () => {
    assert.deepEqual(scan('half an hour, half of it, double the price, double-check'), [
      'w:half:fraction=0.5!', 'w:half:fraction=0.5', 'w:double:multiplier=2!', 'w:double:multiplier=2',
    ]);
    assert.deepEqual(scan('die halbe Stunde, halb so wild, doppelte Menge, doppelt prüfen', { locale: 'de' }), [
      'w:halbe:fraction=0.5!', 'w:halb:fraction=0.5', 'w:doppelte:multiplier=2!', 'w:doppelt:multiplier=2',
    ]);
    assert.deepEqual(scan('half of it', { locale: 'en', lenient: true }), ['w:half:fraction=0.5!']);
  });

  it('does not count a word that states nothing on its own', () => {
    assert.deepEqual(scan('one of them, the new one'), ['w:one:cardinal=1', 'w:one:cardinal=1']);
    assert.deepEqual(scan('ein Haus, Millionen Menschen', { locale: 'de' }), ['w:ein:cardinal=1', 'w:Millionen:cardinal=1000000']);
  });

  it('reads identifiers as no numbers', () => {
    assert.deepEqual(scan('IPv6, GPT-4o, COVID-19, MP3, A4, ISO 9001, DIN EN ISO 13485, USB-C, H2O'), [
      'i:IPv6', 'i:GPT-4o', 'i:COVID-19', 'i:MP3', 'i:A4', 'i:ISO 9001', 'i:DIN EN ISO 13485', 'i:H2O',
    ]);
  });

  it('reads identifiers the caller names as one token', () => {
    assert.deepEqual(scan('Room B 12 and room 12', { locale: 'en', identifierPatterns: [/\bB \d+/] }), ['i:B 12', 'n:12=12']);
  });

  it('finds numbers a listener would hear as another number', () => {
    assert.deepEqual(scan('4 80, 5OO, l5, 10³, 5 hundred, 5-hundred, twenty 5, 4‚5, .5').filter((x) => x.startsWith('j:')), [
      'j:4 80', 'j:5OO', 'j:l5', 'j:10³', 'j:5 hundred', 'j:5-hundred', 'j:twenty 5', 'j:4‚5', 'j:.5',
    ]);
    assert.deepEqual(scan('20 one of them').filter((x) => x.startsWith('j:')), ['j:20 one']);
    assert.deepEqual(scan('3 one of them, 3-5, 3 – 5').filter((x) => x.startsWith('j:')), []);
  });

  it('marks letters that pass for digits', () => {
    const [item] = scanNumbers('5OO', { locale: 'en' });
    assert.equal(item.type === 'joined' && item.lookalike, true);
  });
});

describe('identifierKeys and valueKey', () => {
  it('lists the runs of a hyphenated identifier that carry letters and digits', () => {
    assert.deepEqual(identifierKeys('COVID-19-related'), ['covid-19-related', 'covid-19', '19-related']);
    assert.deepEqual(identifierKeys('GPT-4o'), ['gpt-4o', '4o']);
    assert.deepEqual(identifierKeys('IPv6'), ['ipv6']);
  });

  it('rounds to six decimals and keeps the sign', () => {
    assert.equal(valueKey(1 / 3), '0.333333');
    assert.equal(valueKey(-5), '-5');
    assert.equal(valueKey(-0), '0');
  });
});
