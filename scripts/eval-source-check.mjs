#!/usr/bin/env node
// Measures the source check on labelled answers: faithful answers, and answers with exactly one
// planted error (a changed number, date, time, weekday or code; a wrong person; a negation; a value
// attached to the wrong thing). The answers are in tests/fixtures/grounding/eval.json (sets "dev"
// and "holdout", written for 1.2) and eval-v2-dev.json / eval-v2-holdout.json (sets "v2dev" and
// "v2holdout", written for 2.0, see docs/eval/v2-protocol.md); their sources are the sample files in
// public/samples (chunked here with the app's own code), the sample knowledge-base sections in
// kb-sample.json and the technical specifications in sources-v2.json.
//
// Usage: node scripts/eval-source-check.mjs [--sets dev,v2dev] [--grounding 1|2] [--variants] [--json]
//        node scripts/eval-source-check.mjs --unblind [--sets …]   (also the held-out sets)
//
// For a faithful answer, a statement marked "unsupported" is a false alarm. For an answer with an
// error, the statement that contains the wrong value should be marked "unsupported" (caught) or at
// least "weak" (flagged); "supported" means the error was missed. Results are reported per set: the
// dev sets were available while the rules were adjusted; the held-out sets are measured, not used
// to adjust rules, so they are left out unless --unblind is given. The v2 held-out file is checked
// against the SHA-256 that was committed before any v2 rule was written.
import { createHash } from 'node:crypto';
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
  for (const file of ['kb-sample.json', 'sources-v2.json']) {
    const sets = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/grounding', file), 'utf8'));
    for (const [key, sections] of Object.entries(sets)) {
      corpora[key] = /** @type {Array<{ label: string, doc: string, heading: string, text: string }>} */ (sections).map((s) => ({ ...s, delivered: 'full' }));
    }
  }
  return corpora;
}

/**
 * @param {{ corpus: string, kind: 'faithful' | 'perturbed', category: string, changed: string, answer: string }} item
 * @param {Array<{ label: string, doc: string, heading: string, text: string, delivered: 'full' }>} sources
 * @param {{ version?: number }} [options]  the version of the source-check rules (default: current)
 */
export function evaluateItem(item, sources, options = {}) {
  const report = groundAnswer(blocksFromMarkdown(item.answer, sources), sources, options);
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
 * @param {{ version?: number }} [options]
 */
export function summarize(items, corpora, options = {}) {
  const faithful = { answers: 0, statements: 0, falseAlarms: 0, weak: 0, answersWithFalseAlarm: 0 };
  /** @type {Record<string, { total: number, caught: number, flagged: number, missed: number, notFound: number }>} */
  const byCategory = {};
  /** @type {Record<string, { total: number, caught: number, flagged: number, missed: number, notFound: number }>} */
  const byVariant = {};
  for (const item of items) {
    const result = evaluateItem(item, corpora[item.corpus], options);
    if (item.kind === 'faithful') {
      faithful.answers += 1;
      faithful.statements += /** @type {number} */ (result.statements);
      faithful.falseAlarms += result.falseAlarms ?? 0;
      faithful.weak += result.weak ?? 0;
      if (result.falseAlarms) faithful.answersWithFalseAlarm += 1;
      continue;
    }
    for (const c of [(byCategory[item.category] ??= { total: 0, caught: 0, flagged: 0, missed: 0, notFound: 0 }), ...(item.variant ? [(byVariant[`${item.category}/${item.variant}`] ??= { total: 0, caught: 0, flagged: 0, missed: 0, notFound: 0 })] : [])]) {
      c.total += 1;
      if (result.verdict === 'unsupported') c.caught += 1;
      else if (result.verdict === 'weak') c.flagged += 1;
      else if (result.verdict === 'not_found') c.notFound += 1;
      else c.missed += 1;
    }
  }
  return { faithful, byCategory, byVariant };
}

/** @typedef {{ id: string, set: string, corpus: string, kind: 'faithful' | 'perturbed', category: string, variant?: string, changed: string, answer: string }} EvalItem */

/** The eval items written for 1.2 (sets dev and holdout). */
export async function loadItems() {
  const { items } = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/grounding/eval.json'), 'utf8'));
  return /** @type {EvalItem[]} */ (items);
}

/** Held-out sets: measured, never used to adjust rules. */
export const HELD_OUT = Object.freeze(['holdout', 'v2holdout']);

/**
 * The eval items written for 2.0: set v2dev, and with `unblind` also v2holdout, after checking the
 * held-out file against the SHA-256 committed before the v2 rules were written.
 * @param {{ unblind?: boolean }} [options]
 */
export async function loadV2Items(options = {}) {
  const dir = path.join(ROOT, 'tests/fixtures/grounding');
  const { items } = JSON.parse(await readFile(path.join(dir, 'eval-v2-dev.json'), 'utf8'));
  if (!options.unblind) return /** @type {EvalItem[]} */ (items);
  const bytes = await readFile(path.join(dir, 'eval-v2-holdout.json'));
  const frozen = (await readFile(path.join(dir, 'eval-v2-holdout.sha256'), 'utf8')).split(/\s+/)[0];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== frozen) throw new Error(`eval-v2-holdout.json changed after it was frozen: SHA-256 ${actual}, frozen ${frozen}`);
  return /** @type {EvalItem[]} */ ([...items, ...JSON.parse(bytes.toString('utf8')).items]);
}

