// checkDocument (whole documents of any length), SARIF output and the starpi-ground command.
import './setup.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocument } from '../../src/js/core/document.js';
import { REASON_CODES, THRESHOLDS } from '../../src/js/core/grounding.js';
import { describeReason, REASON_MESSAGES, SARIF_SCHEMA, SARIF_VERSION, toSarif } from '../../src/js/core/sarif.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/ground.mjs');
const PLAN_TEXT = readFileSync(path.join(ROOT, 'public/samples/en/nebula-plan.md'), 'utf8');

const SOURCES = [
  { label: '[Doc: plan.md, Chunk: 1]', doc: 'plan.md', heading: '', text: 'The approved budget for Project Nebula is 480,000 EUR. The public launch is planned for 12 May 2027.', delivered: /** @type {const} */ ('full') },
  { label: '[Doc: plan.md, Chunk: 2]', doc: 'plan.md', heading: '', text: 'The steering group meets every Tuesday at 10:00 in Hamburg.', delivered: /** @type {const} */ ('full') },
];

describe('checkDocument', () => {
  it('reports every checked statement with its line and column, using the labels when there are any', () => {
    const doc = ['# Notes', '', 'The approved budget is 480,000 EUR [Doc: plan.md, Chunk: 1]. The launch is planned for 12 June 2027 [Doc: plan.md, Chunk: 1].', '', '- The group meets every Tuesday at 10:00 [Doc: plan.md, Chunk: 2].'].join('\n');
    const report = checkDocument(doc, SOURCES);
    assert.equal(report.mode, 'labels');
    assert.equal(report.sections, 1);
    assert.deepEqual(report.counts, { supported: 2, weak: 0, unsupported: 1, unchecked: 0 });
    assert.deepEqual(
      report.statements.map((s) => [s.line, s.column, s.verdict]),
      [
        [3, 1, 'supported'],
        [3, 62, 'unsupported'],
        [5, 3, 'supported'],
      ],
    );
    assert.equal(doc.split('\n')[2].slice(61, 64), 'The');
    assert.equal(report.statements[1].reasons[0].code, 'missing_fact');
  });

  it('compares every statement with every excerpt when the document has no labels', () => {
    const report = checkDocument('The approved budget is 480,000 EUR.\nThe group meets every Friday at 10:00.\n', SOURCES);
    assert.equal(report.mode, 'all');
    assert.deepEqual(report.statements.map((s) => [s.line, s.verdict, s.citeSource]), [
      [1, 'supported', 'answer'],
      [2, 'unsupported', 'answer'],
    ]);
    assert.deepEqual(report.statements[0].cites, [0, 1]);
    // Forced modes: labels on an unlabelled document leaves the statements uncited.
    assert.deepEqual(checkDocument('The approved budget is 480,000 EUR.', SOURCES, { cite: 'labels' }).statements.map((s) => [s.verdict, s.citeSource]), [['weak', null]]);
  });

  it('splits a long document at headings, checks every part and keeps answer-wide sources in each', () => {
    // 30 sections of 12 statements: 360 statements and about 25,000 characters, above both limits.
    const parts = [];
    for (let k = 1; k <= 30; k += 1) {
      parts.push(`## Part ${k}`, '');
      for (let j = 0; j < 12; j += 1) parts.push(j === 5 && k === 17 ? 'The approved budget for the project is 520,000 EUR this year.' : 'The approved budget for Project Nebula is 480,000 EUR, as this part says again.');
      parts.push('');
    }
    parts.push('Sources: [Doc: plan.md, Chunk: 1]');
    const doc = parts.join('\n');
    assert.ok(doc.length > THRESHOLDS.maxChars);
    const report = checkDocument(doc, SOURCES);
    assert.equal(report.mode, 'labels');
    assert.ok(report.sections >= 2, `${report.sections} sections`);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.statements.length, 360);
    assert.deepEqual(report.counts, { supported: 359, weak: 0, unsupported: 1, unchecked: 0 });
    const bad = report.statements.find((s) => s.verdict === 'unsupported');
    assert.equal(doc.split('\n')[(bad?.line ?? 0) - 1], 'The approved budget for the project is 520,000 EUR this year.');
    assert.ok(report.statements.every((s) => s.citeSource === 'answer'), 'the Sources: line applies in every section');
  });

  it('reports a paragraph above the limits as not checked, never as passed', () => {
    const long = `${'The approved budget for Project Nebula is 480,000 EUR. '.repeat(400)}`;
    assert.ok(long.length > THRESHOLDS.maxChars);
    const report = checkDocument(`# Notes\n\nThe approved budget is 480,000 EUR [Doc: plan.md, Chunk: 1].\n\n${long}\n`, SOURCES);
    assert.deepEqual(report.skipped, [{ line: 5, endLine: 5 }]);
    assert.equal(report.counts.supported, 1);
  });
});

