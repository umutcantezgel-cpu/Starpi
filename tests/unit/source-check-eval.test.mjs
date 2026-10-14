// Measures the source check on labelled answers (tests/fixtures/grounding/eval.json,
// eval-v2-*.json and paraphrases.json, see scripts/eval-source-check.mjs) and fails when a rule change makes any
// published result worse: more flagged statements in faithful answers, or fewer planted errors
// flagged in any category. Better results pass; then raise the numbers here and in the README.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FACT_CATEGORIES, loadCorpora, loadItems, loadParaphrases, loadV2Items, summarize } from '../../scripts/eval-source-check.mjs';

/**
 * Results as published in the README ("How well it works"): flagged = unsupported or weak.
 * @type {Record<number, Record<string, { faithfulWeak: number, flagged: Record<string, number> }>>}
 */
const PUBLISHED = {
  1: {
    dev: { faithfulWeak: 0, flagged: { number: 16, date: 15, time: 6, weekday: 6, code: 5, entity: 3, relation: 2, negation: 0 } },
    holdout: { faithfulWeak: 15, flagged: { number: 15, date: 16, time: 6, weekday: 6, code: 6, entity: 4, relation: 6, negation: 0 } },
    paraphrases: { faithfulWeak: 16, flagged: {} },
  },
  // Version 2 as measured once on every set (docs/eval/v2-results.md).
  2: {
    dev: { faithfulWeak: 0, flagged: { number: 15, date: 15, time: 6, weekday: 6, code: 5, entity: 5, relation: 3, negation: 8 } },
    holdout: { faithfulWeak: 16, flagged: { number: 15, date: 16, time: 6, weekday: 6, code: 6, entity: 6, relation: 7, negation: 4 } },
    v2dev: { faithfulWeak: 0, flagged: { entity: 19, relation: 23, negation: 24 } },
    v2holdout: { faithfulWeak: 8, flagged: { entity: 17, relation: 20, negation: 16 } },
    paraphrases: { faithfulWeak: 27, flagged: {} },
  },
};

/** @type {Record<number, Record<string, ReturnType<typeof summarize>>>} */
const measured = { 1: {}, 2: {} };

before(async () => {
  const items = [...(await loadItems()), ...(await loadV2Items({ unblind: true })), ...(await loadParaphrases())];
  const corpora = await loadCorpora();
  for (const version of [1, 2]) {
    for (const set of Object.keys(PUBLISHED[version])) measured[version][set] = summarize(items.filter((i) => i.set === set), corpora, { version });
  }
});

for (const version of [1, 2]) {
  describe(`source check evaluation, rules version ${version}`, () => {
    it('measures every published set', () => {
      for (const set of Object.keys(PUBLISHED[version])) assert.ok(measured[version][set].faithful.answers > 0, `${set}: no faithful answers`);
    });

    it('never marks a statement of a faithful answer unsupported, and flags no more of them as weak', () => {
      for (const [set, s] of Object.entries(measured[version])) {
        assert.equal(s.faithful.falseAlarms, 0, `${set}: false alarms`);
        assert.ok(s.faithful.weak <= PUBLISHED[version][set].faithfulWeak, `${set}: ${s.faithful.weak} faithful statements weak`);
      }
    });

    it('flags at least as many planted errors per category as published', () => {
      for (const [set, s] of Object.entries(measured[version])) {
        for (const [category, min] of Object.entries(PUBLISHED[version][set].flagged)) {
          const c = s.byCategory[category];
          assert.ok(c, `${set}: no ${category} items`);
          assert.ok(c.caught + c.flagged >= min, `${set}: ${category} ${c.caught + c.flagged}/${c.total} flagged, published ${min}`);
        }
        if (set !== 'dev' && set !== 'holdout') continue;
        for (const category of ['date', 'time', 'weekday']) {
          const c = s.byCategory[category];
          assert.equal(c.caught, c.total, `${set}: every changed ${category} is unsupported`);
        }
        assert.ok(FACT_CATEGORIES.every((c) => c in s.byCategory));
      }
    });
  });
}
