#!/usr/bin/env node
// Verifies a Starpi answer receipt against the original files, outside the browser.
//
// Usage: node scripts/verify-receipt.mjs <receipt.json> [file ...] [--public-key <key>] [--json]
//        npm run verify:receipt -- <receipt.json> [file ...]
//        npx -p @starpi/core starpi-verify-receipt <receipt.json> [file ...]   (the same code, packaged)
//
// For every excerpt from the on-device workspace it checks, with the same extraction and chunking
// code the app uses: that one of the files has the recorded SHA-256 fingerprint, that extracting it
// gives the recorded text, that the passage at the recorded offsets is the cited excerpt, and that
// chunking reproduces the recorded chunk. It then recomputes the source check. Files are matched by
// fingerprint, not by name. For a v2 receipt it also recomputes the Merkle root, checks every
// inclusion proof and, if the receipt is signed, the signature: against the public key given with
// --public-key (a JWK or a PEM file), or else against the key embedded in the receipt.
//
// Exit codes: 0 every workspace excerpt was reproduced (and the tree and any signature are valid),
// 1 something did not match, a file is missing, or the receipt is not signed by the given key,
// 2 usage error or not a valid receipt.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RECEIPT_LIMITS, validateReceipt, verifyReceipt } from '../src/js/core/receipt.js';
import { importPublicKey } from '../src/js/core/signature.js';
import { EXTRACTOR, extractText } from '../src/js/rag/parser.js';

/** @param {string} message */
function usage(message) {
  console.error(`verify-receipt: ${message}\nusage: verify-receipt <receipt.json> [file ...] [--public-key <key.jwk|key.pem>] [--json]`);
  process.exit(2);
}

let asJson = false;
/** @type {string | undefined} */
let keyPath;
/** @type {string[]} */
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') asJson = true;
  else if (arg === '--public-key') {
    keyPath = args[++i];
    if (keyPath === undefined) usage('--public-key needs a file');
  } else if (arg.startsWith('--public-key=')) keyPath = arg.slice('--public-key='.length);
  else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
  else positional.push(arg);
}
const [receiptPath, ...filePaths] = positional;

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

/** @type {CryptoKey | undefined} */
let publicKey;
if (keyPath !== undefined) {
  try {
    publicKey = await importPublicKey(await readFile(keyPath, 'utf8'));
  } catch (err) {
    usage(`cannot use ${keyPath} as a public key: ${err instanceof Error ? err.message : err}`);
  }
}

const files = [];
for (const p of filePaths) {
  try {
    files.push({ name: path.basename(p), bytes: new Uint8Array(await readFile(p)) });
  } catch (err) {
    usage(`cannot read ${p}: ${err instanceof Error ? err.message : err}`);
  }
}

const report = await verifyReceipt(
  valid.receipt,
  files,
  {
    extractor: EXTRACTOR,
    extract: async (bytes, name) => {
      const r = await extractText(new File([bytes], name));
      return { text: r.text, pdfjs: r.pdfjs };
    },
  },
  { publicKey },
);

const workspace = report.citations.filter((c) => c.source === 'workspace');
const signature = report.signature;
const failed =
  !report.idMatches ||
  !report.answerMatches ||
  workspace.some((c) => c.file !== 'match' || c.passage !== 'match') ||
  report.citations.some((c) => c.excerptConsistent === false) ||
  (report.merkle !== null && (!report.merkle.rootMatches || report.merkle.validProofs !== report.citations.length)) ||
  (signature !== null && signature.status !== 'valid' && signature.status !== 'unsigned') ||
  // A key was given to check who signed: anything but a valid signature by that key fails.
  (publicKey !== undefined && !signature?.trusted);

if (asJson) {
  console.log(JSON.stringify({ ok: !failed, receipt: valid.receipt.id, ...report }, null, 2));
} else {
  const mark = (/** @type {boolean} */ ok) => (ok ? 'ok  ' : 'FAIL');
  // Strings from the receipt are untrusted: control and bidirectional characters are shown escaped,
  // so a crafted receipt cannot rewrite or hide lines of this report in a terminal.
  const safe = (/** @type {unknown} */ s) =>
    // eslint-disable-next-line no-control-regex -- matching control characters is the point here
    String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  console.log(`receipt ${valid.receipt.id.slice(0, 16)}… (${safe(valid.receipt.createdAt)}, ${safe(valid.receipt.answer.engine)})`);
  console.log(`${mark(report.idMatches)} receipt hash matches its contents`);
  console.log(`${mark(report.answerMatches)} answer hash matches the answer text`);
  if (report.merkle) {
    const m = report.merkle;
    console.log(`${mark(m.rootMatches && m.validProofs === report.citations.length)} Merkle root over ${m.size} citation${m.size === 1 ? '' : 's'} ${m.rootMatches ? 'matches' : 'does not match'}, ${m.validProofs}/${report.citations.length} inclusion proofs valid`);
  }
  if (signature) {
    const key = signature.keyId ? `key ${signature.keyId.slice(0, 16)}…` : '';
    if (signature.status === 'unsigned') console.log(`${publicKey ? 'FAIL' : 'n/a '} not signed${publicKey ? ', but a public key was given' : ''}`);
    else if (signature.status === 'valid' && signature.trusted) console.log(`ok   signature valid (${signature.alg}, ${key}, the public key you gave)`);
    else if (signature.status === 'valid') console.log(`ok   signature valid for the key in the receipt (${signature.alg}, ${key}); give --public-key to check who signed it`);
    else if (signature.status === 'key_mismatch') console.log(`FAIL signed with ${key}, not with the public key you gave`);
    else if (signature.status === 'unsupported_algorithm') console.log(`FAIL cannot check a ${safe(signature.alg ?? 'signature')} signature in this runtime`);
    else console.log(`FAIL signature invalid (${signature.alg}, ${key}): the receipt was changed after signing, or the signature is forged`);
  } else console.log('n/a  receipt format v1: no Merkle tree, not signed');
  for (const c of report.citations) {
    if (c.source === 'knowledge') {
      console.log(`${c.proof === false ? 'FAIL' : 'n/a '} ${safe(c.label)}: knowledge-base excerpt, not independently verifiable${c.excerptConsistent === false ? ' (excerpt does not match its fingerprint)' : ''}${c.proof === false ? ', inclusion proof invalid' : ''}`);
      continue;
    }
    const detail = [`file ${c.file}${c.fileName ? ` (${safe(c.fileName)})` : ''}`, c.text && `text ${c.text}`, c.passage && `passage ${c.passage}`, c.chunk && `chunk ${c.chunk}`, c.proof === false && 'inclusion proof invalid'].filter(Boolean).join(', ');
    console.log(`${mark(c.file === 'match' && c.passage === 'match' && c.proof !== false)} ${safe(c.label)}: ${detail}`);
  }
  console.log(`\n${report.summary.reproduced}/${report.summary.verifiable} workspace excerpts reproduced from the given files`);
  if (report.grounding) {
    const g = report.grounding;
    console.log(`source check recomputed for ${g.recomputed} statements: ${g.differences.length ? `${g.differences.length} differ from the receipt` : 'same verdicts as recorded'}`);
    for (const d of g.differences) console.log(`     statement ${d.sentence + 1}: recorded ${d.recorded}, now ${d.now}`);
    if (g.needsConversation) console.log('     note: some verdicts depend on earlier chat turns, which receipts do not contain');
  }
  for (const w of report.warnings) console.log(`warn ${safe(w)}`);
}
process.exit(failed ? 1 : 0);
