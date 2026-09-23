// Every data-action / data-change used in markup or templates must have a registered handler,
// and every registered handler must be reachable (no dead actions).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/** @param {string} dir */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && /\.(js|html)$/.test(d.name))
    .map((d) => path.join(d.parentPath, d.name));
}

const sources = files(SRC).map((f) => readFileSync(f, 'utf8'));
const all = sources.join('\n');

/** @param {RegExp} re */
const collect = (re) => new Set([...all.matchAll(re)].map((m) => m[1]));

describe('delegated actions', () => {
  const usedClicks = collect(/data-action="([\w-]+)"/g);
  const usedChanges = collect(/data-change="([\w-]+)"/g);
  const registeredClicks = collect(/onAction\('([\w-]+)'/g);
  const registeredChanges = collect(/onChange\('([\w-]+)'/g);

  it('has a handler for every data-action and data-change', () => {
    assert.deepEqual([...usedClicks].filter((a) => !registeredClicks.has(a)), []);
    assert.deepEqual([...usedChanges].filter((a) => !registeredChanges.has(a)), []);
  });

  it('has no unreachable handlers', () => {
    assert.deepEqual([...registeredClicks].filter((a) => !usedClicks.has(a)), []);
    assert.deepEqual([...registeredChanges].filter((a) => !usedChanges.has(a)), []);
  });

  it('uses no inline event handler attributes anywhere in the sources', () => {
    assert.doesNotMatch(all, /\son(click|change|submit|keydown|input|drop|dragover|dragleave|load|error)=["']/i);
  });
});

describe('icons', () => {
  it('bundles every lucide icon referenced by the markup and templates', () => {
    const used = collect(/data-lucide="([a-z0-9-]+)"/g);
    for (const m of all.matchAll(/'(info|alert-circle|laptop|tablet|smartphone)'/g)) used.add(m[1]);
    const iconsSrc = readFileSync(path.join(SRC, 'js/icons.js'), 'utf8');
    const pascal = (/** @type {string} */ n) => n.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
    const missing = [...used].filter((n) => !new RegExp(`\\b${pascal(n)},`).test(iconsSrc));
    assert.deepEqual(missing, []);
  });
});
