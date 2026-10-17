// @ts-check
// Application entry point (loaded as an ES module; the CSP forbids inline scripts).
import { initBenchUi, refreshDiagnostics } from './bench/bench-ui.js';
import { refreshSyncStatus } from './chat-store.js';
import { initChat, restoreHistory } from './chat.js';
import { initDemo } from './demo.js';
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
import { changeEngine, initSettings, renderPrivacyNotice } from './settings.js';
import { getMode } from './state.js';
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
