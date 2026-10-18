// @ts-check
// Settings → Chat sync: one card to turn the end-to-end encrypted sync on with a passphrase (or
// unlock an account that already syncs from another browser), see its state, sync now, and turn it
// off, with or without deleting the synced copy. A second part reaches the same account from another
// browser: add an email address to this browser's account, or sign in with one (a one-time code).
//
// The card renders in parts, so a status update never clears what the user is typing: the form is
// rebuilt only when the phase, the account or the connection changes. Every text is an i18n key.
import { setHtml } from '../dom.js';
import { formatDate, formatNumber } from '../i18n/index.js';
import { html, icon, label, labelText, raw } from '../ui/kit.js';
import { MIN_SYNC_PASSPHRASE_CHARS } from './crypto.js';

/** @typedef {import('./sync.js').ChatSync} ChatSync */
/** @typedef {import('./sync.js').SyncStatus} SyncStatus */
/** @typedef {import('./sync.js').SyncAccount} SyncAccount */
/** @typedef {import('./sync.js').EnableFailure} EnableFailure */
/** @typedef {import('../supabase.js').DataError} DataError */
/** @typedef {import('../supabase.js').ConnectionState} ConnectionState */
/** @typedef {import('../ui/kit.js').Label} Label */
/** @typedef {import('../ui/kit.js').Tone} Tone */
/**
 * @template T
 * @typedef {import('../supabase.js').Result<T>} Result
 */

/**
 * @typedef {object} ViewServices
 * @property {(name: string, handler: (el: HTMLElement, event: Event) => unknown) => void} onAction
 * @property {(fn: () => void) => unknown} [onLocaleChange]
 */

/**
 * The account calls of the data layer (supabase.js).
 * @typedef {object} AccountApi
 * @property {() => Promise<Result<SyncAccount>>} syncAccount
 * @property {(email: string, purpose: 'link' | 'sign_in') => Promise<Result<null>>} sendEmailCode
 * @property {(email: string, code: string, purpose: 'link' | 'sign_in') => Promise<Result<SyncAccount>>} verifyEmailCode
 * @property {() => Promise<Result<null>>} signOutAccount
 * @property {() => ConnectionState} getConnection
 * @property {(fn: (state: ConnectionState) => void) => unknown} onConnectionChange
 */

/**
 * @typedef {object} ViewDeps
 * @property {ChatSync} sync
 * @property {AccountApi} api
 * @property {(message: string) => boolean} [confirm]
 */

const NS = 'sync';
/** Error kinds of the data layer that have their own text. */
const OWN_TEXT = new Set(['invalid_email', 'invalid_code', 'email_taken', 'no_account', 'email_disabled', 'rate_limited', 'missing_schema']);

/**
 * The text of a failed data-layer call.
 * @param {DataError} error
 * @returns {string}
 */
function dataErrorKey(error) {
  if (error.kind === 'network' || error.kind === 'timeout') return `${NS}.error.offline`;
  if (error.kind === 'not_signed_in' || error.kind === 'auth_disabled') return `${NS}.error.no_session`;
  return OWN_TEXT.has(error.kind) ? `${NS}.error.${error.kind}` : `${NS}.error.failed`;
}

/**
 * @param {EnableFailure} reason
 * @returns {Label}
 */
function enableErrorLabel(reason) {
  if (reason === 'too_short') return { key: `${NS}.error.too_short`, params: { n: MIN_SYNC_PASSPHRASE_CHARS } };
  return reason === 'error' ? `${NS}.error.failed` : `${NS}.error.${reason}`;
}

/**
 * @param {Label} text
 * @param {Tone} tone
 */
function resultLine(text, tone) {
  const iconName = { ok: 'check-circle-2', warn: 'triangle-alert', danger: 'octagon-alert', info: 'info', neutral: 'loader-2' }[tone];
  return html`<span class="flex items-start gap-1.5" data-tone="${tone}">${icon(iconName, 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(text)}</span>`;
}

