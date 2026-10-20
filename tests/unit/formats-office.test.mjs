// DOCX, XLSX and PPTX extraction: files written by real programs (tests/fixtures/formats, made by
// make-fixtures.py) and small packages built here for the cases those programs do not produce.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hasKey, LOCALES } from '../../src/js/i18n/index.js';
import { docxToText } from '../../src/js/rag/formats/docx.js';
import { ParseError } from '../../src/js/rag/formats/errors.js';
import { pptxToText } from '../../src/js/rag/formats/pptx.js';
import { columnIndex, columnName, formatGeneral, formatKind, formatSerial, xlsxToText } from '../../src/js/rag/formats/xlsx.js';
import { extractText } from '../../src/js/rag/parser.js';
import { makeDocx, makePptx, makeXlsx, makeZip, NS, shape } from '../fixtures/formats/build.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/formats');
const fixture = (/** @type {string} */ name) => new Uint8Array(readFileSync(path.join(DIR, name)));
/** @param {string} code */
const code = (code) => (/** @type {unknown} */ err) => err instanceof ParseError && err.code === code;

const REPORT = `# Harbor Library Renovation

# Overview

The reading room reopens on 3 March 2027. The approved budget is 240,000 EUR.

## Milestones

- Design review in May
  - Two bids compared
- Contract signed in June

1. Order the shelves
2. Install the lighting

## Team

Role: Lead; Name: Ana Ruiz; Hours: 120
Role: Architect; Name: Ben Okafor; Hours: 80

Grüße an das Team in Köln: bold part and a second line
after the break.`;

