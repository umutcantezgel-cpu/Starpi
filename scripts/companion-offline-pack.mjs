#!/usr/bin/env node
// @ts-check
// Builds the offline bundle of Starpi Core (the local companion): everything a machine without
// network access needs to install it, besides Node.js itself.
//
//   <out>/starpi-companion-<version>/
//     app/             the package as npm would publish it, plus node_modules/ with its production
//                      dependencies (copied from this checkout, never downloaded)
//     deploy/          install and uninstall scripts, systemd units (per-user and system, with the
//                      egress splice), the launchd agent and verify-bundle.mjs
//     voice-server/    the optional local voice server (Python, its own requirements)
//     MANIFEST.json    name, version, Node.js range, dependencies with versions and licences
//     SHA256SUMS       every other file, in `sha256sum -c` format
//     SHA256SUMS.sig   Ed25519 signature of SHA256SUMS (with --sign-key)
//   <out>/starpi-companion-<version>.tar.gz (+ .sha256)   the folder as one deterministic tarball
//
// Each dependency must be installed at exactly the version package-lock.json pins, and its licence
// must pass scripts/license-allowlist.json, before it is copied. SOURCE_DATE_EPOCH, when set,
// fixes the time recorded in MANIFEST.json and the tarball, so two builds of one commit match.
//
// Usage:
//   node scripts/companion-offline-pack.mjs --out <dir> [--sign-key <private key PEM>] [--no-tar]
//   node scripts/companion-offline-pack.mjs verify <bundle folder> [--key <public key PEM>]
//   node scripts/companion-offline-pack.mjs keygen --out <dir>    a new Ed25519 key pair for signing
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { evaluateLicense, packageName, readLockfile, readPackageLicense, resolveDependency } from './license-gate.mjs';
import { main as verifyMain, listTree, signSums, sumsOf, SIGNATURE, SUMS, verifyBundle } from '../packages/companion/deploy/verify-bundle.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPANION = 'packages/companion';
export const VOICE_SERVER = 'companion/voice-server';
/** Files of the voice server that travel (its tests and tooling stay in the repository). */
export const VOICE_FILES = Object.freeze(['server.py', 'allowlist.json', 'requirements.txt', 'README.md']);
const SKIP_NAMES = new Set(['.DS_Store', 'node_modules', '.git']);

/**
 * @typedef {import('./license-gate.mjs').Lockfile} Lockfile
 * @typedef {import('./license-gate.mjs').LockEntry} LockEntry
 * @typedef {{ key: string, name: string, version: string, license: string | null, dest: string, workspace: boolean }} BundledDependency
 */

/**
 * Dependencies a package needs at run time: dependencies, optional dependencies (may be absent)
 * and peers that are not optional.
 * @param {LockEntry} entry
 * @returns {Array<{ name: string, optional: boolean }>}
 */
function runtimeNeeds(entry) {
  /** @type {Map<string, boolean>} */
  const needs = new Map();
  for (const name of Object.keys(entry.dependencies ?? {})) needs.set(name, false);
  for (const name of Object.keys(entry.optionalDependencies ?? {})) needs.set(name, true);
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    if (!needs.has(name) && entry.peerDependenciesMeta?.[name]?.optional !== true) needs.set(name, false);
  }
  return [...needs].map(([name, optional]) => ({ name, optional }));
}

/**
 * Where a lockfile key lands in app/: "node_modules/a" and "packages/companion/node_modules/a"
 * both become "node_modules/a"; nested keys keep their nesting.
 * @param {string} key
 * @param {string} from  the companion's key
 */
export function bundlePathOf(key, from = COMPANION) {
  if (key.startsWith(`${from}/node_modules/`)) return key.slice(from.length + 1);
  if (key.startsWith('node_modules/')) return key;
  return null;
}

/**
 * The companion's production dependencies, breadth first through package-lock.json the way Node
 * resolves them from packages/companion. Workspace links (another package of this repository) are
 * followed to their folder.
 * @param {Lockfile} lock
 * @param {{ from?: string, root?: string }} [options]  the companion's lockfile key; the checkout
 * @returns {{ deps: BundledDependency[], problems: string[] }}
 */
