#!/usr/bin/env node
// End-of-life gate over docs/security/eol-register.json (npm run eol:check). It fails when a
// registered component is past its end of life, when an entry is incomplete, when the register no
// longer matches the repository (the Node.js version of .nvmrc, the locked version of a registered
// npm package, a Node.js or Python version a workflow runs) or when a direct production dependency
// of package.json has no entry. A component that reaches its end of life within the register's
// horizon is a warning, and with --strict an error too (a release should not ship one). Offline,
// and deterministic for a given --today.
//
// Usage: node scripts/eol-check.mjs [--today YYYY-MM-DD] [--strict] [--register <file>]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REGISTER = path.join(ROOT, 'docs', 'security', 'eol-register.json');

/** What a component is: a runtime, an npm package, an external service or build tooling. */
export const KINDS = Object.freeze(['runtime', 'npm', 'service', 'tooling']);
const DAY_MS = 86_400_000;

/**
 * @typedef {object} Component
 * @property {string} name
 * @property {string} version
 * @property {string} kind      one of KINDS
 * @property {string} usedFor   where Starpi relies on it
 * @property {string | null} eol 'YYYY-MM-DD', 'YYYY-MM' (read as the first day of the month) or null when none is published
 * @property {string} [source]  where the date comes from; required with a date
 * @property {string} [note]
 * @property {string} [npm]     package whose locked version must equal `version`
 * @property {boolean} [nvmrc]  `version` is the Node.js major of .nvmrc
 *
 * @typedef {{ horizonMonths: number, reviewed?: string, components: Component[] }} Register
 * @typedef {'ok' | 'soon' | 'expired' | 'none'} EolStatus
 * @typedef {{ nvmrc?: string | null, dependencies?: Record<string, string>, lockVersions?: Record<string, string | undefined>, workflowRuntimes?: Array<{ name: string, version: string, file: string }> }} RepoFacts
 */

/**
 * Reads 'YYYY-MM-DD', or 'YYYY-MM' as the first day of that month (so a warning comes early, never
 * late).
 * @param {string} value
 * @returns {Date | null} midnight UTC, or null for an invalid date
 */
export function parseEolDate(value) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = m[3] ? Number(m[3]) : 1;
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

/**
 * The same day `months` later, or the last day of that month when it is shorter.
 * @param {Date} date
 * @param {number} months
 */
export function addMonths(date, months) {
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date.getUTCDate(), last));
  return first;
}

/**
 * Evaluates the register against today and the facts of the repository.
 * @param {Register} register
 * @param {{ today: Date } & RepoFacts} facts
 * @returns {{ rows: Array<{ name: string, version: string, kind: string, eol: string | null, status: EolStatus, daysLeft: number | null }>, problems: string[], warnings: string[] }}
 */
export function evaluateRegister(register, { today, nvmrc = null, dependencies = {}, lockVersions = {}, workflowRuntimes = [] }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  const horizon = register?.horizonMonths;
  const horizonOk = Number.isInteger(horizon) && horizon > 0;
  if (!horizonOk) problems.push('horizonMonths must be a whole number of months above 0');
  const components = Array.isArray(register?.components) ? register.components : [];
  if (components.length === 0) problems.push('the register lists no components');
  const limit = addMonths(today, horizonOk ? horizon : 12);

  const rows = components.map((c, i) => {
    const label = typeof c?.name === 'string' && c.name ? `${c.name} ${c.version ?? ''}`.trim() : `components[${i}]`;
    for (const field of /** @type {const} */ (['name', 'version', 'usedFor'])) {
      if (typeof c?.[field] !== 'string' || !c[field].trim()) problems.push(`${label}: "${field}" is missing`);
    }
    if (!KINDS.includes(c?.kind)) problems.push(`${label}: kind must be one of ${KINDS.join(', ')}`);
    if (!c || !Object.hasOwn(c, 'eol')) problems.push(`${label}: "eol" is missing (a date, or null when no end of life is published)`);
    if (c?.npm !== undefined) {
      const locked = lockVersions[c.npm];
      if (!locked) problems.push(`${label}: ${c.npm} is not installed at the top level of package-lock.json`);
      else if (locked !== c.version) problems.push(`${label}: package-lock.json has ${c.npm}@${locked}; update the register`);
    }
    if (c?.nvmrc) {
      const wanted = String(nvmrc ?? '').trim().replace(/^v/, '');
      if (!wanted) problems.push(`${label}: .nvmrc is missing or empty`);
      else if (wanted !== c.version && !wanted.startsWith(`${c.version}.`)) problems.push(`${label}: .nvmrc names Node.js ${wanted}; update the register`);
    }

    /** @type {EolStatus} */
    let status = 'none';
    /** @type {number | null} */
    let daysLeft = null;
    if (c?.eol !== null && c?.eol !== undefined) {
      const date = typeof c.eol === 'string' ? parseEolDate(c.eol) : null;
      if (!date) problems.push(`${label}: eol "${c.eol}" is neither YYYY-MM-DD nor YYYY-MM`);
      else {
        if (typeof c.source !== 'string' || !c.source.trim()) problems.push(`${label}: an end-of-life date needs a "source"`);
        daysLeft = Math.round((date.getTime() - today.getTime()) / DAY_MS);
        if (date < today) {
          status = 'expired';
          problems.push(`${label} reached its end of life on ${c.eol} (${c.usedFor})`);
        } else if (date <= limit) {
          status = 'soon';
          warnings.push(`${label} reaches its end of life on ${c.eol}, in ${daysLeft} days (${c.usedFor})`);
        } else {
          status = 'ok';
        }
      }
    }
    return { name: c?.name ?? '', version: c?.version ?? '', kind: c?.kind ?? '', eol: c?.eol ?? null, status, daysLeft };
  });

  for (const name of Object.keys(dependencies)) {
    if (!components.some((c) => c?.npm === name)) problems.push(`the production dependency ${name} has no entry in the register`);
  }
  if (nvmrc && !components.some((c) => c?.nvmrc)) problems.push('the Node.js version of .nvmrc has no entry in the register');
  for (const runtime of workflowRuntimes) {
    const known = components.some((c) => c?.kind === 'runtime' && c.name === runtime.name && (c.version === runtime.version || runtime.version.startsWith(`${c.version}.`)));
    if (!known) problems.push(`${runtime.file} runs ${runtime.name} ${runtime.version}, which has no runtime entry in the register`);
  }
  return { rows, problems, warnings };
}

