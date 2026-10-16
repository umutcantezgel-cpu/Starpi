// @ts-check
// HTML pages to text, without DOMParser (workers have none) and without running or loading anything.
// A forgiving tokenizer walks the markup once:
//  - script, style and the other raw-text elements are skipped to their end tag; template, noscript,
//    svg, canvas, object, select and similar elements are dropped with everything inside them;
//  - headings become Markdown headings, list items "- item" / "1. item" lines (nested lists
//    indented), tables go through tableLines ("column: value; …" per row), <pre> keeps its
//    whitespace, and all other text has its whitespace collapsed;
//  - the <title> heads the text when the page has no <h1>.
// Character references are decoded: the common named entities and every numeric reference, with
// the Windows-1252 fix-ups browsers apply to &#128;–&#159;.
import { squashSpace, tableLines, TextBlocks } from './text.js';

// Latin-1 entities, in code point order from U+00A0. Browsers also accept these without a semicolon.
const LATIN1 = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ');

/** @type {Map<string, string>} */
const ENTITIES = new Map([
  ...LATIN1.map((name, i) => /** @type {[string, string]} */ ([name, String.fromCharCode(0xa0 + i)])),
  ...Object.entries({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", AMP: '&', LT: '<', GT: '>', QUOT: '"', COPY: '©', REG: '®',
    OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
    ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏',
    ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡',
    bull: '•', hellip: '…', permil: '‰', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', euro: '€', trade: '™',
    larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194', minus: '−', radic: '√', infin: '∞', ne: '≠', le: '≤', ge: '≥',
    asymp: '≈', sum: '∑', prod: '∏', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ',
    mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω',
  }),
]);
const LEGACY = new Set([...LATIN1, 'amp', 'lt', 'gt', 'quot', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']);

// What browsers show for the C1 range of numeric references (the Windows-1252 characters).
const WINDOWS_1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

/**
 * Decodes HTML character references. Unknown names are kept as written.
 * @param {string} s
 */
export function decodeHtmlEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}))(;?)/g, (m, dec, hex, name, semi) => {
    if (name !== undefined) {
      const ch = ENTITIES.get(name);
      if (ch !== undefined && (semi || LEGACY.has(name))) return ch;
      // Like browsers: the longest legacy name at the start counts ("&copy2027" is "©2027").
      for (let k = Math.min(name.length - 1, 6); k >= 2; k--) {
        const prefix = name.slice(0, k);
        if (LEGACY.has(prefix)) return `${ENTITIES.get(prefix)}${name.slice(k)}${semi}`;
      }
      return m;
    }
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    if (code >= 0x80 && code <= 0x9f) return WINDOWS_1252[code - 0x80];
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  });
}

/**
 * The text of an HTML file's bytes: a byte order mark wins, then a <meta charset> (or http-equiv
 * content type) in the first 1024 bytes, else UTF-8. Unknown encodings read as UTF-8.
 * @param {Uint8Array} bytes
 */
export function decodeHtmlBytes(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  let label = 'utf-8';
  if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    const head = String.fromCharCode(...bytes.subarray(0, 1024));
    const meta = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
    // A page that says UTF-16 without a byte order mark is read as UTF-8, as browsers do.
    if (meta && !/^utf-?16/i.test(meta[1])) label = meta[1].toLowerCase();
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// Elements whose content is raw text up to the end tag (never markup), and elements dropped with
// their whole subtree because they hold no readable text.
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'textarea', 'title']);
const DROPPED = new Set(['template', 'noscript', 'svg', 'canvas', 'object', 'select', 'datalist', 'audio', 'video', 'map']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'header', 'hgroup', 'hr', 'html', 'legend', 'main', 'nav', 'p', 'section', 'summary', 'tbody', 'tfoot', 'thead',
]);
const LISTS = new Set(['ul', 'ol', 'menu']);

/**
 * Reads a start tag beginning at `start` ("<name …>").
 * @param {string} html
 * @param {number} start
 */
