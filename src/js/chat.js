// @ts-check
// The chat tab: wires the composer (chat/composer.js), the mode row (chat/mode-control.js) and the
// action bars (chat/actions.js) to the thread (chat/thread.js), and keeps the names other modules
// import from 2.x (submitChat, isChatBusy, resetConversation, restoreHistory).
//
// The thread, the AI layer and the conversation store load after the first paint: the composer
// and the mode row are here from the start, the first question (or the restored chat) loads the
// rest. Free chat sends the conversation to the chosen model without retrieval or source check;
// grounded answers come from the sources, checked sentence by sentence, with a receipt.
//
// Features reach the chat through their own seams, without the chat loading them: voice through
// registerVoiceUi (dictation into the composer, the speaker button and reading aloud of answers, Live
// turns through the chat's model and retrieval), research through startResearch ("Research this"
// on an answer, a message action).
import { bindChatView, chatSyncActive, currentSessionId, deleteSession, refreshSyncStatus, startNewSession, switchSession } from './chat-store.js';
import { APP_VERSION } from './config.js';
import { downloadText, onAction } from './dom.js';
import { formatDate, getLocale, hasKey, t } from './i18n/index.js';
import { appendNotice } from './messages.js';
import { initActions } from './chat/actions.js';
import { initComposer, refreshSendable } from './chat/composer.js';
import { registerMessageAction } from './chat/hooks.js';
import { initModeControl } from './chat/mode-control.js';
import { startResearch } from './features/research.js';
import { registerVoiceUi } from './features/voice.js';
import { onProvidersChange } from './providers.js';
import { onAssistantChange, onChatModeChange } from './state.js';
import { openChatAside, setAssistantStatus } from './ui.js';
import { toast } from './ui/kit.js';

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

/**
 * Clears the conversation on screen (new chat, deleted history). An answer still being written is
 * stored in its own conversation.
 */
export function resetConversation() {
  if (loaded) loaded.resetThread();
  else void thread().then((m) => m.resetThread());
  if (!isChatBusy()) setAssistantStatus('status.ready');
}

/**
 * Sends a question: the composer's draft, or the given text.
 * @param {string} [rawText]  a question from elsewhere (quick prompts, the graph); omitted: the draft
 * @param {{ workspaceOnly?: boolean, chatMode?: 'grounded' | 'free', localOnly?: boolean, docIds?: readonly string[] }} [options]
 *   localOnly: the question stays on this device; docIds: a grounded question searches only these
 *   workspace documents (thread.js sendQuestion)
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

/**
 * "Research this" on an answer: a research job about the question the answer belongs to, linked to
 * this turn; the research list of the side panel shows its progress.
 * @param {import('./store/schema.js').NodeRecord} node
 * @param {{ conversationId: string }} ctx
 */
async function researchAnswer(node, ctx) {
  const question = node.parentId ? (loaded?.threadNode(node.parentId) ?? null) : null;
  const text = question && !(/** @type {Record<string, unknown>} */ (question.meta ?? {})).continue ? question.parts.filter((p) => p.type === 'text').map((p) => String(p.text ?? '')).join('\n\n').trim() : '';
  if (!text) {
    toast('chat-thread.action.research_no_question', { tone: 'warn' });
    return;
  }
  try {
    await startResearch({ question: text, origin: 'chat', scope: { conversationId: ctx.conversationId, nodeId: node.id } });
    toast('research.started', { tone: 'ok' });
    openChatAside('research');
  } catch (err) {
    console.warn('[starpi] research could not start', err);
    toast('chat-thread.action.research_failed', { tone: 'warn' });
  }
}

/** Connects the voice features (voice/hooks.js) to the composer, the answers and the chat's models. */
function connectVoice() {
  registerVoiceUi({
    composerInput: () => {
      const el = document.getElementById('chatInput');
      return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el : null;
    },
    getAnswer: (id) => loaded?.readableAnswer(id) ?? null,
    ask: async function* (turn) {
      yield* (await thread()).liveAnswer(turn);
    },
    retrieve: async (query) => (await thread()).liveSources(query),
  });
}

/** Deletes the current chat on this device and the messages an earlier version synced. */
async function deleteCurrentChat() {
  // An answer still being written would store its turn again after the delete.
  if (isChatBusy()) {
    window.alert(t('chat.delete_busy'));
    return;
  }
  // With sync on, the deletion also reaches the synced copy and the other browsers.
  const synced = chatSyncActive();
  if (!window.confirm(t(synced ? 'chat.list.delete_current_confirm_synced' : 'chat.delete_confirm'))) return;
  const ok = await deleteSession(currentSessionId());
  resetConversation();
  appendNotice(ok ? { icon: 'check-circle-2', tone: 'success', title: 'chat.deleted_title' } : { icon: 'triangle-alert', tone: 'warn', title: synced ? 'chat.list.delete_partial_synced' : 'chat.delete_partial_title' });
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
  bindChatView({ open: openConversation, isBusy: isChatBusy, reset: resetConversation, answering: () => loaded?.answeringConversation() ?? null });
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
  connectVoice();
  registerMessageAction({ id: 'research', labelKey: 'research.this', icon: 'telescope', run: (node, ctx) => researchAnswer(node, ctx) });
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
