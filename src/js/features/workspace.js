// @ts-check
// Files on this device, in Settings: how much storage the site uses, whether workspace files are
// kept after a reload, "Forget all", and the opt-in for semantic search on this device with its
// model. The section is built the first time it scrolls into view (the Settings tab opened), so
// the quota is only estimated when someone looks at it.
import { formatBytes } from '../bench/diagnostics.js';
import { formatNumber, setText } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { onSemanticChange, semanticModel, semanticModels, semanticState, semanticSuggested, setSemanticSearch } from '../rag/embed-client.js';
import { onWorkspaceChange, onWorkspaceStatus, setKeepFiles, workspaceStats, workspaceStatus } from '../rag/workspace.js';
import { describeUsage, estimateStorage, isPersisted } from '../store/quota.js';
import { registerFeature } from './registry.js';

/** @typedef {import('../rag/embed-client.js').SemanticState} SemanticState */

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [key]
 * @param {Record<string, string | number>} [params]
 */
function el(tag, className, key, params) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) setText(node, key, params);
  return node;
}

/** @param {number} bytes */
const size = (bytes) => formatBytes(bytes, formatNumber);

/**
 * A checkbox row with its label.
 * @param {string} id
 * @param {string} key
 */
function checkbox(id, key) {
  const row = el('label', 'flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none');
  const input = /** @type {HTMLInputElement} */ (el('input', 'rounded border-slate-300 text-amber-500 focus:ring-amber-300'));
  input.type = 'checkbox';
  input.id = id;
  row.append(input, el('span', '', key));
  return { row, input };
}

