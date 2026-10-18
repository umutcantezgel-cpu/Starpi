// @ts-check
// The chat tab: wires the composer (chat/composer.js), the mode row (chat/mode-control.js) and the
// action bars (chat/actions.js) to the thread (chat/thread.js), and keeps the names other modules
// import from 2.x (submitChat, isChatBusy, resetConversation, restoreHistory).
//
// The thread, the AI layer and the conversation store load after the first paint: the composer
// and the mode row are here from the start, the first question (or the restored chat) loads the
// rest. Free chat sends the conversation to the chosen model without retrieval or source check;
// grounded answers come from the sources, checked sentence by sentence, with a receipt.
import { bindChatView, currentSessionId, deleteSession, refreshSyncStatus, startNewSession, switchSession } from './chat-store.js';
import { APP_VERSION } from './config.js';
import { downloadText, onAction } from './dom.js';
import { formatDate, getLocale, hasKey, t } from './i18n/index.js';
import { appendNotice } from './messages.js';
import { initActions } from './chat/actions.js';
import { initComposer, refreshSendable } from './chat/composer.js';
import { initModeControl } from './chat/mode-control.js';
import { onProvidersChange } from './providers.js';
import { onAssistantChange, onChatModeChange } from './state.js';
import { setAssistantStatus } from './ui.js';

/** @typedef {import('./config.js').ChatMode} ChatMode */

/** @type {Promise<typeof import('./chat/thread.js')> | null} */
let threadModule = null;
/** Set while a question is on its way, before the thread module has loaded. */
let starting = false;

/** @type {typeof import('./chat/thread.js') | null} */
let loaded = null;

/** The thread, loaded on first use (the restored chat at start loads it after the first paint). */
function thread() {
  threadModule ??= import('./chat/thread.js').then(
    (m) => {
      loaded = m;
      return m;
    },
    (err) => {
      threadModule = null;
      throw err;
    },
  );
  return threadModule;
}

export function isChatBusy() {
  return starting || Boolean(loaded?.isThreadBusy());
}

/** A file was added to the knowledge base: the list of known titles is read again. */
export function invalidateKnownTitles() {
  loaded?.invalidateKnownTitles();
}

/** Clears the conversation on screen (new chat, deleted history). */
export function resetConversation() {
  if (loaded) loaded.resetThread();
  else void thread().then((m) => m.resetThread());
  setAssistantStatus('status.ready');
}

/**
 * Sends a question: the composer's draft, or the given text.
 * @param {string} [rawText]  a question from elsewhere (quick prompts, the graph); omitted: the draft
 * @param {{ workspaceOnly?: boolean, chatMode?: 'grounded' | 'free' }} [options]
 */
export async function submitChat(rawText, options = {}) {
  starting = true;
  try {
    const m = await thread();
    starting = false;
    await m.sendQuestion({ ...(rawText !== undefined ? { text: rawText } : {}), ...options });
  } finally {
    starting = false;
  }
}

/** Shows the current chat session (at start and after the sync restored it). */
export async function restoreHistory() {
  const m = await thread();
  await m.showConversation(currentSessionId(), { keepNotices: true });
}

/**
 * Shows a stored conversation (chosen in the conversation list).
 * @param {string} id
 */
export async function openConversation(id) {
  switchSession(id);
  const m = await thread();
  await m.showConversation(id);
}

/**
 * Downloads the conversation as Markdown (the thread shown) or as JSON (schema starpi.chat/v2, the
 * stored message tree). The formats load on first use.
 * @param {'md' | 'json'} format
 */
