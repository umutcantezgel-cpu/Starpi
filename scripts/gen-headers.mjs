#!/usr/bin/env node
// Writes the "headers" section of vercel.json from scripts/headers.json (profile public). Those
// headers are generated output: edit scripts/headers.json and run this script. Every other key of
// vercel.json (build settings, functions, rewrites) stays as it is.
//
// Usage: node scripts/gen-headers.mjs [--check] [--file <vercel.json>]
//   --check  writes nothing and exits 1 when vercel.json is not what this script would write
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_PROFILE, resolveHeaderRules } from './lib/headers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * vercel.json with the generated headers, as the file text.
 * @param {Record<string, unknown>} vercel the current content
 */
export function renderVercelJson(vercel) {
  return `${JSON.stringify({ ...vercel, headers: resolveHeaderRules(DEFAULT_PROFILE) }, null, 2)}\n`;
}

async function main() {
  const at = process.argv.indexOf('--file');
  const file = at >= 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : path.join(ROOT, 'vercel.json');
  const text = await readFile(file, 'utf8');
  const next = renderVercelJson(JSON.parse(text));
  if (process.argv.includes('--check')) {
    if (!isDeepStrictEqual(JSON.parse(text).headers, JSON.parse(next).headers)) {
      console.error('headers: vercel.json is out of date with scripts/headers.json; run npm run headers:gen');
      process.exit(1);
    }
    console.log(`headers: vercel.json matches scripts/headers.json (profile ${DEFAULT_PROFILE})`);
    return;
  }
  if (next === text) {
    console.log('headers: vercel.json is up to date');
    return;
  }
  await writeFile(file, next);
  console.log(`headers: wrote vercel.json from scripts/headers.json (profile ${DEFAULT_PROFILE})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
