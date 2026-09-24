import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blocksFromMarkdown, contextCoverage, groundAnswer, resolveLabel, THRESHOLDS } from '../../src/js/core/grounding.js';
import { sentenceSpans, splitSentences } from '../../src/js/core/sentences.js';

const PLAN = 'Project Nebula launches on 12 May 2027. The approved budget is 480,000 EUR. Lena Park leads development of the planner.';
const NOTES = 'The steering group meets every Tuesday at 10:00. Supplier risk for the A320 sensor is rated high.';

/** @param {Partial<{ text: string, delivered: 'full' | 'partial' | 'omitted' }>[]} [overrides] */
function sources(overrides = []) {
  const base = [
    { label: '[Doc: plan.md, Chunk: 1]', doc: 'plan.md', heading: '', text: PLAN, delivered: /** @type {const} */ ('full') },
    { label: '[Doc: notes.md, Chunk: 1]', doc: 'notes.md', heading: '', text: NOTES, delivered: /** @type {const} */ ('full') },
  ];
  return base.map((s, i) => ({ ...s, ...(overrides[i] ?? {}) }));
}

/**
 * @param {string} markdown
 * @param {ReturnType<typeof sources>} [list]
 * @param {{ given?: string[], citedOnly?: boolean }} [options]
 */
function check(markdown, list = sources(), options = {}) {
  return groundAnswer(blocksFromMarkdown(markdown, list), list, options);
}

/** @param {ReturnType<typeof check>} report */
const verdicts = (report) => report.sentences.filter((s) => s.verdict !== 'neutral').map((s) => `${s.verdict}${s.reasons.length ? `:${s.reasons.map((r) => r.code).join('+')}` : ''}`);

describe('sentences', () => {
  it('splits with offsets and keeps ordinals, abbreviations and decimals inside sentences', () => {
    const text = 'Start am 3. März. Budget ca. 4.5 Mio. EUR, z. B. für Ads! Fertig?\nNeue Zeile';
    assert.deepEqual(splitSentences(text), ['Start am 3. März.', 'Budget ca. 4.5 Mio. EUR, z. B. für Ads!', 'Fertig?', 'Neue Zeile']);
    for (const s of sentenceSpans(text)) assert.equal(text.slice(s.start, s.end), text.slice(s.start, s.end).trim());
  });

  it('ends a sentence after a year and keeps e.g. and Aug. inside', () => {
    assert.deepEqual(splitSentences('It launches in 2027. Next, e.g. the beta starts Aug. 1 in Hamburg.'), [
      'It launches in 2027.',
      'Next, e.g. the beta starts Aug. 1 in Hamburg.',
    ]);
  });
});

