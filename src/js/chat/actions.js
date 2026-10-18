// @ts-check
// The action bar under a message: Copy and Copy as Markdown (answers), Regenerate with a model menu
// (answers), Edit (questions; the edited question becomes a new branch), the branch navigator
// ‹ 2/3 ›, Continue (an answer that stopped at its length limit, as a new turn), the speaker button
// of the voice features (read aloud; voice/hooks.js speakerButton, handled there), and the actions
// other features register (hooks.js registerMessageAction, e.g. "Research this").
//
// The bar is plain buttons with data-action and the message's node id as data-arg; dom.js delegates
// the clicks, and the thread passes its handlers once (initActions). Labels are i18n keys.
import { copyAnswer } from '../code-blocks.js';
import { byId, onAction } from '../dom.js';
import { refreshIcons } from '../icons.js';
import { setText, t } from '../i18n/index.js';
import { speakerButton } from '../features/voice.js';
import { escapeHtml } from '../render.js';
import { messageActions } from './hooks.js';

/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */

/**
 * What the bar of one message shows.
 * @typedef {object} BarState
 * @property {NodeRecord} node
 * @property {{ position: number, count: number } | null} branch
 * @property {boolean} canContinue   the answer stopped at its length limit and is the newest message
 * @property {boolean} busy          an answer is being written (regenerate, edit and continue wait)
 */

/**
 * @typedef {object} ActionHandlers
 * @property {(nodeId: string, value: string | null) => unknown} regenerate  value: another picker value, or null for the same model
 * @property {(nodeId: string, text: string) => unknown} edit
 * @property {(nodeId: string, delta: number) => unknown} branch
 * @property {(nodeId: string) => unknown} continueAnswer
 * @property {(nodeId: string) => NodeRecord | null} node
 * @property {() => string} conversationId
 */

/** @type {ActionHandlers | null} */
let handlers = null;

/**
 * A small icon button of the bar.
 * @param {{ action: string, nodeId: string, icon: string, labelKey: string, disabled?: boolean, text?: boolean, extra?: string }} opts
 */
function button(opts) {
  const { action, nodeId, icon, labelKey } = opts;
  const label = escapeHtml(t(labelKey));
  const text = opts.text ? `<span class="msg-action-text" data-i18n="${labelKey}">${label}</span>` : '';
  return `<button type="button" class="msg-action btn btn-ghost px-1.5 py-1 text-[11px]" data-action="${action}" data-arg="${escapeHtml(nodeId)}"${opts.extra ?? ''} data-i18n-aria="${labelKey}" aria-label="${label}" data-i18n-title="${labelKey}" title="${label}"${opts.disabled ? ' disabled' : ''}><i data-lucide="${icon}" class="w-3.5 h-3.5"></i>${text}</button>`;
}

/**
 * Fills the action bar of a message element.
 * @param {HTMLElement} el  the message row (appendMessage / createStreamingMessage)
 * @param {BarState} state
 */
