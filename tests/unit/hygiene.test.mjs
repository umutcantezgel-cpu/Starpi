// The public hygiene check (scripts/public-hygiene.mjs), on the repository itself and on throwaway
// git repositories. Every value the check must catch is assembled at run time, so this file does
// not trip the check it tests.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RULES, runHygiene, scanText } from '../../scripts/public-hygiene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/public-hygiene.mjs');

/** @param {string} name */
const home = (name) => ['', 'home', name, 'work'].join('/');
const MAC = ['', 'Users', 'alex', 'work'].join('/');
const WINDOWS = ['C:', 'Users', 'alex', 'work'].join('\\');
/** the word of the private-token rule */
const WORD = 'fluid';
/** @param {string[]} parts */
const id = (...parts) => parts.join('-');

/** @type {string[]} */
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, ...args) {
  const config = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
  return execFileSync('git', [...config, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * @param {string} dir
 * @param {Record<string, string | Buffer>} files
 */
function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
}

/**
 * Commits everything and returns the commit id.
 * @param {string} dir
 * @param {string} message
 */
function commit(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * A new repository with `files` in its first commit.
 * @param {Record<string, string | Buffer>} files
 */
function repo(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hygiene-'));
  temps.push(dir);
  git(dir, 'init', '-q');
  write(dir, files);
  commit(dir, 'initial commit');
  return dir;
}

/** @param {ReturnType<typeof runHygiene>} result */
const where = (result) => result.findings.map((f) => `${f.file}:${f.line} ${f.rule}`);

describe('public hygiene check', () => {
  it('passes on this repository', () => {
    const result = runHygiene({ root: ROOT });
    assert.ok(result.files > 100, `only ${result.files} tracked files`);
    assert.deepEqual(where(result), []);
  });

  it('reports personal home paths in tracked files with file and line', () => {
    const dir = repo({
      'notes/setup.md': ['# Setup', `cd ${home('alex')}`, `Open ${MAC}/notes.txt`, `Run from ${WINDOWS}`, JSON.stringify({ dir: WINDOWS })].join('\n'),
      'README.md': `A web path like https://example.com${['', 'home', 'page'].join('/')} or ~/projects stays allowed.\n`,
    });
    assert.deepEqual(where(runHygiene({ root: dir })), [
      'notes/setup.md:2 home-path',
      'notes/setup.md:3 home-path',
      'notes/setup.md:4 home-path',
      'notes/setup.md:5 home-path',
    ]);
  });

  it('allows the CI runner home directory only in CI files', () => {
    const dir = repo({ '.github/workflows/ci.yml': `cache: ${home('runner')}/.npm\n`, 'docs/ci.md': `The cache lives in ${home('runner')}.\n` });
    assert.deepEqual(where(runHygiene({ root: dir })), ['docs/ci.md:1 home-path']);
  });

  it('reports private-project tokens and internal-id shapes, but not ordinary identifiers', () => {
    for (const text of [`${WORD}_session`, `X-${WORD.toUpperCase()}-Trace: 1`, `[[${WORD}-tag:a]]`, `import '${WORD}-core'`]) {
      assert.deepEqual(scanText(text, 'a.js').map((f) => f.rule), ['private-token'], text);
    }
    for (const text of [id('E', '114'), id('ADR', '0024'), `ADR ${'0024'}`, id('V02', 'X'), id('M', '17'), id('K', '12'), `see G${'7.5'}`]) {
      assert.deepEqual(scanText(`Decision ${text} applies.`, 'a.md').map((f) => f.rule), ['internal-id'], text);
    }
    const ordinary = 'COVID-19, ISO 9001, ISO-27001, IPv6, USB-C, SHA-256, UTF-8, R-02, E-mail, A4, MP3, 5G, v1.2.3, E-1234, fluid layout';
    assert.deepEqual(scanText(ordinary, 'a.md'), []);
    assert.ok(RULES.every((r) => r.pattern.global), 'every rule pattern is global');
  });

  it('checks file paths as well as their content', () => {
    const dir = repo({ [`vendor/${WORD}-core/index.js`]: 'export {};\n' });
    const [finding] = runHygiene({ root: dir }).findings;
    assert.equal(finding.file, `vendor/${WORD}-core/index.js`);
    assert.equal(finding.line, 0);
    assert.equal(finding.rule, 'private-token');
  });

  it('skips a line with a reasoned inline allow, not one without a reason', () => {
    const text = [`const sample = '${home('demo')}'; // hygiene-allow: fixture for the path parser`, `const other = '${home('demo')}'; // hygiene-allow:`].join('\n');
    assert.deepEqual(scanText(text, 'a.js').map((f) => f.line), [2]);
  });

  it('honours allowlist entries by path, rule and line, and rejects entries without a reason', () => {
    const files = {
      'data/fixture.json': JSON.stringify({ path: home('demo') }),
      'data/other.json': JSON.stringify({ path: home('demo') }),
      'docs/a.md': `line one\n${id('E', '114')}\n`,
    };
    const allow = (/** @type {object[]} */ entries) => ({ 'scripts/public-hygiene.allow.json': JSON.stringify({ allow: entries }) });
    let dir = repo({ ...files, ...allow([{ path: 'data/fixture.json', rule: 'home-path', reason: 'parser fixture' }, { path: 'docs/*.md', line: 2, reason: 'quoted example' }]) });
    assert.deepEqual(where(runHygiene({ root: dir })), ['data/other.json:1 home-path']);
    dir = repo({ ...files, ...allow([{ path: 'data/**', reason: 'fixtures' }, { path: 'docs/a.md', line: 1, reason: 'wrong line' }]) });
    assert.deepEqual(where(runHygiene({ root: dir })), ['docs/a.md:2 internal-id']);
    dir = repo({ ...files, ...allow([{ path: 'data/fixture.json' }]) });
    assert.throws(() => runHygiene({ root: dir }), /needs a reason/);
    dir = repo({ ...files, ...allow([{ path: 'data/fixture.json', rule: 'no-such-rule', reason: 'typo' }]) });
    assert.throws(() => runHygiene({ root: dir }), /unknown rule/);
  });

  it('scans the commit messages of a range, and only with --range', () => {
    const dir = repo({ 'a.txt': 'one\n' });
    const base = git(dir, 'rev-parse', 'HEAD');
    write(dir, { 'a.txt': 'two\n' });
    const bad = commit(dir, `fix: follow-up\n\nCloses ${id('E', '114')}.`);
    write(dir, { 'a.txt': 'three\n' });
    const good = commit(dir, 'docs: clean message');
    assert.deepEqual(where(runHygiene({ root: dir })), []);
    const result = runHygiene({ root: dir, range: `${base}..HEAD` });
    assert.equal(result.commits, 2);
    assert.deepEqual(where(result), [`commit ${bad.slice(0, 12)}:3 internal-id`]);
    assert.deepEqual(where(runHygiene({ root: dir, range: `${bad}..${good}` })), []);
    write(dir, { 'scripts/public-hygiene.allow.json': JSON.stringify({ allow: [{ commit: bad, reason: 'merged before the check existed' }] }) });
    commit(dir, 'chore: allow an old message');
    assert.deepEqual(where(runHygiene({ root: dir, range: `${base}..HEAD` })), []);
    assert.throws(() => runHygiene({ root: dir, range: '--all' }), /form A\.\.B/);
  });

  it('skips binary and untracked files', () => {
    const dir = repo({ 'img/logo.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(home('alex'))]) });
    write(dir, { 'scratch.md': home('alex') });
    assert.deepEqual(where(runHygiene({ root: dir })), []);
  });

  it('exits 1 with file:line:column lines on the command line, 0 when clean, 2 on errors', () => {
    const dirty = repo({ 'docs/guide.md': `intro\n  see ${home('alex')}\n` });
    let run = spawnSync(process.execPath, [SCRIPT, '--root', dirty], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^docs\/guide\.md:2:7 {2}home-path {2}"/m);
    assert.match(run.stderr, /1 finding in 1 tracked files/);
    const clean = repo({ 'docs/guide.md': 'intro\n' });
    run = spawnSync(process.execPath, [SCRIPT, '--root', clean, '--range', 'HEAD..HEAD'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /1 tracked files and 0 commit messages in HEAD\.\.HEAD clean/);
    run = spawnSync(process.execPath, [SCRIPT, '--root', clean, '--range', 'missing..HEAD'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    run = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });
});
