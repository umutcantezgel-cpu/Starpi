#!/usr/bin/env node
// Writes CycloneDX 1.5 SBOMs (JSON) that npm sbom generates from package-lock.json, without
// installing anything:
//   <out>/starpi-<version>.cdx.json       the app: every package in the lockfile, development
//                                         tooling marked (scope optional, cdx:npm:package:development),
//                                         and as an ML-BOM the on-device models of both model
//                                         catalogs (type machine-learning-model)
//   <out>/starpi-core-<version>.cdx.json  the @starpi/core package, which has no dependencies
// scripts/lib/sbom.mjs makes both deterministic: for one commit and one npm version the files are
// byte-identical (the timestamp is the commit time of HEAD, or SOURCE_DATE_EPOCH when set). Each
// document is checked before it is written, also for anything that looks like a key (the key rules
// of .gitleaks.toml and the values of secret environment variables); a problem exits 1 and writes
// nothing. Nothing else is read from the environment.
//
// Usage: node scripts/sbom.mjs [--out <dir>]      (default sbom/; --out=<dir> works too)
//        npm run sbom -- --out <dir>
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG } from '../src/js/webgpu/models.js';
import { WASM_CATALOG } from '../src/js/models/wasm-catalog.js';
import { findSecrets, normalizeCoreSbom, normalizeSbom, validateSbom, wasmModels, webllmModels, withModels } from './lib/sbom.mjs';
import { credentialRules } from './lib/secret-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = (/** @type {string} */ problem) => {
  console.error(`sbom: ${problem}\nusage: node scripts/sbom.mjs [--out <dir>]`);
  process.exit(2);
};
let OUT = path.join(ROOT, 'sbom');
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  const value = arg === '--out' ? process.argv[++i] : arg.startsWith('--out=') ? arg.slice('--out='.length) : null;
  if (value === null) usage(`unknown argument ${arg}`);
  if (!value || value.startsWith('--')) usage('--out needs a directory');
  OUT = path.resolve(value);
}

const readJson = async (/** @type {string} */ file) => JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));
const root = await readJson('package.json');
const core = await readJson('packages/core/package.json');
/** @type {Record<string, string>} cdx:npm:package:path and bom-ref of each project → its package name */
const names = { '': root.name, [`${root.name}@${root.version}`]: root.name };
for (const dir of root.workspaces ?? []) {
  const ws = await readJson(path.join(dir, 'package.json'));
  names[dir] = ws.name;
  names[`${ws.name}@${ws.version}`] = ws.name;
}

// The npm that runs this script (npm run sets npm_execpath), else the one on PATH.
const npmCli = process.env.npm_execpath && /npm-cli\.c?js$/.test(process.env.npm_execpath) ? [process.execPath, process.env.npm_execpath] : ['npm'];
const env = { ...process.env, npm_config_update_notifier: 'false' };
delete env.NODE_ENV; // NODE_ENV=production would leave out development dependencies

/**
 * @param {string[]} extra
 * @returns {import('./lib/sbom.mjs').Bom}
 */
function npmSbom(extra) {
  const [cmd, ...pre] = npmCli;
  const argv = [...pre, 'sbom', '--sbom-format', 'cyclonedx', '--package-lock-only', '--include=dev', '--include=optional', '--include=peer', ...extra];
  return JSON.parse(execFileSync(cmd, argv, { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
}

function timestamp() {
  if (process.env.SOURCE_DATE_EPOCH) {
    const seconds = Number(process.env.SOURCE_DATE_EPOCH);
    if (!Number.isInteger(seconds) || seconds < 0) throw new Error(`SOURCE_DATE_EPOCH ${process.env.SOURCE_DATE_EPOCH} is not a number of seconds`);
    return new Date(seconds * 1000).toISOString();
  }
  let out;
  try {
    // --no-show-signature: log.showSignature would print gpg output before the date
    out = execFileSync('git', ['log', '-1', '--no-show-signature', '--format=%ct', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined; // no git, no repository or no commit: the timestamp is left out
  }
  if (!/^\d+$/.test(out)) throw new Error(`git log printed ${JSON.stringify(out)} instead of the commit time`);
  return new Date(Number(out) * 1000).toISOString();
}

/** @param {string} name */
const lockedRuntime = (name) => {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`${name} is not in package-lock.json`);
  return `${name}@${version}`;
};
const lock = await readJson('package-lock.json');
const models = [
  ...webllmModels(MODEL_CATALOG, { runtime: lockedRuntime('@mlc-ai/web-llm') }),
  ...wasmModels(WASM_CATALOG, { runtime: lockedRuntime('@huggingface/transformers') }),
];

const time = timestamp();
const app = withModels(normalizeSbom(npmSbom(['--sbom-type', 'application']), { names, timestamp: time }), models);
const pkg = normalizeCoreSbom(normalizeSbom(npmSbom(['--sbom-type', 'library', '--workspace', core.name]), { names, timestamp: time }), {
  ref: `${core.name}@${core.version}`,
  manifest: core,
});

const files = [
  {
    file: `starpi-${root.version}.cdx.json`,
    doc: app,
    problems: validateSbom(app, {
      name: root.name,
      version: root.version,
      type: 'application',
      required: Object.keys(root.dependencies ?? {}),
      models: models.map((m) => m['bom-ref']),
    }),
  },
  {
    file: `starpi-core-${core.version}.cdx.json`,
    doc: pkg,
    problems: validateSbom(pkg, { name: core.name, version: core.version, type: 'library', noComponents: true }),
  },
];
const rules = credentialRules(ROOT);
for (const f of files) {
  for (const finding of findSecrets(JSON.stringify(f.doc), { rules, env: process.env })) f.problems.push(`refusing to write: the document contains ${finding}`);
}
const failed = files.filter((f) => f.problems.length > 0);
if (failed.length > 0) {
  for (const f of failed) for (const problem of f.problems) console.error(`${f.file}: ${problem}`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
for (const { file, doc } of files) {
  await writeFile(path.join(OUT, file), `${JSON.stringify(doc, null, 2)}\n`);
  const mlModels = doc.components.filter((c) => c.type === 'machine-learning-model').length;
  console.log(`${path.relative(process.cwd(), path.join(OUT, file)) || file}: CycloneDX ${doc.specVersion}, ${doc.components.length} components (${mlModels} models), ${doc.serialNumber}`);
}
