// @ts-check
// Settings → Model providers and keys. One card with:
// - the key vault: set a passphrase, unlock, lock now, forget all keys (ai/keys.js);
// - the site's access code, when GET /api/health says the site asks for one;
// - the relay switch for providers that block browsers, and the free models the site's pools offer;
// - one row per provider: key status, the way a call would go, a masked key field with the format
//   hint from the catalog, keep-in-vault, test (GET /models; shows ok or an error code, never the
//   provider's text) and remove;
// - your own server: URL presets, an optional key, the cross-origin setting per server and the
//   browser's local-network permission.
//
// The card renders once; keys, vault and pool changes re-render only the parts that show them, so a
// half-typed key or an open row survives. Every text is an i18n key (data-i18n), proper names are
// literal.
import { setHtml } from '../dom.js';
import { t } from '../i18n/index.js';
import { getPool } from '../ai/catalog/pools.js';
import { getProvider, keyLooksValid, LOCAL_SERVER_PRESETS, presetEndpoint, PROVIDER_ORDER } from '../ai/catalog/providers.js';
import { healthClient } from '../ai/health-client.js';
import { ACCESS_SLOT, KeyStoreError, keyStore, MIN_PASSPHRASE_CHARS } from '../ai/keys.js';
import { fetchPools, forgetTransports, planTransport, poolAvailable, relayEnabled, setRelayEnabled, testKey } from '../ai/transport-select.js';
import { getLlmUrl, setLlmUrl } from '../state.js';
import { normalizeServerUrl } from '../providers.js';
import { html, icon, label, labelText, raw } from '../ui/kit.js';

/** @typedef {import('../ai/catalog/providers.js').ProviderInfo} ProviderInfo */
/** @typedef {import('../ai/keys.js').KeyStore} KeyStore */
/** @typedef {import('../ai/keys.js').KeysChange} KeysChange */
/** @typedef {import('../ai/transport-select.js').KeyTestResult} KeyTestResult */
/** @typedef {import('../ai/transport-select.js').PoolStatus} PoolStatus */
/** @typedef {import('../ui/kit.js').Label} Label */
/** @typedef {import('../ui/kit.js').SafeHtml} SafeHtml */
/** @typedef {import('../ui/kit.js').Tone} Tone */

/**
 * The shell services the view uses (features/registry.js).
 * @typedef {object} ViewServices
 * @property {(name: string, handler: (el: HTMLElement, event: Event) => unknown) => void} onAction
 * @property {(name: string, handler: (el: HTMLElement, event: Event) => unknown) => void} onChange
 * @property {(label: Label, opts?: { tone?: Tone, timeoutMs?: number }) => unknown} [toast]
 */

/**
 * What the view reads and changes; the defaults are the app's own modules.
 * @typedef {object} ViewDeps
 * @property {KeyStore} [keys]
 * @property {typeof testKey} [testKey]
 * @property {typeof fetchPools} [fetchPools]
 * @property {{ load: (opts?: { force?: boolean }) => Promise<unknown>, get: () => import('../ai/health-client.js').HealthState, subscribe: (fn: (state: import('../ai/health-client.js').HealthState) => void) => () => void }} [health]
 * @property {() => string} [getLocalUrl]
 * @property {(url: string) => boolean} [setLocalUrl]
 * @property {(url: string) => string} [normalizeUrl]
 * @property {() => string} [origin]
 * @property {(message: string) => boolean} [confirm]
 */

const NS = 'providers';

/** The providers a user can add a key for, in picker order. */
export const KEY_PROVIDERS = Object.freeze(PROVIDER_ORDER.filter((id) => getProvider(id)?.byok));

/** Route chips: tone and icon per route. */
const ROUTES = /** @type {const} */ ({
  direct: { tone: 'info', icon: 'globe' },
  auto: { tone: 'info', icon: 'globe' },
  relay: { tone: 'info', icon: 'network' },
  pool: { tone: 'ok', icon: 'cloud' },
  device: { tone: 'neutral', icon: 'hard-drive' },
  none: { tone: 'neutral', icon: 'circle-dashed' },
});

