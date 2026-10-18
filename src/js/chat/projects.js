// @ts-check
// Projects: chats kept together with their own instructions, default model, files and memory.
//
// - A project is a record of the `projects` store (store/schema.js ProjectRecord): a name, the
//   instructions added to the free chat's system prompt of its chats, the model a new chat in it
//   starts with, the workspace documents its grounded questions search (docIds) and its memory
//   setting ('global': the global notes and its own, 'project': only its own, 'off': none).
// - A chat belongs to a project through the conversation's projectId (chat/store.js); "Move to
//   project" in the conversation list and "New chat" in a project set it. Deleting a project keeps
//   its chats (they leave the project) and deletes the notes saved for it.
// - The first project asks the browser to keep the site's data (store/quota.js requestPersistence).
//
// The sidebar section lists the projects with their chats and opens the editor dialog. Every text
// is an i18n key of the memory namespace; names are the user's own text.
import { formatNumber, onLocaleChange, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { appDb, storeProfileName } from '../store/schema.js';
import { html, icon, label, raw } from '../ui/kit.js';

/** @typedef {import('../store/idb.js').StoreDb} StoreDb */
/** @typedef {import('../store/schema.js').ProjectRecord} ProjectRecord */
/** @typedef {import('../store/schema.js').ConversationRecord} ConversationRecord */
/** @typedef {import('./store.js').ChatStore} ChatStore */
/** @typedef {import('./hooks.js').SidebarSectionContext} SidebarSectionContext */
/** @typedef {ProjectRecord['memoryScope']} MemoryScope */

export const PROJECT_LIMITS = Object.freeze({
  projects: 100,
  nameChars: 80,
  instructionChars: 4000,
  docs: 50,
});
/** @type {readonly MemoryScope[]} */
export const MEMORY_SCOPES = Object.freeze(['global', 'project', 'off']);
/** A model picker value (state.js AssistantValue) as a project or an assistant may keep it. */
export const MODEL_VALUE = /^(?:auto|device|(?:[a-z][a-z0-9-]{0,30}):(?:\*|[\w][\w.:/@+-]{0,199}))$/;
const DOC_ID = /^[\w:.-]{1,200}$/;

/** name: no name left after tidying; full: the most projects there may be; not_found: no such project. */
export class ProjectError extends Error {
  /** @param {'name' | 'full' | 'not_found'} code */
  constructor(code) {
    super(code);
    this.name = 'ProjectError';
    this.code = code;
  }
}

/**
 * Text on one line, white space joined, at most `max` characters.
 * @param {unknown} value
 * @param {number} max
 */
export function oneLine(value, max) {
  return Array.from(String(value ?? '').replace(/\s+/g, ' ').trim())
    .slice(0, max)
    .join('')
    .trim();
}

/**
 * Text with its lines kept, at most `max` characters.
 * @param {unknown} value
 * @param {number} max
 */
export function multiLine(value, max) {
  return Array.from(
    String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .trim(),
  )
    .slice(0, max)
    .join('')
    .trim();
}

/**
 * A model value as kept, or null for none (or one that is not a picker value).
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanModel(value) {
  return typeof value === 'string' && MODEL_VALUE.test(value) ? value : null;
}

/**
 * The editable fields of a project from an input, on top of `base` (an existing project).
 * @param {Partial<ProjectRecord>} input
 * @param {Partial<ProjectRecord>} [base]
 * @returns {Pick<ProjectRecord, 'name' | 'instructions' | 'defaultModel' | 'docIds' | 'memoryScope'>}
 */
export function projectFields(input, base = {}) {
  const pick = (/** @type {keyof ProjectRecord} */ key) => (input[key] !== undefined ? input[key] : base[key]);
  const name = oneLine(pick('name'), PROJECT_LIMITS.nameChars);
  if (!name) throw new ProjectError('name');
  const docs = pick('docIds');
  const scope = /** @type {MemoryScope} */ (pick('memoryScope'));
  return {
    name,
    instructions: multiLine(pick('instructions'), PROJECT_LIMITS.instructionChars),
    defaultModel: cleanModel(pick('defaultModel')),
    docIds: [...new Set(Array.isArray(docs) ? docs.filter((d) => typeof d === 'string' && DOC_ID.test(d)) : [])].slice(0, PROJECT_LIMITS.docs),
    memoryScope: MEMORY_SCOPES.includes(scope) ? scope : 'global',
  };
}

/**
 * @param {unknown} value
 * @returns {value is ProjectRecord}
 */
function isProject(value) {
  const r = /** @type {Record<string, unknown> | null} */ (value && typeof value === 'object' ? value : null);
  return Boolean(r && typeof r.id === 'string' && typeof r.name === 'string');
}

/**
 * A stored record with every field present (older or hand-made records lack some).
 * @param {ProjectRecord} r
 * @returns {ProjectRecord}
 */
function complete(r) {
  const fields = projectFields({ ...r, name: oneLine(r.name, PROJECT_LIMITS.nameChars) || '—' });
  return { id: r.id, ...fields, createdAt: Number(r.createdAt) || 0, updatedAt: Number(r.updatedAt) || 0 };
}

/**
 * @typedef {object} RecordStoreOptions
 * @property {() => Promise<StoreDb>} [open]  the database (default: the app database)
 * @property {string | null} [channel]  BroadcastChannel name for changes between tabs
 */

/**
 * What the project and assistant stores share: calls one after the other on the database, and
 * change listeners that also hear the other tabs.
 * @param {RecordStoreOptions} options
 * @param {string} what  for the log
 */
export function recordStoreBase(options, what) {
  const open = options.open ?? appDb;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {BroadcastChannel | null} */
  let channel = null;
  const deliver = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.error(`[starpi] a ${what} listener failed`, err);
      }
    }
  };
  if (options.channel && typeof BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel(options.channel);
      channel.onmessage = deliver;
    } catch {
      channel = null;
    }
  }
  let tail = Promise.resolve();
  return {
    /**
     * @template T
     * @param {(db: StoreDb) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    serial(fn) {
      const run = tail.then(() => open()).then(fn);
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    emit() {
      deliver();
      try {
        channel?.postMessage('change');
      } catch {
        // The other tabs only miss this change.
      }
    },
    /**
     * @param {() => void} listener
     * @returns {() => void}
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      channel?.close();
      channel = null;
    },
  };
}

/**
 * @typedef {RecordStoreOptions & { now?: () => number, uuid?: () => string, persist?: () => unknown }} ProjectStoreOptions
 *   persist: asks the browser to keep the site's data (first project)
 */

/**
 * Builds a project store.
 * @param {ProjectStoreOptions} [options]
 */
export function createProjectStore(options = {}) {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const persist = options.persist ?? (() => import('../store/quota.js').then((m) => m.requestPersistence()));
  const { serial, emit, onChange, close } = recordStoreBase(options, 'project');
  /** @param {StoreDb} db @returns {Promise<ProjectRecord[]>} */
  const all = async (db) => (await db.getAll('projects')).filter(isProject).map(complete);

  const store = {
    /**
     * Every project, by name.
     * @returns {Promise<ProjectRecord[]>}
     */
    list() {
      return serial(async (db) => (await all(db)).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)));
    },

    /**
     * @param {string} id
     * @returns {Promise<ProjectRecord | null>}
     */
    get(id) {
      return serial(async (db) => {
        const r = await db.get('projects', id);
        return isProject(r) ? complete(r) : null;
      });
    },

    /**
     * Creates a project. The first one asks the browser to keep the site's data.
     * @param {Partial<ProjectRecord>} input
     * @returns {Promise<ProjectRecord>}
     */
    create(input) {
      return serial(async (db) => {
        const fields = projectFields(input);
        const count = await db.count('projects');
        if (count >= PROJECT_LIMITS.projects) throw new ProjectError('full');
        const at = now();
        /** @type {ProjectRecord} */
        const record = { id: `project_${uuid()}`, ...fields, createdAt: at, updatedAt: at };
        await db.add('projects', record);
        if (count === 0) {
          try {
            void Promise.resolve(persist()).catch(() => {});
          } catch {
            // Persistence is best effort.
          }
        }
        emit();
        return record;
      });
    },

    /**
     * @param {string} id
     * @param {Partial<ProjectRecord>} patch
     * @returns {Promise<ProjectRecord>}
     */
    update(id, patch) {
      return serial(async (db) => {
        const found = await db.get('projects', id);
        if (!isProject(found)) throw new ProjectError('not_found');
        const base = complete(found);
        /** @type {ProjectRecord} */
        const record = { ...base, ...projectFields(patch, base), updatedAt: now() };
        await db.put('projects', record);
        emit();
        return record;
      });
    },

    /**
     * Deletes the project record (its chats and notes are the caller's: see removeProject).
     * @param {string} id
     * @returns {Promise<boolean>} false when there was no such project
     */
    remove(id) {
      return serial(async (db) => {
        const found = await db.get('projects', id);
        if (!found) return false;
        await db.delete('projects', id);
        emit();
        return true;
      });
    },

    onChange,
    close,
  };
  return store;
}

