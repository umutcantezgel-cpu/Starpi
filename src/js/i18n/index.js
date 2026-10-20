// @ts-check
// Zero-dependency runtime localization. English is the default; German, French, Spanish, Italian and
// Turkish are one choice away and the choice is kept in localStorage. Switching never reloads the
// page: static markup is re-translated through data-i18n* attributes and dynamic views subscribe to
// onLocaleChange().
//
// Dictionaries come from src/locales (see src/locales/index.js): a root file per language plus
// namespace files whose keys are reached as `<ns>.<key>`. English ships with the app bundle and is
// the fallback for every key another language lacks; other languages are loaded when chosen. This
// module waits for the stored language before it finishes loading (top-level await), so t() is
// synchronous everywhere and the first render is already in the right language.
//
// Markup contract (applied by applyTranslations()):
//   data-i18n="ns.key"               -> textContent
//   data-i18n-placeholder="ns.key"   -> placeholder attribute
//   data-i18n-title="ns.key"         -> title attribute
//   data-i18n-aria="ns.key"          -> aria-label attribute
//   data-i18n-params='{"n":3}'       -> interpolation values for any of the above
// Only textContent and attributes are written, never HTML.
import { ENGLISH, loadLocaleFiles, SHIPPED_LOCALES } from '../../locales/index.js';

/** @typedef {'en' | 'de' | 'fr' | 'es' | 'it' | 'tr'} Locale */
/** @typedef {Record<string, string | number>} Params */
/** @typedef {import('../../locales/index.js').Dictionary} Dictionary */
/** @typedef {import('../../locales/index.js').LocaleFiles} LocaleFiles */
/** @typedef {{ name: string, short: string, intl: string }} Language */

/**
 * Languages the UI is prepared for: the name in the language itself, the short label of the
 * language switch and the BCP 47 tag for Intl and speech recognition. Only those with dictionaries
 * (SHIPPED_LOCALES) can be chosen.
 * @type {Readonly<Record<string, Language>>}
 */
export const LANGUAGES = Object.freeze({
  en: { name: 'English', short: 'EN', intl: 'en-US' },
  de: { name: 'Deutsch', short: 'DE', intl: 'de-DE' },
  fr: { name: 'Français', short: 'FR', intl: 'fr-FR' },
  es: { name: 'Español', short: 'ES', intl: 'es-ES' },
  it: { name: 'Italiano', short: 'IT', intl: 'it-IT' },
  tr: { name: 'Türkçe', short: 'TR', intl: 'tr-TR' },
});

export const LOCALES = /** @type {readonly Locale[]} */ (Object.freeze(SHIPPED_LOCALES.filter((code) => Object.hasOwn(LANGUAGES, code))));
export const DEFAULT_LOCALE = /** @type {Locale} */ ('en');
export const STORAGE_KEY = 'starpi_locale';

/**
 * Merges namespace dictionaries into a copy of the root dictionary, each under its namespace key.
 * A key that is already defined keeps its first value; its path is added to `conflicts`.
 * @param {Dictionary} root
 * @param {Record<string, Dictionary>} namespaces
 * @param {string[]} [conflicts]
 * @returns {Dictionary}
 */
export function buildDictionary(root, namespaces, conflicts = []) {
  /** @type {Dictionary} */
  const out = structuredClone(root);
  /**
   * @param {Dictionary} target
   * @param {Dictionary} source
   * @param {string} path
   */
  const merge = (target, source, path) => {
    for (const [key, value] of Object.entries(source)) {
      // A locale file never names these; skipping them keeps a crafted one off Object.prototype.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const at = `${path}.${key}`;
      const existing = target[key];
      if (typeof value === 'string') {
        if (existing === undefined) target[key] = value;
        else conflicts.push(at);
      } else if (existing === undefined) {
        target[key] = structuredClone(value);
      } else if (typeof existing === 'object') {
        merge(existing, value, at);
      } else {
        conflicts.push(at);
      }
    }
  };
  for (const [ns, dict] of Object.entries(namespaces)) {
    const slot = out[ns];
    if (slot === undefined) out[ns] = structuredClone(dict);
    else if (typeof slot === 'object') merge(slot, dict, ns);
    else conflicts.push(ns);
  }
  return out;
}

