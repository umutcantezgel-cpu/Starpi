// @ts-check
// Modal dialogs: focus moves into the dialog when it opens, Tab and Shift+Tab stay inside it,
// Escape closes the topmost dialog, and focus returns to the control that opened it.
import { setHidden } from './dom.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** @type {Array<{ modal: HTMLElement, trigger: HTMLElement | null, onClose?: () => void }>} */
const stack = [];

/** @param {HTMLElement} modal */
function focusables(modal) {
  return /** @type {HTMLElement[]} */ ([...modal.querySelectorAll(FOCUSABLE)]).filter((el) => el.getClientRects().length > 0);
}

/**
 * Shows a dialog and moves focus into it.
 * @param {HTMLElement | null} modal
 * @param {{ trigger?: HTMLElement | null, initialFocus?: HTMLElement | null, onClose?: () => void }} [options]
 */
export function openDialog(modal, options = {}) {
  if (!modal) return;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const existing = stack.findIndex((e) => e.modal === modal);
  if (existing !== -1) stack.splice(existing, 1);
  stack.push({ modal, trigger: options.trigger ?? active, onClose: options.onClose });
  setHidden(modal, false);
  (options.initialFocus ?? focusables(modal)[0])?.focus();
}

/**
 * Hides a dialog and returns focus to the control that opened it.
 * @param {HTMLElement | null} modal
 */
export function closeDialog(modal) {
  if (!modal) return;
  const index = stack.findIndex((e) => e.modal === modal);
  setHidden(modal, true);
  if (index === -1) return;
  const [entry] = stack.splice(index, 1);
  entry.onClose?.();
  if (entry.trigger?.isConnected) entry.trigger.focus();
}

/** @param {HTMLElement | null} modal */
export function isDialogOpen(modal) {
  return Boolean(modal && stack.some((e) => e.modal === modal));
}

document.addEventListener('keydown', (event) => {
  const top = stack.at(-1);
  if (!top) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog(top.modal);
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusables(top.modal);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const inside = top.modal.contains(document.activeElement);
  if (event.shiftKey && (!inside || document.activeElement === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
    event.preventDefault();
    first.focus();
  }
});
