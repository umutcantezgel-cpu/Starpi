// @ts-check
// Excel workbooks (XLSX) to text, one line per row or cell, each starting with the sheet name and
// the cell reference so a line still says where it comes from after chunking:
//   Budget / A2: Item: Shelves; Cost: 42000; Due: 2027-01-15
//   Notes / B3: Ana Ruiz
// A sheet whose first row with two or more cells is a usable header (distinct text cells, the same
// rule csvToText applies) reads as "column: value" pairs per row; rows above that header and sheets
// without one read cell by cell. Values are the cached results Excel shows: shared and inline
// strings, numbers rounded to 15 significant digits, dates and times in ISO form when the cell's
// number format is a date format, percentages with "%", TRUE/FALSE and error codes. Formulas without
// a cached value, charts and comments are not part of the text.
import { ParseError } from './errors.js';
import { openPackage, R } from './ooxml.js';
import { squashSpace, TextBlocks } from './text.js';
import { vocabulary } from './xml.js';

/** @typedef {import('./xml.js').XmlElement} XmlElement */
/** @typedef {import('./ooxml.js').OfficeOptions} OfficeOptions */
/** @typedef {import('./ooxml.js').OfficePackage} OfficePackage */

const S = vocabulary('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main');

const MAX_COLUMNS = 16_384;
const MAX_ROWS = 1_048_576;
const HEADER_SEARCH_ROWS = 10;

/** @typedef {'number' | 'date' | 'time' | 'datetime' | 'percent'} ValueKind */

/**
 * "A" -> 0, "AB" -> 27.
 * @param {string} letters
 */
export function columnIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 0 -> "A", 27 -> "AB".
 * @param {number} index
 */
export function columnName(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Built-in number formats that show dates and times (ECMA-376 part 1, 18.8.30, plus the East Asian ids).
const BUILTIN_KINDS = /** @type {Map<number, ValueKind>} */ (
  new Map([
    [9, 'percent'],
    [10, 'percent'],
    ...[14, 15, 16, 17, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58].map((id) => /** @type {[number, ValueKind]} */ ([id, 'date'])),
    ...[18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56].map((id) => /** @type {[number, ValueKind]} */ ([id, 'time'])),
    [22, 'datetime'],
  ])
);

/**
 * What a number format code shows: a date, a time, both, a percentage or a plain number. Quoted
 * text, escaped characters and bracketed sections ([Red], [$-409]) are ignored; elapsed-time
 * formats ([h]:mm) stay numbers.
 * @param {string} code
 * @returns {ValueKind}
 */
export function formatKind(code) {
  if (/\[(h+|m+|s+)\]/i.test(code)) return 'number';
  const bare = code
    .split(';')[0]
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/_.|\*./g, '')
    .toLowerCase();
  if (bare === 'general') return 'number';
  const date = /[dy]/.test(bare) || (/m/.test(bare) && !/[hs]/.test(bare));
  const time = /[hs]/.test(bare);
  if (date && time) return 'datetime';
  if (date) return 'date';
  if (time) return 'time';
  if (bare.includes('%')) return 'percent';
  return 'number';
}

/**
 * A number as Excel shows it with the General format: at most 15 significant digits.
 * @param {number} n
 */
export function formatGeneral(n) {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Number(n.toPrecision(15));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');

/**
 * A date serial number as ISO text ("2027-01-15", "09:30", "2027-03-03 09:30:15"), or null when it
 * is out of range. Serial 60 of the 1900 date system is the 29 February 1900 that never existed.
 * @param {number} serial
 * @param {'date' | 'time' | 'datetime'} kind
 * @param {boolean} date1904
 */
export function formatSerial(serial, kind, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466) return null;
  const seconds = Math.round((serial - Math.floor(serial)) * 86_400);
  const day = Math.floor(serial) + (seconds >= 86_400 ? 1 : 0);
  const secs = seconds % 86_400;
  const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}${secs % 60 ? `:${pad(secs % 60)}` : ''}`;
  if (kind === 'time') return time;
  let dateText;
  if (!date1904 && day === 60) dateText = '1900-02-29';
  else {
    // 1900 system: serial 1 is 1900-01-01, and every serial after the phantom 60 is one day early.
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, day < 60 ? 31 : 30);
    const d = new Date(base + day * 86_400_000);
    dateText = `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return kind === 'datetime' && secs ? `${dateText} ${time}` : dateText;
}

/**
 * The shared strings table: each item's text, rich text runs joined, phonetic hints left out.
 * @param {OfficePackage} pkg
 * @param {string | undefined} part
 */
