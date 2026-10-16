// @ts-check
// PowerPoint presentations (PPTX) to text, one block per slide in presentation order:
//   Slide 2: Budget
//   Approved: 240,000 EUR
//   Notes: Mention that the tender closes in April.
// The first line names the slide and its title; then every other paragraph of the slide's shapes
// (groups included) in drawing order, tables through tableLines, and the speaker notes last.
// Placeholders for the date, footer and slide number and the text of layouts and masters are left out.
import { ParseError } from './errors.js';
import { A, drawingParagraphText, openPackage, R, skipFallback } from './ooxml.js';
import { squashSpace, tableLines, TextBlocks } from './text.js';
import { vocabulary } from './xml.js';

/** @typedef {import('./xml.js').XmlElement} XmlElement */
/** @typedef {import('./ooxml.js').OfficeOptions} OfficeOptions */

const P = vocabulary('http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main');

const TITLE = new Set(['title', 'ctrTitle']);
const NOISE = new Set(['dt', 'ftr', 'sldNum', 'sldImg', 'hdr']);
const skip = skipFallback((el) => A.is(el, 'rPr') || A.is(el, 'endParaRPr') || A.is(el, 'bodyPr') || A.is(el, 'lstStyle') || P.is(el, 'spPr') || P.is(el, 'grpSpPr') || A.is(el, 'tcPr') || A.is(el, 'tblPr') || A.is(el, 'tblGrid'));

/**
 * The placeholder type of a shape ("title", "body", …), '' for a shape that is no placeholder or
 * has no type.
 * @param {XmlElement} shape
 */
function placeholderType(shape) {
  const nv = P.child(shape, 'nvSpPr') ?? P.child(shape, 'nvGraphicFramePr');
  const ph = P.child(P.child(nv, 'nvPr'), 'ph');
  return ph ? (P.attr(ph, 'type', true) ?? 'body') : '';
}

/**
 * The paragraphs of a text body, each trimmed, empty ones left out.
 * @param {XmlElement | null} body
 */
function paragraphs(body) {
  return A.children(body, 'p')
    .map((p) => drawingParagraphText(p).split('\n').map((l) => l.trim()).join('\n').trim())
    .filter(Boolean);
}

/**
 * Rows of a DrawingML table, each cell's paragraphs on one line.
 * @param {XmlElement} tbl
 */
function tableRows(tbl) {
  return A.children(tbl, 'tr').map((tr) => A.children(tr, 'tc').map((tc) => squashSpace(paragraphs(A.child(tc, 'txBody')).join(' '))));
}

/**
 * The text of a slide or notes page: title paragraphs and the other lines (paragraphs and table
 * rows) in drawing order.
 * @param {XmlElement} root
 */
function readShapes(root) {
  /** @type {string[]} */
  const title = [];
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const body = [];
  /** @param {XmlElement} tree */
  const walk = (tree) => {
    for (const c of tree.children) {
      if (typeof c === 'string') continue;
      if (P.is(c, 'sp')) {
        const type = placeholderType(c);
        if (NOISE.has(type)) continue;
        const paras = paragraphs(P.child(c, 'txBody'));
        if (TITLE.has(type)) title.push(...paras);
        else {
          lines.push(...paras);
          if (type === 'body') body.push(...paras);
        }
      } else if (P.is(c, 'graphicFrame')) {
        const tbl = A.child(A.child(A.child(c, 'graphic'), 'graphicData'), 'tbl');
        if (tbl) lines.push(...tableLines(tableRows(tbl)));
      } else if (P.is(c, 'grpSp') || c.local === 'AlternateContent' || c.local === 'Choice') walk(c);
    }
  };
  const tree = P.child(P.child(root, 'cSld'), 'spTree');
  if (tree) walk(tree);
  return { title, lines, body };
}

/**
 * Extracts the text of a PPTX file.
 * @param {Uint8Array} bytes
 * @param {OfficeOptions} [options]
 */
export async function pptxToText(bytes, options = {}) {
  const pkg = openPackage(bytes, options);
  const main = await pkg.mainPart('ppt/presentation.xml');
  const presentation = await pkg.xml(main, { skip: (el) => P.is(el, 'defaultTextStyle') || P.is(el, 'extLst') });
  if (!P.is(presentation, 'presentation')) throw new ParseError('invalid_document', 'The file is not a PowerPoint presentation');
  const rels = await pkg.relationships(main);
  const out = new TextBlocks(options.maxChars);
  let n = 0;
  for (const sldId of P.children(P.child(presentation, 'sldIdLst'), 'sldId')) {
    const rid = R.attr(sldId, 'id');
    const rel = rels.find((r) => r.id === rid && r.type === 'slide' && !r.external);
    if (!rel) continue;
    const slide = await pkg.xml(rel.target, { skip });
    if (!slide) continue;
    n += 1;
    const { title, lines } = readShapes(slide);
    const [notesRel] = await pkg.related(rel.target, 'notesSlide');
    const notes = notesRel ? await pkg.xml(notesRel.target, { skip }) : null;
    const notesText = notes ? readShapes(notes).body : [];
    if (!title.length && !lines.length && !notesText.length) continue; // a picture-only slide adds no text
    const block = [`Slide ${n}:${title.length ? ` ${squashSpace(title.join(' '))}` : ''}`, ...lines];
    if (notesText.length) block.push(`Notes: ${notesText.join('\n')}`);
    out.push(block.join('\n'));
  }
  return out.toString();
}