/** @typedef {ReturnType<typeof createProjectStore>} ProjectStore */

/** @type {ProjectStore | null} */
let shared = null;

/** The page's project store on the app database. */
export function projectStore() {
  shared ??= createProjectStore({ channel: `${storeProfileName()}-projects` });
  return shared;
}

/**
 * Deletes a project: its chats stay and leave the project, the notes saved for it are deleted.
 * @param {string} id
 * @param {{ projects: ProjectStore, chats: ChatStore, removeNotes?: (scope: string) => Promise<unknown> }} deps
 * @returns {Promise<{ chats: number }>} how many chats left the project
 */
export async function removeProject(id, deps) {
  const chats = (await deps.chats.listConversations({ includeArchived: true })).filter((c) => c.projectId === id);
  for (const c of chats) await deps.chats.updateConversation(c.id, { projectId: null });
  await deps.removeNotes?.(id);
  await deps.projects.remove(id);
  return { chats: chats.length };
}

// ---------------------------------------------------------------------------------------------
// The sidebar section

/**
 * @typedef {object} ProjectsSectionDeps
 * @property {ProjectStore} projects
 * @property {() => Promise<ChatStore>} chats
 * @property {() => string} currentId  the conversation the chat shows
 * @property {(listener: (id: string) => void) => () => void} onSessionChange
 * @property {(id: string) => unknown} open  shows a chat
 * @property {(projectId: string) => unknown} newChat  starts a chat in the project
 * @property {(project: ProjectRecord | null) => unknown} edit  opens the editor (null: a new project)
 */

