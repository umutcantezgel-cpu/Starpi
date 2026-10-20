// @ts-check
// "Add knowledge" tab with two separate paths:
//  1. On-device workspace: files are parsed, chunked and BM25-indexed in a Web Worker and kept in
//     this browser's storage unless the user chooses memory only (asked at the first file). Nothing
//     is uploaded; the chat searches them alongside the knowledge base, by meaning as well once
//     semantic search on this device is turned on.
//  2. Shared knowledge base: text is saved to Supabase (RLS-protected, owned by this browser session).
import { invalidateKnownTitles } from './chat.js';
import { LIMITS } from './config.js';
import { byId, onAction, onChange, setHidden, setHtml } from './dom.js';
import { refreshIcons } from './icons.js';
import { formatNumber, onLocaleChange, setText, t } from './i18n/index.js';
import { describeDataError } from './library.js';
import { onProvidersChange } from './providers.js';
import { citationButton, registerCitations } from './rag/citations.js';
import { initSemanticSearch, onSemanticChange, semanticDecided, semanticModel, semanticState, semanticSuggested, setSemanticSearch } from './rag/embed-client.js';
import { IMAGE_EXTENSIONS } from './rag/formats/image.js';
import { OCR_ACCEPT, ocrAvailable, ocrHook } from './rag/ocr-hook.js';
import {
  addToWorkspace,
  clearWorkspace,
  getDocumentText,
  listWorkspace,
  onWorkspaceChange,
  onWorkspaceStatus,
  removeFromWorkspace,
  restoreWorkspace,
  searchWorkspace,
  setKeepFiles,
  workspaceStatus,
} from './rag/workspace.js';
import { escapeHtml, renderMarkdown } from './render.js';
import { assignCitations, workspaceHit } from './retrieval.js';
import { getConnection, insertDocument } from './supabase.js';
import { formatBytes } from './bench/diagnostics.js';
import { toast } from './ui/kit.js';

const SOURCE_TYPES = new Set(['meeting_notes', 'file', 'chat', 'text']);
const WORKSPACE_EXTENSIONS = /\.(pdf|txt|md|markdown|json|csv|log|docx|xlsx|pptx|html?|png|jpe?g|gif|webp)$/i;

/**
 * @param {string} title
 * @param {string} sourceType
 * @param {string} content
 */
export function buildIngestMarkdown(title, sourceType, content) {
  return `# ${title}\n\n## ${t('ingest.md_facts')}\n${content}\n\n## ${t('ingest.md_meta')}\n- **${t('ingest.md_source')}:** ${sourceType}\n- **${t('ingest.md_indexed')}:** ${new Date().toISOString()}`;
}

// ---------------------------------------------------------------------------------------------
// On-device workspace
// ---------------------------------------------------------------------------------------------

