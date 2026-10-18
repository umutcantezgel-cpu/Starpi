// Measures the source check on labelled answers (tests/fixtures/grounding/eval.json,
// eval-v2-*.json, paraphrases.json and relations-*.json, see scripts/eval-source-check.mjs) and fails
// when a rule change makes any published result worse: more flagged statements in faithful answers,
// or fewer planted errors flagged in any category. Better results pass; then raise the numbers here
// and in the README. Version 3 must not be worse than version 2 on any set version 2 was measured on.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FACT_CATEGORIES, loadCorpora, loadItems, loadParaphrases, loadRelationItems, loadV2Items, summarize } from '../../scripts/eval-source-check.mjs';

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
  // Version 3 (relations) as measured once on every set (docs/eval/v3-relations.md): the relation
  // sets were written for it, relholdout frozen before its rules.
  3: {
    dev: { faithfulWeak: 0, flagged: { number: 15, date: 15, time: 6, weekday: 6, code: 5, entity: 5, relation: 3, negation: 8 } },
    holdout: { faithfulWeak: 16, flagged: { number: 15, date: 16, time: 6, weekday: 6, code: 6, entity: 6, relation: 7, negation: 4 } },
    v2dev: { faithfulWeak: 0, flagged: { entity: 19, relation: 24, negation: 24 } },
    v2holdout: { faithfulWeak: 8, flagged: { entity: 17, relation: 20, negation: 16 } },
    paraphrases: { faithfulWeak: 27, flagged: {} },
    relations: { faithfulWeak: 0, flagged: { change: 8, comparative: 8, factor: 5, reference: 4, temporal: 7 } },
    relholdout: { faithfulWeak: 0, flagged: { change: 6, comparative: 7, factor: 3, reference: 4, temporal: 3 } },
  },
};

/** @type {Record<number, Record<string, ReturnType<typeof summarize>>>} */
const measured = { 1: {}, 2: {}, 3: {} };
/** Version 2 on the relation sets, for comparison (not published). @type {Record<string, ReturnType<typeof summarize>>} */
const relationsV2 = {};

before(async () => {
  const items = [...(await loadItems()), ...(await loadV2Items({ unblind: true })), ...(await loadParaphrases()), ...(await loadRelationItems({ unblind: true }))];
  const corpora = await loadCorpora();
  for (const version of [1, 2, 3]) {
    for (const set of Object.keys(PUBLISHED[version])) measured[version][set] = summarize(items.filter((i) => i.set === set), corpora, { version });
  }
  for (const set of ['relations', 'relholdout']) relationsV2[set] = summarize(items.filter((i) => i.set === set), corpora, { version: 2 });
});

describe('source check evaluation, version 3 against version 2', () => {
  it('is no worse than version 2 on any set version 2 was measured on, and better on relations', () => {
    for (const [set, v2] of Object.entries(PUBLISHED[2])) {
      const v3 = PUBLISHED[3][set];
      assert.ok(v3.faithfulWeak <= v2.faithfulWeak, `${set}: faithful weak`);
      for (const [category, n] of Object.entries(v2.flagged)) assert.ok(v3.flagged[category] >= n, `${set}: ${category}`);
    }
    for (const set of ['relations', 'relholdout']) {
      const flagged = (/** @type {ReturnType<typeof summarize>} */ s) => Object.values(s.byCategory).reduce((n, c) => n + c.caught + c.flagged, 0);
      assert.ok(flagged(measured[3][set]) > flagged(relationsV2[set]) * 2, `${set}: version 3 flags ${flagged(measured[3][set])}, version 2 ${flagged(relationsV2[set])}`);
      assert.ok(measured[3][set].faithful.weak <= relationsV2[set].faithful.weak, `${set}: no faithful statement newly weak`);
    }
  });
});

for (const version of [1, 2, 3]) {
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
