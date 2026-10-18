// @ts-check
/**
 * @file The chat composer: the message box (Enter sends, Shift+Enter breaks the line), Send and
 * Stop, the paperclip, pasting and dropping files and images (up to LIMITS.attachmentsPerMessage
 * per message, prepared on this device by attachments.js), the chips of the attached files, and the
 * check that the chosen model can take them (an image with a model that cannot see disables Send
 * and says why).
 *
 * Hook points for other features (registered in hooks.js, re-exported here):
 * - registerComposerSlot('mic' | 'voice', render): fills the dictation slot (#composerMicSlot; it
 *   holds the browser dictation button until a voice package registers) or the voice-mode slot
 *   (#composerVoiceSlot). render(slot) may return a cleanup function; removing the registration
 *   brings the default content back.
 * - registerComposerTool({ id, labelKey, icon, run }): an entry of the tools menu (#toolsMenu),
 *   which shows a short note while no tool is registered.
 *
 * The thread owns what happens on send: initComposer() takes its callbacks.
 */
import { LIMITS } from '../config.js';
import { byId, onAction, onChange, setHidden } from '../dom.js';
import { refreshIcons } from '../icons.js';
import { setText, t } from '../i18n/index.js';
import { escapeHtml } from '../render.js';
import { ATTACH_ACCEPT, prepareAttachment } from './attachments.js';
import { composerSlots, composerTools, onComposerSlots, onComposerTools } from './hooks.js';

export { registerComposerSlot, registerComposerTool } from './hooks.js';

/** @typedef {import('./attachments.js').PreparedAttachment} PreparedAttachment */

/**
 * An attachment of the draft.
 * @typedef {object} DraftAttachment
 * @property {string} id
 * @property {string} name
 * @property {'reading' | 'ready'} status
 * @property {Promise<PreparedAttachment | null>} ready
 * @property {PreparedAttachment} [prepared]
 */

/**
 * @typedef {object} ComposerCallbacks
 * @property {() => unknown} submit  the thread takes the draft (takeDraft)
 * @property {() => void} stop
 * @property {(attachments: readonly PreparedAttachment[]) => Promise<{ ok: true } | { ok: false, key: string, params?: Record<string, string> }>} [checkSendable]
 */

/** @type {DraftAttachment[]} */
let draft = [];
let busy = false;
/** @type {{ key: string, params?: Record<string, string> } | null} */
let blocked = null;
/** @type {ComposerCallbacks | null} */
let callbacks = null;
let checkSeq = 0;

/** @returns {HTMLTextAreaElement | null} */
function input() {
  return /** @type {HTMLTextAreaElement | null} */ (byId('chatInput'));
}

/**
 * Grows the message box with its text, up to its max-height (then it scrolls).
 * @param {HTMLTextAreaElement} el
 */
function autosize(el) {
  el.style.height = 'auto';
  if (el.value) el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
}

/** Shows the chips of the draft's attachments. */
function renderChips() {
  const box = byId('attachedInfo');
  if (!box) return;
  setHidden(box, draft.length === 0);
  box.innerHTML = draft
    .map((a) => {
      const label = a.status === 'reading' ? t('chat.attaching', { name: a.name }) : a.prepared?.width ? t('chat-thread.composer.image_size', { name: a.name, width: String(a.prepared.width), height: String(a.prepared.height) }) : a.name;
      return `<span class="attachment-chip inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 text-amber-950 px-2 py-0.5 text-xs max-w-full" data-attachment="${escapeHtml(a.id)}" data-status="${a.status}"><i data-lucide="${a.status === 'reading' ? 'loader-2' : 'paperclip'}" class="w-3.5 h-3.5 flex-shrink-0${a.status === 'reading' ? ' animate-spin' : ''}"></i><span class="truncate">${escapeHtml(label)}</span><button type="button" class="btn btn-ghost p-0.5" data-action="remove-attachment" data-arg="${escapeHtml(a.id)}" data-i18n-aria="chat.remove_attachment" aria-label="${escapeHtml(t('chat.remove_attachment'))}"><i data-lucide="x" class="w-3 h-3"></i></button></span>`;
    })
    .join('');
  refreshIcons(box);
}

