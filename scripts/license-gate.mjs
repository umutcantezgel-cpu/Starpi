#!/usr/bin/env node
// License gate for what Starpi ships: every package reachable from the "dependencies" of the root
// package.json (resolved in package-lock.json the way Node resolves imports; devDependencies never
// count) must declare a license that scripts/license-allowlist.json allows. The license is read
// from the installed package.json, with the lockfile's license field as the fallback for optional
// packages of other platforms. It runs offline and fails (exit 1) on a missing, unknown or forbidden
// license, on an installed version that differs from the lockfile and on a license that the
// lockfile and the installed package disagree on.
//
// A dependency that the browser build never bundles (a Node-only backend of a library that also
// runs in Node) can be listed under "notShipped" with the reason; the gate skips it and whatever
// only it pulls in, and scripts/build.mjs fails when such a package ends up in dist/ after all.
//
// Usage: node scripts/license-gate.mjs [--root <dir>] [--allowlist <file>]
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ALLOWLIST = path.join(ROOT, 'scripts', 'license-allowlist.json');

/**
 * @typedef {object} LockEntry  one entry of package-lock.json "packages"
 * @property {string} [name]     set for aliases and workspaces
 * @property {string} [version]
 * @property {string} [resolved]
 * @property {string} [integrity]
 * @property {string} [license]
 * @property {boolean} [dev]
 * @property {boolean} [optional]
 * @property {boolean} [link]     a workspace symlink; `resolved` is the key of its target
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [optionalDependencies]
 * @property {Record<string, string>} [devDependencies]
 * @property {Record<string, string>} [peerDependencies]
 * @property {Record<string, { optional?: boolean }>} [peerDependenciesMeta]
 *
 * @typedef {{ lockfileVersion: number, packages: Record<string, LockEntry> }} Lockfile
 *
 * @typedef {object} Policy  scripts/license-allowlist.json
 * @property {string[]} allowed
 * @property {string[]} [forbidden]
 * @property {string[]} [forbiddenPatterns]  regular expressions, case-insensitive
 * @property {Record<string, { license: string, evidence: string }>} [packages]  reviewed facts, by "name@version"
 * @property {Record<string, { reason: string }>} [notShipped]  package names the browser build never bundles
 *
 * @typedef {'allowed' | 'forbidden' | 'unknown'} Verdict
 * @typedef {{ type: 'id', id: string } | { type: 'with', id: string, exception: string } | { type: 'and' | 'or', parts: LicenseNode[] }} LicenseNode
 */

/**
 * @param {string} root
 * @returns {Lockfile}
 */
export function readLockfile(root) {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (!(Number(lock.lockfileVersion) >= 2) || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json needs lockfileVersion 2 or 3 (a "packages" map); regenerate it with npm 7 or newer');
  }
  return lock;
}

/**
 * The package name behind a lockfile key: "node_modules/a/node_modules/@s/b" is "@s/b".
 * @param {string} key
 * @param {LockEntry} entry
 */
export function packageName(key, entry) {
  if (entry.name) return entry.name;
  const at = key.lastIndexOf('node_modules/');
  return at === -1 ? key : key.slice(at + 'node_modules/'.length);
}

/**
 * Where Node finds `name` when `from` imports it: its own node_modules, then those of each parent
 * directory up to the root.
 * @param {Record<string, LockEntry>} packages
 * @param {string} from the importing package's key ("" is the root)
 * @param {string} name
 * @returns {string | null} the key of the package found
 */
export function resolveDependency(packages, from, name) {
  for (let dir = from; ; ) {
    const key = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!dir) return null;
    const up = dir.lastIndexOf('/node_modules/');
    dir = up === -1 ? '' : dir.slice(0, up);
  }
}

/**
 * The dependencies a package needs at run time: dependencies and required peers must be there,
 * optional dependencies and optional peers may be missing.
 * @param {LockEntry} entry
 * @returns {Array<{ name: string, optional: boolean }>}
 */
function runtimeDependencies(entry) {
  /** @type {Map<string, boolean>} name -> optional */
  const deps = new Map();
  for (const name of Object.keys(entry.dependencies ?? {})) deps.set(name, false);
  for (const name of Object.keys(entry.optionalDependencies ?? {})) deps.set(name, true);
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    if (!deps.has(name)) deps.set(name, entry.peerDependenciesMeta?.[name]?.optional === true);
  }
  return [...deps].map(([name, optional]) => ({ name, optional }));
}

/**
 * Every lockfile key the production dependencies reach, breadth first from the root, with the
 * problems met on the way (a required dependency the lockfile does not have). Packages named in
 * `skip` are not entered: they are reported under `skipped` instead.
 * @param {Lockfile} lock
 * @param {{ skip?: Iterable<string> }} [options]
 * @returns {{ keys: string[], skipped: string[], problems: string[] }}
 */
