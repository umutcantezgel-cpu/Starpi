// Dictionaries must match 1:1 (root files and namespace files) in every shipped language, every key
// the UI uses must resolve in each of them without falling back, the namespace registry must match
// the files on disk, and the runtime translation helpers must interpolate and fall back to English
// correctly.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
/** @param {string} rel */
const exists = (rel) => existsSync(path.join(LOCALES_DIR, rel));
/** @param {string} lang root file plus every namespace file, as the app merges them (a missing namespace file is {}) */
function merged(lang) {
  /** @type {string[]} */
  const conflicts = [];
  const namespaces = Object.fromEntries(namespaceDirs.map((ns) => [ns, exists(`${ns}/${lang}.json`) ? readJson(`${ns}/${lang}.json`) : {}]));
  return { dict: buildDictionary(readJson(`${lang}.json`), namespaces, conflicts), conflicts };
}
const en = merged('en').dict;
const de = merged('de').dict;
/** The shipped languages besides English. */
const TRANSLATIONS = SHIPPED_LOCALES.filter((code) => code !== 'en');

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
/** @type {Map<string, Map<string, string>>} every shipped translation, flattened */
const flats = new Map(TRANSLATIONS.map((code) => [code, flatten(merged(code).dict)]));
/** @param {string} s */
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** @param {string} s  the counts a text picks plural words for ("{n:file|files}" → n) */
const plurals = (s) => [...new Set([...s.matchAll(/\{(\w+):[^|{}]*\|[^{}]*\}/g)].map((m) => m[1]))].sort();
/** @param {string} s  every name a text reads, from placeholders and plural forms */
const names = (s) => [...new Set([...s.matchAll(/\{(\w+)(?::[^{}]*)?\}/g)].map((m) => m[1]))].sort();

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
  it('register every namespace directory, in every shipped language, with its English file bundled', () => {
    assert.deepEqual([...NAMESPACES].sort(), namespaceDirs);
    for (const ns of namespaceDirs) {
      for (const lang of ['en', 'de']) assert.doesNotThrow(() => readJson(`${ns}/${lang}.json`), `${ns}/${lang}.json`);
      // A namespace without English keys yet needs no file in the other languages; one with keys does.
      const hasKeys = flatten(readJson(`${ns}/en.json`)).size > 0;
      for (const lang of TRANSLATIONS) {
        if (hasKeys || exists(`${ns}/${lang}.json`)) assert.doesNotThrow(() => readJson(`${ns}/${lang}.json`), `${ns}/${lang}.json`);
      }
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
    for (const lang of SHIPPED_LOCALES) assert.deepEqual(merged(lang).conflicts, [], lang);
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

  for (const code of TRANSLATIONS.filter((c) => c !== 'de')) {
    describe(`${code}`, () => {
      const flat = /** @type {Map<string, string>} */ (flats.get(code));

      it('has exactly the keys of English (root and namespaces)', () => {
        assert.deepEqual([...enFlat.keys()].filter((k) => !flat.has(k)), [], `missing in ${code}`);
        assert.deepEqual([...flat.keys()].filter((k) => !enFlat.has(k)), [], `not in English`);
      });

      it('reads the same placeholders and keeps every plural form', () => {
        for (const [key, value] of enFlat) {
          const text = flat.get(key) ?? '';
          assert.deepEqual(names(text), names(value), key);
          assert.deepEqual(plurals(value).filter((n) => !plurals(text).includes(n)), [], `${key}: plural form lost`);
        }
      });

      it('keeps plural forms flat (a form never holds another placeholder) and every value filled', () => {
        for (const [key, value] of flat) {
          assert.ok(value.trim(), `empty value at ${key}`);
          assert.doesNotMatch(value, /\{\w+:[^}]*\{/, key);
        }
      });

      it('actually translates: most entries differ from English', () => {
        const same = [...enFlat].filter(([key, value]) => flat.get(key) === value);
        assert.ok(same.length / enFlat.size < 0.15, `${same.length} identical entries: ${same.map(([k]) => k).join(', ')}`);
      });
    });
  }
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
  it('picks the singular for a count of 1 and the plural otherwise, in every language', () => {
    assert.equal(t('workspace.meta', { chunks: '1', chars: '66' }), '1 chunk · 66 characters');
    assert.equal(t('workspace.meta', { chunks: '12', chars: '6,600' }), '12 chunks · 6,600 characters');
    assert.equal(t('library.meta', { date: 'x', sections: 1 }, 'de'), 'Erstellt am x · 1 Abschnitt');
    assert.equal(t('trace.matches_value', { hits: 1, docs: 2, titles: 't' }, 'de'), '1 Auszug aus 2 Dokumenten (t)');
    assert.equal(t('workspace.meta', { chunks: 1, chars: '66' }, 'fr'), '1 segment · 66 caractères');
    assert.equal(t('workspace.meta', { chunks: 3, chars: '1 200' }, 'fr'), '3 segments · 1 200 caractères');
    assert.equal(t('library.meta', { date: 'x', sections: 2 }, 'es'), 'Creado el x · 2 secciones');
    assert.equal(t('trace.matches_value', { hits: 1, docs: 1, titles: 't' }, 'it'), '1 estratto da 1 documento (t)');
    // Turkish keeps the noun singular after a number, whatever the count.
    assert.equal(t('workspace.meta', { chunks: 1, chars: '66' }, 'tr'), '1 parça · 66 karakter');
    assert.equal(t('workspace.meta', { chunks: 4, chars: '66' }, 'tr'), '4 parça · 66 karakter');
  });
});

describe('the new languages', () => {
  it('use their own terms, and Turkish its own letters', () => {
    assert.equal(t('nav.settings', undefined, 'fr'), 'Paramètres');
    assert.equal(t('nav.settings', undefined, 'es'), 'Ajustes');
    assert.equal(t('nav.settings', undefined, 'it'), 'Impostazioni');
    assert.equal(t('nav.settings', undefined, 'tr'), 'Ayarlar');
    assert.equal(t('nav.ingest', undefined, 'tr'), 'Bilgi ekle');
    assert.equal(t('app.skip_to_content', undefined, 'tr'), 'İçeriğe geç');
    assert.match(t('shell.sidebar.collapse', undefined, 'tr'), /çubuğunu/);
    // No Turkish entry spells a dotted capital I as a plain "I" before a lower-case vowel that
    // needs the dot ("Içerik"), a common slip when Turkish is typed without its keyboard.
    for (const [key, value] of /** @type {Map<string, string>} */ (flats.get('tr'))) assert.doesNotMatch(value, /\bI(?:çer|ptal|ndir|leri|kinci|lk)/, key);
  });

  it('name every shipped language in itself for the language switch', () => {
    assert.deepEqual(
      SHIPPED_LOCALES.map((code) => LANGUAGES[code].name),
      ['English', 'Deutsch', 'Français', 'Español', 'Italiano', 'Türkçe'],
    );
  });
});

/**
 * A fresh copy of the i18n module as a browser starts it: only English is loaded (Node would load
 * every shipped language at once), so loading a language can be watched.
 * @returns {Promise<typeof import('../../src/js/i18n/index.js')>}
 */
async function browserLikeI18n() {
  const node = Object.getOwnPropertyDescriptor(process.versions, 'node');
  Object.defineProperty(process.versions, 'node', { value: undefined, configurable: true });
  try {
    return await import(`../../src/js/i18n/index.js?browser=${Math.random()}`);
  } finally {
    Object.defineProperty(process.versions, 'node', /** @type {PropertyDescriptor} */ (node));
  }
}

describe('languages without a full dictionary', () => {
  it('fall back to English key by key', async () => {
    const i18n = await browserLikeI18n();
    assert.equal(i18n.isLocaleLoaded('fr'), false);
    const partial = { root: { nav: { settings: 'Paramètres' } }, namespaces: { shell: { theme: { dark: 'Sombre' } } } };
    assert.equal(await i18n.loadLocale('fr', async () => partial), true);
    assert.equal(i18n.isLocaleLoaded('fr'), true);
    assert.equal(i18n.t('nav.settings', undefined, 'fr'), 'Paramètres');
    assert.equal(i18n.t('shell.theme.dark', undefined, 'fr'), 'Sombre');
    // Missing in the language: the English text, never the key.
    assert.equal(i18n.t('nav.chat', undefined, 'fr'), 'Chat');
    assert.equal(i18n.t('shell.theme.light', undefined, 'fr'), 'Light');
    assert.equal(i18n.t('workspace.meta', { chunks: 2, chars: '10' }, 'fr'), '2 chunks · 10 characters');
    assert.equal(i18n.hasKey('nav.chat', 'fr'), false);
    assert.equal(i18n.hasKey('nav.settings', 'fr'), true);
  });

  it('are not selectable unless they ship', async () => {
    assert.equal(LOCALES.includes(/** @type {any} */ ('pt')), false);
    assert.equal(await setLocale('pt'), 'en');
    assert.equal(await setLocale('xx'), 'en');
    await setLocale('en');
  });

  it('load to false, not an error, when their files are missing or unknown', async () => {
    const i18n = await browserLikeI18n();
    const warn = console.warn;
    /** @type {unknown[][]} */
    const warnings = [];
    console.warn = (...args) => warnings.push(args);
    try {
      assert.equal(await i18n.loadLocale('es', () => Promise.reject(new Error('offline'))), false);
      assert.equal(i18n.isLocaleLoaded('es'), false);
      assert.equal(i18n.t('nav.settings', undefined, 'es'), 'Settings');
      assert.equal(await i18n.loadLocale('xx'), false);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
  });

  it('share one request between concurrent loads', async () => {
    const i18n = await browserLikeI18n();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return { root: {}, namespaces: {} };
    };
    const [a, b] = await Promise.all([i18n.loadLocale('it', load), i18n.loadLocale('it', load)]);
    assert.deepEqual([a, b, calls], [true, true, 1]);
  });

  it('load the real files of a shipped language on demand', async () => {
    const i18n = await browserLikeI18n();
    assert.equal(i18n.isLocaleLoaded('tr'), false);
    assert.equal(await i18n.setLocale('tr'), 'tr');
    assert.equal(i18n.t('nav.settings'), 'Ayarlar');
    assert.equal(i18n.t('shell.theme.dark'), 'Koyu');
    assert.equal(i18n.getIntlLocale(), 'tr-TR');
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
