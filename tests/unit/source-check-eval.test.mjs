// Measures the source check on labelled answers (tests/fixtures/grounding/eval.json, see
// scripts/eval-source-check.mjs). The thresholds are what the check achieves today, so a rule change
// that makes it worse fails here; the planted errors that depend on meaning (a wrong person, a
// negation, a value attached to the wrong thing) are reported, not required.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FACT_CATEGORIES, loadCorpora, loadItems, summarize } from '../../scripts/eval-source-check.mjs';

/** @type {Record<string, ReturnType<typeof summarize>>} */
const bySet = {};

before(async () => {
  const items = await loadItems();
  const corpora = await loadCorpora();
  for (const set of new Set(items.map((i) => i.set))) bySet[set] = summarize(items.filter((i) => i.set === set), corpora);
});

describe('source check evaluation', () => {
  it('never marks a statement of a faithful answer unsupported', () => {
    for (const [set, s] of Object.entries(bySet)) {
      assert.ok(s.faithful.answers >= 40, `${set}: ${s.faithful.answers} faithful answers`);
      assert.equal(s.faithful.falseAlarms, 0, `${set}: false alarms`);
      assert.ok(s.faithful.weak <= Math.ceil(s.faithful.statements * 0.05), `${set}: ${s.faithful.weak} of ${s.faithful.statements} statements weak`);
    }
  });

  it('flags nearly every changed number, date, time, weekday and code', () => {
    for (const [set, s] of Object.entries(bySet)) {
      const facts = Object.entries(s.byCategory).filter(([c]) => FACT_CATEGORIES.includes(c));
      const total = facts.reduce((n, [, c]) => n + c.total, 0);
      const flagged = facts.reduce((n, [, c]) => n + c.caught + c.flagged, 0);
      assert.ok(total >= 40, `${set}: ${total} fact errors`);
      assert.ok(flagged / total >= 0.9, `${set}: ${flagged}/${total} fact errors flagged`);
      for (const category of ['date', 'time', 'weekday']) {
        const c = s.byCategory[category];
        if (c) assert.equal(c.caught, c.total, `${set}: ${category} ${c.caught}/${c.total}`);
      }
    }
  });
});
