// @ts-check
// Lightweight, zero-dependency client-side translation module.
// English ('en') is the default locale for all incoming users.
// Persisted under 'starpi_locale' in localStorage with reactive runtime toggle without page reload.

import deDict from '../../locales/de.json' with { type: 'json' };
import enDict from '../../locales/en.json' with { type: 'json' };

/** @typedef {'en' | 'de'} Locale */

const STORAGE_KEY = 'starpi_locale';
const DEFAULT_LOCALE = 'en';

/** @type {Record<Locale, Record<string, any>>} */
const DICTIONARIES = {
  en: enDict,
  de: deDict,
};

/** @type {Set<(locale: Locale) => void>} */
const changeListeners = new Set();

/**
 * Returns the currently active locale.
 * @returns {Locale}
 */
export function getLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'de' || saved === 'en') return saved;
  } catch {
    // localStorage might be unavailable or restricted.
  }
  return DEFAULT_LOCALE;
}

/**
 * Looks up a dotted translation key in dictionary.
 * @param {Record<string, any>} dict
 * @param {string} path
 * @returns {string | undefined}
 */
function lookup(dict, path) {
  const parts = path.split('.');
  let current = dict;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

/**
 * Translates a key for the current locale with optional string interpolation.
 * Falls back to English if the key is missing in the active locale.
 *
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function t(key, params) {
  const currentLocale = getLocale();
  let str = lookup(DICTIONARIES[currentLocale], key);
  if (str === undefined && currentLocale !== 'en') {
    str = lookup(DICTIONARIES.en, key);
  }
  if (str === undefined) {
    return key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
  }
  return str;
}

/**
 * Sets the active locale, persists it, updates DOM attributes, and notifies listeners.
 * @param {Locale} newLocale
 */
export function setLocale(newLocale) {
  const target = newLocale === 'de' ? 'de' : 'en';
  try {
    localStorage.setItem(STORAGE_KEY, target);
  } catch {
    // ignore storage quota/permission errors
  }

  document.documentElement.lang = target;
  applyTranslations();

  for (const listener of changeListeners) {
    try {
      listener(target);
    } catch (err) {
      console.error('[i18n] listener failed', err);
    }
  }
}

/**
 * Subscribes to locale change events.
 * @param {(locale: Locale) => void} fn
 * @returns {() => void} Unsubscribe function
 */
export function onLocaleChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/**
 * Scans elements inside root (default: document) with data-i18n attributes
 * and updates their text content, placeholder, title, and aria-labels.
 * @param {Element | Document} [root]
 */
export function applyTranslations(root = document) {
  const currentLocale = getLocale();
  document.documentElement.lang = currentLocale;

  // 1. Text content
  const textElements = root.querySelectorAll('[data-i18n]');
  for (const el of textElements) {
    const key = el.getAttribute('data-i18n');
    if (!key) continue;
    const translation = t(key);
    if (translation && translation !== key) {
      el.textContent = translation;
    }
  }

  // 2. Placeholders
  const placeholderElements = root.querySelectorAll('[data-i18n-placeholder]');
  for (const el of placeholderElements) {
    const key = el.getAttribute('data-i18n-placeholder');
    if (!key) continue;
    const translation = t(key);
    if (translation && translation !== key) {
      el.setAttribute('placeholder', translation);
    }
  }

  // 3. Titles / Tooltips
  const titleElements = root.querySelectorAll('[data-i18n-title]');
  for (const el of titleElements) {
    const key = el.getAttribute('data-i18n-title');
    if (!key) continue;
    const translation = t(key);
    if (translation && translation !== key) {
      el.setAttribute('title', translation);
    }
  }

  // 4. Aria labels
  const ariaElements = root.querySelectorAll('[data-i18n-aria]');
  for (const el of ariaElements) {
    const key = el.getAttribute('data-i18n-aria');
    if (!key) continue;
    const translation = t(key);
    if (translation && translation !== key) {
      el.setAttribute('aria-label', translation);
    }
  }

  // 5. Update language toggle active button styles if present
  const toggleEn = root.querySelector('[data-action="set-locale"][data-arg="en"]');
  const toggleDe = root.querySelector('[data-action="set-locale"][data-arg="de"]');
  if (toggleEn && toggleDe) {
    const activeClasses = ['bg-white', 'text-slate-950', 'shadow-xs', 'font-bold'];
    const inactiveClasses = ['text-slate-500', 'hover:text-slate-900', 'font-medium'];

    if (currentLocale === 'en') {
      toggleEn.classList.add(...activeClasses);
      toggleEn.classList.remove(...inactiveClasses);
      toggleDe.classList.remove(...activeClasses);
      toggleDe.classList.add(...inactiveClasses);
    } else {
      toggleDe.classList.add(...activeClasses);
      toggleDe.classList.remove(...inactiveClasses);
      toggleEn.classList.remove(...activeClasses);
      toggleEn.classList.add(...inactiveClasses);
    }
  }
}
