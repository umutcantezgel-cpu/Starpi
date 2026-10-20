// findNumbers (src/js/core/facts.js) trimmed trailing separators off a digit run with
// /[.,'’\s]+$/u, which CodeQL flags as polynomial (js/polynomial-redos): when a digit follows a long
// run of separators, the expression retries the run from every position. trimNumberTail replaces it
// with a loop from the end. The source check must not change by a single reading, so these tests keep
// the old expression and compare it with the loop: on every string of the unit tests and the eval
// fixtures, on seeded random strings over the expression's alphabet, and, through a copy of facts.js
// that still uses the old line, on extractFacts and indexSource end to end. Long adversarial runs
// must stay fast.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFacts, indexSource, trimNumberTail } from '../../src/js/core/facts.js';
import { loadShippedLanguages } from '../../src/js/core/lang/index.js';
import { loadCorpora } from '../../scripts/eval-source-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FACTS = path.join(ROOT, 'src/js/core/facts.js');

/** The old trim, as findNumbers had it before trimNumberTail. */
const OLD_TRIM = /[.,'’\s]+$/u;
/** @param {string} s */
const oldTrim = (s) => s.replace(OLD_TRIM, '');

/** The digit runs findNumbers trims (its own expression, copied): the strings that reach the trim. */
const NUMBER_RE = new RegExp(`(?<![\\p{L}\\p{N}])\\d(?:[\\d.,'’\\u00A0\\u202F\\u2009]|\\x20(?=\\d{3}(?![\\p{N}])))*`, 'gu');

const NEW_LINE = 'const blob = trimNumberTail(m[0]);';
const OLD_LINE = `const blob = m[0].replace(${OLD_TRIM}, '');`;

/**
 * Seeded PRNG (mulberry32), so every run checks the same strings.
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

/**
 * Escapes in test sources ('\u202F', '\n') read as the characters the tests pass in.
 * @param {string} source
 */
function unescapeJs(source) {
  return source
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (s, hex) => (Number.parseInt(hex, 16) <= 0x10ffff ? String.fromCodePoint(Number.parseInt(hex, 16)) : s))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([ntrvf])/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', v: '\v', f: '\f' })[/** @type {'n'} */ (c)]);
}

/**
 * Every string value (and key) in parsed JSON.
 * @param {unknown} value
 * @param {Set<string>} out
 */
function collectStrings(value, out) {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectStrings(v, out);
    }
  }
}

/**
 * Files under `dir` (recursive) whose name passes `keep`.
 * @param {string} dir
 * @param {(name: string) => boolean} keep
 * @returns {string[]}
 */
