// @ts-check
// Application entry point (loaded as an ES module; the CSP forbids inline scripts).
import { initBenchUi, refreshDiagnostics } from './bench/bench-ui.js';
import { refreshSyncStatus } from './chat-store.js';
import { initChat, restoreHistory } from './chat.js';
import { initDemo } from './demo.js';
import { byId, installDelegation, onAction, reportUnexpected, setHidden } from './dom.js';
import { initEngineUi } from './engine-ui.js';
import { initGraph, loadKnowledgeGraph } from './graph.js';
import { initI18n, setLocale } from './i18n/index.js';
import { refreshIcons } from './icons.js';
import { initIngest } from './ingest.js';
import { initLibrary, loadDocuments } from './library.js';
import { initMessages } from './messages.js';
import { initCitations } from './rag/citations.js';
import { initReceipts } from './rag/receipts.js';
import { changeEngine, initSettings, renderPrivacyNotice } from './settings.js';
import { getMode } from './state.js';
import { connect, onConnectionChange } from './supabase.js';
import { detectAndDisplayDevice, onTabOpen, renderConnection, switchTab, syncSidebarAccess, toggleSidebar } from './ui.js';
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
  navigator.serviceWorker.addEventListener('controllerchange', () => void checkForUpdate());
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (err) {
      console.warn('[starpi] service worker registration failed', err);
    }
  });
}

async function boot() {
  // English by default; a stored choice wins. Applied before any module renders text.
  initI18n();
  installDelegation();
  onAction('switch-tab', (el) => switchTab(el.dataset.arg ?? 'chat'));
  onAction('toggle-sidebar', () => toggleSidebar());
  syncSidebarAccess(false);
  onAction('set-locale', (el) => setLocale(el.dataset.arg ?? 'en'));

  onTabOpen('library', () => void loadDocuments());
  onTabOpen('graph', () => void loadKnowledgeGraph());
  onTabOpen('bench', () => void refreshDiagnostics());

  initMessages();
  initSettings();
  initEngineUi();
  initChat();
  initLibrary();
  initIngest();
  initGraph();
  initVoice();
  initBenchUi();
  initCitations();
  initDemo();
  initReceipts();

  refreshIcons();
  detectAndDisplayDevice();
  registerServiceWorker();

  onConnectionChange((state) => {
    renderConnection(state);
    renderPrivacyNotice();
    void refreshSyncStatus();
  });

  // Apply the persisted mode without triggering downloads (only an already cached model is loaded).
  void changeEngine(getMode(), { interactive: false });

  const state = await connect();
  renderConnection(state);
  await restoreHistory();
}

boot().catch(reportUnexpected);
