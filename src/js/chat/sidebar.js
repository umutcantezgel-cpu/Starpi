// @ts-check
// The conversation list in the sidebar (#chat-sidebar): New chat, import, a search box and the
// conversations grouped Pinned / Today / Previous 7 days / Older, the current one marked. Each row
// has an actions menu (the "…" button, shown on hover or focus; a long press or right click opens
// it too): Rename, Pin, Move to project (only once projects exist), Export as Markdown or JSON,
// Delete. The menu follows the menu-button pattern: arrow keys, Home/End, Escape back to its button.
//
// The search and the export formats load on first use. The list follows the store's change events
// and the current chat session, so it is up to date whichever part of the app changed a chat.
import { downloadText } from '../dom.js';
import { formatDate, getLocale, onLocaleChange, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { html, icon, label, raw } from '../ui/kit.js';

/** @typedef {import('./store.js').ChatStore} ChatStore */
/** @typedef {import('../store/schema.js').ConversationRecord} ConversationRecord */
/** @typedef {import('../features/registry.js').FeatureContext} FeatureContext */
/** @typedef {import('./export.js').ExportTurn} ExportTurn */
/** @typedef {import('../ui/kit.js').SafeHtml} SafeHtml */

/**
 * What the list needs from the rest of the app.
 * @typedef {object} ConversationListDeps
 * @property {() => Promise<ChatStore>} store
 * @property {() => string} currentId  the conversation the chat shows
 * @property {(listener: (id: string) => void) => () => void} onSessionChange
 * @property {(id: string) => void | Promise<void>} open  shows a conversation in the chat
 * @property {(id: string) => Promise<boolean>} remove  deletes a conversation (false: not everywhere)
 * @property {() => boolean} isBusy  an answer is being written
 * @property {() => void} [afterRemoveCurrent]  clears the chat after its conversation was deleted
 * @property {(id: string) => Promise<void>} [settle]  waits for messages of a conversation still being stored
 * @property {string} version  app version for exports
 * @property {(name: string, text: string, type: string) => void} [download]
 * @property {(message: string) => boolean} [confirm]
 * @property {(message: string) => void} [alert]
 * @property {() => number} [now]
 * @property {() => boolean} [isNarrow]  the phone layout (the sidebar is a drawer)
 * @property {(store: ChatStore) => Promise<{ search: (q: string, limit?: number) => Array<{ id: string }>, ready: () => Promise<void> }>} [openSearch]
 */

const DAY_MS = 86_400_000;
const LONG_PRESS_MS = 500;
const SEARCH_DELAY_MS = 120;

/** i18n keys of the engine that wrote an answer, for the Markdown speaker heading. */
const ENGINE_LABELS = /** @type {Record<string, string>} */ ({
  cloud: 'engine.label_cloud',
  client: 'engine.label_client',
  wasm: 'engine.label_wasm',
  local: 'engine.label_server',
  nvidia: 'engine.label_nvidia',
  synthesizer: 'engine.label_synthesizer',
});

/** @typedef {'pinned' | 'today' | 'week' | 'older'} GroupId */

/**
 * Groups conversations for the list: pinned ones first, the rest by their last use.
 * @param {readonly ConversationRecord[]} conversations  in list order
 * @param {number} now
 * @returns {Array<{ id: GroupId, items: ConversationRecord[] }>}
 */
export function groupConversations(conversations, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const week = today - 7 * DAY_MS;
  /** @type {Record<GroupId, ConversationRecord[]>} */
  const groups = { pinned: [], today: [], week: [], older: [] };
  for (const c of conversations) {
    if (c.pinned) groups.pinned.push(c);
    else if (c.updatedAt >= today) groups.today.push(c);
    else if (c.updatedAt >= week) groups.week.push(c);
    else groups.older.push(c);
  }
  return /** @type {GroupId[]} */ (['pinned', 'today', 'week', 'older']).filter((id) => groups[id].length > 0).map((id) => ({ id, items: groups[id] }));
}

/**
 * Speaker labels for the Markdown export of a conversation.
 * @param {ExportTurn[]} turns
 * @param {string} exportedAt
 */
function markdownLabels(turns, exportedAt) {
  return {
    title: t('chat.export_title'),
    subtitle: t('chat.export_meta', { date: formatDate(new Date(exportedAt), { dateStyle: 'long', timeStyle: 'short' }), n: turns.length }),
    user: t('chat.export_you'),
    assistant: (/** @type {ExportTurn} */ turn) => {
      const key = turn.engine ? ENGINE_LABELS[turn.engine] : undefined;
      if (key && (turn.engine !== 'nvidia' || turn.model)) return `Starpi · ${t(key, { model: turn.model ?? '' })}`;
      return turn.model ? `Starpi · ${turn.model}` : 'Starpi';
    },
  };
}

/**
 * Renders the conversation list into its mount point and keeps it current.
 * @param {HTMLElement} root
 * @param {Pick<FeatureContext, 'onAction' | 'onChange' | 'switchTab' | 'toast'>} ctx
 * @param {ConversationListDeps} deps
 * @returns {{ refresh: () => Promise<void>, destroy: () => void }}
 */
export function mountConversationList(root, ctx, deps) {
  const now = deps.now ?? Date.now;
  const download = deps.download ?? downloadText;
  const confirmBox = deps.confirm ?? ((message) => window.confirm(message));
  const alertBox = deps.alert ?? ((message) => window.alert(message));
  const isNarrow = deps.isNarrow ?? (() => !globalThis.matchMedia?.('(min-width: 768px)').matches);

  /** @type {{ conversations: ConversationRecord[], loaded: boolean, failed: boolean, query: string, hits: string[] | null, menu: { id: string, view: 'main' | 'projects', projects: Array<{ id: string, name: string }> } | null, renaming: string | null }} */
  const state = { conversations: [], loaded: false, failed: false, query: '', hits: null, menu: null, renaming: null };
  /** @type {Array<() => void>} */
  const cleanups = [];
  /** @type {ChatStore | null} */
  let store = null;
  /** @type {Promise<Awaited<ReturnType<NonNullable<ConversationListDeps['openSearch']>>>> | null} */
  let searchReady = null;

  root.innerHTML = html`<div class="pt-1 space-y-2">
    <div class="flex items-center gap-1.5">
      <button type="button" data-action="new-chat" data-focus="new" class="btn btn-secondary flex-1 justify-center">${icon('square-pen', 'w-3.5 h-3.5')}${label('chat.list.new_chat')}</button>
      <button type="button" data-action="conv-import" data-focus="import" class="btn btn-ghost btn-icon" aria-label="${t('chat.list.import')}" data-i18n-aria="chat.list.import" title="${t('chat.list.import')}" data-i18n-title="chat.list.import">${icon('upload', 'w-4 h-4')}</button>
      <input type="file" accept=".json,application/json" class="hidden" data-change="conv-import-file" data-conv-import tabindex="-1" aria-hidden="true">
    </div>
    <div class="relative" role="search">
      <label for="chatListSearch" class="sr-only" data-i18n="chat.list.search_label">${t('chat.list.search_label')}</label>
      ${icon('search', 'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500')}
      <input id="chatListSearch" type="search" data-focus="search" class="field py-1.5 pl-8" autocomplete="off" spellcheck="false" placeholder="${t('chat.list.search_placeholder')}" data-i18n-placeholder="chat.list.search_placeholder">
    </div>
    <p id="chatListStatus" class="sr-only" role="status" aria-live="polite"></p>
    <div id="chatList" data-chat-list></div>
  </div>`.value;
  refreshIcons(root);
  const list = /** @type {HTMLElement} */ (root.querySelector('[data-chat-list]'));
  const search = /** @type {HTMLInputElement} */ (root.querySelector('#chatListSearch'));
  const status = /** @type {HTMLElement} */ (root.querySelector('#chatListStatus'));
  const fileInput = /** @type {HTMLInputElement} */ (root.querySelector('[data-conv-import]'));

  /** @param {string} id */
  const find = (id) => state.conversations.find((c) => c.id === id);
  /** @param {ConversationRecord | undefined} c */
  const titleOf = (c) => c?.title || t('chat.list.untitled');

  // -------------------------------------------------------------------------------------------
  // Rendering

  /**
   * @param {ConversationRecord} c
   * @param {string} current
   * @returns {SafeHtml}
   */
  function row(c, current) {
    const title = titleOf(c);
    if (state.renaming === c.id) {
      return html`<li class="flex items-center" data-conv-id="${c.id}"><input type="text" data-rename="${c.id}" data-focus="rename:${c.id}" class="field py-1 text-sm" maxlength="200" value="${c.title}" aria-label="${t('chat.list.rename_label', { title })}"></li>`;
    }
    const open = state.menu?.id === c.id;
    const isCurrent = c.id === current;
    return html`<li class="group relative flex items-center gap-0.5" data-conv-id="${c.id}">
      <button type="button" data-action="conv-open" data-arg="${c.id}" data-focus="open:${c.id}"${isCurrent ? raw(' aria-current="true"') : ''} class="flex-1 min-w-0 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 aria-[current=true]:bg-amber-50 aria-[current=true]:text-amber-950 aria-[current=true]:font-medium">
        ${c.pinned ? html`${icon('pin', 'w-3.5 h-3.5 flex-shrink-0 text-amber-600')}<span class="sr-only">${t('chat.list.pinned')}: </span>` : ''}<span class="truncate">${title}</span>
      </button>
      <button type="button" data-action="conv-menu" data-arg="${c.id}" data-focus="menu:${c.id}" aria-haspopup="menu" aria-expanded="${String(open)}"${open ? raw(' aria-controls="chatListMenu"') : ''} aria-label="${t('chat.list.more', { title })}" title="${t('chat.list.more', { title })}" class="flex-shrink-0 rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100">${icon('ellipsis', 'w-4 h-4')}</button>
      ${open ? menu(c) : ''}
    </li>`;
  }

  /**
   * @param {string} action
   * @param {string} iconName
   * @param {import('../ui/kit.js').Label} text
   * @param {{ arg?: string, role?: string, checked?: boolean, danger?: boolean }} [opts]
   */
  function item(action, iconName, text, opts = {}) {
    const role = opts.role ?? 'menuitem';
    return html`<button type="button" role="${role}" tabindex="-1" data-action="${action}"${opts.arg !== undefined ? html` data-arg="${opts.arg}"` : ''}${role === 'menuitemradio' ? html` aria-checked="${String(Boolean(opts.checked))}"` : ''} class="chat-menu-item${opts.danger ? ' text-rose-700' : ''}">${icon(iconName, 'w-3.5 h-3.5')}${label(text)}</button>`;
  }

  /** @param {ConversationRecord} c */
  function menu(c) {
    const m = /** @type {NonNullable<typeof state.menu>} */ (state.menu);
    const items =
      m.view === 'projects'
        ? [
            item('conv-move-back', 'arrow-left', 'chat.list.move_back'),
            item('conv-move-to', c.projectId ? 'circle-dashed' : 'check', 'chat.list.move_none', { arg: '', role: 'menuitemradio', checked: !c.projectId }),
            ...m.projects.map((p) => item('conv-move-to', c.projectId === p.id ? 'check' : 'folder-open', { text: p.name }, { arg: p.id, role: 'menuitemradio', checked: c.projectId === p.id })),
          ]
        : [
            item('conv-rename', 'pencil', 'chat.list.rename'),
            item('conv-pin', c.pinned ? 'pin-off' : 'pin', c.pinned ? 'chat.list.unpin' : 'chat.list.pin'),
            m.projects.length ? item('conv-move', 'folder-input', 'chat.list.move') : '',
            item('conv-export', 'file-text', 'chat.list.export_md', { arg: 'md' }),
            item('conv-export', 'braces', 'chat.list.export_json', { arg: 'json' }),
            item('conv-delete', 'trash-2', 'chat.list.delete', { danger: true }),
          ];
    const name = m.view === 'projects' ? t('chat.list.move_menu') : t('chat.list.menu', { title: titleOf(c) });
    return html`<div id="chatListMenu" role="menu" aria-label="${name}" data-menu-for="${c.id}" class="absolute right-0 top-full z-30 mt-1 w-56 card p-1 flex flex-col">${items}</div>`;
  }

  /**
   * @param {GroupId | 'results'} id
   * @param {string} key
   * @param {ConversationRecord[]} items
   * @param {string} current
   */
  function group(id, key, items, current) {
    return html`<section class="mt-2" aria-labelledby="chatListGroup-${id}">
      <h2 id="chatListGroup-${id}" class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500" data-i18n="${key}">${t(key)}</h2>
      <ul class="space-y-0.5">${items.map((c) => row(c, current))}</ul>
    </section>`;
  }

  /** @returns {SafeHtml} */
  function body() {
    const current = deps.currentId();
    if (state.failed) return html`<p class="px-2 py-3 text-xs text-slate-600" data-i18n="chat.list.load_failed">${t('chat.list.load_failed')}</p>`;
    if (state.hits) {
      const byId = new Map(state.conversations.map((c) => [c.id, c]));
      const hits = state.hits.map((id) => byId.get(id)).filter((c) => c !== undefined);
      if (hits.length === 0) return html`<p class="px-2 py-3 text-xs text-slate-600" data-i18n="chat.list.search_none">${t('chat.list.search_none')}</p>`;
      return group('results', 'chat.list.search_results', hits, current);
    }
    if (!state.loaded) return html``;
    if (state.conversations.length === 0) return html`<p class="px-2 py-3 text-xs text-slate-600" data-i18n="chat.list.empty">${t('chat.list.empty')}</p>`;
    return html`${groupConversations(state.conversations, now()).map((g) => group(g.id, `chat.list.group_${g.id}`, g.items, current))}`;
  }

  /**
   * Redraws the list. Focus stays on the control it was on (or moves to `focusKey`).
   * @param {string} [focusKey]
   */
  function render(focusKey) {
    const active = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    list.innerHTML = body().value;
    refreshIcons(list);
    placeMenu();
    const key = focusKey ?? active;
    if (key) /** @type {HTMLElement | null} */ (list.querySelector(`[data-focus="${CSS.escape(key)}"]`))?.focus();
    const input = /** @type {HTMLInputElement | null} */ (list.querySelector('[data-rename]'));
    if (input && key?.startsWith('rename:')) input.select();
  }

  /** Opens the menu upwards when it would run past the bottom of the list's scroll area. */
  function placeMenu() {
    const menuEl = list.querySelector('[role="menu"]');
    if (!menuEl || typeof root.getBoundingClientRect !== 'function') return;
    const box = menuEl.getBoundingClientRect();
    const area = root.getBoundingClientRect();
    if (box.bottom > area.bottom && box.top - area.top > box.height + 40) {
      menuEl.classList.remove('top-full', 'mt-1');
      menuEl.classList.add('bottom-full', 'mb-1');
    }
  }

  /** @param {string} text */
  function announce(text) {
    status.textContent = text;
  }

  // -------------------------------------------------------------------------------------------
  // Data

  async function reload() {
    try {
      store ??= await deps.store();
      state.conversations = await store.listConversations();
      state.failed = false;
    } catch (err) {
      console.warn('[starpi] the conversation list could not be loaded', err);
      state.failed = true;
    }
    state.loaded = true;
    if (state.query && searchReady) await runSearch(true);
    // A rename in progress is not redrawn under the typing user; it redraws when it ends.
    if (!state.renaming) render();
  }

  let reloadTimer = 0;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => void reload(), 30);
  }

  /** @returns {Promise<Awaited<ReturnType<NonNullable<ConversationListDeps['openSearch']>>>>} */
  function getSearch() {
    searchReady ??= (async () => {
      const s = store ?? (await deps.store());
      if (deps.openSearch) return deps.openSearch(s);
      const { openConversationSearch } = await import('./search.js');
      return openConversationSearch(s);
    })();
    searchReady.catch(() => {
      searchReady = null;
    });
    return searchReady;
  }

  /** @param {boolean} [quiet] */
  async function runSearch(quiet = false) {
    const query = search.value.trim();
    state.query = query;
    if (!query) {
      state.hits = null;
      if (!quiet) {
        announce('');
        render();
      }
      return;
    }
    try {
      const engine = await getSearch();
      await engine.ready();
      if (state.query !== query) return;
      state.hits = engine.search(query, 100).map((h) => h.id);
    } catch (err) {
      console.warn('[starpi] the chat search could not run', err);
      state.hits = [];
    }
    if (quiet) return;
    const n = state.hits.filter((id) => find(id)).length;
    announce(n ? t('chat.list.search_count', { n }) : t('chat.list.search_none'));
    render();
  }

  // -------------------------------------------------------------------------------------------
  // Actions

  /** After choosing a chat: show the chat; on phones the drawer closes and the composer takes focus. */
  function showChat() {
    ctx.switchTab('chat');
    if (isNarrow()) document.getElementById('chatInput')?.focus();
  }

  /** @param {string} id */
  async function openConversation(id) {
    state.menu = null;
    if (id !== deps.currentId()) await deps.open(id);
    render(isNarrow() ? undefined : `open:${id}`);
    showChat();
  }

  /** @param {string} id */
  async function openMenu(id) {
    if (state.menu?.id === id) return;
    state.renaming = null;
    state.menu = { id, view: 'main', projects: [] };
    render();
    focusMenuItem(0);
    try {
      const projects = await (store ?? (await deps.store())).listProjects();
      if (state.menu?.id !== id || projects.length === 0) return;
      state.menu.projects = projects;
      const focused = menuItems().indexOf(/** @type {HTMLElement} */ (document.activeElement));
      render();
      focusMenuItem(Math.max(0, focused));
    } catch {
      // Without projects the menu simply has no "Move to project".
    }
  }

  /** @param {boolean} [refocus] */
  function closeMenu(refocus = true) {
    const id = state.menu?.id;
    if (!id) return;
    state.menu = null;
    render(refocus ? `menu:${id}` : undefined);
  }

  /** @returns {HTMLElement[]} */
  function menuItems() {
    return /** @type {HTMLElement[]} */ ([...list.querySelectorAll('[role="menu"] [role^="menuitem"]')]);
  }

  /** @param {number} index */
  function focusMenuItem(index) {
    const items = menuItems();
    if (items.length === 0) return;
    items[((index % items.length) + items.length) % items.length].focus();
  }

  /** @param {string} id */
  function startRename(id) {
    state.menu = null;
    state.renaming = id;
    render(`rename:${id}`);
  }

  /**
   * @param {string} id
   * @param {boolean} save
   */
  async function endRename(id, save) {
    if (state.renaming !== id) return;
    const input = /** @type {HTMLInputElement | null} */ (list.querySelector(`[data-rename="${CSS.escape(id)}"]`));
    const title = input?.value.trim() ?? '';
    state.renaming = null;
    const conversation = find(id);
    if (save && title && conversation && title !== conversation.title) {
      conversation.title = title;
      render(`open:${id}`);
      try {
        await (store ?? (await deps.store())).updateConversation(id, { title });
      } catch (err) {
        console.warn('[starpi] the chat could not be renamed', err);
        ctx.toast('chat.list.action_failed', { tone: 'warn' });
        scheduleReload();
      }
      return;
    }
    render(`open:${id}`);
  }

  /** @param {string} id */
  async function togglePin(id) {
    const conversation = find(id);
    closeMenu();
    if (!conversation) return;
    try {
      await (store ?? (await deps.store())).updateConversation(id, { pinned: !conversation.pinned });
    } catch (err) {
      console.warn('[starpi] the chat could not be pinned', err);
      ctx.toast('chat.list.action_failed', { tone: 'warn' });
    }
  }

  /**
   * @param {string} id
   * @param {string} projectId  '' takes the chat out of its project
   */
  async function moveTo(id, projectId) {
    const project = state.menu?.projects.find((p) => p.id === projectId);
    closeMenu();
    try {
      await (store ?? (await deps.store())).updateConversation(id, { projectId: projectId || null });
      ctx.toast(project ? { key: 'chat.list.moved', params: { project: project.name } } : 'chat.list.moved_none', { tone: 'ok' });
    } catch (err) {
      console.warn('[starpi] the chat could not be moved', err);
      ctx.toast('chat.list.action_failed', { tone: 'warn' });
    }
  }

  /**
   * @param {string} id
   * @param {'md' | 'json'} format
   */
  async function exportOne(id, format) {
    closeMenu();
    try {
      await deps.settle?.(id);
      const [{ exportConversation }, s] = await Promise.all([import('./export.js'), store ?? deps.store()]);
      const exportedAt = new Date(now()).toISOString();
      const file = await exportConversation(s, id, { format, meta: { exportedAt, version: deps.version, locale: getLocale() }, labels: (turns) => markdownLabels(turns, exportedAt) });
      if (file) download(file.name, file.text, file.type);
    } catch (err) {
      console.warn('[starpi] the chat could not be exported', err);
      ctx.toast('chat.list.action_failed', { tone: 'warn' });
    }
  }

  /** @param {string} id */
  async function removeOne(id) {
    const conversation = find(id);
    const current = id === deps.currentId();
    state.menu = null;
    render();
    // An answer still being written would store its turn again after the delete.
    if (current && deps.isBusy()) {
      alertBox(t('chat.delete_busy'));
      render(`menu:${id}`);
      return;
    }
    if (!confirmBox(t('chat.list.delete_confirm', { title: titleOf(conversation) }))) {
      render(`menu:${id}`);
      return;
    }
    // Focus moves to the next row (or the one before, or the search box) once the row is gone.
    const ids = state.conversations.map((c) => c.id);
    const at = ids.indexOf(id);
    const next = ids[at + 1] ?? ids[at - 1];
    const ok = await deps.remove(id);
    if (current) deps.afterRemoveCurrent?.();
    state.conversations = state.conversations.filter((c) => c.id !== id);
    render(next ? `open:${next}` : undefined);
    if (!next) search.focus();
    ctx.toast(ok ? 'chat.list.deleted' : 'chat.list.delete_partial', { tone: ok ? 'ok' : 'warn' });
  }

  /** @param {File} file */
  async function importFile(file) {
    const [{ parseChatImport, ChatImportError }, s] = await Promise.all([import('./export.js'), store ?? deps.store()]);
    /** @type {ReturnType<typeof parseChatImport>} */
    let parsed;
    try {
      parsed = parseChatImport(await file.text());
    } catch (err) {
      const code = err instanceof ChatImportError ? err.code : 'invalid';
      ctx.toast(`chat.list.import_error_${code}`, { tone: 'warn' });
      return;
    }
    try {
      const conversation = await s.importConversation(parsed);
      ctx.toast({ key: 'chat.list.import_done', params: { title: titleOf(conversation) } }, { tone: 'ok' });
      await deps.open(conversation.id);
      await reload();
      render(`open:${conversation.id}`);
      showChat();
    } catch (err) {
      console.warn('[starpi] the chat could not be imported', err);
      ctx.toast('chat.list.import_error_store', { tone: 'warn' });
    }
  }

  const menuId = () => state.menu?.id ?? '';
  ctx.onAction('conv-open', (el) => openConversation(el.dataset.arg ?? ''));
  ctx.onAction('conv-menu', (el) => {
    const id = el.dataset.arg ?? '';
    if (state.menu?.id === id) closeMenu();
    else return openMenu(id);
  });
  ctx.onAction('conv-rename', () => startRename(menuId()));
  ctx.onAction('conv-pin', () => togglePin(menuId()));
  ctx.onAction('conv-move', () => {
    if (!state.menu) return;
    state.menu.view = 'projects';
    render();
    focusMenuItem(1);
  });
  ctx.onAction('conv-move-back', () => {
    if (!state.menu) return;
    state.menu.view = 'main';
    render();
    focusMenuItem(menuItems().findIndex((el) => el.dataset.action === 'conv-move'));
  });
  ctx.onAction('conv-move-to', (el) => moveTo(menuId(), el.dataset.arg ?? ''));
  ctx.onAction('conv-export', (el) => exportOne(menuId(), el.dataset.arg === 'json' ? 'json' : 'md'));
  ctx.onAction('conv-delete', () => removeOne(menuId()));
  ctx.onAction('conv-import', () => fileInput.click());
  ctx.onChange('conv-import-file', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    return file ? importFile(file) : undefined;
  });

  // -------------------------------------------------------------------------------------------
  // Events

  /**
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {EventTarget} [target]
   * @param {boolean | AddEventListenerOptions} [options]
   */
  const listen = (type, handler, target = root, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  listen('keydown', (event) => {
    const e = /** @type {KeyboardEvent} */ (event);
    const target = /** @type {HTMLElement} */ (e.target);
    const rename = target.dataset?.rename;
    if (rename) {
      if (e.key === 'Enter') {
        e.preventDefault();
        void endRename(rename, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        void endRename(rename, false);
      }
      return;
    }
    if (target.dataset?.action === 'conv-menu' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const id = target.dataset.arg ?? '';
      if (state.menu?.id === id) focusMenuItem(e.key === 'ArrowUp' ? -1 : 0);
      else void openMenu(id).then(() => e.key === 'ArrowUp' && focusMenuItem(-1));
      return;
    }
    if (!target.closest('[role="menu"]')) return;
    const items = menuItems();
    const at = items.indexOf(target);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusMenuItem(at + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusMenuItem(e.key === 'Home' ? 0 : -1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
    }
  });

  listen('focusout', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const rename = target.dataset?.rename;
    if (rename) void endRename(rename, true);
  });

  // A click elsewhere closes the menu.
  listen(
    'click',
    (event) => {
      if (!state.menu) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="menu"]') || target?.closest(`[data-action="conv-menu"][data-arg="${CSS.escape(state.menu.id)}"]`)) return;
      closeMenu(false);
    },
    document,
  );

  // New chat from the list shows the chat as well (chat.js handles the action itself).
  listen('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-action="new-chat"]')) showChat();
  });

  // Long press (touch) or right click opens a row's menu.
  let pressTimer = 0;
  let pressStart = { x: 0, y: 0 };
  let swallowClick = false;
  const cancelPress = () => clearTimeout(pressTimer);
  listen('pointerdown', (event) => {
    const e = /** @type {PointerEvent} */ (event);
    swallowClick = false;
    if (e.pointerType !== 'touch') return;
    const target = e.target instanceof Element ? e.target : null;
    const rowEl = target?.closest('[data-conv-id]');
    if (!(rowEl instanceof HTMLElement) || target?.closest('[role="menu"], [data-rename]')) return;
    pressStart = { x: e.clientX, y: e.clientY };
    pressTimer = window.setTimeout(() => {
      swallowClick = true;
      void openMenu(rowEl.dataset.convId ?? '');
    }, LONG_PRESS_MS);
  });
  listen('pointermove', (event) => {
    const e = /** @type {PointerEvent} */ (event);
    if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
  });
  listen('pointerup', cancelPress);
  listen('pointercancel', cancelPress);
  listen(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    root,
    true,
  );
  listen('contextmenu', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const rowEl = target?.closest('[data-conv-id]');
    if (!(rowEl instanceof HTMLElement) || target?.closest('[role="menu"], [data-rename]')) return;
    event.preventDefault();
    cancelPress();
    void openMenu(rowEl.dataset.convId ?? '');
  });

  let searchTimer = 0;
  listen(
    'input',
    () => {
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void runSearch(), SEARCH_DELAY_MS);
    },
    search,
  );
  listen(
    'keydown',
    (event) => {
      const e = /** @type {KeyboardEvent} */ (event);
      if (e.key !== 'Escape' || !search.value) return;
      e.preventDefault();
      e.stopPropagation();
      search.value = '';
      void runSearch();
    },
    search,
  );

  const offSession = deps.onSessionChange(() => {
    if (!state.renaming) render();
  });
  cleanups.push(offSession);
  cleanups.push(onLocaleChange(() => render()));

  const ready = (async () => {
    try {
      store = await deps.store();
      cleanups.push(store.onChange(() => scheduleReload()));
    } catch {
      // reload() reports the failure in the list.
    }
    await reload();
  })();

  return {
    refresh: async () => {
      await ready;
      await reload();
    },
    destroy() {
      clearTimeout(reloadTimer);
      clearTimeout(searchTimer);
      cancelPress();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
