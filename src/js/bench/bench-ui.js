// @ts-check
// Diagnostics & Benchmark tab, the part the app loads at start: the tab's action and refresh hook.
// The tab itself (adapter details, the benchmark, the history with its charts) is bench-tab.js,
// loaded when the tab first opens or the benchmark is started.
import { isChatBusy } from '../chat.js';
import { onAction, reportUnexpected } from '../dom.js';
import { startLocalEngine } from '../engine-ui.js';
import { onLocaleChange } from '../i18n/index.js';
import * as engine from '../webgpu/engine.js';

/** @type {Promise<typeof import('./bench-tab.js')> | null} */
let tab = null;

function loadTab() {
  tab ??= import('./bench-tab.js').catch((err) => {
    tab = null;
    throw err;
  });
  return tab;
}

/** Reads the adapter, fills the hardware card and shows the history for this device. */
export async function refreshDiagnostics() {
  try {
    await (await loadTab()).refreshDiagnostics();
  } catch (err) {
    reportUnexpected(err);
  }
}

export function initBenchUi() {
  onAction('run-benchmark', async () => (await loadTab()).executeBenchmark({ isChatBusy, startLocalEngine }));
  // Only a loaded tab has anything to update.
  engine.onEngineChange(() => void tab?.then((m) => m.renderRunner(), () => {}));
  onLocaleChange(() => void tab?.then((m) => m.onLocale(), () => {}));
}
