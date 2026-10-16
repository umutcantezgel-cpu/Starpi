// @ts-check
// Navigation, tabs, the chat side panel, the language switch, the device indicator, and
// connection/status indicators. The sidebar itself (rail, drawer, nav visibility) is ui/sidebar.js.
import { SUPABASE_PROJECT_REF } from './config.js';
import { byId, onAction, setHtml } from './dom.js';
import { refreshIcons } from './icons.js';
import { getLocale, LANGUAGES, LOCALES, setText } from './i18n/index.js';
import { emptyState, html } from './ui/kit.js';
import { toggleSidebar } from './ui/sidebar.js';

export { setNavVisible, syncSidebarAccess, toggleSidebar } from './ui/sidebar.js';

/** Tabs in navigation order; each has a section #tab-<name> and nav entries #nav-<name>, #mobile-nav-<name>. */
export const TABS = Object.freeze(['chat', 'research', 'library', 'ingest', 'graph', 'bench', 'companion', 'settings']);

/** @type {Map<string, () => void>} */
const tabOpenHooks = new Map();

/**
 * @param {string} tab
 * @param {() => void} hook
 */
export function onTabOpen(tab, hook) {
  tabOpenHooks.set(tab, hook);
}

/**
 * A tab that is a mount point (data-mount) and still empty when it opens shows its title and a
 * quiet note, until a feature renders into it.
 * @param {HTMLElement} section
 * @param {string} tab
 */
function fillEmptyMount(section, tab) {
  if (!section.hasAttribute('data-mount') || section.childElementCount > 0) return;
  setHtml(section, html`<div class="max-w-3xl mx-auto w-full" data-placeholder>${emptyState({ title: `nav.${tab}`, body: 'shell.mount.empty', icon: 'inbox' })}</div>`.value);
}

/** @param {string} tabId */
export function switchTab(tabId) {
  const target = TABS.includes(tabId) ? tabId : 'chat';
  for (const name of TABS) {
    const section = byId(`tab-${name}`);
    section?.classList.toggle('hidden', name !== target);
    if (section && name === target) fillEmptyMount(section, name);
    for (const id of [`nav-${name}`, `mobile-nav-${name}`]) {
      const nav = byId(id);
      if (!nav) continue;
      if (name === target) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    }
  }
  setText(byId('pageTitleText'), `nav.${target}`);
  tabOpenHooks.get(target)?.();
  if (window.innerWidth < 768) toggleSidebar(false);
}

// ---------------------------------------------------------------------------------------------
// Chat side panel (#chat-aside): tabs Canvas, Sources, Compare, Research, each panel a mount point.
// A column next to the conversation from lg up, a full-screen panel below.

/** @typedef {'canvas' | 'sources' | 'compare' | 'research'} AsideTab */
export const ASIDE_TABS = /** @type {readonly AsideTab[]} */ (Object.freeze(['canvas', 'sources', 'compare', 'research']));

/** @type {AsideTab} */
let asideTab = 'canvas';
/** @type {Set<(tab: AsideTab | null) => void>} */
const asideListeners = new Set();

/** @param {unknown} value @returns {value is AsideTab} */
function isAsideTab(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (ASIDE_TABS).includes(value);
}

/** @returns {boolean} */
export function isChatAsideOpen() {
  const aside = byId('chat-aside');
  return Boolean(aside && !aside.classList.contains('hidden'));
}

/** @returns {AsideTab} the selected tab (also while the panel is closed) */
export function chatAsideTab() {
  return asideTab;
}

/**
 * Selects a tab of the side panel (roving tabindex, aria-selected) without opening it.
 * @param {string} tab
 * @param {{ focus?: boolean }} [opts]
 */
export function selectChatAsideTab(tab, opts = {}) {
  if (!isAsideTab(tab)) return;
  asideTab = tab;
  for (const name of ASIDE_TABS) {
    const selected = name === tab;
    const button = byId(`chat-aside-tab-${name}`);
    button?.setAttribute('aria-selected', String(selected));
    button?.setAttribute('tabindex', selected ? '0' : '-1');
    byId(`chat-aside-panel-${name}`)?.classList.toggle('hidden', !selected);
    if (selected && opts.focus) button?.focus();
  }
  if (isChatAsideOpen()) notifyAside(tab);
}

/**
 * Opens the side panel on a tab (default: the last one) and moves focus to that tab.
 * @param {string} [tab]
 */
