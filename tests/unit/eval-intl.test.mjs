// The source check in French, Spanish, Italian and Turkish, on the small labelled sets of
// tests/fixtures/grounding/eval-intl.json (sets fr, es, it, tr of the source-check eval): no false
// alarm on a faithful answer, every planted value error (number, date, time, weekday, code) caught,
// and the planted person and negation errors flagged. Plus the rules these sets brought: a sentence
// ends after a time written with "h", and Turkish days and negations with their endings.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { extractFacts } from '../../src/js/core/facts.js';
import { loadShippedLanguages } from '../../src/js/core/lang/index.js';
import { sentenceSpans } from '../../src/js/core/sentences.js';
import { evaluateItem, INTL_SETS, loadCorpora, loadIntlItems } from '../../scripts/eval-source-check.mjs';

/** @type {Awaited<ReturnType<typeof loadCorpora>>} */
let corpora;
/** @type {Awaited<ReturnType<typeof loadIntlItems>>} */
let items;

before(async () => {
  await loadShippedLanguages();
  corpora = await loadCorpora();
  items = await loadIntlItems();
});

describe('the source-check sets in French, Spanish, Italian and Turkish', () => {
  it('hold three faithful answers and seven planted errors per language, each citing its own document', () => {
    for (const set of INTL_SETS) {
      const own = items.filter((i) => i.set === set);
      assert.equal(own.filter((i) => i.kind === 'faithful').length, 3, set);
      assert.deepEqual(own.filter((i) => i.kind === 'perturbed').map((i) => i.category).sort(), ['code', 'date', 'entity', 'negation', 'number', 'time', 'weekday'], set);
      for (const i of own) {
        assert.ok(corpora[i.corpus]?.length, i.id);
        for (const label of i.answer.match(/\[Doc: [^\]]+\]/g) ?? []) assert.ok(corpora[i.corpus].some((s) => s.label === label), `${i.id}: ${label}`);
      }
    }
  });

  for (const set of ['fr', 'es', 'it', 'tr']) {
    it(`${set}: no false alarm, every value error caught, the person and negation errors flagged`, () => {
      for (const item of items.filter((i) => i.set === set)) {
        const result = evaluateItem(item, corpora[item.corpus]);
        if (item.kind === 'faithful') {
          assert.equal(result.falseAlarms, 0, item.id);
          assert.equal(result.statements, 2, `${item.id}: both statements are compared`);
        } else if (['number', 'date', 'time', 'weekday', 'code'].includes(item.category)) {
          assert.equal(result.verdict, 'unsupported', item.id);
        } else {
          assert.ok(result.verdict === 'unsupported' || result.verdict === 'weak', `${item.id}: ${result.verdict}`);
        }
      }
    });
  }
});

describe('rules the sets brought', () => {
  it('ends a sentence after a time written with "h", and keeps an ordinal open', () => {
    const split = (/** @type {string} */ t) => sentenceSpans(t).map((s) => t.slice(s.start, s.end));
    assert.deepEqual(split('Ouvert de 8 h 30 à 12 h 00. La prochaine séance a lieu en mars.'), ['Ouvert de 8 h 30 à 12 h 00.', 'La prochaine séance a lieu en mars.']);
    assert.deepEqual(split('Accueil jusqu’à 17h30. Fermé le lundi.'), ['Accueil jusqu’à 17h30.', 'Fermé le lundi.']);
    assert.deepEqual(split('Die Sitzung ist am 3. März.'), ['Die Sitzung ist am 3. März.'], 'a German ordinal still leaves the sentence open');
  });

  it('reads Turkish weekdays with the endings of a span or a habit', () => {
    const days = (/** @type {string} */ t) => extractFacts(t).filter((f) => f.kind === 'weekday').flatMap((f) => f.values);
    assert.deepEqual(days('Ofis pazartesiden cumaya açıktır.'), days('Ofis pazartesi ve cuma açıktır.'));
    assert.notDeepEqual(days('Ofis salıdan cumaya açıktır.'), days('Ofis pazartesiden cumaya açıktır.'));
    assert.equal(days('Toplantılar salıları yapılır.').length, 1);
  });

  it('reads a Turkish negation with its copula', () => {
    const L = '[Doc: kurallar, Chunk: 1]';
    const sources = [{ label: L, doc: 'kurallar', heading: '', text: 'Gece 23:00’ten sonra yüksek sesle müzik çalmak yasaktır.', delivered: /** @type {const} */ ('full') }];
    const check = (/** @type {string} */ answer) => groundAnswer(blocksFromMarkdown(`${answer} ${L}.`, sources), sources).sentences[0];
    assert.equal(check('Gece 23:00’ten sonra yüksek sesle müzik çalmak yasaktır').verdict, 'supported');
    const flipped = check('Gece 23:00’ten sonra yüksek sesle müzik çalmak yasak değildir');
    assert.notEqual(flipped.verdict, 'supported');
    assert.ok(flipped.reasons.some((r) => r.code === 'negation_inversion'), JSON.stringify(flipped.reasons));
  });
});
