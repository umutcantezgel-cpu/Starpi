// Every module that opts into type checking (// @ts-check) must be part of `npm run typecheck`, so
// the editor and CI check the same files. Server code under api/ must always opt in.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const include = new Set(JSON.parse(readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')).include);

/** @param {string} dir repository-relative directory */
function jsFiles(dir) {
  return readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)).split(path.sep).join('/'));
}

/** @param {string} file repository-relative path */
const isChecked = (file) => readFileSync(path.join(ROOT, file), 'utf8').startsWith('// @ts-check');

describe('typecheck coverage', () => {
  it('lists every @ts-check module in tsconfig.json', () => {
    const checked = [...jsFiles('src/js'), ...jsFiles('api')].filter(isChecked);
    assert.ok(checked.length > 30, `only ${checked.length} checked modules found`);
    assert.deepEqual(checked.filter((f) => !include.has(f)), []);
  });

  it('type-checks every server module under api/', () => {
    const files = jsFiles('api');
    assert.ok(files.length > 0, 'no modules under api/');
    assert.deepEqual(files.filter((f) => !isChecked(f)), [], 'add // @ts-check as the first line');
  });
});
