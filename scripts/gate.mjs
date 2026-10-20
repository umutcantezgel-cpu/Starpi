#!/usr/bin/env node
// starpi-gate: runs Starpi's sentence gate over a text (a model answer, a generated summary) for
// scripts and CI, and reports which sentences it would release and which it would withhold.
//
// Usage: starpi-gate --text <file|-> [--source <file|dir>]… [--sources <file.json>] [--mode sources|web|free]
//                    [--locale <code>] [--question <text>] [--grounding <file.json>] [--identifiers verbatim|any]
//                    [--format json|sarif] [--output <file>] [--fail-on withheld|never]
//        node scripts/gate.mjs …   (the same code, unbundled)
//
// Sources: --source reads files like the app does (Markdown, text, CSV, logs, JSON, Word, Excel and
// PowerPoint files (DOCX, XLSX, PPTX) and HTML pages; PDF with the optional pdfjs-dist), chunks them
// with the app's chunker and labels the chunks "[Doc: <file name>, Chunk: <n>]" (files that share a
// name are labelled with their path); a directory adds every supported file below it, except hidden
// ones and node_modules. --sources reads a JSON list of { label, text, kind? } as the gate takes
// them. --grounding is the JSON grounding of a web answer:
// { segments: [{ start, end, sources }], sources: [{ uri, title }] }, with UTF-16 offsets into the text.
//
// Exit codes: 0 nothing withheld (or --fail-on never), 1 at least one unit withheld, 2 usage error
// or unreadable input.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pkg from '../packages/core/package.json' with { type: 'json' };
import { checkText, WITHHELD_REASONS } from '../src/js/core/gate.js';
import { sha256Hex } from '../src/js/core/hash.js';
import { citationLabel } from '../src/js/core/labels.js';
import { SARIF_SCHEMA, SARIF_VERSION } from '../src/js/core/sarif.js';
import { chunkText } from '../src/js/rag/chunker.js';
import { extensionOf, extractText, MAX_FILE_BYTES, SUPPORTED_EXTENSIONS } from '../src/js/rag/parser.js';

const USAGE =
  'usage: starpi-gate --text <file|-> [--source <file|dir>]… [--sources <file.json>] [--mode sources|web|free] [--locale <code>] [--question <text>] [--grounding <file.json>] [--identifiers verbatim|any] [--format json|sarif] [--output <file>] [--fail-on withheld|never]';
const INFORMATION_URI = 'https://github.com/umutcantezgel-cpu/Starpi';

/**
 * What each reason means, in English, with the token that broke the rule.
 * @type {Readonly<Record<import('../src/js/core/gate.js').WithheldReason, { name: string, short: string, message: string }>>}
 */
const REASONS = Object.freeze({
  unknown_source: { name: 'UnknownSource', short: 'Cites a label that is not one of the sources', message: '{token} is not one of the sources.' },
  chars: { name: 'Characters', short: 'Character outside the allowlist', message: 'The character {token} is not on the allowlist (another script, a look-alike sign or an invisible mark).' },
  link: { name: 'Link', short: 'Contains a link', message: 'It contains a link: {token}.' },
  joined: { name: 'JoinedNumber', short: 'Digits that read as another number', message: '{token} reads as a different number than the one written.' },
  unsupported_number: { name: 'UnsupportedNumber', short: 'Number not in a cited excerpt', message: '{token} is not in the excerpts this unit cites.' },
  number_word: { name: 'UnsupportedNumberWord', short: 'Number word not in a cited excerpt', message: 'The number word {token} is not in the excerpts this unit cites.' },
  identifier: { name: 'UnsupportedIdentifier', short: 'Identifier not in a cited excerpt or the question', message: 'The identifier {token} is neither in a cited excerpt nor in the question.' },
  web_ungrounded: { name: 'WebUngrounded', short: 'Number outside the grounded web segments', message: '{token} lies outside the parts of the answer grounded in a web source.' },
  spoken_mismatch: { name: 'SpokenMismatch', short: 'Spoken form would change a number', message: 'Writing out its abbreviations and units would change a number.' },
});

/** @param {string} message @returns {never} */
function usage(message) {
  console.error(`starpi-gate: ${message}\n${USAGE}`);
  process.exit(2);
}

/** @param {unknown} err */
const reasonOf = (err) => (err instanceof Error ? err.message : String(err));

