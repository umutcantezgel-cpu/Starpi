// @ts-check
// The companion's two surfaces: its card under Settings (pairing, the source setting, unpairing)
// and the Companion tab (status, questions, documents, notes, agenda, inbox, connectors, audit
// and, for the owner, devices and setup checks).
//
// What the user sees comes from the companion when a page opens; nothing is cached across pages
// or reloads, and answers are shown as the companion released them. A red banner tops both
// surfaces while the audit check says the companion's history went back or changed (pair.js).
// Every text is an i18n key; every value from the companion is escaped (ui/kit.js html``).
//
// The probe (GET /v1/hello) runs when the user opens "Connect the companion on this computer" in
// the card, never by itself. A build served by the companion (Mode A) needs no probe: the page
// came from it.
import { setHtml } from '../dom.js';
import { formatDate, formatNumber, hasKey, t } from '../i18n/index.js';
import { chip, emptyState, html, icon, label, labelText, provenanceBadge, raw, segmented, setSegmentedValue } from '../ui/kit.js';
import { CompanionError, loopbackOrigin } from './client.js';
import { DATA_CLASSES, decideApproval, noticeKey, setSourceSettings, sourceSettings, streamCompanion } from './tier.js';

/** @typedef {import('./pair.js').Pairing} Pairing */
/** @typedef {import('./pair.js').PairingState} PairingState */
/** @typedef {import('../ui/kit.js').Label} Label */
/** @typedef {import('../ui/kit.js').SafeHtml} SafeHtml */
/** @typedef {import('../features/registry.js').ShellServices} ShellServices */

/**
 * @typedef {object} ViewDeps
 * @property {Pairing} pairing
 * @property {(message: string) => boolean} [confirm]
 */

const NS = 'companion';
/** Pages of the tab; `owner` pages show only to an owner session. */
export const PAGES = Object.freeze([
  { id: 'status', icon: 'activity' },
  { id: 'ask', icon: 'message-square' },
  { id: 'documents', icon: 'file-text' },
  { id: 'notes', icon: 'pen-line' },
  { id: 'agenda', icon: 'calendar' },
  { id: 'inbox', icon: 'inbox' },
  { id: 'connectors', icon: 'plug' },
  { id: 'audit', icon: 'shield-check' },
  { id: 'devices', icon: 'laptop', owner: true },
  { id: 'setup', icon: 'sliders-horizontal', owner: true },
]);
/** Media types the companion takes as an upload; anything else goes as bytes for it to sniff. */
const UPLOAD_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'text/html', 'application/json', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

/**
 * The text of a failed call: the companion's code when the app has words for it.
 * @param {unknown} err
 * @returns {Label}
 */
export function errorLabel(err) {
  const code = err instanceof CompanionError ? err.code : 'other';
  return hasKey(`${NS}.error.${code}`) ? `${NS}.error.${code}` : { key: `${NS}.error.other`, params: { code } };
}

/**
 * @param {Label} text
 * @param {'ok' | 'warn' | 'danger' | 'info' | 'neutral'} tone
 */
function line(text, tone) {
  const name = { ok: 'check-circle-2', warn: 'triangle-alert', danger: 'octagon-alert', info: 'info', neutral: 'loader-2' }[tone];
  return html`<span class="flex items-start gap-1.5" data-tone="${tone}">${icon(name, 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(text)}</span>`;
}

/** @param {unknown} iso */
function when(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? formatDate(new Date(ms), { dateStyle: 'medium', timeStyle: 'short' }) : '–';
}

/** @param {unknown} bytes */
function size(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return t(`${NS}.unit.bytes`, { n: formatNumber(n) });
  if (n < 1024 * 1024) return t(`${NS}.unit.kb`, { n: formatNumber(Math.round(n / 102.4) / 10) });
  return t(`${NS}.unit.mb`, { n: formatNumber(Math.round(n / 104857.6) / 10) });
}

/** @param {unknown} dataClass */
function classChip(dataClass) {
  const c = DATA_CLASSES.includes(/** @type {any} */ (dataClass)) ? String(dataClass) : 'personal';
  const tone = c === 'public' ? 'neutral' : c === 'personal' ? 'info' : c === 'sensitive' ? 'warn' : 'danger';
  return chip({ label: `${NS}.class.${c}`, tone, icon: c === 'public' ? 'globe' : 'lock' });
}

/** @param {string} id @param {string} [selected] */
function classSelect(id, selected = 'personal') {
  return html`<select id="${id}" class="field" data-companion-field="class">${DATA_CLASSES.map((c) => html`<option value="${c}"${c === selected ? raw(' selected') : ''}>${labelText(`${NS}.class.${c}`)}</option>`)}</select>`;
}

/** @param {string} hash */
const shortHash = (hash) => `${String(hash).slice(0, 12)}…`;

/**
 * The red banner of a failed audit check, or nothing.
 * @param {PairingState['audit']} audit
 * @returns {SafeHtml | string}
 */
