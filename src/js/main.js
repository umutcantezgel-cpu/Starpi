// @ts-check
// Application entry point (loaded as an ES module; the CSP forbids inline scripts).
import { initBenchUi, refreshDiagnostics } from './bench/bench-ui.js';
import { refreshSyncStatus } from './chat-store.js';
import { initChat, restoreHistory } from './chat.js';
import { byId, installDelegation, onAction, reportUnexpected, setHidden } from './dom.js';
import { initEngineUi } from './engine-ui.js';
import { initGraph, loadKnowledgeGraph } from './graph.js';
import { initI18n, setLocale } from './i18n/index.js';
import { refreshIcons } from './icons.js';
import { initIngest } from './ingest.js';
import { initLibrary, loadDocuments } from './library.js';
import { initMessages } from './messages.js';
import { initCitations } from './rag/citations.js';
import { changeEngine, initSettings, renderPrivacyNotice } from './settings.js';
import { getMode } from './state.js';
import { connect, onConnectionChange } from './supabase.js';
import { detectAndDisplayDevice, onTabOpen, renderConnection, switchTab, toggleSidebar } from './ui.js';
import { initVoice } from './voice.js';

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  /** @type {ServiceWorkerRegistration | null} */
  let registration = null;

  const showUpdate = () => setHidden(byId('updateBanner'), false);
  onAction('reload-app', () => {
    if (registration?.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    else window.location.reload();
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First install claims the page; only reload when an older worker was replaced.
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      if (registration.waiting && navigator.serviceWorker.controller) showUpdate();
      registration.addEventListener('updatefound', () => {
        const installing = registration?.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) showUpdate();
        });
      });
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