/** @type {{ text?: string, source: string[], sources?: string, mode: string, locale?: string, question?: string, grounding?: string, identifiers: string, format: string, output?: string, failOn: string }} */
const opts = { source: [], mode: 'sources', identifiers: 'verbatim', format: 'json', failOn: 'withheld' };
const CHOICES = /** @type {Record<string, string[]>} */ ({ mode: ['sources', 'web', 'free'], identifiers: ['verbatim', 'any'], format: ['json', 'sarif'], failOn: ['withheld', 'never'] });
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (args.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}
for (let i = 0; i < args.length; i += 1) {
  const eq = args[i].indexOf('=');
  const name = eq > 0 ? args[i].slice(0, eq) : args[i];
  const value = () => {
    const v = eq > 0 ? args[i].slice(eq + 1) : args[++i];
    if (v === undefined || v === '') usage(`${name} needs a value`);
    return v;
  };
  if (name === '--text') opts.text = value();
  else if (name === '--source') opts.source.push(value());
  else if (name === '--sources') opts.sources = value();
  else if (name === '--locale') opts.locale = value();
  else if (name === '--question') opts.question = value();
  else if (name === '--grounding') opts.grounding = value();
  else if (name === '--output') opts.output = value();
  else if (name === '--mode' || name === '--identifiers' || name === '--format' || name === '--fail-on') {
    const key = name === '--fail-on' ? 'failOn' : name.slice(2);
    const v = value();
    if (!CHOICES[key].includes(v)) usage(`${name} must be one of ${CHOICES[key].join(', ')}`);
    /** @type {Record<string, unknown>} */ (opts)[key] = v;
  } else usage(`unknown argument ${args[i]}`);
}
if (!opts.text) usage('no --text given');
if (opts.mode === 'sources' && !opts.source.length && !opts.sources) usage('mode sources needs --source or --sources');
if (opts.locale !== undefined && !/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/.test(opts.locale)) usage('--locale must be a language code such as en or de-AT');

/**
 * Every supported file of a path: the file itself, or the files below a directory, sorted.
 * @param {string} p
 * @returns {Promise<string[]>}
 */
async function filesOf(p) {
  let info;
  try {
    info = await stat(p);
  } catch (err) {
    usage(`cannot read ${p}: ${reasonOf(err)}`);
  }
  if (info.isFile()) {
    if (!SUPPORTED_EXTENSIONS.has(extensionOf(p))) usage(`${p}: unsupported file type (supported: ${[...SUPPORTED_EXTENSIONS].join(', ')})`);
    return [p];
  }
  if (!info.isDirectory()) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of (await readdir(p, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = path.join(p, entry.name);
    if (entry.isDirectory()) out.push(...(await filesOf(child)));
    else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extensionOf(entry.name))) out.push(child);
  }
  return out;
}

/**
 * Reads a JSON file given on the command line.
 * @param {string} file
 */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    usage(`cannot read ${file}: ${reasonOf(err)}`);
  }
}

/** The text from a file, or from standard input for "-". */
async function readText(/** @type {string} */ file) {
  try {
    if (file !== '-') return await readFile(file, 'utf8');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    usage(`cannot read ${file}: ${reasonOf(err)}`);
  }
}

const text = (await readText(opts.text)).replace(/\r\n?/g, '\n');
const relative = (/** @type {string} */ f) => path.relative(process.cwd(), f).split(path.sep).join('/') || path.basename(f);

/** @type {import('../src/js/core/gate.js').GateSource[]} */
const sources = [];
if (opts.sources) {
  const list = await readJson(opts.sources);
  if (!Array.isArray(list)) usage(`${opts.sources} must hold a JSON list of { label, text }`);
  for (const s of list) {
    if (!s || typeof s.label !== 'string' || typeof s.text !== 'string') usage(`${opts.sources}: every entry needs a label and a text`);
    sources.push({ label: s.label, text: s.text, ...(typeof s.kind === 'string' ? { kind: s.kind } : {}), index: sources.length });
  }
}
const files = [...new Set((await Promise.all(opts.source.map(filesOf))).flat().map((f) => path.resolve(f)))];
if (opts.source.length && !files.length) usage('the sources contain no supported file');
const baseCount = new Map();
for (const f of files) baseCount.set(path.basename(f), (baseCount.get(path.basename(f)) ?? 0) + 1);
for (const file of files) {
  const doc = (baseCount.get(path.basename(file)) ?? 0) > 1 ? relative(file) : path.basename(file);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (err) {
    usage(`cannot read ${file}: ${reasonOf(err)}`);
  }
  if (bytes.length > MAX_FILE_BYTES) usage(`${relative(file)} is larger than ${MAX_FILE_BYTES} bytes`);
  let extracted;
  try {
    extracted = (await extractText(new File([bytes], path.basename(file)))).text;
  } catch (err) {
    usage(`cannot read ${relative(file)}: ${reasonOf(err)}`);
  }
  for (const chunk of chunkText(extracted)) sources.push({ label: citationLabel(doc, chunk.index + 1), kind: 'doc', text: chunk.text, index: sources.length });
}
const grounding = opts.grounding ? await readJson(opts.grounding) : undefined;

