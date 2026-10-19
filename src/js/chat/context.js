// @ts-check
// What the user set up for a conversation, brought into the chat (features/memory.js loads this
// module after the first paint and connects it to the chat's hooks):
//
// - the system note of a free question: the assistant's instructions, the project's instructions
//   and the custom instructions (ai/memory.js systemNoteFor);
// - the request note: the saved notes that go along with the question being answered, from the
//   scopes its project allows (only while memory is on; never stored with the question);
// - the workspace scope of a grounded question: the project's files;
// - chats started in a project or with an assistant: the session starts at once, the conversation
//   is stored with its first message and gets its project and assistant then (until that moment
//   they are kept with the draft, in this browser's storage, so a reload before the first question
//   keeps them); the project's or assistant's model is picked, an assistant's tools are switched
//   and its conversation starters are shown;
// - the memory_lookup tool (hooks.js setMemoryLookup): the saved notes that match its query, only
//   while memory is on and from the scopes the conversation may use;
// - "Remember this" on a message, and the notes a model suggests after a free answer (only while
//   memory and suggestions are on; shown below the answer, kept only when the user accepts one);
// - the chip in the chat toolbar that names the project and assistant of the chat on screen.
import { chatData, currentSessionId, onSessionChange, startNewSession } from '../chat-store.js';
import { downloadText } from '../dom.js';
import { readLocalJson, writeLocalJson } from '../storage.js';
import { getLocale, onLocaleChange, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { modelLabel, providerLabel } from '../providers.js';
import { getAssistant, setAssistant, setWebSearch } from '../state.js';
import { html, icon, label } from '../ui/kit.js';
import { cleanFactText, defaultScopeFor, MEMORY_LIMITS, MemoryError, memoryStore, rankFacts, scopesFor, suggestFacts, suggestionNotes, systemNoteFor } from '../ai/memory.js';
import { setThinking } from '../ai/thinking.js';
import { APP_VERSION } from '../config.js';
import { assistantFileName, AssistantError, assistantStore, exportAssistant, mountAssistantsSection, openAssistantEditor } from './assistants.js';
import { openFormDialog, showFormError } from './form-dialog.js';
import { mountProjectsSection, openProjectEditor, projectStore } from './projects.js';
import { nodeText } from './tree.js';

/** @typedef {import('./hooks.js').TurnContext} TurnContext */
/** @typedef {import('./hooks.js').SidebarSectionContext} SidebarSectionContext */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../store/schema.js').ProjectRecord} ProjectRecord */
/** @typedef {import('../store/schema.js').AssistantRecord} AssistantRecord */
/** @typedef {import('./store.js').ChatStore} ChatStore */

/** A suggestion is only offered for an answer this recent (a change event of an older one is a replay). */
const SUGGEST_WINDOW_MS = 120_000;

/** Where the drafts of chats started in a project or with an assistant are kept across a reload. */
export const DRAFTS_KEY = 'starpi_chat_drafts_v1';
/** Drafts kept at most (the newest). */
const DRAFTS_KEPT = 20;
const SESSION_ID = /^starpi_[\w-]{6,120}$/;
const RECORD_ID = /^[\w:.-]{1,200}$/;

/**
 * The stored drafts, as far as they read back.
 * @returns {Map<string, { projectId?: string, assistantId?: string }>}
 */
function readDrafts() {
  /** @type {Map<string, { projectId?: string, assistantId?: string }>} */
  const out = new Map();
  const raw = /** @type {unknown} */ (readLocalJson(DRAFTS_KEY, null));
  if (!Array.isArray(raw)) return out;
  for (const entry of raw.slice(-DRAFTS_KEPT)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !SESSION_ID.test(entry[0])) continue;
    const v = entry[1] && typeof entry[1] === 'object' ? entry[1] : {};
    /** @type {{ projectId?: string, assistantId?: string }} */
    const draft = {};
    if (typeof v.projectId === 'string' && RECORD_ID.test(v.projectId)) draft.projectId = v.projectId;
    if (typeof v.assistantId === 'string' && RECORD_ID.test(v.assistantId)) draft.assistantId = v.assistantId;
    if (draft.projectId || draft.assistantId) out.set(entry[0], draft);
  }
  return out;
}

/**
 * Chats started in a project or with an assistant whose conversation is not stored yet (kept in
 * this browser's storage too, so a reload before the first question keeps them).
 * @type {Map<string, { projectId?: string, assistantId?: string }>}
 */