export function renderActions(el, state) {
  const bar = el.querySelector('.message-actions');
  if (!bar) return;
  const { node, branch, busy } = state;
  const id = node.id;
  const answer = node.role === 'assistant';
  const parts = [];
  parts.push(button({ action: 'msg-copy', nodeId: id, icon: 'copy', labelKey: 'chat-thread.action.copy' }));
  if (answer) {
    parts.push(button({ action: 'msg-copy-md', nodeId: id, icon: 'braces', labelKey: 'chat-thread.action.copy_md' }));
    parts.push(speakerButton(id, { className: 'msg-action', compact: true }).value);
    parts.push(
      `<details class="regen-menu relative inline-block" data-node="${escapeHtml(id)}"><summary class="msg-action btn btn-ghost px-1.5 py-1 text-[11px] list-none cursor-pointer" data-i18n-aria="chat-thread.action.regenerate" aria-label="${escapeHtml(t('chat-thread.action.regenerate'))}" data-i18n-title="chat-thread.action.regenerate" title="${escapeHtml(t('chat-thread.action.regenerate'))}"${busy ? ' aria-disabled="true"' : ''}><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i><i data-lucide="chevron-down" class="w-3 h-3"></i></summary><div class="regen-list absolute left-0 bottom-full z-30 mb-1 w-64 max-h-72 overflow-y-auto card p-1 flex flex-col" role="menu"></div></details>`,
    );
  } else {
    parts.push(button({ action: 'msg-edit', nodeId: id, icon: 'square-pen', labelKey: 'chat-thread.action.edit', disabled: busy }));
  }
  if (branch && branch.count > 1) {
    parts.push(
      `<span class="branch-nav inline-flex items-center gap-0.5 text-[11px] ${answer ? 'text-slate-600' : 'text-slate-200'}">${button({ action: 'msg-branch-prev', nodeId: id, icon: 'arrow-left', labelKey: 'chat-thread.action.branch_prev', disabled: busy || branch.position <= 1 })}<span class="branch-pos font-mono" aria-live="polite">${branch.position}/${branch.count}</span>${button({ action: 'msg-branch-next', nodeId: id, icon: 'arrow-right', labelKey: 'chat-thread.action.branch_next', disabled: busy || branch.position >= branch.count })}</span>`,
    );
  }
  if (answer && state.canContinue) parts.push(button({ action: 'msg-continue', nodeId: id, icon: 'arrow-right', labelKey: 'chat-thread.action.continue', disabled: busy, text: true }));
  for (const action of messageActions.values()) {
    const fits = action.when ? action.when(node) : answer;
    if (fits) parts.push(button({ action: 'msg-extra', nodeId: id, icon: action.icon, labelKey: action.labelKey, extra: ` data-extra="${escapeHtml(action.id)}"` }));
  }
  // On the dark bubble of a question the bar keeps a light ink.
  bar.className = `message-actions mt-2 flex flex-wrap items-center gap-0.5 ${answer ? 'text-slate-500' : 'text-slate-200 on-dark'}`;
  bar.innerHTML = parts.join('');
  refreshIcons(bar);
}

/**
 * Whether an answer's question was asked to stay on this device (a free question asked on this
 * device): then only the model here or the own server answers it again.
 * @param {string} nodeId  the answer
 */
function staysOnDevice(nodeId) {
  const node = handlers?.node(nodeId) ?? null;
  const question = node?.parentId ? (handlers?.node(node.parentId) ?? null) : null;
  const route = /** @type {Record<string, unknown>} */ (node?.meta ?? {}).chat_mode ?? node?.label;
  return Boolean(question?.localOnly) && route !== 'grounded';
}

/**
 * The regenerate menu's entries, built when it opens: the same model, then the picker's choices
 * (without on-device presets that are not loaded, which would start a download; only the own
 * server's models for a question that stays on this device).
 * @param {HTMLDetailsElement} menu
 */
function fillRegenMenu(menu) {
  const list = menu.querySelector('.regen-list');
  const nodeId = menu.dataset.node ?? '';
  if (!list) return;
  const picker = /** @type {HTMLSelectElement | null} */ (byId('engineSelector'));
  const here = staysOnDevice(nodeId);
  const options = picker ? [...picker.querySelectorAll('option')].filter((o) => !o.disabled && !/^(?:webgpu|wasm):/.test(o.value) && o.value !== 'device' && (!here || o.value.startsWith('local:'))) : [];
  const entry = (/** @type {string} */ value, /** @type {string} */ text) =>
    `<button type="button" role="menuitem" class="chat-menu-item text-left" data-action="msg-regenerate" data-arg="${escapeHtml(nodeId)}" data-value="${escapeHtml(value)}">${escapeHtml(text)}</button>`;
  list.innerHTML = [entry('', t('chat-thread.action.regenerate_same')), ...options.map((o) => entry(o.value, o.textContent ?? o.value))].join('');
}

/** @param {HTMLElement} el */
function closeMenu(el) {
  const menu = el.closest('details');
  if (menu) {
    menu.open = false;
    menu.querySelector('summary')?.focus();
  }
}

/**
 * Shows "Copied" on a copy button for a moment.
 * @param {HTMLElement} btn
 * @param {boolean} ok
 */
function copied(btn, ok) {
  const key = ok ? 'chat.copied' : 'chat.copy_manual';
  btn.setAttribute('aria-label', t(key));
  btn.setAttribute('title', t(key));
  btn.dataset.copied = String(ok);
  setTimeout(() => {
    const label = btn.getAttribute('data-i18n-aria');
    if (label) {
      btn.setAttribute('aria-label', t(label));
      btn.setAttribute('title', t(label));
    }
    delete btn.dataset.copied;
  }, 1500);
}

