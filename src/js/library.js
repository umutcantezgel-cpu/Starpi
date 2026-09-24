// @ts-check
// Knowledge library: document list and detail modal.
import { closeDialog, isDialogOpen, openDialog } from './dialog.js';
import { byId, onAction, setHtml } from './dom.js';
import { formatDate, formatNumber, setText, t } from './i18n/index.js';
import { escapeHtml, renderMarkdown } from './render.js';
import { getDocument, listDocuments } from './supabase.js';

/** @param {import('./supabase.js').DataError} error */
export function describeDataError(error) {
  const [key, params] = dataErrorKey(error);
  return t(key, params);
}

/**
 * The i18n key and parameters for a data error, so the message follows a language switch.
 * @param {import('./supabase.js').DataError} error
 * @returns {[string, Record<string, string>?]}
 */
export function dataErrorKey(error) {
  switch (error.kind) {
    case 'network':
    case 'timeout':
      return ['data.error_unreachable'];
    case 'missing_schema':
    case 'missing_function':
      return ['data.error_missing_schema'];
    case 'forbidden':
      return ['data.error_forbidden'];
    case 'not_found':
      return ['data.error_not_found'];
    case 'auth_disabled':
      return ['data.error_auth_disabled'];
    default:
      return ['data.error_other', { reason: error.message }];
  }
}

/** Translated labels for the document types the app writes; other values are shown as stored. */
const SOURCE_LABELS = /** @type {Record<string, string>} */ ({
  meeting_notes: 'ingest.cat_meeting',
  file: 'ingest.cat_file',
  chat: 'ingest.cat_chat',
  text: 'ingest.cat_text',
});
/** Internal tags that mean nothing to a reader. */
const HIDDEN_TAGS = new Set(['auto-ingest']);

/** @param {string} type */
function sourceBadge(type) {
  const key = SOURCE_LABELS[type];
  return key ? `<span class="badge badge-muted" data-i18n="${key}">${escapeHtml(t(key))}</span>` : `<span class="badge badge-muted">${escapeHtml(type)}</span>`;
}

export async function loadDocuments() {
  const list = byId('docsList');
  if (!list) return;
  setHtml(list, `<div class="p-8 text-center text-slate-500 col-span-full" data-i18n="library.loading">${escapeHtml(t('library.loading'))}</div>`);

  const res = await listDocuments();
  if (!res.ok) {
    setHtml(list, `<div class="p-8 text-center text-red-700 col-span-full" role="alert">${escapeHtml(describeDataError(res.error))}</div>`);
    return;
  }
  const docs = res.data ?? [];
  if (docs.length === 0) {
    setHtml(
      list,
      `<div class="p-12 text-center col-span-full border border-dashed border-slate-300 bg-white rounded-2xl shadow-xs">
        <i data-lucide="folder-open" class="w-10 h-10 text-slate-400 mx-auto mb-2"></i>
        <p class="text-sm font-semibold text-slate-700" data-i18n="library.empty">${escapeHtml(t('library.empty'))}</p>
        <button type="button" data-action="switch-tab" data-arg="ingest" class="btn btn-primary mt-3.5" data-i18n="library.empty_cta">${escapeHtml(t('library.empty_cta'))}</button>
      </div>`,
    );
    return;
  }

  setHtml(
    list,
    docs
      .map((doc) => {
        const date = formatDate(new Date(doc.created_at));
        const summary = doc.summary || doc.raw_content?.slice(0, 150) || t('library.no_summary');
        return `
        <button type="button" data-action="view-doc" data-arg="${escapeHtml(doc.id)}" class="text-left bg-white hover:bg-amber-50/25 border border-slate-200 hover:border-amber-300 rounded-2xl p-5 flex flex-col justify-between transition-all duration-200 cursor-pointer shadow-card hover:shadow-card-hover">
          <div class="w-full">
            <div class="flex items-start justify-between gap-2 mb-2.5">
              <h3 class="font-extrabold text-slate-950 text-sm line-clamp-2 break-words min-w-0">${escapeHtml(doc.title)}</h3>
              ${sourceBadge(doc.source_type || 'text')}
            </div>
            <p class="text-xs text-slate-600 line-clamp-3 mb-3.5 leading-relaxed">${escapeHtml(summary)}</p>
          </div>
          <div class="w-full flex items-center justify-between pt-3 border-t border-slate-100 text-[11px] text-slate-500 font-medium">
            <div class="flex flex-wrap gap-1.5 min-w-0">
              ${(doc.tags || [])
                .filter((tag) => !HIDDEN_TAGS.has(tag) && tag !== doc.source_type)
                .slice(0, 3)
                .map((tag) => `<span class="badge badge-brand">${escapeHtml(tag)}</span>`)
                .join('')}
            </div>
            <span class="whitespace-nowrap flex-shrink-0 ml-2">${escapeHtml(date)}</span>
          </div>
        </button>`;
      })
      .join(''),
  );
}

let viewSeq = 0;

/**
 * @param {string} id
 * @param {HTMLElement} trigger
 */
async function viewDocument(id, trigger) {
  const modal = byId('docModal');
  const title = byId('modalDocTitle');
  const meta = byId('modalDocMeta');
  const content = byId('modalDocContent');
  if (!modal || !title || !meta || !content) return;
  setText(title, 'library.document');
  setText(meta, 'library.loading_document');
  content.removeAttribute('data-i18n');
  content.removeAttribute('data-i18n-params');
  content.replaceChildren();
  openDialog(modal, { trigger });
  const token = ++viewSeq;

  const res = await getDocument(id);
  // A late reply must not fill a dialog that was closed or reopened for another document.
  if (token !== viewSeq || !isDialogOpen(modal)) return;
  if (!res.ok) {
    meta.removeAttribute('data-i18n');
    meta.removeAttribute('data-i18n-params');
    meta.textContent = '';
    setText(content, ...dataErrorKey(res.error));
    return;
  }
  const { doc, sections } = res.data;
  title.removeAttribute('data-i18n');
  title.textContent = doc.title;
  setText(meta, 'library.meta', {
    date: formatDate(new Date(doc.created_at), { dateStyle: 'medium', timeStyle: 'short' }),
    sections: formatNumber(sections.length),
  });

  let markdown = doc.summary ? `> **${t('library.summary')}:** ${doc.summary}\n\n` : '';
  markdown += sections.length > 0 ? sections.map((s) => s.markdown_content ?? '').join('\n\n') : doc.raw_content || t('library.no_content');
  content.innerHTML = renderMarkdown(markdown);
}

function closeDocModal() {
  closeDialog(byId('docModal'));
}

export function initLibrary() {
  onAction('reload-documents', () => loadDocuments());
  onAction('view-doc', (el) => viewDocument(el.dataset.arg ?? '', el));
  onAction('close-doc-modal', () => closeDocModal());
}
