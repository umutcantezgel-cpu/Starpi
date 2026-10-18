#!/usr/bin/env node
// @ts-check
// Licence check of what the companion ships, beside the browser app's gate (license-gate.mjs,
// which starts from the root package.json and so never sees the companion's own tree):
//   1. every production dependency of packages/companion, resolved through package-lock.json
//      from the companion's folder, is installed at the pinned version and has a licence that
//      scripts/license-allowlist.json allows (the offline bundle copies exactly these);
//   2. the companion itself is MIT with its LICENSE, and NOTICE names every text in LICENSES/;
//   3. the voice server's requirements are exact pins of reviewed Python packages: those it
//      imports have an allowed licence, those it only starts as a separate program (Piper,
//      GPL-3.0-or-later) are never imported by server.py;
//   4. companion/voice-server/allowlist.json is byte-identical to api/_lib/voice-allowlist.json,
//      and every voice on it names a licence that allows any use.
//
// Usage: node scripts/companion-license-check.mjs [--root <repository>] [--json]
// Exit: 0 clean, 1 findings, 2 usage or read error.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLockfile } from './license-gate.mjs';
import { checkDependencies, companionDependencies, COMPANION, VOICE_SERVER } from './companion-offline-pack.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Python packages the voice server may require, reviewed by hand. `imported`: server.py imports
 * it, so its licence must be allowed. `program`: run only as a separate program, never imported.
 * @type {Readonly<Record<string, { license: string, use: 'imported' | 'program', evidence: string }>>}
 */
export const PYTHON_REVIEWED = Object.freeze({
  'faster-whisper': { license: 'MIT', use: 'imported', evidence: 'https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE' },
  'piper-tts': { license: 'GPL-3.0-or-later', use: 'program', evidence: 'https://github.com/OHF-Voice/piper1-gpl/blob/main/COPYING' },
});
/** The Python module name of a requirement, for the import check. */
const MODULE_OF = Object.freeze(/** @type {Record<string, string>} */ ({ 'faster-whisper': 'faster_whisper', 'piper-tts': 'piper' }));
/** Licences of voice training data that allow any use (the same set server.py accepts). */
export const OPEN_VOICE_LICENSES = Object.freeze(['CC0-1.0', 'CC-BY-4.0', 'MIT', 'Apache-2.0', 'LicenseRef-public-domain']);

/**
 * Parses requirements.txt: comments and blank lines skipped, every other line must be
 * `name==version`.
 * @param {string} text
 * @returns {{ pins: Array<{ name: string, version: string, line: number }>, problems: string[] }}
 */
export function parseRequirements(text) {
  /** @type {Array<{ name: string, version: string, line: number }>} */
  const pins = [];
  /** @type {string[]} */
  const problems = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][0-9A-Za-z.+!-]*)$/.exec(line);
    if (!match) problems.push(`requirements.txt line ${index + 1}: "${line}" is not an exact pin (name==version)`);
    else pins.push({ name: match[1].toLowerCase().replace(/[._]/g, '-'), version: match[2], line: index + 1 });
  });
  return { pins, problems };
}

/**
 * Runs every check.
 * @param {{ root?: string }} [options]
 * @returns {{ dependencies: Array<{ name: string, version: string, license: string | null }>, python: Array<{ name: string, version: string, license: string, use: string }>, voices: number, findings: string[] }}
 */