const pending = readDrafts();

function saveDrafts() {
  writeLocalJson(DRAFTS_KEY, [...pending].slice(-DRAFTS_KEPT));
}
/** Answers a suggestion was already asked for. */
const suggested = new Set();
/** @type {{ enabled: boolean, suggest: boolean }} */
let prefs = { enabled: false, suggest: false };
/** @type {Set<(value: { enabled: boolean, suggest: boolean }) => void>} */
const prefListeners = new Set();
/** @type {Promise<void> | null} */
let started = null;

// ---------------------------------------------------------------------------------------------
// A conversation's context

/**
 * The project and assistant of a conversation (also of one started but not stored yet).
 * @param {string} conversationId
 * @returns {Promise<{ project: ProjectRecord | null, assistant: AssistantRecord | null }>}
 */
export async function contextOf(conversationId) {
  const conversation = await (await chatData()).getConversation(conversationId).catch(() => undefined);
  const early = pending.get(conversationId);
  const projectId = conversation?.projectId ?? early?.projectId;
  const assistantId = conversation?.assistantId ?? early?.assistantId;
  const [project, assistant] = await Promise.all([projectId ? projectStore().get(projectId).catch(() => null) : null, assistantId ? assistantStore().get(assistantId).catch(() => null) : null]);
  return { project, assistant };
}

/**
 * The saved notes that go along with a free question (registerRequestNotes: in the request that
 * answers it only, never stored with it, so a later turn does not send them again and a note
 * deleted, switched off or locked away is not sent from an earlier turn).
 * @param {TurnContext} ctx
 * @returns {Promise<string[]>}
 */
export async function requestNotes(ctx) {
  if (!ctx.question.trim()) return [];
  const { project } = await contextOf(ctx.conversationId);
  const { note } = await memoryStore().recall(ctx.question, scopesFor(project), ctx.locale);
  return note ? [note] : [];
}

/**
 * The system note of a free question (registerSystemNote).
 * @param {TurnContext} ctx
 */
export async function systemNote(ctx) {
  const [{ project, assistant }, instructions] = await Promise.all([contextOf(ctx.conversationId), memoryStore().instructions()]);
  return systemNoteFor({ assistant, project, instructions }, ctx.locale);
}

/**
 * The workspace documents a conversation's grounded questions search (setWorkspaceScope).
 * @param {string} conversationId
 * @returns {Promise<string[] | null>}
 */
export async function workspaceScope(conversationId) {
  const { project } = await contextOf(conversationId);
  return project?.docIds.length ? project.docIds : null;
}

/**
 * The saved notes that match a query, for the memory_lookup tool: nothing while memory is off, only
 * notes that share a word with the query, from the scopes the conversation may use (a project with
 * memory off: none). They count as used, as notes that went along with a question do.
 * @param {string} query
 * @param {number} limit
 * @param {string | null} conversationId
 * @returns {Promise<Array<{ text: string, updatedAt: string }>>}
 */
export async function lookupNotes(query, limit, conversationId) {
  if (!String(query ?? '').trim()) return [];
  const store = memoryStore();
  if (!(await store.prefs()).enabled) return [];
  const { project } = conversationId ? await contextOf(conversationId) : { project: null };
  const scopes = scopesFor(project);
  if (!scopes.length) return [];
  const { facts } = await store.list();
  const matched = rankFacts(
    facts.filter((f) => scopes.includes(f.scope)),
    query,
    { now: Date.now() },
  )
    .filter((r) => r.parts.relevance > 0)
    .slice(0, Math.max(1, Math.min(limit, MEMORY_LIMITS.injectedFacts)));
  if (matched.length) await store.markUsed(matched.map((r) => r.fact.id));
  return matched.map((r) => ({ text: r.fact.text, updatedAt: new Date(r.fact.usedAt ?? r.fact.createdAt).toISOString() }));
}

/** Whether memory is on (read when the action bars render "Remember this"). */
export function memoryEnabled() {
  return prefs.enabled;
}

/** @param {(value: { enabled: boolean, suggest: boolean }) => void} fn */
export function onMemoryPrefs(fn) {
  prefListeners.add(fn);
  return () => prefListeners.delete(fn);
}

