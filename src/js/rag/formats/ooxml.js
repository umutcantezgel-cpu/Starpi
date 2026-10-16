// @ts-check
// Office Open XML packages (DOCX, XLSX, PPTX): XML parts in a ZIP archive, linked by relationship
// parts (_rels/*.rels). The readers find their parts through these relationships instead of assuming
// file names, and accept both the transitional and the strict namespaces of each schema. Password
// protected Office files are not ZIP archives but compound files with an encryption stream; they are
// recognised and reported as such.
import { ParseError } from './errors.js';
import { decodeXmlBytes, parseXml, scanXml, vocabulary } from './xml.js';
import { isZip, openZip } from './zip.js';

/** @typedef {import('./xml.js').XmlElement} XmlElement */
/** @typedef {import('./xml.js').XmlHandler} XmlHandler */
/** @typedef {import('./zip.js').ZipLimits} ZipLimits */

/**
 * @typedef {object} Relationship
 * @property {string} id
 * @property {string} type    last segment of the relationship type URI ("officeDocument", "slide", …)
 * @property {string} target  part name the relationship points to, resolved ("ppt/slides/slide1.xml")
 * @property {boolean} external
 */

/**
 * @typedef {object} OfficeOptions
 * @property {number} [maxChars]  stop with 'too_large' beyond this many characters of text
 * @property {Partial<ZipLimits>} [limits]  tighter ZIP limits (tests)
 */

const RELS = vocabulary('http://schemas.openxmlformats.org/package/2006/relationships');

/** r:id and friends. */
export const R = vocabulary('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships');

/** DrawingML (text in shapes, slides and tables). */
export const A = vocabulary('http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main');

/** Markup compatibility: of mc:AlternateContent only mc:Choice is read, the mc:Fallback copy is dropped. */
export const MC = vocabulary('http://schemas.openxmlformats.org/markup-compatibility/2006');

const COMPOUND_FILE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * True when the UTF-16LE spelling of `word` occurs in the bytes (stream names of a compound file).
 * @param {Uint8Array} bytes
 * @param {string} word
 */
function containsUtf16(bytes, word) {
  const needle = new Uint8Array(word.length * 2);
  for (let i = 0; i < word.length; i++) needle[i * 2] = word.charCodeAt(i);
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (bytes[i] !== needle[0]) continue;
    for (let k = 1; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * The part a relationship target names, relative to the part that holds the relationship.
 * @param {string} source  part name ("word/document.xml"), '' for the package itself
 * @param {string} target  as written ("media/image1.png", "../slides/slide2.xml", "/xl/styles.xml")
 */
export function resolvePart(source, target) {
  let t = target;
  try {
    t = decodeURIComponent(target);
  } catch {
    // keep the target as written
  }
  t = t.replace(/\\/g, '/').split('#')[0];
  const parts = t.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const seg of t.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** @param {string} part */
function relationshipsPart(part) {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** A ZIP archive read as an Office package. */
export class OfficePackage {
  /** @param {import('./zip.js').ZipArchive} zip */
  constructor(zip) {
    this.zip = zip;
    /** @type {Map<string, Promise<Relationship[]>>} */
    this.rels = new Map();
  }

  /** @param {string} part */
  has(part) {
    return this.zip.get(part) !== null;
  }

  /**
   * The text of a part, or null when the package has no such part.
   * @param {string} part
   */
  async text(part) {
    const entry = this.zip.get(part);
    return entry ? decodeXmlBytes(await this.zip.read(entry)) : null;
  }

  /**
   * @param {string} part
   * @param {{ skip?: (el: XmlElement) => boolean }} [options]
   */
  async xml(part, options) {
    const text = await this.text(part);
    return text === null ? null : parseXml(text, options);
  }

  /**
   * Streams a part's XML events; false when the package has no such part.
   * @param {string} part
   * @param {XmlHandler} handler
   */
  async scan(part, handler) {
    const text = await this.text(part);
    if (text === null) return false;
    scanXml(text, handler);
    return true;
  }

  /**
   * The relationships of a part ('' for the package relationships).
   * @param {string} part
   * @returns {Promise<Relationship[]>}
   */
  relationships(part) {
    let pending = this.rels.get(part);
    if (!pending) {
      pending = this.xml(relationshipsPart(part)).then((root) =>
        RELS.children(root, 'Relationship').map((rel) => {
          const type = RELS.attr(rel, 'Type', true) ?? '';
          const external = (RELS.attr(rel, 'TargetMode', true) ?? '').toLowerCase() === 'external';
          const target = RELS.attr(rel, 'Target', true) ?? '';
          return { id: RELS.attr(rel, 'Id', true) ?? '', type: type.slice(type.lastIndexOf('/') + 1), target: external ? target : resolvePart(part, target), external };
        }),
      );
      this.rels.set(part, pending);
    }
    return pending;
  }

  /**
   * Internal targets of one relationship type from a part.
   * @param {string} part
   * @param {string} type
   */
  async related(part, type) {
    return (await this.relationships(part)).filter((r) => r.type === type && !r.external);
  }

  /**
   * The main document part, found through the package relationships, else the usual name.
   * @param {string} fallback
   */
  async mainPart(fallback) {
    const [main] = await this.related('', 'officeDocument');
    const part = main && this.has(main.target) ? main.target : fallback;
    if (!this.has(part)) throw new ParseError('invalid_document', 'The package has no main document part');
    return part;
  }
}

/**
 * Opens the bytes of a DOCX, XLSX or PPTX file.
 * @param {Uint8Array} bytes
 * @param {OfficeOptions} [options]
 */
export function openPackage(bytes, options = {}) {
  if (COMPOUND_FILE.every((b, i) => bytes[i] === b)) {
    if (containsUtf16(bytes, 'EncryptionInfo')) throw new ParseError('encrypted_document', 'The document is password protected');
    throw new ParseError('unsupported_type', 'The file is in the older binary Office format');
  }
  if (!isZip(bytes)) throw new ParseError('invalid_document', 'The file is not an Office Open XML package');
  return new OfficePackage(openZip(bytes, options.limits));
}

/**
 * Text of a DrawingML paragraph (a:p): runs, fields and line breaks.
 * @param {XmlElement} p
 */
export function drawingParagraphText(p) {
  let out = '';
  /** @param {XmlElement} el */
  const walk = (el) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (A.is(c, 't')) out += c.children.filter((x) => typeof x === 'string').join('');
      else if (A.is(c, 'br')) out += '\n';
      else if (!A.is(c, 'pPr') && !A.is(c, 'rPr') && !A.is(c, 'endParaRPr')) walk(c);
    }
  };
  walk(p);
  return out;
}

/**
 * Drops mc:Fallback copies and the given elements while parsing.
 * @param {(el: XmlElement) => boolean} [more]
 * @returns {(el: XmlElement) => boolean}
 */
export function skipFallback(more) {
  return (el) => MC.is(el, 'Fallback') || (more ? more(el) : false);
}