export function checkCompanionLicenses({ root = ROOT } = {}) {
  /** @type {string[]} */
  const findings = [];
  const read = (/** @type {string} */ rel) => readFileSync(path.join(root, rel), 'utf8');
  const policy = JSON.parse(read('scripts/license-allowlist.json'));

  // 1. The npm tree.
  const lock = readLockfile(root);
  const { deps, problems } = companionDependencies(lock, { root });
  findings.push(...problems, ...checkDependencies(deps, lock, policy, root));

  // 2. The package's own licence and attributions.
  const manifest = JSON.parse(read(`${COMPANION}/package.json`));
  if (manifest.license !== 'MIT') findings.push(`${COMPANION}/package.json: license is ${manifest.license}, expected MIT`);
  if (!existsSync(path.join(root, COMPANION, 'LICENSE'))) findings.push(`${COMPANION}/LICENSE is missing`);
  const noticePath = path.join(root, COMPANION, 'NOTICE');
  const notice = existsSync(noticePath) ? readFileSync(noticePath, 'utf8') : null;
  const texts = existsSync(path.join(root, COMPANION, 'LICENSES')) ? readdirSync(path.join(root, COMPANION, 'LICENSES')).filter((f) => !f.startsWith('.')) : [];
  if (texts.length > 0 && notice === null) findings.push(`${COMPANION}/NOTICE is missing although LICENSES/ holds ${texts.length} text(s)`);
  for (const text of texts) {
    if (notice !== null && !notice.includes(text)) findings.push(`${COMPANION}/NOTICE does not name LICENSES/${text}`);
  }
  for (const item of ['LICENSE', 'NOTICE', 'LICENSES']) {
    if (existsSync(path.join(root, COMPANION, item)) && !(manifest.files ?? []).includes(item)) findings.push(`${COMPANION}/package.json "files" leaves out ${item}`);
  }

  // 3. The voice server's Python requirements.
  const { pins, problems: pinProblems } = parseRequirements(read(`${VOICE_SERVER}/requirements.txt`));
  findings.push(...pinProblems);
  const server = read(`${VOICE_SERVER}/server.py`);
  /** @type {Array<{ name: string, version: string, license: string, use: string }>} */
  const python = [];
  for (const pin of pins) {
    const fact = PYTHON_REVIEWED[pin.name];
    if (!fact) {
      findings.push(`requirements.txt line ${pin.line}: ${pin.name} has not been reviewed (add it to PYTHON_REVIEWED with its licence)`);
      continue;
    }
    python.push({ name: pin.name, version: pin.version, license: fact.license, use: fact.use });
    const module = MODULE_OF[pin.name] ?? pin.name.replace(/-/g, '_');
    const imported = new RegExp(`^\\s*(?:import\\s+${module}\\b|from\\s+${module}(?:\\.[\\w.]+)?\\s+import\\b)`, 'm').test(server);
    if (fact.use === 'program' && imported) findings.push(`server.py imports ${module}, which is ${fact.license} and may only run as a separate program`);
    if (fact.use === 'imported') {
      const allowed = (policy.allowed ?? []).some((/** @type {string} */ id) => id.toLowerCase() === fact.license.toLowerCase());
      if (!allowed) findings.push(`${pin.name} is imported by server.py but its licence ${fact.license} is not on the allowlist`);
    }
  }

  // 4. The voice allowlist.
  const appList = path.join(root, 'api', '_lib', 'voice-allowlist.json');
  const ownList = path.join(root, VOICE_SERVER, 'allowlist.json');
  let voices = 0;
  if (!existsSync(ownList)) findings.push(`${VOICE_SERVER}/allowlist.json is missing`);
  else {
    if (existsSync(appList) && !readFileSync(appList).equals(readFileSync(ownList))) findings.push(`${VOICE_SERVER}/allowlist.json differs from api/_lib/voice-allowlist.json; copy the app's list`);
    const list = JSON.parse(readFileSync(ownList, 'utf8'));
    for (const voice of Array.isArray(list?.voices) ? list.voices : []) {
      voices += 1;
      if (!OPEN_VOICE_LICENSES.includes(voice?.license)) findings.push(`voice ${voice?.id}: licence ${voice?.license} is not one that allows any use`);
    }
    if (voices === 0) findings.push(`${VOICE_SERVER}/allowlist.json lists no voices`);
  }
  return { dependencies: deps.map(({ name, version, license }) => ({ name, version, license })), python, voices, findings };
}

/** @param {string[]} argv */
export function main(argv) {
  const at = argv.indexOf('--root');
  if (at >= 0 && !argv[at + 1]) {
    process.stderr.write('usage: node scripts/companion-license-check.mjs [--root <repository>] [--json]\n');
    return 2;
  }
  let report;
  try {
    report = checkCompanionLicenses({ root: at >= 0 ? path.resolve(argv[at + 1]) : ROOT });
  } catch (err) {
    process.stderr.write(`companion-license-check: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (report.findings.length === 0) {
    const npm = report.dependencies.map((d) => `${d.name}@${d.version} ${d.license}`).join(', ');
    const py = report.python.map((p) => `${p.name}==${p.version} ${p.license} (${p.use})`).join(', ');
    process.stdout.write(`companion-license-check: OK\n  npm: ${npm || 'none'}\n  python: ${py || 'none'}\n  voices: ${report.voices}, all with open licences\n`);
  } else process.stderr.write(`companion-license-check: ${report.findings.length} finding(s)\n - ${report.findings.join('\n - ')}\n`);
  return report.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
