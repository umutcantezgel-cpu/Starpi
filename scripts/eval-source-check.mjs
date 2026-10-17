#!/usr/bin/env node
// Measures the source check on labelled answers: faithful answers, and answers with exactly one
// planted error (a changed number, date, time, weekday or code; a wrong person; a negation; a value
// attached to the wrong thing). The answers are in tests/fixtures/grounding/eval.json (sets "dev"
// and "holdout", written for 1.2) and eval-v2-dev.json / eval-v2-holdout.json (sets "v2dev" and
// "v2holdout", written for 2.0, see docs/eval/v2-protocol.md), paraphrases.json (set
// "paraphrases": faithful statements only) and relations-dev.json / relations-holdout.json (sets
// "relations" and "relholdout", written for 3.0: errors in a relation between values or events, see
// docs/eval/v3-relations.md); their sources are the sample files in public/samples (chunked here
// with the app's own code), the sample knowledge-base sections in kb-sample.json, the technical
// specifications in sources-v2.json, the sources in paraphrases.json and the reports in
// relations-sources.json.
//
// Usage: node scripts/eval-source-check.mjs [--sets dev,v2dev,paraphrases,relations] [--grounding 1|2|3] [--variants] [--json]
//        node scripts/eval-source-check.mjs --unblind [--sets …]   (also the held-out sets)
//
// For a faithful answer, a statement marked "unsupported" is a false alarm. For an answer with an
// error, the statement that contains the wrong value should be marked "unsupported" (caught) or at
// least "weak" (flagged); "supported" means the error was missed. Results are reported per set: the
// dev sets were available while the rules were adjusted; the held-out sets are measured, not used
// to adjust rules, so they are left out unless --unblind is given. The v2 and relation held-out files
// are checked against the SHA-256 that was committed before the rules they measure were written.
// For every set with planted errors the report ends with the detection rate: the share of errors
// flagged (unsupported or weak).
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
  for (const file of ['kb-sample.json', 'sources-v2.json', 'paraphrases.json', 'relations-sources.json']) {
    const json = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/grounding', file), 'utf8'));
    for (const [key, sections] of Object.entries(json.corpora ?? json)) {
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

/**
 * Faithful paraphrases written by a red-team agent against the first version 2 rules (set
 * "paraphrases", docs/eval/v2-protocol.md): a development set of faithful statements only.
 */
export async function loadParaphrases() {
  const { items } = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/grounding/paraphrases.json'), 'utf8'));
  return /** @type {EvalItem[]} */ (items);
}

/** Held-out sets: measured, never used to adjust rules. */
export const HELD_OUT = Object.freeze(['holdout', 'v2holdout', 'relholdout']);

/**
 * A held-out file, after checking it against the SHA-256 committed when it was frozen.
 * @param {string} name  file name in tests/fixtures/grounding
 * @returns {Promise<EvalItem[]>}
 */
async function frozenItems(name) {
  const dir = path.join(ROOT, 'tests/fixtures/grounding');
  const bytes = await readFile(path.join(dir, name));
  const frozen = (await readFile(path.join(dir, name.replace(/\.json$/, '.sha256')), 'utf8')).split(/\s+/)[0];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== frozen) throw new Error(`${name} changed after it was frozen: SHA-256 ${actual}, frozen ${frozen}`);
  return JSON.parse(bytes.toString('utf8')).items;
}

/**
 * The relation sets written for 3.0 (grounding version 3): set relations, and with `unblind` also
 * relholdout, after checking the held-out file against the SHA-256 committed before the relation
 * rules were written.
 * @param {{ unblind?: boolean }} [options]
 */
export async function loadRelationItems(options = {}) {
  const { items } = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/grounding/relations-dev.json'), 'utf8'));
  return /** @type {EvalItem[]} */ ([...items, ...(options.unblind ? await frozenItems('relations-holdout.json') : [])]);
}

/**
 * The eval items written for 2.0: set v2dev, and with `unblind` also v2holdout, after checking the
 * held-out file against the SHA-256 committed before the v2 rules were written.
 * @param {{ unblind?: boolean }} [options]
 */
export async function loadV2Items(options = {}) {
  const { items } = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/grounding/eval-v2-dev.json'), 'utf8'));
  if (!options.unblind) return /** @type {EvalItem[]} */ (items);
  return /** @type {EvalItem[]} */ ([...items, ...(await frozenItems('eval-v2-holdout.json'))]);
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
  const rows = Object.entries(summary.byCategory).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return;
  console.log('Answers with one planted error (caught = unsupported, flagged = weak):');
  for (const [category, c] of rows) {
    const kind = FACT_CATEGORIES.includes(category) ? 'fact' : 'meaning';
    console.log(`  ${category.padEnd(9)} (${kind})  ${c.caught}/${c.total} caught, ${c.flagged} flagged, ${c.missed} missed${c.notFound ? `, ${c.notFound} statement not found` : ''}`);
  }
  const total = rows.reduce((n, [, c]) => n + c.total, 0);
  const detected = rows.reduce((n, [, c]) => n + c.caught + c.flagged, 0);
  console.log(`  detection rate: ${detected}/${total} planted errors flagged (${Math.round((detected / total) * 1000) / 10} %)`);
  if (!variants) return;
  for (const [variant, c] of Object.entries(summary.byVariant).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`    ${variant.padEnd(34)} ${c.caught}/${c.total} caught, ${c.flagged} flagged, ${c.missed} missed${c.notFound ? `, ${c.notFound} not found` : ''}`);
  }
}

/** @param {string} message @returns {never} */
function usage(message) {
  console.error(`eval-source-check: ${message}\nusage: eval-source-check [--sets dev,v2dev,relations] [--grounding 1|2|3] [--variants] [--unblind] [--json]`);
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
  const all = ['dev', 'holdout', 'v2dev', 'v2holdout', 'paraphrases', 'relations', 'relholdout'];
  const sets = wanted ?? all.filter((s) => unblind || !HELD_OUT.includes(s));
  for (const set of sets) {
    if (!all.includes(set)) usage(`unknown set ${set} (sets: ${all.join(', ')})`);
    if (HELD_OUT.includes(set) && !unblind) usage(`${set} is a held-out set: it is measured once, with --unblind (see docs/eval/v2-protocol.md and docs/eval/v3-relations.md)`);
  }
  const v2 = sets.some((set) => set.startsWith('v2')) ? await loadV2Items({ unblind: sets.includes('v2holdout') }) : [];
  const paraphrases = sets.includes('paraphrases') ? await loadParaphrases() : [];
  const relations = sets.some((set) => set.startsWith('rel')) ? await loadRelationItems({ unblind: sets.includes('relholdout') }) : [];
  const items = [...(await loadItems()), ...v2, ...paraphrases, ...relations].filter((i) => sets.includes(i.set));
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