/** Loaded dictionaries by language code; English is always present. @type {Map<string, Dictionary>} */
const dictionaries = new Map([['en', buildDictionary(ENGLISH.root, ENGLISH.namespaces)]]);
/** @type {Map<string, Promise<boolean>>} */
const loading = new Map();

/** @param {unknown} value @returns {value is Locale} */
function isLocale(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (LOCALES).includes(value);
}

/**
 * Loads a prepared language's dictionaries once (concurrent calls share the request). Never throws:
 * a language that cannot be loaded (unknown, not shipped, offline before its files were cached)
 * resolves to false and its keys keep showing English.
 * @param {string} locale
 * @param {(locale: string) => Promise<LocaleFiles>} [load] where the files come from (default: src/locales)
 * @returns {Promise<boolean>}
 */
export function loadLocale(locale, load = loadLocaleFiles) {
  if (dictionaries.has(locale)) return Promise.resolve(true);
  if (!Object.hasOwn(LANGUAGES, locale)) return Promise.resolve(false);
  const pending = loading.get(locale);
  if (pending) return pending;
  const request = (async () => {
    try {
      const files = await load(locale);
      dictionaries.set(locale, buildDictionary(files.root, files.namespaces));
      return true;
    } catch (err) {
      console.warn(`[starpi] the ${locale} dictionary could not be loaded; English is shown instead`, err);
      return false;
    } finally {
      loading.delete(locale);
    }
  })();
  loading.set(locale, request);
  return request;
}

/**
 * @param {string} locale
 * @returns {boolean} whether the language's dictionaries are loaded
 */
export function isLocaleLoaded(locale) {
  return dictionaries.has(locale);
}

function readStoredLocale() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
  return DEFAULT_LOCALE;
}

/** @type {Locale} */
let current = readStoredLocale();
/** Counts language switches, so a slow load never overrides a later choice. */
let switches = 0;
/** @type {Set<(locale: Locale) => void>} */
const listeners = new Set();

// Node (tests, build tools) has no stored choice and may ask for any language: load them all.
// In the browser only the stored language is loaded before the app starts.
if (/** @type {any} */ (globalThis).process?.versions?.node) {
  await Promise.all(LOCALES.map((locale) => loadLocale(locale)));
} else if (current !== DEFAULT_LOCALE && !(await loadLocale(current))) {
  current = DEFAULT_LOCALE;
}

/** @returns {Locale} */
export function getLocale() {
  return current;
}

/** BCP 47 tag for Intl formatting and speech recognition. */
export function getIntlLocale() {
  return LANGUAGES[current]?.intl ?? 'en-US';
}

/**
 * @param {Dictionary | undefined} dict
 * @param {string} key
 * @returns {string | undefined}
 */
