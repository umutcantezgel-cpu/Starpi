// @ts-check
// Navigation, sidebar, device indicator, and connection/status indicators.
import { SUPABASE_PROJECT_REF } from './config.js';
import { byId } from './dom.js';
import { refreshIcons } from './icons.js';
import { setText } from './i18n/index.js';

const TABS = ['chat', 'library', 'graph', 'ingest', 'bench', 'settings'];

/** @type {Map<string, () => void>} */
const tabOpenHooks = new Map();

/**
 * @param {string} tab
 * @param {() => void} hook
 */
export function onTabOpen(tab, hook) {
  tabOpenHooks.set(tab, hook);
}

/** @param {string} tabId */
export function switchTab(tabId) {
  const target = TABS.includes(tabId) ? tabId : 'chat';
  for (const name of TABS) {
    byId(`tab-${name}`)?.classList.toggle('hidden', name !== target);
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

/** @param {boolean} [forcedState] */
export function toggleSidebar(forcedState) {
  const sidebar = byId('sidebar');
  const backdrop = byId('mobileBackdrop');
  if (!sidebar || !backdrop) return;
  const isVisible = !sidebar.classList.contains('-translate-x-full');
  const shouldOpen = forcedState ?? !isVisible;
  sidebar.classList.toggle('-translate-x-full', !shouldOpen);
  backdrop.classList.toggle('hidden', !shouldOpen);
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
  let auth = 'status.rls_session';
  /** @type {Record<string, string> | undefined} */
  let authParams;

  if (c.status === 'offline') {
    tone = 'off';
    badge = 'status.offline';
    auth = 'status.no_session';
  } else if (c.status === 'ready') {
    if (c.hardened && c.signedIn) {
      tone = 'ok';
      badge = 'status.live';
      auth = 'status.rls_session';
    } else if (c.hardened) {
      tone = 'warn';
      badge = 'status.read_only';
      auth = c.authError?.kind === 'auth_disabled' ? 'status.rls_disabled' : 'status.no_session';
    } else if (c.probeError?.kind === 'missing_schema') {
      tone = 'warn';
      badge = 'status.migration_pending';
      auth = 'status.migration_needed';
    } else {
      tone = 'warn';
      badge = 'status.restricted';
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
  const label = byId('dbProjectLabel');
  if (label) label.textContent = SUPABASE_PROJECT_REF;

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
