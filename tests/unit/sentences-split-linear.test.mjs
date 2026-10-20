// sentenceSpans (src/js/core/sentences.js) found the end of a sentence with /[.!?]+(?=\s+\S)/g and
// the token before it with /(\S+)$/, which CodeQL flags as polynomial (js/polynomial-redos): a long
// run of dots, of dots and whitespace, or one long token is rescanned from every position, quadratic
// in its length, and a long run of abbreviations ("1. 1. 1. …") rescanned the whole text before each
// stop. sentenceSpans now scans by hand. Every statement of the source check is split by it, so these
// tests keep the old code and compare both on every string of the unit tests and the eval fixtures,
// on seeded random strings over the alphabet of the expressions, and on long adversarial strings,
// which the new code must also split quickly. Both run with the built-in and the shipped packs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadShippedLanguages } from '../../src/js/core/lang/index.js';
import { isAbbreviation, sentenceSpans, splitSentences } from '../../src/js/core/sentences.js';
import { chunkText } from '../../src/js/rag/chunker.js';
import { extractText } from '../../src/js/rag/parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The clock pattern, as sentences.js has it. */
const OLD_CLOCK_MINUTES = /(?<![\p{L}\p{N}])\d{1,2}\s?h\s?\d{2}$/iu;

/**
 * sentenceSpans before the rewrite, verbatim.
 * @param {string} text
 * @returns {Array<{ start: number, end: number }>}
 */
function oldSentenceSpans(text) {
  /** @type {Array<{ start: number, end: number }>} */
  const out = [];
  const push = (/** @type {number} */ s, /** @type {number} */ e) => {
    while (s < e && /\s/.test(text[s])) s += 1;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    if (e > s) out.push({ start: s, end: e });
  };
  const lines = /[^\n]+/g;
  let line;
  while ((line = lines.exec(text)) !== null) {
    const base = line.index;
    const content = line[0];
    let start = 0;
    const ends = /[.!?]+(?=\s+\S)/g;
    let m;
    while ((m = ends.exec(content)) !== null) {
      const before = content.slice(start, m.index);
      const lastToken = (before.match(/(\S+)$/)?.[1] ?? '').toLowerCase();
      if (m[0] === '.' && isAbbreviation(lastToken) && !OLD_CLOCK_MINUTES.test(before)) continue;
      push(base + start, base + m.index + m[0].length);
      start = m.index + m[0].length;
    }
    push(base + start, base + content.length);
  }
  return out;
}

/**
 * Compares old and new on every input; the first difference fails with the input.
 * @param {Iterable<string>} inputs
 * @returns {{ inputs: number, spans: number }}
 */
function compare(inputs) {
  let count = 0;
  let spans = 0;
  for (const text of inputs) {
    const expected = oldSentenceSpans(text);
    const actual = sentenceSpans(text);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) assert.deepEqual(actual, expected, `input ${JSON.stringify(text.slice(0, 300))}`);
    count += 1;
    spans += actual.length;
  }
  return { inputs: count, spans };
}

/** @type {Record<string, string>} */
const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' };

/**
 * The string literals of a JavaScript source, escapes decoded (template literals as written).
 * @param {string} source
 * @returns {string[]}
 */
function literals(source) {
  const out = [];
  for (const [quoted] of source.matchAll(/'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*"|`(?:[^`\\]|\\[\s\S])*`/g)) {
    out.push(
      quoted.slice(1, -1).replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g, (_, cp, u4, x2, ch) => {
        if (cp) return parseInt(cp, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(cp, 16)) : '';
        if (u4 || x2) return String.fromCharCode(parseInt(u4 ?? x2, 16));
        return ESCAPES[ch] ?? ch;
      }),
    );
  }
  return out;
}

/**
 * Every string value in a parsed JSON document.
 * @param {unknown} value
 * @param {Set<string>} into
 */
function jsonStrings(value, into) {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      jsonStrings(v, into);
    }
  }
}

/**
 * Files below a directory, recursively.
 * @param {string} dir
 * @returns {string[]}
 */
