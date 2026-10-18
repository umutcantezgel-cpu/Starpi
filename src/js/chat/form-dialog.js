// @ts-check
// A modal form built on the fly, for the editors of projects, assistants and saved notes: a card
// with a title, the form's fields, Cancel and the submit button (and optionally a destructive
// button on the left). dialog.js moves the focus in, keeps Tab inside and closes on Escape; the
// element is removed when the dialog closes. Buttons inside carry data-fd, never data-action, so
// they need no entry in the page's action registry.
import { closeDialog, openDialog } from '../dialog.js';
import { t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { html, icon, label } from '../ui/kit.js';

/** @typedef {import('../ui/kit.js').Label} Label */
/** @typedef {import('../ui/kit.js').SafeHtml} SafeHtml */

/**
 * @typedef {object} FormDialogOptions
 * @property {string} id  element id of the dialog (one dialog per id at a time)
 * @property {Label} title
 * @property {string} icon
 * @property {SafeHtml} body  the fields
 * @property {Label} submit
 * @property {Label} [danger]  a destructive action (delete) on the left
 * @property {(form: HTMLFormElement) => boolean | void | Promise<boolean | void>} onSubmit  false keeps the dialog open
 * @property {(form: HTMLFormElement) => boolean | void | Promise<boolean | void>} [onDanger]  false keeps the dialog open
 * @property {(form: HTMLFormElement) => void} [onOpen]  wires extra controls of the body
 * @property {string} [initialFocus]  selector of the control that takes the focus first
 * @property {'md' | 'lg'} [size]
 */

/**
 * Opens a form dialog.
 * @param {FormDialogOptions} opts
 * @returns {{ el: HTMLElement, form: HTMLFormElement, close: () => void }}
 */
export function openFormDialog(opts) {
  document.getElementById(opts.id)?.remove();
  const el = document.createElement('div');
  el.id = opts.id;
  el.className = 'fixed inset-0 bg-scrim/40 dark:bg-scrim/70 backdrop-blur-xs z-50 hidden flex items-end sm:items-center justify-center sm:p-4';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', `${opts.id}-title`);
  const width = opts.size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg';
  el.innerHTML = html`<form novalidate class="card w-full ${width} max-h-[92vh] overflow-y-auto custom-scrollbar p-5 shadow-2xl space-y-4 rounded-b-none sm:rounded-b-2xl">
    <div class="card-header">
      <h3 id="${opts.id}-title" class="card-title">${icon(opts.icon, 'w-4 h-4 text-amber-600')}${label(opts.title)}</h3>
      <button type="button" data-fd="close" class="btn btn-ghost p-1" aria-label="${t('app.close')}" data-i18n-aria="app.close">${icon('x', 'w-4 h-4')}</button>
    </div>
    <div class="space-y-3">${opts.body}</div>
    <p class="text-xs text-rose-700 hidden" role="alert" data-fd="error"></p>
    <div class="flex flex-wrap items-center gap-2 pt-1">
      ${opts.danger ? html`<button type="button" data-fd="danger" class="btn btn-ghost text-rose-700">${icon('trash-2', 'w-3.5 h-3.5')}${label(opts.danger)}</button>` : ''}
      <span class="flex-1"></span>
      <button type="button" data-fd="close" class="btn btn-ghost">${label('app.cancel')}</button>
      <button type="submit" class="btn btn-primary">${icon('check', 'w-3.5 h-3.5')}${label(opts.submit)}</button>
    </div>
  </form>`.value;
  document.body.append(el);
  refreshIcons(el);
  const form = /** @type {HTMLFormElement} */ (el.querySelector('form'));
  let busy = false;
  const close = () => closeDialog(el);

  /**
   * Runs a button's handler once at a time; false or a thrown error keeps the dialog open.
   * @param {(form: HTMLFormElement) => boolean | void | Promise<boolean | void>} fn
   */
  const run = async (fn) => {
    if (busy) return;
    busy = true;
    try {
      if ((await fn(form)) !== false) close();
    } catch (err) {
      console.warn('[starpi] the dialog could not finish', err);
    } finally {
      busy = false;
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run(opts.onSubmit);
  });
  el.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('[data-fd]');
    const role = button instanceof HTMLElement ? button.dataset.fd : '';
    if (role === 'close') close();
    else if (role === 'danger' && opts.onDanger) void run(opts.onDanger);
  });
  opts.onOpen?.(form);
  openDialog(el, { initialFocus: opts.initialFocus ? /** @type {HTMLElement | null} */ (form.querySelector(opts.initialFocus)) : null, onClose: () => el.remove() });
  return { el, form, close };
}

/**
 * Shows a message in the dialog's error line ('' hides it).
 * @param {HTMLFormElement} form
 * @param {Label | ''} message
 */
export function showFormError(form, message) {
  const box = /** @type {HTMLElement | null} */ (form.querySelector('[data-fd="error"]'));
  if (!box) return;
  box.classList.toggle('hidden', !message);
  box.innerHTML = message ? label(message).value : '';
}