/** Enables Send unless an answer is being written or the draft cannot go to the chosen model. */
function renderSend() {
  const send = /** @type {HTMLButtonElement | null} */ (byId('sendBtn'));
  if (send) send.disabled = busy || blocked !== null;
  const note = byId('composerNotice');
  if (!note) return;
  if (blocked) setText(note, blocked.key, blocked.params);
  setHidden(note, !blocked);
}

/**
 * Asks the thread whether the ready attachments can go to the chosen model; the newest check wins.
 */
export async function refreshSendable() {
  const seq = ++checkSeq;
  const ready = draft.flatMap((a) => (a.prepared ? [a.prepared] : []));
  const verdict = ready.length && callbacks?.checkSendable ? await callbacks.checkSendable(ready).catch(() => ({ ok: /** @type {const} */ (true) })) : { ok: /** @type {const} */ (true) };
  if (seq !== checkSeq) return;
  blocked = verdict.ok ? null : { key: verdict.key, params: verdict.params };
  renderSend();
}

/**
 * A notice about an attachment that could not be used, in the composer's note line.
 * @param {string} key
 * @param {Record<string, string>} params
 */
function attachNotice(key, params) {
  const note = byId('composerNotice');
  if (!note) return;
  setText(note, key, params);
  setHidden(note, false);
  setTimeout(() => {
    if (!blocked) setHidden(note, true);
  }, 6000);
}

/**
 * Adds files to the draft (the paperclip, a paste or a drop). Files beyond the per-message limit
 * are left out with a note.
 * @param {Iterable<File>} files
 */
export function addFiles(files) {
  const list = [...files];
  const room = LIMITS.attachmentsPerMessage - draft.length;
  if (list.length > room) attachNotice('chat-thread.composer.too_many', { n: String(LIMITS.attachmentsPerMessage) });
  for (const file of list.slice(0, Math.max(0, room))) {
    const id = crypto.randomUUID();
    /** @type {DraftAttachment} */
    const entry = {
      id,
      name: file.name || t('chat-thread.composer.pasted_image'),
      status: 'reading',
      ready: prepareAttachment(file).then(
        (prepared) => {
          entry.prepared = prepared;
          entry.status = 'ready';
          renderChips();
          void refreshSendable();
          return prepared;
        },
        (err) => {
          draft = draft.filter((a) => a.id !== id);
          renderChips();
          const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unreadable';
          attachNotice(`chat-thread.composer.error_${['unsupported_type', 'too_large'].includes(code) ? code : 'unreadable'}`, { name: file.name });
          void refreshSendable();
          return null;
        },
      ),
    };
    draft.push(entry);
  }
  renderChips();
}

/** Whether files are still being read. */
export function isAttaching() {
  return draft.some((a) => a.status === 'reading');
}

/**
 * The draft: the typed text and the attachments once every one is read.
 * @returns {Promise<{ text: string, attachments: PreparedAttachment[] }>}
 */
export async function takeDraft() {
  const el = input();
  const text = (el?.value ?? '').trim().slice(0, LIMITS.chatInputChars);
  const prepared = (await Promise.all(draft.map((a) => a.ready))).filter((a) => a !== null);
  return { text, attachments: /** @type {PreparedAttachment[]} */ (prepared) };
}

/** Empties the message box and the attachments (after sending). */
export function clearComposer() {
  const el = input();
  if (el) {
    el.value = '';
    autosize(el);
  }
  draft = [];
  blocked = null;
  const file = /** @type {HTMLInputElement | null} */ (byId('chatFileInput'));
  if (file) file.value = '';
  renderChips();
  renderSend();
}

/**
 * Switches between Send and Stop while an answer is being written.
 * @param {boolean} on
 */
export function setComposerBusy(on) {
  busy = on;
  // Hiding the focused Stop button drops focus later, not at once: note it before hiding.
  const stopHadFocus = document.activeElement === byId('stopBtn');
  setHidden(byId('stopBtn'), !on);
  const send = byId('sendBtn');
  const el = input();
  // Disabling the focused Send button would drop keyboard focus to <body>; keep it in the input.
  if (on && send && document.activeElement === send) el?.focus();
  renderSend();
  if (!on && (stopHadFocus || document.activeElement === document.body)) el?.focus();
}