async function exportChat(format) {
  const m = await thread();
  const [{ chatToMarkdown, exportFileName, pathToTurns, sessionToJson }, data] = await Promise.all([import('./chat-export.js'), m.exportData()]);
  const turns = pathToTurns(data.path);
  if (!turns.some((turn) => turn.role === 'assistant')) {
    appendNotice({ icon: 'info', tone: 'info', title: 'chat.export_empty' });
    return;
  }
  const sessionId = currentSessionId();
  const exportedAt = new Date().toISOString();
  const byIndex = data.path.filter((n) => n.role === 'user' || n.role === 'assistant');
  const text =
    format === 'json'
      ? sessionToJson(data.thread, sessionId, { exportedAt, version: APP_VERSION, locale: getLocale() }, turns)
      : chatToMarkdown(turns, {
          title: t('chat.export_title'),
          subtitle: t('chat.export_meta', { date: formatDate(new Date(exportedAt), { dateStyle: 'long', timeStyle: 'short' }), n: turns.length }),
          user: t('chat.export_you'),
          assistant: (turn) => {
            const node = byIndex[turns.indexOf(turn)];
            const label = node ? m.answerBadge(node) : { badge: '', badgeParams: undefined };
            return label.badge ? `Starpi · ${t(label.badge, label.badgeParams)}` : 'Starpi';
          },
        });
  downloadText(exportFileName(sessionId, exportedAt, format), text, format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8');
}

/** Deletes the current chat on this device and the messages an earlier version synced. */
async function deleteCurrentChat() {
  // An answer still being written would store its turn again after the delete.
  if (isChatBusy()) {
    window.alert(t('chat.delete_busy'));
    return;
  }
  if (!window.confirm(t('chat.delete_confirm'))) return;
  const ok = await deleteSession(currentSessionId());
  resetConversation();
  appendNotice(ok ? { icon: 'check-circle-2', tone: 'success', title: 'chat.deleted_title' } : { icon: 'triangle-alert', tone: 'warn', title: 'chat.delete_partial_title' });
}

/**
 * Closes the chat menu and hands the focus back to its button, so a keyboard user stays where they were.
 * @param {HTMLElement} item a menu entry
 */
function closeChatMenu(item) {
  const menu = item.closest('details');
  if (!menu) return;
  menu.removeAttribute('open');
  menu.querySelector('summary')?.focus();
}

/** The chat menu closes like a menu: on a click elsewhere, and on Escape (focus returns to it). */
function initChatMenu() {
  for (const menu of document.querySelectorAll('details.chat-menu, details.tools-menu')) {
    const details = /** @type {HTMLDetailsElement} */ (menu);
    document.addEventListener('click', (e) => {
      if (details.open && !(e.target instanceof Node && details.contains(e.target))) details.open = false;
    });
    details.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !details.open) return;
      details.open = false;
      details.querySelector('summary')?.focus();
    });
  }
}

export function initChat() {
  // The conversation list opens chats through the facade (chat-store.js).
  bindChatView({ open: openConversation, isBusy: isChatBusy, reset: resetConversation });
  initModeControl();
  initComposer({
    submit: () => submitChat(),
    stop: () => loaded?.stopAnswer(),
    checkSendable: async (attachments) => (await thread()).checkSendable(attachments),
  });
  initActions({
    regenerate: (id, value) => loaded?.regenerate(id, value),
    edit: (id, text) => loaded?.editQuestion(id, text),
    branch: (id, delta) => loaded?.showBranch(id, delta),
    continueAnswer: (id) => loaded?.continueAnswer(id),
    node: (id) => loaded?.threadNode(id) ?? null,
    conversationId: () => loaded?.threadConversationId() ?? currentSessionId(),
  });
  // Whether attached images can go to the chosen model changes with the model and the mode.
  onAssistantChange(() => void refreshSendable());
  onChatModeChange(() => void refreshSendable());
  onProvidersChange(() => void refreshSendable());

  onAction('new-chat', () => {
    startNewSession();
    resetConversation();
    void refreshSyncStatus();
  });

  // Quick prompts carry an i18n key, so the question is asked in the active language. They ask about
  // the sources, so they always run in source mode; questions about the sample files
  // (data-scope="workspace") search only the workspace.
  onAction('quick-prompt', (el) => {
    const key = el.dataset.arg ?? '';
    if (key) void submitChat(hasKey(key) ? t(key) : key, { workspaceOnly: el.dataset.scope === 'workspace', chatMode: 'grounded' });
  });

  onAction('export-chat', (el) => {
    closeChatMenu(el);
    return exportChat(el.dataset.arg === 'json' ? 'json' : 'md');
  });
  onAction('delete-chat', (el) => {
    closeChatMenu(el);
    return deleteCurrentChat();
  });
  initChatMenu();
}
