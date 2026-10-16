// @ts-check
// Word documents (DOCX) to text. Paragraphs come in reading order and are separated by blank lines;
// headings (by style name or outline level) are written as Markdown headings; list items become
// "- item" or "1. item" lines, indented two spaces per level; tables go through tableLines
// ("column: value; …" per row); text boxes follow the paragraph that anchors them. Deleted revisions,
// field codes and the fallback copies of alternate content are left out, inserted revisions are kept.
// Headers, footers, footnotes and comments are not part of the text.
import { ParseError } from './errors.js';
import { MC, openPackage, skipFallback } from './ooxml.js';
import { squashSpace, tableLines, TextBlocks } from './text.js';
import { vocabulary } from './xml.js';

/** @typedef {import('./xml.js').XmlElement} XmlElement */
/** @typedef {import('./ooxml.js').OfficeOptions} OfficeOptions */
/** @typedef {import('./ooxml.js').OfficePackage} OfficePackage */

const W = vocabulary('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main');
const M = vocabulary('http://schemas.openxmlformats.org/officeDocument/2006/math', 'http://purl.oclc.org/ooxml/officeDocument/math');

// Never read: formatting, deleted text, field instructions and markers without text.
const DROPPED = new Set(['rPr', 'sectPr', 'tblPr', 'tblGrid', 'trPr', 'del', 'moveFrom', 'delText', 'delInstrText', 'instrText', 'proofErr', 'bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'lastRenderedPageBreak', 'rsids']);
const skip = skipFallback((el) => W.has(el) && DROPPED.has(el.local));

/**
 * @typedef {object} StyleInfo
 * @property {number} heading  1–9, 0 for body text
 * @property {string | null} numId
 * @property {number | null} ilvl
 * @property {number} depth    extra list depth of the built-in "List Bullet 2" … styles
 */

/** @param {XmlElement | null} el @param {string} name */
const val = (el, name) => W.attr(W.child(el, name), 'val');

/**
 * Paragraph styles by id, with heading levels and list numbering resolved through basedOn.
 * @param {OfficePackage} pkg
 * @param {string} main
 * @returns {Promise<(id: string | null) => StyleInfo>}
 */
async function readStyles(pkg, main) {
  const [rel] = await pkg.related(main, 'styles');
  const root = rel ? await pkg.xml(rel.target, { skip }) : null;
  /** @type {Map<string, { name: string, basedOn: string | null, outline: string | null, numId: string | null, ilvl: string | null }>} */
  const styles = new Map();
  for (const style of W.children(root, 'style')) {
    const id = W.attr(style, 'styleId');
    if (!id) continue;
    const pPr = W.child(style, 'pPr');
    const numPr = W.child(pPr, 'numPr');
    styles.set(id, { name: (val(style, 'name') ?? '').toLowerCase(), basedOn: val(style, 'basedOn'), outline: val(pPr, 'outlineLvl'), numId: val(numPr, 'numId'), ilvl: val(numPr, 'ilvl') });
  }
  /** @type {Map<string, StyleInfo>} */
  const cache = new Map();
  return (id) => {
    if (!id) return { heading: 0, numId: null, ilvl: null, depth: 0 };
    const known = cache.get(id);
    if (known) return known;
    const own = styles.get(id);
    const name = own?.name ?? id.toLowerCase();
    let heading = 0;
    const named = /^heading\s*([1-9])$/.exec(name);
    if (named) heading = Number(named[1]);
    else if (name === 'title') heading = 1;
    /** @type {string | null} */
    let numId = null;
    /** @type {string | null} */
    let ilvl = null;
    let outline = null;
    // Inherited values: the nearest style in the basedOn chain that sets them.
    for (let s = own, hops = 0; s && hops < 20; s = s.basedOn ? styles.get(s.basedOn) : undefined, hops++) {
      outline ??= s.outline;
      numId ??= s.numId;
      ilvl ??= s.ilvl;
    }
    if (!heading && outline !== null && Number(outline) >= 0 && Number(outline) < 9) heading = Number(outline) + 1;
    const listed = /^list (?:bullet|number|continue)?\s*([2-9])$/.exec(name);
    const info = { heading, numId, ilvl: ilvl === null ? null : Number(ilvl), depth: listed ? Number(listed[1]) - 1 : 0 };
    cache.set(id, info);
    return info;
  };
}

const ROMAN = /** @type {Array<[number, string]>} */ ([
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]);

/**
 * A list number in the level's format; formats other than these read as decimal.
 * @param {number} n
 * @param {string} format
 */
function formatNumber(n, format) {
  if ((format === 'lowerLetter' || format === 'upperLetter') && n > 0) {
    let s = '';
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
    return format === 'upperLetter' ? s.toUpperCase() : s;
  }
  if ((format === 'lowerRoman' || format === 'upperRoman') && n > 0 && n < 4000) {
    let s = '';
    let k = n;
    for (const [value, digits] of ROMAN) {
      while (k >= value) {
        s += digits;
        k -= value;
      }
    }
    return format === 'upperRoman' ? s.toUpperCase() : s;
  }
  return String(n);
}

/**
 * List levels from the numbering part, and counters that number list items in document order.
 * @param {OfficePackage} pkg
 * @param {string} main
 */
async function readNumbering(pkg, main) {
  const [rel] = await pkg.related(main, 'numbering');
  const root = rel ? await pkg.xml(rel.target, { skip }) : null;
  /** @type {Map<string, Map<number, { format: string, text: string, start: number }>>} */
  const abstracts = new Map();
  for (const abs of W.children(root, 'abstractNum')) {
    /** @type {Map<number, { format: string, text: string, start: number }>} */
    const levels = new Map();
    for (const lvl of W.children(abs, 'lvl')) {
      levels.set(Number(W.attr(lvl, 'ilvl') ?? 0), { format: val(lvl, 'numFmt') ?? 'decimal', text: val(lvl, 'lvlText') ?? '', start: Number(val(lvl, 'start') ?? 1) || 0 });
    }
    abstracts.set(W.attr(abs, 'abstractNumId') ?? '', levels);
  }
  /** @type {Map<string, { levels: Map<number, { format: string, text: string, start: number }>, starts: Map<number, number> }>} */
  const nums = new Map();
  for (const num of W.children(root, 'num')) {
    /** @type {Map<number, number>} */
    const starts = new Map();
    for (const override of W.children(num, 'lvlOverride')) {
      const start = val(override, 'startOverride');
      if (start !== null) starts.set(Number(W.attr(override, 'ilvl') ?? 0), Number(start) || 0);
    }
    nums.set(W.attr(num, 'numId') ?? '', { levels: abstracts.get(val(num, 'abstractNumId') ?? '') ?? new Map(), starts });
  }
  /** @type {Map<string, number[]>} */
  const counters = new Map();

  /**
   * The marker of the next item of a list level: '-' for bullets, else the level text with its
   * numbers filled in ("1.", "2.1", "b)").
   * @param {string} numId
   * @param {number} ilvl
   */
  return (numId, ilvl) => {
    const num = nums.get(numId);
    const level = num?.levels.get(ilvl);
    if (!num || !level || level.format === 'bullet' || level.format === 'none') return { bullet: true, marker: '-' };
    const counts = counters.get(numId) ?? [];
    counters.set(numId, counts);
    counts.length = ilvl + 1;
    counts[ilvl] = counts[ilvl] === undefined ? (num.starts.get(ilvl) ?? level.start) : counts[ilvl] + 1;
    const marker = level.text.replace(/%([1-9])/g, (_, k) => {
      const i = Number(k) - 1;
      const lvl = num.levels.get(i);
      return formatNumber(counts[i] ?? lvl?.start ?? 1, lvl?.format ?? 'decimal');
    });
    return { bullet: false, marker: marker.trim() || `${formatNumber(counts[ilvl], level.format)}.` };
  };
}

/**
 * Text of a paragraph's runs. Text boxes found inside are handed to `boxes` (read after it).
 * @param {XmlElement} p
 * @param {XmlElement[]} boxes
 */
function paragraphText(p, boxes) {
  let out = '';
  /** @param {XmlElement} el */
  const walk = (el) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (W.is(c, 't') || M.is(c, 't')) out += c.children.join('');
      else if (W.is(c, 'tab') || W.is(c, 'ptab')) out += '\t';
      else if (W.is(c, 'br') || W.is(c, 'cr')) out += '\n';
      else if (W.is(c, 'noBreakHyphen')) out += '-';
      else if (W.is(c, 'txbxContent')) boxes.push(c);
      else if (!W.is(c, 'pPr') && !W.is(c, 'softHyphen')) walk(c);
    }
  };
  walk(p);
  return out
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * The cells of a table row, also those wrapped in content controls; a cell spanning several grid
 * columns is followed by empty cells so the row stays as wide as the header.
 * @param {XmlElement} tr
 * @returns {XmlElement[]}
 */
function cellsOf(tr) {
  /** @type {XmlElement[]} */
  const out = [];
  for (const c of tr.children) {
    if (typeof c === 'string') continue;
    if (W.is(c, 'tc')) out.push(c);
    else if (W.is(c, 'sdt')) out.push(...W.children(W.child(c, 'sdtContent'), 'tc'));
    else if (W.is(c, 'customXml')) out.push(...W.children(c, 'tc'));
  }
  return out;
}

/**
 * All text in a table cell on one line: paragraphs and text boxes in order, a nested table as its
 * lines joined with "; ".
 * @param {XmlElement} el
 */
function flatText(el) {
  /** @type {string[]} */
  const parts = [];
  /** @param {XmlElement} node */
  const walk = (node) => {
    for (const c of node.children) {
      if (typeof c === 'string') continue;
      if (W.is(c, 'p')) {
        /** @type {XmlElement[]} */
        const boxes = [];
        parts.push(paragraphText(c, boxes));
        boxes.forEach(walk);
      } else if (W.is(c, 'tbl')) parts.push(tableLines(tableRows(c)).join('; '));
      else if (!W.is(c, 'tcPr')) walk(c);
    }
  };
  walk(el);
  return squashSpace(parts.join(' '));
}

/**
 * The rows of a table as cell texts, rows in content controls included.
 * @param {XmlElement} tbl
 * @returns {string[][]}
 */
function tableRows(tbl) {
  /** @type {string[][]} */
  const rows = [];
  /** @param {XmlElement} el */
  const collect = (el) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (W.is(c, 'tr')) {
        /** @type {string[]} */
        const cells = [];
        for (const tc of cellsOf(c)) {
          cells.push(flatText(tc));
          const span = Number(val(W.child(tc, 'tcPr'), 'gridSpan') ?? 1);
          for (let k = 1; k < Math.min(span, 64); k++) cells.push('');
        }
        rows.push(cells);
      } else if (W.is(c, 'sdt')) collect(W.child(c, 'sdtContent') ?? c);
      else if (W.is(c, 'customXml')) collect(c);
    }
  };
  collect(tbl);
  return rows;
}

