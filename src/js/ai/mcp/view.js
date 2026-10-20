// @ts-check
// Settings → Tools and connections. One card with three parts:
// - Tools for the model: the switches of the built-in tool groups (chat/tools.js offers them);
// - Web search service: Off, Brave Search or Tavily with the user's key (kept in the key store like
//   a provider key), or a self-hosted SearXNG address; a test search shows the number of results or
//   an error code, never the service's own text;
// - MCP servers: the provider-side flag, every server with its connection state and its tools with
//   their pin status (approve, approve again after a change, withdraw), and the form to add one.
//   Each tool shows what the user approves: its whole description (as far as the model gets it),
//   the class its hints give it and its input schema with the descriptions of the arguments;
// - Always allowed: the tools the user chose "Always allow" for, each to forget again.
// Every text is an i18n key; server names, addresses and tool names are shown as given, escaped.
import { setHtml } from '../../dom.js';
import { t } from '../../i18n/index.js';
import { html, icon, label, raw } from '../../ui/kit.js';
import { AiError } from '../errors.js';
import { readSearchSettings, SEARCH_PROVIDERS, searxngRoot, writeSearchSettings } from '../search.js';
import { mcpApprovalKey, parseApprovalKey } from '../tools/approval.js';
import { DEFAULT_TOOL_SWITCHES } from '../tools/builtin.js';
import { effectFromHints, sanitizeSchema, TOOL_LIMITS } from '../tools/registry.js';
import { MAX_SERVERS, McpError, publicEndpoint } from './client.js';

/** @typedef {import('../../ui/kit.js').Label} Label */
/** @typedef {import('../../ui/kit.js').Tone} Tone */
/** @typedef {import('./client.js').McpServer} McpServer */
/** @typedef {import('./client.js').ServerSync} ServerSync */
/** @typedef {import('../tools/builtin.js').ToolSwitches} ToolSwitches */

/**
 * The shell services the view uses (features/registry.js).
 * @typedef {object} ViewServices
 * @property {(name: string, handler: (el: HTMLElement, event: Event) => unknown) => void} onAction
 * @property {(name: string, handler: (el: HTMLElement, event: Event) => unknown) => void} onChange
 */

/**
 * What the view reads and changes (chat/tools.js installChatTools, the key store, the search).
 * @typedef {object} ToolsViewDeps
 * @property {import('../../chat/tools.js').ToolsRuntime} runtime
 * @property {{ getKey(slot: string): string, setKey(slot: string, key: string, opts?: { remember?: boolean }): Promise<void>, removeKey(slot: string): Promise<void>, keyLocation(slot: string): 'session' | 'vault' | null }} keys
 * @property {(query: string, count: number, signal: AbortSignal) => Promise<unknown[]>} testSearch
 */

const NS = 'tools.settings';
const STATUS_TONES = /** @type {const} */ ({ approved: 'ok', new: 'neutral', changed: 'warn', removed: 'neutral', invalid: 'danger' });
const EFFECT_TONES = /** @type {const} */ ({ read: 'info', low: 'warn', high: 'danger', forbidden: 'danger' });

/**
 * @param {Label} text
 * @param {Tone} tone
 * @param {string} iconName
 * @param {string} [attrs]
 */
function chip(text, tone, iconName, attrs = '') {
  return html`<span class="chip chip-${tone}"${raw(attrs)}>${icon(iconName, '')}${label(text)}</span>`;
}

/**
 * Builds the view into `el` and wires its actions.
 * @param {HTMLElement} el
 * @param {ViewServices} services
 * @param {ToolsViewDeps} deps
 */
