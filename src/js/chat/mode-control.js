// @ts-check
// The composer's mode row: the segmented control Auto · Free · Grounded, the Thinking and Web
// toggles, and the hint and placeholder that say what the chosen mode does.
//
// The thread decides Auto per question with ai/hybrid.js (what the question carries and names,
// the workspace probe; a decider set with hooks.js setRouteDecider runs first and can only tighten
// the route). Free never searches sources; Grounded always does, and every answer gets the source
// check and a receipt.
import { byId, onAction } from '../dom.js';
import { setText, t } from '../i18n/index.js';
import { getChatMode, getWebSearch, onChatModeChange, onWebSearchChange, setChatMode, setWebSearch } from '../state.js';

/** Hint and placeholder per mode. */
const MODE_TEXT = Object.freeze({
  auto: { hint: 'chat-thread.mode.auto_hint', placeholder: 'chat-thread.mode.placeholder_auto' },
  free: { hint: 'chat.mode_free_hint', placeholder: 'chat.placeholder_free' },
  grounded: { hint: 'chat.mode_grounded_hint', placeholder: 'chat.placeholder' },
});

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
