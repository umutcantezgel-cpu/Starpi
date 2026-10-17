// Time of the sentence gate on long input: an 80,000-character answer on a single line is judged
// in under 50 ms, streamed or at once, and adversarial lines (runs of digits, brackets, marks,
// abbreviations, look-alike digits, unclosed Markdown) stay linear.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkText, createSentenceGate } from '../../src/js/core/gate.js';

const SOURCES = [
  { label: '[Doc: plan.md, Chunk: 1]', text: 'The approved budget is 480,000 EUR. The team has twelve members and meets twice a week. It is certified to ISO 9001.' },
  { label: '[S2]', text: 'Das Budget beträgt 1.200 Euro. Drei Viertel der Nutzer arbeiten im Büro.' },
];
const LENGTH = 80_000;

/** @param {string} unit */
const line = (unit) => unit.repeat(Math.ceil(LENGTH / unit.length)).slice(0, LENGTH);

/** A realistic answer on one line: cited and uncited sentences, numbers, words, identifiers, emphasis, abbreviations. */
const ANSWER = line(
  'The budget is **480,000 EUR** [Doc: plan.md, Chunk: 1]. The team has 12 members, e.g. for review, and meets twice a week [Doc: plan.md, Chunk: 1]. ' +
    'It is certified to ISO 9001 [Doc: plan.md, Chunk: 1]. Das Budget beträgt z. B. 1.200 Euro [S2]. Drei Viertel der Nutzer arbeiten im Büro [S2]. ' +
    'The first phase took 3 weeks. Once more, see the summary. ',
);

/**
 * The fastest of a few runs, after a warm-up: the time the gate needs, not the time the machine lends it.
 * @param {() => void} run
 */
function fastest(run, rounds = 5) {
  run();
  let best = Infinity;
  for (let i = 0; i < rounds; i += 1) {
    const t0 = performance.now();
    run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('sentence gate time', () => {
  it('judges an 80,000-character line in under 50 ms', () => {
    const result = checkText(ANSWER, { sources: SOURCES, locale: 'en' });
    assert.ok(result.counts.released > 1000 && result.counts.withheld > 100, JSON.stringify(result.counts));
    const ms = fastest(() => checkText(ANSWER, { sources: SOURCES, locale: 'en' }));
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
  });

  it('judges the same line streamed in small deltas in under 50 ms', () => {
    const ms = fastest(() => {
      const gate = createSentenceGate({ sources: SOURCES, locale: 'en' });
      for (let i = 0; i < ANSWER.length; i += 24) gate.push(ANSWER.slice(i, i + 24));
      gate.end();
    });
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
  });

  it('judges a single 80,000-character sentence in under 50 ms', () => {
    const sentence = line('the budget of the team grows with every review and stays within the plan ');
    const ms = fastest(() => checkText(sentence, { sources: SOURCES, locale: 'en' }));
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
  });

  it('stays linear on adversarial lines', () => {
    const shapes = {
      digits: '1 ',
      grouped: '5 000 ',
      lookalike: '5OO ',
      words: 'twenty five hundred ',
      german: 'dreihundertfünfundzwanzigtausend ',
      brackets: '[Doc: a, ',
      labels: '[S2] ',
      bangs: '!',
      abbreviations: 'z. ',
      comments: '<!--',
      tags: '<a ',
      emphasis: '*a_',
      strike: '~~a ',
      marks: 'é',
      invisible: '1​',
      domains: 'a.b.c.',
      standards: 'ISO ',
      pipes: '| a ',
      word: 'x',
    };
    for (const [name, unit] of Object.entries(shapes)) {
      const text = line(unit);
      for (const mode of /** @type {const} */ (['sources', 'web', 'free'])) {
        const ms = fastest(() => checkText(text, { mode, sources: SOURCES, locale: name === 'german' ? 'de' : 'en' }), 1);
        assert.ok(ms < 250, `${name} (${mode}): ${ms.toFixed(1)} ms`);
      }
    }
  });
});