export function productionTree(lock, { skip = [] } = {}) {
  const { packages } = lock;
  const root = packages[''] ?? {};
  const skipNames = new Set(skip);
  /** @type {string[]} */
  const problems = [];
  const reached = new Set();
  const skipped = new Set();
  /** @type {Array<{ from: string, deps: Array<{ name: string, optional: boolean }> }>} */
  const queue = [
    {
      from: '',
      deps: [
        ...Object.keys(root.dependencies ?? {}).map((name) => ({ name, optional: false })),
        ...Object.keys(root.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
      ],
    },
  ];
  for (let item = queue.shift(); item; item = queue.shift()) {
    for (const dep of item.deps) {
      const found = resolveDependency(packages, item.from, dep.name);
      if (!found) {
        if (!dep.optional) problems.push(`${item.from || 'package.json'} needs ${dep.name}, which package-lock.json does not have`);
        continue;
      }
      const target = packages[found];
      const key = target.link && typeof target.resolved === 'string' && packages[target.resolved] ? target.resolved : found;
      if (skipNames.has(packageName(key, packages[key]))) {
        skipped.add(key);
        continue;
      }
      if (reached.has(key)) continue;
      reached.add(key);
      queue.push({ from: key, deps: runtimeDependencies(packages[key]) });
    }
  }
  return { keys: [...reached].sort(), skipped: [...skipped].sort(), problems };
}

/**
 * The license a package.json declares: "license" as a string or { type }, or the old "licenses"
 * array, which means any one of them (OR).
 * @param {any} manifest
 * @returns {string | null}
 */
export function manifestLicense(manifest) {
  const value = manifest?.license ?? manifest?.licenses;
  if (typeof value === 'string') return value.trim() || null;
  if (value && !Array.isArray(value) && typeof value.type === 'string') return value.type.trim() || null;
  if (Array.isArray(value)) {
    const ids = value.map((l) => (typeof l === 'string' ? l : l?.type)).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) return `(${ids.join(' OR ')})`;
  }
  return null;
}

/**
 * The license of one lockfile entry, from the installed package first.
 * @param {string} root
 * @param {string} key
 * @param {LockEntry} entry
 * @returns {{ name: string, version: string, license: string | null, source: 'node_modules' | 'package-lock.json' | 'none', problems: string[] }}
 */
export function readPackageLicense(root, key, entry) {
  const name = packageName(key, entry);
  const version = entry.version ?? '';
  /** @type {string[]} */
  const problems = [];
  const locked = typeof entry.license === 'string' && entry.license.trim() ? entry.license.trim() : null;
  const file = path.join(root, key, 'package.json');
  if (existsSync(file)) {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (version && manifest.version !== version) problems.push(`${name}: node_modules has ${manifest.version}, package-lock.json ${version}; run npm ci`);
    const installed = manifestLicense(manifest);
    if (installed && locked && installed !== locked) problems.push(`${name}@${version}: ${key}/package.json says "${installed}", package-lock.json "${locked}"`);
    if (installed) return { name, version, license: installed, source: 'node_modules', problems };
  }
  if (locked) return { name, version, license: locked, source: 'package-lock.json', problems };
  return { name, version, license: null, source: 'none', problems };
}

/**
 * Parses an SPDX license expression: identifiers joined by AND and OR (AND binds tighter), "X WITH
 * exception", and parentheses; the operators in any case.
 * @param {string} expression
 * @returns {LicenseNode}
 */
export function parseLicenseExpression(expression) {
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  if (tokens.length === 0) throw new Error('empty license expression');
  let pos = 0;
  const isOp = (/** @type {string} */ word) => typeof tokens[pos] === 'string' && tokens[pos].toUpperCase() === word;
  const identifier = () => {
    const token = tokens[pos];
    if (token === undefined || token === '(' || token === ')' || /^(?:AND|OR|WITH)$/i.test(token)) {
      throw new Error(`unexpected ${token === undefined ? 'end' : `"${token}"`} in license expression "${expression}"`);
    }
    pos += 1;
    return token;
  };
  /** @returns {LicenseNode} */
  const primary = () => {
    if (tokens[pos] === '(') {
      pos += 1;
      const inner = disjunction();
      if (tokens[pos] !== ')') throw new Error(`missing ")" in license expression "${expression}"`);
      pos += 1;
      return inner;
    }
    const id = identifier();
    if (!isOp('WITH')) return { type: 'id', id };
    pos += 1;
    return { type: 'with', id, exception: identifier() };
  };
  /**
   * @param {'AND' | 'OR'} word
   * @param {() => LicenseNode} operand
   * @returns {LicenseNode}
   */
  const sequence = (word, operand) => {
    const parts = [operand()];
    while (isOp(word)) {
      pos += 1;
      parts.push(operand());
    }
    return parts.length === 1 ? parts[0] : { type: word === 'AND' ? 'and' : 'or', parts };
  };
  const conjunction = () => sequence('AND', primary);
  const disjunction = () => sequence('OR', conjunction);
  const tree = disjunction();
  if (pos !== tokens.length) throw new Error(`unexpected "${tokens[pos]}" in license expression "${expression}"`);
  return tree;
}

/**
 * Judges a license expression: OR passes when one alternative is allowed, AND when every part is;
 * "X WITH exception" is judged like X (an exception only adds permissions) unless the combination
 * itself is listed.
 * @param {string | null} expression
 * @param {Policy} policy
 * @returns {{ verdict: Verdict, reason: string }}
 */
