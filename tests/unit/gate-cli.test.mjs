// starpi-gate (scripts/gate.mjs): a text and its sources in, JSON or SARIF out, with exit codes
// for scripts and CI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/gate.mjs');
const DIR = mkdtempSync(path.join(tmpdir(), 'starpi-gate-'));

writeFileSync(path.join(DIR, 'plan.md'), '# Plan\n\nThe approved budget is 480,000 EUR. The team has twelve members.\n');
writeFileSync(path.join(DIR, 'answer.md'), 'The budget is 480,000 EUR [Doc: plan.md, Chunk: 1].\nThe team has 13 members [Doc: plan.md, Chunk: 1].\n');
writeFileSync(path.join(DIR, 'sources.json'), JSON.stringify([{ label: '[S1]', text: 'The team has twelve members.' }]));

/**
 * @param {string[]} args
 * @param {string} [input]
 */
const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd: DIR, encoding: 'utf8', input });

describe('starpi-gate', () => {
  it('writes JSON with released and withheld units and exits 1 when something is withheld', () => {
    const r = run(['--text', 'answer.md', '--source', 'plan.md', '--locale', 'en']);
    assert.equal(r.status, 1, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.tool.name, 'starpi-gate');
    assert.deepEqual(report.counts, { released: 1, withheld: 1, reasons: { unsupported_number: 1 }, spokenFallback: 0 });
    assert.deepEqual(report.released.map((/** @type {any} */ u) => [u.line, u.column, u.text, u.cites]), [[1, 1, 'The budget is 480,000 EUR.', ['[Doc: plan.md, Chunk: 1]']]]);
    assert.deepEqual(report.withheld.map((/** @type {any} */ u) => [u.line, u.reason, u.token, u.message]), [[2, 'unsupported_number', '13', '13 is not in the excerpts this unit cites.']]);
  });

  it('writes SARIF 2.1.0 with one result per withheld unit', () => {
    const out = path.join(DIR, 'gate.sarif');
    const r = run(['--text', 'answer.md', '--source', DIR, '--format', 'sarif', '--output', out, '--locale=en']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, '');
    const log = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(log.version, '2.1.0');
    const [run0] = log.runs;
    assert.equal(run0.tool.driver.name, 'starpi-gate');
    assert.equal(run0.tool.driver.rules.length, 9);
    assert.equal(run0.results.length, 1);
    const [result] = run0.results;
    assert.equal(result.ruleId, 'unsupported_number');
    assert.equal(run0.tool.driver.rules[result.ruleIndex].id, 'unsupported_number');
    assert.deepEqual(result.locations[0].physicalLocation, { artifactLocation: { uri: 'answer.md' }, region: { startLine: 2, startColumn: 1 } });
    assert.match(result.partialFingerprints['starpiGate/v1'], /^[0-9a-f]{64}$/);
  });

  it('reads sources as JSON and the text from standard input, and exits 0 when all is released', () => {
    const r = run(['--text', '-', '--sources', 'sources.json'], 'The team has 12 members [S1].');
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.text, 'stdin');
    assert.deepEqual(report.released[0].numbers, [{ raw: '12', value: 12 }]);
  });

  it('runs free and web mode, and never fails with --fail-on never', () => {
    writeFileSync(path.join(DIR, 'web.txt'), 'The tower is 330 m tall. It opened in 1889.');
    writeFileSync(path.join(DIR, 'grounding.json'), JSON.stringify({ segments: [{ start: 0, end: 24, sources: [0] }], sources: [{ uri: 'https://example.org/tower' }] }));
    const web = run(['--text', 'web.txt', '--mode', 'web', '--grounding', 'grounding.json', '--locale', 'en']);
    assert.equal(web.status, 1);
    assert.deepEqual(JSON.parse(web.stdout).withheld.map((/** @type {any} */ w) => w.reason), ['web_ungrounded']);
    const free = run(['--text', 'web.txt', '--mode', 'free']);
    assert.equal(free.status, 0, free.stderr);
    assert.equal(run(['--text', 'answer.md', '--source', 'plan.md', '--fail-on', 'never']).status, 0);
  });

  it('exits 2 on usage errors', () => {
    for (const args of [[], ['--text', 'answer.md'], ['--text', 'answer.md', '--source', 'missing.md'], ['--text', 'answer.md', '--mode', 'loose'], ['--text', 'answer.md', '--mode', 'free', '--locale', 'EN!'], ['--bogus']]) {
      const r = run(args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /^starpi-gate: /);
    }
    assert.equal(run(['--help']).status, 0);
    assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/);
  });
});