function filesUnder(dir, keep) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && keep(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

/**
 * The strings of the unit tests and the eval fixtures: whole files, test sources with their escapes
 * read, every JSON string, and the eval corpora as the app chunks them.
 * @returns {Promise<string[]>}
 */
async function collectCorpus() {
  /** @type {Set<string>} */
  const texts = new Set();
  for (const file of filesUnder(path.join(ROOT, 'tests/unit'), (n) => n.endsWith('.mjs'))) {
    const raw = readFileSync(file, 'utf8');
    texts.add(raw);
    texts.add(unescapeJs(raw));
  }
  for (const file of filesUnder(path.join(ROOT, 'tests/fixtures'), (n) => n.endsWith('.json') || n.endsWith('.mjs'))) {
    const raw = readFileSync(file, 'utf8');
    texts.add(raw);
    if (file.endsWith('.json')) collectStrings(JSON.parse(raw), texts);
    else texts.add(unescapeJs(raw));
  }
  for (const file of filesUnder(path.join(ROOT, 'public/samples'), (n) => n.endsWith('.md') || n.endsWith('.csv'))) texts.add(readFileSync(file, 'utf8'));
  for (const sections of Object.values(await loadCorpora())) for (const s of sections) texts.add(s.text);
  return [...texts];
}

/**
 * The strings to compare for one text: the text, each line, and each digit run findNumbers trims.
 * @param {string} text
 * @param {Set<string>} out
 * @param {Set<string>} blobs  the digit runs alone
 */
function unitsOf(text, out, blobs) {
  out.add(text);
  for (const line of text.split('\n')) out.add(line);
  for (const m of text.matchAll(NUMBER_RE)) {
    out.add(m[0]);
    blobs.add(m[0]);
  }
}

// Pieces biased to the old expression's alphabet: digits, the separators, the spaces \s covers
// (and some it does not: U+0085, U+180E, U+200B, U+2060), number shapes, letters, units, surrogates.
const PIECES = [
  ...'0123456789',
  '000',
  '480',
  '.',
  ',',
  "'",
  '’',
  '..',
  '.,',
  "'’",
  ' ',
  '  ',
  '\u00A0',
  '\u202F',
  '\u2009',
  '\t',
  '\n',
  '\r',
  '\r\n',
  '\v',
  '\f',
  '\u2028',
  '\u2029',
  '\u3000',
  '\u1680',
  '\u2000',
  '\u2005',
  '\u200A',
  '\u205F',
  '\uFEFF',
  '\u0085',
  '\u180E',
  '\u200B',
  '\u2060',
  '‚',
  '‘',
  '"',
  '-',
  '–',
  ':',
  ';',
  '%',
  '€',
  '$',
  '£',
  'k',
  'm',
  ' Mio.',
  ' EUR',
  ' million',
  'a',
  'x',
  'é',
  'Ü',
  '😀',
  '\uD83D',
  '\uDE00',
  '480.000',
  '480,000',
  '1,5',
  '3 100',
  ' 000',
  '1.234,56',
  "3'100",
  '12.5%',
  'v1.2.3',
  '28.08.2026',
  '10:30',
  'about ',
  'rund ',
];
/** The separators and spaces of the old class, for runs. */
const RUN = ['.', ',', "'", '’', ' ', '\u00A0', '\u202F', '\u2009', '\t', '\n', '\u3000', '\uFEFF', '\u2028'];

/**
 * Seeded strings: random pieces, digit runs with separator runs inside and at the end, and short
 * sentences with numbers.
 * @param {number} count
 * @param {number} seed
 */
function generated(count, seed) {
  const rand = mulberry32(seed);
  /** @param {readonly string[]} list */
  const pick = (list) => list[Math.floor(rand() * list.length)];
  /** @param {number} max */
  const int = (max) => Math.floor(rand() * (max + 1));
  /** @type {string[]} */
  const out = [];
  while (out.length < count) {
    const mode = out.length % 4;
    let s = '';
    if (mode === 0) {
      for (let n = int(30); n > 0; n -= 1) s += pick(PIECES);
    } else if (mode === 1) {
      // digit, separator run, then a digit or the end: the old expression's slow case, in small
      for (let n = 1 + int(4); n > 0; n -= 1) {
        s += String(int(999));
        for (let r = int(8); r > 0; r -= 1) s += pick(RUN);
      }
      if (rand() < 0.5) s += pick(PIECES);
    } else if (mode === 2) {
      // a sentence with numbers, for the end-to-end comparison
      const words = ['The budget is', 'Das Budget beträgt', 'about', 'rund', 'users', 'Nutzer', 'up', 'in', 'EUR', '€', '%', 'million', 'Mrd.', 'km', 'risks', 'phase'];
      for (let n = 2 + int(8); n > 0; n -= 1) s += `${pick(words)} ${rand() < 0.6 ? pick(PIECES.slice(0, 12)) + pick(PIECES) + pick(PIECES) : ''}${pick([' ', '. ', ', ', '\u00A0', ' '])}`;
    } else {
      for (let n = int(12); n > 0; n -= 1) s += rand() < 0.5 ? pick(RUN) : pick(PIECES);
      s = `${int(9)}${s}`;
    }
    out.push(s);
  }
  return out;
}

/**
 * JSON of a facts result that keeps -0, NaN, Infinity and the insertion order of sets and maps.
 * @param {unknown} value
 */
const snapshot = (value) =>
  JSON.stringify(value, (_, v) => {
    if (typeof v === 'number') return `#${Object.is(v, -0) ? '-0' : String(v)}`;
    if (v instanceof Set) return { set: [...v] };
    if (v instanceof Map) return { map: [...v] };
    return v;
  });

/** @type {string} */
let oldDir;
/** @type {typeof import('../../src/js/core/facts.js')} */
let oldFacts;
/** @type {string[]} */
let corpus;

before(async () => {
  // facts.js as it was: the same file with the old trim line, importing the same modules.
  const source = readFileSync(FACTS, 'utf8');
  assert.equal(source.split(NEW_LINE).length, 2, 'findNumbers trims its digit run with trimNumberTail exactly once');
  const old = source
    .replace(NEW_LINE, () => OLD_LINE)
    .replace(/from '(\.\.?\/[^']+)'/g, (_, spec) => `from '${pathToFileURL(path.resolve(path.dirname(FACTS), spec)).href}'`);
  oldDir = mkdtempSync(path.join(tmpdir(), 'starpi-facts-old-'));
  const file = path.join(oldDir, 'facts-old.mjs');
  writeFileSync(file, old);
  oldFacts = await import(pathToFileURL(file).href);
  corpus = await collectCorpus();
});