export function openChatAside(tab) {
  const aside = byId('chat-aside');
  if (!aside) return;
  const wasOpen = isChatAsideOpen();
  aside.classList.remove('hidden');
  byId('chatAsideToggle')?.setAttribute('aria-expanded', 'true');
  selectChatAsideTab(isAsideTab(tab) ? tab : asideTab, { focus: true });
  if (!wasOpen) notifyAside(asideTab);
}

export function closeChatAside() {
  const aside = byId('chat-aside');
  if (!aside || !isChatAsideOpen()) return;
  const hadFocus = aside.contains(document.activeElement);
  aside.classList.add('hidden');
  const toggle = byId('chatAsideToggle');
  toggle?.setAttribute('aria-expanded', 'false');
  // Focus returns to the toggle when it is on screen, else to the message box.
  if (hadFocus) (toggle && toggle.getClientRects().length > 0 ? toggle : byId('chatInput'))?.focus();
  notifyAside(null);
}

/**
 * @param {(tab: AsideTab | null) => void} fn called with the shown tab, or null when the panel closes
 * @returns {() => void}
 */
export function onChatAsideChange(fn) {
  asideListeners.add(fn);
  return () => asideListeners.delete(fn);
}

/** @param {AsideTab | null} tab */
function notifyAside(tab) {
  for (const fn of asideListeners) {
    try {
      fn(tab);
    } catch (err) {
      console.error('[starpi] side panel listener failed', err);
    }
  }
}

/**
 * Wires the side panel: the toolbar toggle, its tabs (arrow keys, Home, End) and Escape to close.
 * Features open it on their tab with openChatAside() (also passed to them as ctx.openChatAside).
 */
export function initChatAside() {
  onAction('toggle-chat-aside', () => (isChatAsideOpen() ? closeChatAside() : openChatAside()));
  onAction('close-chat-aside', () => closeChatAside());
  onAction('select-aside-tab', (el) => selectChatAsideTab(el.dataset.arg ?? 'canvas'));
  byId('chatAsideTabs')?.addEventListener('keydown', (event) => {
    const step = /** @type {Record<string, number>} */ ({ ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity })[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = ASIDE_TABS.indexOf(asideTab);
    const next = step === -Infinity ? 0 : step === Infinity ? ASIDE_TABS.length - 1 : (index + step + ASIDE_TABS.length) % ASIDE_TABS.length;
    selectChatAsideTab(ASIDE_TABS[next], { focus: true });
  });
  byId('chat-aside')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeChatAside();
    }
  });
  selectChatAsideTab(asideTab);
}

// ---------------------------------------------------------------------------------------------
// Language switch in the header, generated from the shipped languages: buttons for up to three,
// a select for more.

export function renderLanguageSwitch() {
  const host = byId('langSwitch');
  if (!host) return;
  const current = getLocale();
  if (LOCALES.length > 3) {
    const options = LOCALES.map((code) => html`<option value="${code}" lang="${code}"${code === current ? html` selected` : ''}>${LANGUAGES[code]?.name ?? code}</option>`);
    setHtml(host, html`<i data-lucide="languages" class="w-3.5 h-3.5 mx-1 text-slate-500 hidden sm:block"></i><select data-change="set-locale" class="bg-transparent text-slate-800 font-semibold text-base sm:text-[11px] py-0.5 pr-1 focus:outline-none cursor-pointer" data-i18n-aria="app.language" aria-label="Language">${options}</select>`.value);
    return;
  }
  const buttons = LOCALES.map(
    (code) =>
      html`<button type="button" data-action="set-locale" data-arg="${code}" aria-pressed="${String(code === current)}" class="px-2 py-1 rounded-md transition" lang="${code}" aria-label="${LANGUAGES[code]?.name ?? code}">${LANGUAGES[code]?.short ?? code.toUpperCase()}</button>`,
  );
  setHtml(host, html`<i data-lucide="languages" class="w-3.5 h-3.5 mx-1 text-slate-500 hidden sm:block"></i>${buttons}`.value);
}