/**
 * Renders the projects section of the sidebar into `host` and keeps it current.
 * @param {HTMLElement} host
 * @param {ProjectsSectionDeps} deps
 * @returns {() => void} cleanup
 */
export function mountProjectsSection(host, deps) {
  /** @type {{ projects: ProjectRecord[], chats: ConversationRecord[], open: Set<string> }} */
  const state = { projects: [], chats: [], open: new Set() };
  /** @type {Array<() => void>} */
  const cleanups = [];
  let alive = true;

  /** @param {ConversationRecord} c */
  const chatRow = (c) => {
    const current = c.id === deps.currentId();
    return html`<li><button type="button" data-pj="open" data-id="${c.id}"${current ? raw(' aria-current="true"') : ''} class="w-full min-w-0 flex items-center gap-2 rounded-lg pl-8 pr-2 py-1 text-left text-[13px] text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 aria-[current=true]:bg-amber-50 aria-[current=true]:text-amber-950"><span class="truncate">${c.title || t('chat.list.untitled')}</span></button></li>`;
  };

  /** @param {ProjectRecord} p */
  const projectRow = (p) => {
    const chats = state.chats.filter((c) => c.projectId === p.id);
    const expanded = state.open.has(p.id);
    return html`<li data-project-id="${p.id}">
      <div class="group flex items-center gap-0.5">
        <button type="button" data-pj="toggle" data-id="${p.id}" aria-expanded="${String(expanded)}" class="flex-1 min-w-0 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900">
          ${icon(expanded ? 'folder-open' : 'folder', 'w-3.5 h-3.5 flex-shrink-0 text-amber-600')}<span class="truncate">${p.name}</span><span class="ml-auto text-[11px] text-slate-500" aria-hidden="true">${formatNumber(chats.length)}</span><span class="sr-only">${t('memory.projects.chat_count', { n: chats.length })}</span>
        </button>
        <button type="button" data-pj="edit" data-id="${p.id}" class="flex-shrink-0 rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900" aria-label="${t('memory.projects.edit_named', { name: p.name })}" title="${t('memory.projects.edit_named', { name: p.name })}">${icon('pencil', 'w-3.5 h-3.5')}</button>
      </div>
      ${
        expanded
          ? html`<ul class="space-y-0.5 pb-1">
              <li><button type="button" data-pj="new-chat" data-id="${p.id}" class="w-full flex items-center gap-2 rounded-lg pl-8 pr-2 py-1 text-left text-[13px] text-slate-600 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900">${icon('square-pen', 'w-3.5 h-3.5')}${label('memory.projects.new_chat')}</button></li>
              ${chats.map(chatRow)}
            </ul>`
          : ''
      }
    </li>`;
  };

  function render() {
    if (!alive) return;
    const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    const focus = active ? { pj: active.dataset.pj, id: active.dataset.id } : null;
    host.innerHTML = html`<section class="pt-1" aria-labelledby="sbProjectsTitle">
      <div class="flex items-center justify-between gap-1 px-2">
        <h2 id="sbProjectsTitle" class="text-[11px] font-semibold uppercase tracking-wide text-slate-500" data-i18n="memory.projects.title">${t('memory.projects.title')}</h2>
        <button type="button" data-pj="new" class="rounded-md p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900" aria-label="${t('memory.projects.new')}" data-i18n-aria="memory.projects.new" title="${t('memory.projects.new')}" data-i18n-title="memory.projects.new">${icon('folder-plus', 'w-3.5 h-3.5')}</button>
      </div>
      ${state.projects.length ? html`<ul class="mt-1 space-y-0.5">${state.projects.map(projectRow)}</ul>` : label('memory.projects.empty', { tag: 'p', className: 'px-2 pb-1 text-[11px] text-slate-500 leading-snug' })}
    </section>`.value;
    refreshIcons(host);
    if (focus?.pj) {
      const match = [...host.querySelectorAll('[data-pj]')].find((el) => el instanceof HTMLElement && el.dataset.pj === focus.pj && (el.dataset.id ?? '') === (focus.id ?? ''));
      if (match instanceof HTMLElement) match.focus();
    }
  }

  async function reload() {
    try {
      const [projects, chats] = await Promise.all([deps.projects.list(), deps.chats().then((s) => s.listConversations())]);
      state.projects = projects;
      state.chats = chats.filter((c) => c.projectId);
    } catch (err) {
      console.warn('[starpi] the projects could not be loaded', err);
    }
    render();
  }

  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void reload(), 30);
  };

  host.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-pj]') : null;
    if (!(target instanceof HTMLElement)) return;
    const id = target.dataset.id ?? '';
    const project = state.projects.find((p) => p.id === id) ?? null;
    switch (target.dataset.pj) {
      case 'new':
        void deps.edit(null);
        break;
      case 'edit':
        if (project) void deps.edit(project);
        break;
      case 'toggle':
        if (state.open.has(id)) state.open.delete(id);
        else state.open.add(id);
        render();
        break;
      case 'new-chat':
        void deps.newChat(id);
        break;
      case 'open':
        void deps.open(id);
        break;
      default:
    }
  });

  cleanups.push(deps.projects.onChange(schedule));
  cleanups.push(deps.onSessionChange(() => render()));
  cleanups.push(onLocaleChange(() => render()));
  void deps
    .chats()
    .then((s) => {
      if (alive) cleanups.push(s.onChange(schedule));
    })
    .catch(() => {});
  render();
  void reload();
  return () => {
    alive = false;
    clearTimeout(timer);
    for (const fn of cleanups.splice(0)) fn();
  };
}