function renderWorkspace() {
  const list = byId('workspaceList');
  if (!list) return;
  const docs = listWorkspace();
  setHidden(byId('workspaceEmpty'), docs.length > 0);
  setHidden(byId('workspaceTools'), docs.length === 0);
  const rows = docs.map((doc) => {
    const row = document.createElement('li');
    row.className = 'flex items-center justify-between gap-3 py-2.5';
    row.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0">
        <i data-lucide="${doc.kind === 'pdf' ? 'file-text' : doc.kind === 'json' ? 'braces' : 'file'}" class="w-4 h-4 text-slate-500 flex-shrink-0"></i>
        <div class="min-w-0">
          <p class="text-sm font-medium text-slate-900 truncate">${escapeHtml(doc.name)}</p>
          <p class="text-[11px] text-slate-500 workspace-meta"></p>
        </div>
      </div>
      <div class="flex items-center gap-1 flex-shrink-0">
        <button type="button" data-action="workspace-to-form" data-arg="${escapeHtml(doc.docId)}" class="btn btn-ghost btn-icon" data-i18n-title="workspace.to_form" data-i18n-aria="workspace.to_form" title="${escapeHtml(t('workspace.to_form'))}" aria-label="${escapeHtml(t('workspace.to_form'))}">
          <i data-lucide="database" class="w-4 h-4"></i>
        </button>
        <button type="button" data-action="workspace-remove" data-arg="${escapeHtml(doc.docId)}" class="btn btn-ghost btn-icon text-rose-600" data-i18n-title="workspace.remove" data-i18n-aria="workspace.remove" title="${escapeHtml(t('workspace.remove'))}" aria-label="${escapeHtml(t('workspace.remove'))}">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>`;
    const params = { chunks: formatNumber(doc.chunks), chars: formatNumber(doc.chars) };
    setText(row.querySelector('.workspace-meta'), doc.pages ? 'workspace.meta_pages' : 'workspace.meta', doc.pages ? { ...params, pages: formatNumber(doc.pages) } : params);
    return row;
  });
  list.replaceChildren(...rows);
  refreshIcons(list);
}

/**
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
function setWorkspaceStatus(key, params) {
  const el = byId('workspaceStatus');
  setHidden(el, !key);
  if (key) setText(el, key, params);
}

const WORKSPACE_ERRORS = ['unsupported_type', 'too_large', 'empty', 'invalid_json', 'invalid_pdf', 'encrypted_pdf', 'pdf_reader', 'invalid_document', 'encrypted_document', 'zip_bomb', 'needs_ocr', 'worker_crashed', 'cleared'];

/**
 * The status line with one line per file, so a file that was not added is still reported after
 * the next one finishes.
 * @param {Array<[string, Record<string, string | number>]>} lines
 */
function setWorkspaceReport(lines) {
  const el = byId('workspaceStatus');
  if (!el) return;
  el.removeAttribute('data-i18n');
  el.removeAttribute('data-i18n-params');
  el.replaceChildren(
    ...lines.map(([key, params]) => {
      const line = document.createElement('span');
      line.className = 'block';
      setText(line, key, params);
      return line;
    }),
  );
  setHidden(el, !lines.length);
}

/** Text recognition for images: whether a vision model is set up (checked once, at boot). */
let ocrReady = false;

/** @param {string} name */
const isImage = (name) => IMAGE_EXTENSIONS.has(name.split('.').pop()?.toLowerCase() ?? '');

/** @param {File[]} files */
async function addFiles(files) {
  /** @type {Array<[string, Record<string, string | number>]>} */
  const report = [];
  const show = (/** @type {[string, Record<string, string | number>] | null} */ current) => setWorkspaceReport(current ? [...report, current] : report);
  for (const file of files) {
    if (!WORKSPACE_EXTENSIONS.test(file.name)) {
      report.push(['workspace.error_unsupported_type', { name: file.name }]);
      show(null);
      continue;
    }
    // An image is read by a vision model only after the user agreed, for this one file.
    const image = ocrReady && isImage(file.name);
    if (image && !window.confirm(t('workspace.ocr_confirm', { name: file.name }))) {
      report.push(['workspace.ocr_declined', { name: file.name }]);
      show(null);
      continue;
    }
    show(['workspace.progress_parsing', { name: file.name, done: 0, total: 1 }]);
    try {
      const doc = await addToWorkspace(file, {
        ocr: image ? ocrHook() : undefined,
        onProgress: (p) => show([`workspace.progress_${p.stage}`, { name: file.name, done: formatNumber(p.done), total: formatNumber(p.total) }]),
      });
      report.push(doc.duplicate ? ['workspace.duplicate', { name: doc.name }] : ['workspace.added', { name: doc.name, chunks: formatNumber(doc.chunks) }]);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'internal';
      report.push([`workspace.error_${WORKSPACE_ERRORS.includes(code) ? code : 'internal'}`, { name: file.name }]);
    }
    show(null);
  }
}

async function runWorkspaceSearch() {
  const input = /** @type {HTMLInputElement | null} */ (byId('workspaceQuery'));
  const box = byId('workspaceResults');
  const query = input?.value.trim() ?? '';
  if (!box) return;
  if (!query) {
    box.replaceChildren();
    return;
  }
  const hits = await searchWorkspace(query, 5);
  if (!hits.length) {
    setHtml(box, `<p class="text-xs text-slate-500" data-i18n="workspace.no_results">${escapeHtml(t('workspace.no_results'))}</p>`);
    return;
  }
  const citations = assignCitations(hits.map(workspaceHit), { excerptChars: 100_000 });
  const scope = registerCitations(citations);
  const items = hits.map((hit, i) => {
    const li = document.createElement('li');
    li.className = 'p-3 rounded-lg border border-slate-200 bg-white space-y-1.5';
    const head = document.createElement('div');
    head.className = 'flex flex-wrap items-center justify-between gap-2';
    const score = document.createElement('span');
    score.className = 'badge badge-ok font-mono workspace-score';
    const digits = { minimumFractionDigits: 3, maximumFractionDigits: 3 };
    // A hybrid hit shows its fused rank score; a keyword hit its BM25 score.
    if (hit.similarity !== undefined) setText(score, 'workspace.score_hybrid', { score: formatNumber(hit.score, digits) });
    else setText(score, 'workspace.score', { score: formatNumber(hit.score, digits) });
    head.append(scope ? citationButton(scope, i, 'badge') : document.createTextNode(hit.docName), score);
    const snippet = document.createElement('p');
    snippet.className = 'text-xs text-slate-600 leading-relaxed line-clamp-3';
    snippet.textContent = hit.text;
    li.append(head, snippet);
    return li;
  });
  const list = document.createElement('ol');
  list.className = 'space-y-2';
  list.append(...items);
  box.replaceChildren(list);
  refreshIcons(box);
}

/** @param {string} docId */
async function copyToForm(docId) {
  try {
    const { name, text } = await getDocumentText(docId);
    const titleEl = /** @type {HTMLInputElement | null} */ (byId('ingestTitle'));
    const contentEl = /** @type {HTMLTextAreaElement | null} */ (byId('ingestContent'));
    const typeEl = /** @type {HTMLSelectElement | null} */ (byId('ingestSourceType'));
    if (titleEl) titleEl.value = name.replace(/\.[^.]+$/, '').slice(0, LIMITS.titleChars);
    if (contentEl) contentEl.value = text.slice(0, LIMITS.ingestContentChars);
    if (typeEl) typeEl.value = 'file';
    if (text.length > LIMITS.ingestContentChars) setWorkspaceStatus('workspace.truncated', { max: formatNumber(LIMITS.ingestContentChars) });
    byId('ingestForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    titleEl?.focus();
  } catch {
    setWorkspaceStatus('workspace.error_empty', { name: '' });
  }
}

/**
 * The panel under the drop zone: the first-file question "Keep files on this device after
 * reload?" (kept until answered), then where the files are kept with "Forget all", and, on
 * devices that can run it well, the offer of semantic search on this device.
 */
function renderPersistence() {
  const status = byId('workspaceStatus');
  if (!status) return;
  let panel = byId('workspacePersist');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'workspacePersist';
    panel.className = 'space-y-2';
    status.after(panel);
  }
  const docs = listWorkspace();
  const ws = workspaceStatus();
  /** @type {HTMLElement[]} */
  const parts = [];
  /**
   * @param {string} key
   * @param {Record<string, string | number>} [params]
   * @param {Array<{ key: string, action: string, arg: string, primary?: boolean, danger?: boolean }>} [buttons]
   * @param {string} [testId]
   */
  const row = (key, params, buttons = [], testId) => {
    const box = document.createElement('div');
    box.className = 'flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700';
    if (testId) box.dataset.state = testId;
    const text = document.createElement('p');
    text.className = 'min-w-0 flex-1';
    setText(text, key, params);
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-1.5';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${b.primary ? 'btn-primary' : b.danger ? 'btn-danger' : 'btn-secondary'} py-1`;
      btn.dataset.action = b.action;
      btn.dataset.arg = b.arg;
      setText(btn, b.key);
      actions.append(btn);
    }
    box.append(text, actions);
    parts.push(box);
    return box;
  };
  if (docs.length && ws.ready && !ws.persistent) {
    row('workspace.not_persistent', undefined, [], 'volatile');
  } else if (docs.length && ws.ready && ws.keep === null) {
    const box = row('workspace.keep_prompt', undefined, [
      { key: 'workspace.keep_yes', action: 'workspace-keep', arg: 'yes', primary: true },
      { key: 'workspace.keep_no', action: 'workspace-keep', arg: 'no' },
    ], 'ask');
    const hint = document.createElement('p');
    hint.className = 'w-full text-[11px] text-slate-500';
    setText(hint, 'workspace.keep_prompt_hint');
    box.append(hint);
  } else if (docs.length && ws.keep === false) {
    row('workspace.memory_only', undefined, [{ key: 'workspace.keep_yes', action: 'workspace-keep', arg: 'yes' }], 'memory');
  } else if (docs.length && ws.persistent) {
    const bytes = docs.filter((d) => d.stored).reduce((sum, d) => sum + d.bytes, 0);
    row('workspace.kept', { size: formatBytes(bytes, formatNumber) }, [{ key: 'workspace.forget_all', action: 'workspace-forget-all', arg: '', danger: true }], 'kept');
  }
  if (docs.length && !semanticState().enabled && !semanticDecided() && semanticSuggested()) {
    row('workspace.semantic_offer', { size: formatNumber(semanticModel().approxDownloadMB) }, [
      { key: 'workspace.semantic_turn_on', action: 'workspace-semantic', arg: 'on', primary: true },
      { key: 'workspace.semantic_not_now', action: 'workspace-semantic', arg: 'off' },
    ], 'semantic');
  }
  panel.replaceChildren(...parts);
  setHidden(panel, parts.length === 0);
}

