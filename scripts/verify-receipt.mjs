#!/usr/bin/env node
// Verifies a Starpi answer receipt against the original files, outside the browser.
//
// Usage: node scripts/verify-receipt.mjs <receipt.json> [file ...] [--json]
//        npm run verify:receipt -- <receipt.json> [file ...]
//
// For every excerpt from the on-device workspace it checks, with the same extraction and chunking
// code the app uses: that one of the files has the recorded SHA-256 fingerprint, that extracting it
// gives the recorded text, that the passage at the recorded offsets is the cited excerpt, and that
// chunking reproduces the recorded chunk. It then recomputes the source check. Files are matched by
// fingerprint, not by name.
//
// Exit codes: 0 every workspace excerpt was reproduced, 1 something did not match or a file is
// missing, 2 usage error or not a valid receipt.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RECEIPT_LIMITS, validateReceipt, verifyReceipt } from '../src/js/core/receipt.js';
import { EXTRACTOR, extractText } from '../src/js/rag/parser.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const [receiptPath, ...filePaths] = args.filter((a) => a !== '--json');

/** @param {string} message */
function usage(message) {
  console.error(`verify-receipt: ${message}\nusage: node scripts/verify-receipt.mjs <receipt.json> [file ...] [--json]`);
  process.exit(2);
}

if (!receiptPath) usage('no receipt given');
let raw;
try {
  raw = await readFile(receiptPath);
} catch (err) {
  usage(`cannot read ${receiptPath}: ${err instanceof Error ? err.message : err}`);
}
if (raw.length > RECEIPT_LIMITS.bytes) usage(`${receiptPath} is larger than ${RECEIPT_LIMITS.bytes} bytes`);
let parsed;
try {
  parsed = JSON.parse(raw.toString('utf8'));
} catch {
  usage(`${receiptPath} is not JSON`);
}
const valid = validateReceipt(parsed);
if (!valid.ok) usage(`${receiptPath} is not a valid Starpi receipt (${valid.error}${valid.path ? ` at ${valid.path}` : ''})`);

const files = [];
for (const p of filePaths) {
  try {
    files.push({ name: path.basename(p), bytes: new Uint8Array(await readFile(p)) });
  } catch (err) {
    usage(`cannot read ${p}: ${err instanceof Error ? err.message : err}`);
  }
}

const report = await verifyReceipt(valid.receipt, files, {
  extractor: EXTRACTOR,
  extract: async (bytes, name) => {
    const r = await extractText(new File([bytes], name));
    return { text: r.text, pdfjs: r.pdfjs };
  },
});

const workspace = report.citations.filter((c) => c.source === 'workspace');
const failed =
  !report.idMatches ||
  !report.answerMatches ||
  workspace.some((c) => c.file !== 'match' || c.passage !== 'match') ||
  report.citations.some((c) => c.excerptConsistent === false);

if (asJson) {
  console.log(JSON.stringify({ ok: !failed, receipt: valid.receipt.id, ...report }, null, 2));
} else {
  const mark = (/** @type {boolean} */ ok) => (ok ? 'ok  ' : 'FAIL');
  console.log(`receipt ${valid.receipt.id.slice(0, 16)}… (${valid.receipt.createdAt}, ${valid.receipt.answer.engine})`);
  console.log(`${mark(report.idMatches)} receipt hash matches its contents`);
  console.log(`${mark(report.answerMatches)} answer hash matches the answer text`);
  for (const c of report.citations) {
    if (c.source === 'knowledge') {
      console.log(`n/a  ${c.label}: knowledge-base excerpt, not independently verifiable${c.excerptConsistent === false ? ' (excerpt does not match its fingerprint)' : ''}`);
      continue;
    }
    const detail = [`file ${c.file}${c.fileName ? ` (${c.fileName})` : ''}`, c.text && `text ${c.text}`, c.passage && `passage ${c.passage}`, c.chunk && `chunk ${c.chunk}`].filter(Boolean).join(', ');
    console.log(`${mark(c.file === 'match' && c.passage === 'match')} ${c.label}: ${detail}`);
  }
  console.log(`\n${report.summary.reproduced}/${report.summary.verifiable} workspace excerpts reproduced from the given files`);
  if (report.grounding) {
    const g = report.grounding;
    console.log(`source check recomputed for ${g.recomputed} statements: ${g.differences.length ? `${g.differences.length} differ from the receipt` : 'same verdicts as recorded'}`);
    for (const d of g.differences) console.log(`     statement ${d.sentence + 1}: recorded ${d.recorded}, now ${d.now}`);
    if (g.needsConversation) console.log('     note: some verdicts depend on earlier chat turns, which receipts do not contain');
  }
  for (const w of report.warnings) console.log(`warn ${w}`);
}
process.exit(failed ? 1 : 0);
