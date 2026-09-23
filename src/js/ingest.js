// @ts-check
// Knowledge ingestion from the browser:
// Client-side text/PDF/JSON parsing via Web Worker -> Sliding-window chunking -> BM25 indexing & Supabase persistence.
import { invalidateKnownTitles } from './chat.js';
import { LIMITS } from './config.js';
import { byId, onAction, onChange, setHidden } from './dom.js';
import { refreshIcons } from './icons.js';
import { t } from './i18n/index.js';
import { describeDataError } from './library.js';
import { indexDocumentChunks, parseAndChunkDocument } from './rag/ingestion-service.js';
import { escapeHtml, renderMarkdown } from './render.js';
import { getConnection, insertDocument } from './supabase.js';

const SOURCE_TYPES = new Set(['meeting_notes', 'file', 'chat', 'text']);

/**
 * @param {string} title
 * @param {string} sourceType
 * @param {string} content
 */
export function buildIngestMarkdown(title, sourceType, content) {
  return `# ${title}\n\n## 1. Overview & Facts\n${content}\n\n## 2. Status & Metadata\n- **Source:** ${sourceType}\n- **Indexed:** ${new Date().toISOString()}`;
}

/** @param {boolean} busy */
function setButtonBusy(busy) {
  const btn = /** @type {HTMLButtonElement | null} */ (byId('ingestBtn'));
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy
    ? `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>${escapeHtml(t('ingest.structuring'))}</span>`
    : `<i data-lucide="sparkles" class="w-4 h-4"></i><span>${escapeHtml(t('ingest.submit'))}</span>`;
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
    window.alert(`Text exceeds maximum allowed length (${LIMITS.ingestContentChars.toLocaleString()} characters).`);
    return;
  }
  const sourceType = SOURCE_TYPES.has(typeEl?.value ?? '') ? /** @type {string} */ (typeEl?.value) : 'text';
  const title = (titleEl?.value.trim() || content.split('\n')[0].slice(0, 50) || 'Note').slice(0, LIMITS.titleChars);
  const markdown = buildIngestMarkdown(title, sourceType, content);

  setButtonBusy(true);
  try {
    // 1. Chunk and index into local BM25 engine
    const { chunks } = await parseAndChunkDocument({
      name: `${title}.txt`,
      text: async () => content,
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    });
    const docId = `local_${Date.now()}`;
    await indexDocumentChunks(title, docId, chunks);

    // 2. Persist into Supabase workspace
    const res = await insertDocument({
      title,
      sourceType,
      rawContent: content,
      summary: content.length > 200 ? `${content.slice(0, 200)}…` : content,
      tags: ['auto-ingest', sourceType],
      markdown,
      heading: '## 1. Overview & Facts',
    });

    if (!res.ok) {
      window.alert(`Save failed. ${describeDataError(res.error)}`);
      return;
    }

    invalidateKnownTitles();
    const preview = byId('ingestResultPreview');
    if (preview) {
      const note = getConnection().hardened
        ? ''
        : `<p class="mb-3 text-[11px] font-semibold text-amber-800">${escapeHtml('Notice: Until database migration is applied, records are stored in public table.')}</p>`;
      preview.innerHTML = note + renderMarkdown(markdown);
    }
    setHidden(byId('ingestResultCard'), false);
    clearForm();
  } catch (err) {
    window.alert(`Ingest error: ${err instanceof Error ? err.message : String(err)}`);
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

/** @param {File} file */
async function loadFile(file) {
  if (file.size > LIMITS.ingestFileBytes) {
    window.alert(t('ingest.file_too_large'));
    return;
  }

  setButtonBusy(true);
  try {
    const { title, rawText, chunks } = await parseAndChunkDocument(file);
    const titleEl = /** @type {HTMLInputElement | null} */ (byId('ingestTitle'));
    const contentEl = /** @type {HTMLTextAreaElement | null} */ (byId('ingestContent'));
    const typeEl = /** @type {HTMLSelectElement | null} */ (byId('ingestSourceType'));

    if (titleEl) titleEl.value = title.slice(0, LIMITS.titleChars);
    if (contentEl) contentEl.value = rawText;

    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (typeEl) {
      if (ext === 'txt' || ext === 'md' || ext === 'pdf') typeEl.value = 'file';
      else if (ext === 'json') typeEl.value = 'text';
    }

    // Immediately index chunks into local BM25 index
    await indexDocumentChunks(title, `file_${Date.now()}`, chunks);
  } catch (err) {
    window.alert(`${t('ingest.unsupported_file')} ${err instanceof Error ? err.message : ''}`);
  } finally {
    setButtonBusy(false);
  }
}

export function initIngest() {
  onAction('submit-ingest', () => submitIngest());
  onAction('clear-ingest', () => clearForm());
  onAction('pick-ingest-file', () => byId('ingestFileInput')?.click());
  onChange('ingest-file', (el) => {
    const input = /** @type {HTMLInputElement} */ (el);
    const file = input.files?.[0];
    input.value = '';
    return file ? loadFile(file) : undefined;
  });

  const zone = byId('dropZone');
  const highlight = ['border-amber-400', 'bg-amber-100/20'];
  zone?.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add(...highlight);
  });
  zone?.addEventListener('dragleave', (event) => {
    event.preventDefault();
    zone.classList.remove(...highlight);
  });
  zone?.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove(...highlight);
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });
}
