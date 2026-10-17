// @ts-check
// Settings → Trust → Model downloads: what the download check (models/integrity.js) found for each
// model on this device, and the "Load unverified (upstream changed)" override per model. One card:
// - per checked model its name, runtime, state (verified, loaded unverified, file deleted,
//   unverified), the number of files and the time of the last check, and the files that failed;
// - for a model that failed, the override (after a warning), and for an allowed one the way back.
//
// The view reads the results from the app database (models/integrity-state.js) and never loads the
// check itself or its lock file; it refreshes when a check finishes or an override changes. Model
// names and file paths are literal, every other text is an i18n key.
import { setHtml } from '../dom.js';
import { formatDate } from '../i18n/index.js';
import * as integrityState from '../models/integrity-state.js';
import { html, icon, label, labelText } from '../ui/kit.js';

/** @typedef {import('../models/integrity-state.js').ModelCheck} ModelCheck */
/** @typedef {import('../ui/kit.js').Label} Label */
/** @typedef {import('../ui/kit.js').Tone} Tone */
/** @typedef {import('./settings-view.js').ViewServices} ViewServices */

/**
 * What the view reads and changes; the defaults are the app's own.
 * @typedef {object} ModelIntegrityDeps
 * @property {() => Promise<ModelCheck[]>} [readChecks]
 * @property {() => Promise<string[]>} [unverifiedAllowed]
 * @property {(id: string, allow: boolean) => Promise<void>} [setAllowUnverified]
 * @property {(fn: () => void) => () => void} [onIntegrityChange]
 * @property {(message: string) => boolean} [confirm]
 */

const NS = 'trust.models';
/** Files listed per problem line; the rest is counted. */
const FILES_SHOWN = 4;

/** @type {Readonly<Record<ModelCheck['status'], { tone: Tone, icon: string }>>} */
const STATES = Object.freeze({
  verified: { tone: 'ok', icon: 'shield-check' },
  override: { tone: 'warn', icon: 'shield-alert' },
  mismatch: { tone: 'danger', icon: 'octagon-alert' },
  unverified: { tone: 'warn', icon: 'triangle-alert' },
});

/** @param {string[]} files */
function fileList(files) {
  return files.length > FILES_SHOWN ? `${files.slice(0, FILES_SHOWN).join(', ')}, … (+${files.length - FILES_SHOWN})` : files.join(', ');
}

/**
 * Builds the card into `el` and wires its actions. Returns a handle for tests.
 * @param {HTMLElement} el
 * @param {ViewServices} services
 * @param {ModelIntegrityDeps} [deps]
 */
