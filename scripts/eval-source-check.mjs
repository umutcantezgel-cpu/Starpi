#!/usr/bin/env node
// Measures the source check on labelled answers: faithful answers, and answers with exactly one
// planted error (a changed number, date, time, weekday or code; a wrong person; a negation; a value
// attached to the wrong thing). The answers are in tests/fixtures/grounding/eval.json; their
// sources are the sample files in public/samples (chunked here with the app's own code) and the
// sample knowledge-base sections in tests/fixtures/grounding/kb-sample.json.
//
// Usage: node scripts/eval-source-check.mjs [--json]
//
// For a faithful answer, a statement marked "unsupported" is a false alarm. For an answer with an
// error, the statement that contains the wrong value should be marked "unsupported" (caught) or at
// least "weak" (flagged); "supported" means the error was missed. Results are reported per set:
// "dev" was available while the rules were adjusted, "holdout" was written afterwards and only
// measured.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksFromMarkdown, groundAnswer } from '../src/js/core/grounding.js';
import { fold } from '../src/js/core/facts.js';
import { citationLabel } from '../src/js/core/labels.js';
import { chunkText } from '../src/js/rag/chunker.js';
import { extractText } from '../src/js/rag/parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fact categories the check compares directly; the others depend on wording alone. */
export const FACT_CATEGORIES = ['number', 'date', 'time', 'weekday', 'code'];

const SAMPLE_FILES = {
  en: ['nebula-plan.md', 'nebula-risks.csv', 'nebula-kickoff.pdf'],
  de: ['nebula-projektplan.md', 'nebula-risiken.csv', 'nebula-kickoff.pdf'],
};

/**
 * The sources each answer set was written against, as the app would deliver them.
 * @returns {Promise<Record<string, Array<{ label: string, doc: string, heading: string, text: string, delivered: 'full' }>>>}
 */
export async function loadCorpora() {
  /** @type {Record<string, Array<{ label: string, doc: string, heading: string, text: string, delivered: 'full' }>>} */
  const corpora = {};
  for (const [lang, names] of Object.entries(SAMPLE_FILES)) {
    corpora[lang] = [];
    for (const name of names) {
      const bytes = await readFile(path.join(ROOT, 'public/samples', lang, name));
      const { text } = await extractText(new File([bytes], name));
      for (const c of chunkText(text)) corpora[lang].push({ label: citationLabel(name, c.index + 1), doc: name, heading: '', text: c.text, delivered: 'full' });
    }
  }
  const kb = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/grounding/kb-sample.json'), 'utf8'));
  for (const [key, sections] of Object.entries(kb)) {
    corpora[key] = /** @type {Array<{ label: string, doc: string, heading: string, text: string }>} */ (sections).map((s) => ({ ...s, delivered: 'full' }));
  }
  return corpora;
}

/**
 * @param {{ corpus: string, kind: 'faithful' | 'perturbed', category: string, changed: string, answer: string }} item
 * @param {Array<{ label: string, doc: string, heading: string, text: string, delivered: 'full' }>} sources
 */
export function evaluateItem(item, sources) {
  const report = groundAnswer(blocksFromMarkdown(item.answer, sources), sources);
  const checked = report.sentences.filter((s) => s.verdict !== 'neutral');
  if (item.kind === 'faithful') {
    return {
      falseAlarms: checked.filter((s) => s.verdict === 'unsupported').length,
      weak: checked.filter((s) => s.verdict === 'weak').length,
      statements: checked.length,
    };
  }
  const needle = fold(item.changed).replace(/\s+/g, ' ').trim();
  const target = checked.find((s) => fold(s.text).replace(/\s+/g, ' ').includes(needle)) ?? null;
  return { verdict: target ? target.verdict : 'not_found', statements: checked.length };
}

/**
 * @param {Array<any>} items
 * @param {Awaited<ReturnType<typeof loadCorpora>>} corpora
 */
export function summarize(items, corpora) {
  const faithful = { answers: 0, statements: 0, falseAlarms: 0, weak: 0, answersWithFalseAlarm: 0 };
  /** @type {Record<string, { total: number, caught: number, flagged: number, missed: number, notFound: number }>} */
  const byCategory = {};
  for (const item of items) {
    const result = evaluateItem(item, corpora[item.corpus]);
    if (item.kind === 'faithful') {
      faithful.answers += 1;
      faithful.statements += /** @type {number} */ (result.statements);
      faithful.falseAlarms += result.falseAlarms ?? 0;
      faithful.weak += result.weak ?? 0;
      if (result.falseAlarms) faithful.answersWithFalseAlarm += 1;
      continue;
    }
    const c = (byCategory[item.category] ??= { total: 0, caught: 0, flagged: 0, missed: 0, notFound: 0 });
    c.total += 1;
    if (result.verdict === 'unsupported') c.caught += 1;
    else if (result.verdict === 'weak') c.flagged += 1;
    else if (result.verdict === 'not_found') c.notFound += 1;
    else c.missed += 1;
  }
  return { faithful, byCategory };
}

/** The eval items. */
export async function loadItems() {
  const { items } = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/grounding/eval.json'), 'utf8'));
  return /** @type {Array<{ id: string, set: string, corpus: string, kind: 'faithful' | 'perturbed', category: string, changed: string, answer: string }>} */ (items);
}

/** @param {ReturnType<typeof summarize>} summary */
function print(summary) {
  const f = summary.faithful;
  console.log(`Faithful answers: ${f.answers} (${f.statements} statements)`);
  console.log(`  statements wrongly marked unsupported: ${f.falseAlarms} (in ${f.answersWithFalseAlarm} answers)`);
  console.log(`  statements marked weak: ${f.weak}`);
  console.log('Answers with one planted error (caught = unsupported, flagged = weak):');
  const rows = Object.entries(summary.byCategory).sort(([a], [b]) => a.localeCompare(b));
  for (const [category, c] of rows) {
    const kind = FACT_CATEGORIES.includes(category) ? 'fact' : 'meaning';
    console.log(`  ${category.padEnd(9)} (${kind})  ${c.caught}/${c.total} caught, ${c.flagged} flagged, ${c.missed} missed${c.notFound ? `, ${c.notFound} statement not found` : ''}`);
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  const items = await loadItems();
  const corpora = await loadCorpora();
  const sets = [...new Set(items.map((i) => i.set))];
  const results = Object.fromEntries(sets.map((set) => [set, summarize(items.filter((i) => i.set === set), corpora)]));
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  sets.forEach((set, n) => {
    console.log(`${n ? '\n' : ''}== ${set} (${items.filter((i) => i.set === set).length} answers)`);
    print(results[set]);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
