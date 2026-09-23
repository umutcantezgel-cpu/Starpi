// @ts-check
// "Add knowledge" tab with two separate paths:
//  1. On-device workspace: files are parsed, chunked and BM25-indexed in a Web Worker and kept in
//     memory only. Nothing is uploaded; the chat searches them alongside the knowledge base.
//  2. Shared knowledge base: text is saved to Supabase (RLS-protected, owned by this browser session).
import { invalidateKnownTitles } from './chat.js';
import { LIMITS } from './config.js';
import { byId, onAction, onChange, setHidden, setHtml } from './dom.js';
import { refreshIcons } from './icons.js';
import { formatNumber, onLocaleChange, setText, t } from './i18n/index.js';
import { describeDataError } from './library.js';
import { citationButton, registerCitations } from './rag/citations.js';
import { addToWorkspace, clearWorkspace, getDocumentText, listWorkspace, onWorkspaceChange, removeFromWorkspace, searchWorkspace } from './rag/workspace.js';
import { escapeHtml, renderMarkdown } from './render.js';
import { assignCitations } from './retrieval.js';
import { getConnection, insertDocument } from './supabase.js';

const SOURCE_TYPES = new Set(['meeting_notes', 'file', 'chat', 'text']);
const WORKSPACE_EXTENSIONS = /\.(pdf|txt|md|markdown|json|csv|log)$/i;

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

/** @param {File[]} files */
async function addFiles(files) {
  for (const file of files) {
    if (!WORKSPACE_EXTENSIONS.test(file.name)) {
      setWorkspaceStatus('workspace.error_unsupported_type', { name: file.name });
      continue;
    }
    setWorkspaceStatus('workspace.progress_parsing', { name: file.name, done: 0, total: 1 });
    try {
      const doc = await addToWorkspace(file, {
        onProgress: (p) => setWorkspaceStatus(`workspace.progress_${p.stage}`, { name: file.name, done: formatNumber(p.done), total: formatNumber(p.total) }),
      });
      setWorkspaceStatus('workspace.added', { name: doc.name, chunks: formatNumber(doc.chunks) });
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'internal';
      const known = ['unsupported_type', 'too_large', 'empty', 'invalid_json', 'invalid_pdf', 'encrypted_pdf', 'worker_crashed', 'cleared'];
      setWorkspaceStatus(`workspace.error_${known.includes(code) ? code : 'internal'}`, { name: file.name });
    }
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
  const citations = assignCitations(
    hits.map((h) => ({
      documentId: h.docId,
      documentTitle: h.docName,
      heading: '',
      content: h.text,
      tags: [],
      rank: h.score,
      workspace: { docId: h.docId, chunkIndex: h.chunkIndex, start: h.start, end: h.end },
    })),
    { excerptChars: 100_000 },
  );
  const scope = registerCitations(citations);
  const items = hits.map((hit, i) => {
    const li = document.createElement('li');
    li.className = 'p-3 rounded-lg border border-slate-200 bg-white space-y-1.5';
    const head = document.createElement('div');
    head.className = 'flex flex-wrap items-center justify-between gap-2';
    const score = document.createElement('span');
    score.className = 'badge badge-ok font-mono workspace-score';
    setText(score, 'workspace.score', { score: formatNumber(hit.score, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) });
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
    clearWorkspace();
    byId('workspaceResults')?.replaceChildren();
    setWorkspaceStatus('workspace.cleared');
  });
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

  onWorkspaceChange(() => renderWorkspace());
  onLocaleChange(() => renderWorkspace());
  renderWorkspace();

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