/**
 * The Node.js and Python versions the workflows set up: literal node-version and python-version
 * values, and the entries of a matrix list named node or python.
 * @param {string} dir .github/workflows
 * @returns {Array<{ name: string, version: string, file: string }>}
 */
export function workflowRuntimes(dir) {
  if (!existsSync(dir)) return [];
  /** @type {Array<{ name: string, version: string, file: string }>} */
  const found = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    const where = `.github/workflows/${file}`;
    for (const m of text.matchAll(/^\s*(node|python)-version:\s*['"]?(\d+(?:\.\d+)*)['"]?\s*$/gm)) found.push({ name: m[1] === 'node' ? 'Node.js' : 'Python', version: m[2], file: where });
    for (const m of text.matchAll(/^\s*(node|python):\s*\[([^\]]*)\]/gm)) {
      for (const v of m[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter((s) => /^\d+(?:\.\d+)*$/.test(s))) {
        found.push({ name: m[1] === 'node' ? 'Node.js' : 'Python', version: v, file: where });
      }
    }
  }
  const seen = new Set();
  return found.filter((r) => {
    const key = `${r.name} ${r.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {string} root
 * @returns {RepoFacts}
 */
export function repoFacts(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  /** @type {Record<string, string | undefined>} */
  const lockVersions = {};
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
    if (m) lockVersions[m[1]] = /** @type {{ version?: string }} */ (entry).version;
  }
  const nvmrc = path.join(root, '.nvmrc');
  return {
    nvmrc: existsSync(nvmrc) ? readFileSync(nvmrc, 'utf8') : null,
    dependencies: pkg.dependencies ?? {},
    lockVersions,
    workflowRuntimes: workflowRuntimes(path.join(root, '.github', 'workflows')),
  };
}

function main() {
  const args = process.argv.slice(2);
  const option = (/** @type {string} */ flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const strict = args.includes('--strict');
  const todayArg = option('--today');
  const now = new Date();
  const today = todayArg === undefined ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) : /^\d{4}-\d{2}-\d{2}$/.test(todayArg) ? parseEolDate(todayArg) : null;
  if (!today) {
    console.error(`eol-check: --today needs a date YYYY-MM-DD (got "${todayArg}")`);
    process.exit(2);
  }
  const file = path.resolve(option('--register') ?? DEFAULT_REGISTER);
  /** @type {Register} */
  const register = JSON.parse(readFileSync(file, 'utf8'));
  const { rows, problems, warnings } = evaluateRegister(register, { today, ...repoFacts(ROOT) });
  const annotate = process.env.GITHUB_ACTIONS === 'true';

  console.log(`eol-check: ${path.relative(ROOT, file)}, ${rows.length} components, horizon ${register.horizonMonths} months from ${today.toISOString().slice(0, 10)}`);
  for (const r of rows) {
    const when = r.eol === null ? 'no published end of life' : `end of life ${r.eol} (${r.daysLeft} days)`;
    console.log(`  ${r.status.padEnd(7)} ${`${r.name} ${r.version}`.padEnd(44)} ${r.kind.padEnd(8)} ${when}`);
  }
  for (const w of warnings) console.log(annotate ? `::warning title=End of life within ${register.horizonMonths} months::${w}` : `warning: ${w}`);
  for (const p of problems) console.error(annotate ? `::error title=EOL register::${p}` : `error: ${p}`);
  if (problems.length > 0 || (strict && warnings.length > 0)) {
    console.error(`eol-check: ${problems.length} problem(s), ${warnings.length} warning(s)${strict ? ', strict' : ''}`);
    process.exit(1);
  }
  console.log(`eol-check: OK (${warnings.length} warning(s))`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