describe('DOCX', () => {
  it('reads documents written by two different programs to the same text', async () => {
    assert.equal(await docxToText(fixture('report.docx')), REPORT);
    assert.equal(await docxToText(fixture('report-lo.docx')), REPORT);
  });

  it('reads headings, bullet and numbered lists and tables of a converted Markdown file', async () => {
    assert.equal(
      await docxToText(fixture('notes-pandoc.docx')),
      '# Field Notes\n\nThe survey covered 12 sites in two weeks.\n\n## Findings\n\n- Most paths were dry\n- Two bridges need repair\n\n1. Repair the north bridge\n2. Mark the trail\n\nSite: North; Visitors: 340\nSite: South; Visitors: 125',
    );
  });

  it('keeps inserted text and field results, drops deleted text, field codes and fallback copies', async () => {
    const body =
      '<w:p><w:r><w:t xml:space="preserve">Budget: </w:t></w:r><w:del w:id="1"><w:r><w:delText>200,000</w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t>240,000</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> EUR</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
      '<w:p><w:r><w:t>Anchor</w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>Text in a box</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Text in a box</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>' +
      '<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>Inside a content control</w:t></w:r><w:r><w:tab/><w:t>after a tab</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
      '<w:p><w:hyperlink r:id="rId9"><w:r><w:t>linked</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and &amp; escaped &lt;tag&gt; &#x20AC;</w:t></w:r></w:p>';
    assert.equal(await docxToText(makeDocx(body)), 'Budget: 240,000 EUR\n\nPage 3\n\nAnchor\n\nText in a box\n\nInside a content control\tafter a tab\n\nlinked and & escaped <tag> €');
  });

  it('numbers headings and list levels as the numbering part defines them', async () => {
    const numbering =
      '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1)"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride></w:num>';
    const styles =
      '<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/><w:basedOn w:val="berschrift1"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Wichtig"><w:name w:val="Key point"/><w:basedOn w:val="berschrift2"/></w:style>';
    const p = (/** @type {string} */ t, /** @type {string} */ pPr = '') => `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
    const body =
      p('Scope', '<w:pStyle w:val="berschrift1"/>') +
      p('Goals', '<w:pStyle w:val="berschrift2"/>') +
      p('Limits', '<w:pStyle w:val="Wichtig"/>') +
      p('First', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
      p('Nested', '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr>') +
      p('Second', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
      p('Plain again', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>');
    assert.equal(await docxToText(makeDocx(body, { styles, numbering })), '# 1. Scope\n\n## 1.1 Goals\n\n## 1.2 Limits\n\nc) First\n  - Nested\nd) Second\n\nPlain again');
  });

  it('reads headings by style id when the styles part is missing, and the strict namespace', async () => {
    const body = '<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Section</w:t></w:r></w:p><w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Outline heading</w:t></w:r></w:p><w:p><w:r><w:t>Body</w:t></w:r></w:p>';
    assert.equal(await docxToText(makeDocx(body)), '### Section\n\n## Outline heading\n\nBody');
    assert.equal(await docxToText(makeDocx(body, { ns: NS.wStrict })), '### Section\n\n## Outline heading\n\nBody');
    assert.equal(await docxToText(makeDocx(body, { noRels: true })), '### Section\n\n## Outline heading\n\nBody', 'falls back to word/document.xml');
  });

  it('writes table rows as column: value lines, with merged cells and without a usable header', async () => {
    const cell = (/** @type {string} */ t, /** @type {string} */ pr = '') => `<w:tc><w:tcPr>${pr}</w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const row = (/** @type {string[]} */ cells) => `<w:tr>${cells.join('')}</w:tr>`;
    const header = row([cell('Task'), cell('Owner'), cell('Due')]);
    const merged = row([cell('Review', ''), cell('Ana Ruiz', '<w:gridSpan w:val="2"/>')]);
    const nested = row([cell('Build'), `<w:tc><w:tbl>${row([cell('Ben'), cell('Chloe')])}</w:tbl></w:tc>`, cell('June')]);
    assert.equal(await docxToText(makeDocx(`<w:tbl>${header}${merged}${nested}</w:tbl>`)), 'Task: Review; Owner: Ana Ruiz\nTask: Build; Owner: Ben | Chloe; Due: June');
    const numeric = row([cell('2026'), cell('2027')]) + row([cell('12'), cell('15')]);
    assert.equal(await docxToText(makeDocx(`<w:tbl>${numeric}</w:tbl>`)), '2026 | 2027\n12 | 15');
  });

  it('refuses what is not a Word document', async () => {
    await assert.rejects(docxToText(fixture('budget.xlsx')), code('invalid_document'));
    await assert.rejects(docxToText(new TextEncoder().encode('plain text, not a package')), code('invalid_document'));
    const xml = makeZip([{ name: 'word/document.xml', data: '<w:document xmlns:w="x"><w:body><w:p>' }]);
    await assert.rejects(docxToText(xml), code('invalid_document'));
    await assert.rejects(docxToText(makeDocx('<w:p><w:r><w:t>'.repeat(300))), code('invalid_document'));
  });

  it('recognises password protected and old binary Office files', async () => {
    const compound = (/** @type {string} */ stream) => {
      const bytes = new Uint8Array(2048);
      bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      [...stream].forEach((ch, i) => (bytes[1024 + i * 2] = ch.charCodeAt(0)));
      return bytes;
    };
    await assert.rejects(docxToText(compound('EncryptionInfo')), code('encrypted_document'));
    await assert.rejects(xlsxToText(compound('EncryptedPackage')), code('unsupported_type'));
    await assert.rejects(pptxToText(compound('WordDocument')), code('unsupported_type'));
  });

  it('stops at the text limit', async () => {
    const body = Array.from({ length: 50 }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i} with some words in it.</w:t></w:r></w:p>`).join('');
    await assert.rejects(docxToText(makeDocx(body), { maxChars: 500 }), code('too_large'));
  });
});

describe('XLSX', () => {
  const LO = 'Budget / A2: Item: Shelves; Cost: 42000; Due: 2027-01-15; Share: 25%\nBudget / A3: Item: Lighting; Cost: 18500.5; Due: 2027-02-01; Share: 12.5%\nBudget / A4: Item: Total; Cost: 60500.5\n\nNotes / A1: Opening\nNotes / B1: 2027-03-03 09:30\nNotes / A3: Contact\nNotes / B3: Ana Ruiz\nNotes / C3: TRUE';

  it('reads workbooks written by two different programs', async () => {
    assert.equal(await xlsxToText(fixture('budget-lo.xlsx')), LO);
    // The other writer stores inline strings and leaves the formula without a cached value.
    assert.equal(await xlsxToText(fixture('budget.xlsx')), LO.replace('Item: Total; Cost: 60500.5', 'Item: Total'));
  });

  it('reads shared strings with rich text runs and without phonetic hints, inline strings, booleans and errors', async () => {
    const strings = '<si><t>Name</t></si><si><t>Note</t></si><si><r><t xml:space="preserve">Ana </t></r><r><rPr><b/></rPr><t>Ruiz</t></r><rPh sb="0" eb="1"><t>RUBY</t></rPh></si>';
    const sheet =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Check</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="str"><f>CONCAT("a","b")</f><v>ab</v></c><c r="C2" t="b"><v>0</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Ben\nOkafor</t></is></c><c r="B3" t="e"><v>#DIV/0!</v></c></row>';
    assert.equal(await xlsxToText(makeXlsx([{ name: 'Team', xml: sheet }], { strings })), 'Team / A2: Name: Ana Ruiz; Note: ab; Check: FALSE\nTeam / A3: Name: Ben Okafor; Note: #DIV/0!');
  });

  it('finds the header below a title row and reads cells without references in order', async () => {
    const sheet =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Quarterly plan</t></is></c></row>' +
      '<row r="3"><c t="inlineStr"><is><t>Step</t></is></c><c t="inlineStr"><is><t>Days</t></is></c></row>' +
      '<row><c><v>1</v></c><c><v>4</v></c></row>' +
      '<row><c r="B5"><v>0.30000000000000004</v></c></row>';
    assert.equal(await xlsxToText(makeXlsx([{ name: 'Plan', xml: sheet }])), 'Plan / A1: Quarterly plan\nPlan / A4: Step: 1; Days: 4\nPlan / A5: Days: 0.3');
  });

  it('reads cell by cell when the header is not usable', async () => {
    const numbers = '<row r="1"><c r="A1"><v>2026</v></c><c r="B1"><v>2027</v></c></row><row r="2"><c r="A2"><v>5</v></c><c r="B2"><v>7</v></c></row>';
    assert.equal(await xlsxToText(makeXlsx([{ name: 'Years', xml: numbers }])), 'Years / A1: 2026\nYears / B1: 2027\nYears / A2: 5\nYears / B2: 7');
    const outside = '<row r="1"><c r="A1" t="inlineStr"><is><t>Key</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="C2"><v>9</v></c></row>';
    assert.equal(await xlsxToText(makeXlsx([{ name: 'S', xml: outside }])), 'S / A1: Key\nS / B1: Value\nS / C2: 9');
  });

  it('shows dates, times and percentages by number format, in both date systems', async () => {
    const styles =
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/><numFmt numFmtId="165" formatCode="[h]:mm"/></numFmts>' +
      '<cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="20"/><xf numFmtId="10"/><xf numFmtId="165"/></cellXfs>';
    const sheet = '<row r="1"><c r="A1" s="1"><v>46402</v></c><c r="B1" s="2"><v>46402.75</v></c><c r="C1" s="3"><v>0.5208333333333334</v></c><c r="D1" s="4"><v>0.0425</v></c><c r="E1" s="5"><v>1.5</v></c><c r="F1" t="d"><v>2027-01-15T00:00:00Z</v></c></row>';
    assert.equal(
      await xlsxToText(makeXlsx([{ name: 'D', xml: sheet }], { styles })),
      'D / A1: 2027-01-15\nD / B1: 2027-01-15\nD / C1: 12:30\nD / D1: 4.25%\nD / E1: 1.5\nD / F1: 2027-01-15',
    );
    assert.equal(await xlsxToText(makeXlsx([{ name: 'D', xml: '<row r="1"><c r="A1" s="1"><v>44940</v></c></row>' }], { styles, date1904: true })), 'D / A1: 2027-01-15');
  });

  it('formats serials, number formats and column names like the spreadsheet does', () => {
    assert.equal(formatSerial(1, 'date', false), '1900-01-01');
    assert.equal(formatSerial(59, 'date', false), '1900-02-28');
    assert.equal(formatSerial(60, 'date', false), '1900-02-29');
    assert.equal(formatSerial(61, 'date', false), '1900-03-01');
    assert.equal(formatSerial(45658.999999, 'datetime', false), '2025-01-02');
    assert.equal(formatSerial(45658.5, 'datetime', false), '2025-01-01 12:00');
    assert.equal(formatSerial(0.000011574, 'time', false), '00:00:01');
    assert.equal(formatSerial(0, 'date', true), '1904-01-01');
    assert.equal(formatSerial(-1, 'date', false), null);
    assert.equal(formatKind('General'), 'number');
    assert.equal(formatKind('yyyy\\-mm\\-dd'), 'date');
    assert.equal(formatKind('mmm yy'), 'date');
    assert.equal(formatKind('h:mm AM/PM'), 'time');
    assert.equal(formatKind('mm:ss'), 'time');
    assert.equal(formatKind('d.m.yyyy h:mm'), 'datetime');
    assert.equal(formatKind('0.00%'), 'percent');
    assert.equal(formatKind('#,##0.00 "days"'), 'number');
    assert.equal(formatKind('[Red][$€-407] #,##0.00'), 'number');
    assert.equal(formatKind('0.00E+00'), 'number');
    assert.equal(formatGeneral(0.1 + 0.2), '0.3');
    assert.equal(formatGeneral(-0), '0');
    assert.equal(formatGeneral(123456789012345680), '123456789012346000');
    assert.deepEqual(['A', 'Z', 'AA', 'AZ', 'XFD'].map(columnIndex), [0, 25, 26, 51, 16383]);
    assert.deepEqual([0, 25, 26, 51, 16383].map(columnName), ['A', 'Z', 'AA', 'AZ', 'XFD']);
  });

  it('refuses a sheet with more text than the limit before building its lines', async () => {
    const sheet = Array.from({ length: 200 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>cell text number ${i}</t></is></c></row>`).join('');
    await assert.rejects(xlsxToText(makeXlsx([{ name: 'Big', xml: sheet }]), { maxChars: 1000 }), code('too_large'));
  });

  it('reads sheets in workbook order and skips chart sheets', async () => {
    const one = '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>';
    const two = '<row r="1"><c r="A1" t="inlineStr"><is><t>second</t></is></c></row>';
    const text = await xlsxToText(makeXlsx([{ name: 'One', xml: one }, { name: 'Chart', xml: '', type: 'chartsheet' }, { name: 'Two', xml: two }]));
    assert.equal(text, 'One / A1: first\n\nTwo / A1: second');
  });
});

