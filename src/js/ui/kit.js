// @ts-check
// UI kit: the small building blocks the shell and the feature views share, as HTML strings that are
// escaped by default, plus toasts.
//
// Contract:
// - html`…` escapes every interpolated value unless it is SafeHtml: the result of html`…`, of raw()
//   or of a builder below. Arrays are joined; null, undefined and false render nothing. Hand the
//   result to setHtml() (dom.js), which also renders the icons.
// - Texts are Labels: an i18n key (string), { key, params } or { text } for literal text. Keys are
//   written as data-i18n (and data-i18n-params), so a language switch relabels them in place.
// - Icons are <i data-lucide> placeholders; every name used must be registered in icons.js.
// - A status always shows an icon and a word, never colour alone.
import { refreshIcons } from '../icons.js';
import { t } from '../i18n/index.js';

/** @typedef {string | { key: string, params?: Record<string, string | number> } | { text: string }} Label */
/** @typedef {'neutral' | 'ok' | 'warn' | 'danger' | 'info'} Tone */
/** @typedef {'checked' | 'mixed' | 'unchecked' | 'web' | 'device' | 'withheld'} Provenance */

/** Markup that is already safe to insert (built here, or vouched for with raw()). */
export class SafeHtml {
  /** @param {string} value */
  constructor(value) {
    /** @readonly */
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

/** @type {Record<string, string>} */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapes text for HTML text and quoted attribute values.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/**
 * Marks markup as trusted. Only for markup the caller built or sanitized itself.
 * @param {string | SafeHtml} markup
 * @returns {SafeHtml}
 */
export function raw(markup) {
  return markup instanceof SafeHtml ? markup : new SafeHtml(String(markup));
}

/** @param {unknown} value @returns {string} */
function interpolate(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

/**
 * Tagged template that escapes its values: html`<p>${userText}</p>`.
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {SafeHtml}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += interpolate(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/**
 * @param {Label} label
 * @returns {{ key: string | null, params?: Record<string, string | number>, text: string }}
 */
function resolve(label) {
  if (typeof label === 'string') return { key: label, text: t(label) };
  if ('key' in label) return { key: label.key, params: label.params, text: t(label.key, label.params) };
  return { key: null, text: label.text };
}

/**
 * The translated text of a Label.
 * @param {Label} label
 */
export function labelText(label) {
  return resolve(label).text;
}

/**
 * A Label as an element that keeps its i18n key, or as escaped literal text.
 * @param {Label} value
 * @param {{ tag?: 'span' | 'p' | 'strong' | 'h2' | 'h3' | 'h4', className?: string, id?: string }} [opts]
 * @returns {SafeHtml}
 */
export function label(value, opts = {}) {
  const tag = opts.tag ?? 'span';
  const { key, params, text } = resolve(value);
  const attrs = html`${opts.id ? html` id="${opts.id}"` : ''}${opts.className ? html` class="${opts.className}"` : ''}${key ? html` data-i18n="${key}"` : ''}${key && params ? html` data-i18n-params="${JSON.stringify(params)}"` : ''}`;
  return raw(`<${tag}${attrs.value}>${escapeHtml(text)}</${tag}>`);
}

/**
 * aria-label (and its i18n key) for a Label.
 * @param {Label | undefined} name
 * @returns {SafeHtml}
 */
function ariaName(name) {
  if (!name) return raw('');
  const { key, params, text } = resolve(name);
  return html` aria-label="${text}"${key ? html` data-i18n-aria="${key}"` : ''}${key && params ? html` data-i18n-params="${JSON.stringify(params)}"` : ''}`;
}

/**
 * title (and its i18n key) for a Label.
 * @param {Label | null | undefined} hint
 * @returns {SafeHtml}
 */
function titleOf(hint) {
  if (!hint) return raw('');
  const { key, params, text } = resolve(hint);
  return html` title="${text}"${key ? html` data-i18n-title="${key}"` : ''}${key && params ? html` data-i18n-params="${JSON.stringify(params)}"` : ''}`;
}

/**
 * A decorative Lucide icon placeholder (lucide marks the SVG aria-hidden).
 * @param {string} name kebab-case name, registered in icons.js
 * @param {string} [className]
 */
export function icon(name, className = 'w-4 h-4') {
  return html`<i data-lucide="${name}" class="${className}"></i>`;
}

/** @param {number | undefined} level @param {number} fallback */
function headingTag(level, fallback) {
  return /** @type {'h2' | 'h3' | 'h4'} */ (`h${Math.min(4, Math.max(2, Math.round(level ?? fallback)))}`);
}

/**
 * A card; with a title it gets a header row (title on the left, badges on the right).
 * @param {{ title?: Label, icon?: string, level?: number, badges?: SafeHtml | SafeHtml[], body: SafeHtml | SafeHtml[], footer?: SafeHtml, id?: string, className?: string }} opts
 * @returns {SafeHtml}
 */
export function card(opts) {
  const head = opts.title
    ? html`<div class="card-header"><${raw(headingTag(opts.level, 3))} class="card-title">${opts.icon ? icon(opts.icon, 'w-4 h-4 text-amber-600') : ''}${label(opts.title)}</${raw(headingTag(opts.level, 3))}>${opts.badges ? html`<div class="flex flex-wrap items-center gap-1.5">${opts.badges}</div>` : ''}</div>`
    : '';
  const footer = opts.footer ? html`<div class="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-end gap-2">${opts.footer}</div>` : '';
  return html`<div${opts.id ? html` id="${opts.id}"` : ''} class="card p-4 sm:p-5 space-y-4${opts.className ? ` ${opts.className}` : ''}">${head}<div class="space-y-3">${opts.body}</div>${footer}</div>`;
}

/** @type {Readonly<Record<Tone, { css: string, icon: string }>>} */
export const TONES = Object.freeze({
  neutral: { css: 'chip-neutral', icon: 'circle-dashed' },
  ok: { css: 'chip-ok', icon: 'check-circle-2' },
  warn: { css: 'chip-warn', icon: 'triangle-alert' },
  danger: { css: 'chip-danger', icon: 'octagon-alert' },
  info: { css: 'chip-info', icon: 'info' },
});

/**
 * A small status chip: an icon (by tone, or the given one) and a text.
 * @param {{ label: Label, tone?: Tone, icon?: string, className?: string }} opts
 * @returns {SafeHtml}
 */
export function chip(opts) {
  const tone = TONES[opts.tone ?? 'neutral'] ?? TONES.neutral;
  return html`<span class="chip ${tone.css}${opts.className ? ` ${opts.className}` : ''}">${icon(opts.icon ?? tone.icon, '')}${label(opts.label)}</span>`;
}

/** @type {Readonly<Record<Provenance, { css: string, icon: string, key: string }>>} */
export const PROVENANCE = Object.freeze({
  checked: { css: 'label-checked', icon: 'shield-check', key: 'shell.label.checked' },
  mixed: { css: 'label-mixed', icon: 'shield-alert', key: 'shell.label.mixed' },
  unchecked: { css: 'label-unchecked', icon: 'message-square', key: 'shell.label.unchecked' },
  web: { css: 'label-web', icon: 'globe', key: 'shell.label.web' },
  device: { css: 'label-device', icon: 'hard-drive', key: 'shell.label.device' },
  withheld: { css: 'label-withheld', icon: 'eye-off', key: 'shell.label.withheld' },
});

/**
 * A provenance label: where a text comes from and whether it was checked.
 * @param {Provenance} kind
 * @param {{ label?: Label, hint?: Label | null, className?: string }} [opts] label replaces the default text; hint becomes the tooltip
 * @returns {SafeHtml}
 */
export function provenanceBadge(kind, opts = {}) {
  const def = PROVENANCE[kind] ?? PROVENANCE.unchecked;
  return html`<span class="label-badge ${def.css}${opts.className ? ` ${opts.className}` : ''}" data-provenance="${kind}"${titleOf(opts.hint)}>${icon(def.icon, '')}${label(opts.label ?? def.key)}</span>`;
}

/**
 * Secondary content behind a summary row (<details>).
 * @param {{ summary: Label, body: SafeHtml | SafeHtml[], icon?: string, open?: boolean, id?: string, className?: string }} opts
 * @returns {SafeHtml}
 */
export function disclosure(opts) {
  return html`<details${opts.id ? html` id="${opts.id}"` : ''} class="disclosure${opts.className ? ` ${opts.className}` : ''}"${opts.open ? raw(' open') : ''}><summary>${opts.icon ? icon(opts.icon, 'w-4 h-4 text-amber-600') : ''}${label(opts.summary)}${icon('chevron-down', 'disclosure-chevron')}</summary><div class="disclosure-body">${opts.body}</div></details>`;
}

/**
 * A segmented control: one choice of a few, as toggle buttons (aria-pressed) in a named group. Each
 * button dispatches `action` with its value as data-arg (dom.js delegation).
 * @param {{ action: string, label: Label, value: string, options: Array<{ value: string, label: Label, icon?: string, id?: string }>, id?: string, className?: string }} opts
 * @returns {SafeHtml}
 */
export function segmented(opts) {
  const buttons = opts.options.map(
    (o) =>
      html`<button type="button"${o.id ? html` id="${o.id}"` : ''} data-action="${opts.action}" data-arg="${o.value}" aria-pressed="${String(o.value === opts.value)}">${o.icon ? icon(o.icon, 'w-3.5 h-3.5') : ''}${label(o.label)}</button>`,
  );
  return html`<div${opts.id ? html` id="${opts.id}"` : ''} class="segmented${opts.className ? ` ${opts.className}` : ''}" role="group"${ariaName(opts.label)}>${buttons}</div>`;
}

/**
 * Marks the pressed segment of a rendered segmented control without re-rendering it.
 * @param {Element | null} group
 * @param {string} value
 */
export function setSegmentedValue(group, value) {
  for (const btn of group?.querySelectorAll('button[data-arg]') ?? []) btn.setAttribute('aria-pressed', String(btn.getAttribute('data-arg') === value));
}

/**
 * A quiet placeholder for a view or panel without content.
 * @param {{ body: Label, title?: Label, icon?: string, level?: number }} opts
 * @returns {SafeHtml}
 */
export function emptyState(opts) {
  return html`<div class="empty-state">${icon(opts.icon ?? 'inbox', '')}${opts.title ? label(opts.title, { tag: headingTag(opts.level, 2), className: 'text-base font-semibold text-slate-900' }) : ''}${label(opts.body, { tag: 'p' })}</div>`;
}

const TOAST_LIMIT = 3;

/**
 * Shows a short notice in the toast region (#toastRegion, a polite live region): an icon by tone,
 * the text and a dismiss button. It disappears after `timeoutMs` (0 keeps it until dismissed).
 * @param {Label} message
 * @param {{ tone?: Tone, timeoutMs?: number }} [opts]
 * @returns {() => void} dismisses the toast
 */
export function toast(message, opts = {}) {
  const region = document.getElementById('toastRegion');
  if (!region) return () => {};
  const tone = opts.tone ?? 'info';
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.innerHTML = html`${icon(TONES[tone]?.icon ?? 'info', '')}${label(message, { className: 'flex-1 min-w-0' })}<button type="button" class="btn btn-ghost p-1 -my-1 -mr-1.5"${ariaName('shell.toast.dismiss')}>${icon('x', 'w-3.5 h-3.5')}</button>`.value;
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    el.remove();
  };
  el.querySelector('button')?.addEventListener('click', dismiss);
  while (region.children.length >= TOAST_LIMIT) region.firstElementChild?.remove();
  region.append(el);
  refreshIcons(el);
  const timeout = opts.timeoutMs ?? 6000;
  if (timeout > 0) timer = window.setTimeout(dismiss, timeout);
  return dismiss;
}
