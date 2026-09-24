#!/usr/bin/env node
// Builds the @starpi/core package (packages/core/dist) from the app's own modules, so the package
// and the app never drift apart:
//   dist/index.js            ESM bundle of packages/core/src/index.js (no dependencies; pdfjs-dist
//                            is imported only when a PDF is read, as an optional peer dependency)
//   dist/verify-receipt.js   the receipt verifier CLI (scripts/verify-receipt.mjs) for Node
//   dist/index.d.ts, types/  type declarations generated from the JSDoc types
//
// Usage: node scripts/build-core.mjs [--out <dir>] [--no-types]
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'packages/core');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(args[outArg + 1]) : path.join(PKG, 'dist');
const withTypes = !args.includes('--no-types');

const { version } = JSON.parse(await readFile(path.join(PKG, 'package.json'), 'utf8'));
const banner = `// @starpi/core ${version} (MIT). Built from https://github.com/umutcantezgel-cpu/Starpi`;
const external = ['pdfjs-dist', 'pdfjs-dist/*'];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await build({
  entryPoints: [path.join(PKG, 'src/index.js')],
  outfile: path.join(OUT, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external,
  banner: { js: banner },
  legalComments: 'inline',
  logLevel: 'warning',
});

await build({
  entryPoints: [path.join(ROOT, 'scripts/verify-receipt.mjs')],
  outfile: path.join(OUT, 'verify-receipt.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external,
  banner: { js: banner },
  logLevel: 'warning',
});

if (withTypes) {
  const tsc = path.join(ROOT, 'node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', path.join(PKG, 'tsconfig.build.json'), '--outDir', path.join(OUT, 'types')], { stdio: 'inherit' });
  await writeFile(path.join(OUT, 'index.d.ts'), `${banner}\nexport * from './types/packages/core/src/index.js';\n`);
}

console.log(`built @starpi/core ${version} into ${path.relative(ROOT, OUT) || '.'}${withTypes ? '' : ' (no types)'}`);
