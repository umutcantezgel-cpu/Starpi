// End-of-life gate (scripts/eol-check.mjs) over docs/security/eol-register.json: dates, the
// horizon, completeness, and the facts of the repository the register must match.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addMonths, DEFAULT_REGISTER, evaluateRegister, parseEolDate, repoFacts, workflowRuntimes } from '../../scripts/eol-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TODAY = /** @type {Date} */ (parseEolDate('2026-10-16'));

/** @param {Partial<import('../../scripts/eol-check.mjs').Component>} [extra] */
const component = (extra = {}) => ({ name: 'Widget', version: '1', kind: 'npm', usedFor: 'tests', eol: null, ...extra });
/** @param {object[]} components */
const register = (components) => ({ horizonMonths: 12, components });

describe('dates', () => {
  it('reads days and months, and refuses impossible dates', () => {
    assert.equal(parseEolDate('2027-04-30')?.toISOString(), '2027-04-30T00:00:00.000Z');
    assert.equal(parseEolDate('2027-10')?.toISOString(), '2027-10-01T00:00:00.000Z');
    for (const bad of ['2027-02-30', '2027-13', '27-01-01', 'soon']) assert.equal(parseEolDate(bad), null, bad);
  });

  it('adds months without running past the end of a month', () => {
    assert.equal(addMonths(/** @type {Date} */ (parseEolDate('2026-08-31')), 6).toISOString().slice(0, 10), '2027-02-28');
    assert.equal(addMonths(TODAY, 12).toISOString().slice(0, 10), '2027-10-16');
  });
});

describe('evaluateRegister', () => {
  it('passes a date beyond the horizon, warns within it and fails after it', () => {
    const result = evaluateRegister(
      register([
        component({ name: 'Far', eol: '2030-01-01', source: 'https://example.org' }),
        component({ name: 'Near', eol: '2027-04', source: 'https://example.org' }),
        component({ name: 'Past', eol: '2026-10-15', source: 'https://example.org' }),
        component({ name: 'Open' }),
      ]),
      { today: TODAY },
    );
    assert.deepEqual(result.rows.map((r) => r.status), ['ok', 'soon', 'expired', 'none']);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^Near 1 reaches its end of life on 2027-04, in 167 days/);
    assert.deepEqual(result.problems, ['Past 1 reached its end of life on 2026-10-15 (tests)']);
  });

  it('refuses incomplete entries and a date without a source', () => {
    const { problems } = evaluateRegister(register([{ name: 'Bare', version: '1', kind: 'gadget' }, component({ eol: '2030-01-01' }), component({ eol: 'never' })]), { today: TODAY });
    for (const expected of [
      'Bare 1: "usedFor" is missing',
      'Bare 1: kind must be one of runtime, npm, service, tooling',
      'Bare 1: "eol" is missing (a date, or null when no end of life is published)',
      'Widget 1: an end-of-life date needs a "source"',
      'Widget 1: eol "never" is neither YYYY-MM-DD nor YYYY-MM',
    ]) {
      assert.ok(problems.includes(expected), `${expected}\n---\n${problems.join('\n')}`);
    }
    assert.ok(evaluateRegister({ horizonMonths: 0, components: [] }, { today: TODAY }).problems.includes('the register lists no components'));
  });

  it('follows the repository: locked versions, .nvmrc, production dependencies and workflow runtimes', () => {
    const { problems } = evaluateRegister(
      register([component({ npm: 'widget', version: '1.0.0' }), component({ name: 'Node.js', version: '22', kind: 'runtime', nvmrc: true })]),
      {
        today: TODAY,
        nvmrc: '24\n',
        dependencies: { widget: '1.0.0', gadget: '2.0.0' },
        lockVersions: { widget: '1.0.1' },
        workflowRuntimes: [
          { name: 'Python', version: '3.12', file: '.github/workflows/ci.yml' },
          { name: 'Node.js', version: '22', file: '.github/workflows/ci.yml' },
        ],
      },
    );
    assert.deepEqual(problems, [
      'Widget 1.0.0: package-lock.json has widget@1.0.1; update the register',
      'Node.js 22: .nvmrc names Node.js 24; update the register',
      'the production dependency gadget has no entry in the register',
      '.github/workflows/ci.yml runs Python 3.12, which has no runtime entry in the register',
    ]);
  });
});

describe('workflow runtimes', () => {
  it('reads literal versions and matrix lists, not expressions', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'starpi-workflows-'));
    writeFileSync(
      path.join(dir, 'ci.yml'),
      ["      node-version: 22", "        python: ['3.11', \"3.13\"]", '          python-version: ${{ matrix.python }}', "          python-version: '3.12'"].join('\n'),
    );
    assert.deepEqual(
      workflowRuntimes(dir).map((r) => `${r.name} ${r.version}`),
      ['Node.js 22', 'Python 3.12', 'Python 3.11', 'Python 3.13'],
    );
  });
});

describe('npm run eol:check', () => {
  it('passes on this repository today, and the register names the runtimes and libraries the plan tracks', () => {
    const reg = JSON.parse(readFileSync(DEFAULT_REGISTER, 'utf8'));
    const { problems } = evaluateRegister(reg, { today: TODAY, ...repoFacts(ROOT) });
    assert.deepEqual(problems, []);
    const has = (/** @type {string} */ name, /** @type {string} */ version) => reg.components.some((/** @type {{ name: string, version: string }} */ c) => c.name === name && c.version.startsWith(version));
    for (const [name, version] of [['Node.js', '22'], ['Node.js', '24'], ['Python', '3.11'], ['Python', '3.12'], ['Python', '3.13'], ['Tailwind CSS', '3'], ['pdf.js', ''], ['WebLLM', ''], ['Transformers.js', '']]) {
      assert.ok(has(name, version), `${name} ${version}`);
    }
    const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/eol-check.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
    const ok = run(['--today', '2026-10-16']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /warning: Node\.js 22 reaches its end of life on 2027-04-30/);
    // A release gate refuses what reaches its end of life within the horizon.
    assert.equal(run(['--today', '2026-10-16', '--strict']).status, 1);
    // Once a date has passed, the gate fails even without --strict.
    assert.equal(run(['--today', '2027-05-01']).status, 1);
    assert.equal(run(['--today', '16.10.2026']).status, 2);
  });
});
