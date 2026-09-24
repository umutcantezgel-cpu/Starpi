// @ts-check
// Citation labels, shared by retrieval, rendering, the source check and answer receipts. Pure: no
// DOM, no i18n, runs in the browser, in workers and in Node.

/**
 * The document name as it appears inside a label: brackets and line breaks would end or split the
 * label, so they become spaces.
 * @param {string} name
 */
export function labelName(name) {
  return name.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Document';
}

/**
 * @param {string} doc
 * @param {number} chunk 1-based
 */
export function citationLabel(doc, chunk) {
  return `[Doc: ${labelName(doc)}, Chunk: ${chunk}]`;
}

/**
 * Matches citation labels in model output: [Doc: <name>, Chunk: <n>]. Global: use it with
 * matchAll() or a copy (`new RegExp(CITATION_PATTERN)`), never with .test() or .exec() directly.
 */
export const CITATION_PATTERN = /\[Doc:\s*([^\]\n]+?),\s*Chunk:\s*(\d{1,6})\s*\]/g;

/**
 * Anything a model may write as a citation, including variants the app never produces
 * ("[doc: a.pdf, chunk 2]", "[Quelle: a.pdf]"). The source check reports these instead of reading
 * their numbers as facts.
 */
export const LOOSE_LABEL_PATTERN = /\[(?:doc|dok|dokument|document|source|quelle)\s*:[^\]\n]{1,300}\]/gi;

/**
 * Reads a label leniently: any case, any spacing, "Chunk"/"Abschnitt"/"Teil" and an optional colon.
 * @param {string} text
 * @returns {{ doc: string, chunk: number | null } | null}
 */
export function parseLabel(text) {
  const m = /^\[\s*(?:doc|dok|dokument|document|source|quelle)\s*:\s*(.+?)\s*(?:,\s*(?:chunk|abschnitt|teil|part)\s*:?\s*(\d{1,6}))?\s*\]$/i.exec(text.trim());
  if (!m) return null;
  return { doc: m[1].replace(/\s+/g, ' ').trim(), chunk: m[2] ? Number(m[2]) : null };
}
