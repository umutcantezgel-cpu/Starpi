// parseLabel (src/js/core/labels.js) read a label with one expression whose lazy name stood between
// optional spaces and an optional chunk part, which CodeQL flags as polynomial (js/polynomial-redos):
// on a long label with a run of spaces the expression retries the run from every position, cubic in
// its length. parseLabel now splits the label by hand. The source check resolves citations through
// it, so these tests keep the old expression and compare both on every string of the unit tests and
// the eval fixtures, on seeded random strings over the label alphabet, on every short combination
// of label pieces, and on long adversarial labels, which the new code must also read quickly.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCorpora } from '../../scripts/eval-source-check.mjs';
import { CITATION_PATTERN, citationLabel, LOOSE_LABEL_PATTERN, parseLabel } from '../../src/js/core/labels.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The old expression, as parseLabel had it before the rewrite. */
const OLD_LABEL = /^\[\s*(?:doc|dok|dokument|document|source|quelle)\s*:\s*(.+?)\s*(?:,\s*(?:chunk|abschnitt|teil|part)\s*:?\s*(\d{1,6}))?\s*\]$/i;

/**
 * parseLabel before the rewrite.
 * @param {string} text
 * @returns {{ doc: string, chunk: number | null } | null}
 */
function oldParseLabel(text) {
  const m = OLD_LABEL.exec(text.trim());
  if (!m) return null;
  return { doc: m[1].replace(/\s+/g, ' ').trim(), chunk: m[2] ? Number(m[2]) : null };
}

/** Every string parseLabel received while the unit tests and both evals ran on the old code. */
const SEEN = [
  '[Doc: Booking rules, Chunk: 1]',
  '[Doc: Q3 draft notes.md, Chunk: 1]',
  '[Doc: answer.md, Chunk: 1]',
  '[Doc: bericht.md, Chunk: 2]',
  '[Doc: bericht.md, Chunk: 3]',
  '[Doc: hall-plan.md, Chunk: 1]',
  '[Doc: invented.pdf, Chunk: 7]',
  '[Doc: nowhere.md, Chunk: 2]',
  '[Doc: other.md, Chunk: 9]',
  '[Doc: other.pdf, Chunk: 1]',
  '[Doc: other.pdf, Chunk: 3]',
  '[Doc: plan.md, Chunk: 1]',
  '[Doc: plan.md, Chunk: 2]',
  '[Doc: plan.md, Chunk: 7]',
  '[Doc: sources.json, Chunk: 1]',
  '[Doc: team.md, Chunk: 1]',
  '[Quelle: notes.md]',
  '[S1]',
  '[S2, T1]',
  '[S2]',
  '[S7]',
  '[T1]',
  '[doc:  PLAN.md , chunk 1]',
  '[doc: PLAN.md, chunk 1]',
  '[doc: Plan.md, chunk 1]',
  '[doc: plan.md, chunk 1]',
  '[doc: q3 draft notes.md, chunk 1]',
  '[draft]',
  '[the plan]',
  '[web:3]',
];

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
 * The texts of the unit tests and the eval fixtures: whole files, test sources with their escapes
 * read, every JSON string, the eval scripts, and the labels of the eval corpora.
 * @returns {Promise<string[]>}
 */
async function collectTexts() {
  /** @type {Set<string>} */
  const texts = new Set(SEEN);
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
  for (const file of filesUnder(path.join(ROOT, 'scripts'), (n) => /^eval.*\.mjs$/.test(n))) texts.add(unescapeJs(readFileSync(file, 'utf8')));
  for (const sections of Object.values(await loadCorpora())) {
    for (const s of sections) {
      texts.add(s.label);
      texts.add(citationLabel(s.doc, 1));
    }
  }
  return [...texts];
}

/**
 * The strings to compare for one text: the text, each line, each citation and loose label in it,
 * and from every "[" the text up to each of the next three "]" (a name may hold a bracket).
 * @param {string} text
 * @param {Set<string>} out
 */
function unitsOf(text, out) {
  out.add(text);
  for (const line of text.split('\n')) out.add(line);
  for (const m of text.matchAll(new RegExp(CITATION_PATTERN))) out.add(m[0]);
  for (const m of text.matchAll(new RegExp(LOOSE_LABEL_PATTERN))) out.add(m[0]);
  for (let open = text.indexOf('['); open >= 0; open = text.indexOf('[', open + 1)) {
    let close = open;
    for (let k = 0; k < 3; k += 1) {
      close = text.indexOf(']', close + 1);
      if (close < 0 || close - open > 600) break;
      out.add(text.slice(open, close + 1));
    }
  }
}

