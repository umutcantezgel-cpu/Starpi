// Dictionaries must match 1:1 (root files and namespace files), every key the UI uses must resolve
// in both languages without falling back, the namespace registry must match the files on disk, and
// the runtime translation helpers must interpolate and fall back to English correctly.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REASON_CODES } from '../../src/js/core/grounding.js';
import { buildDictionary, DEFAULT_LOCALE, hasKey, isLocaleLoaded, LANGUAGES, loadLocale, LOCALES, setLocale, t } from '../../src/js/i18n/index.js';
import { ENGLISH, NAMESPACES, SHIPPED_LOCALES } from '../../src/locales/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCALES_DIR = path.join(ROOT, 'src/locales');
/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(path.join(LOCALES_DIR, rel), 'utf8'));
/** Namespace directories on disk. */
const namespaceDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
/** @param {string} lang root file plus every namespace file, as the app merges them */
function merged(lang) {
  /** @type {string[]} */
  const conflicts = [];
  const namespaces = Object.fromEntries(namespaceDirs.map((ns) => [ns, readJson(`${ns}/${lang}.json`)]));
  return { dict: buildDictionary(readJson(`${lang}.json`), namespaces, conflicts), conflicts };
}
const en = merged('en').dict;
const de = merged('de').dict;

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
    /\b(?:title|body|badge|label|summary|hint|key): '([a-z][\w]*\.[\w.-]+)'/g,
    /\b(?:label|toast)\(\s*'([a-z][\w]*\.[\w.-]+)'/g,
    /[?:]\s*'([a-z][\w]*\.[\w.-]+)'/g,
    /data-arg="([a-z][\w]*\.[\w.-]+)"/g,
    // Keys of namespaces with a hyphen in their name, wherever they are written literally (a
    // section prefix such as 'ai-orchestration.council' is not a key).
    /["'`]((?:chat-thread|ai-orchestration)\.(?!council["'`])[a-z][\w.-]*[\w])["'`]/g,
  ];
  for (const text of files) for (const re of patterns) for (const m of text.matchAll(re)) keys.add(m[1]);
  // Keys assembled at runtime.
  for (const phase of ['init', 'download', 'cache', 'shaders', 'finalizing']) keys.add(`engine.progress.${phase}`);
  for (const kind of ['unsupported', 'no-adapter', 'quota', 'network', 'code-download', 'device-lost', 'out-of-memory', 'cancelled', 'busy', 'not-loaded', 'unknown']) {
    keys.add(`engine.error.${kind}`);
  }
  for (const stage of ['reading', 'parsing', 'chunking', 'indexing']) keys.add(`workspace.progress_${stage}`);
  for (const code of ['unsupported_type', 'too_large', 'empty', 'invalid_json', 'invalid_pdf', 'encrypted_pdf', 'pdf_reader', 'worker_crashed', 'cleared', 'internal']) {
    keys.add(`workspace.error_${code}`);
  }
  for (const phase of ['warmup', 'prefill', 'decode', 'done']) keys.add(`diagnostics.phase_${phase}`);
  for (const type of ['project', 'person', 'metric', 'tech', 'regulation']) keys.add(`graph.type_${type}`);
  for (const tab of ['chat', 'research', 'library', 'ingest', 'graph', 'bench', 'companion', 'settings']) keys.add(`nav.${tab}`), keys.add(`nav_short.${tab}`);
  for (const tab of ['canvas', 'sources', 'compare', 'research']) keys.add(`shell.aside.${tab}`);
  for (const kind of ['checked', 'mixed', 'unchecked', 'web', 'device', 'withheld']) keys.add(`shell.label.${kind}`);
  for (const dir of ['outgoing', 'incoming']) keys.add(`graph.${dir}`);
  for (const role of ['retrieval', 'answer', 'details', 'reasoning']) keys.add(`trace.role_${role}`);
  for (const key of ['review', 'partial']) keys.add(`grounding.${key}`);
  for (const e of ['denied', 'microphone', 'network', 'no_speech', 'language', 'other']) keys.add(`chat.voice_error_${e}`);
  for (const q of ['launch', 'budget', 'risks']) keys.add(`demo.q_${q}`), keys.add(`demo.q_${q}_question`);
  for (const f of ['budget', 'meeting', 'launch']) keys.add(`demo.flawed_find_${f}`);
  for (const s of ['file_missing', 'file_not_verifiable', 'passage_match', 'passage_moved', 'passage_mismatch', 'text_mismatch', 'text_version_differs', 'chunk_mismatch', 'chunk_version_differs']) {
    keys.add(`receipt.check_${s}`);
  }
  for (const code of REASON_CODES) keys.add(`grounding.reason_${code}`);
  return [...keys].filter((k) => !k.startsWith('ns.')).sort();
}

describe('locale files', () => {
  it('register every namespace directory, in both languages, with its English file bundled', () => {
    assert.deepEqual([...NAMESPACES].sort(), namespaceDirs);
    for (const ns of namespaceDirs) {
      for (const lang of ['en', 'de']) assert.doesNotThrow(() => readJson(`${ns}/${lang}.json`), `${ns}/${lang}.json`);
      assert.deepEqual(ENGLISH.namespaces[ns], readJson(`${ns}/en.json`), `${ns}: bundled English differs from the file`);
    }
  });

  it('ship a root file for every selectable language, and only prepared languages', () => {
    const roots = readdirSync(LOCALES_DIR).filter((f) => /^[a-z]{2}\.json$/.test(f)).map((f) => f.slice(0, 2)).sort();
    assert.deepEqual([...SHIPPED_LOCALES].sort(), roots);
    assert.deepEqual([...LOCALES].sort(), roots);
    for (const code of SHIPPED_LOCALES) assert.ok(Object.hasOwn(LANGUAGES, code), code);
  });

  it('define every key once: namespaces never redefine a root key', () => {
    for (const lang of ['en', 'de']) assert.deepEqual(merged(lang).conflicts, [], lang);
  });

  it('keep namespace keys under their namespace', () => {
    assert.equal(t('shell.theme.dark'), 'Dark');
    assert.equal(t('shell.theme.dark', undefined, 'de'), 'Dunkel');
    assert.equal(hasKey('shell.sidebar.collapse', 'de'), true);
  });
});

describe('dictionaries', () => {
  it('have identical keys in English and German (root and namespaces)', () => {
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

describe('plural forms', () => {
  it('picks the singular for a count of 1 and the plural otherwise, in both languages', () => {
    assert.equal(t('workspace.meta', { chunks: '1', chars: '66' }), '1 chunk · 66 characters');
    assert.equal(t('workspace.meta', { chunks: '12', chars: '6,600' }), '12 chunks · 6,600 characters');
    assert.equal(t('library.meta', { date: 'x', sections: 1 }, 'de'), 'Erstellt am x · 1 Abschnitt');
    assert.equal(t('trace.matches_value', { hits: 1, docs: 2, titles: 't' }, 'de'), '1 Auszug aus 2 Dokumenten (t)');
  });
});

describe('languages without a full dictionary', () => {
  it('fall back to English key by key', async () => {
    const partial = { root: { nav: { settings: 'Paramètres' } }, namespaces: { shell: { theme: { dark: 'Sombre' } } } };
    assert.equal(await loadLocale('fr', async () => partial), true);
    assert.equal(isLocaleLoaded('fr'), true);
    assert.equal(t('nav.settings', undefined, 'fr'), 'Paramètres');
    assert.equal(t('shell.theme.dark', undefined, 'fr'), 'Sombre');
    // Missing in the new language: the English text, never the key.
    assert.equal(t('nav.chat', undefined, 'fr'), 'Chat');
    assert.equal(t('shell.theme.light', undefined, 'fr'), 'Light');
    assert.equal(t('workspace.meta', { chunks: 2, chars: '10' }, 'fr'), '2 chunks · 10 characters');
    assert.equal(hasKey('nav.chat', 'fr'), false);
    assert.equal(hasKey('nav.settings', 'fr'), true);
  });

  it('are not selectable until they ship', async () => {
    assert.equal(LOCALES.includes(/** @type {any} */ ('fr')), false);
    assert.equal(await setLocale('fr'), 'en');
    await setLocale('en');
  });

  it('load to false, not an error, when their files are missing or unknown', async () => {
    const warn = console.warn;
    /** @type {unknown[][]} */
    const warnings = [];
    console.warn = (...args) => warnings.push(args);
    try {
      assert.equal(await loadLocale('es'), false);
      assert.equal(isLocaleLoaded('es'), false);
      assert.equal(t('nav.settings', undefined, 'es'), 'Settings');
      assert.equal(await loadLocale('xx'), false);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
  });

  it('share one request between concurrent loads', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return { root: {}, namespaces: {} };
    };
    const [a, b] = await Promise.all([loadLocale('it', load), loadLocale('it', load)]);
    assert.deepEqual([a, b, calls], [true, true, 1]);
  });
});

describe('buildDictionary()', () => {
  it('merges namespaces under their key and reports keys defined twice', () => {
    /** @type {string[]} */
    const conflicts = [];
    const dict = buildDictionary({ chat: { send: 'Send' }, nav: 'x' }, { chat: { send: 'Again', stop: 'Stop' }, shell: { a: 'A' }, nav: { b: 'B' } }, conflicts);
    assert.deepEqual(dict, { chat: { send: 'Send', stop: 'Stop' }, nav: 'x', shell: { a: 'A' } });
    assert.deepEqual(conflicts, ['chat.send', 'nav']);
  });

  it('does not change its inputs', () => {
    const root = { chat: { send: 'Send' } };
    buildDictionary(root, { chat: { stop: 'Stop' } });
    assert.deepEqual(root, { chat: { send: 'Send' } });
  });
});
