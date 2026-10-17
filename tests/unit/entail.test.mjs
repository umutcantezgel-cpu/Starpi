// The advisory second opinion (core/entail.js): only weak statements are asked about, the model
// reads the passages that share the statement's words, NLI probabilities and judge answers map to
// entailed, neutral or contradicted, and nothing ever makes a verdict better.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { ENTAIL, eligible, judgeResult, nliResult, opinionReason, premiseFor, SECOND_OPINION_REASON, secondOpinions, shownVerdict } from '../../src/js/core/entail.js';

const PLAN = 'Project Nebula launches on 12 May 2027. The approved budget is 480,000 EUR. The steering group meets every Tuesday.';
const SOURCES = [{ label: '[Doc: plan.md, Chunk: 1]', doc: 'plan.md', heading: '', text: PLAN, delivered: /** @type {const} */ ('full') }];
const ANSWER = [
  'Nebula launches on 12 May 2027 [Doc: plan.md, Chunk: 1].',
  'The budget is about 500,000 EUR [Doc: plan.md, Chunk: 1].',
  'The group meets every Friday [Doc: plan.md, Chunk: 1].',
  'The steering group praised the careful planning of the launch team [Doc: plan.md, Chunk: 1].',
].join(' ');

/** @param {import('../../src/js/core/entail.js').OpinionResult | null} answer */
function engine(answer) {
  /** @type {Array<{ premise: string, hypothesis: string }>} */
  const seen = [];
  return {
    seen,
    /** @type {import('../../src/js/core/entail.js').OpinionEngine} */
    engine: {
      id: 'nli',
      model: 'test/model@abc/fp16',
      classify: async (pairs) => {
        seen.push(...pairs);
        return pairs.map(() => answer);
      },
    },
  };
}

describe('second opinion', () => {
  it('asks only about weak statements with a delivered excerpt', async () => {
    const report = groundAnswer(blocksFromMarkdown(ANSWER, SOURCES), SOURCES);
    const verdicts = report.sentences.map((s) => s.verdict);
    assert.deepEqual(verdicts, ['supported', 'weak', 'unsupported', 'weak']);
    assert.deepEqual(report.sentences.map((s) => eligible(s, SOURCES)), [false, true, false, true]);
    assert.equal(eligible(report.sentences[1], [{ ...SOURCES[0], delivered: 'omitted' }]), false);
    const { seen, engine: e } = engine('entailed');
    const opinions = await secondOpinions(report, SOURCES, e);
    assert.deepEqual(seen.map((p) => p.hypothesis), [report.sentences[1].text, report.sentences[3].text]);
    assert.deepEqual(opinions, [
      { sentence: 1, cites: [0], engine: 'nli', model: 'test/model@abc/fp16', result: 'entailed' },
      { sentence: 3, cites: [0], engine: 'nli', model: 'test/model@abc/fp16', result: 'entailed' },
    ]);
    // The report is not changed: an "entailed" leaves every verdict as it was.
    assert.deepEqual(report.sentences.map((s) => s.verdict), verdicts);
    assert.equal(report.secondOpinion, undefined);
  });

  it('never upgrades a verdict, and a contradiction keeps or makes it amber', () => {
    const verdicts = /** @type {const} */ (['supported', 'unchecked', 'weak', 'unsupported']);
    const rank = { supported: 0, unchecked: 1, neutral: 1, weak: 2, unsupported: 3 };
    for (const verdict of verdicts) {
      for (const result of /** @type {const} */ (['entailed', 'neutral', 'contradicted'])) {
        const shown = shownVerdict(verdict, result);
        assert.ok(rank[shown] >= rank[verdict], `${verdict} + ${result} -> ${shown}`);
        if (result !== 'contradicted') assert.equal(shown, verdict);
      }
    }
    assert.equal(shownVerdict('weak', 'contradicted'), 'weak');
    assert.equal(shownVerdict('supported', 'contradicted'), 'weak');
    assert.equal(shownVerdict('unsupported', 'contradicted'), 'unsupported');
  });

  it('adds the advisory reason only for a contradiction', () => {
    const base = { sentence: 1, cites: [0], engine: /** @type {const} */ ('judge'), model: 'p:m' };
    assert.deepEqual(opinionReason({ ...base, result: 'contradicted' }), { code: SECOND_OPINION_REASON, level: 'weak', cites: [0], engine: 'judge' });
    assert.equal(opinionReason({ ...base, result: 'entailed' }), null);
    assert.equal(opinionReason({ ...base, result: 'neutral' }), null);
  });

  it('maps NLI probabilities and judge answers, undecided below the thresholds', () => {
    assert.equal(nliResult({ entailment: 0.85, neutral: 0.05, contradiction: 0.1 }), 'entailed');
    assert.equal(nliResult({ entailment: 0.1, neutral: 0.1, contradiction: 0.8 }), 'contradicted');
    assert.equal(nliResult({ entailment: 0.5, neutral: 0.1, contradiction: 0.4 }), 'neutral');
    assert.equal(nliResult({ entailment: 0.3, neutral: 0.4, contradiction: 0.3 }), 'neutral');
    assert.equal(judgeResult({ verdict: 'contradicted', confidence: 0.9 }), 'contradicted');
    assert.equal(judgeResult({ verdict: 'contradicted', confidence: 0.3 }), 'neutral');
    assert.equal(judgeResult({ verdict: 'supported', confidence: 0.95 }), 'entailed');
    assert.equal(judgeResult({ verdict: 'unknown', confidence: 0.9 }), 'neutral');
    assert.equal(judgeResult({ verdict: 'maybe' }), null);
    assert.equal(judgeResult(null), null);
  });

  it('gives the model the excerpt sentences that share the statement words, in excerpt order and bounded', () => {
    assert.equal(premiseFor('The steering group meets on Fridays.', SOURCES, [0]), 'The steering group meets every Tuesday.');
    const long = [{ ...SOURCES[0], text: `${'The budget review covers every line item of the plan. '.repeat(60)}` }];
    assert.ok(premiseFor('The budget review covers the plan.', long, [0]).length <= ENTAIL.premiseChars);
  });

  it('skips pairs the engine could not decide and stops at the statement limit', async () => {
    const many = Array.from({ length: ENTAIL.maxStatements + 5 }, () => 'The steering group praised the careful planning of the launch team [Doc: plan.md, Chunk: 1].').join(' ');
    const report = groundAnswer(blocksFromMarkdown(many, SOURCES), SOURCES);
    const { seen, engine: e } = engine(null);
    assert.deepEqual(await secondOpinions(report, SOURCES, e), []);
    assert.equal(seen.length, ENTAIL.maxStatements);
  });
});