function filesBelow(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesBelow(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/**
 * The strings of the unit tests (literals and whole files), of the fixtures (every JSON string,
 * Markdown-stripped as the synthesizer splits it, and every text fixture) and the sample documents
 * the eval chunks as its sources.
 * @returns {Promise<Set<string>>}
 */
async function fixtureStrings() {
  /** @type {Set<string>} */
  const found = new Set();
  for (const file of filesBelow(path.join(ROOT, 'tests/unit')).filter((f) => /\.m?js$/.test(f))) {
    const source = readFileSync(file, 'utf8');
    found.add(source);
    for (const s of literals(source)) found.add(s);
  }
  for (const file of filesBelow(path.join(ROOT, 'tests/fixtures'))) {
    if (file.endsWith('.json')) jsonStrings(JSON.parse(readFileSync(file, 'utf8')), found);
    else if (/\.(?:sse|mjs|py|jwk|sha256|md|txt|csv)$/.test(file)) found.add(readFileSync(file, 'utf8'));
  }
  for (const file of filesBelow(path.join(ROOT, 'public/samples'))) {
    const bytes = readFileSync(file);
    if (!file.endsWith('.pdf')) found.add(bytes.toString('utf8'));
    const { text } = await extractText(new File([bytes], path.basename(file)));
    found.add(text);
    for (const c of chunkText(text)) found.add(c.text);
  }
  for (const s of [...found]) found.add(s.replace(/[#>*_`]/g, ' '));
  return found;
}

/**
 * A seeded PRNG (mulberry32), so a failure is reproducible.
 * @param {number} seed
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pieces of the alphabet the old expressions and the abbreviation rules react to. */
const PIECES = [
  // stops and runs of them
  '.', '.', '.', '!', '?', '..', '...', '?!', '!!', '.?', '…', '‽', '¿', '¡', '。',
  // whitespace, line breaks and Unicode spaces
  ' ', ' ', ' ', '  ', '   ', '\t', '\n', '\r', '\r\n', '\v', '\f', '\u00A0', '\u202F', '\u2009', '\u2028', '\u2029', '\u3000', '\uFEFF', '\u1680', '\u200B',
  // digits, ordinals, decimals, day and month, times with "h"
  '0', '1', '3', '9', '12', '31', '2026', '4.5', '1.6', '31.8', '8 h 30', '12 h 00', '17h30', '9h', '9 h', 'h', 'H', '00', '7h05', 'x12 h 00', '𝐀9h30', '112h00',
  // words, abbreviations and short month names of the packs
  'a', 'B', 'x', 'Start', 'am', 'März', 'ca', 'Mio', 'EUR', 'z', 'e.g', 'i.e', 'z.B', 'u.a', 'Dr', 'Nr', 'bzw', 'etc', 'vs', 'Aug', 'Jan', 'Sept', 'janv', 'févr',
  'p', 'ex', 'vb', 'Sr', 'Sra', 'pág', 'ecc', 'sig', 'blz', 'Prof', 'Inc', 'St', 'fig', 'tel', 'n°', 'ene', 'dic', 'gen', 'ott',
  // separators, quotes, brackets, letters outside ASCII and astral or lone surrogates
  ',', ';', ':', '-', '–', '(', ')', '[', ']', '"', "'", '„', '“', '”', '»', '«', '/', 'ä', 'ß', 'İ', 'ı', '😀', '𝐀', '\uD835', '\uDC00', 'Ω',
];

/**
 * One random string over the pieces: sometimes long runs, sometimes cut off after a stop.
 * @param {() => number} rand
 */
function randomText(rand) {
  const pick = () => PIECES[Math.floor(rand() * PIECES.length)];
  const length = Math.floor(rand() * 40);
  let text = '';
  for (let i = 0; i < length; i += 1) {
    const piece = pick();
    text += rand() < 0.08 ? piece.repeat(2 + Math.floor(rand() * 12)) : piece;
  }
  const tail = rand();
  if (tail < 0.15) text += '.';
  else if (tail < 0.25) text += '. ';
  else if (tail < 0.3) text += '.\u00A0\u202F';
  else if (tail < 0.35) text += '! x';
  return text;
}

/** Adversarial strings of length about `n`: quadratic for the old expressions, linear for the new code. */
const ADVERSARIAL = {
  'a run of dots': (/** @type {number} */ n) => '.'.repeat(n),
  'a run of dots, then whitespace to the end': (/** @type {number} */ n) => '.'.repeat(n / 2) + ' '.repeat(n / 2),
  'a run of stops, then Unicode spaces to the end': (/** @type {number} */ n) => '!?'.repeat(n / 4) + '\u00A0\u202F\u2009 '.repeat(n / 8),
  'a run of dots inside a word': (/** @type {number} */ n) => `x${'.'.repeat(n - 2)}x`,
  'one long token before a stop': (/** @type {number} */ n) => `${'x'.repeat(n - 4)} . y`,
  'one long token, a no-break space, a stop': (/** @type {number} */ n) => `${'x'.repeat(n - 4)}\u00A0. y`,
  'ordinals that leave the sentence open': (/** @type {number} */ n) => `${'1. '.repeat(Math.floor(n / 3))}x`,
  'abbreviations that leave the sentence open': (/** @type {number} */ n) => `${'z.B. '.repeat(Math.floor(n / 5))}Ende`,
  'short month names and times with "h"': (/** @type {number} */ n) => `${'Aug. 12 h 00. 3. '.repeat(Math.floor(n / 17))}x`,
  'stops and whitespace in blocks': (/** @type {number} */ n) => ('.'.repeat(250) + ' '.repeat(250)).repeat(Math.floor(n / 500)),
  'long lines of whitespace and stops': (/** @type {number} */ n) => `${'. \t'.repeat(Math.floor(n / 6))}\n${' '.repeat(Math.floor(n / 2))}.`,
};

for (const packs of /** @type {const} */ (['built-in', 'shipped'])) {
  describe(`sentenceSpans without polynomial expressions, with the ${packs} language packs`, () => {
    /** @type {Set<string>} */
    let corpus;

    before(async () => {
      if (packs === 'shipped') await loadShippedLanguages();
      // The pack state differs, so the abbreviation rules take other branches in each run.
      assert.equal(isAbbreviation('vb'), packs === 'shipped');
      corpus = await fixtureStrings();
    });

    it('splits every string of the unit tests and the eval fixtures as before', () => {
      const { inputs, spans } = compare(corpus);
      assert.ok(inputs > 5000, `only ${inputs} strings found`);
      assert.ok(spans > 20000, `only ${spans} spans`);
    });

    it('splits the examples of the sentence tests as before', () => {
      const text = 'Start am 3. März. Budget ca. 4.5 Mio. EUR, z. B. für Ads! Fertig?\nNeue Zeile';
      assert.deepEqual(splitSentences(text), ['Start am 3. März.', 'Budget ca. 4.5 Mio. EUR, z. B. für Ads!', 'Fertig?', 'Neue Zeile']);
      compare([
        text,
        'It launches in 2027. Next, e.g. the beta starts Aug. 1 in Hamburg.',
        'Der Pilot läuft vom 1.6. bis 31.8.2026. Danach folgt der Rollout.',
        'Ouvert de 8 h 30 à 12 h 00. La prochaine séance a lieu en mars.',
        'Accueil jusqu’à 17h30. Fermé le lundi.',
        'Die Sitzung ist am 3. März.',
        'El Sr. García llega hoy. Luego sigue.',
        'Elma, armut vb. meyveler var. Sonra devam.',
        'Voir p. ex. la note. Ensuite la suite.',
        'Zie blz. 4 voor details. Daarna volgt meer.',
      ]);
    });

    it('splits 25,000 seeded random strings as before', () => {
      const rand = mulberry32(packs === 'shipped' ? 0x5e7e2 : 0x5e7e1);
      const texts = Array.from({ length: 25000 }, () => randomText(rand));
      const { inputs, spans } = compare(texts);
      assert.equal(inputs, 25000);
      assert.ok(spans > 25000, `only ${spans} spans`);
    });

    it('splits a time with "h" after every kind of character, at every distance from the sentence start, as before', () => {
      // The clock test reads only the end of the text before a stop: these cover the edge of that tail
      // (a letter, digit or astral letter right before the time, the time at the start of the text).
      const fillers = [...Array.from({ length: 22 }, (_, k) => (k ? `${'a'.repeat(k - 1)} ` : '')), 'Ab dem ', 'z.B. z.B. ', '1. 2. 3. 4. 5. 6. ', 'de 8 h 30 à ', '𝐀𝐀𝐀𝐀𝐀𝐀𝐀 '];
      const prefixes = ['', ' ', 'x', 'X', '1', '9', '𝐀', '😀', '\uD835', '\uDC00', 'ä', 'İ', '-', '(', '\u00A0', '\u202F'];
      const clocks = ['12 h 00', '12h00', '9 h 30', '9h30', '12 h00', '12h 00', '123 h 00', '1 h 0', 'h 00', '12 H 00', '12\u00A0h\u2009 00', '12  h 00', '00', '3', '12.5', '1.6'];
      const after = ['. Next', '.', '. ', '! Next', '.. Next', '.\u00A0Next', '. \n'];
      const texts = [];
      for (const f of fillers) for (const p of prefixes) for (const c of clocks) for (const a of after) texts.push(`${f}${p}${c}${a}`);
      assert.equal(compare(texts).inputs, fillers.length * prefixes.length * clocks.length * after.length);
    });

    it('splits adversarial strings as before, at a length the old code still manages', () => {
      for (const make of Object.values(ADVERSARIAL)) {
        for (const n of [6, 7, 50, 500, 2000]) compare([make(n), ` ${make(n)} `, `${make(n)}. Next.`, `Ein Satz. ${make(n)}\nNoch einer.`]);
      }
    });
  });
}

describe('sentenceSpans on long adversarial strings', () => {
  it('splits each of 20,000 to 50,000 units in linear time', () => {
    for (const make of Object.values(ADVERSARIAL)) sentenceSpans(make(2000)); // compile and warm up
    for (const [name, make] of Object.entries(ADVERSARIAL)) {
      for (const n of [20000, 50000]) {
        const text = make(n);
        assert.ok(text.length >= n * 0.9, `${name}: ${text.length} units`);
        const t0 = performance.now();
        const spans = sentenceSpans(text);
        const ms = performance.now() - t0;
        // At most about 10 ms here; the old code took about 0.3 to 1.5 s at 20,000 units. Generous for CI.
        assert.ok(ms < 200, `${name} (${text.length} units): ${ms.toFixed(1)} ms`);
        for (const s of spans) assert.ok(s.start < s.end && s.end <= text.length, name);
      }
    }
  });
});