// Pieces biased to the label alphabet: brackets, separators, the spaces \s covers (line breaks
// among them, which the name may not hold) and some it does not (U+0085, U+200B), the keywords in
// mixed case and near misses, digits (and digits \d does not cover), letters that case-fold to
// ASCII only with Unicode rules (ſ, the Kelvin sign, dotless and dotted i), surrogates.
const PIECES = [
  '[',
  ']',
  ',',
  ':',
  ' ',
  '  ',
  '\t',
  '\n',
  '\r',
  '\r\n',
  '\v',
  '\f',
  '\u00A0',
  '\u202F',
  '\u2009',
  '\u2028',
  '\u2029',
  '\u3000',
  '\u1680',
  '\uFEFF',
  '\u0085',
  '\u200B',
  'doc',
  'Doc',
  'DOK',
  'dokument',
  'Document',
  'source',
  'QUELLE',
  'docu',
  'chunk',
  'Chunk',
  'CHUNK',
  'abschnitt',
  'Teil',
  'part',
  'Part',
  'chunks',
  ...'0123456789',
  '12',
  '123456',
  '1234567',
  '\u0663',
  'a',
  'x',
  'Plan',
  '.pdf',
  ' notes.md',
  '-',
  '<<<',
  '>>>',
  'é',
  '\u017F',
  '\u212A',
  '\u0131',
  '\u0130',
  '\uD83D\uDE00',
  '\uD83D',
  '\uDE00',
];
/** Spaces, line breaks among them, for runs. */
const SPACES = [' ', ' ', '\t', '\n', '\r', '\u00A0', '\u202F', '\u2009', '\u2028', '\u3000', '\uFEFF', ''];
const KEYWORDS = ['doc', 'Doc', 'DOC', 'dok', 'Dok', 'dokument', 'Dokument', 'document', 'DOCUMENT', 'source', 'Source', 'quelle', 'Quelle', 'docs', 'D0c', 'd\u212Ak', '\u017Fource', 'sources'];
const CHUNK_WORDS = ['chunk', 'Chunk', 'CHUNK', 'abschnitt', 'Abschnitt', 'teil', 'Teil', 'part', 'Part', 'chunks', 'chnk', '\u212Apart'];

/**
 * Seeded strings: random pieces, label-shaped strings with random bodies, names with commas and
 * a chunk part (well-formed or nearly), and labels with space runs around every part.
 * @param {number} count
 * @param {number} seed
 */
function generated(count, seed) {
  const rand = mulberry32(seed);
  /** @param {readonly string[]} list */
  const pick = (list) => list[Math.floor(rand() * list.length)];
  /** @param {number} max */
  const int = (max) => Math.floor(rand() * (max + 1));
  const spaces = (/** @type {number} */ max) => {
    let s = '';
    for (let n = int(max); n > 0; n -= 1) s += pick(SPACES);
    return s;
  };
  const name = () => {
    let s = '';
    for (let n = int(6); n > 0; n -= 1) s += rand() < 0.3 ? pick(SPACES) : pick(PIECES);
    return s;
  };
  /** @type {string[]} */
  const out = [];
  while (out.length < count) {
    const mode = out.length % 5;
    let s = '';
    if (mode === 0) {
      for (let n = int(24); n > 0; n -= 1) s += pick(PIECES);
    } else if (mode === 1) {
      s = `${spaces(2)}[${spaces(2)}${pick(KEYWORDS)}${spaces(2)}${rand() < 0.9 ? ':' : ''}`;
      for (let n = int(14); n > 0; n -= 1) s += pick(PIECES);
      s += `${rand() < 0.85 ? ']' : ''}${spaces(2)}`;
    } else if (mode === 2) {
      // a name (with commas and chunk words) and a chunk part, well-formed or nearly
      s = `[${pick(KEYWORDS)}:${spaces(2)}${name()}`;
      for (let n = int(2); n > 0; n -= 1) s += `,${spaces(1)}${rand() < 0.5 ? pick(CHUNK_WORDS) : name()}`;
      s += `${spaces(2)}${rand() < 0.9 ? ',' : ''}${spaces(2)}${pick(CHUNK_WORDS)}${spaces(2)}${rand() < 0.5 ? ':' : ''}${spaces(2)}`;
      s += `${'1234567890'.slice(0, int(8))}${rand() < 0.2 ? pick(PIECES) : ''}${spaces(3)}${rand() < 0.95 ? ']' : ''}`;
    } else if (mode === 3) {
      // space runs, line breaks among them, around every part
      s = `${spaces(4)}[${spaces(4)}${pick(KEYWORDS)}${spaces(4)}:${spaces(6)}`;
      if (rand() < 0.7) s += name();
      s += spaces(6);
      if (rand() < 0.6) s += `,${spaces(4)}${pick(CHUNK_WORDS)}${spaces(4)}${rand() < 0.5 ? ':' : ''}${spaces(4)}${int(999999)}`;
      s += `${spaces(6)}]${spaces(4)}`;
    } else {
      s = citationLabel(name(), 1 + int(20));
      if (rand() < 0.5) s = s.toLowerCase().replace('chunk:', pick(['chunk', 'teil:', 'abschnitt', 'part :']));
      if (rand() < 0.3) s = `${spaces(3)}${s.replace(', ', `,${spaces(3)}`)}${spaces(3)}`;
    }
    out.push(s);
  }
  return out;
}

