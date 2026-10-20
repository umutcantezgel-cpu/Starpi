// @ts-check
// Assistants: saved presets for a chat ({ name, icon, instructions, model, tools, starters }).
//
// - Starting a chat with an assistant sets the model picker to its model (when it has one), its
//   tools (the Web and Thinking switches, and switches on the chat's built-in tools it names) and
//   shows its conversation starters; its instructions go into the free chat's system prompt of that
//   chat (the conversation keeps the assistantId).
// - Assistants run no code: the only tools they may switch on are those in ASSISTANT_TOOLS, and an
//   import drops every other tool it names (and reports them). An import does not switch on the
//   tools that read the user's files or cost money (ASSISTANT_TOOLS_ASKED); the user may tick them
//   in the editor. Tools of MCP servers are not assistant tools: each server's approvals decide.
// - Import and export as `starpi.assistant/v1`: one assistant per file, validated field by field,
//   every text cut to its limit. Unknown fields are ignored.
//
// The sidebar section lists them (click: a new chat with it; the pencil: the editor, with Export
// and Delete); the editor dialog edits one. Texts are i18n keys of the memory namespace.
import { onLocaleChange, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { storeProfileName } from '../store/schema.js';
import { html, icon, label, raw } from '../ui/kit.js';
import { cleanModel, modelOptions, multiLine, oneLine, recordStoreBase } from './projects.js';

/** @typedef {import('../store/idb.js').StoreDb} StoreDb */
/** @typedef {import('../store/schema.js').AssistantRecord} AssistantRecord */
/** @typedef {Pick<AssistantRecord, 'name' | 'icon' | 'instructions' | 'model' | 'tools' | 'starters'>} AssistantFields */

export const ASSISTANT_SCHEMA = 'starpi.assistant/v1';
export const ASSISTANT_LIMITS = Object.freeze({
  assistants: 100,
  nameChars: 60,
  instructionChars: 8000,
  starters: 4,
  starterChars: 200,
  /** Bytes of an import file. */
  fileBytes: 64 * 1024,
});
/**
 * Tools an assistant may switch on: the model's own web search and extended thinking, and the chat's
 * built-in tools (chat/tools.js: date and time, calculator, searching the files on this device,
 * the saved notes, web search through the search service, images). None of them runs code.
 */
export const ASSISTANT_TOOLS = Object.freeze(['web', 'thinking', 'datetime', 'calculator', 'workspace_search', 'memory_lookup', 'web_search', 'generate_image']);
/** Tools an imported assistant does not bring along (they let a model read the user's files or cost money). */
export const ASSISTANT_TOOLS_ASKED = Object.freeze(['workspace_search', 'generate_image']);
/** Icons an assistant may show (registered in icons.js). */
export const ASSISTANT_ICONS = Object.freeze(['bot', 'sparkles', 'brain', 'graduation-cap', 'pen-line', 'code', 'languages', 'lightbulb', 'briefcase', 'palette', 'compass', 'book-open']);

/**
 * json: not JSON; schema: not a `starpi.assistant/v1` file; invalid: no assistant object in it;
 * fields: no name or no instructions; too_large: the file is too large; full: the most assistants
 * there may be; not_found: no such assistant.
 * @typedef {'json' | 'schema' | 'invalid' | 'fields' | 'too_large' | 'full' | 'not_found'} AssistantErrorCode
 */

export class AssistantError extends Error {
  /** @param {AssistantErrorCode} code */
  constructor(code) {
    super(code);
    this.name = 'AssistantError';
    /** @type {AssistantErrorCode} */
    this.code = code;
  }
}

/**
 * The fields of an assistant as kept, from any input; the tools it named that an assistant may not
 * use (or, for an import, may not bring along) are reported in `dropped`.
 * @param {Record<string, unknown>} input
 * @param {{ imported?: boolean }} [opts]
 * @returns {{ fields: AssistantFields, dropped: string[] }}
 */
export function assistantFields(input, opts = {}) {
  const name = oneLine(input.name, ASSISTANT_LIMITS.nameChars);
  const instructions = multiLine(input.instructions, ASSISTANT_LIMITS.instructionChars);
  if (!name || !instructions) throw new AssistantError('fields');
  const iconName = typeof input.icon === 'string' && ASSISTANT_ICONS.includes(input.icon) ? input.icon : 'bot';
  const named = Array.isArray(input.tools) ? input.tools.map((x) => oneLine(x, 60)).filter(Boolean) : [];
  const allowed = opts.imported ? ASSISTANT_TOOLS.filter((x) => !ASSISTANT_TOOLS_ASKED.includes(x)) : ASSISTANT_TOOLS;
  const tools = allowed.filter((x) => named.includes(x));
  const dropped = [...new Set(named.filter((x) => !allowed.includes(x)))];
  /** @type {string[]} */
  const starters = [];
  for (const s of Array.isArray(input.starters) ? input.starters : []) {
    const text = oneLine(s, ASSISTANT_LIMITS.starterChars);
    if (text && !starters.includes(text)) starters.push(text);
    if (starters.length >= ASSISTANT_LIMITS.starters) break;
  }
  return { fields: { name, icon: iconName, instructions, model: cleanModel(input.model), tools, starters }, dropped };
}

/**
 * An assistant as a `starpi.assistant/v1` document.
 * @param {AssistantFields} assistant
 * @param {{ exportedAt: string, version: string }} meta
 */
export function exportAssistant(assistant, meta) {
  return {
    schema: ASSISTANT_SCHEMA,
    generator: { name: 'starpi', version: meta.version },
    exportedAt: meta.exportedAt,
    assistant: {
      name: assistant.name,
      icon: assistant.icon,
      instructions: assistant.instructions,
      model: assistant.model,
      tools: [...assistant.tools],
      starters: [...assistant.starters],
    },
  };
}

/**
 * Reads a `starpi.assistant/v1` file.
 * @param {string} text
 * @returns {{ fields: AssistantFields, dropped: string[] }}
 */
export function parseAssistant(text) {
  if (new TextEncoder().encode(String(text)).length > ASSISTANT_LIMITS.fileBytes) throw new AssistantError('too_large');
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch {
    throw new AssistantError('json');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new AssistantError('schema');
  const d = /** @type {Record<string, unknown>} */ (doc);
  if (d.schema !== ASSISTANT_SCHEMA) throw new AssistantError('schema');
  const a = d.assistant;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new AssistantError('invalid');
  return assistantFields(/** @type {Record<string, unknown>} */ (a), { imported: true });
}

/** A file name for an exported assistant. @param {string} name */
export function assistantFileName(name) {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'assistant';
  return `${base}.assistant.json`;
}

/**
 * @param {unknown} value
 * @returns {value is AssistantRecord}
 */
function isAssistant(value) {
  const r = /** @type {Record<string, unknown> | null} */ (value && typeof value === 'object' ? value : null);
  return Boolean(r && typeof r.id === 'string' && typeof r.name === 'string');
}

/**
 * A stored record with every field in shape.
 * @param {AssistantRecord} r
 * @returns {AssistantRecord}
 */
function complete(r) {
  let fields;
  try {
    ({ fields } = assistantFields(/** @type {any} */ (r)));
  } catch {
    fields = { name: oneLine(r.name, ASSISTANT_LIMITS.nameChars) || '—', icon: 'bot', instructions: '', model: null, tools: [], starters: [] };
  }
  return { id: r.id, ...fields, createdAt: Number(r.createdAt) || 0, updatedAt: Number(r.updatedAt) || 0 };
}

/**
 * Builds an assistant store.
 * @param {import('./projects.js').RecordStoreOptions & { now?: () => number, uuid?: () => string }} [options]
 */
export function createAssistantStore(options = {}) {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const { serial, emit, onChange, close } = recordStoreBase(options, 'assistant');
  /** @param {StoreDb} db @returns {Promise<AssistantRecord[]>} */
  const all = async (db) => (await db.getAll('assistants')).filter(isAssistant).map(complete);

  const store = {
    /**
     * Every assistant, by name.
     * @returns {Promise<AssistantRecord[]>}
     */
    list() {
      return serial(async (db) => (await all(db)).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)));
    },

    /**
     * @param {string} id
     * @returns {Promise<AssistantRecord | null>}
     */
    get(id) {
      return serial(async (db) => {
        const r = await db.get('assistants', id);
        return isAssistant(r) ? complete(r) : null;
      });
    },

    /**
     * @param {Record<string, unknown>} input
     * @returns {Promise<AssistantRecord>}
     */
    create(input) {
      return serial(async (db) => {
        const { fields } = assistantFields(input);
        if ((await db.count('assistants')) >= ASSISTANT_LIMITS.assistants) throw new AssistantError('full');
        const at = now();
        /** @type {AssistantRecord} */
        const record = { id: `assistant_${uuid()}`, ...fields, createdAt: at, updatedAt: at };
        await db.add('assistants', record);
        emit();
        return record;
      });
    },

    /**
     * @param {string} id
     * @param {Record<string, unknown>} patch
     * @returns {Promise<AssistantRecord>}
     */
    update(id, patch) {
      return serial(async (db) => {
        const found = await db.get('assistants', id);
        if (!isAssistant(found)) throw new AssistantError('not_found');
        const base = complete(found);
        const { fields } = assistantFields({ ...base, ...patch });
        /** @type {AssistantRecord} */
        const record = { ...base, ...fields, updatedAt: now() };
        await db.put('assistants', record);
        emit();
        return record;
      });
    },

    /**
     * Imports a `starpi.assistant/v1` file as a new assistant.
     * @param {string} text
     * @returns {Promise<{ assistant: AssistantRecord, dropped: string[] }>}
     */
    async importText(text) {
      const { fields, dropped } = parseAssistant(text);
      return { assistant: await store.create(fields), dropped };
    },

    /**
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    remove(id) {
      return serial(async (db) => {
        const found = await db.get('assistants', id);
        if (!found) return false;
        await db.delete('assistants', id);
        emit();
        return true;
      });
    },

    onChange,
    close,
  };
  return store;
}

/** @typedef {ReturnType<typeof createAssistantStore>} AssistantStore */

/** @type {AssistantStore | null} */
let shared = null;

/** The page's assistant store on the app database. */
export function assistantStore() {
  shared ??= createAssistantStore({ channel: `${storeProfileName()}-assistants` });
  return shared;
}

// ---------------------------------------------------------------------------------------------
// The sidebar section

/**
 * @typedef {object} AssistantsSectionDeps
 * @property {AssistantStore} assistants
 * @property {(assistant: AssistantRecord) => unknown} start  a new chat with the assistant
 * @property {(assistant: AssistantRecord | null) => unknown} edit  the editor (null: a new assistant)
 * @property {(file: File) => unknown} importFile
 */

/**
 * Renders the assistants section of the sidebar into `host` and keeps it current.
 * @param {HTMLElement} host
 * @param {AssistantsSectionDeps} deps
 * @returns {() => void} cleanup
 */
export function mountAssistantsSection(host, deps) {
  /** @type {AssistantRecord[]} */
  let assistants = [];
  let alive = true;
  /** @type {Array<() => void>} */
  const cleanups = [];
  const ghost = 'rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900';

  /** @param {AssistantRecord} a */
  const row = (a) =>
    html`<li class="group flex items-center gap-0.5" data-assistant-id="${a.id}">
      <button type="button" data-as="start" data-id="${a.id}" class="flex-1 min-w-0 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900" title="${t('memory.assistants.start_named', { name: a.name })}">${icon(a.icon, 'w-3.5 h-3.5 flex-shrink-0 text-amber-600')}<span class="truncate">${a.name}</span></button>
      <button type="button" data-as="edit" data-id="${a.id}" class="flex-shrink-0 ${ghost}" aria-label="${t('memory.assistants.edit_named', { name: a.name })}" title="${t('memory.assistants.edit_named', { name: a.name })}">${icon('pencil', 'w-3.5 h-3.5')}</button>
    </li>`;

  function render() {
    if (!alive) return;
    const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    const focus = active ? `${active.dataset.as ?? ''}:${active.dataset.id ?? ''}` : '';
    host.innerHTML = html`<section class="pt-1" aria-labelledby="sbAssistantsTitle">
      <div class="flex items-center justify-between gap-1 px-2">
        <h2 id="sbAssistantsTitle" class="text-[11px] font-semibold uppercase tracking-wide text-slate-500" data-i18n="memory.assistants.title">${t('memory.assistants.title')}</h2>
        <span class="flex items-center">
          <button type="button" data-as="import" class="${ghost}" aria-label="${t('memory.assistants.import')}" data-i18n-aria="memory.assistants.import" title="${t('memory.assistants.import')}" data-i18n-title="memory.assistants.import">${icon('upload', 'w-3.5 h-3.5')}</button>
          <button type="button" data-as="new" class="${ghost}" aria-label="${t('memory.assistants.new')}" data-i18n-aria="memory.assistants.new" title="${t('memory.assistants.new')}" data-i18n-title="memory.assistants.new">${icon('plus', 'w-3.5 h-3.5')}</button>
        </span>
        <input type="file" accept=".json,application/json" class="hidden" data-as-file tabindex="-1" aria-hidden="true">
      </div>
      ${assistants.length ? html`<ul class="mt-1 space-y-0.5">${assistants.map(row)}</ul>` : label('memory.assistants.empty', { tag: 'p', className: 'px-2 pb-1 text-[11px] text-slate-500 leading-snug' })}
    </section>`.value;
    refreshIcons(host);
    if (focus) {
      const match = [...host.querySelectorAll('[data-as]')].find((el) => el instanceof HTMLElement && `${el.dataset.as ?? ''}:${el.dataset.id ?? ''}` === focus);
      if (match instanceof HTMLElement) match.focus();
    }
  }

  async function reload() {
    try {
      assistants = await deps.assistants.list();
    } catch (err) {
      console.warn('[starpi] the assistants could not be loaded', err);
    }
    render();
  }

  host.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-as]') : null;
    if (!(target instanceof HTMLElement)) return;
    const found = assistants.find((a) => a.id === target.dataset.id) ?? null;
    const what = target.dataset.as;
    if (what === 'new') void deps.edit(null);
    else if (what === 'import') /** @type {HTMLInputElement | null} */ (host.querySelector('[data-as-file]'))?.click();
    else if (what === 'start' && found) void deps.start(found);
    else if (what === 'edit' && found) void deps.edit(found);
  });
  host.addEventListener('change', (event) => {
    const input = event.target instanceof HTMLInputElement && event.target.matches('[data-as-file]') ? event.target : null;
    const file = input?.files?.[0];
    if (!input || !file) return;
    input.value = '';
    void deps.importFile(file);
  });

  cleanups.push(deps.assistants.onChange(() => void reload()));
  cleanups.push(onLocaleChange(() => render()));
  render();
  void reload();
  return () => {
    alive = false;
    for (const fn of cleanups.splice(0)) fn();
  };
}