describe('SARIF', () => {
  it('has a rule for every reason code, worded like the app', async () => {
    const en = JSON.parse(readFileSync(path.join(ROOT, 'src/locales/en.json'), 'utf8')).grounding;
    for (const code of REASON_CODES) assert.equal(REASON_MESSAGES[code], en[`reason_${code}`], code);
    assert.deepEqual(Object.keys(REASON_MESSAGES).sort(), [...REASON_CODES].sort());
    const log = await toSarif([], { name: 'starpi-ground', version: '9.9.9', informationUri: 'https://example.org' });
    assert.deepEqual(log.runs[0].tool.driver.rules.map((r) => r.id), [...REASON_CODES, 'too_long']);
    for (const rule of log.runs[0].tool.driver.rules) {
      assert.match(rule.name, /^[A-Z][A-Za-z]+$/);
      assert.ok(rule.shortDescription.text && rule.fullDescription.text && rule.help.text);
      assert.ok(['error', 'warning'].includes(rule.defaultConfiguration.level));
    }
    assert.equal(describeReason({ code: 'missing_fact', level: 'unsupported', fact: '520,000 EUR', cites: [0] }, SOURCES), '520,000 EUR is not in [Doc: plan.md, Chunk: 1].');
    const many = Array.from({ length: 5 }, (_, i) => ({ label: `[Doc: d.md, Chunk: ${i + 1}]` }));
    assert.equal(describeReason({ code: 'low_overlap', level: 'weak', cites: [0, 1, 2, 3, 4] }, many), 'Few of its words appear in [Doc: d.md, Chunk: 1], [Doc: d.md, Chunk: 2], [Doc: d.md, Chunk: 3] and 2 more excerpts.');
  });

  it('writes one result per statement to review, at its line, with stable fingerprints', async () => {
    const doc = 'The approved budget is 480,000 EUR [Doc: plan.md, Chunk: 1].\n\nThe launch is planned for 12 June 2027 [Doc: plan.md, Chunk: 1]. Its rollout covers several regional delivery depots [Doc: plan.md, Chunk: 1].\n';
    const report = checkDocument(doc, SOURCES);
    const log = await toSarif([{ uri: 'docs/notes.md', report, sources: SOURCES }], { name: 'starpi-ground', version: '2.0.0', informationUri: 'https://github.com/umutcantezgel-cpu/Starpi' });
    assert.equal(log.version, SARIF_VERSION);
    assert.equal(log.$schema, SARIF_SCHEMA);
    const run = log.runs[0];
    assert.equal(run.columnKind, 'utf16CodeUnits');
    assert.deepEqual(
      run.results.map((r) => [r.ruleId, r.level, r.locations[0].physicalLocation.artifactLocation.uri, r.locations[0].physicalLocation.region]),
      [
        ['missing_fact', 'error', 'docs/notes.md', { startLine: 3, startColumn: 1 }],
        ['low_overlap', 'warning', 'docs/notes.md', { startLine: 3, startColumn: doc.split('\n')[2].indexOf('Its') + 1 }],
      ],
    );
    for (const r of run.results) {
      assert.equal(run.tool.driver.rules[r.ruleIndex].id, r.ruleId);
      assert.match(r.partialFingerprints['starpiStatement/v1'], /^[0-9a-f]{64}$/);
    }
    assert.match(run.results[0].message.text, /^Not supported by the cited sources: “The launch is planned for 12 June 2027\.” 12 June 2027 is not in \[Doc: plan\.md, Chunk: 1\]\.$/);
    // The same statement on another line keeps its fingerprint.
    const moved = await toSarif([{ uri: 'docs/notes.md', report: checkDocument(`# Moved\n\n${doc}`, SOURCES), sources: SOURCES }], { name: 'starpi-ground', version: '2.0.0', informationUri: 'https://github.com/umutcantezgel-cpu/Starpi' });
    assert.equal(moved.runs[0].results[0].locations[0].physicalLocation.region.startLine, 5);
    assert.equal(moved.runs[0].results[0].partialFingerprints['starpiStatement/v1'], run.results[0].partialFingerprints['starpiStatement/v1']);
  });
});

