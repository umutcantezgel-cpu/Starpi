#!/usr/bin/env node
// @ts-check
// Dependency check of the local companion (packages/companion). It reads every module specifier
// of the shipped code (bin/, src/, deploy/; not test/) and reports:
//   - a bare package that package.json does not declare (dependencies, optionalDependencies,
//     peerDependencies), or a declared runtime dependency that nothing imports;
//   - a Node.js built-in without the `node:` prefix, or a `node:` name Node does not have;
//   - a relative import that leaves the package (it would break once the package is installed
//     on its own), and any import at all but `node:` built-ins in deploy/ (those files run from
//     the offline bundle, outside app/, before anything is installed);
//   - a computed specifier (`import(name)`, `require(name)`, `process.getBuiltinModule(name)`),
//     which no review can follow (getBuiltinModule with a literal name counts as an import);
//   - a module that only certain files may import (RESTRICTED below): the companion forbids
//     spawning and patches the network stack in one place, so the modules that could go around
//     that stay in the files that own them.
// Comments are masked before matching, so JSDoc type imports do not count; string contents stay.
//
// Usage: node scripts/companion-deps-check.mjs [--root <package folder>] [--json]
// Exit: 0 clean, 1 findings, 2 usage or read error.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(SCRIPTS, '..');
export const PACKAGE = path.join(ROOT, 'packages', 'companion');
export const SCANNED = Object.freeze(['bin', 'src', 'deploy']);

/**
 * Modules that only the listed files (or folders, ending in "/") may import, with the reason.
 * @type {Readonly<Record<string, { files: readonly string[], reason: string }>>}
 */
export const RESTRICTED = Object.freeze({
  'node:child_process': { files: ['src/vault/kek/runner.js', 'src/egress/guard.js'], reason: 'spawning is forbidden; the runner starts fixed programs and the guard blocks the rest' },
  'node:cluster': { files: ['src/egress/guard.js'], reason: 'a forked worker would run outside the egress guard' },
  'node:worker_threads': { files: ['src/egress/guard.js'], reason: 'a worker thread would run outside the egress guard' },
  'node:module': { files: ['src/egress/guard.js'], reason: 'loader hooks run off the main thread, outside the egress guard' },
  'node:dgram': { files: ['src/egress/guard.js'], reason: 'datagram sockets are guarded in one place' },
  'node:tls': { files: ['src/egress/guard.js'], reason: 'TLS connections go through the guard or a capability' },
  'node:https': { files: ['src/egress/guard.js'], reason: 'HTTPS goes through the guard or a capability' },
  'node:dns': { files: ['src/egress/guard.js', 'src/egress/splice.js'], reason: 'name lookups are guarded; only the splice resolves hosts itself' },
  '@anthropic-ai/sdk': { files: ['src/brain/anthropic.js'], reason: 'the SDK is loaded by the Anthropic brain only, and only when it is configured' },
});

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

/**
 * The source with every comment replaced by spaces (line breaks kept), strings, templates and
 * regular expression literals left as they are.
 * @param {string} src
 * @returns {string}
 */
export function maskComments(src) {
  const out = src.split('');
  /** @type {Array<'code' | 'template'>} */
  const stack = ['code'];
  /** @type {number[]} */
  const braces = [0];
  let last = ''; // the last significant code character or word, for the regex-or-division question
  let i = 0;
  const blank = (/** @type {number} */ from, /** @type {number} */ to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const regexAllowed = () => last === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || KEYWORDS_BEFORE_REGEX.has(last);
  while (i < src.length) {
    const mode = stack[stack.length - 1];
    const ch = src[i];
    if (mode === 'template') {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        stack.pop();
        i += 1;
        last = '`';
      } else if (ch === '$' && src[i + 1] === '{') {
        stack.push('code');
        braces.push(0);
        i += 2;
        last = '{';
      } else i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
      last = ch;
    } else if (ch === '`') {
      stack.push('template');
      i += 1;
    } else if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '[') (inClass = true), (j += 1);
        else if (src[j] === ']') (inClass = false), (j += 1);
        else if (src[j] === '/' && !inClass) break;
        else j += 1;
      }
      i = j + 1;
      while (i < src.length && /[a-z]/i.test(src[i])) i += 1;
      last = 'regex';
    } else if (ch === '{') {
      braces[braces.length - 1] += 1;
      last = ch;
      i += 1;
    } else if (ch === '}') {
      if (braces[braces.length - 1] === 0 && stack.length > 1) {
        stack.pop();
        braces.pop();
      } else braces[braces.length - 1] -= 1;
      last = ch;
      i += 1;
    } else if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j += 1;
      last = src.slice(i, j);
      i = j;
    } else {
      if (!/\s/.test(ch)) last = ch;
      i += 1;
    }
  }
  return out.join('');
}

/**
 * The module specifiers of a source text.
 * @param {string} src
 * @returns {{ specifiers: Array<{ spec: string, line: number }>, computed: number[] }}
 */