async function readSharedStrings(pkg, part) {
  /** @type {string[]} */
  const strings = [];
  if (!part) return strings;
  let current = '';
  let inText = false;
  await pkg.scan(part, {
    open(el) {
      if (S.is(el, 'rPh') || S.is(el, 'phoneticPr')) return false;
      if (S.is(el, 'si')) current = '';
      else if (S.is(el, 't')) inText = true;
    },
    close(el) {
      if (S.is(el, 't')) inText = false;
      else if (S.is(el, 'si')) strings.push(current);
    },
    text(s) {
      if (inText) current += s;
    },
  });
  return strings;
}

/**
 * The value kind of each cell style index (cellXfs), from its number format.
 * @param {OfficePackage} pkg
 * @param {string | undefined} part
 * @returns {Promise<ValueKind[]>}
 */
async function readStyleKinds(pkg, part) {
  if (!part) return [];
  const root = await pkg.xml(part, { skip: (el) => S.is(el, 'fonts') || S.is(el, 'fills') || S.is(el, 'borders') || S.is(el, 'cellStyleXfs') || S.is(el, 'dxfs') || S.is(el, 'extLst') });
  /** @type {Map<number, ValueKind>} */
  const custom = new Map();
  for (const fmt of S.children(S.child(root, 'numFmts'), 'numFmt')) {
    custom.set(Number(S.attr(fmt, 'numFmtId', true)), formatKind(S.attr(fmt, 'formatCode', true) ?? ''));
  }
  return S.children(S.child(root, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(S.attr(xf, 'numFmtId', true) ?? 0);
    return custom.get(id) ?? BUILTIN_KINDS.get(id) ?? 'number';
  });
}

/**
 * @typedef {object} Cell
 * @property {number} col
 * @property {string} value
 * @property {boolean} text  a string cell (shared, inline or formula string), not a number, date or boolean
 */

/**
 * @typedef {object} SheetContext
 * @property {string[]} strings
 * @property {ValueKind[]} kinds
 * @property {boolean} date1904
 * @property {number} maxChars  a sheet whose cell text alone exceeds this is refused early
 */

/**
 * The rows of a worksheet with their non-empty cells, in row order.
 * @param {OfficePackage} pkg
 * @param {string} part
 * @param {SheetContext} ctx
 * @returns {Promise<Array<{ row: number, cells: Cell[] }>>}
 */
async function readSheet(pkg, part, ctx) {
  /** @type {Map<number, Cell[]>} */
  const rows = new Map();
  let rowNumber = 0;
  let colIndex = -1;
  let chars = 0;
  /** @type {{ ref: string | null, type: string, style: number, v: string, inline: string, inV: boolean, inT: boolean } | null} */
  let cell = null;
  const finish = () => {
    if (!cell) return;
    const c = cell;
    cell = null;
    const ref = c.ref ? /^([A-Za-z]{1,3})(\d+)$/.exec(c.ref) : null;
    if (ref) {
      colIndex = columnIndex(ref[1]);
      rowNumber = Number(ref[2]);
    } else colIndex += 1;
    if (colIndex < 0 || colIndex >= MAX_COLUMNS || rowNumber < 1 || rowNumber > MAX_ROWS) return;
    let value = '';
    let text = false;
    if (c.type === 's') {
      value = ctx.strings[Number(c.v)] ?? '';
      text = true;
    } else if (c.type === 'inlineStr') {
      value = c.inline;
      text = true;
    } else if (c.type === 'str') {
      value = c.v;
      text = true;
    } else if (c.type === 'b') value = c.v.trim() === '1' ? 'TRUE' : c.v.trim() === '0' ? 'FALSE' : '';
    else if (c.type === 'e') value = c.v.trim();
    else if (c.type === 'd') value = c.v.trim().replace(/T00:00(:00(\.0+)?)?Z?$/, '');
    else if (c.v.trim() !== '') {
      const n = Number(c.v);
      const kind = ctx.kinds[c.style] ?? 'number';
      if (Number.isNaN(n)) value = c.v.trim();
      else if (kind === 'percent') value = `${formatGeneral(n * 100)}%`;
      else if (kind !== 'number') value = formatSerial(n, kind, ctx.date1904) ?? formatGeneral(n);
      else value = formatGeneral(n);
    }
    value = squashSpace(value);
    if (!value) return;
    chars += value.length;
    if (chars > ctx.maxChars) throw new ParseError('too_large', 'Extracted text is too long', { max: ctx.maxChars });
    const list = rows.get(rowNumber) ?? [];
    rows.set(rowNumber, list);
    list.push({ col: colIndex, value, text });
  };
  await pkg.scan(part, {
    open(el) {
      if (!S.has(el)) return false; // extensions of other vocabularies hold no cell values
      if (S.is(el, 'row')) {
        const r = Number(S.attr(el, 'r', true));
        rowNumber = Number.isInteger(r) && r > 0 ? r : rowNumber + 1;
        colIndex = -1;
      } else if (S.is(el, 'c')) {
        cell = { ref: S.attr(el, 'r', true), type: S.attr(el, 't', true) ?? 'n', style: Number(S.attr(el, 's', true) ?? 0) || 0, v: '', inline: '', inV: false, inT: false };
      } else if (cell && S.is(el, 'v')) cell.inV = true;
      else if (cell && S.is(el, 't')) cell.inT = true;
      else if (S.is(el, 'rPh') || S.is(el, 'f') || S.is(el, 'extLst')) return false;
      else if (!cell && !S.is(el, 'worksheet') && !S.is(el, 'sheetData')) return false;
    },
    close(el) {
      if (!cell) return;
      if (S.is(el, 'v')) cell.inV = false;
      else if (S.is(el, 't')) cell.inT = false;
      else if (S.is(el, 'c')) finish();
    },
    text(s) {
      if (cell?.inV) cell.v += s;
      else if (cell?.inT) cell.inline += s;
    },
  });
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([row, cells]) => ({ row, cells: cells.sort((a, b) => a.col - b.col) }));
}

