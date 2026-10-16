#!/usr/bin/env node
// Public hygiene check. This repository is public: generic infrastructure may be shared with
// related projects of the same author, but their names, private paths and internal identifiers
// must never enter it (docs/PORTING.md). The check scans every tracked file (`git ls-files`, the
// working-tree content and the path) and, with --range A..B, the commit messages of that range for
// generic patterns: absolute paths into personal home directories, the prefixes and markers of a
// related private project, and the shapes of internal ids (decision, work-package and requirement
// numbers). It holds no list of private terms; those are checked outside this repository.
//
// A legitimate hit is allowed in one of two ways:
//   - on the same line: `hygiene-allow: <reason>` (in a comment; the reason is required);
//   - in scripts/public-hygiene.allow.json: { "path" | "commit", "rule"?, "line"?, "reason" }, for
//     files that cannot carry a comment. Name the file and the rule; do not repeat the matched text.
//
// Usage: node scripts/public-hygiene.mjs [--range A..B] [--root <dir>]
// Exit code 0 when clean, 1 with one `file:line:column` line per finding, 2 on a usage or git error.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Repository-relative path of the allowlist. */
export const ALLOW_FILE = 'scripts/public-hygiene.allow.json';

/** Marker of an inline allow comment; the reason follows it. */
const ALLOW_MARK = /hygiene-allow:\s*(\S.*)?$/;

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} description
 * @property {RegExp} pattern  global
 * @property {(match: string, file: string) => boolean} [exempt]  a hit that is fine where it stands
 */

// The patterns are written so that this file does not match them itself (a character class around
// one character of each token), so the check needs no exception for its own source.
/** @type {readonly Rule[]} */
export const RULES = Object.freeze([
  {
    id: 'home-path',
    description: 'absolute path into a personal home directory',
    pattern: /(?<![\w.-])\/home\/[A-Za-z_][\w.-]*/g,
    // The CI runner's home directory is not personal; workflow files may name it.
    exempt: (match, file) => match.split('/')[2] === 'runner' && file.startsWith('.github/'),
  },
  { id: 'home-path', description: 'absolute path into a personal home directory', pattern: /(?<![\w.-])\/Users\/[^\s/'"`]+/g },
  { id: 'home-path', description: 'absolute path into a personal home directory', pattern: /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)/gi },
  {
    id: 'private-token',
    description: 'identifier prefix, header prefix, wire marker or package name of a related private project',
    pattern: /fluid[_]|x-fluid[-]|\[\[fluid[-]|fluid[-]core/gi,
  },
  {
    id: 'internal-id',
    description: 'shape of an internal decision, work-package or requirement id of another project',
    pattern: /\b[EMVKZ]-\d{2,3}\b|\bV0\d-[A-Z]|\bADR[-\s]?\d{4}\b|\bG\d+\.\d+\b/g,
  },
]);

/**
 * @typedef {object} Finding
 * @property {string} file    repository path, or `commit <sha>` for a commit message
 * @property {number} line    1-based; 0 for a file path
 * @property {number} column  1-based
 * @property {string} rule
 * @property {string} match
 * @property {string} description
 */

/**
 * @typedef {object} AllowEntry
 * @property {string} [path]    repository path; `*` matches within a directory, `**` across directories
 * @property {string} [commit]  commit id (at least 7 characters of it)
 * @property {string} [rule]    only this rule
 * @property {number} [line]    only this line
 * @property {string} reason
 */

/**
 * Findings in one text. Lines with an inline allow comment that gives a reason are skipped.
 * @param {string} text
 * @param {string} file  repository path (decides exemptions) or commit label
 * @returns {Finding[]}
 */
export function scanText(text, file) {
  /** @type {Finding[]} */
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (ALLOW_MARK.exec(line)?.[1]) return;
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.pattern)) {
        if (rule.exempt?.(m[0], file)) continue;
        out.push({ file, line: i + 1, column: (m.index ?? 0) + 1, rule: rule.id, match: m[0], description: rule.description });
      }
    }
  });
  return out;
}