/**
 * @param {ReturnType<typeof summarize>} summary
 * @param {boolean} variants
 */
function print(summary, variants) {
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
  if (!variants) return;
  for (const [variant, c] of Object.entries(summary.byVariant).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`    ${variant.padEnd(34)} ${c.caught}/${c.total} caught, ${c.flagged} flagged, ${c.missed} missed${c.notFound ? `, ${c.notFound} not found` : ''}`);
  }
}

/** @param {string} message @returns {never} */
function usage(message) {
  console.error(`eval-source-check: ${message}\nusage: eval-source-check [--sets dev,v2dev] [--grounding 1|2] [--variants] [--unblind] [--json]`);
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const unblind = args.includes('--unblind');
  const variants = args.includes('--variants');
  /** @type {string[] | null} */
  let wanted = null;
  /** @type {{ version?: number }} */
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const [name, inline] = args[i].split('=', 2);
    const value = () => inline ?? args[++i] ?? usage(`${name} needs a value`);
    if (name === '--sets') wanted = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (name === '--grounding') {
      options.version = Number(value());
      if (!Number.isInteger(options.version)) usage('--grounding needs a version number');
    } else if (!['--json', '--unblind', '--variants'].includes(name)) usage(`unknown argument ${args[i]}`);
  }
  const all = ['dev', 'holdout', 'v2dev', 'v2holdout'];
  const sets = wanted ?? all.filter((s) => unblind || !HELD_OUT.includes(s));
  for (const set of sets) {
    if (!all.includes(set)) usage(`unknown set ${set} (sets: ${all.join(', ')})`);
    if (HELD_OUT.includes(set) && !unblind) usage(`${set} is a held-out set: it is measured once, with --unblind (see docs/eval/v2-protocol.md)`);
  }
  const v2 = sets.some((set) => set.startsWith('v2')) ? await loadV2Items({ unblind: sets.includes('v2holdout') }) : [];
  const items = [...(await loadItems()), ...v2].filter((i) => sets.includes(i.set));
  const corpora = await loadCorpora();
  const results = Object.fromEntries(sets.map((set) => [set, summarize(items.filter((i) => i.set === set), corpora, options)]));
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  sets.forEach((set, n) => {
    console.log(`${n ? '\n' : ''}== ${set} (${items.filter((i) => i.set === set).length} answers)`);
    print(results[set], variants);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
