// @ts-check
// Citation labels, shared by retrieval, rendering, the source check and answer receipts. Pure: no
// DOM, no i18n, runs in the browser, in workers and in Node.

/**
 * Two or more angle brackets in a row: the shape of the markers that open and close an excerpt in
 * a prompt ("<<<EXCERPT 1 …>>>"). Text that goes inside such a marker must not contain one.
 */
const FENCE_RUN = /<{2,}|>{2,}/g;

/**
 * Text placed inside an excerpt marker, such as an excerpt's heading: runs of angle brackets and
 * line breaks become spaces, so a document cannot close its marker early or forge another one.
 * Single brackets ("a < b") and all other text stay as they are.
 * @param {string} text
 */
export function fenceSafe(text) {
  return text.replace(FENCE_RUN, ' ').replace(/[\r\n]+/g, ' ');
}

/**
 * The document name as it appears inside a label: brackets and line breaks would end or split the
 * label, and runs of angle brackets would end or forge the excerpt marker that carries it (see
 * fenceSafe), so they all become spaces. The same name always gives the same label, so an answer
 * that cites it still resolves to the excerpt.
 * @param {string} name
 */
export function labelName(name) {
  return name.replace(/[[\]\r\n]+/g, ' ').replace(FENCE_RUN, ' ').replace(/\s+/g, ' ').trim() || 'Document';
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
