// The streaming sentence releaser (src/js/core/release.js): sentences, list items, table rows,
// headings and code blocks released whole and in order, the same however the text is split into
// deltas, with partial Markdown, stop and linear time.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSentenceReleaser, TRAILING_LABEL } from '../../src/js/core/release.js';

/**
 * Units of a text streamed in pieces of `size` characters, as [kind, text, closed].
 * @param {string} text
 * @param {number} [size]
 * @param {Parameters<typeof createSentenceReleaser>[0] extends infer O ? Omit<O, 'check'> : never} [options]
 */
function units(text, size = text.length || 1, options = {}) {
  /** @type {import('../../src/js/core/release.js').Unit[]} */
  const out = [];
  const releaser = createSentenceReleaser({ ...options, check: (u) => u });
  for (let i = 0; i < text.length; i += size) out.push(...releaser.push(text.slice(i, i + size)));
  out.push(...releaser.end());
  return out;
}
/** @param {string} text @param {number} [size] */
const brief = (text, size) => units(text, size).map((u) => [u.kind, u.text, u.closed]);

const DOCUMENT = `# Budget review
The plan was approved. It costs 480,000 EUR, e.g. for staff. Done?! Yes.

- First item. Still the first item
  with a continuation line.
- Second item
1. Numbered item

| Year | Amount |
|------|--------|
| 2026 | 480,000 |

\`\`\`js
const total = 480000; // not a sentence. really
\`\`\`
The last sentence [Doc: plan.md, Chunk: 1]. One more [S2].
Trailing text without an end`;

