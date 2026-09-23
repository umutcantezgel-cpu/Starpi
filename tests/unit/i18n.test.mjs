// Dictionaries must match 1:1, every key the UI uses must resolve in both languages without
// falling back, and the runtime translation helpers must interpolate and fall back correctly.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOCALE, hasKey, LOCALES, t } from '../../src/js/i18n/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const en = JSON.parse(readFileSync(path.join(ROOT, 'src/locales/en.json'), 'utf8'));
const de = JSON.parse(readFileSync(path.join(ROOT, 'src/locales/de.json'), 'utf8'));

/**
 * @param {Record<string, unknown>} obj
 * @param {string} [prefix]
 * @returns {Map<string, string>}
 */
function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(/** @type {Record<string, unknown>} */ (v), key, out);
    else out.set(key, String(v));
  }
  return out;
}

const enFlat = flatten(en);
const deFlat = flatten(de);
/** @param {string} s */
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Every key literally referenced by markup or code. */
function usedKeys() {
  const files = readdirSync(path.join(ROOT, 'src'), { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && /\.(js|html)$/.test(d.name))
    .map((d) => readFileSync(path.join(d.parentPath, d.name), 'utf8'));
  const keys = new Set();
  const patterns = [
    /data-i18n(?:-placeholder|-title|-aria)?="([a-z][\w]*\.[\w.-]+)"/g,
    /\bt\(\s*'([a-z][\w]*\.[\w.-]+)'/g,
    /setText\([^,]+,\s*'([a-z][\w]*\.[\w.-]+)'/g,
    /setAssistantStatus\(\s*'([a-z][\w]*\.[\w.-]+)'/g,
    /setWorkspaceStatus\(\s*'([a-z][\w]*\.[\w.-]+)'/g,
    /\b(?:title|body|badge): '([a-z][\w]*\.[\w.-]+)'/g,
    /[?:]\s*'([a-z][\w]*\.[\w.-]+)'/g,
    /data-arg="([a-z][\w]*\.[\w.-]+)"/g,
  ];
  for (const text of files) for (const re of patterns) for (const m of text.matchAll(re)) keys.add(m[1]);
  // Keys assembled at runtime.
  for (const phase of ['init', 'download', 'cache', 'shaders', 'finalizing']) keys.add(`engine.progress.${phase}`);
  for (const kind of ['unsupported', 'no-adapter', 'quota', 'network', 'device-lost', 'out-of-memory', 'cancelled', 'busy', 'not-loaded', 'unknown']) {
    keys.add(`engine.error.${kind}`);
  }
  for (const stage of ['parsing', 'chunking', 'indexing']) keys.add(`workspace.progress_${stage}`);
  for (const code of ['unsupported_type', 'too_large', 'empty', 'invalid_json', 'invalid_pdf', 'encrypted_pdf', 'worker_crashed', 'cleared', 'internal']) {
    keys.add(`workspace.error_${code}`);
  }
  for (const phase of ['warmup', 'prefill', 'decode', 'done']) keys.add(`diagnostics.phase_${phase}`);
  for (const type of ['project', 'person', 'metric', 'tech', 'regulation']) keys.add(`graph.type_${type}`);
  for (const tab of ['chat', 'library', 'graph', 'ingest', 'bench', 'settings']) keys.add(`nav.${tab}`);
  for (const dir of ['outgoing', 'incoming']) keys.add(`graph.${dir}`);
  for (const role of ['retrieval', 'answer', 'details']) keys.add(`trace.role_${role}`);
  return [...keys].filter((k) => !k.startsWith('ns.')).sort();
}

describe('dictionaries', () => {
  it('have identical keys in en.json and de.json', () => {
    assert.deepEqual([...enFlat.keys()].filter((k) => !deFlat.has(k)), [], 'missing in de.json');
    assert.deepEqual([...deFlat.keys()].filter((k) => !enFlat.has(k)), [], 'missing in en.json');
  });

  it('use the same placeholders in both languages', () => {
    for (const [key, value] of enFlat) assert.deepEqual(placeholders(deFlat.get(key) ?? ''), placeholders(value), key);
  });

  it('contain no empty values', () => {
    for (const [key, value] of [...enFlat, ...deFlat]) assert.ok(value.trim(), `empty value at ${key}`);
  });

  it('actually translate: German differs from English for most entries', () => {
    const same = [...enFlat].filter(([key, value]) => deFlat.get(key) === value);
    assert.ok(same.length / enFlat.size < 0.15, `${same.length} identical entries: ${same.map(([k]) => k).join(', ')}`);
  });
});

describe('keys used by the UI', () => {
  const keys = usedKeys();

  it('finds the keys used in markup and code', () => {
    assert.ok(keys.length > 250, `only ${keys.length} keys found`);
  });

  for (const locale of LOCALES) {
    it(`resolves every used key in ${locale} without fallback`, () => {
      assert.deepEqual(keys.filter((k) => !hasKey(k, locale)), []);
    });
  }
});

describe('t()', () => {
  it('defaults to English', () => {
    assert.equal(DEFAULT_LOCALE, 'en');
    assert.equal(t('nav.settings'), 'Settings');
  });

  it('translates into German on request', () => {
    assert.equal(t('nav.settings', undefined, 'de'), 'Einstellungen');
  });

  it('interpolates parameters and leaves unknown placeholders visible', () => {
    assert.equal(t('workspace.meta', { chunks: 3, chars: '1,200' }), '3 chunks · 1,200 characters');
    assert.equal(t('workspace.meta', { chunks: 3 }), '3 chunks · {chars} characters');
  });

  it('falls back to the key for unknown entries', () => {
    assert.equal(t('does.not.exist'), 'does.not.exist');
    assert.equal(hasKey('does.not.exist'), false);
  });
});
