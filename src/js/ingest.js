// @ts-check
// Knowledge ingestion from the browser: text/file -> Markdown document + section in Supabase.
import { invalidateKnownTitles } from './chat.js';
import { LIMITS } from './config.js';
import { byId, onAction, onChange, setHidden } from './dom.js';
import { refreshIcons } from './icons.js';
import { describeDataError } from './library.js';
import { escapeHtml, renderMarkdown } from './render.js';
import { getConnection, insertDocument } from './supabase.js';

const SOURCE_TYPES = new Set(['meeting_notes', 'file', 'chat', 'text']);

/**
 * @param {string} title
 * @param {string} sourceType
 * @param {string} content
 */
export function buildIngestMarkdown(title, sourceType, content) {
  return `# ${title}\n\n## 1. Überblick & Fakten\n${content}\n\n## 2. Status & Metadaten\n- **Quelle:** ${sourceType}\n- **Erfasst am:** ${new Date().toLocaleString('de-DE')}`;
}

/** @param {boolean} busy */
function setButtonBusy(busy) {
  const btn = /** @type {HTMLButtonElement | null} */ (byId('ingestBtn'));
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy
    ? '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Strukturiere...</span>'
    : '<i data-lucide="sparkles" class="w-4 h-4"></i><span>In Markdown strukturieren & speichern</span>';
  refreshIcons(btn);
}

async function submitIngest() {
  const titleEl = /** @type {HTMLInputElement | null} */ (byId('ingestTitle'));
  const typeEl = /** @type {HTMLSelectElement | null} */ (byId('ingestSourceType'));
  const contentEl = /** @type {HTMLTextAreaElement | null} */ (byId('ingestContent'));
  const content = contentEl?.value.trim() ?? '';
  if (!content) {
    window.alert('Bitte fügen Sie Text ein.');
    return;
  }
  if (content.length > LIMITS.ingestContentChars) {
    window.alert(`Der Text ist zu lang (maximal ${LIMITS.ingestContentChars.toLocaleString('de-DE')} Zeichen).`);
    return;
  }
  const sourceType = SOURCE_TYPES.has(typeEl?.value ?? '') ? /** @type {string} */ (typeEl?.value) : 'text';
  const title = (titleEl?.value.trim() || content.split('\n')[0].slice(0, 50) || 'Notiz').slice(0, LIMITS.titleChars);
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
      heading: '## 1. Überblick & Fakten',
    });
    if (!res.ok) {
      window.alert(`Speichern fehlgeschlagen. ${describeDataError(res.error)}`);
      return;
    }
    invalidateKnownTitles();
    const preview = byId('ingestResultPreview');
    if (preview) {
      const note = getConnection().hardened
        ? ''
        : `<p class="mb-3 text-[11px] font-semibold text-amber-800">${escapeHtml('Hinweis: Bis die Datenbank Migration angewendet ist, sind neue Einträge für alle Besucher sichtbar.')}</p>`;
      preview.innerHTML = note + renderMarkdown(markdown);
    }
    setHidden(byId('ingestResultCard'), false);
    clearForm();
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
    window.alert(`Die Datei ist zu groß (maximal ${Math.round(LIMITS.ingestFileBytes / (1024 * 1024))} MB).`);
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    window.alert('Die Datei konnte nicht gelesen werden.');
    return;
  }
  const titleEl = /** @type {HTMLInputElement | null} */ (byId('ingestTitle'));
  const contentEl = /** @type {HTMLTextAreaElement | null} */ (byId('ingestContent'));
  const typeEl = /** @type {HTMLSelectElement | null} */ (byId('ingestSourceType'));
  if (titleEl) titleEl.value = file.name.replace(/\.[^/.]+$/, '').slice(0, LIMITS.titleChars);
  if (contentEl) contentEl.value = text;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (typeEl) {
    if (ext === 'txt' || ext === 'md') typeEl.value = 'file';
    else if (ext === 'json') typeEl.value = 'text';
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
  const highlight = ['border-brand-400', 'bg-brand-500/10'];
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
