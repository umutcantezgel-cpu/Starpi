// @ts-check
// Knowledge library: document list and detail modal.
import { byId, onAction, setHidden, setHtml } from './dom.js';
import { formatDate, formatNumber, setText, t } from './i18n/index.js';
import { escapeHtml, renderMarkdown } from './render.js';
import { getDocument, listDocuments } from './supabase.js';

/** @param {import('./supabase.js').DataError} error */
export function describeDataError(error) {
  switch (error.kind) {
    case 'network':
    case 'timeout':
      return t('data.error_unreachable');
    case 'missing_schema':
    case 'missing_function':
      return t('data.error_missing_schema');
    case 'forbidden':
      return t('data.error_forbidden');
    case 'auth_disabled':
      return t('data.error_auth_disabled');
    default:
      return t('data.error_other', { reason: error.message });
  }
}

export async function loadDocuments() {
  const list = byId('docsList');
  if (!list) return;
  setHtml(list, `<div class="p-8 text-center text-slate-500 col-span-2" data-i18n="library.loading">${escapeHtml(t('library.loading'))}</div>`);

  const res = await listDocuments();
  if (!res.ok) {
    setHtml(list, `<div class="p-8 text-center text-red-500 col-span-2">${escapeHtml(describeDataError(res.error))}</div>`);
    return;
  }
  const docs = res.data ?? [];
  if (docs.length === 0) {
    setHtml(
      list,
      `<div class="p-12 text-center col-span-2 border border-dashed border-slate-300 bg-white rounded-2xl shadow-xs">
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
              <h3 class="font-extrabold text-slate-950 text-sm truncate">${escapeHtml(doc.title)}</h3>
              <span class="badge badge-muted">${escapeHtml(doc.source_type || 'text')}</span>
            </div>
            <p class="text-xs text-slate-600 line-clamp-3 mb-3.5 leading-relaxed">${escapeHtml(summary)}</p>
          </div>
          <div class="w-full flex items-center justify-between pt-3 border-t border-slate-100 text-[11px] text-slate-500 font-medium">
            <div class="flex flex-wrap gap-1.5">
              ${(doc.tags || [])
                .slice(0, 3)
                .map((tag) => `<span class="badge badge-brand">${escapeHtml(tag)}</span>`)
                .join('')}
            </div>
            <span>${escapeHtml(date)}</span>
          </div>
        </button>`;
      })
      .join(''),
  );
}

/** @param {string} id */
async function viewDocument(id) {
  const modal = byId('docModal');
  const title = byId('modalDocTitle');
  const meta = byId('modalDocMeta');
  const content = byId('modalDocContent');
  if (!modal || !title || !meta || !content) return;
  setText(title, 'library.document');
  setText(meta, 'library.loading_document');
  content.replaceChildren();
  setHidden(modal, false);

  const res = await getDocument(id);
  if (!res.ok) {
    meta.textContent = '';
    content.textContent = describeDataError(res.error);
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
  setHidden(byId('docModal'), true);
}

export function initLibrary() {
  onAction('reload-documents', () => loadDocuments());
  onAction('view-doc', (el) => viewDocument(el.dataset.arg ?? ''));
  onAction('close-doc-modal', () => closeDocModal());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDocModal();
  });
}