after(() => {
  if (oldDir) rmSync(oldDir, { recursive: true, force: true });
});

/**
 * Strings where the loop and the old expression disagree.
 * @param {Iterable<string>} strings
 */
function trimMismatches(strings) {
  const bad = [];
  for (const s of strings) if (trimNumberTail(s) !== oldTrim(s)) bad.push(JSON.stringify(s.length > 80 ? `${s.slice(0, 40)}…${s.slice(-40)}` : s));
  return bad;
}

/**
 * Strings where facts.js with the loop and facts.js with the old line read different facts.
 * @param {Iterable<string>} strings
 */
function factsMismatches(strings) {
  const bad = [];
  for (const s of strings) {
    if (snapshot(extractFacts(s)) !== snapshot(oldFacts.extractFacts(s))) bad.push(`extractFacts ${JSON.stringify(s.slice(0, 80))}`);
    if (snapshot(indexSource(s)) !== snapshot(oldFacts.indexSource(s))) bad.push(`indexSource ${JSON.stringify(s.slice(0, 80))}`);
  }
  return bad;
}

/**
 * The corpus strings and lines (up to 4,000 characters) for the end-to-end comparison: every one
 * with a digit run the trim shortens, and every eighth of the others where a digit is followed by a
 * character the trim removes (masking dates and codes can leave such a run behind).
 * @param {string[]} texts
 */