const VAULT_TONES = /** @type {const} */ ({ none: 'neutral', locked: 'warn', unlocked: 'ok', unavailable: 'neutral' });
const VAULT_ICONS = /** @type {const} */ ({ none: 'circle-dashed', locked: 'lock', unlocked: 'shield-check', unavailable: 'circle-dashed' });

/** The error codes of the key store with their own text. */
const STORE_ERRORS = new Set(['invalid_slot', 'invalid_key', 'locked', 'unavailable', 'storage']);

/**
 * A chip with a tone and icon of its own.
 * @param {Label} text
 * @param {Tone} tone
 * @param {string} iconName
 * @param {string} [attrs] data attributes, already escaped
 */
function chip(text, tone, iconName, attrs = '') {
  return html`<span class="chip chip-${tone}"${raw(attrs)}>${icon(iconName, '')}${label(text)}</span>`;
}

/**
 * The text of a failed key store call.
 * @param {unknown} err
 * @returns {Label}
 */
function storeErrorLabel(err) {
  const code = err instanceof KeyStoreError && STORE_ERRORS.has(err.code) ? err.code : 'storage';
  return `${NS}.error.${code}`;
}

/** @param {string} key */
const last4 = (key) => key.slice(-4);

/**
 * @param {Label} text
 * @param {Tone} tone
 */
function resultLine(text, tone) {
  const iconName = { ok: 'check-circle-2', warn: 'triangle-alert', danger: 'octagon-alert', info: 'info', neutral: 'loader-2' }[tone];
  const spin = tone === 'neutral' ? ' animate-spin motion-reduce:animate-none' : '';
  return html`<span class="flex items-start gap-1.5" data-tone="${tone}">${icon(iconName, `w-3.5 h-3.5 mt-0.5 flex-shrink-0${spin}`)}${label(text)}</span>`;
}

/**
 * Builds the view into `el` and wires its actions. Returns a handle for tests and for a refresh.
 * @param {HTMLElement} el
 * @param {ViewServices} services
 * @param {ViewDeps} [deps]
 */