async function readPrefs() {
  try {
    prefs = await memoryStore().prefs();
  } catch {
    prefs = { enabled: false, suggest: false };
  }
  for (const fn of prefListeners) fn(prefs);
}

/**
 * The name of a model picker value for the editors.
 * @param {string} value
 */
export function modelName(value) {
  if (value === 'auto') return t('chat-thread.picker.auto');
  if (value === 'device') return t('engine.mode_local');
  if (value === 'local:*') return t('engine.mode_server');
  const at = value.indexOf(':');
  const provider = /** @type {import('../ai/contract.js').ProviderId} */ (value.slice(0, at));
  return `${providerLabel(provider)} · ${modelLabel(provider, value.slice(at + 1))}`;
}

// ---------------------------------------------------------------------------------------------
// Starting chats

/**
 * Starts a new chat in a project or with an assistant: a fresh session on screen, the model of the
 * project or assistant picked, an assistant's tools switched and its starters shown.
 * @param {{ projectId?: string, assistantId?: string }} where
 * @param {{ switchTab?: (tab: string) => void }} [ui]
 */
export async function startChat(where, ui = {}) {
  const [project, assistant] = await Promise.all([where.projectId ? projectStore().get(where.projectId) : null, where.assistantId ? assistantStore().get(where.assistantId) : null]);
  const id = startNewSession();
  if (project || assistant) {
    pending.set(id, { ...(project ? { projectId: project.id } : {}), ...(assistant ? { assistantId: assistant.id } : {}) });
    saveDrafts();
  }
  const thread = await import('./thread.js');
  thread.resetThread();
  const model = assistant?.model ?? project?.defaultModel ?? null;
  if (model) setAssistant(model);
  if (assistant) {
    setWebSearch(assistant.tools.includes('web'));
    setThinking(assistant.tools.includes('thinking'));
    // The chat's own tools it names are switched on (the others keep their setting).
    if (assistant.tools.some((x) => x !== 'web' && x !== 'thinking')) await import('./tools.js').then((m) => m.switchOnTools(assistant.tools)).catch((err) => console.warn('[starpi] the assistant could not switch its tools on', err));
    showStarters(assistant);
  }
  ui.switchTab?.('chat');
  document.getElementById('chatInput')?.focus();
  void refreshChip();
}

/**
 * The conversation starters of an assistant, below the welcome message of a new chat.
 * @param {AssistantRecord} assistant
 */
function showStarters(assistant) {
  const box = document.getElementById('chatMessages');
  if (!box) return;
  box.querySelector('[data-assistant-intro]')?.remove();
  const el = document.createElement('div');
  el.dataset.assistantIntro = assistant.id;
  el.className = 'w-full max-w-4xl mx-auto';
  el.innerHTML = html`<div class="card p-4 text-sm space-y-3">
    <p class="flex items-center gap-2 font-semibold text-slate-900">${icon(assistant.icon, 'w-4 h-4 text-amber-600')}<span>${assistant.name}</span></p>
    ${assistant.starters.length ? html`<div class="flex flex-wrap gap-2">${assistant.starters.map((s, i) => html`<button type="button" class="btn btn-secondary text-left" data-starter="${i}">${s}</button>`)}</div>` : label('memory.assistants.intro_no_starters', { tag: 'p', className: 'text-slate-600' })}
  </div>`.value;
  el.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-starter]') : null;
    const text = button instanceof HTMLElement ? assistant.starters[Number(button.dataset.starter)] : undefined;
    if (!text) return;
    el.remove();
    void import('../chat.js').then((m) => m.submitChat(text));
  });
  box.append(el);
  refreshIcons(el);
}

/**
 * Gives a conversation started in a project or with an assistant its context once it is stored.
 * @param {ChatStore} chats
 */