/**
 * The lines of one sheet: "column: value" pairs per row under a usable header, else cell by cell.
 * @param {string} sheet
 * @param {Array<{ row: number, cells: Cell[] }>} rows
 * @param {TextBlocks} out
 */
function sheetLines(sheet, rows, out) {
  const cellLine = (/** @type {number} */ row, /** @type {Cell} */ c) => `${sheet} / ${columnName(c.col)}${row}: ${c.value}`;
  const at = rows.slice(0, HEADER_SEARCH_ROWS).findIndex((r) => r.cells.length >= 2);
  const header = at >= 0 ? rows[at].cells : [];
  const columns = new Map(header.map((c) => [c.col, c.value]));
  const usable =
    at >= 0 &&
    rows.length > at + 1 &&
    header.every((c) => c.text && !/^[\d.,\s-]+$/.test(c.value)) &&
    new Set(header.map((c) => c.value.toLowerCase())).size === header.length &&
    rows.slice(at + 1).every((r) => r.cells.every((c) => columns.has(c.col)));
  if (!usable) {
    for (const r of rows) for (const c of r.cells) out.push(cellLine(r.row, c), 'sheet');
    return;
  }
  for (const r of rows.slice(0, at)) for (const c of r.cells) out.push(cellLine(r.row, c), 'sheet');
  const first = columnName(header[0].col);
  for (const r of rows.slice(at + 1)) {
    out.push(`${sheet} / ${first}${r.row}: ${r.cells.map((c) => `${columns.get(c.col)}: ${c.value}`).join('; ')}`, 'sheet');
  }
}

/**
 * Extracts the text of an XLSX file, sheet by sheet in workbook order.
 * @param {Uint8Array} bytes
 * @param {OfficeOptions} [options]
 */
export async function xlsxToText(bytes, options = {}) {
  const pkg = openPackage(bytes, options);
  const main = await pkg.mainPart('xl/workbook.xml');
  const workbook = await pkg.xml(main, { skip: (el) => S.is(el, 'definedNames') || S.is(el, 'extLst') });
  if (!S.is(workbook, 'workbook')) throw new ParseError('invalid_document', 'The file is not an Excel workbook');
  const pr = S.attr(S.child(workbook, 'workbookPr'), 'date1904', true);
  const rels = await pkg.relationships(main);
  const target = (/** @type {string} */ type) => rels.find((r) => r.type === type && !r.external)?.target;
  const out = new TextBlocks(options.maxChars);
  /** @type {SheetContext} */
  const ctx = { strings: await readSharedStrings(pkg, target('sharedStrings')), kinds: await readStyleKinds(pkg, target('styles')), date1904: pr === '1' || pr === 'true', maxChars: out.maxChars };
  for (const sheet of S.children(S.child(workbook, 'sheets'), 'sheet')) {
    const id = R.attr(sheet, 'id');
    const rel = rels.find((r) => r.id === id && r.type === 'worksheet' && !r.external);
    if (!rel || !pkg.has(rel.target)) continue; // chart sheets, dialog sheets, missing parts
    const name = squashSpace(S.attr(sheet, 'name', true) ?? '') || rel.target;
    sheetLines(name, await readSheet(pkg, rel.target, ctx), out);
    out.breakGroup();
  }
  return out.toString();
}