/** @type {Map<string, Node[]>} */
const slotDefaults = new Map();
/** @type {Map<string, () => void>} */
const slotCleanups = new Map();

/** Renders the registered slots (or their default content). */
function renderSlots() {
  for (const [name, id] of /** @type {const} */ ([
    ['mic', 'composerMicSlot'],
    ['voice', 'composerVoiceSlot'],
  ])) {
    const slot = byId(id);
    if (!slot) continue;
    if (!slotDefaults.has(name)) slotDefaults.set(name, [...slot.childNodes]);
    slotCleanups.get(name)?.();
    slotCleanups.delete(name);
    const render = composerSlots.get(name);
    if (!render) {
      slot.replaceChildren(...(slotDefaults.get(name) ?? []));
      continue;
    }
    slot.replaceChildren();
    const cleanup = render(slot);
    if (typeof cleanup === 'function') slotCleanups.set(name, cleanup);
  }
}

/** Renders the tools menu. */
function renderTools() {
  const list = byId('toolsMenuList');
  if (!list) return;
  if (composerTools.size === 0) {
    list.innerHTML = `<p class="px-2 py-1.5 text-xs text-slate-500" data-i18n="chat-thread.tools.empty">${escapeHtml(t('chat-thread.tools.empty'))}</p>`;
    return;
  }
  list.innerHTML = [...composerTools.values()]
    .map((tool) => `<button type="button" class="chat-menu-item" data-action="run-composer-tool" data-arg="${escapeHtml(tool.id)}"><i data-lucide="${escapeHtml(tool.icon)}" class="w-3.5 h-3.5"></i><span data-i18n="${escapeHtml(tool.labelKey)}">${escapeHtml(t(tool.labelKey))}</span></button>`)
    .join('');
  refreshIcons(list);
}

/** @param {DataTransfer | null} data */
function filesOf(data) {
  return data ? [...data.files].filter((f) => f.size > 0 || f.type) : [];
}

/**
 * @param {ComposerCallbacks} cb
 */
export function initComposer(cb) {
  callbacks = cb;
  const form = byId('chatForm');
  const el = input();
  const file = /** @type {HTMLInputElement | null} */ (byId('chatFileInput'));
  if (file) {
    file.accept = ATTACH_ACCEPT;
    file.multiple = true;
  }
  const submit = () => {
    if (busy || blocked) return;
    void cb.submit();
  };
  // Voice input and quick edits fire 'input' too.
  el?.addEventListener('input', () => autosize(el));
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  el?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  // Pasted images and files join the draft; pasted text stays text.
  el?.addEventListener('paste', (e) => {
    const files = filesOf(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });
  // Files dropped onto the composer or the conversation.
  for (const zone of [form, byId('chatMessages')]) {
    zone?.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
      e.preventDefault();
      form?.classList.add('drop-target');
    });
    zone?.addEventListener('dragleave', () => form?.classList.remove('drop-target'));
    zone?.addEventListener('drop', (e) => {
      const files = filesOf(e.dataTransfer);
      form?.classList.remove('drop-target');
      if (!files.length) return;
      e.preventDefault();
      addFiles(files);
    });
  }
  onAction('stop-generation', () => cb.stop());
  onAction('pick-chat-file', () => file?.click());
  onAction('remove-attachment', (btn) => {
    draft = draft.filter((a) => a.id !== btn.dataset.arg);
    renderChips();
    void refreshSendable();
    el?.focus();
  });
  onChange('attach-file', (target) => {
    const picker = /** @type {HTMLInputElement} */ (target);
    const files = [...(picker.files ?? [])];
    picker.value = '';
    if (files.length) addFiles(files);
  });
  onAction('run-composer-tool', (btn) => {
    const menu = btn.closest('details');
    if (menu) menu.open = false;
    return composerTools.get(btn.dataset.arg ?? '')?.run();
  });
  onComposerSlots(renderSlots);
  onComposerTools(renderTools);
  renderSlots();
  renderTools();
  renderChips();
  renderSend();
}
