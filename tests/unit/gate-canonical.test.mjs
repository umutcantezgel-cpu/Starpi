// Canonical text and the character allowlist of the sentence gate (src/js/core/canonical.js): the
// one form of a unit that is judged, shown and spoken, with the input index of every character.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blankRanges, canonicalize, canonicalText, describeChar, firstDisallowed, isAllowedChar } from '../../src/js/core/canonical.js';

describe('canonicalText', () => {
  const cases = [
    ['Markdown emphasis and code', 'The **budget** is _final_ and `480` EUR.', 'The budget is final and 480 EUR.'],
    ['emphasis marks inside words stay', 'Use snake_case and 5*3.', 'Use snake_case and 5*3.'],
    ['list marker and task box', '- [x] Done item', 'Done item'],
    ['numbered list marker', '12. Twelfth item', 'Twelfth item'],
    ['heading marks and section number', '## 2.1. Results ##', 'Results'],
    ['quote marks', '> > Quoted text', 'Quoted text'],
    ['table row', '| Year | Budget |', 'Year; Budget'],
    ['escaped pipe in a cell', '| a \\| b | c |', 'a | b; c'],
    ['strikethrough goes with its text', 'It costs ~~500~~ 480 EUR.', 'It costs 480 EUR.'],
    ['backslash escapes', 'A \\*literal\\* star.', 'A *literal* star.'],
    ['HTML tags and comments', 'Line<br>two <b>bold</b><!-- note --> end.', 'Line two bold end.'],
    ['unclosed comment stays', 'a <!-- b', 'a <!-- b'],
    ['zero-width and bidi characters', 'A​B‮C⁦D﻿E­F', 'ABCDEF'],
    ['variation selector and tag characters', 'Star️ done\u{e0041}', 'Star done'],
    ['minus sign and Unicode hyphens', '−5 and 3‐4', '-5 and 3-4'],
    ['fullwidth letters and digits', 'ＡＢＣ　１２３', 'ABC 123'],
    ['Greek mu and ohm sign', '5 μm and 10 kΩ', '5 µm and 10 kΩ'],
    ['no NFKC: superscripts and fractions stay', 'm² and ½', 'm² and ½'],
    ['NFC composes marks', 'café', 'café'],
    ['white space collapses', '  a \t b\n\nc  ', 'a b c'],
    ['no space before punctuation or after an opening bracket', 'a , b ( c ) [ d ] e .', 'a, b (c) [d] e.'],
    ['a leading decimal keeps its space', 'fell to .5 and ,5', 'fell to .5 and ,5'],
    ['no-break and other spaces', 'a b c　d', 'a b c d'],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => assert.equal(canonicalText(input), expected));
  }

  it('keeps a fenced code block and drops only its fences', () => {
    assert.equal(canonicalText('```js\nconst a = 1;\n```', { kind: 'code' }), 'const a = 1;');
    assert.equal(canonicalText('~~~\nx = *y*\n', { kind: 'code' }), 'x = *y*');
  });

  it('maps every character to its input index', () => {
    const input = '**480** ​EUR';
    const { text, map } = canonicalize(input);
    assert.equal(text, '480 EUR');
    assert.deepEqual([...map], [2, 3, 4, 7, 9, 10, 11]);
    for (let i = 0; i < text.length; i += 1) if (text[i] !== ' ') assert.equal(input[map[i]], text[i]);
  });

  it('maps composed characters to the base character', () => {
    const { text, map } = canonicalize('xéy');
    assert.equal(text, 'xéy');
    assert.deepEqual([...map], [0, 1, 3]);
  });

  it('blanks ranges and collapses white space around them', () => {
    const c = canonicalize('Budget 480 EUR [S1]. Next [S2] part.');
    const ranges = /** @type {Array<[number, number]>} */ ([...c.text.matchAll(/\[S\d\]/g)].map((m) => [/** @type {number} */ (m.index), /** @type {number} */ (m.index) + m[0].length]));
    const blanked = blankRanges(c, ranges);
    assert.equal(blanked.text, 'Budget 480 EUR. Next part.');
    assert.equal(blanked.map[blanked.text.indexOf('Next')], c.map[c.text.indexOf('Next')]);
  });

  it('accepts anything and returns text', () => {
    assert.equal(canonicalText(/** @type {any} */ (null)), '');
    assert.equal(canonicalText(/** @type {any} */ (42)), '42');
  });
});

describe('character allowlist', () => {
  it('allows Latin letters, digits, common signs and the letters of the packs', () => {
    assert.equal(firstDisallowed('Größe: 5 µm, 20 °C, 10 % ± 2, 5 € — „gut“ «bien» ŞğİıÇ ẞ m² cm³ 3×4 © ™ § & @ #'), null);
  });

  it('finds other scripts, digit systems, marks and look-alike signs', () => {
    const cases = [
      ['Привет', 'П'],
      ['٣ items', '٣'],
      ['five ५', '५'],
      ['𝟓 apples', '𝟓'],
      ['x̶', '̶'],
      ['a ½ cup', '½'],
      ['10⁴', '⁴'],
      ['Ⅻ', 'Ⅻ'],
      ['3․5', '․'],
      ['5 · 3', '·'],
      ['日本', '日'],
      ['emoji 🙂', '🙂'],
      ['a{b}', '{'],
    ];
    for (const [text, char] of cases) assert.equal(firstDisallowed(text)?.char, char, text);
  });

  it('describes a character with its code point', () => {
    assert.equal(describeChar('٣'), '٣ U+0663');
    assert.equal(describeChar('🙂'), '🙂 U+1F642');
    assert.equal(isAllowedChar('a'.charCodeAt(0)), true);
    assert.equal(isAllowedChar(0x0430), false);
  });
});