// ---------------------------------------------------------------------------------------------
// The editor

/**
 * @typedef {object} AssistantEditorDeps
 * @property {AssistantStore} assistants
 * @property {() => string} currentModel  the model picker's value
 * @property {(value: string) => string} modelName
 * @property {(assistant: AssistantFields) => unknown} exportFile  downloads it
 * @property {(message: string) => boolean} [confirm]
 * @property {typeof import('../ui/kit.js').toast} toast
 */

/**
 * Opens the assistant editor: a new assistant (null) or an existing one, with Export and Delete.
 * @param {AssistantRecord | null} assistant
 * @param {AssistantEditorDeps} deps
 */
export async function openAssistantEditor(assistant, deps) {
  const { openFormDialog, showFormError } = await import('./form-dialog.js');
  const confirmBox = deps.confirm ?? ((message) => window.confirm(message));
  const chosenIcon = assistant?.icon ?? 'bot';
  const starters = [...(assistant?.starters ?? [])];
  while (starters.length < ASSISTANT_LIMITS.starters) starters.push('');
  const body = html`
    <div><label class="field-label" for="asName">${label('memory.assistants.name')}</label><input id="asName" name="name" type="text" class="field" maxlength="${ASSISTANT_LIMITS.nameChars}" required value="${assistant?.name ?? ''}" autocomplete="off"></div>
    <fieldset><legend class="field-label">${label('memory.assistants.icon')}</legend><div class="flex flex-wrap gap-1.5">${ASSISTANT_ICONS.map(
      (name) =>
        html`<label class="cursor-pointer"><input type="radio" name="icon" value="${name}" class="peer sr-only"${name === chosenIcon ? raw(' checked') : ''}><span class="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 peer-checked:border-amber-400 peer-checked:bg-amber-50 peer-checked:text-amber-700 peer-focus-visible:ring-2 peer-focus-visible:ring-slate-900">${icon(name, 'w-4 h-4')}<span class="sr-only">${name}</span></span></label>`,
    )}</div></fieldset>
    <div><label class="field-label" for="asInstructions">${label('memory.assistants.instructions')}</label><textarea id="asInstructions" name="instructions" rows="6" class="field" maxlength="${ASSISTANT_LIMITS.instructionChars}" required placeholder="${t('memory.assistants.instructions_placeholder')}">${assistant?.instructions ?? ''}</textarea></div>
    <div><label class="field-label" for="asModel">${label('memory.assistants.model')}</label><select id="asModel" name="model" class="field">${modelOptions(assistant?.model ?? null, deps.currentModel, deps.modelName)}</select></div>
    <fieldset class="space-y-1.5"><legend class="field-label">${label('memory.assistants.tools')}</legend>${ASSISTANT_TOOLS.map((tool) => html`<label class="flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" name="tool" value="${tool}" class="rounded border-slate-300 text-amber-500 focus:ring-amber-300"${assistant?.tools.includes(tool) ? raw(' checked') : ''}>${label(`memory.assistants.tool_${tool}`)}</label>`)}${label('memory.assistants.tools_hint', { tag: 'p', className: 'text-[11px] text-slate-500' })}</fieldset>
    <fieldset class="space-y-1.5"><legend class="field-label">${label('memory.assistants.starters')}</legend>${starters.map((s, i) => html`<input type="text" name="starter" class="field" maxlength="${ASSISTANT_LIMITS.starterChars}" value="${s}" aria-label="${t('memory.assistants.starter_n', { n: i + 1 })}" placeholder="${t('memory.assistants.starter_placeholder')}">`)}</fieldset>
    ${assistant ? html`<div class="pt-1"><button type="button" data-fd-export class="btn btn-secondary py-1">${icon('download', 'w-3.5 h-3.5')}${label('memory.assistants.export')}</button></div>` : ''}`;
  openFormDialog({
    id: 'assistantDialog',
    title: assistant ? 'memory.assistants.edit' : 'memory.assistants.new',
    icon: 'bot',
    body,
    size: 'lg',
    submit: assistant ? 'memory.save' : 'memory.assistants.create',
    ...(assistant ? { danger: 'memory.assistants.delete' } : {}),
    initialFocus: '#asName',
    onOpen(form) {
      form.querySelector('[data-fd-export]')?.addEventListener('click', () => {
        if (assistant) deps.exportFile(assistant);
      });
    },
    async onSubmit(form) {
      const data = new FormData(form);
      const input = {
        name: String(data.get('name') ?? ''),
        icon: String(data.get('icon') ?? 'bot'),
        instructions: String(data.get('instructions') ?? ''),
        model: cleanModel(data.get('model')),
        tools: data.getAll('tool').map(String),
        starters: data.getAll('starter').map(String),
      };
      try {
        if (assistant) await deps.assistants.update(assistant.id, input);
        else await deps.assistants.create(input);
        deps.toast(assistant ? 'memory.assistants.saved' : { key: 'memory.assistants.created', params: { name: oneLine(input.name, ASSISTANT_LIMITS.nameChars) } }, { tone: 'ok' });
        return true;
      } catch (err) {
        showFormError(form, `memory.assistants.error_${err instanceof AssistantError ? err.code : 'store'}`);
        return false;
      }
    },
    async onDanger() {
      if (!assistant) return true;
      if (!confirmBox(t('memory.assistants.delete_confirm', { name: assistant.name }))) return false;
      await deps.assistants.remove(assistant.id);
      deps.toast({ key: 'memory.assistants.deleted', params: { name: assistant.name } }, { tone: 'ok' });
      return true;
    },
  });
}