/** The characters . does not match: the line breaks a name may not hold. */
const LINE_BREAK_CODES = [0x0a, 0x0d, 0x2028, 0x2029];

/** Short pieces for the exhaustive check: every sequence of up to five, inside four heads. */
const SHORT = [' ', '\n', '\u00A0', ',', ':', 'chunk', '1', 'a', ']'];
const HEADS = ['[doc:', '[ Doc :', '[doc\n:', ''];

/**
 * Inputs where the new code and the old expression disagree.
 * @param {Iterable<string>} strings
 */
function mismatches(strings) {
  const bad = [];
  for (const s of strings) {
    const got = JSON.stringify(parseLabel(s));
    const want = JSON.stringify(oldParseLabel(s));
    if (got !== want) bad.push(`${JSON.stringify(s.length > 120 ? `${s.slice(0, 60)}…${s.slice(-60)}` : s)}: ${got} instead of ${want}`);
  }
  return bad;
}

/** @type {string[]} */
let texts;

before(async () => {
  texts = await collectTexts();
});

describe('parseLabel without the polynomial expression', () => {
  it('reads labels as the old expression did, edge cases included', () => {
    const cases = [
      ['[Doc: plan.md, Chunk: 2]', { doc: 'plan.md', chunk: 2 }],
      ['  [doc:  PLAN.md , chunk 1]\n', { doc: 'PLAN.md', chunk: 1 }],
      ['[Quelle: notes.md]', { doc: 'notes.md', chunk: null }],
      ['[DOKUMENT : a.pdf , Abschnitt:7]', { doc: 'a.pdf', chunk: 7 }],
      ['[source:a,b, teil 3]', { doc: 'a,b', chunk: 3 }],
      // only the last comma can start the chunk part
      ['[Doc: a, Chunk: 1, Chunk: 2]', { doc: 'a, Chunk: 1', chunk: 2 }],
      ['[Doc: a, Chunk: 1, b]', { doc: 'a, Chunk: 1, b', chunk: null }],
      ['[Doc: a, Chunk: 1234567]', { doc: 'a, Chunk: 1234567', chunk: null }],
      ['[Doc: a, Chunk: 000012]', { doc: 'a', chunk: 12 }],
      ['[Doc: a, Chunk ::1]', { doc: 'a, Chunk ::1', chunk: null }],
      ['[Doc: a]b]', { doc: 'a]b', chunk: null }],
      ['[Doc: a\tb \u00A0 c]', { doc: 'a b c', chunk: null }],
      // a comma right after the colon leaves no name: the chunk part is read as the name
      ['[Doc: , Chunk: 1]', { doc: ', Chunk: 1', chunk: null }],
      // line breaks: around the name and in the chunk part, never in the name
      ['[Doc:\na\n,\nChunk\n:\n4\n]', { doc: 'a', chunk: 4 }],
      ['[Doc: a\nb]', null],
      ['[Doc: a\u2028b, Chunk 1]', null],
      ['[Doc: a\nb, Chunk 1]', null],
      // only spaces: a space that is not a line break stands in as an empty name
      ['[doc: ]', { doc: '', chunk: null }],
      ['[doc:\n]', null],
      ['[doc:]', null],
      ['[Doc: ,\nChunk 1]', { doc: '', chunk: 1 }],
      ['[Doc:,\nChunk 1]', null],
      ['[Doc:\n,\nChunk 1]', null],
      ['[Doc: \n,\nChunk 1]', { doc: '', chunk: 1 }],
      // ASCII case only: ſ and the Kelvin sign do not stand for s and k
      ['[\u017Fource: a]', null],
      ['[do\u212A: a]', null],
      ['[Doc: a, \u212Apart 1]', { doc: 'a, \u212Apart 1', chunk: null }],
      ['[Doc: a, Chunk \u0663]', { doc: 'a, Chunk \u0663', chunk: null }],
      ['[S2, T1]', null],
      ['[web:3]', null],
      ['[Doc: a', null],
      ['Doc: a]', null],
    ];
    for (const [input, want] of cases) {
      assert.deepEqual(oldParseLabel(/** @type {string} */ (input)), want, `old ${JSON.stringify(input)}`);
      assert.deepEqual(parseLabel(/** @type {string} */ (input)), want, `new ${JSON.stringify(input)}`);
    }
  });

  it('relies on trim() removing exactly what \\s matches, and on . missing only the line breaks', () => {
    for (let code = 0; code < 0x10000; code += 1) {
      const ch = String.fromCharCode(code);
      const space = /\s/.test(ch);
      assert.equal(ch.trim() === '' && ch.trimStart() === '' && ch.trimEnd() === '', space, `U+${code.toString(16)}`);
      assert.equal(/./.test(ch), !LINE_BREAK_CODES.includes(code), `U+${code.toString(16)}`);
    }
  });

  it('agrees with the old expression on every string of the unit tests and eval fixtures', (t) => {
    /** @type {Set<string>} */
    const units = new Set();
    for (const text of texts) unitsOf(text, units);
    const labels = [...units].filter((s) => oldParseLabel(s) !== null);
    // The corpus reaches parseLabel: labels with and without a chunk, names with commas.
    assert.ok(labels.length > 500, `labels: ${labels.length}`);
    assert.ok(labels.filter((s) => oldParseLabel(s)?.chunk === null).length > 20);
    assert.ok(labels.filter((s) => oldParseLabel(s)?.doc.includes(',')).length > 5);
    for (const s of SEEN) assert.ok(units.has(s));
    t.diagnostic(`${units.size} strings, ${labels.length} of them labels`);
    assert.deepEqual(mismatches(units), []);
  });

  it('agrees with the old expression on 40,000 seeded strings', (t) => {
    const strings = generated(40000, 0x1abe1);
    const labels = strings.filter((s) => oldParseLabel(s) !== null);
    assert.ok(labels.length > 8000, `labels: ${labels.length}`);
    assert.ok(labels.filter((s) => oldParseLabel(s)?.chunk !== null).length > 3000);
    assert.ok(labels.filter((s) => oldParseLabel(s)?.doc === '').length > 20);
    t.diagnostic(`${strings.length} strings, ${labels.length} of them labels`);
    assert.deepEqual(mismatches(strings), []);
  });

  it('agrees with the old expression on every short combination of label pieces', (t) => {
    /** @type {string[]} */
    const strings = [];
    /**
     * @param {string} body
     * @param {number} depth
     */
    const grow = (body, depth) => {
      for (const head of HEADS) strings.push(`${head}${body}]`, `${head}${body}`);
      if (depth > 0) for (const p of SHORT) grow(body + p, depth - 1);
    };
    grow('', 5);
    t.diagnostic(`${strings.length} strings`);
    assert.deepEqual(mismatches(strings), []);
  });

  it('stays linear on long labels that the old expression retries cubically', (t) => {
    /** @param {number} n */
    const adversarial = (n) => [
      `[Doc: a${' '.repeat(n)}a]`,
      `[Doc: a${' '.repeat(n)}`,
      `[Doc: a${'\u00A0'.repeat(n)}a\u202F]`,
      `[Doc: a${' \t\u00A0\u202F\u2009\n'.repeat(Math.ceil(n / 6)).slice(0, n)}a]`,
      `[Doc: a${' '.repeat(n)}, Chunk${' '.repeat(n)}x]`,
      `[Doc: x, chunk:${' '.repeat(n)}1x]`,
      `[Doc: x, chunk${' '.repeat(n)}:${' '.repeat(n)}1234567]`,
      `[Doc: ${'a '.repeat(n / 2)}]`,
      `[Doc: ${', chunk 1'.repeat(Math.ceil(n / 9))}]`,
      `[Doc: ${','.repeat(n)}]`,
      `[Doc:${' '.repeat(n)}]`,
      `[Doc:${'\n'.repeat(n)}]`,
      `[Doc: a${'\n'.repeat(n)}b]`,
      `[${' '.repeat(n)}doc${' '.repeat(n)}:a]`,
      `${' '.repeat(n)}[Doc: a, Chunk: 1]${' '.repeat(n)}`,
      `[Doc: ${'[Doc: a, Chunk: 1]'.repeat(Math.ceil(n / 18))}`,
      `[Doc: ${'x]'.repeat(n / 2)}`,
    ];
    let slowest = 0;
    const lengths = [];
    for (const n of [20000, 50000]) {
      for (const s of adversarial(n)) {
        const t0 = performance.now();
        parseLabel(s);
        const ms = performance.now() - t0;
        slowest = Math.max(slowest, ms);
        lengths.push(s.length);
        // 50 ms is the target; the bound is generous so a busy CI machine stays green.
        assert.ok(ms < 200, `${JSON.stringify(s.slice(0, 30))}… (${s.length} characters) took ${ms.toFixed(1)} ms`);
      }
    }
    t.diagnostic(`slowest adversarial label (${Math.min(...lengths)}-${Math.max(...lengths)} characters): ${slowest.toFixed(2)} ms`);
    // The old expression on the same shapes, small enough to finish: same result.
    for (const n of [1, 2, 3, 7, 40, 120]) assert.deepEqual(mismatches(adversarial(n)), []);
  });
});