/** @param {string} glob */
function globPattern(glob) {
  const source = glob
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

/**
 * Reads and checks the allowlist; a missing file allows nothing.
 * @param {string} root
 * @returns {Array<AllowEntry & { matches: (f: Finding) => boolean }>}
 */
export function loadAllowlist(root) {
  const file = path.join(root, ALLOW_FILE);
  if (!existsSync(file)) return [];
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const entries = json?.allow;
  if (!Array.isArray(entries)) throw new Error(`${ALLOW_FILE}: "allow" must be a list`);
  return entries.map((/** @type {AllowEntry} */ e, i) => {
    const where = `${ALLOW_FILE}: entry ${i + 1}`;
    if (!e || typeof e.reason !== 'string' || e.reason.trim().length < 3) throw new Error(`${where} needs a reason`);
    if ((typeof e.path === 'string') === (typeof e.commit === 'string')) throw new Error(`${where} needs either "path" or "commit"`);
    if (typeof e.commit === 'string' && !/^[0-9a-f]{7,40}$/i.test(e.commit)) throw new Error(`${where}: "commit" must be a commit id`);
    if (e.rule !== undefined && !RULES.some((r) => r.id === e.rule)) throw new Error(`${where}: unknown rule "${e.rule}"`);
    const target = typeof e.path === 'string' ? globPattern(e.path) : null;
    const commit = e.commit?.toLowerCase().slice(0, 12);
    return {
      ...e,
      matches: (f) =>
        (target ? target.test(f.file) : f.file.startsWith('commit ') && f.file.slice(7).startsWith(commit ?? '')) &&
        (e.rule === undefined || e.rule === f.rule) &&
        (e.line === undefined || e.line === f.line),
    };
  });
}

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Content of a tracked file as text, or null for a binary file, a directory (submodule) or a file
 * missing from the working tree. A symbolic link is checked by its target.
 * @param {string} file absolute path
 */
function readText(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return readlinkSync(file);
  if (!stat.isFile()) return null;
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8192).includes(0)) return null;
  return bytes.toString('utf8');
}

/**
 * Runs the check.
 * @param {{ root?: string, range?: string }} [options]
 * @returns {{ findings: Finding[], files: number, commits: number }}
 */
export function runHygiene(options = {}) {
  const root = path.resolve(options.root ?? ROOT);
  const allow = loadAllowlist(root);
  /** @type {Finding[]} */
  const found = [];
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  for (const file of files) {
    found.push(...scanText(file, file).map((f) => ({ ...f, line: 0 })));
    const text = readText(path.join(root, file));
    if (text !== null) found.push(...scanText(text, file));
  }
  let commits = 0;
  if (options.range !== undefined) {
    if (!/^[^\s.-]\S*\.\.[^\s.-]\S*$/.test(options.range)) throw new Error(`--range needs the form A..B, got "${options.range}"`);
    const log = git(root, ['log', '--format=%H%x1f%B%x1e', options.range, '--']);
    for (const record of log.split('\x1e')) {
      const [sha, body] = record.replace(/^\n/, '').split('\x1f');
      if (!sha) continue;
      commits += 1;
      found.push(...scanText(body ?? '', `commit ${sha.slice(0, 12)}`));
    }
  }
  return { findings: found.filter((f) => !allow.some((a) => a.matches(f))), files: files.length, commits };
}

/** @param {string[]} argv */
function main(argv) {
  /** @type {{ root?: string, range?: string }} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--range' || arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      options[arg === '--range' ? 'range' : 'root'] = value;
      i += 1;
    } else if (arg.startsWith('--range=')) options.range = arg.slice(8);
    else if (arg.startsWith('--root=')) options.root = arg.slice(7);
    else throw new Error(`unknown argument "${arg}"`);
  }
  const { findings, files, commits } = runHygiene(options);
  const scope = `${files} tracked files${options.range !== undefined ? ` and ${commits} commit messages in ${options.range}` : ''}`;
  if (!findings.length) {
    console.log(`public hygiene: ${scope} clean`);
    return 0;
  }
  console.error(`public hygiene: ${findings.length} finding${findings.length === 1 ? '' : 's'} in ${scope}`);
  for (const f of findings) {
    const where = f.line === 0 ? `${f.file} (path)` : `${f.file}:${f.line}:${f.column}`;
    console.error(`${where}  ${f.rule}  ${JSON.stringify(f.match)}  ${f.description}`);
  }
  console.error(`Remove the text, or allow a legitimate hit with "hygiene-allow: <reason>" on its line or an entry in ${ALLOW_FILE}.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const e = /** @type {Error & { stderr?: string }} */ (err);
    console.error(`public hygiene: ${(e.stderr || e.message).trim()}`);
    process.exitCode = 2;
  }
}