export function companionDependencies(lock, { from = COMPANION, root = ROOT } = {}) {
  const { packages } = lock;
  const start = packages[from];
  /** @type {string[]} */
  const problems = [];
  if (!start) return { deps: [], problems: [`package-lock.json has no entry ${from}`] };
  /** @type {Map<string, BundledDependency>} */
  const reached = new Map();
  /** @type {Map<string, string>} */
  const placed = new Map();
  const queue = [{ at: from, entry: start }];
  for (let item = queue.shift(); item; item = queue.shift()) {
    for (const need of runtimeNeeds(item.entry)) {
      const found = resolveDependency(packages, item.at, need.name);
      if (!found) {
        if (!need.optional) problems.push(`${item.at} needs ${need.name}, which package-lock.json does not have`);
        continue;
      }
      const linked = packages[found];
      const workspace = Boolean(linked.link && typeof linked.resolved === 'string' && packages[linked.resolved]);
      const key = workspace ? /** @type {string} */ (linked.resolved) : found;
      if (reached.has(key)) continue;
      const entry = packages[key];
      const dest = workspace ? `node_modules/${need.name}` : bundlePathOf(key, from);
      if (dest === null) {
        problems.push(`${key}: no place for it in the bundle`);
        continue;
      }
      if (placed.has(dest)) {
        problems.push(`${dest} would hold both ${placed.get(dest)} and ${key}`);
        continue;
      }
      if (need.optional && !existsSync(path.join(root, key, 'package.json')) && !workspace) continue; // an optional part of another platform
      placed.set(dest, key);
      reached.set(key, { key, name: workspace ? need.name : packageName(key, entry), version: entry.version ?? '', license: null, dest, workspace });
      queue.push({ at: key, entry });
    }
  }
  return { deps: [...reached.values()].sort((a, b) => a.dest.localeCompare(b.dest)), problems };
}

/**
 * Copies a folder without node_modules, VCS folders or Finder files; refuses links and special
 * files, which the bundle cannot hold.
 * @param {string} from
 * @param {string} to
 */
