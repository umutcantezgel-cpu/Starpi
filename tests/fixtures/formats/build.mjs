// Builders for the format tests: a ZIP writer that is independent of the reader under test (node:zlib
// deflates and computes the CRC-32) and can write broken or hostile archives on purpose, plus small
// DOCX, XLSX and PPTX packages assembled from XML strings.
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';

/**
 * @typedef {object} ZipFile
 * @property {string} name
 * @property {string | Uint8Array} [data]
 * @property {0 | 8 | number} [method]    compression method written (8 deflate by default)
 * @property {Uint8Array} [payload]       bytes stored as the entry's data instead of the compressed `data`
 * @property {number} [size]              declared uncompressed size (default: the real one)
 * @property {number} [crc]               declared CRC-32 (default: the real one)
 * @property {number} [flags]             extra general purpose flags (bit 0 encrypted, bit 3 data descriptor)
 * @property {number} [aliasOf]           only a central directory record, pointing at that earlier entry's data
 */

/**
 * Writes a ZIP archive.
 * @param {ZipFile[]} files
 * @param {{ zip64?: boolean, comment?: string }} [options]
 */
export function makeZip(files, options = {}) {
  const zip64 = Boolean(options.zip64);
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const central = [];
  /** @type {Array<{ offset: number, crc: number, csize: number, size: number, method: number, flags: number }>} */
  const written = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    let rec;
    if (f.aliasOf !== undefined) rec = written[f.aliasOf];
    else {
      const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data ?? new Uint8Array());
      const method = f.method ?? 8;
      const payload = f.payload ? Buffer.from(f.payload) : method === 8 ? deflateRawSync(data) : data;
      const flags = 0x800 | (f.flags ?? 0);
      rec = { offset, crc: f.crc ?? zlibCrc32(data), csize: payload.length, size: f.size ?? data.length, method, flags };
      const descriptor = (flags & 0x8) !== 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(zip64 ? 45 : 20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0x21, 12);
      local.writeUInt32LE(descriptor ? 0 : rec.crc, 14);
      local.writeUInt32LE(descriptor ? 0 : zip64 ? 0xffffffff : rec.csize, 18);
      local.writeUInt32LE(descriptor ? 0 : zip64 ? 0xffffffff : rec.size, 22);
      local.writeUInt16LE(name.length, 26);
      const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
      if (zip64) {
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(16, 2);
        extra.writeBigUInt64LE(BigInt(rec.size), 4);
        extra.writeBigUInt64LE(BigInt(rec.csize), 12);
      }
      local.writeUInt16LE(extra.length, 28);
      chunks.push(local, name, extra, payload);
      offset += local.length + name.length + extra.length + payload.length;
      if (descriptor) {
        const dd = Buffer.alloc(16);
        dd.writeUInt32LE(0x08074b50, 0);
        dd.writeUInt32LE(rec.crc, 4);
        dd.writeUInt32LE(rec.csize, 8);
        dd.writeUInt32LE(rec.size, 12);
        chunks.push(dd);
        offset += dd.length;
      }
      written.push(rec);
    }
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(zip64 ? 45 : 20, 4);
    head.writeUInt16LE(zip64 ? 45 : 20, 6);
    head.writeUInt16LE(rec.flags, 8);
    head.writeUInt16LE(rec.method, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0x21, 14);
    head.writeUInt32LE(rec.crc, 16);
    head.writeUInt32LE(zip64 ? 0xffffffff : rec.csize, 20);
    head.writeUInt32LE(zip64 ? 0xffffffff : rec.size, 24);
    head.writeUInt16LE(name.length, 28);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(rec.size), 4);
      extra.writeBigUInt64LE(BigInt(rec.csize), 12);
      extra.writeBigUInt64LE(BigInt(rec.offset), 20);
    }
    head.writeUInt16LE(extra.length, 30);
    head.writeUInt32LE(zip64 ? 0xffffffff : rec.offset, 42);
    central.push(head, name, extra);
  }
  const directory = Buffer.concat(central);
  const count = files.length;
  /** @type {Buffer[]} */
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : count, 8);
  end.writeUInt16LE(zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...chunks, directory, ...tail, end, comment]));
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wStrict: 'http://purl.oclc.org/ooxml/wordprocessingml/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: REL,
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
};

/**
 * A relationships part.
 * @param {Array<[id: string, type: string, target: string]>} rels
 */
export function relsXml(rels) {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL}">${rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

/**
 * A DOCX package around a document body (the inner XML of w:body, prefix w).
 * @param {string} body
 * @param {{ styles?: string, numbering?: string, ns?: string, main?: string, noRels?: boolean }} [options]
 */