async function forgetAll() {
  try {
    await clearWorkspace();
  } catch (err) {
    console.warn('[starpi] forgetting the workspace failed', err);
  }
  byId('workspaceResults')?.replaceChildren();
  setWorkspaceStatus('workspace.cleared');
  toast('workspace.forgotten', { tone: 'ok' });
}

// ---------------------------------------------------------------------------------------------
// Shared knowledge base (Supabase)
// ---------------------------------------------------------------------------------------------

/** @param {boolean} busy */
function setButtonBusy(busy) {
  const btn = /** @type {HTMLButtonElement | null} */ (byId('ingestBtn'));
  if (!btn) return;
  btn.disabled = busy;
  const icon = document.createElement('i');
  icon.dataset.lucide = busy ? 'loader-2' : 'upload';
  icon.className = busy ? 'w-4 h-4 animate-spin' : 'w-4 h-4';
  const label = document.createElement('span');
  setText(label, busy ? 'ingest.saving' : 'ingest.submit');
  btn.replaceChildren(icon, label);
  refreshIcons(btn);
}

async function submitIngest() {
  const titleEl = /** @type {HTMLInputElement | null} */ (byId('ingestTitle'));
  const typeEl = /** @type {HTMLSelectElement | null} */ (byId('ingestSourceType'));
  const contentEl = /** @type {HTMLTextAreaElement | null} */ (byId('ingestContent'));
  const content = contentEl?.value.trim() ?? '';
  if (!content) {
    window.alert(t('ingest.empty_text_alert'));
    return;
  }
  if (content.length > LIMITS.ingestContentChars) {
    window.alert(t('ingest.too_long', { max: formatNumber(LIMITS.ingestContentChars) }));
    return;
  }
  const sourceType = SOURCE_TYPES.has(typeEl?.value ?? '') ? /** @type {string} */ (typeEl?.value) : 'text';
  const title = (titleEl?.value.trim() || content.split('\n')[0].slice(0, 50) || t('ingest.default_title')).slice(0, LIMITS.titleChars);
  const markdown = buildIngestMarkdown(title, sourceType, content);

  setButtonBusy(true);
  try {
    const res = await insertDocument({
      title,
      sourceType,
      rawContent: content,
      summary: content.length > 200 ? `${content.slice(0, 200)}…` : content,
      tags: ['auto-ingest', sourceType],
      markdown,
      heading: `## ${t('ingest.md_facts')}`,
    });
    if (!res.ok) {
      window.alert(`${t('ingest.save_failed')} ${describeDataError(res.error)}`);
      return;
    }
    invalidateKnownTitles();
    const preview = byId('ingestResultPreview');
    if (preview) {
      const note = getConnection().hardened
        ? ''
        : `<p class="mb-3 text-[11px] font-semibold text-amber-800" data-i18n="ingest.legacy_public_note">${escapeHtml(t('ingest.legacy_public_note'))}</p>`;
      preview.innerHTML = note + renderMarkdown(markdown);
    }
    setHidden(byId('ingestResultCard'), false);
    clearForm();
  } catch (err) {
    window.alert(t('ingest.error', { reason: err instanceof Error ? err.message : String(err) }));
  } finally {
    setButtonBusy(false);
  }
}

