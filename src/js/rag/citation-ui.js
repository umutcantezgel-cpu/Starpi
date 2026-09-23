// @ts-check
// Interactive citation modal controller.
import { byId, onAction, setHidden } from '../dom.js';
import { getCitationChunk } from './ingestion-service.js';

/**
 * Initializes citation action handlers.
 */
export function initCitationUi() {
  onAction('open-citation', (el) => {
    const arg = el.dataset.arg ?? '';
    openCitation(arg);
  });
  onAction('close-citation', () => {
    closeCitation();
  });
}

/**
 * Opens and populates the citation inspection modal.
 * @param {string} citationArg - Format "docTitle:chunkIndex"
 */
export function openCitation(citationArg) {
  const parts = citationArg.split(':');
  const docTitle = parts[0] || 'Document';
  const chunkIndex = parts[1] || '0';

  const modal = byId('citationModal');
  const docEl = byId('citationModalDoc');
  const idxEl = byId('citationModalChunkIdx');
  const offsetsEl = byId('citationModalOffsets');
  const scoreEl = byId('citationModalScore');
  const contentEl = byId('citationModalContent');

  if (!modal) return;

  const chunk = getCitationChunk(docTitle, chunkIndex);

  if (docEl) docEl.textContent = docTitle;
  if (idxEl) idxEl.textContent = `#${chunkIndex}`;

  if (chunk) {
    if (offsetsEl) offsetsEl.textContent = `${chunk.startOffset} – ${chunk.endOffset}`;
    if (contentEl) contentEl.textContent = chunk.content;
    if (scoreEl) scoreEl.textContent = 'Matched';
  } else {
    if (offsetsEl) offsetsEl.textContent = '–';
    if (contentEl) contentEl.textContent = `Excerpt from ${docTitle} (Chunk #${chunkIndex}).`;
    if (scoreEl) scoreEl.textContent = 'Active';
  }

  setHidden(modal, false);
}

/**
 * Closes the citation modal.
 */
export function closeCitation() {
  const modal = byId('citationModal');
  if (modal) setHidden(modal, true);
}