export function makeDocx(body, options = {}) {
  const ns = options.ns ?? NS.w;
  const main = options.main ?? 'word/document.xml';
  const dir = main.slice(0, main.lastIndexOf('/') + 1);
  const rels = /** @type {Array<[string, string, string]>} */ ([]);
  /** @type {ZipFile[]} */
  const files = [{ name: main, data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${ns}" xmlns:mc="${NS.mc}" xmlns:r="${REL}"><w:body>${body}</w:body></w:document>` }];
  if (options.styles) {
    rels.push(['rId1', 'styles', 'styles.xml']);
    files.push({ name: `${dir}styles.xml`, data: `<w:styles xmlns:w="${ns}">${options.styles}</w:styles>` });
  }
  if (options.numbering) {
    rels.push(['rId2', 'numbering', 'numbering.xml']);
    files.push({ name: `${dir}numbering.xml`, data: `<w:numbering xmlns:w="${ns}">${options.numbering}</w:numbering>` });
  }
  if (!options.noRels) {
    files.push({ name: '_rels/.rels', data: relsXml([['rId1', 'officeDocument', main]]) });
    files.push({ name: `${dir}_rels/${main.slice(dir.length)}.rels`, data: relsXml(rels) });
  }
  return makeZip(files);
}

/**
 * An XLSX package.
 * @param {Array<{ name: string, xml: string, type?: string }>} sheets  inner XML of each worksheet's sheetData
 * @param {{ strings?: string[] | string, styles?: string, date1904?: boolean }} [options]
 */
export function makeXlsx(sheets, options = {}) {
  /** @type {Array<[string, string, string]>} */
  const rels = sheets.map((s, i) => [`rId${i + 1}`, s.type ?? 'worksheet', `worksheets/sheet${i + 1}.xml`]);
  /** @type {ZipFile[]} */
  const files = [
    { name: '_rels/.rels', data: relsXml([['rId1', 'officeDocument', 'xl/workbook.xml']]) },
    {
      name: 'xl/workbook.xml',
      data: `<workbook xmlns="${NS.s}" xmlns:r="${REL}"><workbookPr${options.date1904 ? ' date1904="1"' : ''}/><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: `<worksheet xmlns="${NS.s}"><dimension ref="A1"/><sheetData>${s.xml}</sheetData></worksheet>` })),
  ];
  if (options.strings) {
    rels.push(['rIdS', 'sharedStrings', 'sharedStrings.xml']);
    const items = Array.isArray(options.strings) ? options.strings.map((s) => `<si><t>${s}</t></si>`).join('') : options.strings;
    files.push({ name: 'xl/sharedStrings.xml', data: `<sst xmlns="${NS.s}">${items}</sst>` });
  }
  if (options.styles) {
    rels.push(['rIdT', 'styles', 'styles.xml']);
    files.push({ name: 'xl/styles.xml', data: `<styleSheet xmlns="${NS.s}">${options.styles}</styleSheet>` });
  }
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: relsXml(rels) });
  return makeZip(files);
}

/**
 * A PPTX package. Each slide is the inner XML of p:spTree; notes likewise.
 * @param {Array<{ shapes: string, notes?: string, file?: string }>} slides  in presentation order
 */
export function makePptx(slides) {
  const head = `xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${REL}"`;
  /** @type {ZipFile[]} */
  const files = [
    { name: '_rels/.rels', data: relsXml([['rId1', 'officeDocument', 'ppt/presentation.xml']]) },
    { name: 'ppt/presentation.xml', data: `<p:presentation ${head}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(slides.map((s, i) => [`rId${i + 1}`, 'slide', `slides/${s.file ?? `slide${i + 1}.xml`}`])) },
  ];
  slides.forEach((s, i) => {
    const file = s.file ?? `slide${i + 1}.xml`;
    files.push({ name: `ppt/slides/${file}`, data: `<p:sld ${head}><p:cSld><p:spTree>${s.shapes}</p:spTree></p:cSld></p:sld>` });
    if (s.notes !== undefined) {
      files.push({ name: `ppt/slides/_rels/${file}.rels`, data: relsXml([['rId1', 'notesSlide', `../notesSlides/notes${i + 1}.xml`]]) });
      files.push({ name: `ppt/notesSlides/notes${i + 1}.xml`, data: `<p:notes ${head}><p:cSld><p:spTree>${s.notes}</p:spTree></p:cSld></p:notes>` });
    }
  });
  return makeZip(files);
}

/**
 * A slide shape with paragraphs; `type` makes it a placeholder of that type.
 * @param {string[]} paragraphs
 * @param {string} [type]
 */
export function shape(paragraphs, type) {
  const ph = type === undefined ? '' : `<p:ph type="${type}"/>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs.map((t) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
}
