// The gate part of the language packs (src/js/core/lang): number words, extra characters and
// spoken expansions are checked when a pack is registered, and a registered pack reaches the gate.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstDisallowed } from '../../src/js/core/canonical.js';
import { checkText } from '../../src/js/core/gate.js';
import { languagePack, registerLanguage } from '../../src/js/core/lang/index.js';
import { numberWordTag } from '../../src/js/core/number-words.js';
import { spokenForm } from '../../src/js/core/spoken.js';

describe('gate rules of the built-in packs', () => {
  it('tag the claims and the words that are no claims', () => {
    for (const code of ['en', 'de']) {
      const words = /** @type {import('../../src/js/core/lang/index.js').LanguagePack} */ (languagePack(code)).gate.numberWords;
      assert.ok(Object.keys(words.cardinals).length >= 28, code);
      assert.ok(words.adverbs.length > 0 && words.contextual.length > 0, code);
      for (const w of words.adverbs) assert.equal(numberWordTag(w, code)?.kind, 'adverb', `${code}: ${w}`);
    }
  });

  it('are frozen', () => {
    const pack = /** @type {import('../../src/js/core/lang/index.js').LanguagePack} */ (languagePack('de'));
    assert.ok(Object.isFrozen(pack.gate.numberWords.cardinals) && Object.isFrozen(pack.gate.spoken.units));
  });
});

describe('registerLanguage: gate rules', () => {
  it('rejects malformed gate rules', () => {
    const bad = [
      { gate: { chars: '5' } },
      { gate: { chars: 'a b' } },
      { gate: { chars: '́' } },
      { gate: { numberWords: { cardinals: { Two: 2 } } } },
      { gate: { numberWords: { cardinals: { two: -2 } } } },
      { gate: { numberWords: { cardinals: { t2o: 2 } } } },
      { gate: { numberWords: { fractions: [] } } },
      { gate: { numberWords: { adverbs: ['once more'] } } },
      { gate: { numberWords: { compound: 'yes' } } },
      { gate: { numberWords: { suffixes: { ordinal: ['th3'] } } } },
      { gate: { spoken: { abbreviations: { 'no.': 'number 1' } } } },
      { gate: { spoken: { abbreviations: { 'v2.': 'version' } } } },
      { gate: { spoken: { units: { km: ['kilometre'] } } } },
      { gate: { spoken: { units: { '5m': ['metre', 'metres'] } } } },
      { gate: { spoken: { approx: '~' } } },
    ];
    for (const extra of bad) assert.throws(() => registerLanguage(/** @type {any} */ ({ code: 'xx', ...extra })), TypeError, JSON.stringify(extra));
  });

  it('brings the number words, characters and expansions of a new language to the gate', () => {
    const source = { label: '[S1]', text: 'La urbo havas dudek kvin parkojn. Ni aĉetis 3 dekduojn da ovoj.' };
    const text = 'La urbo havas dudek kvin parkojn [S1]. La urbo havas dudek ses parkojn [S1].';
    // Before: the words are no numbers, so nothing is checked.
    assert.equal(checkText(text, { sources: [source], locale: 'eo' }).released.length, 2);
    assert.ok(firstDisallowed('Ŝə'));
    registerLanguage({
      code: 'eo',
      name: 'Esperanto',
      stopwords: ['la', 'kaj', 'de', 'en', 'ni'],
      abbreviations: ['dk', 'ekz'],
      gate: {
        chars: 'əƏ',
        numberWords: {
          cardinals: { unu: 1, du: 2, tri: 3, kvar: 4, kvin: 5, ses: 6, sep: 7, ok: 8, naŭ: 9, dek: 10, dudek: 20, tridek: 30 },
          scales: { cent: 100, mil: 1000, dekduo: 12, dekduoj: 12, dekduojn: 12 },
          ordinals: { unua: 1, dua: 2, tria: 3 },
          adverbs: ['unufoje'],
        },
        spoken: { abbreviations: { 'dk.': 'dekduo', 'ekz.': 'ekzemple' } },
      },
    });
    const after = checkText(text, { sources: [source], locale: 'eo' });
    assert.deepEqual(after.released.map((r) => r.text), ['La urbo havas dudek kvin parkojn.']);
    assert.deepEqual(after.withheld.map((w) => [w.reason, w.token]), [['number_word', 'dudek ses']]);
    assert.equal(firstDisallowed('Ŝə'), null);
    assert.deepEqual(checkText('Unufoje, la unua.', { mode: 'sources', locale: 'eo' }).released.map((r) => r.text), ['Unufoje, la unua.']);
  });

  it('speaks the canonical text when an expansion would add a number', () => {
    // "3 dk." becomes "3 dekduo": digits next to a number word, which a listener hears as another number.
    assert.deepEqual(spokenForm('Ni aĉetis 3 dk. ovojn, ekz. hodiaŭ.', { locale: 'eo' }), { text: 'Ni aĉetis 3 dk. ovojn, ekz. hodiaŭ.', expanded: false, mismatch: true });
    assert.equal(spokenForm('Ni aĉetis ovojn, ekz. hodiaŭ.', { locale: 'eo' }).text, 'Ni aĉetis ovojn, ekzemple hodiaŭ.');
    const opts = /** @type {const} */ ({ mode: 'free', locale: 'eo' });
    const [unit] = checkText('Ni aĉetis 3 dk. ovojn.', opts).released;
    assert.equal(unit.spoken, 'Ni aĉetis 3 dk. ovojn.');
    assert.equal(checkText('Ni aĉetis 3 dk. ovojn.', opts).counts.spokenFallback, 1);
    assert.deepEqual(checkText('Ni aĉetis 3 dk. ovojn.', { ...opts, spoken: 'strict' }).withheld.map((w) => w.reason), ['spoken_mismatch']);
  });
});