export function mountToolsView(el, services, deps) {
  const { runtime, keys } = deps;
  /** @param {string} selector */
  const part = (selector) => /** @type {HTMLElement | null} */ (el.querySelector(selector));
  /** @param {string} id */
  const input = (id) => /** @type {HTMLInputElement | null} */ (el.querySelector(`#${id}`));
  /**
   * @param {string} selector
   * @param {Label} text
   * @param {Tone} tone
   */
  const result = (selector, text, tone) => {
    const target = part(selector);
    if (target) setHtml(target, String(html`<span data-tone="${tone}">${label(text)}</span>`));
  };

  // ---------------------------------------------------------------------------------------------
  // Markup

  function switchesMarkup() {
    const on = runtime.switches();
    return html`${Object.keys(DEFAULT_TOOL_SWITCHES).map(
      (name) => html`<label class="flex items-start gap-2 text-sm text-slate-800 cursor-pointer select-none">
        <input type="checkbox" class="mt-0.5 rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-change="tools-switch" data-arg="${name}"${/** @type {Record<string, boolean>} */ (on)[name] ? raw(' checked') : ''}>
        ${label(`${NS}.switch.${name}`)}
      </label>`,
    )}`;
  }

  function searchMarkup() {
    const settings = readSearchSettings();
    const provider = settings.provider;
    const keyed = provider === 'brave' || provider === 'tavily';
    const where = keyed ? keys.keyLocation(provider) : null;
    return html`<div class="flex flex-wrap items-end gap-2">
        <div class="min-w-[12rem]">
          <label for="tsProvider" class="field-label">${label(`${NS}.search.provider`)}</label>
          <select id="tsProvider" class="field" data-change="tools-search-provider">
            ${['off', ...SEARCH_PROVIDERS].map((p) => html`<option value="${p}"${p === provider ? raw(' selected') : ''} data-i18n="${NS}.search.${p}">${t(`${NS}.search.${p}`)}</option>`)}
          </select>
        </div>
        ${keyed ? chip(where ? `${NS}.search.key_set` : `${NS}.search.key_none`, where ? 'ok' : 'neutral', where ? 'check-circle-2' : 'circle-dashed', ' data-search-key') : ''}
      </div>
      ${keyed
        ? html`<div>
            <label for="tsKey" class="field-label">${label(`${NS}.search.key`)}</label>
            <input type="password" id="tsKey" class="field font-mono" autocomplete="off" spellcheck="false">
          </div>
          ${provider === 'brave' ? label(`${NS}.search.relay_note`, { tag: 'p', className: 'text-[11px] text-slate-500' }) : ''}`
        : ''}
      ${provider === 'searxng'
        ? html`<div>
            <label for="tsUrl" class="field-label">${label(`${NS}.search.url`)}</label>
            <input type="url" id="tsUrl" class="field font-mono" spellcheck="false" value="${settings.searxngUrl}" placeholder="https://search.example.org">
            ${label(`${NS}.search.url_hint`, { tag: 'p', className: 'text-[11px] text-slate-500 mt-1' })}
          </div>`
        : ''}
      ${provider === 'off'
        ? ''
        : html`<div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-primary" data-action="tools-search-save">${icon('check', 'w-3.5 h-3.5')}${label(`${NS}.search.save`)}</button>
            <button type="button" class="btn btn-secondary" data-action="tools-search-test">${icon('search', 'w-3.5 h-3.5')}${label(`${NS}.search.test`)}</button>
            ${keyed ? html`<button type="button" class="btn btn-ghost text-rose-700" data-action="tools-search-remove-key">${icon('trash-2', 'w-3.5 h-3.5')}${label(`${NS}.search.remove_key`)}</button>` : ''}
          </div>`}
      <p class="text-xs" role="status" aria-live="polite" data-ts="search-result"></p>`;
  }

  /**
   * @param {McpServer} server
   * @param {ServerSync | undefined} sync
   */
  function serverStatus(server, sync) {
    if (!server.enabled) return chip(`${NS}.mcp.status.off`, 'neutral', 'circle-dashed', ' data-mcp-status="off"');
    if (server.mode === 'provider') return chip(`${NS}.mcp.mode_provider`, 'info', 'cloud', ' data-mcp-status="provider"');
    if (!sync) return chip(`${NS}.mcp.status.unknown`, 'neutral', 'circle-dashed', ' data-mcp-status="unknown"');
    if (sync.status === 'ok') return chip(`${NS}.mcp.status.ok`, 'ok', 'check-circle-2', ' data-mcp-status="ok"');
    const reason = t(`${NS}.mcp.error.${sync.error ?? 'protocol'}`);
    return chip({ key: `${NS}.mcp.status.error`, params: { reason } }, 'warn', 'triangle-alert', ' data-mcp-status="error"');
  }

  /**
   * @param {McpServer} server
   * @param {ServerSync | undefined} sync
   */
  function toolsMarkup(server, sync) {
    if (server.mode === 'provider') {
      return html`<div class="space-y-1.5">
        <label for="mcpAllowed-${server.id}" class="field-label">${label(`${NS}.mcp.allowed`)}</label>
        <div class="flex flex-wrap items-end gap-2">
          <input type="text" id="mcpAllowed-${server.id}" class="field font-mono flex-1 min-w-[12rem]" spellcheck="false" value="${server.allowed.join(', ')}">
          <button type="button" class="btn btn-secondary" data-action="mcp-save-allowed" data-arg="${server.id}">${label(`${NS}.mcp.save_allowed`)}</button>
        </div>
        ${label(`${NS}.mcp.provider_note`, { tag: 'p', className: 'text-[11px] text-slate-500' })}
      </div>`;
    }
    const tools = sync?.tools ?? [];
    if (!tools.length) return '';
    return html`<ul class="space-y-1.5">${tools
      .filter((tool) => tool.name)
      .map((tool) => {
        const listed = tool.tool;
        // As much of the description as the model can get, and the schema as it is sent.
        const desc = typeof listed?.description === 'string' ? listed.description.slice(0, TOOL_LIMITS.descriptionChars) : '';
        const effect = listed ? effectFromHints(listed.annotations) : null;
        const schema = listed ? JSON.stringify(sanitizeSchema(listed.inputSchema), null, 2) : '';
        const action =
          tool.status === 'new' || tool.status === 'changed'
            ? html`<button type="button" class="btn btn-secondary py-1" data-action="mcp-approve" data-arg="${server.id}" data-tool="${tool.name}" data-hash="${tool.hash ?? ''}">${icon('shield-check', 'w-3.5 h-3.5')}${label(`${NS}.mcp.approve`)}</button>`
            : tool.status === 'approved' || tool.status === 'removed'
              ? html`<button type="button" class="btn btn-ghost py-1" data-action="mcp-revoke" data-arg="${server.id}" data-tool="${tool.name}">${label(`${NS}.mcp.revoke`)}</button>`
              : '';
        return html`<li class="flex flex-wrap items-start justify-between gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200" data-mcp-tool="${tool.name}" data-pin="${tool.status}">
          <div class="min-w-0 flex-1 space-y-1">
            <p class="font-mono text-xs text-slate-900 break-all">${tool.name}</p>
            ${desc ? html`<p class="text-[11px] text-slate-600 whitespace-pre-wrap break-words" data-mcp-desc>${desc}</p>` : ''}
            ${schema
              ? html`<details class="text-[11px]"><summary class="cursor-pointer select-none text-slate-600">${label(`${NS}.mcp.schema`)}</summary><pre class="mt-1 max-h-48 overflow-auto rounded-lg bg-white border border-slate-200 p-2 font-mono text-[11px] whitespace-pre-wrap break-words" tabindex="0" data-mcp-schema>${schema}</pre></details>`
              : ''}
          </div>
          <div class="flex flex-wrap items-center gap-1.5">${effect ? chip(`tools.effect.${effect}`, EFFECT_TONES[effect], effect === 'read' ? 'info' : 'triangle-alert', ` data-mcp-effect="${effect}"`) : ''}${chip(`${NS}.mcp.tool.${tool.status}`, STATUS_TONES[tool.status], tool.status === 'approved' ? 'shield-check' : tool.status === 'changed' ? 'shield-alert' : 'circle-dashed')}${action}</div>
        </li>`;
      })}</ul>`;
  }

  function serversMarkup() {
    const list = runtime.servers.list();
    const syncs = runtime.bridge.last();
    if (!list.length) return label(`${NS}.mcp.empty`, { tag: 'p', className: 'text-xs text-slate-500' });
    return html`<ul class="space-y-2">${list.map((server) => {
      const sync = syncs.find((s) => s.server.id === server.id);
      return html`<li class="p-3 rounded-xl border border-slate-200 space-y-2" data-mcp-server="${server.id}">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0"><p class="text-sm font-semibold text-slate-800">${server.name}</p><p class="text-[11px] font-mono text-slate-500 break-all">${server.url}</p></div>
          <div class="flex flex-wrap items-center gap-1.5">${serverStatus(server, sync)}</div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none"><input type="checkbox" class="rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-change="mcp-enabled" data-arg="${server.id}"${server.enabled ? raw(' checked') : ''}>${label(`${NS}.mcp.enabled`)}</label>
          ${server.mode === 'browser' ? html`<button type="button" class="btn btn-ghost py-1" data-action="mcp-check" data-arg="${server.id}">${icon('refresh-cw', 'w-3.5 h-3.5')}${label(`${NS}.mcp.check`)}</button>` : ''}
          <button type="button" class="btn btn-ghost py-1 text-rose-700" data-action="mcp-remove" data-arg="${server.id}">${icon('trash-2', 'w-3.5 h-3.5')}${label(`${NS}.mcp.remove`)}</button>
        </div>
        ${toolsMarkup(server, sync)}
      </li>`;
    })}</ul>`;
  }

  function rememberedMarkup() {
    const entries = runtime.gate.remembered();
    if (!entries.length) return label(`${NS}.remembered_empty`, { tag: 'p', className: 'text-xs text-slate-500' });
    const servers = runtime.servers.list();
    return html`<ul class="space-y-1.5">${entries.map((entry) => {
        const what = parseApprovalKey(entry.key);
        /** @type {Label} */
        let name = { text: entry.key };
        if (what?.kind === 'tool') name = Object.hasOwn(DEFAULT_TOOL_SWITCHES, what.name) ? `tools.builtin.${what.name}` : { text: what.name };
        else if (what?.kind === 'mcp') name = { key: `${NS}.remembered_mcp`, params: { tool: what.tool, server: servers.find((s) => s.id === what.serverId)?.name ?? what.serverId } };
        return html`<li class="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200" data-remembered="${entry.key}">
          ${label(name, { className: 'text-xs text-slate-800 break-all' })}
          <button type="button" class="btn btn-ghost py-1" data-action="tools-forget-approval" data-arg="${entry.key}">${icon('x', 'w-3.5 h-3.5')}${label(`${NS}.remembered_forget`)}</button>
        </li>`;
      })}</ul>
      <button type="button" class="btn btn-ghost text-rose-700" data-action="tools-forget-approvals">${icon('trash-2', 'w-3.5 h-3.5')}${label(`${NS}.remembered_forget_all`)}</button>`;
  }

  function addMarkup() {
    const providerSide = runtime.servers.providerSide();
    return html`<div class="space-y-2 pt-2">
      <div class="grid gap-2 sm:grid-cols-2">
        <div><label for="mcpName" class="field-label">${label(`${NS}.mcp.name`)}</label><input type="text" id="mcpName" class="field" maxlength="60" spellcheck="false"></div>
        <div><label for="mcpUrl" class="field-label">${label(`${NS}.mcp.url`)}</label><input type="url" id="mcpUrl" class="field font-mono" spellcheck="false" placeholder="https://mcp.example.org/mcp"></div>
        <div><label for="mcpToken" class="field-label">${label(`${NS}.mcp.token`)}</label><input type="password" id="mcpToken" class="field font-mono" autocomplete="off" spellcheck="false"></div>
        ${providerSide
          ? html`<div><label for="mcpMode" class="field-label">${label(`${NS}.mcp.mode`)}</label><select id="mcpMode" class="field"><option value="browser" data-i18n="${NS}.mcp.mode_browser">${t(`${NS}.mcp.mode_browser`)}</option><option value="provider" data-i18n="${NS}.mcp.mode_provider">${t(`${NS}.mcp.mode_provider`)}</option></select></div>`
          : ''}
      </div>
      <label class="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none"><input type="checkbox" id="mcpRemember" class="rounded border-slate-300 text-amber-500 focus:ring-amber-300">${label(`${NS}.mcp.remember`)}</label>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-primary" data-action="mcp-add">${icon('plus', 'w-3.5 h-3.5')}${label(`${NS}.mcp.add`)}</button>
        <p class="text-xs" role="status" aria-live="polite" data-ts="mcp-result"></p>
      </div>
    </div>`;
  }

  function render() {
    setHtml(
      el,
      String(html`<div class="card p-4 sm:p-5 space-y-4" id="toolsSettings" data-ts-root>
        <div class="card-header"><h3 class="card-title">${icon('sliders-horizontal', 'w-4 h-4 text-amber-600')}${label(`${NS}.title`)}</h3></div>
        ${label(`${NS}.subtitle`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed -mt-2' })}
        <section class="space-y-2">
          ${label(`${NS}.tools_title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}
          ${label(`${NS}.tools_hint`, { tag: 'p', className: 'text-xs text-slate-500' })}
          <div class="space-y-1.5" data-ts="switches">${switchesMarkup()}</div>
        </section>
        <section class="space-y-2 pt-3 border-t border-slate-100">
          ${label(`${NS}.search_title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}
          ${label(`${NS}.search_hint`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
          <div class="space-y-2" data-ts="search">${searchMarkup()}</div>
        </section>
        <section class="space-y-2 pt-3 border-t border-slate-100">
          ${label(`${NS}.mcp_title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}
          ${label(`${NS}.mcp_hint`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
          <label class="flex items-start gap-2 text-sm text-slate-800 cursor-pointer select-none">
            <input type="checkbox" id="mcpProviderSide" class="mt-0.5 rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-change="mcp-provider-side"${runtime.servers.providerSide() ? raw(' checked') : ''}>
            ${label(`${NS}.mcp.provider_flag`)}
          </label>
          ${label(`${NS}.mcp.provider_flag_hint`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
          <div data-ts="servers">${serversMarkup()}</div>
          <div data-ts="add">${addMarkup()}</div>
        </section>
        <section class="space-y-2 pt-3 border-t border-slate-100">
          ${label(`${NS}.remembered_title`, { tag: 'h4', className: 'text-sm font-semibold text-slate-800' })}
          ${label(`${NS}.remembered_hint`, { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
          <div class="space-y-2" data-ts="remembered">${rememberedMarkup()}</div>
        </section>
      </div>`),
    );
  }

  /** @param {string} name @param {() => string} markup */
  const refresh = (name, markup) => {
    const target = part(`[data-ts="${name}"]`);
    if (target) setHtml(target, String(markup()));
  };
  const refreshServers = () => refresh('servers', () => String(serversMarkup()));
  const refreshRemembered = () => refresh('remembered', () => String(rememberedMarkup()));

  // ---------------------------------------------------------------------------------------------
  // Actions

  services.onChange('tools-switch', (box) => {
    const name = box.dataset.arg ?? '';
    if (Object.hasOwn(DEFAULT_TOOL_SWITCHES, name)) runtime.setSwitches({ [name]: /** @type {HTMLInputElement} */ (box).checked });
  });

  services.onChange('tools-search-provider', (select) => {
    const provider = /** @type {HTMLSelectElement} */ (select).value;
    const settings = readSearchSettings();
    writeSearchSettings({ ...settings, provider: /** @type {any} */ (provider) });
    refresh('search', () => String(searchMarkup()));
  });

  services.onAction('tools-search-save', async () => {
    const settings = readSearchSettings();
    if (settings.provider === 'searxng') {
      const root = searxngRoot(input('tsUrl')?.value ?? '');
      if (!root) return result('[data-ts="search-result"]', `${NS}.search.bad_url`, 'warn');
      writeSearchSettings({ ...settings, searxngUrl: root });
    } else if (settings.provider === 'brave' || settings.provider === 'tavily') {
      const key = input('tsKey')?.value.trim() ?? '';
      if (key) {
        try {
          await keys.setKey(settings.provider, key, { remember: keys.keyLocation(settings.provider) === 'vault' });
        } catch (err) {
          return result('[data-ts="search-result"]', `providers.error.${/** @type {any} */ (err)?.code ?? 'storage'}`, 'danger');
        }
      }
    }
    refresh('search', () => String(searchMarkup()));
    result('[data-ts="search-result"]', `${NS}.search.saved`, 'ok');
  });

  services.onAction('tools-search-remove-key', async () => {
    const { provider } = readSearchSettings();
    if (provider === 'brave' || provider === 'tavily') await keys.removeKey(provider).catch(() => {});
    refresh('search', () => String(searchMarkup()));
  });

  services.onAction('tools-search-test', async () => {
    result('[data-ts="search-result"]', `${NS}.search.working`, 'neutral');
    try {
      const found = await deps.testSearch('open source software', 3, AbortSignal.timeout(15_000));
      result('[data-ts="search-result"]', { key: `${NS}.search.ok`, params: { n: found.length } }, found.length ? 'ok' : 'warn');
    } catch (err) {
      const code = err instanceof AiError ? err.code : 'network';
      result('[data-ts="search-result"]', { key: `${NS}.search.failed`, params: { reason: t(`ai.error.${code}`) } }, 'danger');
    }
  });

  services.onChange('mcp-provider-side', (box) => {
    runtime.servers.setProviderSide(/** @type {HTMLInputElement} */ (box).checked);
    refresh('add', () => String(addMarkup()));
    refreshServers();
  });

  services.onAction('mcp-add', async () => {
    const url = input('mcpUrl')?.value.trim() ?? '';
    const mode = /** @type {HTMLSelectElement | null} */ (el.querySelector('#mcpMode'))?.value === 'provider' ? 'provider' : 'browser';
    if (mode === 'provider' && !publicEndpoint(url)) return result('[data-ts="mcp-result"]', `${NS}.mcp.bad_url_provider`, 'warn');
    try {
      await runtime.servers.add({ name: input('mcpName')?.value ?? '', url, mode, token: input('mcpToken')?.value ?? '', rememberToken: input('mcpRemember')?.checked === true });
    } catch (err) {
      if (err instanceof McpError) return result('[data-ts="mcp-result"]', `${NS}.mcp.bad_url`, 'warn');
      if (err instanceof Error && err.message === 'too_many') return result('[data-ts="mcp-result"]', { key: `${NS}.mcp.too_many`, params: { n: MAX_SERVERS } }, 'warn');
      return result('[data-ts="mcp-result"]', `providers.error.${/** @type {any} */ (err)?.code ?? 'storage'}`, 'danger');
    }
    refresh('add', () => String(addMarkup()));
    result('[data-ts="mcp-result"]', `${NS}.mcp.added`, 'ok');
    refreshServers();
    await runtime.syncServers(AbortSignal.timeout(30_000)).catch(() => {});
    refreshServers();
  });

  services.onAction('mcp-check', async () => {
    await runtime.syncServers(AbortSignal.timeout(30_000)).catch(() => {});
    refreshServers();
  });

  services.onChange('mcp-enabled', async (box) => {
    runtime.servers.setEnabled(box.dataset.arg ?? '', /** @type {HTMLInputElement} */ (box).checked);
    await runtime.syncServers(AbortSignal.timeout(30_000)).catch(() => {});
    refreshServers();
  });

  services.onAction('mcp-remove', async (btn) => {
    const id = btn.dataset.arg ?? '';
    await runtime.servers.remove(id);
    runtime.gate.forget(id);
    await runtime.syncServers(AbortSignal.timeout(30_000)).catch(() => {});
    refreshServers();
  });

  services.onAction('mcp-approve', async (btn) => {
    const id = btn.dataset.arg ?? '';
    const name = btn.dataset.tool ?? '';
    const hash = btn.dataset.hash ?? '';
    if (!name || !hash) return;
    // A new pin: earlier "always allow" answers for this tool no longer hold.
    runtime.gate.forgetKey(mcpApprovalKey(id, name));
    runtime.servers.approve(id, name, hash);
    await runtime.syncServers(AbortSignal.timeout(30_000)).catch(() => {});
    refreshServers();
  });

  services.onAction('mcp-revoke', async (btn) => {
    const id = btn.dataset.arg ?? '';
    const name = btn.dataset.tool ?? '';
    runtime.servers.revoke(id, name);
    runtime.gate.forgetKey(mcpApprovalKey(id, name));
    await runtime.syncServers(AbortSignal.timeout(30_000)).catch(() => {});
    refreshServers();
  });

  services.onAction('mcp-save-allowed', (btn) => {
    const id = btn.dataset.arg ?? '';
    const names = (input(`mcpAllowed-${id}`)?.value ?? '')
      .split(/[\s,]+/)
      .map((n) => n.trim())
      .filter(Boolean);
    runtime.servers.setAllowed(id, names);
    refreshServers();
  });

  services.onAction('tools-forget-approval', (btn) => {
    const key = btn.dataset.arg ?? '';
    if (key) runtime.gate.forgetKey(key);
    refreshRemembered();
  });

  services.onAction('tools-forget-approvals', () => {
    runtime.gate.forget();
    refreshRemembered();
  });

  runtime.onChange(() => {
    refresh('switches', () => String(switchesMarkup()));
    refreshServers();
    refreshRemembered();
  });
  render();
  return { render, refreshServers };
}