export function detectAndDisplayDevice() {
  const userAgent = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
  const isAndroid = /Android/i.test(userAgent);
  const isTablet = /iPad|Tablet/i.test(userAgent) || (window.innerWidth >= 640 && window.innerWidth <= 1024);

  const iconEl = byId('deviceTypeIcon');
  const textEl = byId('detectedDeviceText');
  let icon = 'laptop';
  let labelKey = 'device.laptop';
  if (isTablet) {
    icon = 'tablet';
    labelKey = 'device.tablet';
  } else if (isIOS || isAndroid || window.innerWidth <= 768) {
    icon = 'smartphone';
    labelKey = 'device.smartphone';
  }
  if (iconEl) {
    const placeholder = document.createElement('i');
    placeholder.id = 'deviceTypeIcon';
    placeholder.className = 'w-3.5 h-3.5 text-amber-600';
    placeholder.setAttribute('data-lucide', icon);
    iconEl.replaceWith(placeholder);
    refreshIcons(placeholder.parentElement ?? document);
  }
  setText(textEl, labelKey);
}

/**
 * @param {'ok' | 'warn' | 'off' | 'busy'} tone
 */
function dotClass(tone) {
  switch (tone) {
    case 'ok':
      return 'bg-emerald-500';
    case 'warn':
      return 'bg-amber-400';
    case 'busy':
      return 'bg-amber-400 animate-pulse';
    default:
      return 'bg-slate-400';
  }
}

/**
 * @param {'ok' | 'warn' | 'off' | 'busy'} tone
 */
export function setEngineDot(tone) {
  const dot = byId('engineStatusDot');
  if (dot) dot.className = `w-2 h-2 rounded-full flex-shrink-0 ${dotClass(tone)}`;
}

/**
 * @param {string} key i18n key
 * @param {Record<string, string | number>} [params]
 */
export function setAssistantStatus(key, params) {
  setText(byId('assistantStatusText'), key, params);
}

/**
 * @param {import('./supabase.js').ConnectionState} c
 */
export function renderConnection(c) {
  /** @type {'ok' | 'warn' | 'off' | 'busy'} */
  let tone = 'busy';
  let badge = 'status.connecting';
  let detail = 'status.detail_connecting';
  let auth = 'status.rls_session';
  /** @type {Record<string, string> | undefined} */
  let authParams;

  if (c.status === 'offline') {
    tone = 'off';
    badge = 'status.offline';
    detail = 'status.detail_offline';
    auth = 'status.no_session';
  } else if (c.status === 'ready') {
    if (c.hardened && c.signedIn) {
      tone = 'ok';
      badge = 'status.live';
      detail = 'status.detail_live';
      auth = 'status.rls_session';
    } else if (c.hardened) {
      // Reading published documents works; saving and chat sync need a session.
      tone = 'ok';
      badge = 'status.public';
      detail = 'status.detail_public';
      auth = c.authError?.kind === 'auth_disabled' ? 'status.rls_disabled' : 'status.no_session';
    } else if (c.probeError?.kind === 'missing_schema') {
      tone = 'warn';
      badge = 'status.migration_pending';
      detail = 'status.detail_setup';
      auth = 'status.migration_needed';
    } else {
      tone = 'warn';
      badge = 'status.restricted';
      detail = 'status.detail_setup';
      auth = 'status.probe_error';
      authParams = { code: c.probeError?.code || c.probeError?.kind || 'unknown' };
    }
  }

  const colors = { ok: 'badge-ok', warn: 'badge-warn', off: 'badge-muted', busy: 'badge-muted' };

  const dot = byId('dbStatusDot');
  if (dot) dot.className = `w-2 h-2 rounded-full ${dotClass(tone)}`;
  const badgeEl = byId('dbStatusBadge');
  if (badgeEl) {
    setText(badgeEl, badge);
    badgeEl.className = `badge ${colors[tone]}`;
  }
  setText(byId('dbStatusDetail'), detail);

  // Saving to the knowledge base needs a session and the hardened schema; say so instead of failing.
  const canWrite = c.status === 'ready' && c.signedIn && c.hardened;
  for (const el of document.querySelectorAll('[data-requires-session]')) {
    /** @type {HTMLButtonElement} */ (el).disabled = !canWrite && c.status !== 'pending';
  }
  for (const note of document.querySelectorAll('.session-note')) note.classList.toggle('hidden', canWrite || c.status === 'pending');

  const settingsBadge = byId('settingsDbBadge');
  if (settingsBadge) {
    settingsBadge.className = `badge ${colors[tone]}`;
    const sDot = document.createElement('span');
    sDot.className = `w-1.5 h-1.5 rounded-full ${dotClass(tone)}`;
    const sText = document.createElement('span');
    setText(sText, badge);
    settingsBadge.replaceChildren(sDot, sText);
  }
  const project = byId('settingsDbProject');
  if (project) project.textContent = SUPABASE_PROJECT_REF;
  setText(byId('settingsDbAuth'), auth, authParams);
}