function clearForm() {
  const titleEl = /** @type {HTMLInputElement | null} */ (byId('ingestTitle'));
  const contentEl = /** @type {HTMLTextAreaElement | null} */ (byId('ingestContent'));
  if (titleEl) titleEl.value = '';
  if (contentEl) contentEl.value = '';
}

export function initIngest() {
  onAction('submit-ingest', () => submitIngest());
  onAction('clear-ingest', () => clearForm());
  onAction('pick-workspace-files', () => byId('workspaceFileInput')?.click());
  onAction('workspace-remove', (el) => removeFromWorkspace(el.dataset.arg ?? ''));
  onAction('workspace-to-form', (el) => copyToForm(el.dataset.arg ?? ''));
  onAction('workspace-clear', () => {
    if (!window.confirm(t('workspace.clear_confirm'))) return;
    void clearWorkspace().catch((err) => console.warn('[starpi] clearing the workspace failed', err));
    byId('workspaceResults')?.replaceChildren();
    setWorkspaceStatus('workspace.cleared');
  });
  onAction('workspace-forget-all', () => forgetAll());
  onAction('workspace-keep', (el) => void setKeepFiles(el.dataset.arg === 'yes').catch((err) => console.warn('[starpi] could not change where files are kept', err)));
  onAction('workspace-semantic', (el) => void setSemanticSearch(el.dataset.arg === 'on').then(renderPersistence));
  onChange('workspace-files', (el) => {
    const input = /** @type {HTMLInputElement} */ (el);
    const files = [...(input.files ?? [])];
    input.value = '';
    return addFiles(files);
  });

  byId('workspaceSearchForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void runWorkspaceSearch();
  });

  onWorkspaceChange(() => {
    renderWorkspace();
    renderPersistence();
  });
  onWorkspaceStatus(() => renderPersistence());
  onSemanticChange(() => renderPersistence());
  onLocaleChange(() => renderWorkspace());
  renderWorkspace();
  renderPersistence();
  // Files kept on this device come back after a reload; semantic search picks them up.
  void restoreWorkspace()
    .then(() => initSemanticSearch())
    .catch((err) => console.warn('[starpi] restoring the workspace failed', err));
  // Images become sources once a model that reads them is set up, also when that happens later.
  const checkOcr = () =>
    void ocrAvailable().then((ok) => {
      ocrReady = ok;
      const input = /** @type {HTMLInputElement | null} */ (byId('workspaceFileInput'));
      if (ok && input && !input.accept.includes('.png')) input.accept = `${input.accept},${OCR_ACCEPT}`;
    });
  checkOcr();
  onProvidersChange(checkOcr);

  const zone = byId('dropZone');
  const highlight = ['border-amber-500', 'bg-amber-50'];
  zone?.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add(...highlight);
  });
  zone?.addEventListener('dragleave', () => zone.classList.remove(...highlight));
  zone?.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove(...highlight);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) void addFiles(files);
  });
  zone?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      byId('workspaceFileInput')?.click();
    }
  });
}
