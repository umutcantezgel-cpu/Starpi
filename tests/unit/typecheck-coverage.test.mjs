// Every module that opts into type checking (// @ts-check) must be part of `npm run typecheck`, so
// the editor and CI check the same files.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('typecheck coverage', () => {
  it('lists every @ts-check module in tsconfig.json', () => {
    const include = new Set(JSON.parse(readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')).include);
    const checked = readdirSync(path.join(ROOT, 'src/js'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.js'))
      .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
      .filter((f) => readFileSync(path.join(ROOT, f), 'utf8').startsWith('// @ts-check'));
    assert.ok(checked.length > 30, `only ${checked.length} checked modules found`);
    assert.deepEqual(checked.filter((f) => !include.has(f)), []);
  });
});