export function evaluateLicense(expression, policy) {
  if (!expression) return { verdict: 'unknown', reason: 'no license declared' };
  if (/^SEE LICEN[CS]E IN\b/i.test(expression)) return { verdict: 'unknown', reason: 'a custom license file, which needs a review' };
  let tree;
  try {
    tree = parseLicenseExpression(expression);
  } catch (err) {
    return { verdict: 'unknown', reason: /** @type {Error} */ (err).message };
  }
  const lower = (/** @type {string[] | undefined} */ list) => new Set((list ?? []).map((id) => id.toLowerCase()));
  const allowed = lower(policy.allowed);
  const forbidden = lower(policy.forbidden);
  const patterns = (policy.forbiddenPatterns ?? []).map((p) => new RegExp(p, 'i'));
  /** @param {string} id @returns {Verdict} */
  const judgeId = (id) => {
    if (allowed.has(id.toLowerCase())) return 'allowed';
    if (forbidden.has(id.toLowerCase()) || patterns.some((re) => re.test(id))) return 'forbidden';
    return 'unknown';
  };
  /** @param {LicenseNode} node @returns {{ verdict: Verdict, via: string }} */
  const judge = (node) => {
    if (node.type === 'id') return { verdict: judgeId(node.id), via: node.id };
    if (node.type === 'with') {
      const whole = `${node.id} WITH ${node.exception}`;
      return { verdict: allowed.has(whole.toLowerCase()) ? 'allowed' : judgeId(node.id), via: whole };
    }
    const results = node.parts.map(judge);
    if (node.type === 'or') return results.find((r) => r.verdict === 'allowed') ?? results.find((r) => r.verdict === 'unknown') ?? results[0];
    return results.find((r) => r.verdict === 'forbidden') ?? results.find((r) => r.verdict === 'unknown') ?? { verdict: 'allowed', via: expression };
  };
  const { verdict, via } = judge(tree);
  const reason = verdict === 'allowed' ? `allowed as ${via}` : verdict === 'forbidden' ? `${via} is forbidden` : `${via} is not on the allowlist`;
  return { verdict, reason };
}

/**
 * Runs the gate over a checkout.
 * @param {{ root?: string, policy?: Policy }} [options]
 * @returns {{ packages: Array<{ key: string, name: string, version: string, license: string | null, source: string, verdict: Verdict, reason: string }>, skipped: string[], problems: string[] }}
 */
export function checkLicenses({ root = ROOT, policy = JSON.parse(readFileSync(DEFAULT_ALLOWLIST, 'utf8')) } = {}) {
  const lock = readLockfile(root);
  const notShipped = policy.notShipped ?? {};
  const tree = productionTree(lock, { skip: Object.keys(notShipped) });
  const problems = [...tree.problems];
  for (const [name, entry] of Object.entries(notShipped)) {
    if (typeof entry?.reason !== 'string' || !entry.reason.trim()) problems.push(`license-allowlist.json: notShipped["${name}"] needs the "reason" it never ships`);
  }
  const reviewed = policy.packages ?? {};
  for (const [id, fact] of Object.entries(reviewed)) {
    if (typeof fact?.license !== 'string' || typeof fact?.evidence !== 'string' || !fact.evidence.trim()) {
      problems.push(`license-allowlist.json: packages["${id}"] needs a "license" and the "evidence" for it`);
    }
  }
  const packages = tree.keys.map((key) => {
    const info = readPackageLicense(root, key, lock.packages[key]);
    problems.push(...info.problems);
    const fact = reviewed[`${info.name}@${info.version}`];
    const license = fact?.license ?? info.license;
    const { verdict, reason } = evaluateLicense(license, policy);
    if (verdict !== 'allowed') problems.push(`${info.name}@${info.version} (${key}): ${license ?? 'no license'}, ${reason}`);
    return { key, name: info.name, version: info.version, license, source: fact ? 'license-allowlist.json' : info.source, verdict, reason };
  });
  if (packages.length === 0 && Object.keys(lock.packages['']?.dependencies ?? {}).length > 0) problems.push('package-lock.json resolves none of the production dependencies');
  return { packages, skipped: tree.skipped, problems };
}

function main() {
  const args = process.argv.slice(2);
  const option = (/** @type {string} */ flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const allowlist = option('--allowlist');
  const policy = JSON.parse(readFileSync(allowlist ? path.resolve(allowlist) : DEFAULT_ALLOWLIST, 'utf8'));
  const { packages, skipped, problems } = checkLicenses({ root: path.resolve(option('--root') ?? ROOT), policy });
  if (problems.length > 0) {
    console.error(`license-gate: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const p of packages) counts.set(p.license ?? '', (counts.get(p.license ?? '') ?? 0) + 1);
  const summary = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([license, n]) => `${license} ${n}`);
  const notShipped = skipped.length > 0 ? `; not shipped, skipped: ${skipped.map((key) => key.replace(/^.*node_modules\//, '')).join(', ')}` : '';
  console.log(`license-gate: OK (${packages.length} production packages: ${summary.join(', ')}${notShipped})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
