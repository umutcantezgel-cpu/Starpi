// @ts-check
// Settings → Trust: the key this device signs answer receipts with (trust/signing.js). One card with
// - the "Sign exported receipts" switch;
// - the signing key: algorithm, full key id and creation date, export of the public key as JWK or
//   PEM, rotate and delete (or "create" while there is none);
// - earlier keys after a rotation, whose public keys can still be exported or deleted;
// - how someone else checks a signed receipt with the exported public key.
//
// The card renders once; a change of the signer re-renders only the key parts. Every text is an
// i18n key (data-i18n); dates follow the language, key ids are literal.
import { downloadText, setHtml } from '../dom.js';
import { formatDate } from '../i18n/index.js';
import { html, icon, label, labelText, raw } from '../ui/kit.js';
import { receiptSigner, SigningError } from './signing.js';

/** @typedef {import('./signing.js').ReceiptSignerApi} ReceiptSignerApi */
/** @typedef {import('./signing.js').SigningKeyInfo} SigningKeyInfo */
/** @typedef {import('./signing.js').SigningState} SigningState */
/** @typedef {import('../ui/kit.js').Label} Label */
/** @typedef {import('../ui/kit.js').Tone} Tone */

/**
 * The shell services the view uses (features/registry.js).
 * @typedef {object} ViewServices
 * @property {(name: string, handler: (el: HTMLElement, event: Event) => unknown) => void} onAction
 * @property {(name: string, handler: (el: HTMLElement, event: Event) => unknown) => void} onChange
 * @property {(fn: () => void) => unknown} [onLocaleChange]
 */

/**
 * What the view reads and changes; the defaults are the app's own.
 * @typedef {object} ViewDeps
 * @property {ReceiptSignerApi} [signer]
 * @property {(message: string) => boolean} [confirm]
 * @property {(name: string, text: string, type: string) => void} [download]
 */

const NS = 'trust';

/** @param {number} at */
const dateOf = (at) => formatDate(new Date(at), { dateStyle: 'medium', timeStyle: 'short' });

/**
 * @param {Label} text
 * @param {Tone} tone
 */
function resultLine(text, tone) {
  const iconName = { ok: 'check-circle-2', warn: 'triangle-alert', danger: 'octagon-alert', info: 'info', neutral: 'loader-2' }[tone];
  return html`<span class="flex items-start gap-1.5" data-tone="${tone}">${icon(iconName, 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(text)}</span>`;
}

/**
 * The text of a failed signer call.
 * @param {unknown} err
 * @returns {Label}
 */
function errorLabel(err) {
  return err instanceof SigningError ? `${NS}.error.${err.code}` : `${NS}.error.storage`;
}

/**
 * Builds the view into `el` and wires its actions. Returns a handle for tests and for a refresh.
 * @param {HTMLElement} el
 * @param {ViewServices} services
 * @param {ViewDeps} [deps]
 */
