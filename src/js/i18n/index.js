// @ts-check
// Zero-dependency runtime localization. English is the default; German is one click away and the
// choice is kept in localStorage. Switching never reloads the page: static markup is re-translated
// through data-i18n* attributes and dynamic views subscribe to onLocaleChange().
//
// Markup contract (applied by applyTranslations()):
//   data-i18n="ns.key"               -> textContent
//   data-i18n-placeholder="ns.key"   -> placeholder attribute
//   data-i18n-title="ns.key"         -> title attribute
//   data-i18n-aria="ns.key"          -> aria-label attribute
//   data-i18n-params='{"n":3}'       -> interpolation values for any of the above
// Only textContent and attributes are written, never HTML.
import de from '../../locales/de.json' with { type: 'json' };
import en from '../../locales/en.json' with { type: 'json' };

/** @typedef {'en' | 'de'} Locale */
/** @typedef {Record<string, string | number>} Params */
/** @typedef {{ [key: string]: string | Dictionary }} Dictionary */

export const LOCALES = /** @type {readonly Locale[]} */ (Object.freeze(['en', 'de']));
export const DEFAULT_LOCALE = /** @type {Locale} */ ('en');
export const STORAGE_KEY = 'starpi_locale';

/** @type {Record<Locale, Dictionary>} */
const DICTIONARIES = { en, de };
const INTL_LOCALES = /** @type {Record<Locale, string>} */ ({ en: 'en-US', de: 'de-DE' });

/** @param {unknown} value @returns {value is Locale} */
function isLocale(value) {
  return value === 'en' || value === 'de';
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
/** @type {Set<(locale: Locale) => void>} */
const listeners = new Set();

/** @returns {Locale} */
export function getLocale() {
  return current;
}

/** BCP 47 tag for Intl formatting and speech recognition. */
export function getIntlLocale() {
  return INTL_LOCALES[current];
}

/**
 * @param {Dictionary} dict
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
 * @param {string} key
 * @param {Locale} [locale]
 */
export function hasKey(key, locale = current) {
  return lookup(DICTIONARIES[locale], key) !== undefined;
}

/**
 * Translates a key. Falls back to English, then to the key itself, so a missing entry is visible
 * instead of silently empty. `{name}` placeholders are replaced from params.
 * @param {string} key
 * @param {Params} [params]
 * @param {Locale} [locale]
 */
export function t(key, params, locale = current) {
  const template = lookup(DICTIONARIES[locale], key) ?? lookup(DICTIONARIES[DEFAULT_LOCALE], key) ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
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

/**
 * Switches the language at runtime, persists it and notifies subscribers.
 * @param {string} next
 */
export function setLocale(next) {
  const locale = isLocale(next) ? next : DEFAULT_LOCALE;
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
  document.documentElement.lang = current;
  applyTranslations(document);
}