/**
 * @typedef {object} Context
 * @property {(id: string | null) => StyleInfo} style
 * @property {(numId: string, ilvl: number) => { bullet: boolean, marker: string }} number
 * @property {string | null} list  numbering of the last top-level list item; another one starts a new list
 */

/**
 * @param {XmlElement} p
 * @param {TextBlocks} out
 * @param {Context} ctx
 */
function paragraph(p, out, ctx) {
  /** @type {XmlElement[]} */
  const boxes = [];
  const text = paragraphText(p, boxes);
  const pPr = W.child(p, 'pPr');
  const style = ctx.style(val(pPr, 'pStyle'));
  const outline = val(pPr, 'outlineLvl');
  const heading = outline !== null ? (Number(outline) >= 0 && Number(outline) < 9 ? Number(outline) + 1 : 0) : style.heading;
  const numPr = W.child(pPr, 'numPr');
  const numId = val(numPr, 'numId') ?? style.numId;
  const ilvl = Number(val(numPr, 'ilvl') ?? style.ilvl ?? 0) || 0;
  const listed = numId !== null && numId !== '0';
  if (text) {
    if (heading) {
      const number = listed ? ctx.number(numId, ilvl) : null;
      out.push(`${'#'.repeat(Math.min(heading, 6))} ${number && !number.bullet ? `${number.marker} ` : ''}${squashSpace(text)}`);
    } else if (listed) {
      const { marker } = ctx.number(numId, ilvl);
      const depth = Math.min(ilvl + style.depth, 8);
      if (depth === 0) {
        if (ctx.list !== null && ctx.list !== numId) out.breakGroup();
        ctx.list = numId;
      }
      out.push(`${'  '.repeat(depth)}${marker} ${text}`, 'list');
    } else {
      out.push(text);
    }
  }
  for (const box of boxes) blocks(box, out, ctx);
}