describe('PPTX', () => {
  it('reads slides with titles, bullets, a table and speaker notes from a real presentation', async () => {
    assert.equal(
      await pptxToText(fixture('status.pptx')),
      'Slide 1: Harbor Library Renovation\nStatus update, spring 2027\n\nSlide 2: Budget\nApproved: 240,000 EUR\nSpent so far: 61,000 EUR\nLighting tender still open\nNotes: Mention that the lighting tender closes in April.\n\nSlide 3: Phases\nPhase: Design; Start: May 2026\nPhase: Build; Start: September 2026',
    );
  });

  it('follows the presentation order, reads groups and line breaks, and leaves out footer placeholders', async () => {
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(['In a group'])}</p:grpSp>`;
    const broken = '<p:sp><p:nvSpPr><p:cNvPr id="6" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Line one</a:t></a:r><a:br/><a:r><a:t>line two</a:t></a:r><a:fld id="{1}" type="slidenum"><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp>';
    const slides = [
      { file: 'slide9.xml', shapes: shape(['Opening'], 'ctrTitle') + shape(['Welcome']) + shape(['7'], 'sldNum') + shape(['Footer text'], 'ftr') },
      { file: 'slide2.xml', shapes: '<p:pic/>' },
      { file: 'slide1.xml', shapes: shape(['Details'], 'title') + group + broken, notes: shape(['slide image'], 'sldImg') + shape(['First note', 'Second note'], 'body') },
    ];
    assert.equal(await pptxToText(makePptx(slides)), 'Slide 1: Opening\nWelcome\n\nSlide 3: Details\nIn a group\nLine one\nline two‹#›\nNotes: First note\nSecond note');
  });

  it('refuses what is not a presentation', async () => {
    await assert.rejects(pptxToText(fixture('report.docx')), code('invalid_document'));
  });
});

describe('extractText with Office files', () => {
  it('dispatches by extension and records one kind per format', async () => {
    const docx = await extractText(new File([fixture('report.docx')], 'Report.DOCX'));
    assert.equal(docx.kind, 'docx');
    assert.equal(docx.text, REPORT);
    assert.deepEqual([docx.pages, docx.pdfjs], [null, null]);
    assert.equal((await extractText(new File([fixture('budget-lo.xlsx')], 'budget.xlsx'))).kind, 'xlsx');
    assert.equal((await extractText(new File([fixture('status.pptx')], 'status.pptx'))).kind, 'pptx');
  });

  it('reports a package without text as empty and a renamed file as invalid', async () => {
    await assert.rejects(extractText(new File([makeDocx('<w:p/>')], 'blank.docx')), code('empty'));
    await assert.rejects(extractText(new File([fixture('status.pptx')], 'slides.xlsx')), code('invalid_document'));
  });
});

describe('error messages', () => {
  it('has a workspace message in every language for each error the readers raise', () => {
    for (const code of ['invalid_document', 'encrypted_document', 'zip_bomb', 'needs_ocr', 'unsupported_type', 'too_large', 'empty']) {
      for (const locale of LOCALES) assert.ok(hasKey(`workspace.error_${code}`, locale), `${locale}: ${code}`);
    }
  });
});
