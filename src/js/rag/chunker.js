// @ts-check
// Deterministic sliding-window text chunking with boundary detection.
// Preserves character offsets and avoids splitting words across chunk boundaries.

export const DEFAULT_CHUNKER_OPTIONS = {
  chunkSize: 500,
  chunkOverlap: 50,
};

/**
 * @typedef {object} TextChunk
 * @property {number} id - 0-based chunk sequence index
 * @property {string} text - Cleaned chunk text
 * @property {number} startOffset - Character offset in original source text
 * @property {number} endOffset - Character end offset in original source text
 * @property {number} charCount - Length of chunk text in characters
 */

/**
 * Splits source text into overlapping chunks using a sliding window.
 *
 * @param {string} text - Input text
 * @param {object} [options]
 * @param {number} [options.chunkSize=500] - Target size of each chunk in characters
 * @param {number} [options.chunkOverlap=50] - Number of characters to overlap between successive chunks
 * @returns {TextChunk[]}
 */
export function chunkText(text, options = {}) {
  if (!text || typeof text !== 'string') return [];

  const raw = text.trim();
  if (raw.length === 0) return [];

  const chunkSize = Math.max(50, options.chunkSize ?? DEFAULT_CHUNKER_OPTIONS.chunkSize);
  const chunkOverlap = Math.min(
    Math.max(0, options.chunkOverlap ?? DEFAULT_CHUNKER_OPTIONS.chunkOverlap),
    Math.floor(chunkSize / 2),
  );

  // If the whole text fits in one chunk, return it immediately
  if (text.length <= chunkSize) {
    return [
      {
        id: 0,
        text: text.trim(),
        startOffset: 0,
        endOffset: text.length,
        charCount: text.trim().length,
      },
    ];
  }

  /** @type {TextChunk[]} */
  const chunks = [];
  let cursor = 0;
  let chunkIndex = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= chunkSize) {
      const slice = text.slice(cursor);
      if (slice.trim().length > 0) {
        chunks.push({
          id: chunkIndex,
          text: slice.trim(),
          startOffset: cursor,
          endOffset: text.length,
          charCount: slice.trim().length,
        });
      }
      break;
    }

    // Determine target end position
    const targetEnd = cursor + chunkSize;

    // Search for a natural boundary near targetEnd (within the last 20% of the chunk window)
    const searchBackDistance = Math.min(Math.floor(chunkSize * 0.25), targetEnd - cursor - 10);
    const searchStart = targetEnd - searchBackDistance;
    const windowSlice = text.slice(searchStart, targetEnd);

    // Preference: 1. Paragraph (\n\n), 2. Sentence boundary (. / ! / ? + space/newline), 3. Space
    let splitPos = -1;

    const paragraphMatch = windowSlice.lastIndexOf('\n\n');
    if (paragraphMatch !== -1) {
      splitPos = searchStart + paragraphMatch + 2;
    } else {
      const sentenceRegex = /[.!?](\s+)/g;
      let match;
      let lastSentenceMatch = -1;
      while ((match = sentenceRegex.exec(windowSlice)) !== null) {
        lastSentenceMatch = searchStart + match.index + 1;
      }
      if (lastSentenceMatch !== -1) {
        splitPos = lastSentenceMatch;
      } else {
        const lastSpace = windowSlice.lastIndexOf(' ');
        if (lastSpace !== -1) {
          splitPos = searchStart + lastSpace + 1;
        }
      }
    }

    // Fallback: strict cut at targetEnd
    const finalEnd = splitPos > cursor ? splitPos : targetEnd;
    const chunkContent = text.slice(cursor, finalEnd).trim();

    if (chunkContent.length > 0) {
      chunks.push({
        id: chunkIndex++,
        text: chunkContent,
        startOffset: cursor,
        endOffset: finalEnd,
        charCount: chunkContent.length,
      });
    }

    // Advance cursor with overlap
    cursor = Math.max(cursor + 1, finalEnd - chunkOverlap);
  }

  return chunks;
}