/**
 * @param {XmlElement} tbl
 * @param {TextBlocks} out
 */
function table(tbl, out) {
  out.breakGroup();
  for (const line of tableLines(tableRows(tbl))) out.push(line, 'table');
  out.breakGroup();
}

/**
 * Block-level content: paragraphs and tables, also inside content controls and inserted revisions.
 * @param {XmlElement} container
 * @param {TextBlocks} out
 * @param {Context} ctx
 */
function blocks(container, out, ctx) {
  for (const c of container.children) {
    if (typeof c === 'string') continue;
    if (W.is(c, 'p')) paragraph(c, out, ctx);
    else if (W.is(c, 'tbl')) table(c, out);
    else if (W.is(c, 'sdt')) blocks(W.child(c, 'sdtContent') ?? c, out, ctx);
    else if (W.is(c, 'customXml') || W.is(c, 'ins') || W.is(c, 'moveTo') || W.is(c, 'smartTag') || MC.is(c, 'AlternateContent') || MC.is(c, 'Choice')) blocks(c, out, ctx);
  }
}

/**
 * Extracts the text of a DOCX file.
 * @param {Uint8Array} bytes
 * @param {OfficeOptions} [options]
 */
export async function docxToText(bytes, options = {}) {
  const pkg = openPackage(bytes, options);
  const main = await pkg.mainPart('word/document.xml');
  const doc = await pkg.xml(main, { skip });
  const body = W.is(doc, 'document') ? W.child(doc, 'body') : null;
  if (!body) throw new ParseError('invalid_document', 'The file is not a Word document');
  /** @type {Context} */
  const ctx = { style: await readStyles(pkg, main), number: await readNumbering(pkg, main), list: null };
  const out = new TextBlocks(options.maxChars);
  blocks(body, out, ctx);
  return out.toString();
}
