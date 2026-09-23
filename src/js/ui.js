// @ts-check
// Navigation, sidebar, device indicator, and connection/status indicators.
import { SUPABASE_PROJECT_REF } from './config.js';
import { byId } from './dom.js';
import { refreshIcons } from './icons.js';
import { t } from './i18n/index.js';

const TABS = ['chat', 'library', 'graph', 'ingest', 'bench', 'settings'];

const ACTIVE_NAV = ['bg-amber-50', 'text-amber-950', 'border', 'border-amber-300/80', 'font-bold', 'shadow-xs'];

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
  for (const tName of TABS) {
    byId(`tab-${tName}`)?.classList.add('hidden');
    const nav = byId(`nav-${tName}`);
    if (nav) {
      nav.classList.remove(...ACTIVE_NAV);
      nav.classList.add('text-slate-600', 'hover:text-slate-950', 'hover:bg-slate-100/70', 'font-medium');
    }
    const mNav = byId(`mobile-nav-${tName}`);
    if (mNav) {
      mNav.classList.remove(...ACTIVE_NAV);
      mNav.classList.add('text-slate-600', 'hover:text-slate-900', 'font-medium');
    }
  }

  byId(`tab-${target}`)?.classList.remove('hidden');
  const activeNav = byId(`nav-${target}`);
  if (activeNav) {
    activeNav.classList.add(...ACTIVE_NAV);
    activeNav.classList.remove('text-slate-600', 'hover:text-slate-950', 'hover:bg-slate-100/70', 'font-medium');
  }
  const activeMNav = byId(`mobile-nav-${target}`);
  if (activeMNav) {
    activeMNav.classList.add(...ACTIVE_NAV);
    activeMNav.classList.remove('text-slate-600', 'hover:text-slate-900', 'font-medium');
  }

  const titleEl = byId('pageTitleText');
  if (titleEl) {
    titleEl.textContent = t(`nav.${target}`) || 'Starpi';
  }

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
  if (textEl) textEl.textContent = t(labelKey);
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
 * @param {string} text
 */
export function setAssistantStatus(text) {
  const el = byId('assistantStatusText');
  if (el) el.textContent = text;
}

/**
 * @param {import('./supabase.js').ConnectionState} c
 */
export function renderConnection(c) {
  /** @type {'ok' | 'warn' | 'off' | 'busy'} */
  let tone = 'busy';
  let badge = t('status.connecting');
  let auth = t('status.rls_session');

  if (c.status === 'offline') {
    tone = 'off';
    badge = t('status.offline');
    auth = t('status.no_session');
  } else if (c.status === 'ready') {
    if (c.hardened && c.signedIn) {
      tone = 'ok';
      badge = t('status.live');
      auth = t('status.rls_session');
    } else if (c.hardened) {
      tone = 'warn';
      badge = t('status.read_only');
      auth = c.authError?.kind === 'auth_disabled' ? t('status.rls_disabled') : t('status.no_session');
    } else if (c.probeError?.kind === 'missing_schema') {
      tone = 'warn';
      badge = t('status.migration_pending');
      auth = t('status.migration_needed');
    } else {
      tone = 'warn';
      badge = t('status.restricted');
      auth = `Error (${c.probeError?.code || c.probeError?.kind || 'unknown'})`;
    }
  }

  const colors = {
    ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warn: 'bg-amber-50 text-amber-800 border-amber-200',
    off: 'bg-slate-50 text-slate-600 border-slate-200',
    busy: 'bg-slate-50 text-slate-600 border-slate-200',
  };

  const dot = byId('dbStatusDot');
  if (dot) dot.className = `w-2 h-2 rounded-full ${dotClass(tone)}`;
  const badgeEl = byId('dbStatusBadge');
  if (badgeEl) {
    badgeEl.textContent = badge;
    badgeEl.className = `text-[10px] uppercase font-bold font-mono px-2 py-0.5 rounded-full border ${colors[tone]}`;
  }
  const label = byId('dbProjectLabel');
  if (label) label.textContent = SUPABASE_PROJECT_REF;

  const settingsBadge = byId('settingsDbBadge');
  if (settingsBadge) {
    settingsBadge.className = `text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 ${colors[tone]}`;
    settingsBadge.replaceChildren();
    const sDot = document.createElement('span');
    sDot.className = `w-1.5 h-1.5 rounded-full ${dotClass(tone)}`;
    settingsBadge.append(sDot, document.createTextNode(badge));
  }
  const project = byId('settingsDbProject');
  if (project) project.textContent = SUPABASE_PROJECT_REF;
  const authEl = byId('settingsDbAuth');
  if (authEl) authEl.textContent = auth;
}