function lookup(dict, key) {
  /** @type {string | Dictionary | undefined} */
  let node = dict;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Whether a key has its own entry in a language (English fallbacks do not count).
 * @param {string} key
 * @param {string} [locale]
 */
export function hasKey(key, locale = current) {
  return lookup(dictionaries.get(locale), key) !== undefined;
}

/**
 * Translates a key. Falls back to English, then to the key itself, so a missing entry is visible
 * instead of silently empty. `{name}` placeholders are replaced from params; `{name:one|other}`
 * picks the singular or plural word for the count in `name` ("{n} {n:chunk|chunks}").
 * @param {string} key
 * @param {Params} [params]
 * @param {string} [locale]
 */
export function t(key, params, locale = current) {
  const template = lookup(dictionaries.get(locale), key) ?? lookup(dictionaries.get(DEFAULT_LOCALE), key) ?? key;
  if (!params) return template;
  return template
    .replace(/\{(\w+):([^|{}]*)\|([^{}]*)\}/g, (match, name, one, other) => (name in params ? (String(params[name]) === '1' ? one : other) : match))
    .replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/**
 * @param {number} value
 * @param {Intl.NumberFormatOptions} [options]
 */
export function formatNumber(value, options) {
  return new Intl.NumberFormat(getIntlLocale(), options).format(value);
}

/**
 * @param {Date} value
 * @param {Intl.DateTimeFormatOptions} [options]
 */
export function formatDate(value, options = { dateStyle: 'medium' }) {
  return Number.isNaN(value.getTime()) ? '–' : new Intl.DateTimeFormat(getIntlLocale(), options).format(value);
}

/** @param {Element} el */
function paramsOf(el) {
  const raw = el.getAttribute('data-i18n-params');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? /** @type {Params} */ (parsed) : undefined;
  } catch {
    return undefined;
  }
}

const ATTRIBUTE_BINDINGS = /** @type {const} */ ([
  ['data-i18n-placeholder', 'placeholder'],
  ['data-i18n-title', 'title'],
  ['data-i18n-aria', 'aria-label'],
]);

const ANNOTATED = '[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria]';

/**
 * Translates every annotated element under root (and root itself).
 * @param {Element | Document} [root]
 */
export function applyTranslations(root = document) {
  /** @type {Element[]} */
  const elements = [...root.querySelectorAll(ANNOTATED)];
  if (root instanceof Element && root.matches(ANNOTATED)) elements.unshift(root);
  for (const el of elements) {
    const params = paramsOf(el);
    const textKey = el.getAttribute('data-i18n');
    if (textKey) el.textContent = t(textKey, params);
    for (const [source, target] of ATTRIBUTE_BINDINGS) {
      const key = el.getAttribute(source);
      if (key) el.setAttribute(target, t(key, params));
    }
  }
  for (const btn of document.querySelectorAll('[data-action="set-locale"]')) {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-arg') === current));
  }
  for (const select of document.querySelectorAll('select[data-change="set-locale"]')) {
    /** @type {HTMLSelectElement} */ (select).value = current;
  }
}

/**
 * Sets translated text on an element and remembers the key, so a later language switch
 * re-translates it without the caller re-rendering.
 * @param {Element | null} el
 * @param {string} key
 * @param {Params} [params]
 */
export function setText(el, key, params) {
  if (!el) return;
  el.setAttribute('data-i18n', key);
  if (params) el.setAttribute('data-i18n-params', JSON.stringify(params));
  else el.removeAttribute('data-i18n-params');
  el.textContent = t(key, params);
}

/** @param {Locale} locale */
function apply(locale) {
  current = locale;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    // Not persisted; the switch still applies to this page.
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    applyTranslations(document);
  }
  for (const fn of listeners) {
    try {
      fn(locale);
    } catch (err) {
      console.error('[starpi] locale listener failed', err);
    }
  }
}

/**
 * Switches the language at runtime, persists it and notifies subscribers. A loaded language switches
 * at once (before this returns); another one switches when its dictionaries arrive, unless a later
 * call chose differently. A language that fails to load leaves the current one in place.
 * @param {string} next
 * @returns {Promise<Locale>} the language in effect afterwards
 */
export function setLocale(next) {
  const locale = isLocale(next) ? next : DEFAULT_LOCALE;
  const request = ++switches;
  if (dictionaries.has(locale)) {
    apply(locale);
    return Promise.resolve(locale);
  }
  return loadLocale(locale).then((loaded) => {
    if (loaded && request === switches) apply(locale);
    return current;
  });
}

/**
 * @param {(locale: Locale) => void} fn
 * @returns {() => void}
 */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Applies the stored (or default) language to the document once at boot. */
export function initI18n() {
  current = readStoredLocale();
  if (!dictionaries.has(current)) current = DEFAULT_LOCALE;
  document.documentElement.lang = current;
  applyTranslations(document);
}
