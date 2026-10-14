// @ts-check
// Copy buttons for code blocks in rendered answers. Sanitized Markdown cannot carry buttons, classes
// or data attributes (render.js), so they are added afterwards with DOM APIs. The source check skips
// <pre> and every button that is not a citation (grounding-view.js), so they never change a verdict.
import { onAction } from './dom.js';
import { refreshIcons } from './icons.js';
import { setText, t } from './i18n/index.js';

/** @type {WeakMap<HTMLElement, ReturnType<typeof setTimeout>>} */
const labelResets = new WeakMap();

function copyButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-copy';
  btn.dataset.action = 'copy-code';
  btn.setAttribute('data-i18n-aria', 'chat.copy_code');
  btn.setAttribute('aria-label', t('chat.copy_code'));
  const icon = document.createElement('i');
  icon.dataset.lucide = 'copy';
  icon.className = 'w-3.5 h-3.5';
  const label = document.createElement('span');
  label.className = 'code-copy-label';
  setText(label, 'chat.copy');
  btn.append(icon, label);
  return btn;
}

/**
 * Wraps every code block under root in a .code-block with a copy button. Calling it again on the
 * same answer adds nothing.
 * @param {HTMLElement} root  the .message-content of an answer
 */
export function decorateCodeBlocks(root) {
  const blocks = [...root.querySelectorAll('pre')].filter((pre) => !pre.parentElement?.classList.contains('code-block'));
  if (!blocks.length) return;
  for (const pre of blocks) {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.before(wrap);
    wrap.append(pre, copyButton());
  }
  refreshIcons(root);
}

/**
 * Copies the code next to the button. Without clipboard access (permission refused, no secure
 * context) the code is selected instead, so it can be copied by hand.
 * @param {HTMLElement} btn
 * @returns {Promise<boolean>} whether the code reached the clipboard
 */
export async function copyCodeBlock(btn) {
  const pre = btn.closest('.code-block')?.querySelector('pre');
  if (!pre) return false;
  let copied = false;
  try {
    await navigator.clipboard.writeText((pre.textContent ?? '').replace(/\n$/, ''));
    copied = true;
  } catch {
    window.getSelection()?.selectAllChildren(pre);
  }
  const label = btn.querySelector('.code-copy-label');
  setText(label, copied ? 'chat.copied' : 'chat.copy_manual');
  clearTimeout(labelResets.get(btn));
  labelResets.set(btn, setTimeout(() => setText(label, 'chat.copy'), 2000));
  return copied;
}

export function initCodeBlocks() {
  onAction('copy-code', (el) => copyCodeBlock(el));
}