export function auditBanner(audit) {
  if (audit.state !== 'rollback' && audit.state !== 'fork' && audit.state !== 'invalid') return '';
  const params = { stored: formatNumber(audit.stored?.seq ?? 0), reported: formatNumber(audit.reported?.seq ?? 0) };
  return html`<div class="flex items-start gap-3 rounded-xl border-2 border-rose-400 bg-rose-50 p-3 sm:p-4 text-rose-900" role="alert" data-companion-banner="${audit.state}">
    ${icon('octagon-alert', 'w-5 h-5 flex-shrink-0 mt-0.5')}
    <div class="flex-1 min-w-0 space-y-1">
      ${label(`${NS}.audit.banner_title`, { tag: 'p', className: 'font-semibold' })}
      ${label({ key: `${NS}.audit.banner_${audit.state}`, params }, { tag: 'p', className: 'text-sm leading-relaxed' })}
      <div class="flex flex-wrap gap-2 pt-1">
        <button type="button" class="btn btn-secondary py-1" data-action="companion-audit-check">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.audit.check_again`)}</button>
        ${audit.state === 'invalid' ? '' : html`<button type="button" class="btn btn-ghost py-1" data-action="companion-audit-accept">${icon('check', 'w-3.5 h-3.5')}${label(`${NS}.audit.accept`)}</button>`}
      </div>
    </div>
  </div>`;
}

/**
 * The pairing form (code, and the address unless the companion serves the app).
 * @param {string} prefix  ids of the fields
 * @param {PairingState} state
 * @param {boolean} selfServed
 */
function pairForm(prefix, state, selfServed) {
  return html`<div class="space-y-3" data-companion-form>
    ${
      selfServed
        ? label(`${NS}.pair.self_hint`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })
        : html`<div>
      <label for="${prefix}Origin" class="field-label">${label(`${NS}.pair.origin`)}</label>
      <input type="url" id="${prefix}Origin" class="field font-mono" data-companion-field="origin" value="${state.origin}" spellcheck="false" autocomplete="off" inputmode="url">
    </div>`
    }
    <div>
      <label for="${prefix}Code" class="field-label">${label(`${NS}.pair.code`)}</label>
      <input type="text" id="${prefix}Code" class="field font-mono uppercase tracking-widest" data-companion-field="code" maxlength="11" spellcheck="false" autocomplete="one-time-code" placeholder="ABCD-EFGH">
      ${label(`${NS}.pair.code_hint`, { tag: 'p', className: 'text-xs text-slate-500 mt-1' })}
    </div>
    <div class="flex flex-wrap gap-2"><button type="button" class="btn btn-primary" data-action="companion-pair">${icon('plug', 'w-3.5 h-3.5')}${label(`${NS}.pair.submit`)}</button></div>
    <p class="text-xs" data-companion-result aria-live="polite"></p>
  </div>`;
}

/**
 * Wires the actions both surfaces share (once per page).
 * @param {ShellServices} services
 * @param {ViewDeps} deps
 */
function wireShared(services, deps) {
  const { pairing } = deps;
  services.onAction('companion-pair', async (btn) => {
    const form = /** @type {HTMLElement | null} */ (btn.closest('[data-companion-form]'));
    if (!form) return;
    const result = /** @type {HTMLElement | null} */ (form.querySelector('[data-companion-result]'));
    const code = /** @type {HTMLInputElement | null} */ (form.querySelector('[data-companion-field="code"]'))?.value ?? '';
    const originField = /** @type {HTMLInputElement | null} */ (form.querySelector('[data-companion-field="origin"]'));
    const show = (/** @type {Label} */ text, /** @type {'ok' | 'warn' | 'danger' | 'info' | 'neutral'} */ tone) => result && setHtml(result, String(line(text, tone)));
    if (originField && !loopbackOrigin(originField.value)) {
      show(`${NS}.error.origin_invalid`, 'warn');
      return;
    }
    /** @type {HTMLButtonElement} */ (btn).disabled = true;
    show(`${NS}.pair.working`, 'neutral');
    try {
      await pairing.pair({ code, origin: originField?.value });
      services.toast(`${NS}.pair.done`, { tone: 'ok' });
    } catch (err) {
      show(errorLabel(err), 'warn');
    } finally {
      /** @type {HTMLButtonElement} */ (btn).disabled = false;
    }
  });
  services.onAction('companion-audit-check', async () => {
    try {
      await pairing.checkAudit();
    } catch (err) {
      services.toast(errorLabel(err), { tone: 'warn' });
    }
  });
  services.onAction('companion-audit-accept', async () => {
    if (!(deps.confirm ?? ((m) => globalThis.confirm?.(m) ?? false))(t(`${NS}.audit.accept_confirm`))) return;
    if (await pairing.acceptCurrent()) services.toast(`${NS}.audit.accepted`, { tone: 'ok' });
  });
}

/** @type {WeakSet<object>} */
const wiredFor = new WeakSet();

/**
 * @param {ShellServices} services
 * @param {ViewDeps} deps
 */
function ensureWired(services, deps) {
  if (wiredFor.has(deps.pairing)) return;
  wiredFor.add(deps.pairing);
  wireShared(services, deps);
}

// ---------------------------------------------------------------------------------------------
// Settings card
// ---------------------------------------------------------------------------------------------

/**
 * Settings → Companion.
 * @param {HTMLElement} el
 * @param {ShellServices} services
 * @param {ViewDeps} deps
 */
export function mountCompanionSettings(el, services, deps) {
  const { pairing } = deps;
  const confirmAction = deps.confirm ?? ((/** @type {string} */ m) => globalThis.confirm?.(m) ?? false);
  ensureWired(services, deps);
  let shape = '';

  /** @param {PairingState} s */
  function stateChip(s) {
    if (s.phase !== 'paired') return chip({ label: `${NS}.state.unpaired`, tone: 'neutral' });
    if (s.audit.state === 'rollback' || s.audit.state === 'fork' || s.audit.state === 'invalid') return chip({ label: `${NS}.state.audit_failed`, tone: 'danger' });
    return chip({ label: s.mode === 'cookie' ? `${NS}.state.paired_self` : `${NS}.state.paired_hosted`, tone: 'ok', icon: 'plug' });
  }

  /** @param {PairingState} s */
  function body(s) {
    if (s.phase !== 'paired') {
      const lost = s.lost ? html`<p class="text-xs text-amber-800">${line(`${NS}.pair.lost`, 'warn')}</p>` : '';
      if (pairing.selfServed()) return html`${lost}${pairForm('companionSettings', s, true)}`;
      return html`${lost}<details class="disclosure" data-companion-connect>
        <summary>${icon('search', 'w-4 h-4 text-amber-600')}${label(`${NS}.pair.connect`)}${icon('chevron-down', 'disclosure-chevron')}</summary>
        <div class="disclosure-body space-y-3">
          <div class="flex flex-wrap items-center gap-2"><p class="text-xs flex-1 min-w-0" data-companion-probe aria-live="polite"></p><button type="button" class="btn btn-ghost py-1" data-action="companion-probe">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.probe.again`)}</button></div>
          ${pairForm('companionSettings', s, false)}
          ${label(`${NS}.pair.network_hint`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
        </div>
      </details>`;
    }
    const settings = sourceSettings();
    const rows = [
      [`${NS}.info.origin`, html`<span class="font-mono">${s.origin}</span>`],
      [`${NS}.info.mode`, label(s.mode === 'cookie' ? `${NS}.info.mode_self` : `${NS}.info.mode_hosted`)],
      [`${NS}.info.role`, label(`${NS}.role.${s.role ?? 'member'}`)],
      [`${NS}.info.expires`, when(s.expiresAt)],
      [`${NS}.info.key`, html`<span class="font-mono">${String(s.keyId ?? '').slice(0, 16)}</span>`],
    ];
    return html`<dl class="space-y-2 text-xs">${rows.map(([k, v]) => html`<div class="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200"><dt class="text-slate-600">${label(/** @type {string} */ (k))}</dt><dd class="font-medium text-slate-900 text-right truncate">${v}</dd></div>`)}</dl>
      <div class="space-y-2">
        <label class="flex items-start gap-2 text-sm text-slate-800"><input type="checkbox" class="mt-1" data-change="companion-source-enabled"${settings.enabled ? raw(' checked') : ''}>${label(`${NS}.source.enabled`)}</label>
        <div>
          <label for="companionCeiling" class="field-label">${label(`${NS}.source.ceiling`)}</label>
          <select id="companionCeiling" class="field" data-change="companion-source-ceiling">
            <option value="personal"${settings.cloudCeiling === 'personal' ? raw(' selected') : ''}>${labelText(`${NS}.source.ceiling_personal`)}</option>
            <option value="public"${settings.cloudCeiling === 'public' ? raw(' selected') : ''}>${labelText(`${NS}.source.ceiling_public`)}</option>
          </select>
          ${label(`${NS}.source.ceiling_hint`, { tag: 'p', className: 'text-xs text-slate-500 mt-1 leading-relaxed' })}
        </div>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-secondary py-1" data-action="companion-open">${icon('arrow-right', 'w-3.5 h-3.5')}${label(`${NS}.open`)}</button>
        <button type="button" class="btn btn-ghost py-1 text-rose-700" data-action="companion-unpair">${icon('x', 'w-3.5 h-3.5')}${label(`${NS}.unpair`)}</button>
      </div>`;
  }

  function render() {
    const s = pairing.state();
    const next = `${s.phase}|${s.mode}|${s.role}|${s.audit.state}|${s.lost}`;
    if (next === shape && el.childElementCount > 0) return;
    shape = next;
    setHtml(
      el,
      String(html`<div class="card p-4 sm:p-5 space-y-4" data-companion-card>
        <div class="card-header"><h3 class="card-title">${icon('plug', 'w-4 h-4 text-amber-600')}${label(`${NS}.card.title`)}</h3><div class="flex items-center gap-1.5">${stateChip(s)}</div></div>
        ${label(`${NS}.card.subtitle`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}
        ${auditBanner(s.audit)}
        <div class="space-y-3">${body(s)}</div>
      </div>`),
    );
    const details = /** @type {HTMLDetailsElement | null} */ (el.querySelector('[data-companion-connect]'));
    details?.addEventListener('toggle', () => {
      if (details.open) void probe();
    });
    // A changed address is asked again right away.
    el.querySelector('[data-companion-field="origin"]')?.addEventListener('change', () => void probe());
  }

  /** Only the newest probe shows its answer. */
  let probes = 0;
  async function probe() {
    const out = /** @type {HTMLElement | null} */ (el.querySelector('[data-companion-probe]'));
    const origin = /** @type {HTMLInputElement | null} */ (el.querySelector('[data-companion-field="origin"]'))?.value ?? pairing.state().origin;
    if (!out) return;
    const mine = ++probes;
    setHtml(out, String(line(`${NS}.probe.looking`, 'neutral')));
    /** @type {SafeHtml} */
    let result;
    try {
      const hello = await pairing.probe(origin);
      result = line({ key: `${NS}.probe.found`, params: { version: hello.version, origin: loopbackOrigin(origin) ?? origin } }, 'ok');
    } catch (err) {
      result = line(err instanceof CompanionError && (err.code === 'unreachable' || err.code === 'timeout') ? `${NS}.probe.none` : errorLabel(err), 'warn');
    }
    if (mine === probes && out.isConnected) setHtml(out, String(result));
  }

  services.onAction('companion-unpair', async () => {
    if (!confirmAction(t(`${NS}.unpair_confirm`))) return;
    await pairing.unpair();
    services.toast(`${NS}.unpaired`, { tone: 'info' });
  });
  services.onAction('companion-open', () => services.switchTab('companion'));
  services.onAction('companion-probe', () => void probe());
  services.onChange('companion-source-enabled', (input) => {
    setSourceSettings({ enabled: /** @type {HTMLInputElement} */ (input).checked });
  });
  services.onChange('companion-source-ceiling', (input) => {
    setSourceSettings({ cloudCeiling: /** @type {HTMLSelectElement} */ (input).value === 'public' ? 'public' : 'personal' });
  });

  pairing.subscribe(render);
  services.onLocaleChange(() => {
    shape = '';
    render();
  });
  render();
}

// ---------------------------------------------------------------------------------------------
// Companion tab
// ---------------------------------------------------------------------------------------------

/**
 * The Companion tab.
 * @param {HTMLElement} el
 * @param {ShellServices} services
 * @param {ViewDeps} deps
 */
