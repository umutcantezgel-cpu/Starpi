// The adversarial corpus of the sentence gate (tests/fixtures/gate): benign and attack sentences in
// English and German, in sources, free and web mode. Every case is run as one text and streamed in
// pieces of several sizes; both must release and withhold exactly the same units.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkText, createSentenceGate, isReleased } from '../../src/js/core/gate.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/gate');
/** @param {string} name */
const load = (name) => JSON.parse(readFileSync(path.join(DIR, name), 'utf8'));

/** @type {Record<string, { label: string, kind: 'doc' | 'web' | 'note' | 'tool', text: string }>} */
const SOURCES = load('sources.json');
delete SOURCES.$comment;
const sources = Object.values(SOURCES).map((s, index) => ({ ...s, index }));

/**
 * @typedef {object} Case
 * @property {string} name
 * @property {string} text
 * @property {'sources' | 'web' | 'free'} [mode]
 * @property {string} [locale]
 * @property {string} [question]
 * @property {'verbatim' | 'any'} [identifiers]
 * @property {{ segments: Array<{ text: string, sources: number[] }>, sources: Array<{ uri: string, title?: string }> }} [grounding]
 * @property {string[]} released
 * @property {Array<[string, string]>} withheld
 */

/**
 * Gate options for a case; grounded segments given by their text become offsets.
 * @param {Case} c
 * @param {string} locale
 * @returns {import('../../src/js/core/gate.js').GateOptions}
 */
function optionsOf(c, locale) {
  /** @type {import('../../src/js/core/gate.js').GateOptions} */
  const opts = { mode: c.mode ?? 'sources', locale: c.locale ?? locale, sources, identifiers: c.identifiers, question: c.question };
  if (c.grounding) {
    opts.mode = 'web';
    opts.sources = [];
    opts.grounding = {
      sources: c.grounding.sources,
      segments: c.grounding.segments.map((s) => {
        const start = c.text.indexOf(s.text);
        assert.ok(start >= 0, `segment not in the text: ${s.text}`);
        return { start, end: start + s.text.length, sources: s.sources };
      }),
    };
  }
  return opts;
}

/**
 * @param {import('../../src/js/core/gate.js').GateResult} result
 */
const outcome = (result) => ({ released: result.released.map((r) => r.text), withheld: result.withheld.map((w) => [w.reason, w.token]) });

/**
 * @param {string} text
 * @param {import('../../src/js/core/gate.js').GateOptions} opts
 * @param {number} size
 */
function streamed(text, opts, size) {
  const gate = createSentenceGate(opts);
  const released = [];
  for (let i = 0; i < text.length; i += size) released.push(...gate.push(text.slice(i, i + size)));
  const end = gate.end();
  return { ...end, released: [...released, ...end.released] };
}

for (const file of ['corpus-en.json', 'corpus-de.json', 'web.json']) {
  const { locale = 'en', cases } = /** @type {{ locale?: string, cases: Case[] }} */ (load(file));
  describe(`sentence gate corpus: ${file}`, () => {
    for (const c of cases) {
      it(c.name, () => {
        const opts = optionsOf(c, locale);
        const result = checkText(c.text, opts);
        assert.deepEqual(outcome(result), { released: c.released, withheld: c.withheld });
        assert.ok(result.released.every(isReleased));
        assert.equal(result.counts.released, c.released.length);
        assert.equal(result.counts.withheld, c.withheld.length);
        for (const size of [1, 2, 3, 5, 8]) assert.deepEqual(outcome(streamed(c.text, opts, size)), outcome(result), `pieces of ${size}`);
      });
    }
  });
}