export function mountProvidersView(el, services, deps = {}) {
  const keys = deps.keys ?? keyStore;
  const runTest = deps.testKey ?? testKey;
  const loadPools = deps.fetchPools ?? fetchPools;
  const health = deps.health ?? healthClient;
  const getLocalUrl = deps.getLocalUrl ?? getLlmUrl;
  const setLocalUrl = deps.setLocalUrl ?? setLlmUrl;
  const normalizeUrl = deps.normalizeUrl ?? normalizeServerUrl;
  const origin = deps.origin ?? (() => globalThis.location?.origin ?? '');
  const confirmAction = deps.confirm ?? ((/** @type {string} */ message) => globalThis.confirm?.(message) ?? false);

  /** @type {{ reachable: boolean | null, pools: Record<string, PoolStatus> }} */
  let pools = { reachable: null, pools: {} };

  /** @param {string} selector */
  const part = (selector) => /** @type {HTMLElement | null} */ (el.querySelector(selector));
  /** @param {string} id */
  const input = (id) => /** @type {HTMLInputElement | null} */ (el.querySelector(`#${id}`));

  /**
   * @param {string} selector
   * @param {SafeHtml | string} markup
   */
  const fill = (selector, markup) => {
    const target = part(selector);
    if (target) setHtml(target, String(markup));
  };

  /** @param {string} id */
  const poolOf = (id) => (Object.hasOwn(pools.pools, id) ? pools.pools[id].configured : poolAvailable(id));

  // -------------------------------------------------------------------------------------------
  // Markup

  function vaultChip() {
    const state = keys.vaultState();
    return chip(`${NS}.vault.state.${state}`, VAULT_TONES[state], VAULT_ICONS[state], ` data-vault-state="${state}"`);
  }

  function suggestMarkup() {
    if (!keys.vaultSuggested()) return '';
    return html`<div class="flex flex-wrap items-start gap-2 p-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900" role="note">
      ${icon('shield-alert', 'w-4 h-4 flex-shrink-0 mt-0.5')}${label(`${NS}.vault.suggest`, { tag: 'p', className: 'flex-1 min-w-0' })}
      <button type="button" class="btn btn-ghost py-1" data-action="providers-dismiss-hint">${label(`${NS}.vault.suggest_dismiss`)}</button>
    </div>`;
  }

  function vaultMarkup() {
    const state = keys.vaultState();
    const body = label(`${NS}.vault.${state}_body`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' });
    let controls = html``;
    if (state === 'none' || state === 'locked') {
      const creating = state === 'none';
      controls = html`<div class="flex flex-wrap items-end gap-2">
        <div class="flex-1 min-w-[12rem]">
          <label for="pvPassphrase" class="field-label">${label(`${NS}.vault.passphrase`)}</label>
          <input type="password" id="pvPassphrase" class="field" autocomplete="${creating ? 'new-password' : 'current-password'}" spellcheck="false"${creating ? html` minlength="${MIN_PASSPHRASE_CHARS}"` : ''}>
        </div>
        <button type="button" class="btn btn-primary" data-action="providers-unlock">${icon(creating ? 'shield-check' : 'lock', 'w-3.5 h-3.5')}${label(creating ? `${NS}.vault.create` : `${NS}.vault.unlock`)}</button>
      </div>${creating ? label(`${NS}.vault.passphrase_new_hint`, { tag: 'p', className: 'text-[11px] text-slate-500' }) : ''}`;
    } else if (state === 'unlocked') {
      controls = html`<div class="flex flex-wrap gap-2"><button type="button" class="btn btn-secondary" data-action="providers-lock">${icon('lock', 'w-3.5 h-3.5')}${label(`${NS}.vault.lock`)}</button></div>`;
    }
    return html`${label(`${NS}.vault.title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800', id: 'pvVaultTitle' })}${body}${controls}
      <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
        <p class="text-xs min-w-0" role="status" aria-live="polite" data-pv="vault-result"></p>
        <button type="button" class="btn btn-danger" data-action="providers-forget">${icon('trash-2', 'w-3.5 h-3.5')}${label(`${NS}.vault.forget`)}</button>
      </div>`;
  }

  function accessMarkup() {
    const asked = health.get().data?.access === true;
    const stored = keys.keyLocation(ACCESS_SLOT);
    if (!asked && !stored) return '';
    const placeholderKey = stored ? `${NS}.access.placeholder_saved` : `${NS}.access.placeholder`;
    return html`<div class="space-y-2 pt-3 border-t border-slate-100">
      ${label(`${NS}.access.title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}
      ${label(`${NS}.access.body`, { tag: 'p', className: 'text-xs text-slate-600 leading-relaxed' })}
      <div class="flex flex-wrap items-end gap-2">
        <div class="flex-1 min-w-[12rem]">
          <label for="pvAccess" class="field-label">${label(`${NS}.access.label`)}</label>
          <input type="password" id="pvAccess" class="field font-mono" autocomplete="off" spellcheck="false" placeholder="${t(placeholderKey)}" data-i18n-placeholder="${placeholderKey}">
        </div>
        <button type="button" class="btn btn-secondary" data-action="providers-save-access">${label(`${NS}.access.save`)}</button>
      </div>
      <p class="text-xs" role="status" aria-live="polite" data-pv="access-result"></p>
    </div>`;
  }

  function poolsMarkup() {
    if (pools.reachable === false) return label(`${NS}.pool.unreachable`, { tag: 'p', className: 'text-xs text-slate-500' });
    const ids = Object.keys(pools.pools);
    if (ids.length === 0) return label(`${NS}.pool.loading`, { tag: 'p', className: 'text-xs text-slate-500' });
    return html`<ul class="flex flex-wrap gap-1.5">${ids.map((id) => {
      const status = pools.pools[id];
      const name = getProvider(getPool(id)?.provider ?? id)?.label ?? id;
      return html`<li data-pool="${id}">${chip(
        { key: status.configured ? `${NS}.pool.on` : `${NS}.pool.off`, params: { provider: name, count: status.models.length } },
        status.configured ? 'ok' : 'neutral',
        status.configured ? 'check-circle-2' : 'circle-dashed',
      )}</li>`;
    })}</ul>`;
  }

  /**
   * Key and route chips of one provider.
   * @param {string} id
   */
  function statusMarkup(id) {
    const key = keys.getKey(id);
    const where = keys.keyLocation(id);
    const keyChip = where
      ? chip({ key: `${NS}.key.${where}`, params: { last4: last4(key) } }, 'ok', where === 'vault' ? 'lock' : 'check-circle-2', ' data-key="set"')
      : chip(`${NS}.key.none`, 'neutral', 'circle-dashed', ' data-key="none"');
    const plan = planTransport(id, { key, pool: poolOf(id), baseUrl: id === 'local' ? getLocalUrl() : null });
    const def = ROUTES[plan.route];
    const routeLabel = plan.route === 'none' ? `${NS}.route.reason.${plan.reason ?? 'no_key'}` : `${NS}.route.${plan.route}`;
    return html`${keyChip}${chip(routeLabel, def.tone, def.icon, ` data-route="${plan.route}"`)}`;
  }

  /**
   * The key field, hint and buttons of a provider (or of the local server).
   * @param {string} id
   * @param {Readonly<ProviderInfo>} info
   */
  function keyFields(id, info) {
    const hint = info.keyHint ? { key: `${NS}.key.hint_prefix`, params: { prefix: info.keyHint } } : id === 'local' ? `${NS}.local.key_hint` : `${NS}.key.hint_any`;
    const placeholderKey = `${NS}.key.placeholder`;
    return html`<div>
        <label for="pvKey-${id}" class="field-label">${label(id === 'local' ? `${NS}.local.key` : { key: `${NS}.key.label`, params: { provider: info.label } })}</label>
        <input type="password" id="pvKey-${id}" class="field font-mono" autocomplete="off" spellcheck="false"${info.keyHint ? html` placeholder="${info.keyHint}…"` : html` placeholder="${t(placeholderKey)}" data-i18n-placeholder="${placeholderKey}"`}>
        ${label(hint, { tag: 'p', className: 'text-[11px] text-slate-500 mt-1' })}
      </div>
      <label class="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
        <input type="checkbox" id="pvRemember-${id}" class="rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-pv-remember>
        ${label(`${NS}.key.remember`)}
      </label>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-primary" data-action="providers-save-key" data-arg="${id}">${icon('check', 'w-3.5 h-3.5')}${label(`${NS}.key.save`)}</button>
        <button type="button" class="btn btn-secondary" data-action="providers-test-key" data-arg="${id}">${icon('zap', 'w-3.5 h-3.5 text-amber-600')}${label(`${NS}.key.test`)}</button>
        <button type="button" class="btn btn-ghost text-rose-700" data-action="providers-remove-key" data-arg="${id}">${icon('trash-2', 'w-3.5 h-3.5')}${label(`${NS}.key.remove`)}</button>
        ${info.keysUrl ? html`<a class="btn btn-ghost" href="${info.keysUrl}" target="_blank" rel="noopener noreferrer">${label(`${NS}.key.get`)}</a>` : ''}
      </div>
      <p class="text-xs" role="status" aria-live="polite" data-pv-result="${id}"></p>`;
  }

  /** @param {string} id */
  function providerRow(id) {
    const info = /** @type {Readonly<ProviderInfo>} */ (getProvider(id));
    return html`<li><details class="disclosure" data-provider="${id}">
      <summary><span class="flex flex-1 min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><span class="font-semibold text-slate-800">${info.label}</span><span class="flex flex-wrap gap-1.5" data-pv-status="${id}">${statusMarkup(id)}</span></span>${icon('chevron-down', 'disclosure-chevron')}</summary>
      <div class="disclosure-body space-y-2">${keyFields(id, info)}</div>
    </details></li>`;
  }

  function localMarkup() {
    const info = /** @type {Readonly<ProviderInfo>} */ (getProvider('local'));
    const site = origin() || 'https://…';
    const presets = Object.values(LOCAL_SERVER_PRESETS);
    return html`<div class="space-y-3 pt-3 border-t border-slate-100">
      <div class="flex flex-wrap items-center justify-between gap-2">
        ${label(`${NS}.local.title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}<span class="flex flex-wrap gap-1.5" data-pv-status="local">${statusMarkup('local')}</span>
      </div>
      <div class="flex flex-wrap gap-1.5" role="group" aria-labelledby="pvLocalPresets">
        ${label(`${NS}.local.presets`, { className: 'text-xs text-slate-600 self-center', id: 'pvLocalPresets' })}
        ${presets.map((p) => html`<button type="button" class="btn btn-ghost py-1" data-action="providers-local-preset" data-arg="${p.id}">${p.label}</button>`)}
      </div>
      <div>
        <label for="pvLocalUrl" class="field-label">${label(`${NS}.local.url`)}</label>
        <input type="text" id="pvLocalUrl" class="field font-mono" spellcheck="false" value="${getLocalUrl()}" placeholder="${presetEndpoint('ollama')}">
        ${label(`${NS}.local.url_hint`, { tag: 'p', className: 'text-[11px] text-slate-500 mt-1' })}
      </div>
      ${keyFields('local', info)}
      <div class="space-y-1.5 p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700">
        ${label(`${NS}.local.cors_title`, { tag: 'p', className: 'font-semibold' })}
        <ul class="space-y-1">${presets.map((p) => html`<li data-cors="${p.id}">${label({ key: `${NS}.local.cors.${p.id}`, params: { setting: p.corsSetting ?? '', origin: site } })}</li>`)}</ul>
        ${label(`${NS}.local.chrome`, { tag: 'p' })}
        ${label(`${NS}.local.relay_never`, { tag: 'p', className: 'text-slate-500' })}
      </div>
      ${label(`${NS}.local.large_models`, { tag: 'p', className: 'text-[11px] text-slate-500', id: 'pvLocalLarge' })}
    </div>`;
  }

  function render() {
    setHtml(
      el,
      html`<div class="card p-4 sm:p-5 space-y-4" data-pv-root>
        <div class="card-header">
          <h3 class="card-title">${icon('plug', 'w-4 h-4 text-amber-600')}${label(`${NS}.title`)}</h3>
          <span data-pv="vault-chip">${vaultChip()}</span>
        </div>
        ${label(`${NS}.subtitle`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed -mt-2' })}
        <div data-pv="suggest">${suggestMarkup()}</div>
        <section class="space-y-2" data-pv="vault" aria-labelledby="pvVaultTitle">${vaultMarkup()}</section>
        <div data-pv="access">${accessMarkup()}</div>
        <section class="space-y-2 pt-3 border-t border-slate-100">
          <label class="flex items-start gap-2 text-sm text-slate-800 cursor-pointer select-none">
            <input type="checkbox" id="pvRelay" class="mt-0.5 rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-change="providers-relay"${relayEnabled() ? raw(' checked') : ''}>
            ${label(`${NS}.relay.label`)}
          </label>
          ${label(`${NS}.relay.hint`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="btn btn-ghost py-1" data-action="providers-forget-routes">${label(`${NS}.relay.reset`)}</button>
            <p class="text-xs" role="status" aria-live="polite" data-pv="relay-result"></p>
          </div>
        </section>
        <section class="space-y-2 pt-3 border-t border-slate-100">
          ${label(`${NS}.pool.title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}
          <div data-pv="pools">${poolsMarkup()}</div>
        </section>
        <section class="space-y-2 pt-3 border-t border-slate-100">
          ${label(`${NS}.list.title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}
          <ul class="space-y-2">${KEY_PROVIDERS.map((id) => providerRow(id))}</ul>
        </section>
        ${localMarkup()}
      </div>`.value,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Updates

  function refreshStatuses() {
    for (const id of [...KEY_PROVIDERS, 'local']) fill(`[data-pv-status="${id}"]`, statusMarkup(id));
  }

  function refreshVault() {
    fill('[data-pv="vault-chip"]', vaultChip());
    fill('[data-pv="suggest"]', suggestMarkup());
    fill('[data-pv="vault"]', vaultMarkup());
    const canRemember = keys.vaultState() === 'unlocked';
    for (const box of el.querySelectorAll('input[data-pv-remember]')) {
      const checkbox = /** @type {HTMLInputElement} */ (box);
      checkbox.disabled = !canRemember;
      if (!canRemember) checkbox.checked = false;
      checkbox.title = canRemember ? '' : labelText(`${NS}.key.remember_locked`);
    }
  }

  function refreshAccess() {
    fill('[data-pv="access"]', accessMarkup());
  }

  function refreshPools() {
    fill('[data-pv="pools"]', poolsMarkup());
    refreshStatuses();
  }

  /**
   * @param {string} selector
   * @param {Label} text
   * @param {Tone} tone
   */
  const report = (selector, text, tone) => fill(selector, resultLine(text, tone));

  // -------------------------------------------------------------------------------------------
  // Actions

  /**
   * @param {HTMLElement} target
   * @returns {string}
   */
  const argOf = (target) => target.dataset.arg ?? '';

  async function saveKey(/** @type {string} */ id) {
    const field = input(`pvKey-${id}`);
    const remember = input(`pvRemember-${id}`)?.checked === true;
    const value = field?.value.trim() ?? '';
    const result = `[data-pv-result="${id}"]`;
    if (id === 'local') {
      const urlField = input('pvLocalUrl');
      let url;
      try {
        url = normalizeUrl(urlField?.value ?? '');
      } catch (err) {
        report(result, { text: err instanceof Error ? err.message : String(err) }, 'danger');
        return;
      }
      if (urlField) urlField.value = url;
      const stored = setLocalUrl(url);
      // The older server field in Advanced shows the same setting.
      const legacy = /** @type {HTMLInputElement | null} */ (el.ownerDocument.getElementById('cfgLlmUrl'));
      if (legacy) legacy.value = url;
      if (!value) {
        report(result, stored ? `${NS}.local.saved` : `${NS}.error.storage`, stored ? 'ok' : 'danger');
        refreshStatuses();
        return;
      }
    } else if (!value) {
      report(result, `${NS}.key.empty`, 'warn');
      field?.focus();
      return;
    }
    try {
      await keys.setKey(id, value, { remember });
    } catch (err) {
      report(result, storeErrorLabel(err), 'danger');
      return;
    }
    if (field) field.value = '';
    const info = getProvider(id);
    const looksValid = id === 'local' ? null : keyLooksValid(/** @type {import('../ai/contract.js').ProviderId} */ (id), value);
    if (looksValid === false) report(result, { key: `${NS}.key.mismatch`, params: { provider: info?.label ?? id } }, 'warn');
    else report(result, remember ? `${NS}.key.saved_vault` : `${NS}.key.saved`, 'ok');
  }

  async function runKeyTest(/** @type {string} */ id) {
    const typed = input(`pvKey-${id}`)?.value.trim() ?? '';
    const key = typed || keys.getKey(id);
    const result = `[data-pv-result="${id}"]`;
    if (!key && id !== 'local') {
      report(result, `${NS}.key.empty`, 'warn');
      return;
    }
    let baseUrl = null;
    if (id === 'local') {
      try {
        baseUrl = normalizeUrl(input('pvLocalUrl')?.value ?? '');
      } catch (err) {
        report(result, { text: err instanceof Error ? err.message : String(err) }, 'danger');
        return;
      }
    }
    report(result, `${NS}.test.running`, 'neutral');
    /** @type {KeyTestResult} */
    let outcome;
    try {
      outcome = await runTest(id, key, { baseUrl, access: () => keys.getKey(ACCESS_SLOT) });
    } catch {
      outcome = { ok: false, code: 'network', via: null, status: 0 };
    }
    if (outcome.ok) report(result, `${NS}.test.ok_${outcome.via}`, 'ok');
    else report(result, { key: `${NS}.test.failed`, params: { code: outcome.code, reason: labelText(`ai.error.${outcome.code}`) } }, 'danger');
    refreshStatuses();
  }

  async function removeKey(/** @type {string} */ id) {
    const result = `[data-pv-result="${id}"]`;
    try {
      await keys.removeKey(id);
      report(result, `${NS}.key.removed`, 'ok');
    } catch (err) {
      report(result, storeErrorLabel(err), 'danger');
    }
  }

  async function unlockVault() {
    const field = input('pvPassphrase');
    const pass = field?.value ?? '';
    if (field) field.value = '';
    report('[data-pv="vault-result"]', `${NS}.vault.working`, 'neutral');
    let outcome;
    try {
      outcome = await keys.unlock(pass);
    } catch (err) {
      report('[data-pv="vault-result"]', storeErrorLabel(err), 'danger');
      return;
    }
    const ok = outcome === 'created' || outcome === 'unlocked';
    // The vault part re-renders on the change; the result goes into the fresh status line.
    refreshVault();
    refreshStatuses();
    report('[data-pv="vault-result"]', `${NS}.vault.result.${outcome}`, ok ? 'ok' : 'danger');
    if (!ok) input('pvPassphrase')?.focus();
  }

  async function forgetAll() {
    if (!confirmAction(labelText(`${NS}.vault.forget_confirm`))) return;
    try {
      await keys.forgetAll();
    } catch (err) {
      report('[data-pv="vault-result"]', storeErrorLabel(err), 'danger');
      return;
    }
    refreshVault();
    refreshAccess();
    refreshStatuses();
    report('[data-pv="vault-result"]', `${NS}.vault.result.forgotten`, 'ok');
  }

  async function saveAccess() {
    const field = input('pvAccess');
    const value = field?.value.trim() ?? '';
    try {
      if (value) await keys.setKey(ACCESS_SLOT, value, { remember: keys.vaultState() === 'unlocked' });
      else await keys.removeKey(ACCESS_SLOT);
    } catch (err) {
      report('[data-pv="access-result"]', storeErrorLabel(err), 'danger');
      return;
    }
    refreshAccess();
    report('[data-pv="access-result"]', value ? `${NS}.access.saved` : `${NS}.access.removed`, 'ok');
  }

  services.onAction('providers-save-key', (target) => saveKey(argOf(target)));
  services.onAction('providers-test-key', (target) => runKeyTest(argOf(target)));
  services.onAction('providers-remove-key', (target) => removeKey(argOf(target)));
  services.onAction('providers-unlock', () => unlockVault());
  services.onAction('providers-lock', () => {
    keys.lock();
    report('[data-pv="vault-result"]', `${NS}.vault.result.locked`, 'ok');
  });
  services.onAction('providers-forget', () => forgetAll());
  services.onAction('providers-dismiss-hint', () => {
    keys.dismissVaultSuggestion();
    fill('[data-pv="suggest"]', '');
  });
  services.onAction('providers-save-access', () => saveAccess());
  services.onAction('providers-forget-routes', () => {
    forgetTransports();
    report('[data-pv="relay-result"]', `${NS}.relay.reset_done`, 'ok');
    refreshStatuses();
  });
  services.onAction('providers-local-preset', (target) => {
    const preset = LOCAL_SERVER_PRESETS[/** @type {keyof typeof LOCAL_SERVER_PRESETS} */ (argOf(target))];
    const field = input('pvLocalUrl');
    if (preset && field) {
      field.value = presetEndpoint(preset.id);
      field.focus();
    }
  });
  services.onChange('providers-relay', (target) => {
    const on = /** @type {HTMLInputElement} */ (target).checked;
    const stored = setRelayEnabled(on);
    report('[data-pv="relay-result"]', stored ? (on ? `${NS}.relay.on` : `${NS}.relay.off`) : `${NS}.error.storage`, stored ? 'ok' : 'warn');
    refreshStatuses();
  });

  render();
  refreshVault();

  /** @param {KeysChange} change */
  const onChangeOfKeys = (change) => {
    if (change.type === 'vault') {
      refreshVault();
      refreshAccess();
      if (change.reason === 'idle') {
        report('[data-pv="vault-result"]', `${NS}.vault.result.idle`, 'info');
        services.toast?.(`${NS}.vault.result.idle`, { tone: 'info' });
      }
    } else if (change.slot === ACCESS_SLOT) {
      refreshAccess();
      return;
    }
    refreshStatuses();
  };
  const unsubscribeKeys = keys.onKeysChange(onChangeOfKeys);
  const unsubscribeHealth = health.subscribe(() => {
    refreshAccess();
    refreshStatuses();
  });

  const loaded = Promise.all([
    keys.ready().then(() => {
      refreshVault();
      refreshStatuses();
    }),
    health.load().catch(() => {}),
    loadPools()
      .then((answer) => {
        pools = answer;
        refreshPools();
      })
      .catch(() => {}),
  ]).then(() => undefined);

  return {
    /** Resolves when the vault state, the health answer and the pool list have been read. */
    loaded,
    refresh() {
      refreshVault();
      refreshAccess();
      refreshPools();
    },
    destroy() {
      unsubscribeKeys();
      unsubscribeHealth();
    },
  };
}