export function mountModelIntegrityView(el, services, deps = {}) {
  const readChecks = deps.readChecks ?? (() => integrityState.readChecks());
  const readAllowed = deps.unverifiedAllowed ?? (() => integrityState.unverifiedAllowed());
  const setAllow = deps.setAllowUnverified ?? ((id, allow) => integrityState.setAllowUnverified(id, allow));
  const subscribe = deps.onIntegrityChange ?? integrityState.onIntegrityChange;
  const confirmAction = deps.confirm ?? ((/** @type {string} */ message) => globalThis.confirm?.(message) ?? false);

  /** @type {ModelCheck[]} */
  let checks = [];
  /** @type {Set<string>} */
  let allowed = new Set();

  /** @param {string} selector */
  const part = (selector) => /** @type {HTMLElement | null} */ (el.querySelector(selector));

  /** @param {ModelCheck} check */
  function item(check) {
    const state = STATES[check.status] ?? STATES.unverified;
    const isAllowed = allowed.has(check.id);
    const failed = check.status === 'mismatch' || check.status === 'unverified';
    return html`<li class="space-y-1.5 p-2.5 rounded-lg bg-slate-50 border border-slate-200" data-model-check="${check.id}" data-state="${check.status}">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="min-w-0"><span class="text-sm font-medium text-slate-900">${check.label}</span> <span class="text-xs text-slate-500">· ${label(`${NS}.runtime.${check.runtime}`)}</span></span>
        <span class="chip chip-${state.tone}">${icon(state.icon, '')}${label(`${NS}.state.${check.status}`)}</span>
      </div>
      ${label({ key: `${NS}.checked`, params: { n: check.files, date: formatDate(new Date(check.checkedAt), { dateStyle: 'medium', timeStyle: 'short' }) } }, { tag: 'p', className: 'text-xs text-slate-600' })}
      ${check.mismatched.length ? label({ key: `${NS}.mismatched`, params: { files: fileList(check.mismatched) } }, { tag: 'p', className: 'text-xs text-slate-700 font-mono break-all' }) : ''}
      ${check.unverified.length ? label({ key: `${NS}.unpinned`, params: { files: fileList(check.unverified) } }, { tag: 'p', className: 'text-xs text-slate-700 font-mono break-all' }) : ''}
      ${
        isAllowed
          ? html`<p class="flex items-start gap-1.5 text-xs text-amber-800" role="note">${icon('triangle-alert', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(`${NS}.allowed`)}</p>
              <div class="flex flex-wrap gap-2"><button type="button" class="btn btn-secondary py-1" data-action="model-integrity-revoke" data-arg="${check.id}">${icon('shield-check', 'w-3.5 h-3.5')}${label(`${NS}.revoke`)}</button></div>`
          : failed
            ? html`<div class="flex flex-wrap gap-2"><button type="button" class="btn btn-ghost py-1 text-amber-800" data-action="model-integrity-allow" data-arg="${check.id}">${icon('triangle-alert', 'w-3.5 h-3.5')}${label(`${NS}.allow`)}</button></div>`
            : ''
      }
    </li>`;
  }

  function listMarkup() {
    if (checks.length === 0) return label(`${NS}.empty`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' });
    return html`<ul class="space-y-2">${checks.map(item)}</ul>`;
  }

  function render() {
    setHtml(
      el,
      html`<div class="card p-4 sm:p-5 space-y-4" data-mi-root>
        <div class="card-header">
          <h3 class="card-title">${icon('file-check', 'w-4 h-4 text-emerald-600')}${label(`${NS}.title`)}</h3>
        </div>
        ${label(`${NS}.subtitle`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed -mt-2' })}
        <div data-mi="list">${listMarkup()}</div>
        <p class="text-xs min-w-0" role="status" aria-live="polite" data-mi="result"></p>
        ${label(`${NS}.note`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed pt-3 border-t border-slate-100' })}
      </div>`.value,
    );
  }

  function refreshList() {
    const target = part('[data-mi="list"]');
    if (target) setHtml(target, String(listMarkup()));
  }

  async function reload() {
    try {
      const [found, ids] = await Promise.all([readChecks(), readAllowed()]);
      checks = found;
      allowed = new Set(ids);
    } catch {
      checks = [];
      allowed = new Set();
    }
    refreshList();
  }

  /**
   * @param {Label} text
   * @param {Tone} tone
   */
  function report(text, tone) {
    const target = part('[data-mi="result"]');
    if (target) setHtml(target, String(html`<span class="flex items-start gap-1.5" data-tone="${tone}">${icon(tone === 'ok' ? 'check-circle-2' : 'octagon-alert', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(text)}</span>`));
  }

  /** @param {string} id */
  const modelOf = (id) => checks.find((c) => c.id === id)?.label ?? id;

  /**
   * @param {string} id
   * @param {boolean} allow
   */
  async function change(id, allow) {
    try {
      await setAllow(id, allow);
      report({ key: allow ? `${NS}.result.allowed` : `${NS}.result.revoked`, params: { model: modelOf(id) } }, 'ok');
    } catch {
      report(`${NS}.error.storage`, 'danger');
    }
    await reload();
  }

  services.onAction('model-integrity-allow', (target) => {
    const id = target.dataset.arg ?? '';
    if (!id || !confirmAction(labelText({ key: `${NS}.allow_confirm`, params: { model: modelOf(id) } }))) return undefined;
    return change(id, true);
  });
  services.onAction('model-integrity-revoke', (target) => {
    const id = target.dataset.arg ?? '';
    return id ? change(id, false) : undefined;
  });

  render();
  const unsubscribe = subscribe(() => void reload());
  // Dates follow the language.
  services.onLocaleChange?.(() => refreshList());
  const loaded = reload();

  return {
    /** Resolves when the results have been read. */
    loaded,
    reload,
    destroy() {
      unsubscribe();
    },
  };
}
