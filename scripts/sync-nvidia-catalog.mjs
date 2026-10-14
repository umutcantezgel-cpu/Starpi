#!/usr/bin/env node
// Writes backend/core/nvidia_catalog.json, the Python backend's copy of the NVIDIA model allowlist,
// request limits and proxy timings, from src/js/models/nvidia-catalog.js (the single source). The
// backend cannot import the JS module: only backend/ is deployed to the API host.
//
// Usage: npm run nvidia:sync            rewrite the copy
//        npm run nvidia:sync -- --check exit 1 if the copy is outdated, change nothing
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogJson } from '../src/js/models/nvidia-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = 'backend/core/nvidia_catalog.json';
const check = process.argv.includes('--check');

const target = path.join(ROOT, MIRROR);
const expected = catalogJson();
let current = null;
try {
  current = readFileSync(target, 'utf8');
} catch {
  // missing: written below, or reported as outdated with --check
}

if (current === expected) {
  console.log(`${MIRROR} matches the catalog`);
} else if (check) {
  console.error(`${MIRROR} is outdated; run npm run nvidia:sync`);
  process.exit(1);
} else {
  writeFileSync(target, expected);
  console.log(`${MIRROR} updated`);
}