/**
 * Builds the view into `el` and wires its actions.
 * @param {HTMLElement} el
 * @param {ViewServices} services
 * @param {ViewDeps} deps
 */
export function mountSyncView(el, services, deps) {
  const { sync, api } = deps;
  const confirmAction = deps.confirm ?? ((/** @type {string} */ message) => globalThis.confirm?.(message) ?? false);

  /** Whether the account has a key envelope (sync set up in some browser); null: not known yet. */
  /** @type {boolean | null} */
  let accountHasSync = null;
  /** @type {SyncAccount | null} */
  let account = null;
  /** The address a code was sent to, and what for. */
  /** @type {{ email: string, purpose: 'link' | 'sign_in' } | null} */
  let codeFor = null;
  let bodyShape = '';
  let accountShape = '';
  let working = false;

  /** @param {string} selector */
  const part = (selector) => /** @type {HTMLElement | null} */ (el.querySelector(selector));
  /** @param {string} id */
  const field = (id) => /** @type {HTMLInputElement | null} */ (el.querySelector(`#${id}`));
  /**
   * @param {string} selector
   * @param {import('../ui/kit.js').SafeHtml | string} markup
   */
  const fill = (selector, markup) => {
    const target = part(selector);
    if (target) setHtml(target, String(markup));
  };
  /**
   * @param {Label} text
   * @param {Tone} tone
   */
  const report = (text, tone) => fill('[data-sv="result"]', resultLine(text, tone));

  const usable = () => {
    const c = api.getConnection();
    return c.status === 'ready' && c.signedIn;
  };

  // -------------------------------------------------------------------------------------------
  // Markup

  /** @param {SyncStatus} s */
  function chipMarkup(s) {
    const [key, tone, iconName] =
      s.phase === 'unavailable'
        ? ['unavailable', 'neutral', 'circle-dashed']
        : s.phase === 'off'
          ? ['off', 'neutral', 'circle-dashed']
          : s.phase !== 'on'
            ? ['attention', 'warn', 'triangle-alert']
            : s.busy
              ? ['busy', 'info', 'refresh-cw']
              : ['on', 'ok', 'shield-check'];
    return html`<span class="chip chip-${tone}" data-sync-state="${s.phase === 'on' && s.busy ? 'busy' : s.phase}">${icon(iconName, '')}${label(`${NS}.state.${key}`)}</span>`;
  }

  /**
   * The passphrase form: a new passphrase (twice) or the one of the account.
   * @param {boolean} join
   */
  function formMarkup(join) {
    const disabled = usable() ? '' : raw(' disabled');
    return html`<div class="space-y-3" data-sv-form="${join ? 'join' : 'new'}">
      ${label(join ? `${NS}.form.join_hint` : { key: `${NS}.form.new_hint`, params: { n: MIN_SYNC_PASSPHRASE_CHARS } }, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}
      <div>
        <label for="svPass" class="field-label">${label(`${NS}.form.passphrase`)}</label>
        <input type="password" id="svPass" class="field" autocomplete="${join ? 'current-password' : 'new-password'}" spellcheck="false"${disabled}>
      </div>
      ${
        join
          ? ''
          : html`<div>
        <label for="svPass2" class="field-label">${label(`${NS}.form.confirm`)}</label>
        <input type="password" id="svPass2" class="field" autocomplete="new-password" spellcheck="false"${disabled}>
      </div>`
      }
      <div class="flex flex-wrap gap-2"><button type="button" class="btn btn-primary" data-action="sync-enable"${disabled}>${icon('lock', 'w-3.5 h-3.5')}${label(join ? `${NS}.form.join` : `${NS}.form.enable`)}</button></div>
      ${usable() ? '' : label(`${NS}.form.connection`, { tag: 'p', className: 'text-xs text-amber-800' })}
    </div>`;
  }

  const offLocalButton = () => html`<button type="button" class="btn btn-ghost py-1" data-action="sync-off-local">${icon('x', 'w-3.5 h-3.5')}${label(`${NS}.on.off_local`)}</button>`;

  /** @param {SyncStatus} s */
  function summaryMarkup(s) {
    const last = s.lastSyncAt !== null ? label({ key: `${NS}.on.last`, params: { time: formatDate(new Date(s.lastSyncAt), { dateStyle: 'medium', timeStyle: 'short' }) } }) : label(`${NS}.on.never`);
    const error = s.error ? resultLine(s.error === 'network' || s.error === 'timeout' ? `${NS}.error.offline` : s.error === 'missing_schema' ? `${NS}.error.missing_schema` : `${NS}.error.failed`, 'warn') : '';
    return html`<p class="text-sm font-medium text-slate-800" data-sv="count">${label({ key: `${NS}.on.summary`, params: { n: formatNumber(s.conversations) } })}</p>
      <p class="text-xs text-slate-600">${last}</p>
      ${s.skipped > 0 ? label({ key: `${NS}.on.skipped`, params: { n: formatNumber(s.skipped) } }, { tag: 'p', className: 'text-xs text-amber-800' }) : ''}
      ${error ? html`<p class="text-xs">${error}</p>` : ''}`;
  }

  /** @param {SyncStatus} s */
  function bodyMarkup(s) {
    switch (s.phase) {
      case 'unavailable':
        return label(`${NS}.notice.unavailable`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' });
      case 'off':
        return formMarkup(accountHasSync === true);
      case 'on':
        return html`<div class="space-y-1" data-sv="summary">${summaryMarkup(s)}</div>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-secondary py-1" data-action="sync-now">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.on.sync_now`)}</button>
            ${offLocalButton()}
            <button type="button" class="btn btn-ghost py-1 text-rose-700" data-action="sync-off-delete">${icon('trash-2', 'w-3.5 h-3.5')}${label(`${NS}.on.off_delete`)}</button>
          </div>`;
      case 'remote_off':
      case 'rekeyed':
        return html`<p class="flex items-start gap-1.5 text-xs text-amber-800" role="note">${icon('triangle-alert', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(`${NS}.notice.${s.phase}`)}</p>
          ${formMarkup(s.phase === 'rekeyed')}
          <div class="flex flex-wrap gap-2">${offLocalButton()}</div>`;
      default:
        return html`<p class="flex items-start gap-1.5 text-xs text-amber-800" role="note">${icon('triangle-alert', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(`${NS}.notice.other_account`)}</p>
          <div class="flex flex-wrap gap-2">${offLocalButton()}</div>`;
    }
  }

  function accountMarkup() {
    const disabled = usable() ? '' : raw(' disabled');
    const who = account && !account.anonymous && account.email ? label({ key: `${NS}.account.signed_in`, params: { email: account.email } }) : label(`${NS}.account.anonymous`);
    const signedIn = Boolean(account && !account.anonymous);
    const code = codeFor
      ? html`<div class="space-y-2">
          <label for="svCode" class="field-label">${label(`${NS}.account.code`)}</label>
          <div class="flex flex-wrap gap-2">
            <input type="text" id="svCode" class="field flex-1 min-w-0 font-mono" inputmode="numeric" autocomplete="one-time-code" spellcheck="false"${disabled}>
            <button type="button" class="btn btn-secondary" data-action="sync-email-verify"${disabled}>${icon('check', 'w-3.5 h-3.5')}${label(`${NS}.account.verify`)}</button>
          </div>
        </div>`
      : '';
    return html`<details class="group pt-3 border-t border-slate-100" data-sv-account="${signedIn ? 'email' : 'anonymous'}">
      <summary class="flex items-center justify-between cursor-pointer text-sm font-semibold text-slate-800 select-none">
        <span class="flex items-center gap-2">${icon('user', 'w-4 h-4 text-amber-600')}${label(`${NS}.account.title`)}</span>
        ${icon('chevron-down', 'w-4 h-4 transition-transform group-open:rotate-180 text-slate-400')}
      </summary>
      <div class="mt-3 space-y-3">
        ${label(`${NS}.account.body`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}
        <p class="text-xs font-medium text-slate-800 break-all" data-sv="who">${who}</p>
        ${
          signedIn
            ? html`<div class="flex flex-wrap gap-2"><button type="button" class="btn btn-ghost py-1" data-action="sync-signout"${disabled}>${icon('x', 'w-3.5 h-3.5')}${label(`${NS}.account.sign_out`)}</button></div>`
            : html`<div class="space-y-2">
          <label for="svEmail" class="field-label">${label(`${NS}.account.email`)}</label>
          <input type="email" id="svEmail" class="field" autocomplete="email" spellcheck="false"${disabled}>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-secondary py-1" data-action="sync-email-link"${disabled}>${label(`${NS}.account.link`)}</button>
            <button type="button" class="btn btn-ghost py-1" data-action="sync-email-signin"${disabled}>${label(`${NS}.account.sign_in`)}</button>
          </div>
          ${label(`${NS}.account.sign_in_hint`, { tag: 'p', className: 'text-[11px] text-slate-500 leading-relaxed' })}
        </div>`
        }
        ${code}
      </div>
    </details>`;
  }

  function render() {
    setHtml(
      el,
      html`<div class="card p-4 sm:p-5 space-y-4" data-sv-root>
        <div class="card-header">
          <h3 class="card-title">${icon('cloud', 'w-4 h-4 text-emerald-600')}${label(`${NS}.card.title`)}</h3>
          <span data-sv="chip"></span>
        </div>
        ${label(`${NS}.card.subtitle`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed -mt-2' })}
        <section class="space-y-3" data-sv="body"></section>
        <p class="text-xs min-w-0" role="status" aria-live="polite" data-sv="result"></p>
        <div data-sv="account"></div>
      </div>`.value,
    );
    bodyShape = '';
    accountShape = '';
    refresh();
  }

  /** Updates the parts; rebuilds the form and the account part only when their shape changed. */
  function refresh() {
    const s = sync.status();
    fill('[data-sv="chip"]', chipMarkup(s));
    const shape = `${s.phase}|${accountHasSync}|${usable()}`;
    if (shape !== bodyShape) {
      bodyShape = shape;
      fill('[data-sv="body"]', bodyMarkup(s));
    } else if (s.phase === 'on') {
      fill('[data-sv="summary"]', summaryMarkup(s));
    }
    const shapeOfAccount = `${account?.userId}|${account?.email}|${account?.anonymous}|${codeFor?.email}|${codeFor?.purpose}|${usable()}`;
    if (shapeOfAccount !== accountShape) {
      const open = part('[data-sv="account"] details')?.hasAttribute('open') ?? false;
      accountShape = shapeOfAccount;
      fill('[data-sv="account"]', accountMarkup());
      if (open || codeFor) part('[data-sv="account"] details')?.setAttribute('open', '');
    }
    for (const button of el.querySelectorAll('button[data-action^="sync-"]')) if (working) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  /** Reads the account and whether it syncs already (when the connection allows). */
  async function probe() {
    if (!usable()) return;
    const [who, has] = await Promise.all([api.syncAccount(), sync.accountHasSync()]);
    account = who.ok ? who.data : account;
    accountHasSync = has.ok ? has.data : accountHasSync;
    refresh();
  }

  // -------------------------------------------------------------------------------------------
  // Actions

  /**
   * Runs one action at a time.
   * @param {() => Promise<void>} fn
   */
  async function act(fn) {
    if (working) return;
    working = true;
    refresh();
    try {
      await fn();
    } catch (err) {
      console.warn('[starpi] a sync action failed', err);
      report(`${NS}.error.failed`, 'danger');
    } finally {
      working = false;
      refresh();
    }
  }

  services.onAction('sync-enable', () =>
    act(async () => {
      const pass = field('svPass')?.value ?? '';
      const again = field('svPass2');
      if (again && again.value !== pass) {
        report(`${NS}.error.mismatch`, 'danger');
        return;
      }
      report(`${NS}.state.busy`, 'neutral');
      const res = await sync.enable(pass);
      if (!res.ok) {
        report(enableErrorLabel(res.reason), 'danger');
        return;
      }
      for (const input of [field('svPass'), again]) if (input) input.value = '';
      accountHasSync = true;
      report(res.joined ? `${NS}.result.joined` : `${NS}.result.enabled`, 'ok');
    }),
  );

  services.onAction('sync-now', () =>
    act(async () => {
      const done = await sync.syncNow();
      const s = sync.status();
      if (done) report(`${NS}.result.synced`, 'ok');
      else if (s.phase === 'on') report(s.error === 'network' || s.error === 'timeout' ? `${NS}.error.offline` : `${NS}.error.failed`, 'warn');
    }),
  );

  services.onAction('sync-off-local', () => {
    if (!confirmAction(labelText(`${NS}.on.off_local_confirm`))) return undefined;
    return act(async () => {
      await sync.disable({ deleteRemote: false });
      report(`${NS}.result.off`, 'ok');
    });
  });

  services.onAction('sync-off-delete', () => {
    if (!confirmAction(labelText(`${NS}.on.off_delete_confirm`))) return undefined;
    return act(async () => {
      if (await sync.disable({ deleteRemote: true })) {
        accountHasSync = false;
        report(`${NS}.result.deleted`, 'ok');
      } else {
        report(`${NS}.error.delete_failed`, 'danger');
      }
    });
  });

  /** @param {'link' | 'sign_in'} purpose */
  const sendCode = (purpose) =>
    act(async () => {
      const email = (field('svEmail')?.value ?? '').trim();
      const res = await api.sendEmailCode(email, purpose);
      if (!res.ok) {
        report(dataErrorKey(res.error), 'danger');
        return;
      }
      codeFor = { email, purpose };
      report({ key: `${NS}.result.code_sent`, params: { email } }, 'ok');
    });
  services.onAction('sync-email-link', () => sendCode('link'));
  services.onAction('sync-email-signin', () => sendCode('sign_in'));

  services.onAction('sync-email-verify', () =>
    act(async () => {
      if (!codeFor) return;
      const res = await api.verifyEmailCode(codeFor.email, field('svCode')?.value ?? '', codeFor.purpose);
      if (!res.ok) {
        report(dataErrorKey(res.error), 'danger');
        return;
      }
      const purpose = codeFor.purpose;
      codeFor = null;
      account = res.data;
      report(purpose === 'link' ? `${NS}.result.linked` : `${NS}.result.signed_in`, 'ok');
      // Another account may sync already, or this browser's sync may belong to the old one.
      accountHasSync = null;
      await probe();
      if (sync.status().phase !== 'off') await sync.syncNow();
    }),
  );

  services.onAction('sync-signout', () =>
    act(async () => {
      const res = await api.signOutAccount();
      if (!res.ok) {
        report(dataErrorKey(res.error), 'danger');
        return;
      }
      report(`${NS}.result.signed_out`, 'ok');
      account = null;
      accountHasSync = null;
      await probe();
      if (sync.status().phase !== 'off') await sync.syncNow();
    }),
  );

  render();
  const offStatus = sync.onStatus(() => refresh());
  api.onConnectionChange(() => {
    refresh();
    void probe();
  });
  // Numbers and dates follow the language (the other texts relabel themselves).
  services.onLocaleChange?.(() => refresh());
  const loaded = sync.ready().then(async () => {
    refresh();
    await probe();
  });

  return {
    /** Resolves once the state and (when connected) the account were read. */
    loaded,
    refresh,
    probe,
    destroy() {
      offStatus();
    },
  };
}
