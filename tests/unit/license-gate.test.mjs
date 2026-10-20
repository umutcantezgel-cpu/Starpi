// License gate (scripts/license-gate.mjs): SPDX expressions, the production tree of a lockfile,
// packages that never ship, and the gate over this repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkLicenses, evaluateLicense, manifestLicense, parseLicenseExpression, productionTree, resolveDependency } from '../../scripts/license-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY = JSON.parse(readFileSync(path.join(ROOT, 'scripts/license-allowlist.json'), 'utf8'));

describe('license expressions', () => {
  it('parses AND before OR, WITH and parentheses', () => {
    assert.deepEqual(parseLicenseExpression('MIT'), { type: 'id', id: 'MIT' });
    assert.deepEqual(parseLicenseExpression('MIT OR Apache-2.0 AND BSD-3-Clause'), {
      type: 'or',
      parts: [{ type: 'id', id: 'MIT' }, { type: 'and', parts: [{ type: 'id', id: 'Apache-2.0' }, { type: 'id', id: 'BSD-3-Clause' }] }],
    });
    assert.deepEqual(parseLicenseExpression('(GPL-2.0-only with Classpath-exception-2.0)'), { type: 'with', id: 'GPL-2.0-only', exception: 'Classpath-exception-2.0' });
    for (const bad of ['', 'MIT OR', '(MIT', 'MIT)', 'AND MIT']) assert.throws(() => parseLicenseExpression(bad), undefined, bad);
  });

  it('judges permissive, copyleft and unknown licenses', () => {
    const verdict = (/** @type {string | null} */ expression) => evaluateLicense(expression, POLICY).verdict;
    assert.equal(verdict('MIT'), 'allowed');
    assert.equal(verdict('bsd-3-clause'), 'allowed');
    assert.equal(verdict('(MPL-2.0 OR Apache-2.0)'), 'allowed');
    assert.equal(verdict('MIT AND OFL-1.1'), 'allowed');
    assert.equal(verdict('Apache-2.0 AND LGPL-3.0-or-later'), 'forbidden');
    assert.equal(verdict('GPL-3.0-only'), 'forbidden');
    assert.equal(verdict('EPL-2.0'), 'forbidden');
    assert.equal(verdict('CC-BY-NC-4.0'), 'forbidden');
    assert.equal(verdict('SSPL-1.0'), 'forbidden');
    assert.equal(verdict('WTFPL'), 'unknown');
    assert.equal(verdict('SEE LICENSE IN LICENSE.md'), 'unknown');
    assert.equal(verdict(null), 'unknown');
    assert.equal(verdict('GPL-2.0-only WITH Classpath-exception-2.0'), 'forbidden');
  });

  it('reads the license fields of package.json in their old and new shapes', () => {
    assert.equal(manifestLicense({ license: ' MIT ' }), 'MIT');
    assert.equal(manifestLicense({ license: { type: 'ISC' } }), 'ISC');
    assert.equal(manifestLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), '(MIT OR Apache-2.0)');
    assert.equal(manifestLicense({}), null);
  });
});

/**
 * A checkout with a lockfile and installed package.json files.
 * @param {Record<string, Record<string, unknown>>} packages lockfile "packages"
 * @param {Record<string, Record<string, unknown>>} [installed] key -> installed package.json
 */
