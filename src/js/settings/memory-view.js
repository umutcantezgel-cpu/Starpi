// @ts-check
// Settings -> Memory and personalization: one card with
// - the custom instructions "About me" and "How to answer" (they go into the free chat's system
//   prompt of every chat);
// - memory: off until switched on, suggestions after answers (a second switch), whether the notes
//   are encrypted (the vault of Settings -> Providers), adding a note, the notes with their scope
//   (global or a project) to edit and delete, export as `starpi.memory/v1` and "Delete all".
// Notes sealed under a passphrase that is gone are counted, and can be deleted. Every text is an
// i18n key; notes and project names are the user's own text.
import { downloadText } from '../dom.js';
import { formatNumber, onLocaleChange, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { html, icon, label, raw } from '../ui/kit.js';
import { MEMORY_LIMITS, MemoryError } from '../ai/memory.js';
import { APP_VERSION } from '../config.js';

/** @typedef {import('../ai/memory.js').MemoryStore} MemoryStore */
/** @typedef {import('../ai/memory.js').Fact} Fact */
/** @typedef {import('../ai/memory.js').MemoryPrefs} MemoryPrefs */
/** @typedef {'none' | 'locked' | 'unlocked' | 'unavailable'} VaultState */

/**
 * @typedef {object} MemoryViewServices
 * @property {typeof import('../ui/kit.js').toast} toast
 */

/**
 * @typedef {object} MemoryViewDeps
 * @property {MemoryStore} [store]
 * @property {() => Promise<Array<{ id: string, name: string }>>} [projects]
 * @property {(fn: () => void) => unknown} [onProjectsChange]
 * @property {{ state: () => VaultState, onChange: (fn: () => void) => unknown }} [vault]
 * @property {(name: string, text: string, type: string) => void} [download]
 * @property {(message: string) => boolean} [confirm]
 * @property {() => number} [now]
 * @property {string} [version]
 */

/** i18n key and tone of each vault state, for the encryption line. */
const VAULT_LINE = Object.freeze({
  none: { key: 'memory.settings.vault_none', icon: 'lock', tone: 'text-slate-600' },
  unlocked: { key: 'memory.settings.vault_unlocked', icon: 'shield-check', tone: 'text-emerald-700' },
  locked: { key: 'memory.settings.vault_locked', icon: 'lock', tone: 'text-amber-800' },
  unavailable: { key: 'memory.settings.vault_unavailable', icon: 'triangle-alert', tone: 'text-amber-800' },
});

/**
 * The page's defaults for the view's dependencies (loaded on demand).
 * @returns {Promise<Required<Pick<MemoryViewDeps, 'store' | 'projects' | 'onProjectsChange' | 'vault'>>>}
 */
async function pageDeps() {
  const [{ memoryStore }, { projectStore }, keys] = await Promise.all([import('../ai/memory.js'), import('../chat/projects.js'), import('../ai/keys.js')]);
  return {
    store: memoryStore(),
    projects: () => projectStore().list(),
    onProjectsChange: (fn) => projectStore().onChange(fn),
    vault: {
      state: () => keys.vaultState(),
      onChange: (fn) =>
        keys.onKeysChange((change) => {
          if (change.type === 'vault') fn();
        }),
    },
  };
}

/**
 * Builds the card into `el` and keeps it current.
 * @param {HTMLElement} el
 * @param {MemoryViewServices} services
 * @param {MemoryViewDeps} [given]
 * @returns {Promise<{ refresh: () => Promise<void> }>}
 */
export async function mountMemoryView(el, services, given = {}) {
  const deps = { ...(given.store && given.projects && given.vault ? {} : await pageDeps()), ...given };
  const store = /** @type {MemoryStore} */ (deps.store);
  const download = deps.download ?? downloadText;
  const confirmBox = deps.confirm ?? ((message) => window.confirm(message));
  const now = deps.now ?? Date.now;
  const vault = deps.vault ?? { state: () => /** @type {VaultState} */ ('none'), onChange: () => {} };

  /** @type {{ prefs: MemoryPrefs, facts: Fact[], locked: number, projects: Array<{ id: string, name: string }>, editing: string | null, instructions: { aboutMe: string, howToAnswer: string } }} */
  const state = { prefs: { enabled: false, suggest: false }, facts: [], locked: 0, projects: [], editing: null, instructions: { aboutMe: '', howToAnswer: '' } };

  /** @param {string} selector */
  const part = (selector) => /** @type {HTMLElement | null} */ (el.querySelector(selector));

  /** @param {string} scope */
  const scopeName = (scope) => {
    if (scope === 'global') return t('memory.scope_global');
    const project = state.projects.find((p) => p.id === scope);
    return project ? t('memory.scope_project', { name: project.name }) : t('memory.scope_gone');
  };

  /** @param {string} chosen */
  const scopeOptions = (chosen) =>
    html`<option value="global"${chosen === 'global' ? raw(' selected') : ''}>${t('memory.scope_global')}</option>${state.projects.map((p) => html`<option value="${p.id}"${chosen === p.id ? raw(' selected') : ''}>${t('memory.scope_project', { name: p.name })}</option>`)}`;

  /** @param {Fact} f */
  function factRow(f) {
    if (state.editing === f.id) {
      return html`<li class="rounded-lg border border-amber-300 bg-amber-50/40 p-2 space-y-2" data-fact="${f.id}">
        <label class="sr-only" for="mvEdit">${label('memory.settings.edit_label')}</label>
        <textarea id="mvEdit" rows="2" class="field" maxlength="${MEMORY_LIMITS.factChars}" data-mv-edit-text>${f.text}</textarea>
        <div class="flex flex-wrap items-center gap-2"><label class="sr-only" for="mvEditScope">${label('memory.settings.scope_label')}</label><select id="mvEditScope" class="field w-auto py-1" data-mv-edit-scope>${scopeOptions(f.scope)}</select><span class="flex-1"></span>
          <button type="button" class="btn btn-ghost py-1" data-mv="edit-cancel">${label('app.cancel')}</button>
          <button type="button" class="btn btn-primary py-1" data-mv="edit-save" data-id="${f.id}">${icon('check', 'w-3.5 h-3.5')}${label('memory.save')}</button></div>
      </li>`;
    }
    return html`<li class="flex items-start gap-2 rounded-lg border border-slate-200 p-2" data-fact="${f.id}">
      <div class="flex-1 min-w-0 space-y-1"><p class="text-sm text-slate-800 break-words">${f.text}</p>
        <p class="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500"><span class="chip chip-neutral">${icon(f.scope === 'global' ? 'globe' : 'folder', '')}<span>${scopeName(f.scope)}</span></span>${f.source === 'suggested' ? html`<span class="chip chip-info">${icon('sparkles', '')}${label('memory.settings.suggested')}</span>` : ''}${f.sealed ? html`<span class="chip chip-ok">${icon('lock', '')}${label('memory.settings.sealed')}</span>` : ''}</p></div>
      <button type="button" class="btn btn-ghost p-1.5" data-mv="edit" data-id="${f.id}" aria-label="${t('memory.settings.edit')}" title="${t('memory.settings.edit')}">${icon('pencil', 'w-3.5 h-3.5')}</button>
      <button type="button" class="btn btn-ghost p-1.5 text-rose-700" data-mv="delete" data-id="${f.id}" aria-label="${t('memory.settings.delete')}" title="${t('memory.settings.delete')}">${icon('trash-2', 'w-3.5 h-3.5')}</button>
    </li>`;
  }

  function vaultLine() {
    const v = VAULT_LINE[vault.state()] ?? VAULT_LINE.none;
    return html`<p class="flex items-start gap-1.5 text-xs ${v.tone}" data-mv-vault="${vault.state()}">${icon(v.icon, 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(v.key)}</p>`;
  }

  function notesPart() {
    const locked = vault.state() === 'locked';
    const gone = state.locked > 0 && !locked;
    return html`
      ${vaultLine()}
      ${
        locked
          ? ''
          : html`<form class="flex flex-wrap gap-2" data-mv-add>
          <label class="sr-only" for="mvAddText">${label('memory.settings.add_label')}</label>
          <input id="mvAddText" type="text" class="field flex-1 min-w-[12rem]" maxlength="${MEMORY_LIMITS.factChars}" autocomplete="off" placeholder="${t('memory.settings.add_placeholder')}" data-i18n-placeholder="memory.settings.add_placeholder">
          <label class="sr-only" for="mvAddScope">${label('memory.settings.scope_label')}</label>
          <select id="mvAddScope" class="field w-auto">${scopeOptions('global')}</select>
          <button type="submit" class="btn btn-secondary">${icon('plus', 'w-3.5 h-3.5')}${label('memory.settings.add')}</button>
        </form>`
      }
      ${gone ? html`<p class="flex flex-wrap items-center gap-2 text-xs text-amber-800">${icon('triangle-alert', 'w-3.5 h-3.5')}${label({ key: 'memory.settings.unreadable', params: { n: state.locked } })}<button type="button" class="btn btn-ghost py-1 text-rose-700" data-mv="drop-unreadable">${label('memory.settings.unreadable_delete')}</button></p>` : ''}
      <div class="flex items-center justify-between gap-2"><h5 class="text-xs font-semibold text-slate-700" data-mv-count>${t('memory.settings.count', { n: state.facts.length, max: formatNumber(MEMORY_LIMITS.facts) })}</h5></div>
      ${state.facts.length ? html`<ul class="space-y-1.5 max-h-96 overflow-y-auto custom-scrollbar pr-1" data-mv-list>${state.facts.map(factRow)}</ul>` : label(locked && state.locked ? 'memory.settings.list_locked' : 'memory.settings.list_empty', { tag: 'p', className: 'text-xs text-slate-500' })}
      <div class="flex flex-wrap gap-2 pt-1">
        <button type="button" class="btn btn-secondary py-1" data-mv="export"${state.facts.length ? '' : raw(' disabled')}>${icon('download', 'w-3.5 h-3.5')}${label('memory.settings.export')}</button>
        <button type="button" class="btn btn-ghost py-1 text-rose-700" data-mv="clear"${state.facts.length || state.locked ? '' : raw(' disabled')}>${icon('trash-2', 'w-3.5 h-3.5')}${label('memory.settings.clear')}</button>
      </div>`;
  }

  function render() {
    const s = state.prefs;
    el.innerHTML = html`<div class="card p-4 sm:p-5 space-y-4" data-memory-settings>
      <div class="card-header"><h3 class="card-title">${icon('brain', 'w-4 h-4 text-amber-600')}${label('memory.settings.title')}</h3></div>
      ${label('memory.settings.subtitle', { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed -mt-2' })}

      <section class="space-y-2" aria-labelledby="mvInstrTitle">
        ${label('memory.settings.instructions_title', { tag: 'h4', className: 'text-sm font-semibold text-slate-800', id: 'mvInstrTitle' })}
        <div><label class="field-label" for="mvAboutMe">${label('memory.settings.about_me')}</label><textarea id="mvAboutMe" rows="3" class="field" maxlength="${MEMORY_LIMITS.instructionChars}" placeholder="${t('memory.settings.about_me_placeholder')}" data-i18n-placeholder="memory.settings.about_me_placeholder">${state.instructions.aboutMe}</textarea></div>
        <div><label class="field-label" for="mvHowToAnswer">${label('memory.settings.how_to_answer')}</label><textarea id="mvHowToAnswer" rows="3" class="field" maxlength="${MEMORY_LIMITS.instructionChars}" placeholder="${t('memory.settings.how_to_answer_placeholder')}" data-i18n-placeholder="memory.settings.how_to_answer_placeholder">${state.instructions.howToAnswer}</textarea></div>
        <div class="flex flex-wrap items-center gap-2"><button type="button" class="btn btn-secondary" data-mv="save-instructions">${icon('check', 'w-3.5 h-3.5')}${label('memory.settings.save_instructions')}</button>${label('memory.settings.instructions_hint', { tag: 'p', className: 'flex-1 min-w-[12rem] text-[11px] text-slate-500' })}</div>
      </section>

      <section class="space-y-3 pt-3 border-t border-slate-100" aria-labelledby="mvMemTitle">
        ${label('memory.settings.memory_title', { tag: 'h4', className: 'text-sm font-semibold text-slate-800', id: 'mvMemTitle' })}
        <label class="flex items-start gap-2 text-sm text-slate-800 cursor-pointer select-none"><input type="checkbox" id="mvEnabled" class="mt-0.5 rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-mv-toggle="enabled"${s.enabled ? raw(' checked') : ''}><span>${label('memory.settings.enabled')}${label('memory.settings.enabled_hint', { tag: 'p', className: 'text-[11px] text-slate-500 mt-0.5' })}</span></label>
        <label class="flex items-start gap-2 text-sm text-slate-800 cursor-pointer select-none${s.enabled ? '' : ' opacity-60'}"><input type="checkbox" id="mvSuggest" class="mt-0.5 rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-mv-toggle="suggest"${s.suggest ? raw(' checked') : ''}${s.enabled ? '' : raw(' disabled')}><span>${label('memory.settings.suggest')}${label('memory.settings.suggest_hint', { tag: 'p', className: 'text-[11px] text-slate-500 mt-0.5' })}</span></label>
        <div class="space-y-2" data-mv-notes>${notesPart()}</div>
      </section>
      <p class="sr-only" role="status" aria-live="polite" data-mv-status></p>
    </div>`.value;
    refreshIcons(el);
  }

  /** Redraws the notes part only (the instruction fields keep what is being typed). */
  function renderNotes() {
    const box = part('[data-mv-notes]');
    if (!box) return render();
    const active = document.activeElement instanceof HTMLElement && box.contains(document.activeElement) ? document.activeElement : null;
    const key = active ? `${active.dataset.mv ?? active.id}:${active.dataset.id ?? ''}` : '';
    box.innerHTML = notesPart().value;
    refreshIcons(box);
    if (state.editing) /** @type {HTMLTextAreaElement | null} */ (box.querySelector('[data-mv-edit-text]'))?.focus();
    else if (key) {
      const match = [...box.querySelectorAll('button, input, select')].find((x) => x instanceof HTMLElement && `${x.dataset.mv ?? x.id}:${x.dataset.id ?? ''}` === key);
      if (match instanceof HTMLElement) match.focus();
    }
  }

  /** @param {string} text */
  const announce = (text) => {
    const box = part('[data-mv-status]');
    if (box) box.textContent = text;
  };

  async function loadNotes() {
    try {
      const [{ facts, locked }, projects] = await Promise.all([store.list(), deps.projects ? deps.projects().catch(() => []) : []]);
      state.facts = facts;
      state.locked = locked;
      state.projects = projects;
    } catch (err) {
      console.warn('[starpi] the saved notes could not be read', err);
    }
  }

  async function refresh() {
    try {
      const [prefs, instructions] = await Promise.all([store.prefs(), store.instructions()]);
      state.prefs = prefs;
      state.instructions = instructions;
    } catch (err) {
      console.warn('[starpi] the memory settings could not be read', err);
    }
    await loadNotes();
    render();
  }

  /** @param {unknown} err */
  const failed = (err) => {
    const code = err instanceof MemoryError ? err.code : 'store';
    services.toast(`memory.error_${code}`, { tone: 'warn' });
  };

  el.addEventListener('change', async (event) => {
    const target = event.target instanceof HTMLInputElement ? event.target : null;
    const which = target?.dataset.mvToggle;
    if (!target || !which) return;
    try {
      state.prefs = await store.setPrefs(which === 'enabled' ? { enabled: target.checked, ...(target.checked ? {} : { suggest: false }) } : { suggest: target.checked });
      services.toast(which === 'enabled' ? (state.prefs.enabled ? 'memory.settings.enabled_on' : 'memory.settings.enabled_off') : state.prefs.suggest ? 'memory.settings.suggest_on' : 'memory.settings.suggest_off', { tone: 'ok' });
    } catch (err) {
      failed(err);
    }
    const instructions = { aboutMe: /** @type {HTMLTextAreaElement | null} */ (part('#mvAboutMe'))?.value ?? '', howToAnswer: /** @type {HTMLTextAreaElement | null} */ (part('#mvHowToAnswer'))?.value ?? '' };
    render();
    // Unsaved instructions stay in their fields.
    /** @type {HTMLTextAreaElement} */ (part('#mvAboutMe')).value = instructions.aboutMe;
    /** @type {HTMLTextAreaElement} */ (part('#mvHowToAnswer')).value = instructions.howToAnswer;
    part(which === 'enabled' ? '#mvEnabled' : '#mvSuggest')?.focus();
  });

  el.addEventListener('submit', async (event) => {
    const form = event.target instanceof HTMLFormElement && event.target.matches('[data-mv-add]') ? event.target : null;
    if (!form) return;
    event.preventDefault();
    const input = /** @type {HTMLInputElement} */ (form.querySelector('#mvAddText'));
    const scope = /** @type {HTMLSelectElement} */ (form.querySelector('#mvAddScope')).value;
    try {
      await store.add({ text: input.value, scope, source: 'explicit' });
      input.value = '';
      announce(t('memory.remember.saved'));
      await loadNotes();
      renderNotes();
      /** @type {HTMLInputElement | null} */ (part('#mvAddText'))?.focus();
    } catch (err) {
      failed(err);
    }
  });

  el.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-mv]') : null;
    if (!(button instanceof HTMLElement)) return;
    const id = button.dataset.id ?? '';
    try {
      switch (button.dataset.mv) {
        case 'save-instructions': {
          state.instructions = await store.setInstructions({
            aboutMe: /** @type {HTMLTextAreaElement} */ (part('#mvAboutMe')).value,
            howToAnswer: /** @type {HTMLTextAreaElement} */ (part('#mvHowToAnswer')).value,
          });
          services.toast('memory.settings.instructions_saved', { tone: 'ok' });
          break;
        }
        case 'edit':
          state.editing = id;
          renderNotes();
          break;
        case 'edit-cancel':
          state.editing = null;
          renderNotes();
          break;
        case 'edit-save': {
          const text = /** @type {HTMLTextAreaElement} */ (part('[data-mv-edit-text]')).value;
          const scope = /** @type {HTMLSelectElement} */ (part('[data-mv-edit-scope]')).value;
          await store.update(id, { text, scope });
          state.editing = null;
          announce(t('memory.settings.updated'));
          await loadNotes();
          renderNotes();
          break;
        }
        case 'delete':
          await store.remove(id);
          announce(t('memory.settings.deleted'));
          await loadNotes();
          renderNotes();
          break;
        case 'drop-unreadable':
          if (!confirmBox(t('memory.settings.unreadable_confirm', { n: state.locked }))) return;
          await store.removeUnreadable();
          await loadNotes();
          renderNotes();
          break;
        case 'clear':
          if (!confirmBox(t('memory.settings.clear_confirm'))) return;
          await store.clear();
          services.toast('memory.settings.cleared', { tone: 'ok' });
          await loadNotes();
          renderNotes();
          break;
        case 'export': {
          const names = new Map(state.projects.map((p) => [p.id, p.name]));
          const exportedAt = new Date(now()).toISOString();
          const doc = await store.exportDoc({ exportedAt, version: deps.version ?? APP_VERSION, projectName: (pid) => names.get(pid) ?? null });
          download(`starpi-memory-${exportedAt.slice(0, 10)}.json`, `${JSON.stringify(doc, null, 2)}\n`, 'application/json');
          break;
        }
        default:
      }
    } catch (err) {
      failed(err);
    }
  });

  let timer = 0;
  const later = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      // An edit in progress is not redrawn under the typing user.
      if (state.editing) return;
      try {
        state.prefs = await store.prefs();
      } catch {
        // keep the last known switches
      }
      await loadNotes();
      const box = part('[data-mv-notes]');
      const enabled = /** @type {HTMLInputElement | null} */ (part('#mvEnabled'));
      const suggest = /** @type {HTMLInputElement | null} */ (part('#mvSuggest'));
      if (enabled) enabled.checked = state.prefs.enabled;
      if (suggest) {
        suggest.checked = state.prefs.suggest;
        suggest.disabled = !state.prefs.enabled;
        suggest.closest('label')?.classList.toggle('opacity-60', !state.prefs.enabled);
      }
      if (box) renderNotes();
    }, 50);
  };
  store.onChange(later);
  deps.onProjectsChange?.(later);
  vault.onChange(later);
  onLocaleChange(() => {
    const instructions = { aboutMe: /** @type {HTMLTextAreaElement | null} */ (part('#mvAboutMe'))?.value, howToAnswer: /** @type {HTMLTextAreaElement | null} */ (part('#mvHowToAnswer'))?.value };
    render();
    if (instructions.aboutMe !== undefined) /** @type {HTMLTextAreaElement} */ (part('#mvAboutMe')).value = instructions.aboutMe;
    if (instructions.howToAnswer !== undefined) /** @type {HTMLTextAreaElement} */ (part('#mvHowToAnswer')).value = instructions.howToAnswer;
  });

  render();
  await refresh();
  return { refresh };
}
