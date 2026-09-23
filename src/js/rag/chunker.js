// @ts-check
// Deterministic sliding-window chunking. Every chunk's text is exactly source.slice(start, end), so
// citations can highlight the precise span in the extracted document. Windows end on a paragraph,
// sentence or word boundary when one lies in the last quarter of the window, never inside a UTF-16
// surrogate pair or before a combining mark.

export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 50;

/**
 * @typedef {object} TextChunk
 * @property {number} index  0-based position in the document
 * @property {number} start  offset of the first character in the source text (inclusive)
 * @property {number} end    offset after the last character (exclusive)
 * @property {string} text   source.slice(start, end)
 */

/**
 * @typedef {object} ChunkOptions
 * @property {number} [chunkSize]    window length in UTF-16 code units (default 500)
 * @property {number} [chunkOverlap] characters repeated from the previous window (default 50)
 */

const COMBINING = /\p{M}/u;

/**
 * True when a chunk boundary at `pos` would split a surrogate pair or detach a combining mark.
 * @param {string} text
 * @param {number} pos
 */
function isUnsafeBoundary(text, pos) {
  if (pos <= 0 || pos >= text.length) return false;
  const code = text.charCodeAt(pos);
  if (code >= 0xdc00 && code <= 0xdfff) return true; // low surrogate: pair would be split
  return COMBINING.test(String.fromCodePoint(text.codePointAt(pos) ?? 0));
}

/**
 * Moves pos backwards (or forwards when it cannot move back past min) to a safe boundary.
 * @param {string} text
 * @param {number} pos
 * @param {number} min
 */
function safeBoundary(text, pos, min) {
  let p = pos;
  while (p > min && isUnsafeBoundary(text, p)) p -= 1;
  if (p === min) {
    p = pos;
    while (p < text.length && isUnsafeBoundary(text, p)) p += 1;
  }
  return p;
}

/**
 * Best break position in (windowStart, hardEnd]: paragraph, then sentence end, then whitespace.
 * @param {string} text
 * @param {number} start
 * @param {number} hardEnd
 * @param {number} size
 */
function findBreak(text, start, hardEnd, size) {
  const from = Math.max(start + 1, hardEnd - Math.floor(size / 4));
  const window = text.slice(from, hardEnd);
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph !== -1) return from + paragraph + 2;
  let sentence = -1;
  for (const m of window.matchAll(/[.!?…。](?=\s)/g)) sentence = (m.index ?? 0) + m[0].length;
  if (sentence !== -1) return from + sentence;
  let space = -1;
  for (const m of window.matchAll(/\s/g)) space = (m.index ?? 0) + 1;
  if (space !== -1) return from + space;
  return hardEnd;
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 * @param {string} name
 */
function intOption(value, fallback, name) {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return v;
}

/**
 * Splits text into overlapping windows. Whitespace-only windows are skipped and chunk bounds are
 * trimmed, so no chunk starts or ends with whitespace.
 * @param {string} text
 * @param {ChunkOptions} [options]
 * @returns {TextChunk[]}
 */
export function chunkText(text, options = {}) {
  const size = intOption(options.chunkSize, DEFAULT_CHUNK_SIZE, 'chunkSize');
  const overlap = intOption(options.chunkOverlap, DEFAULT_CHUNK_OVERLAP, 'chunkOverlap');
  if (size < 1) throw new RangeError('chunkSize must be at least 1');
  if (overlap >= size) throw new RangeError('chunkOverlap must be smaller than chunkSize');
  if (typeof text !== 'string' || text.length === 0) return [];

  /** @type {TextChunk[]} */
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) end = findBreak(text, start, end, size);
    end = safeBoundary(text, end, start);

    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s += 1;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    if (e > s) chunks.push({ index: chunks.length, start: s, end: e, text: text.slice(s, e) });

    if (end >= text.length) break;
    const next = safeBoundary(text, Math.max(end - overlap, start + 1), start);
    start = next > start ? next : end;
  }
  return chunks;
}