describe('groundAnswer', () => {
  it('supports statements whose facts and words are in the cited excerpt', () => {
    const r = check('Nebula launches on May 12, 2027 [Doc: plan.md, Chunk: 1]. The budget is 480,000 EUR [Doc: plan.md, Chunk: 1].');
    assert.deepEqual(verdicts(r), ['supported', 'supported']);
    assert.deepEqual(r.counts, { supported: 2, weak: 0, unsupported: 0, unchecked: 0 });
  });

  it('flags a changed number, date, weekday or code and names it', () => {
    const r = check(
      [
        'The budget is 520,000 EUR [Doc: plan.md, Chunk: 1].',
        'Nebula launches on 12 June 2027 [Doc: plan.md, Chunk: 1].',
        'The steering group meets every Friday [Doc: notes.md, Chunk: 1].',
        'The risk concerns the A380 sensor [Doc: notes.md, Chunk: 1].',
      ].join('\n'),
    );
    assert.deepEqual(verdicts(r), ['unsupported:missing_fact', 'unsupported:missing_fact', 'unsupported:missing_fact', 'unsupported:missing_fact']);
    assert.deepEqual(
      r.sentences.map((s) => s.reasons[0].fact),
      ['520,000', '12 June 2027', 'Friday', 'A380'],
    );
  });

  it('attaches a citation placed after the full stop to the sentence before it', () => {
    const r = check('The budget is 480,000 EUR. [Doc: plan.md, Chunk: 1] The group meets every Tuesday. [Doc: notes.md, Chunk: 1]');
    assert.deepEqual(r.sentences.map((s) => [s.cites, s.citeSource]), [
      [[0], 'own'],
      [[1], 'own'],
    ]);
    assert.deepEqual(verdicts(r), ['supported', 'supported']);
  });

  it('inherits citations within a block, from a lead-in and from a sources line', () => {
    const inBlock = check('The budget is 480,000 EUR. Lena Park leads development [Doc: plan.md, Chunk: 1].');
    assert.deepEqual(inBlock.sentences.map((s) => s.citeSource), ['block', 'own']);
    const leadIn = check('According to [Doc: notes.md, Chunk: 1]:\n- The group meets every Tuesday at 10:00.\n- The A320 sensor risk is rated high.');
    assert.deepEqual(leadIn.sentences.filter((s) => s.verdict !== 'neutral').map((s) => [s.citeSource, s.verdict]), [
      ['leadin', 'supported'],
      ['leadin', 'supported'],
    ]);
    const sourcesLine = check('The budget is 480,000 EUR.\n\nSources: [Doc: plan.md, Chunk: 1]');
    assert.deepEqual(sourcesLine.sentences.map((s) => [s.citeSource, s.verdict]), [['answer', 'supported']]);
  });

  it('reports facts found only in another excerpt, or in no excerpt at all', () => {
    const elsewhere = check('The group meets every Tuesday [Doc: plan.md, Chunk: 1].');
    assert.deepEqual(verdicts(elsewhere), ['weak:fact_elsewhere+low_overlap']);
    assert.deepEqual(elsewhere.sentences[0].reasons[0].other, [1]);
    const uncited = check('The budget is 480,000 EUR.\n\nIt was founded in 1999.');
    assert.deepEqual(verdicts(uncited), ['weak:uncited_found', 'unsupported:uncited_missing']);
  });

  it('treats facts from the question as coming from the conversation', () => {
    const r = check('For 2028 the budget is 480,000 EUR [Doc: plan.md, Chunk: 1].', sources(), { given: ['What is the budget for 2028?'] });
    assert.deepEqual(verdicts(r), ['weak:from_conversation']);
  });

  it('reports approximations and rounded figures as approximate, not as errors', () => {
    const r = check('The budget is about 500,000 EUR [Doc: plan.md, Chunk: 1]. It is roughly 0.5 million EUR [Doc: plan.md, Chunk: 1].');
    assert.deepEqual(verdicts(r), ['weak:approximate', 'weak:approximate']);
  });

  it('flags labels that were never given and resolves misspelled ones', () => {
    const r = check('The budget is 480,000 EUR [doc: PLAN.md, chunk 1]. See [Doc: other.pdf, Chunk: 3] for more details.');
    assert.deepEqual(verdicts(r), ['weak:label_mismatch', 'unsupported:unknown_citation']);
  });

  it('flags statements whose excerpt did not reach the model', () => {
    const r = check('The group meets every Tuesday at 10:00 [Doc: notes.md, Chunk: 1].', sources([{}, { delivered: 'omitted', text: '' }]));
    assert.deepEqual(verdicts(r), ['unsupported:not_delivered']);
  });

  it('compares facts only when answer and excerpt are in different languages', () => {
    const de = sources([{ text: 'Das Projekt Nebula startet am 12. Mai 2027, und das Budget ist nicht verhandelbar. Die Entwicklung leitet Lena Park.' }]);
    const r = check('Nebula launches on May 12, 2027, and the team will present the plan to the board [Doc: plan.md, Chunk: 1].', de);
    assert.deepEqual(verdicts(r), ['supported']);
    assert.equal(r.sentences[0].overlap, null);
    assert.equal(r.crossLanguage, true);
  });

  it('counts only cited statements for extractive answers and ignores headings', () => {
    const md = '### From your sources\n\n* **plan.md:** The approved budget is 480,000 EUR. \\[Doc: plan.md, Chunk: 1\\]\n\n_Quoted directly from the sources._';
    const r = check(md, sources(), { citedOnly: true });
    assert.deepEqual(verdicts(r), ['supported']);
  });

  it('skips answers beyond the size limit', () => {
    const r = check('x '.repeat(THRESHOLDS.maxChars));
    assert.equal(r.skipped, 'too_long');
  });
});

describe('contextCoverage', () => {
  const citations = [{ text: 'first excerpt' }, { text: 'second excerpt that is long' }, { text: 'third' }];
  const full = '<<<EXCERPT 1 [Doc: a, Chunk: 1]>>>\nfirst excerpt\n<<<END EXCERPT 1>>>\n\n<<<EXCERPT 2 [Doc: b, Chunk: 1] · Heading>>>\nsecond excerpt that is long\n<<<END EXCERPT 2>>>\n\n<<<EXCERPT 3 [Doc: c, Chunk: 1]>>>\nthird\n<<<END EXCERPT 3>>>';

  it('marks excerpts that reached the model in full', () => {
    assert.deepEqual(contextCoverage(citations, full).map((c) => c.delivered), ['full', 'full', 'full']);
  });

  it('marks cut and missing excerpts', () => {
    const cut = full.slice(0, full.indexOf('that is') + 4) + '…';
    const coverage = contextCoverage(citations, cut);
    assert.deepEqual(coverage.map((c) => c.delivered), ['full', 'partial', 'omitted']);
    assert.equal(coverage[1].text, 'second excerpt that');
  });

  it('marks an excerpt whose text was cut inside closed fences as partial', () => {
    const fenced = '<<<EXCERPT 1 [Doc: a, Chunk: 1]>>>\nfirst excerpt\n<<<END EXCERPT 1>>>\n\n<<<EXCERPT 2 [Doc: b, Chunk: 1]>>>\nsecond excerpt…\n<<<END EXCERPT 2>>>';
    const coverage = contextCoverage(citations, fenced);
    assert.deepEqual(coverage.map((c) => c.delivered), ['full', 'partial', 'omitted']);
    assert.equal(coverage[1].text, 'second excerpt');
  });
});

describe('resolveLabel', () => {
  const list = sources();
  it('matches document names case- and space-insensitively with the chunk number', () => {
    assert.equal(resolveLabel('[doc:  PLAN.md , chunk 1]', list), 0);
    assert.equal(resolveLabel('[Quelle: notes.md]', list), 1);
    assert.equal(resolveLabel('[Doc: plan.md, Chunk: 7]', list), null);
    assert.equal(resolveLabel('[Doc: other.pdf, Chunk: 1]', list), null);
  });
});