function trimmable(texts) {
  /** @type {Set<string>} */
  const seen = new Set();
  const out = [];
  let other = 0;
  for (const text of texts) {
    for (const s of [text, ...text.split('\n')]) {
      if (s.length > 4000 || seen.has(s) || !/\d[.,'’\s]/u.test(s)) continue;
      seen.add(s);
      if ([...s.matchAll(NUMBER_RE)].some((m) => OLD_TRIM.test(m[0])) || other++ % 8 === 0) out.push(s);
    }
  }
  return out;
}

describe('trimNumberTail', () => {
  it('trims what the old expression trimmed', () => {
    const cases = [
      ['480.000.', '480.000'],
      ['1,5, ', '1,5'],
      ["3'100’", "3'100"],
      ['12\u00A0\u202F\u2009', '12'],
      ['7 .\n', '7'],
      ['7\u3000\uFEFF\u2028', '7'],
      ['7\u0085', '7\u0085'],
      ['7\u200B.', '7\u200B'],
      ['.,', ''],
      ['', ''],
      ['8', '8'],
      ['1.....1', '1.....1'],
      ['😀.', '😀'],
      ['\uD83D.', '\uD83D'],
      ['.\uDE00', '.\uDE00'],
    ];
    for (const [input, want] of cases) {
      assert.equal(oldTrim(input), want, JSON.stringify(input));
      assert.equal(trimNumberTail(input), want, JSON.stringify(input));
    }
  });

  it('agrees with the old expression on every string of the unit tests and eval fixtures', (t) => {
    /** @type {Set<string>} */
    const units = new Set();
    /** @type {Set<string>} */
    const blobs = new Set();
    for (const text of corpus) unitsOf(text, units, blobs);
    // The corpus reaches the trim: digit runs with a trailing separator or space are among them.
    assert.ok(blobs.size > 2000, `digit runs: ${blobs.size}`);
    assert.ok([...blobs].filter((b) => OLD_TRIM.test(b)).length > 100);
    t.diagnostic(`${units.size} strings, ${blobs.size} of them digit runs`);
    assert.deepEqual(trimMismatches(units), []);
  });

  it('agrees with the old expression on 24,000 seeded strings and their digit runs', (t) => {
    /** @type {Set<string>} */
    const units = new Set();
    /** @type {Set<string>} */
    const blobs = new Set();
    const strings = generated(24000, 0x5ea1);
    for (const s of strings) unitsOf(s, units, blobs);
    assert.ok(blobs.size > 10000, `digit runs: ${blobs.size}`);
    assert.ok([...blobs].filter((b) => OLD_TRIM.test(b)).length > 2000);
    t.diagnostic(`${units.size} strings, ${blobs.size} of them digit runs`);
    assert.deepEqual(trimMismatches(units), []);
  });

  it('stays linear on long separator runs that the old expression retries quadratically', (t) => {
    /** @param {number} n */
    const adversarial = (n) => [
      ...['.', ',', "'", '’', '\u00A0', '\u202F', '\u2009'].map((sep) => `1${sep.repeat(n)}1`),
      `1${" .,'’\u00A0\u202F\u2009\t\n".repeat(Math.ceil(n / 10)).slice(0, n)}1`,
      `1${' '.repeat(n)}x`,
      `1${'.'.repeat(n)}`,
      `1${'.'.repeat(n / 2)}1${'.'.repeat(n / 2)}`,
      `${'1.'.repeat(n / 2)}`,
    ];
    let slowest = 0;
    for (const n of [20000, 50000]) {
      for (const s of adversarial(n)) {
        const t0 = performance.now();
        const got = trimNumberTail(s);
        const ms = performance.now() - t0;
        slowest = Math.max(slowest, ms);
        // 50 ms is the target; the bound is generous so a busy CI machine stays green.
        assert.ok(ms < 200, `${s.length} characters took ${ms.toFixed(1)} ms`);
        assert.ok(got.length <= s.length);
      }
    }
    t.diagnostic(`slowest adversarial input (20,000-50,000 characters): ${slowest.toFixed(2)} ms`);
    // The old expression on the same shapes, small enough to finish: same result.
    for (const s of adversarial(2000)) assert.equal(trimNumberTail(s), oldTrim(s));
    const slow = `1${'.'.repeat(4000)}1`;
    const t0 = performance.now();
    oldTrim(slow);
    const t1 = performance.now();
    trimNumberTail(slow);
    t.diagnostic(`4,001 separators: old ${(t1 - t0).toFixed(1)} ms, loop ${(performance.now() - t1).toFixed(2)} ms`);
  });
});

describe('findNumbers with trimNumberTail', () => {
  it('reads the same facts as with the old expression on the unit tests and eval fixtures', (t) => {
    const strings = trimmable(corpus);
    assert.ok(strings.length > 3000, `strings: ${strings.length}`);
    t.diagnostic(`${strings.length} strings through extractFacts and indexSource`);
    assert.deepEqual(factsMismatches(strings), []);
  });

  it('reads the same facts as with the old expression on seeded strings', () => {
    assert.deepEqual(factsMismatches(generated(2000, 0xfac7)), []);
  });

  it('reads the same facts with the shipped language packs loaded', async () => {
    await loadShippedLanguages();
    const strings = trimmable(corpus);
    assert.deepEqual(factsMismatches([...generated(1000, 0x1a96), ...strings.filter((_, i) => i % 4 === 0)]), []);
  });
});