function watchPending(chats) {
  /** @param {string} id */
  const settle = (id) => {
    const early = pending.get(id);
    if (!early) return;
    pending.delete(id);
    saveDrafts();
    const patch = { ...(early.projectId ? { projectId: early.projectId } : {}), ...(early.assistantId ? { assistantId: early.assistantId } : {}) };
    // Asked for right away, so it is stored before the first answer goes out.
    void chats.updateConversation(id, patch).catch((err) => {
      pending.set(id, early);
      saveDrafts();
      console.warn('[starpi] the chat could not keep its project or assistant', err);
    });
  };
  chats.onChange((change) => {
    if (change.kind !== 'conversation' || change.op !== 'put' || change.remote) return;
    settle(change.id);
  });
  // Drafts kept from before a reload: one whose conversation was stored meanwhile gets its context
  // now; one left without a question (another chat is on screen) is dropped.
  for (const id of [...pending.keys()]) {
    void chats
      .getConversation(id)
      .then((conversation) => {
        if (conversation) settle(id);
        else if (id !== currentSessionId() && pending.delete(id)) saveDrafts();
      })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Saving notes

/**
 * The scope choices for a note saved in a conversation: the global notes, and the project's own.
 * @param {ProjectRecord | null} project
 */
function scopeOptions(project) {
  const chosen = defaultScopeFor(project);
  return html`<option value="global"${chosen === 'global' ? ' selected' : ''}>${t('memory.scope_global')}</option>${project ? html`<option value="${project.id}"${chosen === project.id ? ' selected' : ''}>${t('memory.scope_project', { name: project.name })}</option>` : ''}`;
}

/**
 * "Remember this" on a message: a dialog with the note (the message's text, editable) and where it
 * is kept. Nothing is stored before the user saves.
 * @param {NodeRecord} node
 * @param {{ conversationId: string }} ctx
 * @param {typeof import('../ui/kit.js').toast} toast
 */
export async function rememberMessage(node, ctx, toast) {
  const { project } = await contextOf(ctx.conversationId);
  const text = cleanFactText(nodeText(node));
  openFormDialog({
    id: 'rememberDialog',
    title: 'memory.remember.title',
    icon: 'bookmark-plus',
    body: html`<div><label class="field-label" for="rmText">${label('memory.remember.text')}</label><textarea id="rmText" name="text" rows="3" class="field" maxlength="${MEMORY_LIMITS.factChars}" required>${text}</textarea>${label({ key: 'memory.remember.hint', params: { n: MEMORY_LIMITS.factChars } }, { tag: 'p', className: 'text-[11px] text-slate-500 mt-1' })}</div>
      <div><label class="field-label" for="rmScope">${label('memory.remember.scope')}</label><select id="rmScope" name="scope" class="field">${scopeOptions(project)}</select></div>`,
    submit: 'memory.remember.save',
    initialFocus: '#rmText',
    async onSubmit(form) {
      const data = new FormData(form);
      try {
        await memoryStore().add({ text: String(data.get('text') ?? ''), scope: String(data.get('scope') ?? 'global'), source: 'explicit' });
        toast('memory.remember.saved', { tone: 'ok' });
        return true;
      } catch (err) {
        showFormError(form, `memory.error_${err instanceof MemoryError ? err.code : 'store'}`);
        return false;
      }
    },
  });
}

/**
 * Asks for notes after a free answer, when memory and suggestions are on, and shows them below the
 * answer while its chat is on screen.
 * @param {ChatStore} chats
 * @param {typeof import('../ui/kit.js').toast} toast
 */
function watchAnswers(chats, toast) {
  chats.onChange((change) => {
    if (change.kind !== 'node' || change.remote || !prefs.enabled || !prefs.suggest || suggested.has(change.id)) return;
    suggested.add(change.id);
    void suggestFor(chats, change.id, change.conversationId, toast).catch((err) => console.warn('[starpi] no notes could be suggested', err));
  });
}

/**
 * @param {ChatStore} chats
 * @param {string} nodeId
 * @param {string} conversationId
 * @param {typeof import('../ui/kit.js').toast} toast
 */
async function suggestFor(chats, nodeId, conversationId, toast) {
  const answer = await chats.getNode(nodeId);
  if (!answer || answer.role !== 'assistant' || answer.label !== 'free' || Date.now() - answer.createdAt > SUGGEST_WINDOW_MS || !answer.parentId) return;
  const question = await chats.getNode(answer.parentId);
  if (!question || question.role !== 'user' || /** @type {Record<string, unknown>} */ (question.meta ?? {}).continue) return;
  const { project } = await contextOf(conversationId);
  const scopes = scopesFor(project);
  const store = memoryStore();
  // No suggestions in a project with its notes off, nor while the vault is locked (none could be kept).
  if (!scopes.length || !store.canStore()) return;
  const [{ facts }, { titleProviders }, { runPurpose }] = await Promise.all([store.list(), import('./thread.js'), import('../ai/router.js')]);
  const turn = { question: nodeText(question), answer: nodeText(answer), now: Date.now() };
  // The model that answered sees, besides the turn, only notes this chat may use, and of those only
  // as many as go along with a question, so it does not suggest them again. Every other note is
  // compared here and does not leave the device for this call.
  const ideas = await suggestFacts(
    { question: turn.question, answer: turn.answer, ...suggestionNotes(facts, scopes, turn) },
    { run: (purpose, input, opts) => runPurpose(purpose, input, /** @type {import('../ai/router.js').RunOptions} */ (opts)), providers: titleProviders(answer), locale: getLocale(), signal: AbortSignal.timeout(20_000) },
  );
  if (!ideas.length || currentSessionId() !== conversationId) return;
  showSuggestions(nodeId, ideas, defaultScopeFor(project), toast);
}

/**
 * The suggested notes below an answer: each can be remembered or dismissed.
 * @param {string} nodeId
 * @param {Array<{ text: string }>} ideas
 * @param {string} scope
 * @param {typeof import('../ui/kit.js').toast} toast
 */
function showSuggestions(nodeId, ideas, scope, toast) {
  const row = [...document.querySelectorAll('#chatMessages [data-node-id]')].find((el) => el instanceof HTMLElement && el.dataset.nodeId === nodeId);
  if (!row) return;
  const el = document.createElement('div');
  el.dataset.memorySuggest = nodeId;
  el.className = 'w-full max-w-4xl mx-auto';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', t('memory.suggest.title'));
  const items = ideas.map((idea, i) => html`<li class="flex flex-wrap items-center gap-2" data-idea="${i}"><span class="flex-1 min-w-[10rem] text-slate-800">${idea.text}</span><span class="flex items-center gap-1"><button type="button" class="btn btn-secondary py-1" data-ms="keep">${icon('bookmark-plus', 'w-3.5 h-3.5')}${label('memory.suggest.keep')}</button><button type="button" class="btn btn-ghost py-1" data-ms="dismiss">${label('memory.suggest.dismiss')}</button></span></li>`);
  el.innerHTML = html`<div class="card p-3 text-sm space-y-2 border-amber-200"><p class="flex items-center gap-1.5 text-xs font-semibold text-slate-700">${icon('brain', 'w-3.5 h-3.5 text-amber-600')}${label('memory.suggest.title')}</p><ul class="space-y-1.5">${items}</ul>${label('memory.suggest.hint', { tag: 'p', className: 'text-[11px] text-slate-500' })}</div>`.value;
  el.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-ms]') : null;
    const item = button?.closest('[data-idea]');
    if (!(button instanceof HTMLElement) || !(item instanceof HTMLElement)) return;
    const idea = ideas[Number(item.dataset.idea)];
    if (button.dataset.ms === 'keep' && idea) {
      try {
        await memoryStore().add({ text: idea.text, scope, source: 'suggested' });
        toast('memory.remember.saved', { tone: 'ok' });
      } catch (err) {
        toast(`memory.error_${err instanceof MemoryError ? err.code : 'store'}`, { tone: 'warn' });
        return;
      }
    }
    item.remove();
    if (!el.querySelector('[data-idea]')) el.remove();
  });
  row.after(el);
  refreshIcons(el);
}

