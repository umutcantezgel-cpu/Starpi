// Tooling of the local companion: the dependency check (scripts/companion-deps-check.mjs) and the
// licence check (scripts/companion-license-check.mjs), over this repository and over small trees
// made for each rule.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDependencies, maskComments, packageOf, RESTRICTED, specifiersOf } from '../../scripts/companion-deps-check.mjs';
import { checkCompanionLicenses, parseRequirements, PYTHON_REVIEWED } from '../../scripts/companion-license-check.mjs';
import { companionDependencies } from '../../scripts/companion-offline-pack.mjs';
import { readLockfile } from '../../scripts/license-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'companion-tooling-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A package folder with the given files below it.
 * @param {string} name
 * @param {Record<string, string>} files
 * @param {Record<string, string>} [dependencies]
 */
function fakePackage(name, files, dependencies = {}) {
  const root = path.join(scratch, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@example/pkg', dependencies }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

describe('companion dependency check', () => {
  it('passes over the companion as it is', () => {
    const report = checkDependencies();
    assert.deepEqual(report.findings, []);
    assert.ok(report.files > 50, `only ${report.files} files scanned`);
  });

  it('reads static, re-exported, dynamic and built-in module names, not those in comments', () => {
    const src = [
      "import a from 'node:fs';",
      "import { b, c } from './b.js';",
      "export { d } from '../d.js';",
      "export * from './e.js';",
      "import './side-effect.js';",
      "const sdk = () => import('@scope/sdk/sub');",
      "const net = process.getBuiltinModule('net');",
      "/** @type {import('../types.js').T} */",
      "// import x from 'commented-out';",
      'const re = /\\/\\/ not a comment/g;',
      "const s = 'it is // inside a string';",
      "const t = `template ${import('./in-template.js')} //`;",
      'const later = import(name);',
    ].join('\n');
    const { specifiers, computed } = specifiersOf(src);
    assert.deepEqual(
      specifiers.map((s) => s.spec),
      ['node:fs', './b.js', '../d.js', './e.js', './side-effect.js', '@scope/sdk/sub', 'node:net', './in-template.js'],
    );
    assert.deepEqual(computed, [13]);
    assert.equal(packageOf('@scope/sdk/sub'), '@scope/sdk');
    assert.equal(packageOf('lodash/fp'), 'lodash');
    assert.ok(!maskComments(src).includes('commented-out'));
  });

  it('reads every spelling of getBuiltinModule and reports the ones it cannot follow', () => {
    const literal = [
      "const a = process.getBuiltinModule?.('child_process');",
      'const b = process["getBuiltinModule"]("node:dns");',
      "const c = process['getBuiltinModule']?.('tls');",
      'const d = process[`getBuiltinModule`]("cluster");',
    ];
    assert.deepEqual(
      specifiersOf(literal.join('\n')).specifiers.map((s) => s.spec),
      ['node:child_process', 'node:dns', 'node:tls', 'node:cluster'],
    );
    const unfollowable = [
      'const load = process.getBuiltinModule;',
      "const e = process.getBuiltinModule.call(process, 'child_process');",
      "const f = Reflect.get(process, 'getBuiltinModule')('child_process');",
      'const g = process.getBuiltinModule(name);',
    ];
    const { specifiers, computed } = specifiersOf(unfollowable.join('\n'));
    assert.deepEqual(specifiers, []);
    assert.deepEqual(computed, [1, 2, 3, 4]);
  });

  it('does not read a member call named import or require as a module import', () => {
    const src = [
      "const script = 'function run() { ObjC.import(\"Cocoa\"); }';",
      "loader.require('left-pad');",
      'obj.import(dynamicName);',
    ].join('\n');
    const { specifiers, computed } = specifiersOf(src);
    assert.deepEqual(specifiers, []);
    assert.deepEqual(computed, []);
  });

  it('reports every rule', () => {
    const root = fakePackage('bad', {
      'src/a.js': "import fs from 'fs';\nimport x from 'left-pad';\nimport y from '../../outside.js';\nimport cp from 'node:child_process';\nimport z from 'node:nothing';\nconst m = import(dynamicName);\n",
      'src/brain/other.js': "const sdk = () => import('@anthropic-ai/sdk');\n",
      'deploy/tool.mjs': "import { x } from '../src/a.js';\n",
    }, { '@anthropic-ai/sdk': '1.0.0', unused: '1.0.0' });
    const rules = checkDependencies({ root }).findings.map((f) => `${f.file}:${f.rule}`).sort();
    assert.deepEqual(rules, [
      'deploy/tool.mjs:deploy-import',
      'package.json:unused',
      'src/a.js:computed',
      'src/a.js:node-prefix',
      'src/a.js:outside',
      'src/a.js:restricted',
      'src/a.js:undeclared',
      'src/a.js:unknown-builtin',
      'src/brain/other.js:restricted',
    ]);
  });

  it('lets the owning files import their restricted modules', () => {
    const root = fakePackage('owners', {
      'src/egress/guard.js': "import dns from 'node:dns';\nimport tls from 'node:tls';\nconst m = process.getBuiltinModule('node:module');\n",
      'src/egress/splice.js': "import dns from 'node:dns';\n",
      'src/brain/anthropic.js': "const sdk = () => import('@anthropic-ai/sdk');\n",
      'src/vault/kek/runner.js': "import cp from 'node:child_process';\n",
    }, { '@anthropic-ai/sdk': '1.0.0' });
    assert.deepEqual(checkDependencies({ root }).findings, []);
    assert.ok(RESTRICTED['node:child_process'].files.includes('src/vault/kek/runner.js'));
  });
});

describe('companion licence check', () => {
  it('passes over this repository and names what ships', () => {
    const report = checkCompanionLicenses();
    assert.deepEqual(report.findings, []);
    assert.ok(report.dependencies.some((d) => d.name === '@anthropic-ai/sdk'));
    assert.deepEqual(report.python.map((p) => [p.name, p.use]), [['faster-whisper', 'imported'], ['piper-tts', 'program']]);
    assert.ok(report.voices > 0);
  });

  it('accepts exact pins only', () => {
    const { pins, problems } = parseRequirements('# comment\nfaster-whisper==1.2.1  # pinned\n\nnumpy>=2\nrequests\nPiper_TTS==1.8.0\n');
    assert.deepEqual(pins.map((p) => `${p.name}==${p.version}`), ['faster-whisper==1.2.1', 'piper-tts==1.8.0']);
    assert.equal(problems.length, 2);
    assert.equal(PYTHON_REVIEWED['piper-tts'].use, 'program');
  });

  it('finds a GPL program imported, an unreviewed package, a changed voice list and a missing attribution', () => {
    const root = path.join(scratch, 'repo');
    for (const rel of ['package.json', 'package-lock.json', 'scripts/license-allowlist.json', 'api/_lib/voice-allowlist.json']) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      cpSync(path.join(ROOT, rel), path.join(root, rel));
    }
    cpSync(path.join(ROOT, 'packages/companion'), path.join(root, 'packages/companion'), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
    cpSync(path.join(ROOT, 'companion/voice-server'), path.join(root, 'companion/voice-server'), { recursive: true });
    // The check reads the installed manifest of every dependency, so those come along.
    for (const dep of companionDependencies(readLockfile(ROOT)).deps) {
      mkdirSync(path.join(root, dep.key), { recursive: true });
      cpSync(path.join(ROOT, dep.key, 'package.json'), path.join(root, dep.key, 'package.json'));
    }
    assert.deepEqual(checkCompanionLicenses({ root }).findings, []);

    const server = path.join(root, 'companion/voice-server/server.py');
    writeFileSync(server, `${readFileSync(server, 'utf8')}\nfrom piper import PiperVoice\n`);
    writeFileSync(path.join(root, 'companion/voice-server/requirements.txt'), 'faster-whisper==1.2.1\npiper-tts==1.8.0\nsomething-new==0.1\n');
    const list = JSON.parse(readFileSync(path.join(root, 'companion/voice-server/allowlist.json'), 'utf8'));
    list.voices[0].license = 'CC-BY-NC-4.0';
    writeFileSync(path.join(root, 'companion/voice-server/allowlist.json'), JSON.stringify(list));
    writeFileSync(path.join(root, 'packages/companion/NOTICE'), 'No attributions.\n');
    const findings = checkCompanionLicenses({ root }).findings.join('\n');
    assert.match(findings, /server\.py imports piper/);
    assert.match(findings, /something-new has not been reviewed/);
    assert.match(findings, /differs from api\/_lib\/voice-allowlist\.json/);
    assert.match(findings, /licence CC-BY-NC-4\.0 is not one that allows any use/);
    assert.match(findings, /NOTICE does not name LICENSES\/openclaw-MIT\.txt/);
  });
});
