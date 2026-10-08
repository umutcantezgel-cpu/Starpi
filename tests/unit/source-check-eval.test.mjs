// Measures the source check on labelled answers (tests/fixtures/grounding/eval.json, see
// scripts/eval-source-check.mjs) and fails when a rule change makes any published result worse:
// more flagged statements in faithful answers, or fewer planted errors flagged in any category.
// Better results pass; then raise the numbers here and in the README.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FACT_CATEGORIES, loadCorpora, loadItems, summarize } from '../../scripts/eval-source-check.mjs';

/** Results as published in the README ("How well it works"): flagged = unsupported or weak. */
const PUBLISHED = {
  dev: { faithfulWeak: 0, flagged: { number: 16, date: 15, time: 6, weekday: 6, code: 5, entity: 3, relation: 2, negation: 0 } },
  holdout: { faithfulWeak: 15, flagged: { number: 15, date: 16, time: 6, weekday: 6, code: 6, entity: 4, relation: 6, negation: 0 } },
};

/** @type {Record<string, ReturnType<typeof summarize>>} */
const bySet = {};

before(async () => {
  const items = await loadItems();
  const corpora = await loadCorpora();
  for (const set of new Set(items.map((i) => i.set))) bySet[set] = summarize(items.filter((i) => i.set === set), corpora);
});

describe('source check evaluation', () => {
  it('measures both sets', () => {
    assert.deepEqual(Object.keys(bySet).sort(), Object.keys(PUBLISHED).sort());
  });

  it('never marks a statement of a faithful answer unsupported, and flags no more of them as weak', () => {
    for (const [set, s] of Object.entries(bySet)) {
      assert.equal(s.faithful.falseAlarms, 0, `${set}: false alarms`);
      assert.ok(s.faithful.weak <= PUBLISHED[/** @type {'dev' | 'holdout'} */ (set)].faithfulWeak, `${set}: ${s.faithful.weak} faithful statements weak`);
    }
  });

  it('flags at least as many planted errors per category as published', () => {
    for (const [set, s] of Object.entries(bySet)) {
      for (const [category, min] of Object.entries(PUBLISHED[/** @type {'dev' | 'holdout'} */ (set)].flagged)) {
        const c = s.byCategory[category];
        assert.ok(c, `${set}: no ${category} items`);
        assert.ok(c.caught + c.flagged >= min, `${set}: ${category} ${c.caught + c.flagged}/${c.total} flagged, published ${min}`);
      }
      for (const category of ['date', 'time', 'weekday']) {
        const c = s.byCategory[category];
        assert.equal(c.caught, c.total, `${set}: every changed ${category} is unsupported`);
      }
      assert.ok(FACT_CATEGORIES.every((c) => c in s.byCategory));
    }
  });
});