// ---------------------------------------------------------------------------------------------
// The toolbar chip

/** @type {HTMLElement | null} */
let chipHost = null;
/** @type {HTMLElement | null} */
let chipMount = null;

async function refreshChip() {
  const host = chipHost;
  if (!host || !chipMount) return;
  const id = currentSessionId();
  const { project, assistant } = await contextOf(id).catch(() => ({ project: null, assistant: null }));
  if (host !== chipHost || id !== currentSessionId()) return;
  const chips = [
    project ? html`<span class="chip chip-neutral max-w-[10rem]" title="${t('memory.chip.project', { name: project.name })}" data-context-chip="project">${icon('folder', '')}<span class="truncate">${project.name}</span></span>` : '',
    assistant ? html`<span class="chip chip-neutral max-w-[10rem]" title="${t('memory.chip.assistant', { name: assistant.name })}" data-context-chip="assistant">${icon(assistant.icon, '')}<span class="truncate">${assistant.name}</span></span>` : '',
  ];
  // Without a project or assistant the mount point stays empty (and hidden).
  if (!project && !assistant) {
    host.remove();
    return;
  }
  host.innerHTML = html`${chips}`.value;
  refreshIcons(host);
  if (!host.isConnected) chipMount.prepend(host);
}

/**
 * Shows the project and assistant of the chat on screen in the chat toolbar.
 * @param {HTMLElement} el
 */