let result;
try {
  result = checkText(text, {
    mode: /** @type {import('../src/js/core/gate.js').GateMode} */ (opts.mode),
    locale: opts.locale ?? null,
    sources,
    ...(opts.question ? { question: opts.question } : {}),
    ...(opts.mode === 'web' ? { grounding: grounding ?? null } : {}),
    identifiers: /** @type {'verbatim' | 'any'} */ (opts.identifiers),
  });
} catch (err) {
  usage(reasonOf(err));
}

const uri = opts.text === '-' ? 'stdin' : relative(path.resolve(opts.text));
/** 1-based column of an offset in the text. */
const columnOf = (/** @type {number} */ offset) => offset - (text.lastIndexOf('\n', offset - 1) + 1) + 1;
const labels = (/** @type {readonly number[]} */ list) => list.map((i) => sources[i]?.label ?? String(i));
/** @param {import('../src/js/core/gate.js').Withheld} w */
const describe = (w) => REASONS[w.reason].message.replace('{token}', w.token);
const failing = opts.failOn === 'never' ? 0 : result.withheld.length;

let out;
if (opts.format === 'sarif') {
  const rules = WITHHELD_REASONS.map((id) => ({
    id,
    name: REASONS[id].name,
    shortDescription: { text: REASONS[id].short },
    help: { text: `${REASONS[id].short}. The sentence gate releases a unit only when every rule holds; a withheld unit is not shown or spoken as checked.` },
    defaultConfiguration: { level: 'error' },
    properties: { tags: ['sentence-gate', 'grounding'] },
  }));
  const results = [];
  for (const w of result.withheld) {
    results.push({
      ruleId: w.reason,
      ruleIndex: WITHHELD_REASONS.indexOf(w.reason),
      level: 'error',
      message: { text: `Withheld: “${w.text.length > 200 ? `${w.text.slice(0, 199)}…` : w.text}” ${describe(w)}` },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: w.line, startColumn: columnOf(w.start) } } }],
      partialFingerprints: { 'starpiGate/v1': await sha256Hex(`${w.reason}\n${w.text}`) },
    });
  }
  const log = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{ tool: { driver: { name: 'starpi-gate', version: pkg.version, semanticVersion: pkg.version, informationUri: INFORMATION_URI, rules } }, columnKind: 'utf16CodeUnits', results }],
  };
  out = `${JSON.stringify(log, null, 2)}\n`;
} else {
  out = `${JSON.stringify(
    {
      ok: failing === 0,
      tool: { name: 'starpi-gate', version: pkg.version },
      text: uri,
      mode: opts.mode,
      locale: opts.locale ?? null,
      sources: sources.length,
      counts: result.counts,
      released: result.released.map((r) => ({ line: r.line, column: columnOf(r.start), kind: r.kind, text: r.text, spoken: r.spoken, cites: labels(r.cites), numbers: r.numbers })),
      withheld: result.withheld.map((w) => ({ line: w.line, column: columnOf(w.start), kind: w.kind, text: w.text, reason: w.reason, token: w.token, message: describe(w) })),
    },
    null,
    2,
  )}\n`;
}

if (opts.output) {
  try {
    await writeFile(opts.output, out);
  } catch (err) {
    usage(`cannot write ${opts.output}: ${reasonOf(err)}`);
  }
} else process.stdout.write(out);
// exitCode, not exit(): a large report written to a pipe must be flushed first.
process.exitCode = failing ? 1 : 0;