// ---------------------------------------------------------------------------------------------
// The editor

/**
 * @typedef {object} ProjectEditorDeps
 * @property {ProjectStore} projects
 * @property {() => Promise<ChatStore>} chats
 * @property {() => Promise<Array<{ docId: string, name: string }>>} documents  the workspace documents
 * @property {() => string} currentModel  the model picker's value
 * @property {(value: string) => string} modelName
 * @property {(scope: string) => Promise<unknown>} [removeNotes]
 * @property {(message: string) => boolean} [confirm]
 * @property {typeof import('../ui/kit.js').toast} toast
 * @property {(project: ProjectRecord) => unknown} [created]  after a new project was saved
 */

/**
 * The options of the default-model select: none, the picker's value now, and the stored one.
 * @param {string | null} stored
 * @param {ProjectEditorDeps['currentModel']} current
 * @param {ProjectEditorDeps['modelName']} name
 */
export function modelOptions(stored, current, name) {
  const values = [...new Set([cleanModel(current()), stored].filter((v) => typeof v === 'string'))];
  return html`<option value=""${stored ? '' : raw(' selected')}>${t('memory.model_none')}</option>${values.map((v) => html`<option value="${v}"${v === stored ? raw(' selected') : ''}>${name(/** @type {string} */ (v))}</option>`)}`;
}

/**
 * Opens the project editor: a new project (null) or an existing one, with Delete.
 * @param {ProjectRecord | null} project
 * @param {ProjectEditorDeps} deps
 */