/** @param {HTMLElement} root */
function build(root) {
  const card = el('div', 'card p-4 sm:p-5 space-y-4');
  card.id = 'workspaceSettingsCard';
  const header = el('div', 'card-header');
  const title = el('h3', 'card-title');
  const icon = el('i', 'w-4 h-4 text-amber-600');
  icon.dataset.lucide = 'hard-drive';
  title.append(icon, el('span', '', 'workspace.settings_title'));
  header.append(title);

  const usage = el('p', 'text-xs text-slate-600');
  usage.id = 'wsUsage';
  const persisted = el('p', 'text-[11px] text-slate-500');
  persisted.id = 'wsPersisted';
  const files = el('p', 'text-xs text-slate-600');
  files.id = 'wsFiles';
  const keep = checkbox('wsKeep', 'workspace.settings_keep');
  const forgetRow = el('div', 'flex justify-end');
  const forget = el('button', 'btn btn-danger');
  forget.setAttribute('type', 'button');
  forget.id = 'wsForgetAll';
  forget.dataset.action = 'workspace-forget-all';
  const trash = el('i', 'w-3.5 h-3.5');
  trash.dataset.lucide = 'trash-2';
  forget.append(trash, el('span', '', 'workspace.forget_all'));
  forgetRow.append(forget);

  const semantic = el('div', 'pt-3 border-t border-slate-100 space-y-2');
  const toggle = checkbox('wsSemantic', 'workspace.settings_semantic');
  const hint = el('p', 'text-[11px] text-slate-500 leading-relaxed', 'workspace.settings_semantic_hint');
  const modelLabel = el('label', 'field-label', 'workspace.settings_semantic_model');
  modelLabel.setAttribute('for', 'wsSemanticModel');
  const select = /** @type {HTMLSelectElement} */ (el('select', 'field'));
  select.id = 'wsSemanticModel';
  for (const m of semanticModels()) {
    const option = /** @type {HTMLOptionElement} */ (el('option', '', m.languages === 'multilingual' ? 'workspace.model_multilingual' : 'workspace.model_english', { name: m.label }));
    option.value = m.key;
    select.append(option);
  }
  const download = el('p', 'text-[11px] text-slate-500');
  download.id = 'wsSemanticSize';
  const device = el('p', 'text-[11px] text-slate-500', semanticSuggested() ? 'workspace.settings_semantic_suggested' : 'workspace.settings_semantic_slow');
  const status = el('p', 'text-xs text-slate-700');
  status.id = 'wsSemanticStatus';
  status.setAttribute('role', 'status');
  semantic.append(toggle.row, hint, modelLabel, select, download, device, status);

  card.append(header, usage, persisted, files, keep.row, forgetRow, semantic);
  root.replaceChildren(card);
  refreshIcons(card);

  keep.input.addEventListener('change', () => {
    keep.input.disabled = true;
    void setKeepFiles(keep.input.checked)
      .catch((err) => console.warn('[starpi] could not change where files are kept', err))
      .finally(() => {
        keep.input.disabled = false;
        void refreshStorage();
      });
  });
  toggle.input.addEventListener('change', () => void setSemanticSearch(toggle.input.checked, /** @type {any} */ (select.value)));
  select.addEventListener('change', () => void setSemanticSearch(semanticState().enabled, /** @type {any} */ (select.value)));

  const renderWorkspace = () => {
    const s = workspaceStatus();
    keep.input.checked = s.keep !== false;
    keep.input.disabled = !s.persistent && s.ready;
  };
  /** @param {SemanticState} s */
  const renderSemantic = (s) => {
    toggle.input.checked = s.enabled;
    select.value = s.model;
    setText(download, 'workspace.settings_semantic_size', { size: formatNumber(semanticModel().approxDownloadMB) });
    if (s.phase === 'off') setText(status, 'workspace.semantic_off');
    else if (s.phase === 'loading') setText(status, 'workspace.semantic_loading', { percent: formatNumber(Math.round(s.progress * 100)) });
    else if (s.phase === 'indexing') setText(status, 'workspace.semantic_indexing', { done: formatNumber(s.done), total: formatNumber(s.total) });
    // A refused download is said in the reader's language, with what to do about it.
    else if (s.phase === 'error' && s.integrity) setText(status, s.integrity.code === 'mismatch' ? 'engine.error.integrity' : 'engine.error.unverified', { model: s.integrity.model, files: s.integrity.files });
    else if (s.phase === 'error') setText(status, 'workspace.semantic_error', { reason: s.error ?? '' });
    else if (s.phase === 'ready') setText(status, 'workspace.semantic_ready', { count: formatNumber(workspaceStatus().vectors) });
    else setText(status, 'workspace.semantic_idle');
  };

  const refreshStorage = async () => {
    const [estimate, protectedData, stats] = await Promise.all([estimateStorage(), isPersisted(), workspaceStats().catch(() => null)]);
    if (estimate.supported) {
      const d = describeUsage(estimate, formatNumber);
      setText(usage, 'workspace.settings_usage', { usage: d.usage, quota: d.quota, percent: formatNumber(d.percent) });
    } else {
      setText(usage, 'workspace.settings_usage_unknown');
    }
    persisted.hidden = protectedData === null;
    if (protectedData !== null) setText(persisted, protectedData ? 'workspace.settings_persisted' : 'workspace.settings_not_persisted');
    if (stats && !stats.persistent && stats.ready) setText(files, 'workspace.not_persistent');
    else if (stats && stats.documents > 0 && stats.keep !== false) setText(files, 'workspace.settings_files', { count: formatNumber(stats.documents), size: size(stats.storedBytes) });
    else setText(files, 'workspace.settings_files_none');
    renderWorkspace();
  };

  renderWorkspace();
  renderSemantic(semanticState());
  onSemanticChange(renderSemantic);
  onWorkspaceStatus(() => {
    renderWorkspace();
    renderSemantic(semanticState());
  });
  let pending = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  onWorkspaceChange(() => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void refreshStorage();
    }, 300);
  });
  return refreshStorage;
}

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'workspace',
  mount(root) {
    /** @type {(() => Promise<void>) | null} */
    let refresh = null;
    const show = () => {
      refresh ??= build(root);
      void refresh();
    };
    if (typeof IntersectionObserver !== 'function') {
      show();
      return;
    }
    // The mount point is hidden while empty (empty:hidden); watch its parent section instead.
    const target = root.parentElement ?? root;
    let visible = false;
    new IntersectionObserver((entries) => {
      const now = entries.some((e) => e.isIntersecting);
      if (now && !visible) show();
      visible = now;
    }).observe(target);
  },
};

registerFeature('workspaceSettings', feature);
