// @ts-check
// DOM helpers and the single delegated event dispatcher that replaces inline on* handlers
// (required by the strict Content-Security-Policy).
import { refreshIcons } from './icons.js';

/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {string} id
 * @returns {T | null}
 */
export function byId(id) {
  return /** @type {T | null} */ (document.getElementById(id));
}

/**
 * @typedef {(el: HTMLElement, event: Event) => unknown} ActionHandler
 */

/** @type {Map<string, ActionHandler>} */
const clickActions = new Map();
/** @type {Map<string, ActionHandler>} */
const changeActions = new Map();

/**
 * Registers a handler for elements carrying `data-action="<name>"` (click).
 * @param {string} name
 * @param {ActionHandler} handler
 */
export function onAction(name, handler) {
  clickActions.set(name, handler);
}

/**
 * Registers a handler for elements carrying `data-change="<name>"` (change).
 * @param {string} name
 * @param {ActionHandler} handler
 */
export function onChange(name, handler) {
  changeActions.set(name, handler);
}

/**
 * @param {Map<string, ActionHandler>} registry
 * @param {string} attr
 * @param {Event} event
 */
function dispatch(registry, attr, event) {
  const target = event.target instanceof Element ? event.target : null;
  const el = /** @type {HTMLElement | null} */ (target?.closest(`[${attr}]`) ?? null);
  if (!el) return;
  const name = el.getAttribute(attr) ?? '';
  const handler = registry.get(name);
  if (!handler) {
    console.warn(`[starpi] no handler registered for ${attr}="${name}"`);
    return;
  }
  try {
    const result = handler(el, event);
    if (result instanceof Promise) result.catch(reportUnexpected);
  } catch (err) {
    reportUnexpected(err);
  }
}

/** @param {unknown} err */
export function reportUnexpected(err) {
  console.error('[starpi] unexpected error', err);
}

export function installDelegation() {
  document.addEventListener('click', (event) => dispatch(clickActions, 'data-action', event));
  document.addEventListener('change', (event) => dispatch(changeActions, 'data-change', event));
}

/**
 * Replaces the children of `el` with trusted, already-escaped/sanitized HTML and renders icons in it.
 * @param {Element} el
 * @param {string} html
 */
export function setHtml(el, html) {
  el.innerHTML = html;
  refreshIcons(el);
}

/**
 * @param {HTMLElement | null} el
 * @param {boolean} hidden
 */
export function setHidden(el, hidden) {
  el?.classList.toggle('hidden', hidden);
}