export function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${source} is a symbolic link; the bundle holds regular files only`);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) {
      copyFileSync(source, target);
      chmodSync(target, statSync(source).mode & 0o111 ? 0o755 : 0o644);
    } else throw new Error(`${source} is not a regular file`);
  }
}

/**
 * Copies what npm would publish of a workspace package: package.json, the "files" entries and
 * the files npm always includes (README, LICENSE, NOTICE).
 * @param {string} pkgDir
 * @param {string} to
 */
export function copyPublished(pkgDir, to) {
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.files)) throw new Error(`${pkgDir}/package.json has no "files" list`);
  mkdirSync(to, { recursive: true });
  copyFileSync(path.join(pkgDir, 'package.json'), path.join(to, 'package.json'));
  const always = readdirSync(pkgDir).filter((name) => /^(?:readme|license|licence|notice)(?:\.|$)/i.test(name));
  for (const item of new Set([...manifest.files, ...always])) {
    if (typeof item !== 'string' || /[*?]/.test(item) || item.split('/').includes('..')) throw new Error(`${pkgDir}: unsupported "files" entry ${JSON.stringify(item)}`);
    const source = path.join(pkgDir, item);
    if (!existsSync(source)) throw new Error(`${pkgDir}: "files" names ${item}, which does not exist (is the package built?)`);
    if (lstatSync(source).isDirectory()) copyTree(source, path.join(to, item));
    else {
      mkdirSync(path.dirname(path.join(to, item)), { recursive: true });
      copyFileSync(source, path.join(to, item));
      chmodSync(path.join(to, item), statSync(source).mode & 0o111 ? 0o755 : 0o644);
    }
  }
  return manifest;
}

// --- Tarball ------------------------------------------------------------------------------------

/**
 * One ustar header block.
 * @param {{ name: string, prefix: string, mode: number, size: number, mtime: number, type: string }} f
 */
function tarHeader({ name, prefix, mode, size, mtime, type }) {
  const block = Buffer.alloc(512);
  /** @param {string} value @param {number} at @param {number} length */
  const put = (value, at, length) => {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
    bytes.copy(block, at);
  };
  /** @param {number} value @param {number} at @param {number} length */
  const octal = (value, at, length) => put(`${value.toString(8).padStart(length - 1, '0')}\0`, at, length);
  put(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  block.fill(0x20, 148, 156);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

/**
 * Splits a path into ustar's name (100 bytes) and prefix (155 bytes) at a slash, or null.
 * @param {string} p
 * @returns {{ name: string, prefix: string } | null}
 */
export function splitTarPath(p) {
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name !== '') return { name, prefix };
  }
  return null;
}

/** @param {number} size */
const padding = (size) => Buffer.alloc((512 - (size % 512)) % 512);

/**
 * A pax extended header carrying a long path.
 * @param {string} p
 * @param {number} mtime
 */
function paxPath(p, mtime) {
  const body = (/** @type {string} */ key, /** @type {string} */ value) => {
    const tail = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(tail) + 1;
    while (String(length).length + Buffer.byteLength(tail) !== length) length = String(length).length + Buffer.byteLength(tail);
    return `${length}${tail}`;
  };
  const record = Buffer.from(body('path', p), 'utf8');
  return [tarHeader({ name: 'PaxHeader', prefix: '', mode: 0o644, size: record.length, mtime, type: 'x' }), record, padding(record.length)];
}

/**
 * A deterministic ustar archive of a folder: entries sorted, owner 0, fixed time, modes 0755 for
 * folders and executables and 0644 for other files, under `top/`.
 * @param {string} dir
 * @param {string} top
 * @param {number} mtime  seconds since the epoch
 * @returns {Buffer}
 */
export function tarFolder(dir, top, mtime) {
  /** @type {Buffer[]} */
  const parts = [];
  /** @param {string} p @param {number} mode @param {number} size @param {string} type */
  const entry = (p, mode, size, type) => {
    const split = splitTarPath(p);
    if (split) parts.push(tarHeader({ ...split, mode, size, mtime, type }));
    else {
      parts.push(...paxPath(p, mtime));
      parts.push(tarHeader({ name: p.slice(-99).replace(/^\/+/, ''), prefix: '', mode, size, mtime, type }));
    }
  };
  /** @param {string} rel */
  const visit = (rel) => {
    entry(`${rel ? `${top}/${rel}` : top}/`, 0o755, 0, '5');
    const names = readdirSync(rel ? path.join(dir, rel) : dir).sort();
    for (const name of names) {
      const child = rel ? `${rel}/${name}` : name;
      const full = path.join(dir, child);
      const stat = lstatSync(full);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) {
        const data = readFileSync(full);
        entry(`${top}/${child}`, stat.mode & 0o111 ? 0o755 : 0o644, data.length, '0');
        parts.push(data, padding(data.length));
      } else throw new Error(`${full} cannot go into the tarball`);
    }
  };
  visit('');
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// --- Bundle -------------------------------------------------------------------------------------

/**
 * Checks versions and licences of the dependencies against node_modules and the policy.
 * @param {BundledDependency[]} deps
 * @param {Lockfile} lock
 * @param {any} policy
 * @param {string} root
 */
export function checkDependencies(deps, lock, policy, root = ROOT) {
  /** @type {string[]} */
  const problems = [];
  for (const dep of deps) {
    const info = readPackageLicense(root, dep.key, lock.packages[dep.key]);
    if (!dep.workspace) problems.push(...info.problems);
    if (!existsSync(path.join(root, dep.key, 'package.json'))) problems.push(`${dep.name}@${dep.version} is not installed (${dep.key}); run npm ci`);
    const fact = policy.packages?.[`${info.name}@${info.version}`];
    dep.license = fact?.license ?? info.license;
    const verdict = evaluateLicense(dep.license, policy);
    if (verdict.verdict !== 'allowed') problems.push(`${dep.name}@${dep.version}: ${dep.license ?? 'no license'}, ${verdict.reason}`);
  }
  return problems;
}

/**
 * Builds the bundle folder and, unless `tar` is false, the tarball.
 * @param {{ outDir: string, signKey?: string | Buffer, tar?: boolean, root?: string, now?: number }} options
 * @returns {{ dir: string, version: string, files: number, tarball: string | null, sha256: string | null, keyId: string | null }}
 */
export function packOffline({ outDir, signKey, tar = true, root = ROOT, now }) {
  const pkgDir = path.join(root, COMPANION);
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const version = String(manifest.version);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`unusable version ${version}`);
  const lock = readLockfile(root);
  const policy = JSON.parse(readFileSync(path.join(root, 'scripts', 'license-allowlist.json'), 'utf8'));
  const { deps, problems } = companionDependencies(lock, { root });
  problems.push(...checkDependencies(deps, lock, policy, root));
  if (problems.length > 0) throw new Error(`cannot bundle the dependencies:\n - ${problems.join('\n - ')}`);

  const epoch = now ?? (process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : Math.floor(Date.now() / 1000));
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('SOURCE_DATE_EPOCH must be whole seconds');
  const name = `starpi-companion-${version}`;
  const dir = path.join(path.resolve(outDir), name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  copyPublished(pkgDir, path.join(dir, 'app'));
  for (const dep of deps) {
    const target = path.join(dir, 'app', dep.dest);
    if (dep.workspace) copyPublished(path.join(root, dep.key), target);
    else copyTree(path.join(root, dep.key), target);
  }
  copyTree(path.join(pkgDir, 'deploy'), path.join(dir, 'deploy'));
  mkdirSync(path.join(dir, 'voice-server'));
  for (const file of VOICE_FILES) copyFileSync(path.join(root, VOICE_SERVER, file), path.join(dir, 'voice-server', file));
  chmodSync(path.join(dir, 'voice-server', 'server.py'), 0o755);

  const bundleManifest = {
    name: manifest.name,
    version,
    node: manifest.engines?.node ?? null,
    created: new Date(epoch * 1000).toISOString(),
    license: manifest.license,
    dependencies: deps.map((d) => ({ name: d.name, version: d.version, license: d.license, path: `app/${d.dest}` })),
    install: { linux: 'sh deploy/linux/install.sh', macos: 'sh deploy/macos/install.sh' },
  };
  writeFileSync(path.join(dir, 'MANIFEST.json'), `${JSON.stringify(bundleManifest, null, 2)}\n`);

  const sums = sumsOf(dir);
  writeFileSync(path.join(dir, SUMS), sums);
  /** @type {string | null} */
  let id = null;
  if (signKey !== undefined) {
    const signed = signSums(sums, signKey);
    writeFileSync(path.join(dir, SIGNATURE), signed.signature);
    id = signed.keyId;
  }
  const publicKey = signKey !== undefined ? createPublicKey(signKey).export({ type: 'spki', format: 'pem' }) : undefined;
  const check = verifyBundle(dir, { publicKey });
  if (!check.ok) throw new Error(`the bundle does not verify:\n - ${check.problems.join('\n - ')}`);

  /** @type {string | null} */
  let tarball = null;
  /** @type {string | null} */
  let sha256 = null;
  if (tar) {
    tarball = path.join(path.resolve(outDir), `${name}.tar.gz`);
    const archive = gzipSync(tarFolder(dir, name, epoch), { level: 9 });
    writeFileSync(tarball, archive);
    sha256 = createHash('sha256').update(archive).digest('hex');
    writeFileSync(`${tarball}.sha256`, `${sha256}  ${name}.tar.gz\n`);
  }
  return { dir, version, files: listTree(dir).files.length, tarball, sha256, keyId: id };
}

/**
 * A new Ed25519 key pair: <dir>/companion-release.key (private, 0600) and .pub.
 * @param {string} outDir
 */
export function keygen(outDir) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(outDir, { recursive: true });
  const priv = path.join(outDir, 'companion-release.key');
  const pub = path.join(outDir, 'companion-release.pub');
  if (existsSync(priv)) throw new Error(`${priv} exists; a signing key is never replaced`);
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  return { priv, pub };
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  const [first, ...rest] = argv;
  if (first === 'verify') return verifyMain(rest);
  const option = (/** @type {string[]} */ args, /** @type {string} */ flag) => {
    const at = args.indexOf(flag);
    return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : undefined;
  };
  if (first === 'keygen') {
    const out = option(rest, '--out');
    if (!out) {
      process.stderr.write('usage: node scripts/companion-offline-pack.mjs keygen --out <dir>\n');
      return 2;
    }
    const { priv, pub } = keygen(out);
    process.stdout.write(`private key ${priv} (keep it offline)\npublic key  ${pub} (publish it with the release notes)\n`);
    return 0;
  }
  const out = option(argv, '--out');
  if (!out) {
    process.stderr.write('usage: node scripts/companion-offline-pack.mjs --out <dir> [--sign-key <private key PEM>] [--no-tar]\n       node scripts/companion-offline-pack.mjs verify <bundle> [--key <public key PEM>]\n       node scripts/companion-offline-pack.mjs keygen --out <dir>\n');
    return 2;
  }
  const keyFile = option(argv, '--sign-key');
  const result = packOffline({ outDir: out, signKey: keyFile ? readFileSync(keyFile) : undefined, tar: !argv.includes('--no-tar') });
  process.stdout.write(`bundle   ${result.dir} (${result.files} files, verified${result.keyId ? `, signed by key ${result.keyId}` : ', not signed'})\n`);
  if (result.tarball) process.stdout.write(`tarball  ${result.tarball}\nsha256   ${result.sha256}\n`);
  return 0;
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`companion-offline-pack: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