export async function openProjectEditor(project, deps) {
  const [{ openFormDialog, showFormError }, docs] = await Promise.all([import('./form-dialog.js'), deps.documents().catch(() => [])]);
  const chosen = new Set(project?.docIds ?? []);
  // Files of the project that are no longer in the workspace stay listed, so saving keeps them.
  const known = new Set(docs.map((d) => d.docId));
  const missing = [...chosen].filter((id) => !known.has(id));
  const scope = project?.memoryScope ?? 'global';
  const confirmBox = deps.confirm ?? ((message) => window.confirm(message));
  const fileRows = [
    ...docs.map((d) => html`<label class="flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" name="doc" value="${d.docId}" class="rounded border-slate-300 text-amber-500 focus:ring-amber-300"${chosen.has(d.docId) ? raw(' checked') : ''}><span class="truncate">${d.name}</span></label>`),
    ...missing.map((id) => html`<label class="flex items-center gap-2 text-sm text-slate-500"><input type="checkbox" name="doc" value="${id}" class="rounded border-slate-300 text-amber-500 focus:ring-amber-300" checked><span class="truncate">${t('memory.projects.file_missing')}</span></label>`),
  ];
  const body = html`
    <div><label class="field-label" for="pjName">${label('memory.projects.name')}</label><input id="pjName" name="name" type="text" class="field" maxlength="${PROJECT_LIMITS.nameChars}" required value="${project?.name ?? ''}" autocomplete="off"></div>
    <div><label class="field-label" for="pjInstructions">${label('memory.projects.instructions')}</label><textarea id="pjInstructions" name="instructions" rows="4" class="field" maxlength="${PROJECT_LIMITS.instructionChars}" placeholder="${t('memory.projects.instructions_placeholder')}">${project?.instructions ?? ''}</textarea>${label('memory.projects.instructions_hint', { tag: 'p', className: 'text-[11px] text-slate-500 mt-1' })}</div>
    <div><label class="field-label" for="pjModel">${label('memory.projects.model')}</label><select id="pjModel" name="model" class="field">${modelOptions(project?.defaultModel ?? null, deps.currentModel, deps.modelName)}</select>${label('memory.projects.model_hint', { tag: 'p', className: 'text-[11px] text-slate-500 mt-1' })}</div>
    <fieldset class="space-y-1.5"><legend class="field-label">${label('memory.projects.files')}</legend>${fileRows.length ? html`<div class="max-h-40 overflow-y-auto custom-scrollbar space-y-1 pr-1">${fileRows}</div>` : label('memory.projects.files_none', { tag: 'p', className: 'text-xs text-slate-500' })}${label('memory.projects.files_hint', { tag: 'p', className: 'text-[11px] text-slate-500' })}</fieldset>
    <fieldset class="space-y-1.5"><legend class="field-label">${label('memory.projects.memory')}</legend>${MEMORY_SCOPES.map((s) => html`<label class="flex items-start gap-2 text-sm text-slate-800"><input type="radio" name="memoryScope" value="${s}" class="mt-0.5 border-slate-300 text-amber-500 focus:ring-amber-300"${s === scope ? raw(' checked') : ''}><span>${label(`memory.projects.memory_${s}`)}</span></label>`)}</fieldset>`;
  openFormDialog({
    id: 'projectDialog',
    title: project ? 'memory.projects.edit' : 'memory.projects.new',
    icon: project ? 'folder-open' : 'folder-plus',
    body,
    submit: project ? 'memory.save' : 'memory.projects.create',
    ...(project ? { danger: 'memory.projects.delete' } : {}),
    initialFocus: '#pjName',
    async onSubmit(form) {
      const data = new FormData(form);
      /** @type {Partial<ProjectRecord>} */
      const input = {
        name: String(data.get('name') ?? ''),
        instructions: String(data.get('instructions') ?? ''),
        defaultModel: cleanModel(data.get('model')),
        docIds: data.getAll('doc').map(String),
        memoryScope: /** @type {MemoryScope} */ (String(data.get('memoryScope') ?? 'global')),
      };
      try {
        if (project) {
          await deps.projects.update(project.id, input);
          deps.toast('memory.projects.saved', { tone: 'ok' });
        } else {
          const created = await deps.projects.create(input);
          deps.toast({ key: 'memory.projects.created', params: { name: created.name } }, { tone: 'ok' });
          deps.created?.(created);
        }
        return true;
      } catch (err) {
        const code = err instanceof ProjectError ? err.code : 'store';
        showFormError(form, `memory.projects.error_${code}`);
        return false;
      }
    },
    async onDanger() {
      if (!project) return true;
      const chats = (await (await deps.chats()).listConversations({ includeArchived: true })).filter((c) => c.projectId === project.id).length;
      if (!confirmBox(t('memory.projects.delete_confirm', { name: project.name, n: chats }))) return false;
      await removeProject(project.id, { projects: deps.projects, chats: await deps.chats(), removeNotes: deps.removeNotes });
      deps.toast({ key: 'memory.projects.deleted', params: { name: project.name } }, { tone: 'ok' });
      return true;
    },
  });
}