export function mountContextChip(el) {
  chipMount = el;
  chipHost = document.createElement('span');
  chipHost.className = 'hidden sm:flex items-center gap-1';
  const refresh = () => void refreshChip();
  onSessionChange(refresh);
  onLocaleChange(refresh);
  projectStore().onChange(refresh);
  assistantStore().onChange(refresh);
  void chatData()
    .then((chats) =>
      chats.onChange((change) => {
        if (change.kind === 'all' || (change.kind === 'conversation' && change.id === currentSessionId())) refresh();
      }),
    )
    .catch(() => {});
  refresh();
}

// ---------------------------------------------------------------------------------------------
// Sidebar sections

/**
 * The projects section of the sidebar.
 * @param {HTMLElement} host
 * @param {SidebarSectionContext} ctx
 */
export function projectsSection(host, ctx) {
  const open = async (/** @type {string} */ id) => {
    const { getChatView } = await import('../chat-store.js');
    await getChatView()?.open(id);
    ctx.switchTab('chat');
  };
  return mountProjectsSection(host, {
    projects: projectStore(),
    chats: chatData,
    currentId: currentSessionId,
    onSessionChange,
    open,
    newChat: (projectId) => startChat({ projectId }, ctx),
    edit: (project) => openProjectEditor(project, editorDeps(ctx)),
  });
}

/**
 * The assistants section of the sidebar.
 * @param {HTMLElement} host
 * @param {SidebarSectionContext} ctx
 */
export function assistantsSection(host, ctx) {
  return mountAssistantsSection(host, {
    assistants: assistantStore(),
    start: (assistant) => startChat({ assistantId: assistant.id }, ctx),
    edit: (assistant) =>
      openAssistantEditor(assistant, {
        assistants: assistantStore(),
        currentModel: getAssistant,
        modelName,
        exportFile: (a) => {
          const doc = exportAssistant(a, { exportedAt: new Date().toISOString(), version: APP_VERSION });
          downloadText(assistantFileName(a.name), `${JSON.stringify(doc, null, 2)}\n`, 'application/json');
        },
        toast: ctx.toast,
      }),
    importFile: async (file) => {
      try {
        const { assistant, dropped } = await assistantStore().importText(await file.text());
        ctx.toast({ key: dropped.length ? 'memory.assistants.imported_dropped' : 'memory.assistants.imported', params: { name: assistant.name, tools: dropped.join(', ') } }, { tone: dropped.length ? 'warn' : 'ok' });
      } catch (err) {
        ctx.toast(`memory.assistants.error_${err instanceof AssistantError ? err.code : 'store'}`, { tone: 'warn' });
      }
    },
  });
}

/** @param {SidebarSectionContext} ctx @returns {import('./projects.js').ProjectEditorDeps} */
function editorDeps(ctx) {
  return {
    projects: projectStore(),
    chats: chatData,
    documents: async () => {
      const ws = await import('../rag/workspace.js');
      await ws.restoreWorkspace().catch(() => {});
      return ws.listWorkspace().map((d) => ({ docId: d.docId, name: d.name }));
    },
    currentModel: getAssistant,
    modelName,
    removeNotes: (scope) => memoryStore().removeScope(scope),
    toast: ctx.toast,
  };
}

// ---------------------------------------------------------------------------------------------
// Start

/**
 * Loads the memory switches and connects the chat store, the vault and the change listeners. Runs
 * once; later calls share it.
 * @param {{ toast: typeof import('../ui/kit.js').toast }} services
 */
export function startContext(services) {
  started ??= (async () => {
    const store = memoryStore();
    store.onChange(() => void readPrefs());
    await readPrefs();
    try {
      const { onKeysChange } = await import('../ai/keys.js');
      onKeysChange((change) => {
        if (change.type === 'vault') void store.reconcile().catch(() => {});
      });
      await store.reconcile();
    } catch (err) {
      console.warn('[starpi] the saved notes could not be matched to the vault', err);
    }
    const chats = await chatData();
    watchPending(chats);
    watchAnswers(chats, services.toast);
  })();
  return started;
}