export function mountTrustView(el, services, deps = {}) {
  const signer = deps.signer ?? receiptSigner;
  const confirmAction = deps.confirm ?? ((/** @type {string} */ message) => globalThis.confirm?.(message) ?? false);
  const download = deps.download ?? downloadText;

  /** @param {string} selector */
  const part = (selector) => /** @type {HTMLElement | null} */ (el.querySelector(selector));

  // -------------------------------------------------------------------------------------------
  // Markup

  /** @param {SigningState} s */
  function statusChip(s) {
    const [key, tone, iconName] = !s.available
      ? ['unavailable', 'neutral', 'circle-dashed']
      : !s.enabled
        ? ['off', 'neutral', 'circle-dashed']
        : s.active
          ? ['on', 'ok', 'shield-check']
          : ['ready', 'info', 'shield'];
    return html`<span class="chip chip-${tone}" data-trust-state="${key}">${icon(iconName, '')}${label(`${NS}.state.${key}`)}</span>`;
  }

  /**
   * Export and delete buttons of a key.
   * @param {SigningKeyInfo} key
   */
  function exportButtons(key) {
    return html`<button type="button" class="btn btn-secondary py-1" data-action="trust-export-jwk" data-arg="${key.id}">${icon('download', 'w-3.5 h-3.5')}${label(`${NS}.key.export_jwk`)}</button>
      <button type="button" class="btn btn-secondary py-1" data-action="trust-export-pem" data-arg="${key.id}">${icon('download', 'w-3.5 h-3.5')}${label(`${NS}.key.export_pem`)}</button>`;
  }

  /**
   * Algorithm, key id and dates of a key.
   * @param {SigningKeyInfo} key
   */
  function keyFacts(key) {
    return html`<dl class="grid gap-1.5 text-xs">
      <div class="flex flex-wrap items-baseline gap-x-2"><dt class="text-slate-600">${label(`${NS}.key.alg`)}</dt><dd class="font-medium text-slate-900" data-trust="alg">${key.alg}</dd></div>
      <div class="flex flex-wrap items-baseline gap-x-2 min-w-0"><dt class="text-slate-600">${label(`${NS}.key.id`)}</dt><dd class="font-mono text-slate-900 break-all select-all" data-trust="key-id">${key.id}</dd></div>
      <div class="flex flex-wrap items-baseline gap-x-2"><dt class="text-slate-600">${label(`${NS}.key.created`)}</dt><dd class="text-slate-900">${dateOf(key.createdAt)}</dd></div>
      ${key.retiredAt !== null ? html`<div class="flex flex-wrap items-baseline gap-x-2"><dt class="text-slate-600">${label(`${NS}.key.retired`)}</dt><dd class="text-slate-900">${dateOf(key.retiredAt)}</dd></div>` : ''}
    </dl>`;
  }

  /** @param {SigningState} s */
  function keyMarkup(s) {
    const heading = label(`${NS}.key.title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800', id: 'tvKeyTitle' });
    if (!s.available) return html`${heading}${label(`${NS}.key.unavailable`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}`;
    if (!s.active) {
      return html`${heading}${label(`${NS}.key.none`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}
        <div class="flex flex-wrap gap-2"><button type="button" class="btn btn-primary" data-action="trust-create">${icon('plus', 'w-3.5 h-3.5')}${label(`${NS}.key.create`)}</button></div>`;
    }
    const key = s.active;
    return html`${heading}<div class="space-y-2" data-trust-key="${key.id}">
      ${keyFacts(key)}
      <div class="flex flex-wrap gap-2">
        ${exportButtons(key)}
        <button type="button" class="btn btn-ghost py-1" data-action="trust-rotate">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.key.rotate`)}</button>
        <button type="button" class="btn btn-ghost py-1 text-rose-700" data-action="trust-delete" data-arg="${key.id}">${icon('trash-2', 'w-3.5 h-3.5')}${label(`${NS}.key.delete`)}</button>
      </div>
    </div>`;
  }

  /** @param {SigningState} s */
  function retiredMarkup(s) {
    if (s.retired.length === 0) return '';
    return html`<div class="space-y-2 pt-3 border-t border-slate-100">
      ${label(`${NS}.retired.title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}
      ${label(`${NS}.retired.body`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}
      <ul class="space-y-3">${s.retired.map(
        (key) => html`<li class="space-y-2 p-2.5 rounded-lg bg-slate-50 border border-slate-200" data-trust-retired="${key.id}">
          ${keyFacts(key)}
          <div class="flex flex-wrap gap-2">${exportButtons(key)}<button type="button" class="btn btn-ghost py-1 text-rose-700" data-action="trust-delete" data-arg="${key.id}">${icon('trash-2', 'w-3.5 h-3.5')}${label(`${NS}.key.delete`)}</button></div>
        </li>`,
      )}</ul>
    </div>`;
  }

  /** @param {SigningState} s */
  function noteMarkup(s) {
    return s.available && !s.persistent ? html`<p class="flex items-start gap-1.5 text-xs text-amber-800" role="note">${icon('triangle-alert', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(`${NS}.key.not_persistent`)}</p>` : '';
  }

  function render() {
    const s = signer.state();
    setHtml(
      el,
      html`<div class="card p-4 sm:p-5 space-y-4" data-tv-root>
        <div class="card-header">
          <h3 class="card-title">${icon('shield-check', 'w-4 h-4 text-emerald-600')}${label(`${NS}.title`)}</h3>
          <span data-tv="chip">${statusChip(s)}</span>
        </div>
        ${label(`${NS}.subtitle`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed -mt-2' })}
        <section class="space-y-2">
          <label class="flex items-start gap-2 text-sm text-slate-800 cursor-pointer select-none">
            <input type="checkbox" id="tvSign" class="mt-0.5 rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-change="trust-sign"${s.enabled ? raw(' checked') : ''}${s.available ? '' : raw(' disabled')}>
            ${label(`${NS}.sign.label`)}
          </label>
          ${label(`${NS}.sign.hint`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
        </section>
        <section class="space-y-2 pt-3 border-t border-slate-100" data-tv="key" aria-labelledby="tvKeyTitle">${keyMarkup(s)}</section>
        <div data-tv="note">${noteMarkup(s)}</div>
        <div data-tv="retired">${retiredMarkup(s)}</div>
        <p class="text-xs min-w-0" role="status" aria-live="polite" data-tv="result"></p>
        <div class="space-y-1.5 pt-3 border-t border-slate-100 text-xs text-slate-600">
          ${label(`${NS}.check.title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}
          ${label(`${NS}.check.body`, { tag: 'p', className: 'leading-relaxed' })}
          <pre class="p-2.5 rounded-lg bg-slate-50 border border-slate-200 font-mono text-[11px] text-slate-800 whitespace-pre-wrap break-all">npx -p @starpi/core starpi-verify-receipt receipt.json &lt;files&gt; --public-key starpi-signing-key.pem --require-signature</pre>
        </div>
      </div>`.value,
    );
  }

  /**
   * @param {string} selector
   * @param {import('../ui/kit.js').SafeHtml | string} markup
   */
  const fill = (selector, markup) => {
    const target = part(selector);
    if (target) setHtml(target, String(markup));
  };

  function refresh() {
    const s = signer.state();
    fill('[data-tv="chip"]', statusChip(s));
    fill('[data-tv="key"]', keyMarkup(s));
    fill('[data-tv="note"]', noteMarkup(s));
    fill('[data-tv="retired"]', retiredMarkup(s));
    const box = /** @type {HTMLInputElement | null} */ (el.querySelector('#tvSign'));
    if (box) {
      box.checked = s.enabled;
      box.disabled = !s.available;
    }
  }

  /**
   * @param {Label} text
   * @param {Tone} tone
   */
  const report = (text, tone) => fill('[data-tv="result"]', resultLine(text, tone));

  // -------------------------------------------------------------------------------------------
  // Actions

  /** @param {HTMLElement} target */
  const argOf = (target) => target.dataset.arg ?? '';

  /**
   * @param {() => Promise<unknown>} fn
   * @param {Label} done
   */
  async function run(fn, done) {
    try {
      await fn();
      report(done, 'ok');
    } catch (err) {
      report(errorLabel(err), 'danger');
    }
  }

  /**
   * @param {string} id
   * @param {'jwk' | 'pem'} format
   */
  async function exportKey(id, format) {
    try {
      const file = await signer.exportPublicKey(id, format);
      download(file.name, file.text, file.type);
      report({ key: `${NS}.result.exported`, params: { file: file.name } }, 'ok');
    } catch (err) {
      report(errorLabel(err), 'danger');
    }
  }

  services.onChange('trust-sign', async (target) => {
    const on = /** @type {HTMLInputElement} */ (target).checked;
    const stored = await signer.setEnabled(on);
    report(stored ? (on ? `${NS}.result.sign_on` : `${NS}.result.sign_off`) : `${NS}.result.sign_page`, stored ? 'ok' : 'warn');
  });
  services.onAction('trust-create', () => run(() => signer.createKey(), `${NS}.result.created`));
  services.onAction('trust-rotate', () => {
    if (!confirmAction(labelText(`${NS}.key.rotate_confirm`))) return undefined;
    return run(() => signer.rotate(), `${NS}.result.rotated`);
  });
  services.onAction('trust-delete', (target) => {
    const id = argOf(target);
    const active = signer.state().active?.id === id;
    if (!confirmAction(labelText(active ? `${NS}.key.delete_confirm` : `${NS}.retired.delete_confirm`))) return undefined;
    return run(() => signer.deleteKey(id), `${NS}.result.deleted`);
  });
  services.onAction('trust-export-jwk', (target) => exportKey(argOf(target), 'jwk'));
  services.onAction('trust-export-pem', (target) => exportKey(argOf(target), 'pem'));

  render();
  const unsubscribe = signer.onChange(() => refresh());
  // Dates are formatted for the language; the key parts render again when it changes.
  services.onLocaleChange?.(() => refresh());
  const loaded = signer.ready().then(() => refresh());

  return {
    /** Resolves when the keys and the setting have been read. */
    loaded,
    refresh,
    destroy() {
      unsubscribe();
    },
  };
}
