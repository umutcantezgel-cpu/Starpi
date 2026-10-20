// @ts-check
// A small XML reader for the parts of Office documents. Workers have no DOMParser, and the parts need
// only a little of XML: elements, attributes, text, CDATA, comments and processing instructions, with
// namespace prefixes resolved. Only the five predefined entities and character references are
// decoded. A DOCTYPE is skipped and its entity declarations are never expanded, so entity tricks
// ("billion laughs") cannot inflate the text. Nesting deeper than MAX_XML_DEPTH is refused.
import { ParseError } from './errors.js';

export const MAX_XML_DEPTH = 256;

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * @typedef {object} XmlAttr
 * @property {string} ns     namespace URI, '' for an attribute without prefix
 * @property {string} local
 * @property {string} value
 */

/**
 * @typedef {object} XmlElement
 * @property {string} ns     namespace URI ('' when none is in scope)
 * @property {string} local  local name ("p" for <w:p>)
 * @property {XmlAttr[]} attrs
 * @property {Array<XmlElement | string>} children
 */

/**
 * @typedef {object} XmlHandler
 * @property {(el: XmlElement) => boolean | void} [open]  return false to skip the element's content
 * @property {(el: XmlElement) => void} [close]
 * @property {(text: string) => void} [text]
 */

/** @param {string} message */
const invalid = (message) => new ParseError('invalid_document', message);

const PREDEFINED = /** @type {Record<string, string>} */ ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" });

/**
 * Decodes the predefined entities and character references; anything else is kept as written.
 * @param {string} s
 */
export function decodeXmlEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, ref) => {
    if (ref[0] !== '#') return PREDEFINED[ref];
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

/**
 * Text of an XML part: UTF-16 when it starts with a byte order mark, else UTF-8.
 * @param {Uint8Array} bytes
 */
export function decodeXmlBytes(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Index after the '>' that ends the markup starting at `from`, skipping quoted values. For a
 * DOCTYPE the internal subset in brackets is skipped too.
 * @param {string} xml
 * @param {number} from
 * @param {boolean} [brackets]
 */
function endOfMarkup(xml, from, brackets = false) {
  let quote = '';
  let depth = 0;
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (brackets && ch === '[') depth += 1;
    else if (brackets && ch === ']') depth -= 1;
    else if (ch === '>' && depth <= 0) return i + 1;
  }
  throw invalid('An XML tag is not closed');
}

/**
 * Streams the events of an XML document: open (with resolved namespaces), text and close. Text
 * outside the root element is ignored.
 * @param {string} xml
 * @param {XmlHandler} handler
 */
export function scanXml(xml, handler) {
  /** @type {Array<{ el: XmlElement, qname: string, scope: Map<string, string>, skip: boolean }>} */
  const stack = [];
  let scope = new Map([['xml', XML_NS]]);
  let skipping = 0;
  const len = xml.length;
  let i = 0;
  /** @param {string} s */
  const emit = (s) => {
    if (s && stack.length && !skipping) handler.text?.(s);
  };
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      emit(decodeXmlEntities(xml.slice(i)));
      break;
    }
    if (lt > i) emit(decodeXmlEntities(xml.slice(i, lt)));
    const next = xml.charCodeAt(lt + 1);
    if (next === 0x21 /* ! */) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        if (end === -1) throw invalid('An XML comment is not closed');
        i = end + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        if (end === -1) throw invalid('An XML CDATA section is not closed');
        emit(xml.slice(lt + 9, end));
        i = end + 3;
      } else {
        i = endOfMarkup(xml, lt + 2, true); // DOCTYPE: skipped, never expanded
      }
      continue;
    }
    if (next === 0x3f /* ? */) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw invalid('An XML processing instruction is not closed');
      i = end + 2;
      continue;
    }
    if (next === 0x2f /* / */) {
      const end = xml.indexOf('>', lt + 2);
      if (end === -1) throw invalid('An XML end tag is not closed');
      const qname = xml.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.qname !== qname) throw invalid(`Unexpected end tag </${qname}>`);
      if (top.skip) skipping -= 1;
      else if (!skipping) handler.close?.(top.el);
      scope = top.scope;
      i = end + 1;
      continue;
    }

    // Start tag: name, attributes, optional "/>".
    const end = endOfMarkup(xml, lt + 1);
    const selfClosing = xml.charCodeAt(end - 2) === 0x2f;
    const body = xml.slice(lt + 1, selfClosing ? end - 2 : end - 1);
    const nameEnd = body.search(/[\s/]|$/);
    const qname = body.slice(0, nameEnd);
    if (!qname) throw invalid('An XML tag has no name');
    /** @type {Array<[string, string]>} */
    const raw = [];
    const attrPattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    attrPattern.lastIndex = nameEnd;
    for (let m = attrPattern.exec(body); m; m = attrPattern.exec(body)) raw.push([m[1], decodeXmlEntities(m[3] ?? m[4] ?? '')]);

    const parentScope = scope;
    for (const [name, value] of raw) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        if (scope === parentScope) scope = new Map(parentScope);
        scope.set(name === 'xmlns' ? '' : name.slice(6), value);
      }
    }
    const colon = qname.indexOf(':');
    /** @type {XmlElement} */
    const el = {
      ns: scope.get(colon === -1 ? '' : qname.slice(0, colon)) ?? '',
      local: colon === -1 ? qname : qname.slice(colon + 1),
      attrs: raw
        .filter(([name]) => name !== 'xmlns' && !name.startsWith('xmlns:'))
        .map(([name, value]) => {
          const c = name.indexOf(':');
          return { ns: c === -1 ? '' : (scope.get(name.slice(0, c)) ?? ''), local: c === -1 ? name : name.slice(c + 1), value };
        }),
      children: [],
    };
    let skip = false;
    if (skipping) skip = true;
    else if (handler.open?.(el) === false) skip = true;
    if (selfClosing) {
      if (!skip) handler.close?.(el);
      scope = parentScope;
    } else {
      if (stack.length >= MAX_XML_DEPTH) throw invalid('The XML is nested too deeply');
      stack.push({ el, qname, scope: parentScope, skip });
      if (skip) skipping += 1;
    }
    i = end;
  }
  if (stack.length) throw invalid(`The XML element <${stack[stack.length - 1].qname}> is not closed`);
}