/**
 * Turns a question into an editor in place; saving asks the thread to answer the edited question
 * as a new branch.
 * @param {HTMLElement} row
 * @param {string} nodeId
 * @param {string} text
 */
function openEditor(row, nodeId, text) {
  const content = /** @type {HTMLElement | null} */ (row.querySelector('.message-content'));
  if (!content || row.querySelector('.message-editor')) return;
  const form = document.createElement('form');
  form.className = 'message-editor flex flex-col gap-2';
  const area = document.createElement('textarea');
  area.className = 'field text-slate-900 text-sm min-h-[4rem]';
  area.value = text;
  area.setAttribute('aria-label', t('chat-thread.action.edit_label'));
  const buttons = document.createElement('div');
  buttons.className = 'flex justify-end gap-2';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary py-1';
  setText(cancel, 'chat-thread.action.edit_cancel');
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-primary py-1';
  setText(save, 'chat-thread.action.edit_save');
  buttons.append(cancel, save);
  form.append(area, buttons);
  content.hidden = true;
  content.after(form);
  area.focus();
  const close = () => {
    form.remove();
    content.hidden = false;
  };
  cancel.addEventListener('click', () => {
    close();
    /** @type {HTMLElement | null} */ (row.querySelector('[data-action="msg-edit"]'))?.focus();
  });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel.click();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = area.value.trim();
    close();
    if (next && next !== text.trim()) void handlers?.edit(nodeId, next);
  });
}

/**
 * Binds the bar's buttons to the thread.
 * @param {ActionHandlers} h
 */
export function initActions(h) {
  handlers = h;
  const rowOf = (/** @type {HTMLElement} */ el) => /** @type {HTMLElement | null} */ (el.closest('.message-row'));
  onAction('msg-copy', async (el) => {
    const row = rowOf(el);
    if (!row) return;
    const node = h.node(el.dataset.arg ?? '');
    if (row.dataset.role === 'user') {
      const text = node ? node.parts.filter((p) => p.type === 'text').map((p) => String(p.text ?? '')).join('\n\n') : (row.querySelector('.message-content')?.textContent ?? '');
      copied(el, await navigator.clipboard.writeText(text).then(() => true, () => false));
    } else copied(el, await copyAnswer(row, { format: 'text' }));
  });
  onAction('msg-copy-md', async (el) => {
    const row = rowOf(el);
    if (row) copied(el, await copyAnswer(row, { format: 'markdown' }));
  });
  onAction('msg-regenerate', (el) => {
    closeMenu(el);
    return h.regenerate(el.dataset.arg ?? '', el.dataset.value || null);
  });
  onAction('msg-edit', (el) => {
    const row = rowOf(el);
    const node = h.node(el.dataset.arg ?? '');
    if (row && node) openEditor(row, node.id, node.parts.filter((p) => p.type === 'text').map((p) => String(p.text ?? '')).join('\n\n'));
  });
  onAction('msg-branch-prev', (el) => h.branch(el.dataset.arg ?? '', -1));
  onAction('msg-branch-next', (el) => h.branch(el.dataset.arg ?? '', 1));
  onAction('msg-continue', (el) => h.continueAnswer(el.dataset.arg ?? ''));
  onAction('msg-extra', (el) => {
    const action = messageActions.get(el.dataset.extra ?? '');
    const node = h.node(el.dataset.arg ?? '');
    const row = rowOf(el);
    if (action && node && row) return action.run(node, { element: row, conversationId: h.conversationId() });
    return undefined;
  });
  // The model menu is built when it opens, so a long thread does not carry one per answer.
  document.addEventListener(
    'toggle',
    (e) => {
      const menu = e.target;
      if (menu instanceof HTMLDetailsElement && menu.classList.contains('regen-menu') && menu.open) {
        if (menu.querySelector('summary')?.getAttribute('aria-disabled') === 'true') menu.open = false;
        else fillRegenMenu(menu);
      }
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const menu = document.querySelector('details.regen-menu[open]');
    if (menu instanceof HTMLDetailsElement) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  });
  document.addEventListener('click', (e) => {
    for (const menu of document.querySelectorAll('details.regen-menu[open]')) {
      if (!(e.target instanceof Node && menu.contains(e.target))) /** @type {HTMLDetailsElement} */ (menu).open = false;
    }
  });
}