export function mountCompanionTab(el, services, deps) {
  const { pairing } = deps;
  const confirmAction = deps.confirm ?? ((/** @type {string} */ m) => globalThis.confirm?.(m) ?? false);
  ensureWired(services, deps);
  let page = 'status';
  let headShape = '';
  /** The session and role the page list was built for ('' while the page waits for the tab to open). */
  let shownPages = '';
  /** Generation of the shown page: a late answer of a page left meanwhile is dropped. */
  let generation = 0;

  /** In-memory state of the Ask page: the open conversation and the running question. */
  const ask = { mode: /** @type {'sources' | 'free'} */ ('sources'), conversation: /** @type {string | null} */ (null), controller: /** @type {AbortController | null} */ (null) };
  /** The inbox while its page is open: what it has shown, and the stream. */
  const inbox = { after: 0, items: /** @type {Map<string, any>} */ (new Map()), controller: /** @type {AbortController | null} */ (null), retry: 0 };
  /** The MCP client token made last, shown once. */
  let freshToken = /** @type {{ label: string, token: string } | null} */ (null);

  setHtml(
    el,
    String(html`<div class="max-w-4xl mx-auto w-full space-y-4" data-companion-tab>
      <div data-cv="banner"></div>
      <div data-cv="head"></div>
      <div data-cv="nav" class="overflow-x-auto custom-scrollbar"></div>
      <div data-cv="page" class="space-y-4"></div>
    </div>`),
  );
  /** @param {string} name */
  const part = (name) => /** @type {HTMLElement} */ (el.querySelector(`[data-cv="${name}"]`));
  /** @param {string} name @param {SafeHtml | string} markup */
  const fill = (name, markup) => setHtml(part(name), String(markup));
  const visible = () => !el.classList.contains('hidden');
  const owner = () => pairing.state().role === 'owner';
  const pages = () => PAGES.filter((p) => !p.owner || owner());

  /**
   * The banner, the header with its chips and the page list; the page itself loads only while the
   * tab is shown (a paired companion is not asked anything while the tab stays closed).
   * @param {{ reload?: boolean }} [opts]  reload: load the page again (the tab was opened)
   */
  function renderChrome(opts = {}) {
    const s = pairing.state();
    fill('banner', s.phase === 'paired' ? auditBanner(s.audit) : '');
    const shape = `${s.phase}|${s.role}|${s.mode}|${s.audit.state}|${s.lost}`;
    const pageShape = `${s.phase}|${s.role}|${s.session}`;
    const pagesChanged = pageShape !== shownPages;
    if (shape !== headShape) {
      headShape = shape;
      if (s.phase !== 'paired') {
        fill('head', html`<div class="flex items-center gap-2">${icon('plug', 'w-5 h-5 text-amber-600')}${label(`${NS}.card.title`, { tag: 'h2', className: 'text-lg font-semibold text-slate-900' })}</div>`);
        fill('nav', '');
        stopInbox();
        fill(
          'page',
          pairing.selfServed()
            ? html`<div class="card p-4 sm:p-5 space-y-3">${label(`${NS}.card.subtitle`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}${s.lost ? line(`${NS}.pair.lost`, 'warn') : ''}${pairForm('companionTab', s, true)}</div>`
            : html`${emptyState({ title: `${NS}.tab.unpaired_title`, body: `${NS}.tab.unpaired_body`, icon: 'plug' })}<div class="flex justify-center"><button type="button" class="btn btn-primary" data-action="companion-to-settings">${icon('settings-2', 'w-3.5 h-3.5')}${label(`${NS}.tab.to_settings`)}</button></div>`,
        );
        shownPages = pageShape;
        return;
      }
      fill(
        'head',
        html`<div class="flex flex-wrap items-center gap-2">${icon('plug', 'w-5 h-5 text-amber-600')}${label(`${NS}.card.title`, { tag: 'h2', className: 'text-lg font-semibold text-slate-900' })}<span class="flex-1"></span>${chip({ label: s.mode === 'cookie' ? `${NS}.state.paired_self` : `${NS}.state.paired_hosted`, tone: 'ok', icon: 'plug' })}${auditChip(s.audit.state)}</div>`,
      );
    }
    if (s.phase !== 'paired') return;
    if (pagesChanged || opts.reload) {
      if (!pages().some((p) => p.id === page)) page = 'status';
      fill('nav', segmented({ action: 'companion-page', label: `${NS}.tab.pages`, value: page, options: pages().map((p) => ({ value: p.id, label: `${NS}.page.${p.id}`, icon: p.icon })) }));
    }
    if ((pagesChanged || opts.reload) && visible()) {
      shownPages = pageShape;
      void showPage();
    } else if (pagesChanged) {
      // Shown again when the tab opens.
      fill('page', '');
      shownPages = '';
    }
  }

  /** @param {string} state */
  function auditChip(state) {
    if (state === 'ok') return chip({ label: `${NS}.audit.chip_ok`, tone: 'ok', icon: 'shield-check' });
    if (state === 'unsupported') return chip({ label: `${NS}.audit.chip_unsupported`, tone: 'neutral', icon: 'shield-question-mark' });
    if (state === 'unknown') return chip({ label: `${NS}.audit.chip_unknown`, tone: 'neutral', icon: 'shield' });
    return chip({ label: `${NS}.audit.chip_failed`, tone: 'danger', icon: 'shield-alert' });
  }

  /**
   * Loads and shows the current page.
   * @param {{ quiet?: boolean }} [opts]  quiet: keep the page while it reloads
   */
  async function showPage(opts = {}) {
    const mine = ++generation;
    if (page !== 'inbox') stopInbox();
    if (page !== 'ask') ask.controller?.abort();
    if (!opts.quiet) fill('page', html`<p class="text-sm text-slate-500">${line(`${NS}.loading`, 'neutral')}</p>`);
    try {
      const markup = await loaders[/** @type {keyof typeof loaders} */ (page)]();
      if (mine !== generation) return;
      fill('page', markup);
      after[/** @type {keyof typeof after} */ (page)]?.();
    } catch (err) {
      if (mine !== generation) return;
      fill('page', html`<div class="card p-4 space-y-3"><p class="text-sm">${line(errorLabel(err), 'warn')}</p><button type="button" class="btn btn-secondary py-1" data-action="companion-reload">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.retry`)}</button></div>`);
    }
  }

  /**
   * @param {Label} title
   * @param {SafeHtml | SafeHtml[] | string} body
   * @param {SafeHtml | string} [badges]
   */
  const section = (title, body, badges = '') =>
    html`<section class="card p-4 sm:p-5 space-y-3"><div class="card-header">${label(title, { tag: 'h3', className: 'card-title' })}${badges ? html`<div class="flex flex-wrap items-center gap-1.5">${badges}</div>` : ''}</div>${body}</section>`;
  /** @param {Array<[Label, SafeHtml | string]>} rows */
  const facts = (rows) =>
    html`<dl class="grid sm:grid-cols-2 gap-2 text-xs">${rows.map(([k, v]) => html`<div class="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200"><dt class="text-slate-600">${label(k)}</dt><dd class="font-medium text-slate-900 text-right truncate">${v}</dd></div>`)}</dl>`;
  /** @param {Label} text */
  const quiet = (text) => label(text, { tag: 'p', className: 'text-xs text-slate-500' });

  const loaders = {
    async status() {
      const s = await pairing.call('GET', '/v1/status');
      const allow = Object.entries(s.egress?.allow ?? {}).filter(([, hosts]) => Array.isArray(hosts) && hosts.length > 0);
      const brains = Array.isArray(s.brains) ? s.brains : [];
      const head = s.audit?.head ?? null;
      return html`${section(
        `${NS}.status.title`,
        facts([
          [`${NS}.status.version`, String(s.version ?? '–')],
          [`${NS}.status.profile`, String(s.profile ?? '–')],
          [`${NS}.status.time_zone`, String(s.timeZone ?? '–')],
          [`${NS}.status.started`, when(s.startedAt)],
          [`${NS}.status.breaker`, label(hasKey(`${NS}.breaker.${s.breaker?.level}`) ? `${NS}.breaker.${s.breaker?.level}` : { text: String(s.breaker?.level ?? '–') })],
          [`${NS}.status.sessions`, formatNumber(Number(s.sessions) || 0)],
        ]),
        chip({ label: { text: `v${String(s.version ?? '')}` }, tone: 'info', icon: 'server' }),
      )}
      ${section(
        `${NS}.status.egress`,
        html`<p class="text-sm">${s.egress?.guarded ? line(`${NS}.status.egress_guarded`, 'ok') : line(`${NS}.status.egress_unguarded`, 'warn')}</p>
        ${allow.length ? html`<ul class="text-xs space-y-1">${allow.map(([mod, hosts]) => html`<li class="flex flex-wrap gap-1.5 items-center"><span class="font-medium">${mod}</span>${/** @type {string[]} */ (hosts).map((h) => html`<span class="chip chip-neutral font-mono">${h}</span>`)}</li>`)}</ul>` : quiet(`${NS}.status.egress_none`)}`,
      )}
      ${section(
        `${NS}.status.brains`,
        brains.length
          ? html`<ul class="text-xs space-y-1.5">${brains.map((/** @type {any} */ b) => html`<li class="flex flex-wrap items-center gap-1.5"><span class="font-medium">${String(b.id)}</span>${chip({ label: hasKey(`${NS}.locality.${b.locality}`) ? `${NS}.locality.${b.locality}` : { text: String(b.locality) }, tone: b.locality === 'cloud' ? 'info' : 'neutral', icon: b.locality === 'cloud' ? 'cloud' : 'hard-drive' })}${b.model ? html`<span class="font-mono text-slate-600">${String(b.model)}</span>` : ''}${b.resting ? chip({ label: `${NS}.status.resting`, tone: 'warn' }) : ''}</li>`)}</ul>`
          : quiet(`${NS}.status.no_brains`),
      )}
      ${section(
        `${NS}.status.audit`,
        facts([
          [`${NS}.status.head`, head ? html`<span class="font-mono">#${formatNumber(head.seq)} · ${shortHash(head.hash)}</span>` : '–'],
          [`${NS}.status.anchors`, formatNumber(Number(s.audit?.anchors?.count) || 0)],
        ]),
      )}`;
    },

    async ask() {
      const list = await pairing.call('GET', '/v1/chat/conversations').catch(() => ({ conversations: [] }));
      const conversations = Array.isArray(list.conversations) ? list.conversations.slice(0, 30) : [];
      return html`${section(
        `${NS}.ask.title`,
        html`${label(`${NS}.ask.hint`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}
        ${segmented({ action: 'companion-ask-mode', label: `${NS}.ask.mode`, value: ask.mode, options: [{ value: 'sources', label: `${NS}.ask.mode_sources`, icon: 'file-check' }, { value: 'free', label: `${NS}.ask.mode_free`, icon: 'message-square' }] })}
        <div><label for="companionQuestion" class="field-label">${label(`${NS}.ask.question`)}</label><textarea id="companionQuestion" class="field min-h-[5rem]" data-companion-field="question" maxlength="8000"></textarea></div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-primary" data-action="companion-ask">${icon('arrow-up', 'w-3.5 h-3.5')}${label(`${NS}.ask.submit`)}</button>
          <button type="button" class="btn btn-ghost hidden" data-action="companion-ask-stop">${icon('square', 'w-3.5 h-3.5')}${label(`${NS}.ask.stop`)}</button>
          <button type="button" class="btn btn-ghost" data-action="companion-ask-new">${icon('plus', 'w-3.5 h-3.5')}${label(`${NS}.ask.new`)}</button>
        </div>
        <div data-cv="thread" class="space-y-3"></div>`,
        ask.conversation ? chip({ label: `${NS}.ask.continuing`, tone: 'info', icon: 'message-square' }) : '',
      )}
      ${section(`${NS}.ask.conversations`, html`<div data-cv="conversations">${conversationList(conversations)}</div>`)}`;
    },

    async documents() {
      const { documents = [] } = await pairing.call('GET', '/v1/docs');
      return section(
        `${NS}.docs.title`,
        html`<div class="flex flex-wrap items-end gap-2" data-companion-upload>
          <div><label for="companionDocClass" class="field-label">${label(`${NS}.docs.class`)}</label>${classSelect('companionDocClass')}</div>
          <label class="btn btn-secondary cursor-pointer">${icon('upload', 'w-3.5 h-3.5')}${label(`${NS}.docs.upload`)}<input type="file" class="sr-only" data-change="companion-doc-upload"></label>
          <button type="button" class="btn btn-ghost" data-action="companion-reload">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.refresh`)}</button>
        </div>
        <p class="text-xs" data-cv="upload-result" aria-live="polite"></p>
        ${
          documents.length
            ? html`<ul class="divide-y divide-slate-100 text-sm" data-companion-list="documents">${documents.map(
                (/** @type {any} */ d) =>
                  html`<li class="flex flex-wrap items-center gap-2 py-2" data-companion-doc="${String(d.id)}"><span class="flex-1 min-w-0 truncate font-medium">${String(d.name)}</span>${classChip(d.dataClass)}${chip({ label: hasKey(`${NS}.docs.status_${d.status}`) ? `${NS}.docs.status_${d.status}` : { text: String(d.status) }, tone: d.status === 'indexed' ? 'ok' : d.status === 'failed' ? 'warn' : 'neutral' })}<span class="text-xs text-slate-500">${size(d.bytes)}</span><button type="button" class="btn btn-ghost p-1" data-action="companion-doc-download" data-arg="${String(d.id)}" aria-label="${labelText(`${NS}.docs.download`)}" data-i18n-aria="${NS}.docs.download">${icon('download', 'w-3.5 h-3.5')}</button><button type="button" class="btn btn-ghost p-1" data-action="companion-doc-delete" data-arg="${String(d.id)}" aria-label="${labelText(`${NS}.delete`)}" data-i18n-aria="${NS}.delete">${icon('trash-2', 'w-3.5 h-3.5')}</button></li>`,
              )}</ul>`
            : quiet(`${NS}.docs.empty`)
        }`,
      );
    },

    async notes() {
      const { notes = [] } = await pairing.call('GET', '/v1/memory/notes');
      return html`${section(
        `${NS}.notes.add`,
        html`<div class="space-y-2" data-companion-note-form>
          <div><label for="companionNoteTitle" class="field-label">${label(`${NS}.notes.note_title`)}</label><input type="text" id="companionNoteTitle" class="field" data-companion-field="title" maxlength="200"></div>
          <div><label for="companionNoteText" class="field-label">${label(`${NS}.notes.text`)}</label><textarea id="companionNoteText" class="field min-h-[4rem]" data-companion-field="text"></textarea></div>
          <div class="flex flex-wrap items-end gap-2"><div><label for="companionNoteClass" class="field-label">${label(`${NS}.docs.class`)}</label>${classSelect('companionNoteClass')}</div><button type="button" class="btn btn-primary" data-action="companion-note-add">${icon('plus', 'w-3.5 h-3.5')}${label(`${NS}.notes.save`)}</button></div>
          <p class="text-xs" data-cv="note-result" aria-live="polite"></p>
        </div>`,
      )}
      ${section(
        `${NS}.notes.title`,
        notes.length
          ? html`<ul class="divide-y divide-slate-100 text-sm" data-companion-list="notes">${notes.map(
              (/** @type {any} */ n) =>
                html`<li class="py-2 space-y-1" data-companion-note="${String(n.id)}"><div class="flex flex-wrap items-center gap-2"><button type="button" class="flex-1 min-w-0 text-left truncate font-medium hover:underline" data-action="companion-note-open" data-arg="${String(n.id)}">${String(n.title || '…')}</button>${n.pinned ? icon('pin', 'w-3.5 h-3.5 text-amber-600') : ''}${classChip(n.dataClass)}<span class="text-xs text-slate-500">${when(n.updated)}</span><button type="button" class="btn btn-ghost p-1" data-action="companion-note-delete" data-arg="${String(n.id)}" aria-label="${labelText(`${NS}.delete`)}" data-i18n-aria="${NS}.delete">${icon('trash-2', 'w-3.5 h-3.5')}</button></div><div class="hidden text-sm text-slate-700 whitespace-pre-wrap" data-note-text></div></li>`,
            )}</ul>`
          : quiet(`${NS}.notes.empty`),
      )}`;
    },

    async agenda() {
      const { items = [], timeZone } = await pairing.call('GET', '/v1/agenda');
      const day = (/** @type {number} */ d) => labelText(`${NS}.agenda.day_${d}`);
      return html`${section(
        `${NS}.agenda.add`,
        html`<div class="space-y-2" data-companion-agenda-form>
          <div><label for="companionAgendaTitle" class="field-label">${label(`${NS}.agenda.item_title`)}</label><input type="text" id="companionAgendaTitle" class="field" data-companion-field="title" maxlength="200"></div>
          <div class="grid sm:grid-cols-3 gap-2">
            <div><label for="companionAgendaRule" class="field-label">${label(`${NS}.agenda.repeat`)}</label><select id="companionAgendaRule" class="field" data-companion-field="rule">${['once', 'daily', 'weekly', 'monthly'].map((r) => html`<option value="${r}">${labelText(`${NS}.agenda.rule_${r}`)}</option>`)}</select></div>
            <div><label for="companionAgendaDate" class="field-label">${label(`${NS}.agenda.date`)}</label><input type="date" id="companionAgendaDate" class="field" data-companion-field="date"></div>
            <div><label for="companionAgendaTime" class="field-label">${label(`${NS}.agenda.time`)}</label><input type="time" id="companionAgendaTime" class="field" data-companion-field="time" value="09:00"></div>
          </div>
          <fieldset class="flex flex-wrap gap-2 text-xs"><legend class="field-label">${label(`${NS}.agenda.weekdays`)}</legend>${WEEKDAYS.map((d) => html`<label class="flex items-center gap-1"><input type="checkbox" data-companion-weekday="${d}">${day(d)}</label>`)}</fieldset>
          <div class="flex flex-wrap items-end gap-2"><div><label for="companionAgendaDay" class="field-label">${label(`${NS}.agenda.month_day`)}</label><input type="number" id="companionAgendaDay" class="field w-24" min="1" max="31" data-companion-field="day"></div><button type="button" class="btn btn-primary" data-action="companion-agenda-add">${icon('plus', 'w-3.5 h-3.5')}${label(`${NS}.agenda.save`)}</button></div>
          <p class="text-xs" data-cv="agenda-result" aria-live="polite"></p>
        </div>`,
      )}
      ${section(
        `${NS}.agenda.title`,
        items.length
          ? html`<ul class="divide-y divide-slate-100 text-sm" data-companion-list="agenda">${items.map(
              (/** @type {any} */ a) =>
                html`<li class="flex flex-wrap items-center gap-2 py-2" data-companion-agenda="${String(a.id)}"><span class="flex-1 min-w-0 truncate font-medium">${String(a.title)}</span><span class="text-xs text-slate-600">${ruleText(a.rule)}</span><span class="text-xs text-slate-500">${a.nextLocal ? label({ key: `${NS}.agenda.next`, params: { time: String(a.nextLocal) } }) : label(`${NS}.agenda.done`)}</span><button type="button" class="btn btn-ghost p-1" data-action="companion-agenda-delete" data-arg="${String(a.id)}" aria-label="${labelText(`${NS}.delete`)}" data-i18n-aria="${NS}.delete">${icon('trash-2', 'w-3.5 h-3.5')}</button></li>`,
            )}</ul>`
          : quiet(`${NS}.agenda.empty`),
        timeZone ? chip({ label: { text: String(timeZone) }, tone: 'neutral', icon: 'globe' }) : '',
      )}`;
    },

    async inbox() {
      return section(
        `${NS}.inbox.title`,
        html`<div class="flex flex-wrap gap-2"><button type="button" class="btn btn-secondary py-1" data-action="companion-inbox-read-all">${icon('check', 'w-3.5 h-3.5')}${label(`${NS}.inbox.read_all`)}</button></div>
        <p class="text-xs" data-cv="inbox-state" aria-live="polite"></p>
        <ul class="divide-y divide-slate-100 text-sm" data-cv="inbox-list"></ul>`,
      );
    },

    async connectors() {
      const [{ servers = [] }, { approvals = [] }] = await Promise.all([pairing.call('GET', '/v1/connectors'), pairing.call('GET', '/v1/connectors/approvals')]);
      const isOwner = owner();
      return html`${section(
        `${NS}.connectors.approvals`,
        approvals.length
          ? html`<ul class="divide-y divide-slate-100 text-sm">${approvals.map(
              (/** @type {any} */ a) =>
                html`<li class="flex flex-wrap items-center gap-2 py-2"><span class="flex-1 min-w-0"><span class="font-medium">${String(a.server)}.${String(a.tool)}</span> <span class="text-xs text-slate-500 font-mono">${String(a.preview ?? '')}</span></span><button type="button" class="btn btn-primary py-1" data-action="companion-approval" data-arg="${String(a.id)}|approve">${label(`${NS}.connectors.approve_call`)}</button><button type="button" class="btn btn-ghost py-1" data-action="companion-approval" data-arg="${String(a.id)}|deny">${label(`${NS}.connectors.deny_call`)}</button></li>`,
            )}</ul>`
          : quiet(`${NS}.connectors.no_approvals`),
      )}
      ${section(
        `${NS}.connectors.title`,
        servers.length
          ? servers.map(
              (/** @type {any} */ s) =>
                html`<div class="space-y-2 border-t border-slate-100 pt-3 first:border-0 first:pt-0"><div class="flex flex-wrap items-center gap-2"><span class="font-medium">${String(s.title ?? s.id)}</span><span class="text-xs font-mono text-slate-500">${String(s.url ?? '')}</span>${chip({ label: { text: String(s.state ?? '') }, tone: s.state === 'ready' ? 'ok' : 'neutral' })}${isOwner ? html`<button type="button" class="btn btn-ghost py-1" data-action="companion-connector-refresh" data-arg="${String(s.id)}">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.refresh`)}</button>` : ''}</div>
                <ul class="text-xs space-y-1.5">${(Array.isArray(s.tools) ? s.tools : []).map(
                  (/** @type {any} */ tool) =>
                    html`<li class="flex flex-wrap items-center gap-2"><span class="font-mono">${String(tool.name)}</span>${chip({ label: hasKey(`${NS}.connectors.pin_${tool.state}`) ? `${NS}.connectors.pin_${tool.state}` : { text: String(tool.state) }, tone: tool.state === 'approved' ? 'ok' : tool.state === 'changed' ? 'warn' : 'neutral' })}${tool.calls ? chip({ label: `${NS}.connectors.calls_${tool.calls === 'allow' ? 'allow' : 'ask'}`, tone: 'neutral' }) : ''}<span class="flex-1 min-w-0 truncate text-slate-600">${String(tool.description ?? '')}</span>${
                      isOwner && tool.pin && tool.state !== 'approved'
                        ? html`<button type="button" class="btn btn-secondary py-1" data-action="companion-tool-approve" data-arg="${String(s.id)}|${String(tool.name)}|${String(tool.pin)}">${label(`${NS}.connectors.approve_tool`)}</button>`
                        : ''
                    }${isOwner && tool.approvedPin ? html`<button type="button" class="btn btn-ghost py-1" data-action="companion-tool-revoke" data-arg="${String(s.id)}|${String(tool.name)}">${label(`${NS}.connectors.revoke_tool`)}</button>` : ''}</li>`,
                )}</ul></div>`,
            )
          : quiet(`${NS}.connectors.empty`),
      )}`;
    },

    async audit() {
      const audit = await pairing.checkAudit();
      return section(
        `${NS}.audit.title`,
        html`${facts([
          [`${NS}.audit.state`, label(`${NS}.audit.state_${audit.state}`)],
          [`${NS}.audit.reported`, audit.reported ? html`<span class="font-mono">#${formatNumber(audit.reported.seq)} · ${shortHash(audit.reported.hash)}</span>` : '–'],
          [`${NS}.audit.stored`, audit.stored ? html`<span class="font-mono">#${formatNumber(audit.stored.seq)} · ${shortHash(audit.stored.hash)}</span>` : '–'],
          [`${NS}.audit.key`, html`<span class="font-mono">${String(pairing.state().keyId ?? '').slice(0, 16)}</span>`],
        ])}
        ${label(`${NS}.audit.explain`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}
        <div class="flex flex-wrap gap-2"><button type="button" class="btn btn-secondary py-1" data-action="companion-audit-check">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.audit.check_again`)}</button>${owner() ? html`<button type="button" class="btn btn-secondary py-1" data-action="companion-audit-verify">${icon('shield-check', 'w-3.5 h-3.5')}${label(`${NS}.audit.verify`)}</button>` : ''}</div>
        <div class="text-xs" data-cv="verify-result" aria-live="polite"></div>`,
      );
    },

    async devices() {
      const [{ sessions = [] }, mcp] = await Promise.all([pairing.call('GET', '/v1/sessions'), pairing.call('GET', '/v1/mcp/clients').catch(() => ({ clients: null }))]);
      const mine = pairing.state().session;
      return html`${section(
        `${NS}.devices.title`,
        html`<ul class="divide-y divide-slate-100 text-sm">${sessions.map(
          (/** @type {any} */ d) =>
            html`<li class="flex flex-wrap items-center gap-2 py-2"><span class="flex-1 min-w-0 truncate">${d.label || d.origin ? String(d.label || d.origin) : label(d.kind === 'bearer' ? `${NS}.devices.kind_bearer` : `${NS}.devices.kind_cookie`)}</span>${chip({ label: `${NS}.role.${d.role === 'owner' ? 'owner' : 'member'}`, tone: 'neutral' })}${d.id === mine ? chip({ label: `${NS}.devices.this`, tone: 'info' }) : ''}<span class="text-xs text-slate-500">${when(d.lastUsed ?? d.created)}</span>${d.id === mine ? '' : html`<button type="button" class="btn btn-ghost py-1 text-rose-700" data-action="companion-session-revoke" data-arg="${String(d.id)}">${label(`${NS}.devices.revoke`)}</button>`}</li>`,
        )}</ul>`,
      )}
      ${
        mcp.clients === null
          ? ''
          : section(
              `${NS}.mcp.title`,
              html`${label(`${NS}.mcp.hint`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}
              ${freshToken ? html`<div class="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1 text-xs" data-cv="mcp-token">${label({ key: `${NS}.mcp.token_once`, params: { label: freshToken.label } }, { tag: 'p', className: 'font-medium' })}<code class="block break-all font-mono select-all">${freshToken.token}</code></div>` : ''}
              <div class="flex flex-wrap items-end gap-2"><div class="flex-1 min-w-[12rem]"><label for="companionMcpLabel" class="field-label">${label(`${NS}.mcp.label`)}</label><input type="text" id="companionMcpLabel" class="field" maxlength="80" data-companion-field="mcp-label"></div><button type="button" class="btn btn-primary" data-action="companion-mcp-add">${icon('plus', 'w-3.5 h-3.5')}${label(`${NS}.mcp.add`)}</button></div>
              <ul class="divide-y divide-slate-100 text-sm">${(mcp.clients ?? []).map(
                (/** @type {any} */ c) =>
                  html`<li class="flex flex-wrap items-center gap-2 py-2"><span class="flex-1 min-w-0 truncate">${String(c.label)}</span><span class="text-xs text-slate-500">${label({ key: `${NS}.mcp.calls`, params: { n: formatNumber(Number(c.calls) || 0) } })}</span><button type="button" class="btn btn-ghost py-1 text-rose-700" data-action="companion-mcp-revoke" data-arg="${String(c.id)}">${label(`${NS}.devices.revoke`)}</button></li>`,
              )}</ul>`,
            )
      }`;
    },

    async setup() {
      const r = await pairing.call('GET', '/v1/setup');
      const checks = Array.isArray(r.checks) ? r.checks : [];
      return section(
        `${NS}.setup.title`,
        html`<ul class="space-y-2 text-sm">${checks.map((/** @type {any} */ c) => {
          const tone = c.state === 'ok' ? 'ok' : c.state === 'warn' ? 'warn' : c.state === 'fail' ? 'danger' : 'info';
          return html`<li class="space-y-0.5">${line(hasKey(`${NS}.setup.code_${c.code}`) ? `${NS}.setup.code_${c.code}` : { text: String(c.code) }, tone)}<p class="text-xs text-slate-500 font-mono pl-5">${String(c.detail ?? '')}</p></li>`;
        })}</ul>
        <button type="button" class="btn btn-secondary py-1" data-action="companion-setup-fresh">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.setup.run`)}</button>`,
        r.ready ? chip({ label: `${NS}.setup.ready`, tone: 'ok' }) : chip({ label: `${NS}.setup.not_ready`, tone: 'warn' }),
      );
    },
  };

  /** What a page does once it is shown. */
  const after = {
    inbox: () => startInbox(),
  };

  /** @param {any[]} conversations */
  function conversationList(conversations) {
    return conversations.length
      ? html`<ul class="divide-y divide-slate-100 text-sm">${conversations.map(
          (c) =>
            html`<li class="flex items-center gap-2 py-2"><button type="button" class="flex-1 min-w-0 text-left truncate hover:underline" data-action="companion-conv-open" data-arg="${String(c.id)}">${String(c.title || '…')}</button>${classChip(c.dataClass)}<span class="text-xs text-slate-500">${when(c.updated)}</span><button type="button" class="btn btn-ghost p-1" data-action="companion-conv-delete" data-arg="${String(c.id)}" aria-label="${labelText(`${NS}.delete`)}" data-i18n-aria="${NS}.delete">${icon('trash-2', 'w-3.5 h-3.5')}</button></li>`,
        )}</ul>`
      : quiet(`${NS}.ask.no_conversations`);
  }

  async function refreshConversations() {
    const box = /** @type {HTMLElement | null} */ (el.querySelector('[data-cv="conversations"]'));
    if (!box) return;
    const list = await pairing.call('GET', '/v1/chat/conversations').catch(() => null);
    if (list && Array.isArray(list.conversations)) setHtml(box, String(conversationList(list.conversations.slice(0, 30))));
  }

  /** @param {any} rule */
  function ruleText(rule) {
    if (!rule || typeof rule !== 'object') return '';
    if (rule.type === 'once') return t(`${NS}.agenda.text_once`, { date: String(rule.date), time: String(rule.time) });
    if (rule.type === 'daily') return t(`${NS}.agenda.text_daily`, { time: String(rule.time) });
    if (rule.type === 'weekly') return t(`${NS}.agenda.text_weekly`, { days: (Array.isArray(rule.days) ? rule.days : []).map((/** @type {number} */ d) => t(`${NS}.agenda.day_${d}`)).join(', '), time: String(rule.time) });
    if (rule.type === 'monthly') return t(rule.day === 'last' ? `${NS}.agenda.text_monthly_last` : `${NS}.agenda.text_monthly`, { day: String(rule.day), time: String(rule.time) });
    return '';
  }

  // -------------------------------------------------------------------------------------------
  // Ask

  /** @param {Label} text @param {'warn' | 'info'} tone */
  const threadNotice = (text, tone) => html`<p class="text-xs">${line(text, tone)}</p>`;

  /**
   * One finished answer as it came from the companion.
   * @param {string} question
   * @param {import('./tier.js').CompanionAnswer} answer
   */
  function answerMarkup(question, answer) {
    const notice = noticeKey(answer.notice);
    const checked = answer.mode === 'sources' && answer.source === 'model';
    const badge = answer.source === 'template' ? provenanceBadge('withheld', { label: `${NS}.ask.label_template` }) : provenanceBadge(checked ? 'checked' : 'unchecked', { label: checked ? `${NS}.ask.label_checked` : `${NS}.ask.label_free` });
    const withheld = Array.isArray(answer.withheld) ? answer.withheld.length : 0;
    const sources = Array.isArray(answer.sources) ? answer.sources : [];
    return html`<div class="space-y-2" data-companion-turn>
      <p class="text-sm font-medium text-slate-900 whitespace-pre-wrap">${question}</p>
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
        <div class="flex flex-wrap items-center gap-1.5">${badge}${answer.locality && answer.locality !== 'none' ? chip({ label: hasKey(`${NS}.locality.${answer.locality}`) ? `${NS}.locality.${answer.locality}` : { text: String(answer.locality) }, tone: 'neutral', icon: answer.locality === 'cloud' ? 'cloud' : 'hard-drive' }) : ''}${answer.model ? html`<span class="text-xs font-mono text-slate-500">${String(answer.model)}</span>` : ''}</div>
        <div class="text-sm text-slate-800 whitespace-pre-wrap" data-companion-answer>${String(answer.text ?? '')}</div>
        ${notice ? threadNotice(notice, 'info') : ''}
        ${withheld ? threadNotice({ key: `${NS}.ask.withheld`, params: { n: formatNumber(withheld) } }, 'warn') : ''}
        ${sources.length ? html`<ul class="text-xs text-slate-600 space-y-0.5">${sources.map((src) => html`<li><span class="font-mono">${String(src.label)}</span> ${String(src.title ?? '')}</li>`)}</ul>` : ''}
      </div>
    </div>`;
  }

  async function runAsk() {
    const field = /** @type {HTMLTextAreaElement | null} */ (el.querySelector('[data-companion-field="question"]'));
    const thread = /** @type {HTMLElement | null} */ (el.querySelector('[data-cv="thread"]'));
    const question = field?.value.trim() ?? '';
    if (!field || !thread || !question || ask.controller) return;
    const controller = new AbortController();
    ask.controller = controller;
    const stopBtn = el.querySelector('[data-action="companion-ask-stop"]');
    stopBtn?.classList.remove('hidden');
    const turn = document.createElement('div');
    turn.className = 'space-y-2';
    setHtml(turn, String(html`<p class="text-sm font-medium text-slate-900 whitespace-pre-wrap">${question}</p><div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 whitespace-pre-wrap" data-companion-live aria-live="polite">${line(`${NS}.ask.waiting`, 'neutral')}</div>`));
    thread.append(turn);
    field.value = '';
    /** @type {string[]} */
    const units = [];
    const live = /** @type {HTMLElement} */ (turn.querySelector('[data-companion-live]'));
    const show = () => {
      live.textContent = units.join(' ');
    };
    try {
      const done = await streamCompanion(
        pairing,
        { question, mode: ask.mode, conversation: ask.conversation, signal: controller.signal },
        {
          onUnit(unit) {
            units.push(unit.text);
            show();
          },
          onReset(e) {
            units.splice(Math.max(0, units.length - (Number(e.withdrawn) || units.length)));
            show();
          },
          onApproval(a) {
            const card = document.createElement('div');
            card.className = 'rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs space-y-2';
            setHtml(card, String(html`${label({ key: `${NS}.ask.approval`, params: { tool: `${a.server}.${a.tool}` } }, { tag: 'p' })}<div class="flex gap-2"><button type="button" class="btn btn-primary py-1" data-action="companion-approval" data-arg="${String(a.id)}|approve">${label(`${NS}.connectors.approve_call`)}</button><button type="button" class="btn btn-ghost py-1" data-action="companion-approval" data-arg="${String(a.id)}|deny">${label(`${NS}.connectors.deny_call`)}</button></div>`));
            turn.append(card);
          },
        },
      );
      ask.conversation = done.conversation;
      setHtml(turn, String(answerMarkup(question, done.answer)));
      void refreshConversations();
    } catch (err) {
      live.textContent = units.join(' ');
      turn.insertAdjacentHTML('beforeend', String(threadNotice(err instanceof CompanionError && err.code === 'aborted' ? `${NS}.ask.stopped` : errorLabel(err), 'warn')));
    } finally {
      ask.controller = null;
      stopBtn?.classList.add('hidden');
    }
  }

  /** @param {string} id */
  async function openConversation(id) {
    const r = await pairing.call('GET', `/v1/chat/conversations/${encodeURIComponent(id)}`);
    ask.conversation = String(r.conversation?.id ?? id);
    await showPage({ quiet: true });
    const thread = /** @type {HTMLElement | null} */ (el.querySelector('[data-cv="thread"]'));
    if (thread) setHtml(thread, String(html`${(Array.isArray(r.turns) ? r.turns : []).map((/** @type {any} */ turn) => answerMarkup(String(turn.question ?? ''), turn.answer ?? {}))}`));
  }

  // -------------------------------------------------------------------------------------------
  // Inbox

  function renderInbox() {
    const list = /** @type {HTMLElement | null} */ (el.querySelector('[data-cv="inbox-list"]'));
    if (!list) return;
    const items = [...inbox.items.values()].sort((a, b) => b.seq - a.seq);
    setHtml(
      list,
      String(
        items.length
          ? html`${items.map(
              (n) =>
                html`<li class="flex flex-wrap items-center gap-2 py-2${n.read ? ' opacity-70' : ''}" data-companion-notification="${String(n.id)}">${n.read ? icon('check', 'w-3.5 h-3.5 text-slate-400') : icon('info', 'w-3.5 h-3.5 text-amber-600')}<span class="flex-1 min-w-0 truncate">${label(hasKey(`${NS}.inbox.kind_${n.kind}`) ? { key: `${NS}.inbox.kind_${n.kind}`, params: { title: String(n.title ?? '') } } : { key: `${NS}.inbox.kind_other`, params: { title: String(n.title ?? n.kind) } })}</span><span class="text-xs text-slate-500">${when(n.at)}</span>${n.read ? '' : html`<button type="button" class="btn btn-ghost py-1" data-action="companion-inbox-read" data-arg="${String(n.id)}">${label(`${NS}.inbox.read`)}</button>`}<button type="button" class="btn btn-ghost p-1" data-action="companion-inbox-delete" data-arg="${String(n.id)}" aria-label="${labelText(`${NS}.delete`)}" data-i18n-aria="${NS}.delete">${icon('trash-2', 'w-3.5 h-3.5')}</button></li>`,
            )}`
          : html`<li class="py-2">${quiet(`${NS}.inbox.empty`)}</li>`,
      ),
    );
  }

  function startInbox() {
    if (inbox.controller || page !== 'inbox' || !visible() || pairing.state().phase !== 'paired') return;
    const controller = new AbortController();
    inbox.controller = controller;
    const status = (/** @type {Label} */ text, /** @type {'ok' | 'warn' | 'info' | 'neutral'} */ tone) => {
      const out = /** @type {HTMLElement | null} */ (el.querySelector('[data-cv="inbox-state"]'));
      if (out) setHtml(out, String(line(text, tone)));
    };
    renderInbox();
    status(`${NS}.inbox.connecting`, 'neutral');
    void pairing
      .stream('GET', '/v1/notify/stream', {
        query: { after: inbox.after },
        signal: controller.signal,
        onEvent(event, data) {
          if (event === 'hello') {
            if (data?.reset) {
              inbox.items.clear();
              inbox.after = 0;
            }
            inbox.retry = 0;
            status(`${NS}.inbox.live`, 'ok');
          } else if (event === 'notification' && data && typeof data.id === 'string') {
            inbox.items.set(data.id, data);
            inbox.after = Math.max(inbox.after, Number(data.seq) || 0);
          }
          renderInbox();
        },
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        status(errorLabel(err), 'warn');
      })
      .finally(() => {
        if (inbox.controller !== controller) return;
        inbox.controller = null;
        if (controller.signal.aborted || page !== 'inbox' || !visible()) return;
        // The stream ended (the companion restarted, a network hiccup): try again, more slowly each time.
        inbox.retry = Math.min(inbox.retry + 1, 6);
        setTimeout(startInbox, 1000 * 2 ** inbox.retry);
      });
  }

  function stopInbox() {
    inbox.controller?.abort();
    inbox.controller = null;
  }

  // -------------------------------------------------------------------------------------------
  // Actions

  /**
   * Runs an action that changes something on the companion, then shows the page again.
   * @param {() => Promise<unknown>} fn
   * @param {Label} [done]
   */
  async function change(fn, done) {
    try {
      await fn();
      if (done) services.toast(done, { tone: 'ok' });
      await showPage({ quiet: true });
    } catch (err) {
      services.toast(errorLabel(err), { tone: 'warn' });
    }
  }

  services.onAction('companion-page', (btn) => {
    const next = btn.dataset.arg ?? 'status';
    if (!pages().some((p) => p.id === next) || next === page) return;
    page = next;
    setSegmentedValue(btn.closest('.segmented'), page);
    void showPage();
  });
  services.onAction('companion-reload', () => void showPage());
  services.onAction('companion-to-settings', () => services.switchTab('settings'));
  services.onAction('companion-ask-mode', (btn) => {
    ask.mode = btn.dataset.arg === 'free' ? 'free' : 'sources';
    setSegmentedValue(btn.closest('.segmented'), ask.mode);
  });
  services.onAction('companion-ask', () => void runAsk());
  services.onAction('companion-ask-stop', () => ask.controller?.abort());
  services.onAction('companion-ask-new', () => {
    ask.controller?.abort();
    ask.conversation = null;
    void showPage({ quiet: true });
  });
  services.onAction('companion-conv-open', (btn) => void openConversation(btn.dataset.arg ?? '').catch((err) => services.toast(errorLabel(err), { tone: 'warn' })));
  services.onAction('companion-conv-delete', (btn) => {
    const id = btn.dataset.arg ?? '';
    if (!confirmAction(t(`${NS}.ask.delete_confirm`))) return;
    if (ask.conversation === id) ask.conversation = null;
    void change(() => pairing.call('DELETE', `/v1/chat/conversations/${encodeURIComponent(id)}`));
  });
  services.onAction('companion-approval', (btn) => {
    const [id, decision] = String(btn.dataset.arg ?? '').split('|');
    void decideApproval(pairing, id, decision === 'approve' ? 'approve' : 'deny')
      .then(() => {
        btn.closest('li, div.rounded-lg')?.remove();
        if (page === 'connectors') void showPage({ quiet: true });
      })
      .catch((err) => services.toast(errorLabel(err), { tone: 'warn' }));
  });

  services.onChange('companion-doc-upload', (input) => {
    const file = /** @type {HTMLInputElement} */ (input).files?.[0];
    /** @type {HTMLInputElement} */ (input).value = '';
    if (!file) return;
    const out = /** @type {HTMLElement | null} */ (el.querySelector('[data-cv="upload-result"]'));
    const dataClass = /** @type {HTMLSelectElement | null} */ (el.querySelector('#companionDocClass'))?.value ?? 'personal';
    if (out) setHtml(out, String(line({ key: `${NS}.docs.uploading`, params: { name: file.name } }, 'neutral')));
    void pairing
      .call('POST', '/v1/docs', { query: { name: file.name.slice(0, 255), class: dataClass }, raw: { type: UPLOAD_TYPES.has(file.type) ? file.type : 'application/octet-stream', data: file }, timeoutMs: 120_000 })
      .then((r) => change(async () => {}, r?.duplicate ? `${NS}.docs.duplicate` : `${NS}.docs.uploaded`))
      .catch((err) => out && setHtml(out, String(line(errorLabel(err), 'warn'))));
  });
  services.onAction('companion-doc-delete', (btn) => {
    if (!confirmAction(t(`${NS}.docs.delete_confirm`))) return;
    void change(() => pairing.call('DELETE', `/v1/docs/${encodeURIComponent(btn.dataset.arg ?? '')}`));
  });
  services.onAction('companion-doc-download', async (btn) => {
    const client = pairing.client();
    const id = btn.dataset.arg ?? '';
    if (!client) return;
    try {
      const name = btn.closest('[data-companion-doc]')?.querySelector('.font-medium')?.textContent ?? 'document';
      const blob = await client.blob(`/v1/docs/${encodeURIComponent(id)}/file`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      services.toast(errorLabel(err), { tone: 'warn' });
    }
  });

  services.onAction('companion-note-add', () => {
    const form = el.querySelector('[data-companion-note-form]');
    const value = (/** @type {string} */ name) => /** @type {HTMLInputElement | null} */ (form?.querySelector(`[data-companion-field="${name}"]`))?.value ?? '';
    const text = value('text').trim();
    const out = /** @type {HTMLElement | null} */ (el.querySelector('[data-cv="note-result"]'));
    if (!text) {
      if (out) setHtml(out, String(line(`${NS}.notes.need_text`, 'warn')));
      return;
    }
    void change(() => pairing.call('POST', '/v1/memory/notes', { body: { text, ...(value('title').trim() ? { title: value('title').trim() } : {}), dataClass: value('class') || 'personal' } }), `${NS}.notes.saved`);
  });
  services.onAction('companion-note-open', async (btn) => {
    const li = btn.closest('[data-companion-note]');
    const box = /** @type {HTMLElement | null} */ (li?.querySelector('[data-note-text]') ?? null);
    if (!box) return;
    if (!box.classList.contains('hidden')) {
      box.classList.add('hidden');
      return;
    }
    try {
      const r = await pairing.call('GET', `/v1/memory/notes/${encodeURIComponent(btn.dataset.arg ?? '')}`);
      box.textContent = String(r.note?.text ?? '');
      box.classList.remove('hidden');
    } catch (err) {
      services.toast(errorLabel(err), { tone: 'warn' });
    }
  });
  services.onAction('companion-note-delete', (btn) => {
    if (!confirmAction(t(`${NS}.notes.delete_confirm`))) return;
    void change(() => pairing.call('DELETE', `/v1/memory/notes/${encodeURIComponent(btn.dataset.arg ?? '')}`));
  });

  services.onAction('companion-agenda-add', () => {
    const form = el.querySelector('[data-companion-agenda-form]');
    const value = (/** @type {string} */ name) => /** @type {HTMLInputElement | null} */ (form?.querySelector(`[data-companion-field="${name}"]`))?.value ?? '';
    const out = /** @type {HTMLElement | null} */ (el.querySelector('[data-cv="agenda-result"]'));
    const title = value('title').trim();
    const type = value('rule');
    const time = value('time') || '09:00';
    /** @type {Record<string, unknown>} */
    let rule = { type: 'daily', time };
    if (type === 'once') rule = { type, date: value('date'), time };
    else if (type === 'weekly') rule = { type, days: [...(form?.querySelectorAll('[data-companion-weekday]') ?? [])].filter((c) => /** @type {HTMLInputElement} */ (c).checked).map((c) => Number(/** @type {HTMLElement} */ (c).dataset.companionWeekday)), time };
    else if (type === 'monthly') rule = { type, day: Number(value('day')) || 1, time };
    if (!title || (type === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(String(rule.date))) || (type === 'weekly' && !(/** @type {number[]} */ (rule.days).length))) {
      if (out) setHtml(out, String(line(`${NS}.agenda.incomplete`, 'warn')));
      return;
    }
    void change(() => pairing.call('POST', '/v1/agenda', { body: { title, rule } }), `${NS}.agenda.saved`);
  });
  services.onAction('companion-agenda-delete', (btn) => {
    if (!confirmAction(t(`${NS}.agenda.delete_confirm`))) return;
    void change(() => pairing.call('DELETE', `/v1/agenda/${encodeURIComponent(btn.dataset.arg ?? '')}`));
  });

  services.onAction('companion-inbox-read', (btn) => {
    const id = btn.dataset.arg ?? '';
    void pairing
      .call('POST', `/v1/notify/${encodeURIComponent(id)}/read`)
      .then((r) => {
        if (r?.notification) inbox.items.set(id, r.notification);
        renderInbox();
      })
      .catch((err) => services.toast(errorLabel(err), { tone: 'warn' }));
  });
  services.onAction('companion-inbox-read-all', () => {
    void pairing
      .call('POST', '/v1/notify/read-all')
      .then(() => {
        for (const n of inbox.items.values()) n.read = true;
        renderInbox();
      })
      .catch((err) => services.toast(errorLabel(err), { tone: 'warn' }));
  });
  services.onAction('companion-inbox-delete', (btn) => {
    const id = btn.dataset.arg ?? '';
    void pairing
      .call('DELETE', `/v1/notify/${encodeURIComponent(id)}`)
      .then(() => {
        inbox.items.delete(id);
        renderInbox();
      })
      .catch((err) => services.toast(errorLabel(err), { tone: 'warn' }));
  });

  services.onAction('companion-connector-refresh', (btn) => void change(() => pairing.call('POST', `/v1/connectors/${encodeURIComponent(btn.dataset.arg ?? '')}/refresh`, { timeoutMs: 60_000 })));
  services.onAction('companion-tool-approve', (btn) => {
    const [server, tool, pin] = String(btn.dataset.arg ?? '').split('|');
    if (!confirmAction(t(`${NS}.connectors.approve_confirm`, { tool: `${server}.${tool}` }))) return;
    void change(() => pairing.call('POST', `/v1/connectors/${encodeURIComponent(server)}/approve`, { body: { tool, pin, calls: 'ask' } }));
  });
  services.onAction('companion-tool-revoke', (btn) => {
    const [server, tool] = String(btn.dataset.arg ?? '').split('|');
    void change(() => pairing.call('POST', `/v1/connectors/${encodeURIComponent(server)}/revoke`, { body: { tool } }));
  });

  services.onAction('companion-audit-verify', async () => {
    const out = /** @type {HTMLElement | null} */ (el.querySelector('[data-cv="verify-result"]'));
    if (out) setHtml(out, String(line(`${NS}.audit.verifying`, 'neutral')));
    try {
      const { report } = await pairing.call('GET', '/v1/audit/verify', { timeoutMs: 120_000 });
      const findings = Array.isArray(report?.findings) ? report.findings.length : 0;
      if (out) setHtml(out, String(line(report?.ok ? { key: `${NS}.audit.verified`, params: { n: formatNumber(Number(report.records) || 0) } } : { key: `${NS}.audit.findings`, params: { n: formatNumber(findings) } }, report?.ok ? 'ok' : 'danger')));
    } catch (err) {
      if (out) setHtml(out, String(line(errorLabel(err), 'warn')));
    }
  });

  services.onAction('companion-session-revoke', (btn) => {
    if (!confirmAction(t(`${NS}.devices.revoke_confirm`))) return;
    void change(() => pairing.call('DELETE', `/v1/sessions/${encodeURIComponent(btn.dataset.arg ?? '')}`));
  });
  services.onAction('companion-mcp-add', () => {
    const name = /** @type {HTMLInputElement | null} */ (el.querySelector('[data-companion-field="mcp-label"]'))?.value.trim() ?? '';
    if (!name) return;
    void change(async () => {
      const made = await pairing.call('POST', '/v1/mcp/clients', { body: { label: name } });
      freshToken = typeof made?.token === 'string' ? { label: name, token: made.token } : null;
    });
  });
  services.onAction('companion-mcp-revoke', (btn) => {
    if (!confirmAction(t(`${NS}.devices.revoke_confirm`))) return;
    freshToken = null;
    void change(() => pairing.call('DELETE', `/v1/mcp/clients/${encodeURIComponent(btn.dataset.arg ?? '')}`));
  });
  services.onAction('companion-setup-fresh', () => void change(() => pairing.call('GET', '/v1/setup', { query: { fresh: 1 }, timeoutMs: 60_000 })));

  // -------------------------------------------------------------------------------------------
  // Life cycle

  pairing.subscribe(() => renderChrome());
  services.onTabOpen('companion', () => {
    headShape = '';
    renderChrome({ reload: true });
  });
  services.onLocaleChange(() => {
    headShape = '';
    renderChrome({ reload: visible() });
  });
  // Leaving the tab ends the inbox stream; nothing runs while the tab is hidden.
  new MutationObserver(() => {
    if (!visible()) {
      stopInbox();
      ask.controller?.abort();
    }
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
  renderChrome();
}