function checkout(packages, installed = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'starpi-licenses-'));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  for (const [key, manifest] of Object.entries(installed)) {
    mkdirSync(path.join(root, key), { recursive: true });
    writeFileSync(path.join(root, key, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

const LOCK = {
  '': { name: 'app', dependencies: { lib: '1.0.0', 'image-backend': '1.0.0' }, devDependencies: { tool: '1.0.0' } },
  'node_modules/lib': { version: '1.0.0', license: 'MIT', dependencies: { inner: '^2.0.0' }, optionalDependencies: { 'other-platform': '1.0.0' } },
  'node_modules/lib/node_modules/inner': { version: '2.1.0', license: 'ISC' },
  'node_modules/inner': { version: '1.0.0', license: 'GPL-3.0-only' },
  'node_modules/image-backend': { version: '1.0.0', license: 'Apache-2.0', optionalDependencies: { 'native-lib': '1.0.0' } },
  'node_modules/native-lib': { version: '1.0.0', license: 'LGPL-3.0-or-later' },
  'node_modules/tool': { version: '1.0.0', dev: true, license: 'GPL-3.0-only' },
};

describe('production tree', () => {
  it('resolves like Node: the nearest node_modules first', () => {
    assert.equal(resolveDependency(LOCK, 'node_modules/lib', 'inner'), 'node_modules/lib/node_modules/inner');
    assert.equal(resolveDependency(LOCK, '', 'inner'), 'node_modules/inner');
    assert.equal(resolveDependency(LOCK, 'node_modules/lib', 'missing'), null);
  });

  it('leaves development tooling out and tolerates a missing optional dependency', () => {
    const tree = productionTree({ lockfileVersion: 3, packages: LOCK });
    assert.deepEqual(tree.keys, ['node_modules/image-backend', 'node_modules/lib', 'node_modules/lib/node_modules/inner', 'node_modules/native-lib']);
    assert.deepEqual(tree.problems, []);
    const broken = productionTree({ lockfileVersion: 3, packages: { '': { dependencies: { gone: '1.0.0' } } } });
    assert.deepEqual(broken.problems, ['package.json needs gone, which package-lock.json does not have']);
  });

  it('skips a package that never ships, and what only it pulls in', () => {
    const tree = productionTree({ lockfileVersion: 3, packages: LOCK }, { skip: ['image-backend'] });
    assert.deepEqual(tree.keys, ['node_modules/lib', 'node_modules/lib/node_modules/inner']);
    assert.deepEqual(tree.skipped, ['node_modules/image-backend']);
  });
});

describe('checkLicenses', () => {
  it('fails on a forbidden license in the shipped tree and passes once it is declared never shipped', () => {
    const root = checkout(LOCK);
    const failed = checkLicenses({ root, policy: POLICY });
    assert.deepEqual(failed.problems, ['native-lib@1.0.0 (node_modules/native-lib): LGPL-3.0-or-later, LGPL-3.0-or-later is forbidden']);
    const passed = checkLicenses({ root, policy: { ...POLICY, notShipped: { 'image-backend': { reason: 'server-side only' } } } });
    assert.deepEqual(passed.problems, []);
    assert.deepEqual(passed.skipped, ['node_modules/image-backend']);
    const unexplained = checkLicenses({ root, policy: { ...POLICY, notShipped: { 'image-backend': { reason: ' ' } } } });
    assert.ok(unexplained.problems.some((p) => p.includes('notShipped["image-backend"] needs the "reason"')));
  });

  it('prefers the installed package.json and reports a version or license that disagrees with the lockfile', () => {
    const root = checkout(
      { '': { dependencies: { a: '1.0.0', b: '1.0.0' } }, 'node_modules/a': { version: '1.0.0', license: 'MIT' }, 'node_modules/b': { version: '1.0.0' } },
      { 'node_modules/a': { version: '1.0.1', license: 'ISC' }, 'node_modules/b': { version: '1.0.0', license: 'BSD-2-Clause' } },
    );
    const { packages, problems } = checkLicenses({ root, policy: POLICY });
    assert.deepEqual(packages.map((p) => [p.name, p.license, p.source]), [['a', 'ISC', 'node_modules'], ['b', 'BSD-2-Clause', 'node_modules']]);
    assert.ok(problems.some((p) => p.includes('node_modules has 1.0.1, package-lock.json 1.0.0')));
    assert.ok(problems.some((p) => p.includes('says "ISC", package-lock.json "MIT"')));
  });

  it('takes a reviewed fact for a release without license metadata, but only with evidence', () => {
    const root = checkout({ '': { dependencies: { bare: '1.0.0' } }, 'node_modules/bare': { version: '1.0.0' } });
    assert.ok(checkLicenses({ root, policy: POLICY }).problems.some((p) => p.includes('no license declared')));
    const reviewed = { ...POLICY, packages: { 'bare@1.0.0': { license: 'MIT', evidence: 'https://example.org/bare/1.0.0/LICENSE' } } };
    assert.deepEqual(checkLicenses({ root, policy: reviewed }).problems, []);
    const noEvidence = { ...POLICY, packages: { 'bare@1.0.0': { license: 'MIT', evidence: '' } } };
    assert.ok(checkLicenses({ root, policy: noEvidence }).problems.some((p) => p.includes('needs a "license" and the "evidence"')));
  });
});

describe('npm run license:check', () => {
  it('passes on this repository and covers every production dependency', () => {
    const { packages, skipped, problems } = checkLicenses();
    assert.deepEqual(problems, []);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const name of Object.keys(pkg.dependencies)) assert.ok(packages.some((p) => p.name === name), name);
    assert.ok(!packages.some((p) => p.name === 'esbuild' || p.name === 'eslint'), 'development tooling never counts');
    assert.deepEqual(skipped, ['node_modules/sharp']);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/license-gate.mjs')], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^license-gate: OK \(\d+ production packages/);
  });
});
