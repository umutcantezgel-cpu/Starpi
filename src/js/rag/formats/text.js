// @ts-check
// Shared output rules of the document readers, so DOCX, PPTX, XLSX and HTML read alike: blocks are
// separated by a blank line (the chunker prefers to cut there), list items and table rows by a
// single line break, headings are written as Markdown headings, and a table with a usable header row
// becomes one "column: value; column: value" line per row, the same rule csvToText applies to CSV.
import { ParseError } from './errors.js';

export const DEFAULT_MAX_CHARS = 5_000_000;

/**
 * Collapses runs of whitespace (line breaks included) to one space and trims.
 * @param {string} s
 */
export const squashSpace = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * One line per table row. With a header row whose cells are all named, distinct (ignoring case) and
 * not numbers, and rows as wide as the header, each later row reads "column: value; column: value"
 * (empty cells left out). Otherwise each row's non-empty cells are joined with " | ".
 * @param {string[][]} rows
 * @returns {string[]}
 */
export function tableLines(rows) {
  const filled = rows.map((r) => r.map(squashSpace)).filter((r) => r.some((c) => c !== ''));
  if (!filled.length) return [];
  const header = filled[0];
  const usable =
    filled.length >= 2 &&
    header.length >= 2 &&
    header.every((h) => h !== '' && !/^[\d.,\s-]+$/.test(h)) &&
    new Set(header.map((h) => h.toLowerCase())).size === header.length &&
    filled.every((r) => r.length === header.length);
  if (!usable) return filled.map((r) => r.filter((c) => c !== '').join(' | '));
  return filled
    .slice(1)
    .map((r) =>
      r
        .map((v, i) => [header[i], v])
        .filter(([, v]) => v !== '')
        .map(([h, v]) => `${h}: ${v}`)
        .join('; '),
    )
    .filter(Boolean);
}

/**
 * Collects the blocks of a document and joins them. Consecutive blocks of the same group (list
 * items, table rows) are joined with one line break, everything else with a blank line. Stops with
 * ParseError 'too_large' once the text exceeds maxChars.
 */
export class TextBlocks {
  /** @param {number} [maxChars] */
  constructor(maxChars = DEFAULT_MAX_CHARS) {
    this.maxChars = maxChars;
    /** @type {string[]} */
    this.parts = [];
    this.length = 0;
    /** @type {string | null} */
    this.lastGroup = null;
  }

  /**
   * Adds a block as written (leading indentation is kept for nested list items); trailing spaces
   * and surrounding blank lines are dropped, and a block without visible text is ignored.
   * @param {string} text
   * @param {string | null} [group]  'list', 'table', … or null for a block of its own
   */
  push(text, group = null) {
    const t = text.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
    if (!t.trim()) return;
    const sep = this.parts.length === 0 ? '' : group !== null && group === this.lastGroup ? '\n' : '\n\n';
    this.parts.push(sep + t);
    this.length += sep.length + t.length;
    this.lastGroup = group;
    if (this.length > this.maxChars) throw new ParseError('too_large', 'Extracted text is too long', { max: this.maxChars });
  }

  /** Ends the current group, so the next block starts after a blank line. */
  breakGroup() {
    this.lastGroup = null;
  }

  toString() {
    return this.parts.join('');
  }
}
