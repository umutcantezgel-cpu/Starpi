// @ts-check
// The composer's mode row: the segmented control Auto · Free · Grounded, the Thinking and Web
// toggles, and the hint and placeholder that say what the chosen mode does.
//
// Auto picks per question until the routing package brings its own decision (hooks.js
// setRouteDecider): Grounded when the question carries a document or the on-device workspace holds
// files and the question carries no images only, Free otherwise. Free never searches sources;
// Grounded always does, and every answer gets the source check and a receipt.
import { byId, onAction } from '../dom.js';
import { setText, t } from '../i18n/index.js';
import { getChatMode, getWebSearch, onChatModeChange, onWebSearchChange, setChatMode, setWebSearch } from '../state.js';
import { single } from './hooks.js';

/** @typedef {import('../config.js').ChatMode} ChatMode */

/** Hint and placeholder per mode. */
const MODE_TEXT = Object.freeze({
  auto: { hint: 'chat-thread.mode.auto_hint', placeholder: 'chat-thread.mode.placeholder_auto' },
  free: { hint: 'chat.mode_free_hint', placeholder: 'chat.placeholder_free' },
  grounded: { hint: 'chat.mode_grounded_hint', placeholder: 'chat.placeholder' },
});

/**
 * The built-in route of a question: an explicit mode is kept; Auto answers from the sources when the
 * question brings a document, or brings no images and the workspace holds files.
 * @param {{ mode: ChatMode, attachments: readonly { kind: string }[], workspaceDocs: number }} input
 * @returns {'free' | 'grounded'}
 */
export function builtInRoute(input) {
  if (input.mode !== 'auto') return input.mode;
  const kinds = input.attachments.map((a) => a.kind);
  if (kinds.some((k) => k !== 'image')) return 'grounded';
  if (kinds.length > 0) return 'free';
  return input.workspaceDocs > 0 ? 'grounded' : 'free';
}

/**
 * The route of a question: the registered decider's when it decides, else the built-in rule.
 * @param {{ question: string, mode: ChatMode, attachments: readonly { name: string, kind: string }[], workspaceDocs: number }} input
 * @returns {Promise<'free' | 'grounded'>}
 */
export async function decideRoute(input) {
  if (input.mode !== 'auto') return input.mode;
  try {
    const decided = single.route ? await single.route(input) : null;
    if (decided?.route === 'free' || decided?.route === 'grounded') return decided.route;
  } catch (err) {
    console.warn('[starpi] the route decider failed; the built-in rule decides', err);
  }
  return builtInRoute(input);
}

/** @type {Promise<typeof import('../ai/thinking.js')> | null} */
let thinkingModule = null;
const thinking = () => (thinkingModule ??= import('../ai/thinking.js'));

/** @param {boolean} on */
function renderThinking(on) {
  byId('thinkingToggle')?.setAttribute('aria-pressed', String(on));
}

/** Shows the chosen mode: pressed segment, hint, placeholder, toggles. */
export function renderModeControl() {
  const mode = getChatMode();
  for (const btn of document.querySelectorAll('[data-action="set-chat-mode"]')) btn.setAttribute('aria-pressed', String(btn.getAttribute('data-arg') === mode));
  const text = MODE_TEXT[mode];
  setText(byId('chatModeHint'), text.hint);
  const input = byId('chatInput');
  input?.setAttribute('data-i18n-placeholder', text.placeholder);
  input?.setAttribute('placeholder', t(text.placeholder));
  byId('webToggle')?.setAttribute('aria-pressed', String(getWebSearch()));
}

export function initModeControl() {
  onAction('set-chat-mode', (el) => setChatMode(el.dataset.arg));
  onAction('toggle-web', () => setWebSearch(!getWebSearch()));
  onAction('toggle-thinking', async () => {
    const m = await thinking();
    m.setThinking(!m.isThinkingOn());
  });
  onChatModeChange(() => renderModeControl());
  onWebSearchChange(() => renderModeControl());
  renderModeControl();
  void thinking()
    .then((m) => {
      renderThinking(m.isThinkingOn());
      m.onThinkingChange(renderThinking);
    })
    .catch(() => {});
}
