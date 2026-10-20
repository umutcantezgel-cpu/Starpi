// @ts-check
// Application entry point (loaded as an ES module; the CSP forbids inline scripts).
import { initBenchUi, refreshDiagnostics } from './bench/bench-ui.js';
import { refreshSyncStatus } from './chat-store.js';
import { initChat, restoreHistory } from './chat.js';
import { initDemo } from './demo.js';
import { loadShippedLanguages } from './core/lang/index.js';
import { closeDialog, openDialog } from './dialog.js';
import { byId, installDelegation, onAction, onChange, reportUnexpected, setHidden } from './dom.js';
import { initEngineUi } from './engine-ui.js';
import { mountFeatures } from './features/index.js';
import { initGraphTab } from './graph-tab.js';
import { initI18n, onLocaleChange, setLocale } from './i18n/index.js';
import { refreshIcons } from './icons.js';
import { initIngest } from './ingest.js';
import { initLibrary, loadDocuments } from './library.js';
import { initMessages } from './messages.js';
import { initModelPicker } from './model-picker.js';
import { initCitations } from './rag/citations.js';
import { initReceipts } from './rag/receipts.js';
import { initProviders } from './providers.js';
import { changeEngine, initSettings, renderPrivacyNotice } from './settings.js';
import { getAssistant } from './state.js';
import { connect, onConnectionChange } from './supabase.js';
import { closeChatAside, detectAndDisplayDevice, initChatAside, onTabOpen, openChatAside, renderConnection, renderLanguageSwitch, switchTab } from './ui.js';
import { toast } from './ui/kit.js';
import { initSidebar, setNavVisible } from './ui/sidebar.js';
import { initTheme } from './ui/theme.js';
import { initVoice } from './voice.js';

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Navigations are network-first and assets are content-hashed, so a page usually already runs the
  // newest build when a new worker takes over. The banner appears only when this page's code is
  // older than the deployed build, and "Reload" reloads only this tab (never other open tabs, whose
  // workspaces and drafts live in memory).
  const currentMain = document.querySelector('script[type="module"][src^="/assets/"]')?.getAttribute('src') ?? null;
  onAction('reload-app', () => window.location.reload());
  onAction('dismiss-update', () => setHidden(byId('updateBanner'), true));
  const checkForUpdate = async () => {
    try {
      const res = await fetch('/build-manifest.json', { cache: 'no-store' });
      if (!res.ok) return;
      const manifest = await res.json();
      const latest = manifest?.entries?.mainJs;
      if (currentMain && typeof latest === 'string' && latest !== currentMain) setHidden(byId('updateBanner'), false);
    } catch {
      // Offline or no manifest: nothing to compare against.
    }
  };
  // Assets loaded before a worker controlled the page (the first visit) did not pass through it; the
  // worker caches them on request so an offline start finds every chunk the page has used. A load that
  // started before the worker took control can finish after it, so loads are collected as they finish
  // and named whenever a worker controls the page.
  /** @type {Set<string>} */
  const loadedAssets = new Set();
  /** @type {Set<string>} */
  const unreported = new Set();
  const reportLoadedAssets = () => {
    const controller = navigator.serviceWorker.controller;
    if (!controller || unreported.size === 0) return;
    controller.postMessage({ type: 'CACHE_ASSETS', urls: [...unreported] });
    unreported.clear();
  };
  /** @param {PerformanceEntryList} entries */
  const noteLoadedAssets = (entries) => {
    for (const entry of entries) {
      // A load the worker answered (workerStart set) is cached by the worker itself.
      if (/** @type {PerformanceResourceTiming} */ (entry).workerStart > 0) continue;
      const url = new URL(entry.name, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/assets/') || loadedAssets.has(url.pathname)) continue;
      loadedAssets.add(url.pathname);
      unreported.add(url.pathname);
    }
    reportLoadedAssets();
  };
  noteLoadedAssets(performance.getEntriesByType('resource'));
  if (typeof PerformanceObserver === 'function') {
    try {
      new PerformanceObserver((list) => noteLoadedAssets(list.getEntries())).observe({ type: 'resource' });
    } catch {
      // Without resource observation the loads seen when the worker takes control are named.
    }
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    void checkForUpdate();
    noteLoadedAssets(performance.getEntriesByType('resource'));
    reportLoadedAssets();
  });
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (err) {
      console.warn('[starpi] service worker registration failed', err);
    }
  });
}

async function boot() {
  // English by default; a stored choice wins (its dictionary is loaded before this module runs).
  // Applied before any module renders text.
  initI18n();
  installDelegation();
  // The shell: theme (already applied by theme-boot.js), sidebar rail and drawer, language switch,
  // chat side panel.
  initTheme();
  initSidebar();
  renderLanguageSwitch();
  initChatAside();
  onAction('switch-tab', (el) => switchTab(el.dataset.arg ?? 'chat'));
  onAction('set-locale', (el) => setLocale(el.dataset.arg ?? 'en'));
  onChange('set-locale', (el) => setLocale(/** @type {HTMLSelectElement} */ (el).value));

  onTabOpen('library', () => void loadDocuments());
  onTabOpen('bench', () => void refreshDiagnostics());

  initMessages();
  // The AI layer (adapters, transports, the router's world) is set up once the page is idle and
  // again whenever keys, pools or the own server change.
  initProviders();
  initSettings();
  // After the settings: the pickers show the stored choice, then the device's model groups.
  initModelPicker();
  initEngineUi();
  initChat();
  initLibrary();
  initIngest();
  initGraphTab();
  initVoice();
  initBenchUi();
  initCitations();
  initDemo();
  initReceipts();

  // Features render into the shell's mount points (features/registry.js).
  void mountFeatures({ onAction, onChange, onLocaleChange, onTabOpen, switchTab, setNavVisible, openChatAside, closeChatAside, openDialog, closeDialog, toast }).catch(reportUnexpected);

  refreshIcons();
  detectAndDisplayDevice();
  registerServiceWorker();
  // The language packs beyond English and German load after the first paint, each from a chunk of
  // its own; the source check, Auto routing and the graph read those languages once they are in.
  void loadShippedLanguages().catch(reportUnexpected);

  onConnectionChange((state) => {
    renderConnection(state);
    renderPrivacyNotice();
    void refreshSyncStatus();
  });

  // Apply the stored assistant without triggering downloads (only an already cached model is loaded).
  void changeEngine(getAssistant(), { interactive: false });

  const state = await connect();
  renderConnection(state);
  await restoreHistory();
}

boot().catch(reportUnexpected);