export function specifiersOf(src) {
  const code = maskComments(src);
  const lineAt = (/** @type {number} */ index) => code.slice(0, index).split('\n').length;
  /** @type {Array<{ spec: string, line: number }>} */
  const specifiers = [];
  const patterns = [
    /\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?(['"])([^'"\n]+)\1/g,
    /\bexport\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*[,)]/g,
    /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const key = `${match.index}:${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      specifiers.push({ spec: match[2], line: lineAt(match.index ?? 0) });
    }
  }
  // process.getBuiltinModule() reaches a built-in without an import; its name may lack the prefix.
  for (const match of code.matchAll(/\bgetBuiltinModule\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g)) {
    specifiers.push({ spec: match[2].startsWith('node:') ? match[2] : `node:${match[2]}`, line: lineAt(match.index ?? 0) });
  }
  /** @type {number[]} */
  const computed = [];
  for (const match of code.matchAll(/\b(?:import|require|getBuiltinModule)\s*\(\s*(?!['"])/g)) computed.push(lineAt(match.index ?? 0));
  return { specifiers: specifiers.sort((a, b) => a.line - b.line), computed };
}

/**
 * The package name of a bare specifier ("@scope/name/sub" -> "@scope/name").
 * @param {string} spec
 */
export function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** @param {string} dir @param {string} base @returns {string[]} */
function sourceFiles(dir, base) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const files = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory() && item.name !== 'node_modules') files.push(...sourceFiles(full, base));
    else if (item.isFile() && /\.(?:js|mjs|cjs)$/.test(item.name)) files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files.sort();
}

/** @param {string} file @param {string} rule */
function allowedFor(file, rule) {
  return RESTRICTED[rule].files.some((f) => (f.endsWith('/') ? file.startsWith(f) : file === f));
}

/**
 * Runs the check over a package folder.
 * @param {{ root?: string }} [options]
 * @returns {{ files: number, findings: Array<{ file: string, line: number, rule: string, message: string }> }}
 */
export function checkDependencies({ root = PACKAGE } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));
  /** @type {Array<{ file: string, line: number, rule: string, message: string }>} */
  const findings = [];
  const used = new Set();
  const files = SCANNED.flatMap((dir) => sourceFiles(path.join(root, dir), root));
  for (const file of files) {
    const { specifiers, computed } = specifiersOf(readFileSync(path.join(root, file), 'utf8'));
    const add = (/** @type {number} */ line, /** @type {string} */ rule, /** @type {string} */ message) => findings.push({ file, line, rule, message });
    for (const line of computed) add(line, 'computed', 'a computed specifier cannot be checked; name the module as a string');
    const inDeploy = file.startsWith('deploy/');
    for (const { spec, line } of specifiers) {
      if (spec.startsWith('node:')) {
        if (!builtins.has(spec.slice(5).split('/')[0])) add(line, 'unknown-builtin', `${spec} is not a Node.js built-in`);
      } else if (spec.startsWith('.') || spec.startsWith('/')) {
        if (inDeploy) add(line, 'deploy-import', `deploy/ files run on their own from the bundle and may import node: built-ins only (${spec})`);
        const target = path.resolve(path.dirname(path.join(root, file)), spec);
        const rel = path.relative(root, target);
        if (spec.startsWith('/') || rel.startsWith('..') || path.isAbsolute(rel)) add(line, 'outside', `${spec} leaves the package`);
      } else if (builtins.has(spec.split('/')[0]) && !spec.startsWith('@')) {
        add(line, 'node-prefix', `write node:${spec}, so a package of that name can never stand in for the built-in`);
      } else {
        const name = packageOf(spec);
        if (inDeploy) add(line, 'deploy-import', `deploy/ files run on their own from the bundle and may import node: built-ins only (${spec})`);
        else if (name !== manifest.name && !declared.has(name)) add(line, 'undeclared', `${name} is not declared in package.json`);
        used.add(name);
      }
      const rule = spec.startsWith('node:') ? spec.split('/')[0] : spec.startsWith('.') ? null : packageOf(spec);
      if (rule && Object.hasOwn(RESTRICTED, rule) && !allowedFor(file, rule)) add(line, 'restricted', `${rule} may be imported only by ${RESTRICTED[rule].files.join(', ')}: ${RESTRICTED[rule].reason}`);
    }
  }
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!used.has(name)) findings.push({ file: 'package.json', line: 0, rule: 'unused', message: `${name} is a dependency that no shipped file imports` });
  }
  return { files: files.length, findings };
}

/** @param {string[]} args  the command line after the script */
export function main(args) {
  const argv = args;
  const at = argv.indexOf('--root');
  if (at >= 0 && !argv[at + 1]) {
    process.stderr.write('usage: node scripts/companion-deps-check.mjs [--root <package folder>] [--json]\n');
    return 2;
  }
  let report;
  try {
    report = checkDependencies({ root: at >= 0 ? path.resolve(argv[at + 1]) : PACKAGE });
  } catch (err) {
    process.stderr.write(`companion-deps-check: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (report.findings.length === 0) process.stdout.write(`companion-deps-check: OK (${report.files} files)\n`);
  else process.stderr.write(`companion-deps-check: ${report.findings.length} finding(s)\n${report.findings.map((f) => ` - ${f.file}:${f.line} [${f.rule}] ${f.message}`).join('\n')}\n`);
  return report.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