describe('starpi-ground (scripts/ground.mjs)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'starpi-ground-'));
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir });
  mkdirSync(path.join(dir, 'specs/a'), { recursive: true });
  mkdirSync(path.join(dir, 'specs/b'), { recursive: true });
  mkdirSync(path.join(dir, 'specs/.hidden'), { recursive: true });
  mkdirSync(path.join(dir, 'specs/node_modules'), { recursive: true });
  writeFileSync(path.join(dir, 'specs/nebula-plan.md'), PLAN_TEXT);
  writeFileSync(path.join(dir, 'specs/a/limits.md'), '# Limits\n\nThe gateway accepts at most 400 connections.\n');
  writeFileSync(path.join(dir, 'specs/b/limits.md'), '# Limits\n\nThe broker keeps messages for 7 days.\n');
  writeFileSync(path.join(dir, 'specs/.hidden/secret.md'), 'The approved budget is 999,000 EUR.\n');
  writeFileSync(path.join(dir, 'specs/node_modules/dep.md'), 'The approved budget is 999,000 EUR.\n');
  writeFileSync(path.join(dir, 'specs/image.png'), 'not text');
  writeFileSync(path.join(dir, 'good.md'), '# Notes\n\nThe approved budget for Project Nebula is 480,000 EUR.\nThe gateway accepts at most 400 connections.\n');
  writeFileSync(path.join(dir, 'bad.md'), '# Notes\n\nThe approved budget for Project Nebula is 999,000 EUR.\nLena Park leads development at the Munich office.\n');
  writeFileSync(path.join(dir, 'labelled.md'), 'The broker keeps messages for 7 days [Doc: specs/b/limits.md, Chunk: 1].\nThe gateway accepts at most 400 connections [Doc: specs/b/limits.md, Chunk: 1].\n');

  it('passes a document whose statements are in the sources, reading a directory like the app', () => {
    const ok = run(['--answer', 'good.md', '--source', 'specs', '--format', 'json']);
    assert.equal(ok.status, 0, ok.stderr);
    const json = JSON.parse(ok.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'all');
    assert.deepEqual(json.counts, { supported: 2, weak: 0, unsupported: 0, unchecked: 0 });
    // Hidden directories, node_modules and unsupported files are left out; equal names get their path.
    assert.deepEqual(json.sources.map((/** @type {any} */ s) => s.doc), ['specs/a/limits.md', 'specs/b/limits.md', 'nebula-plan.md']);
    assert.equal(json.tool.name, 'starpi-ground');
  });

  it('fails on unsupported statements by default, on weak ones with --fail-on weak, never with --fail-on never', () => {
    const text = run(['--answer', 'bad.md', '--source', 'specs']);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /^bad\.md:3:1 unsupported “The approved budget for Project Nebula is 999,000 EUR\.”\n {4}999,000 is not in \[Doc: specs\/a\/limits\.md, Chunk: 1\], \[Doc: specs\/b\/limits\.md, Chunk: 1\], \[Doc: nebula-plan\.md, Chunk: 1\] and 2 more excerpts\.$/m);
    assert.match(text.stdout, /^bad\.md:4:1 weak “Lena Park leads development at the Munich office\.”$/m);
    assert.match(text.stdout, /2 statements checked against 5 excerpts from 3 files \(citations: all\): 0 supported, 1 weak, 1 unsupported, 0 unchecked$/m);
    assert.equal(run(['--answer', 'bad.md', '--source', 'specs', '--fail-on', 'never']).status, 0);
    assert.equal(run(['--answer', 'good.md', '--source', 'specs', '--fail-on=weak']).status, 0);
    writeFileSync(path.join(dir, 'weak.md'), 'Lena Park leads development at the Munich office.\n');
    assert.equal(run(['--answer', 'weak.md', '--source', 'specs']).status, 0, 'weak passes by default');
    assert.equal(run(['--answer', 'weak.md', '--source', 'specs', '--fail-on', 'weak']).status, 1);
  });

  it('uses the labels of a labelled document and writes SARIF to a file', () => {
    const out = run(['--answer', 'labelled.md', '--source', 'specs', '--format', 'sarif', '--output', 'out.sarif']);
    assert.equal(out.status, 0, 'a weak finding passes the default --fail-on unsupported');
    assert.equal(out.stdout, '');
    const log = JSON.parse(readFileSync(path.join(dir, 'out.sarif'), 'utf8'));
    assert.equal(log.version, '2.1.0');
    assert.equal(log.runs[0].tool.driver.name, 'starpi-ground');
    assert.equal(log.runs[0].tool.driver.version, JSON.parse(readFileSync(path.join(ROOT, 'packages/core/package.json'), 'utf8')).version);
    assert.deepEqual(
      log.runs[0].results.map((/** @type {any} */ r) => [r.ruleId, r.level, r.locations[0].physicalLocation.artifactLocation.uri, r.locations[0].physicalLocation.region.startLine]),
      [['fact_elsewhere', 'warning', 'labelled.md', 2]],
    );
    assert.match(log.runs[0].results[0].message.text, /400 is in \[Doc: specs\/a\/limits\.md, Chunk: 1\], not in the cited \[Doc: specs\/b\/limits\.md, Chunk: 1\]\./);
  });

  it('refuses bad arguments and unreadable input with exit code 2', () => {
    assert.equal(run([]).status, 2);
    assert.equal(run(['--answer', 'good.md']).status, 2);
    assert.equal(run(['--source', 'specs']).status, 2);
    assert.equal(run(['--answer', 'missing.md', '--source', 'specs']).status, 2);
    assert.equal(run(['--answer', 'good.md', '--source', 'specs/image.png']).status, 2);
    assert.equal(run(['--answer', 'good.md', '--source', 'specs', '--format', 'xml']).status, 2);
    assert.equal(run(['--answer', 'good.md', '--source', 'specs', '--fail-on']).status, 2);
    assert.equal(run(['--answer', 'good.md', '--source', 'specs', '--frobnicate']).status, 2);
    const help = run(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^usage: starpi-ground --answer/);
  });

  it('escapes control and bidirectional characters from the document in the text report', () => {
    writeFileSync(path.join(dir, 'evil.md'), 'The approved budget is 999,000 EUR \u202e\u001b[2Jhidden.\n');
    const out = run(['--answer', 'evil.md', '--source', 'specs']);
    assert.equal(out.status, 1);
    assert.ok(!out.stdout.includes('\u001b') && !out.stdout.includes('\u202e'));
    assert.match(out.stdout, /\\u202e\\u001b\[2Jhidden/);
  });
});