describe('createSentenceReleaser', () => {
  it('releases sentences, items, rows, headings and code blocks as units', () => {
    assert.deepEqual(brief(DOCUMENT), [
      ['heading', '# Budget review', true],
      ['sentence', 'The plan was approved.', true],
      ['sentence', 'It costs 480,000 EUR, e.g. for staff.', true],
      ['sentence', 'Done?!', true],
      ['sentence', 'Yes.', true],
      ['item', '- First item. Still the first item\n  with a continuation line.', true],
      ['item', '- Second item', true],
      ['item', '1. Numbered item', true],
      ['row', '| Year | Amount |', true],
      ['row', '| 2026 | 480,000 |', true],
      ['code', '```js\nconst total = 480000; // not a sentence. really\n```', true],
      ['sentence', 'The last sentence [Doc: plan.md, Chunk: 1].', true],
      ['sentence', 'One more [S2].', true],
      ['sentence', 'Trailing text without an end', false],
    ]);
  });

  it('gives the same units however the text is split', () => {
    const whole = JSON.stringify(units(DOCUMENT));
    for (let size = 1; size <= 24; size += 1) assert.equal(JSON.stringify(units(DOCUMENT, size)), whole, `pieces of ${size}`);
  });

  it('reports offsets and lines in the whole stream', () => {
    const text = 'One. Two.\n\nThree.';
    const out = units(text, 2);
    assert.deepEqual(out.map((u) => [u.text, u.start, u.end, u.line]), [['One.', 0, 4, 1], ['Two.', 5, 9, 1], ['Three.', 11, 17, 3]]);
    for (const u of out) assert.equal(text.slice(u.start, u.end), u.text);
  });

  it('waits for the character after a sentence end', () => {
    const releaser = createSentenceReleaser({ check: (u) => u.text });
    assert.deepEqual(releaser.push('It is 3.'), []);
    assert.deepEqual(releaser.push('5 m long. It'), ['It is 3.5 m long.']);
    assert.deepEqual(releaser.push(' ends.'), []);
    assert.deepEqual(releaser.push('\n'), ['It ends.']);
  });

  it('keeps abbreviations, ordinals and decimals inside the sentence', () => {
    assert.deepEqual(brief('Am 3. März kommt z. B. Dr. Weber. Version 2.5 ist da.').map((u) => u[1]), ['Am 3. März kommt z. B. Dr. Weber.', 'Version 2.5 ist da.']);
    assert.deepEqual(brief('Use e.g. a list, i.e. bullets. Next.').map((u) => u[1]), ['Use e.g. a list, i.e. bullets.', 'Next.']);
  });

  it('ends a sentence after closing quotes and brackets and at an ellipsis', () => {
    assert.deepEqual(brief('He said "done." Then (it ended.) Wait… Go!').map((u) => u[1]), ['He said "done."', 'Then (it ended.)', 'Wait…', 'Go!']);
  });

  it('keeps citation labels after the end with their sentence', () => {
    assert.deepEqual(brief('Alpha. [Doc: a.md, Chunk: 2] Beta. [S1, S2]. Gamma [1]. Delta. [note] Epsilon.').map((u) => u[1]), [
      'Alpha. [Doc: a.md, Chunk: 2]',
      'Beta. [S1, S2].',
      'Gamma [1].',
      'Delta.',
      '[note] Epsilon.',
    ]);
  });

  it('takes a custom test for labels', () => {
    const out = units('Alpha. [web:3] Beta.', undefined, { trailer: { test: (t) => t === '[web:3]' } });
    assert.deepEqual(out.map((u) => u.text), ['Alpha. [web:3]', 'Beta.']);
    assert.ok(TRAILING_LABEL.test('[Doc: x.md, Chunk: 1]') && TRAILING_LABEL.test('[S12]') && !TRAILING_LABEL.test('[note]'));
  });

  it('handles partial Markdown at the end of the stream', () => {
    assert.deepEqual(brief('Text.\n```py\nprint(1)'), [['sentence', 'Text.', true], ['code', '```py\nprint(1)', false]]);
    assert.deepEqual(brief('- open item'), [['item', '- open item', false]]);
    assert.deepEqual(brief('| a | b'), [['row', '| a | b', false]]);
    assert.deepEqual(brief('**bold sentence'), [['sentence', '**bold sentence', false]]);
    assert.deepEqual(brief('#'), [['heading', '#', false]]);
  });

  it('keeps a fence that does not start a line, or a longer fence inside, as text', () => {
    assert.deepEqual(brief('Use ``` for code. Fine.').map((u) => u[1]), ['Use ``` for code.', 'Fine.']);
    assert.deepEqual(brief('````\n```\ninner\n```\n````').map((u) => u[0]), ['code']);
  });

  it('treats Markdown as text with blocks: none', () => {
    assert.deepEqual(
      units('# Title\n- item one. two', undefined, { blocks: 'none' }).map((u) => [u.kind, u.text]),
      [['sentence', '# Title'], ['sentence', '- item one.'], ['sentence', 'two']],
    );
  });

  it('releases only what check returns', () => {
    const releaser = createSentenceReleaser({ check: (u) => (u.text.includes('bad') ? null : u.text.toUpperCase()) });
    assert.deepEqual(releaser.push('Good one. A bad one. Fine '), ['GOOD ONE.']);
    assert.deepEqual(releaser.end(), ['FINE']);
    const falsy = createSentenceReleaser({ check: () => false });
    falsy.push('A. B.');
    assert.deepEqual(falsy.end(), []);
  });

  it('drops open units unjudged on abort and ignores later text', () => {
    /** @type {string[]} */
    const seen = [];
    const releaser = createSentenceReleaser({ check: (u) => (seen.push(u.text), u.text) });
    assert.deepEqual(releaser.push('Done. Half a sent'), ['Done.']);
    assert.deepEqual(releaser.abort(), { dropped: 1 });
    assert.equal(releaser.done, true);
    assert.deepEqual(releaser.push('ence.'), []);
    assert.deepEqual(releaser.end(), []);
    assert.deepEqual(releaser.abort(), { dropped: 0 });
    assert.deepEqual(seen, ['Done.']);
    const fenced = createSentenceReleaser({ check: (u) => u });
    fenced.push('```\ncode\n');
    assert.deepEqual(fenced.abort(), { dropped: 1 });
  });

  it('rejects bad options', () => {
    assert.throws(() => createSentenceReleaser(/** @type {any} */ ({})), TypeError);
    assert.throws(() => createSentenceReleaser(/** @type {any} */ ({ check: () => null, blocks: 'html' })), TypeError);
  });

  it('runs in linear time on long and repetitive lines', () => {
    for (const unit of ['!', 'z. ', 'a [', '3.', '- ', '| ', '``', 'x']) {
      const text = unit.repeat(Math.ceil(80000 / unit.length));
      const t0 = performance.now();
      const releaser = createSentenceReleaser({ check: () => null });
      for (let i = 0; i < text.length; i += 1000) releaser.push(text.slice(i, i + 1000));
      releaser.end();
      assert.ok(performance.now() - t0 < 400, `${JSON.stringify(unit)}: ${performance.now() - t0} ms`);
    }
  });
});
