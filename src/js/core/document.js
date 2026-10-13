// @ts-check
// Checks a whole Markdown document against source excerpts: an answer, release notes, generated
// documentation. A document longer than the source check's limits (THRESHOLDS.maxChars characters,
// THRESHOLDS.maxSentences statements) is split into sections at headings, then at paragraphs, and
// each section is checked on its own; a single paragraph above the limits is reported as skipped,
// never passed. Every statement gets its line and column in the document (1-based, columns in
// UTF-16 code units).
//
// Citations: in "labels" mode the document cites excerpts with labels ("[Doc: spec.md, Chunk: 3]");
// in "all" mode every statement is compared with every excerpt, for documents written without
// labels. "auto" picks "labels" when the document contains at least one label.
//
// Pure: runs in the browser, in workers and in Node. Used by the starpi-ground command.
import { contentTokens, extractFacts } from './facts.js';
import { associate, blocksFromMarkdown, groundAnswer, THRESHOLDS } from './grounding.js';

/**
 * @typedef {import('./grounding.js').SentenceResult & { line: number, column: number }} DocumentStatement
 */

/**
 * @typedef {object} DocumentReport
 * @property {'labels' | 'all'} mode
 * @property {{ id: string, version: number }} algorithm
 * @property {DocumentStatement[]} statements  every checked statement (verdict not neutral), in document order
 * @property {{ supported: number, weak: number, unsupported: number, unchecked: number }} counts
 * @property {number} sections  how many parts the document was checked in
 * @property {Array<{ line: number, endLine: number }>} skipped  parts above the limits, not checked
 * @property {boolean} crossLanguage
 */

/** @param {import('./grounding.js').Block} block */
const textOf = (block) => block.segments.map((s) => (s.type === 'text' ? s.text : '')).join('');

/** @param {import('./grounding.js').Block} block */
const charsOf = (block) => block.segments.reduce((n, s) => n + (s.type === 'text' ? s.text.length : 0), 0);

/**
 * A block that states nothing and only carries citations ("Sources: [A], [B]"): its citations apply
 * to the whole document, so it goes into every section.
 * @param {import('./grounding.js').Block} block
 */
function answerWide(block) {
  if (!block.segments.some((s) => s.type === 'cite' || s.type === 'badcite')) return false;
  const text = textOf(block);
  return contentTokens(text).length === 0 && extractFacts(text).length === 0;
}

/**
 * The column (1-based) of a statement in its source line: where its first word is, searching from
 * the end of the previous statement on that line. 1 when the word cannot be found.
 * @param {string} line
 * @param {string} text
 * @param {number} from
 */
function columnOf(line, text, from) {
  const word = /[\p{L}\p{N}]+/u.exec(text)?.[0];
  if (!word) return { column: 1, next: from };
  const at = line.indexOf(word, from);
  return at < 0 ? { column: 1, next: from } : { column: at + 1, next: at + word.length };
}

/**
 * Checks a Markdown document.
 * @param {string} markdown
 * @param {import('./grounding.js').GroundingSource[]} sources
 * @param {{ cite?: 'auto' | 'labels' | 'all' }} [options]
 * @returns {DocumentReport}
 */
export function checkDocument(markdown, sources, options = {}) {
  const blocks = blocksFromMarkdown(markdown, sources);
  const labelled = blocks.some((b) => b.segments.some((s) => s.type === 'cite' || s.type === 'badcite'));
  const cite = options.cite ?? 'auto';
  /** @type {'labels' | 'all'} */
  const mode = cite === 'auto' ? (labelled ? 'labels' : 'all') : cite;

  // Blocks that only carry answer-wide citations, by index; in "all" mode, one that cites every excerpt.
  const wide = blocks.flatMap((b, i) => (answerWide(b) ? [i] : []));
  /** @type {import('./grounding.js').Block[]} */
  const everything = mode === 'all' ? [{ kind: 'p', segments: sources.map((_, index) => ({ type: /** @type {const} */ ('cite'), index })), leadIn: null }] : [];

  /**
   * The blocks of a section: blocks[from, to) with lead-in links inside it, plus the answer-wide
   * citation blocks outside it.
   * @param {number} from
   * @param {number} to
   * @returns {import('./grounding.js').Block[]}
   */
  const sectionBlocks = (from, to) => [
    ...blocks.slice(from, to).map((b) => ({ ...b, leadIn: b.leadIn !== null && b.leadIn >= from && b.leadIn < to ? b.leadIn - from : null })),
    ...wide.filter((i) => i < from || i >= to).map((i) => ({ ...blocks[i], leadIn: null })),
    ...everything,
  ];
  /** @param {number} from @param {number} to */
  const fits = (from, to) => {
    const list = sectionBlocks(from, to);
    return list.reduce((n, b) => n + charsOf(b), 0) <= THRESHOLDS.maxChars && associate(list).length <= THRESHOLDS.maxSentences;
  };

  /** @type {Array<[number, number]>} */
  const ranges = [];
  if (fits(0, blocks.length)) ranges.push([0, blocks.length]);
  else {
    // Units start at headings; whole units are packed into sections while they fit.
    /** @type {Array<[number, number]>} */
    const units = [];
    blocks.forEach((b, i) => {
      if (i === 0 || b.kind === 'heading') units.push([i, i + 1]);
      else units[units.length - 1][1] = i + 1;
    });
    /** @type {[number, number] | null} */
    let open = null;
    const close = () => {
      if (open) ranges.push(open);
      open = null;
    };
    for (const [from, to] of units) {
      if (open && fits(open[0], to)) {
        open = [open[0], to];
        continue;
      }
      close();
      if (fits(from, to)) {
        open = [from, to];
        continue;
      }
      // A unit above the limits on its own: split between blocks.
      for (let i = from; i < to; i += 1) {
        if (open && fits(open[0], i + 1)) open = [open[0], i + 1];
        else {
          close();
          open = [i, i + 1];
        }
      }
    }
    close();
  }

  const lines = markdown.split('\n');
  /** @type {Map<number, number>} where the last located statement on a line ended */
  const cursor = new Map();
  /** @type {DocumentReport} */
  const result = { mode, algorithm: { id: '', version: 0 }, statements: [], counts: { supported: 0, weak: 0, unsupported: 0, unchecked: 0 }, sections: ranges.length, skipped: [], crossLanguage: false };
  for (const [from, to] of ranges) {
    const report = groundAnswer(sectionBlocks(from, to), sources);
    result.algorithm = report.algorithm;
    if (report.crossLanguage) result.crossLanguage = true;
    if (report.skipped) {
      result.skipped.push({ line: blocks[from].line ?? 1, endLine: blocks[to - 1].line ?? 1 });
      continue;
    }
    for (const s of report.sentences) {
      if (s.verdict === 'neutral') continue;
      result.counts[s.verdict] += 1;
      const block = blocks[from + s.block];
      const line = block?.line ?? 1;
      const { column, next } = columnOf(lines[line - 1] ?? '', s.text, cursor.get(line) ?? 0);
      cursor.set(line, next);
      result.statements.push({ ...s, block: from + s.block, line, column });
    }
  }
  return result;
}