/**
 * Parses XML into a tree. `skip(el)` returning true drops an element with everything inside it,
 * which keeps the tree small (run properties, drawings' geometry, …).
 * @param {string} xml
 * @param {{ skip?: (el: XmlElement) => boolean }} [options]
 * @returns {XmlElement}
 */
export function parseXml(xml, options = {}) {
  /** @type {XmlElement[]} */
  const stack = [];
  /** @type {XmlElement | null} */
  let root = null;
  scanXml(xml, {
    open(el) {
      if (options.skip?.(el)) return false;
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(el);
      else if (!root) root = el;
      else return false; // a second root element is ignored
      stack.push(el);
      return true;
    },
    close() {
      stack.pop();
    },
    text(s) {
      stack[stack.length - 1]?.children.push(s);
    },
  });
  if (!root) throw invalid('The XML has no root element');
  return root;
}

/**
 * Element helpers bound to one vocabulary, given by its namespace URIs (the transitional and the
 * strict URI of an Office schema, for example).
 * @param {...string} uris
 */
export function vocabulary(...uris) {
  const set = new Set(uris);
  /**
   * @param {XmlElement | string | null | undefined} node
   * @param {string} local
   * @returns {boolean}
   */
  const is = (node, local) => typeof node === 'object' && node !== null && node.local === local && set.has(node.ns);
  return {
    is,
    /** @param {XmlElement | string | null | undefined} node */
    has: (node) => typeof node === 'object' && node !== null && set.has(node.ns),
    /** @param {XmlElement | null | undefined} el @param {string} local */
    child: (el, local) => /** @type {XmlElement | null} */ (el?.children.find((c) => is(c, local)) ?? null),
    /** @param {XmlElement | null | undefined} el @param {string} local */
    children: (el, local) => /** @type {XmlElement[]} */ ((el?.children ?? []).filter((c) => is(c, local))),
    /**
     * An attribute of this vocabulary (w:val) or, with `plain`, one without prefix (Id, Target).
     * @param {XmlElement | null | undefined} el
     * @param {string} local
     * @param {boolean} [plain]
     */
    attr: (el, local, plain = false) => el?.attrs.find((a) => a.local === local && (plain ? a.ns === '' : set.has(a.ns)))?.value ?? null,
  };
}

/**
 * All element children of a node.
 * @param {XmlElement} el
 * @returns {XmlElement[]}
 */
export function elementsOf(el) {
  return /** @type {XmlElement[]} */ (el.children.filter((c) => typeof c !== 'string'));
}