function readTag(html, start) {
  const len = html.length;
  let j = start + 1;
  while (j < len && !/[\s/>]/.test(html[j])) j++;
  const name = html.slice(start + 1, j).toLowerCase();
  /** @type {Map<string, string>} */
  const attrs = new Map();
  let selfClosing = false;
  while (j < len) {
    const ch = html[j];
    if (ch === '>') {
      j++;
      break;
    }
    if (ch === '/' && html[j + 1] === '>') {
      selfClosing = true;
      j += 2;
      break;
    }
    if (ch === '/' || /\s/.test(ch)) {
      j++;
      continue;
    }
    let k = j;
    while (k < len && !/[\s=>]/.test(html[k]) && !(html[k] === '/' && html[k + 1] === '>')) k++;
    const attr = html.slice(j, k).toLowerCase();
    j = k;
    while (j < len && /\s/.test(html[j])) j++;
    let value = '';
    if (html[j] === '=') {
      j++;
      while (j < len && /\s/.test(html[j])) j++;
      const quote = html[j];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, j + 1);
        value = html.slice(j + 1, end === -1 ? len : end);
        j = end === -1 ? len : end + 1;
      } else {
        let end = j;
        while (end < len && !/[\s>]/.test(html[end])) end++;
        value = html.slice(j, end);
        j = end;
      }
    }
    if (attr && !attrs.has(attr)) attrs.set(attr, decodeHtmlEntities(value));
  }
  return { name, attrs, end: j, selfClosing };
}

/**
 * @typedef {object} ListState
 * @property {boolean} ordered
 * @property {number} n   number of the last item
 * @property {boolean} [implicit]  opened by an <li> outside any list; closed with that item
 */

/**
 * @typedef {object} ItemState
 * @property {ListState} list
 * @property {number} depth
 * @property {string} marker
 * @property {boolean} used  the marker was written; further blocks of the item are indented only
 */

/**
 * @typedef {object} TableState
 * @property {string[][]} rows
 * @property {string[] | null} row
 * @property {string | null} cell
 */

/**
 * Extracts the readable text of an HTML document.
 * @param {string} html
 * @param {{ maxChars?: number }} [options]
 */
