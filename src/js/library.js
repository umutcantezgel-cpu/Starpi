// @ts-check
// Knowledge library: document list and detail modal.
import { byId, onAction, setHidden, setHtml } from './dom.js';
import { escapeHtml, renderMarkdown } from './render.js';
import { getDocument, listDocuments } from './supabase.js';

/** @param {import('./supabase.js').DataError} error */
export function describeDataError(error) {
  switch (error.kind) {
    case 'network':
    case 'timeout':
      return 'Die Wissensdatenbank ist gerade nicht erreichbar. Bitte Verbindung prüfen und erneut versuchen.';
    case 'missing_schema':
    case 'missing_function':
      return 'Die benötigten Tabellen oder Funktionen sind in dieser Datenbank noch nicht eingerichtet (Migration ausstehend).';
    case 'forbidden':
      return 'Keine Berechtigung. Für diese Aktion ist eine Sitzung nötig (anonyme Anmeldung in Supabase aktivieren).';
    case 'auth_disabled':
      return 'Die anonyme Anmeldung ist in Supabase deaktiviert.';
    default:
      return `Fehler: ${error.message}`;
  }
}

export async function loadDocuments() {
  const list = byId('docsList');
  if (!list) return;
  setHtml(list, '<div class="p-8 text-center text-slate-500 col-span-2">Lade Dokumente aus Supabase...</div>');

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
        <p class="text-sm font-semibold text-slate-700">Noch keine Dokumente gespeichert.</p>
        <button type="button" data-action="switch-tab" data-arg="ingest" class="mt-3.5 text-xs bg-[#FFCA00] hover:bg-[#E5B500] text-slate-950 font-bold px-4 py-2 rounded-xl shadow-yellow transition">Jetzt Wissen einspeisen</button>
      </div>`,
    );
    return;
  }

  setHtml(
    list,
    docs
      .map((doc) => {
        const created = new Date(doc.created_at);
        const date = Number.isNaN(created.getTime()) ? '' : created.toLocaleDateString('de-DE');
        const summary = doc.summary || doc.raw_content?.slice(0, 150) || 'Keine Zusammenfassung vorhanden.';
        return `
        <button type="button" data-action="view-doc" data-arg="${escapeHtml(doc.id)}" class="text-left bg-white hover:bg-amber-50/25 border border-slate-200 hover:border-amber-300 rounded-2xl p-5 flex flex-col justify-between transition-all duration-200 cursor-pointer shadow-card hover:shadow-card-hover">
          <div class="w-full">
            <div class="flex items-start justify-between gap-2 mb-2.5">
              <h3 class="font-extrabold text-slate-950 text-sm truncate">${escapeHtml(doc.title)}</h3>
              <span class="text-[10px] uppercase font-mono font-bold px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-600">${escapeHtml(doc.source_type || 'text')}</span>
            </div>
            <p class="text-xs text-slate-600 line-clamp-3 mb-3.5 leading-relaxed">${escapeHtml(summary)}</p>
          </div>
          <div class="w-full flex items-center justify-between pt-3 border-t border-slate-100 text-[11px] text-slate-500 font-medium">
            <div class="flex flex-wrap gap-1.5">
              ${(doc.tags || [])
                .slice(0, 3)
                .map((t) => `<span class="bg-amber-50 text-amber-950 border border-amber-200/80 px-2 py-0.5 rounded-full text-[10px] font-bold">${escapeHtml(t)}</span>`)
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
  title.textContent = 'Dokument';
  meta.textContent = 'Wird geladen…';
  content.replaceChildren();
  setHidden(modal, false);

  const res = await getDocument(id);
  if (!res.ok) {
    meta.textContent = '';
    content.textContent = describeDataError(res.error);
    return;
  }
  const { doc, sections } = res.data;
  const created = new Date(doc.created_at);
  title.textContent = doc.title;
  meta.textContent = `Erstellt am ${Number.isNaN(created.getTime()) ? '–' : created.toLocaleString('de-DE')} • ${sections.length} Abschnitte`;

  let markdown = doc.summary ? `> **Zusammenfassung:** ${doc.summary}\n\n` : '';
  markdown += sections.length > 0 ? sections.map((s) => s.markdown_content ?? '').join('\n\n') : doc.raw_content || 'Kein Inhalt vorhanden.';
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