export function htmlToText(html, options = {}) {
  const out = new TextBlocks(options.maxChars);
  let inline = '';
  let pre = 0;
  let heading = 0;
  let title = '';
  let hasH1 = false;
  let dropped = '';
  let dropDepth = 0;
  /** @type {ListState[]} */
  const lists = [];
  /** @type {ItemState[]} */
  const items = [];
  /** @type {TableState[]} */
  const tables = [];

  const table = () => tables[tables.length - 1];
  const inCell = () => {
    const t = table();
    return Boolean(t && t.cell !== null);
  };
  /** @param {string} s */
  const append = (s) => {
    const t = table();
    if (t && t.cell !== null) t.cell += s;
    else inline += s;
  };
  const flush = () => {
    const raw = inline;
    inline = '';
    const text = pre
      ? raw.replace(/^\n/, '').replace(/\s+$/, '')
      : raw
          .split('\n')
          .map((line) => line.replace(/ {2,}/g, ' ').trim())
          .join('\n')
          .trim();
    if (!text.trim()) return;
    const item = items[items.length - 1];
    if (heading) out.push(`${'#'.repeat(heading)} ${squashSpace(text)}`);
    else if (item) {
      out.push(`${'  '.repeat(item.depth)}${item.used ? ' '.repeat(item.marker.length) : item.marker} ${text}`, 'list');
      item.used = true;
    } else out.push(text);
  };
  /** @param {TableState} t */
  const endCell = (t) => {
    if (t.cell === null) return;
    (t.row ??= []).push(t.cell);
    t.cell = null;
  };
  /** @param {TableState} t */
  const endRow = (t) => {
    endCell(t);
    if (t.row) t.rows.push(t.row);
    t.row = null;
  };
  /** A block boundary: inside a table cell only a space, elsewhere the end of a block. */
  const boundary = () => (inCell() ? append(' ') : flush());

  /**
   * @param {string} name
   * @param {Map<string, string>} attrs
   * @param {boolean} selfClosing
   */
  const startTag = (name, attrs, selfClosing) => {
    if (dropDepth) {
      if (name === dropped && !selfClosing) dropDepth += 1;
      return;
    }
    if (DROPPED.has(name)) {
      if (selfClosing) return;
      dropped = name;
      dropDepth = 1;
      return;
    }
    const level = /^h([1-6])$/.exec(name);
    if (name === 'br') append(inCell() ? ' ' : '\n');
    else if (level) {
      if (inCell()) return append(' ');
      flush();
      heading = Number(level[1]);
      if (heading === 1) hasH1 = true;
    } else if (LISTS.has(name)) {
      if (inCell()) return append(' ');
      flush();
      if (lists.length && lists[lists.length - 1].implicit && !items.length) lists.pop();
      const ordered = name === 'ol';
      lists.push({ ordered, n: ordered ? (parseInt(attrs.get('start') ?? '', 10) || 1) - 1 : 0 });
    } else if (name === 'li') {
      if (inCell()) return append(' ');
      flush();
      if (!lists.length) lists.push({ ordered: false, n: 0, implicit: true });
      const list = lists[lists.length - 1];
      while (items.length && items[items.length - 1].list === list) items.pop(); // an unclosed <li>
      const value = parseInt(attrs.get('value') ?? '', 10);
      list.n = Number.isFinite(value) ? value : list.n + 1;
      items.push({ list, depth: Math.min(lists.length - 1, 8), marker: list.ordered ? `${list.n}.` : '-', used: false });
    } else if (name === 'table') {
      if (!inCell()) flush();
      tables.push({ rows: [], row: null, cell: null });
    } else if (name === 'tr') {
      const t = table();
      if (t) {
        endRow(t);
        t.row = [];
      } else flush();
    } else if (name === 'td' || name === 'th') {
      const t = table();
      if (t) {
        endCell(t);
        t.row ??= [];
        t.cell = '';
      } else flush();
    } else if (name === 'pre') {
      boundary();
      pre += 1;
    } else if (BLOCK.has(name)) boundary();
  };

  /** @param {string} name */
  const endTag = (name) => {
    if (dropDepth) {
      if (name === dropped) dropDepth -= 1;
      return;
    }
    if (/^h[1-6]$/.test(name)) {
      if (inCell()) return append(' ');
      flush();
      heading = 0;
    } else if (name === 'li') {
      if (inCell()) return append(' ');
      flush();
      if (items.length && items[items.length - 1].list === lists[lists.length - 1]) items.pop();
      if (lists.length && lists[lists.length - 1].implicit && !items.some((it) => it.list === lists[lists.length - 1])) lists.pop();
    } else if (LISTS.has(name)) {
      if (inCell()) return append(' ');
      flush();
      const list = lists.pop();
      while (items.length && items[items.length - 1].list === list) items.pop();
    } else if (name === 'td' || name === 'th') {
      const t = table();
      if (t) endCell(t);
    } else if (name === 'tr') {
      const t = table();
      if (t) endRow(t);
    } else if (name === 'table') {
      const t = tables.pop();
      if (!t) return;
      endRow(t);
      const lines = tableLines(t.rows);
      if (inCell()) append(` ${lines.join(' ')} `);
      else {
        flush();
        out.breakGroup();
        for (const line of lines) out.push(line, 'table');
        out.breakGroup();
      }
    } else if (name === 'pre') {
      if (inCell()) append(' ');
      else flush();
      pre = Math.max(0, pre - 1);
    } else if (BLOCK.has(name)) boundary();
  };

  /** @param {string} raw */
  const text = (raw) => {
    if (dropDepth || !raw) return;
    const s = decodeHtmlEntities(raw).replace(/\u00a0/g, ' ');
    append(pre ? s : s.replace(/[\t\n\f\r ]+/g, ' '));
  };

  const len = html.length;
  let i = 0;
  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    i = lt;
    const next = html[i + 1] ?? '';
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? len : end + 3;
    } else if (next === '!' || next === '?') {
      const end = html.indexOf('>', i + 2);
      i = end === -1 ? len : end + 1;
    } else if (next === '/' && /[a-zA-Z]/.test(html[i + 2] ?? '')) {
      const end = html.indexOf('>', i + 2);
      const name = /^[^\s/>]+/.exec(html.slice(i + 2, end === -1 ? len : end))?.[0].toLowerCase() ?? '';
      endTag(name);
      i = end === -1 ? len : end + 1;
    } else if (/[a-zA-Z]/.test(next)) {
      const tag = readTag(html, i);
      i = tag.end;
      if (RAW_TEXT.has(tag.name) && !tag.selfClosing) {
        const close = new RegExp(`</${tag.name}(?=[\\s/>])`, 'gi');
        close.lastIndex = i;
        const found = close.exec(html);
        const contentEnd = found ? found.index : len;
        if (tag.name === 'title' && !title && !dropDepth) title = squashSpace(decodeHtmlEntities(html.slice(i, contentEnd)));
        const end = found ? html.indexOf('>', found.index) : -1;
        i = end === -1 ? len : end + 1;
        continue;
      }
      startTag(tag.name, tag.attrs, tag.selfClosing);
    } else {
      text('<');
      i += 1;
    }
  }
  while (tables.length) endTag('table');
  flush();
  const body = out.toString();
  return title && !hasH1 ? `# ${title}${body ? `\n\n${body}` : ''}` : body;
}
