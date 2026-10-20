#!/usr/bin/env node
// starpi-ground: checks a Markdown document (an answer, release notes, generated documentation)
// against source files with Starpi's source check, for scripts and CI.
//
// Usage: starpi-ground --answer <file.md> --source <file|dir> [--source …] [--format text|json|sarif]
//                      [--output <file>] [--fail-on unsupported|weak|never] [--cite auto|labels|all]
//                      [--grounding 1|2|3]
//        node scripts/ground.mjs …   (the same code, unbundled)
//
// Sources are read like the app reads them (Markdown, text, CSV, logs, JSON, Word, Excel and
// PowerPoint files (DOCX, XLSX, PPTX) and HTML pages; PDF when the optional pdfjs-dist is installed),
// chunked with the app's chunker and labelled "[Doc: <file name>, Chunk: <n>]"; files that share a
// name are labelled with their path instead. A directory adds every supported file below it, except
// hidden ones and node_modules. With --cite labels the document's citation labels decide which
// excerpts a statement is compared with; with --cite all every statement is compared with every
// excerpt; auto (the default) uses labels when the document has any.
// --grounding runs an earlier version of the source-check rules (default: the current one, which
// also checks relations between values and events); the output of a version is the same as the
// output of the release that introduced it.
//
// Exit codes: 0 no statement at or above the --fail-on level (default unsupported), 1 findings at or
// above it (a part too long to check counts as unsupported), 2 usage error or unreadable input.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pkg from '../packages/core/package.json' with { type: 'json' };
import { checkDocument } from '../src/js/core/document.js';
import { GROUNDING, GROUNDING_VERSIONS } from '../src/js/core/grounding.js';
import { citationLabel } from '../src/js/core/labels.js';
import { describeReason, toSarif } from '../src/js/core/sarif.js';
import { chunkText } from '../src/js/rag/chunker.js';
import { extensionOf, extractText, MAX_FILE_BYTES, SUPPORTED_EXTENSIONS } from '../src/js/rag/parser.js';

const USAGE = `usage: starpi-ground --answer <file.md> --source <file|dir> [--source …] [--format text|json|sarif] [--output <file>] [--fail-on unsupported|weak|never] [--cite auto|labels|all] [--grounding ${GROUNDING_VERSIONS.join('|')}]`;
const INFORMATION_URI = 'https://github.com/umutcantezgel-cpu/Starpi';

/** @param {string} message @returns {never} */
function usage(message) {
  console.error(`starpi-ground: ${message}\n${USAGE}`);
  process.exit(2);
}

/** @type {{ answer?: string, sources: string[], format: string, output?: string, failOn: string, cite: string, grounding: number }} */
const opts = { sources: [], format: 'text', failOn: 'unsupported', cite: 'auto', grounding: GROUNDING.version };
const CHOICES = /** @type {Record<string, string[]>} */ ({ format: ['text', 'json', 'sarif'], failOn: ['unsupported', 'weak', 'never'], cite: ['auto', 'labels', 'all'] });
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
  if (name === '--answer') opts.answer = value();
  else if (name === '--source') opts.sources.push(value());
  else if (name === '--output') opts.output = value();
  else if (name === '--grounding') {
    const v = Number(value());
    if (!GROUNDING_VERSIONS.includes(v)) usage(`--grounding must be one of ${GROUNDING_VERSIONS.join(', ')}`);
    opts.grounding = v;
  }
  else if (name === '--format' || name === '--fail-on' || name === '--cite') {
    const key = name === '--fail-on' ? 'failOn' : name.slice(2);
    const v = value();
    if (!CHOICES[key].includes(v)) usage(`${name} must be one of ${CHOICES[key].join(', ')}`);
    /** @type {Record<string, unknown>} */ (opts)[key] = v;
  } else usage(`unknown argument ${args[i]}`);
}
if (!opts.answer) usage('no --answer given');
if (!opts.sources.length) usage('no --source given');

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
    usage(`cannot read ${p}: ${err instanceof Error ? err.message : err}`);
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

const answerPath = opts.answer;
let markdown;
try {
  markdown = (await readFile(answerPath, 'utf8')).replace(/\r\n?/g, '\n');
} catch (err) {
  usage(`cannot read ${answerPath}: ${err instanceof Error ? err.message : err}`);
}

const files = [...new Set((await Promise.all(opts.sources.map(filesOf))).flat().map((f) => path.resolve(f)))];
if (!files.length) usage('the sources contain no supported file');
const relative = (/** @type {string} */ f) => path.relative(process.cwd(), f).split(path.sep).join('/') || path.basename(f);
const baseCount = new Map();
for (const f of files) baseCount.set(path.basename(f), (baseCount.get(path.basename(f)) ?? 0) + 1);

/** @type {import('../src/js/core/grounding.js').GroundingSource[]} */
const sources = [];
/** @type {Array<{ file: string, doc: string, chunks: number }>} */
const read = [];
for (const file of files) {
  const doc = (baseCount.get(path.basename(file)) ?? 0) > 1 ? relative(file) : path.basename(file);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (err) {
    usage(`cannot read ${file}: ${err instanceof Error ? err.message : err}`);
  }
  if (bytes.length > MAX_FILE_BYTES) usage(`${relative(file)} is larger than ${MAX_FILE_BYTES} bytes`);
  let text;
  try {
    ({ text } = await extractText(new File([bytes], path.basename(file))));
  } catch (err) {
    usage(`cannot read ${relative(file)}: ${err instanceof Error ? err.message : err}`);
  }
  const chunks = chunkText(text);
  for (const chunk of chunks) sources.push({ label: citationLabel(doc, chunk.index + 1), doc, heading: '', text: chunk.text, delivered: 'full' });
  read.push({ file: relative(file), doc, chunks: chunks.length });
}

const report = checkDocument(markdown, sources, { cite: /** @type {'auto' | 'labels' | 'all'} */ (opts.cite), version: opts.grounding });
const uri = relative(path.resolve(answerPath));
const failing = opts.failOn === 'never' ? 0 : report.skipped.length + report.statements.filter((s) => s.verdict === 'unsupported' || (opts.failOn === 'weak' && s.verdict === 'weak')).length;

/** @param {number[] | undefined} list */
const labels = (list) => (list ?? []).map((i) => sources[i]?.label ?? String(i));

let out;
if (opts.format === 'sarif') {
  out = `${JSON.stringify(await toSarif([{ uri, report, sources }], { name: 'starpi-ground', version: pkg.version, informationUri: INFORMATION_URI }), null, 2)}\n`;
} else if (opts.format === 'json') {
  out = `${JSON.stringify(
    {
      ok: failing === 0,
      tool: { name: 'starpi-ground', version: pkg.version },
      answer: uri,
      mode: report.mode,
      algorithm: report.algorithm,
      sources: read,
      sections: report.sections,
      counts: report.counts,
      skipped: report.skipped,
      statements: report.statements.map((s) => ({
        line: s.line,
        column: s.column,
        text: s.text,
        verdict: s.verdict,
        citeSource: s.citeSource,
        cites: labels(s.cites),
        reasons: s.reasons.map((r) => ({ ...r, cites: r.cites && labels(r.cites), other: r.other && labels(r.other), message: describeReason(r, sources) })),
      })),
      // Version 3: the relations compared, by statement index (supported ones included).
      ...(report.relations ? { relations: report.relations.map((r) => ({ ...r, cites: labels(r.cites) })) } : {}),
    },
    null,
    2,
  )}\n`;
} else {
  // Text from the document and the sources is untrusted: control and bidirectional characters are
  // shown escaped, so a crafted file cannot rewrite or hide lines of this report in a terminal.
  const safe = (/** @type {unknown} */ s) =>
    // eslint-disable-next-line no-control-regex -- matching control characters is the point here
    String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const lines = [];
  for (const s of report.statements) {
    if (s.verdict !== 'unsupported' && s.verdict !== 'weak') continue;
    lines.push(`${safe(uri)}:${s.line}:${s.column} ${s.verdict} “${safe(s.text.length > 200 ? `${s.text.slice(0, 199)}…` : s.text)}”`);
    for (const r of s.reasons) lines.push(`    ${safe(describeReason(r, sources))}`);
  }
  for (const part of report.skipped) lines.push(`${safe(uri)}:${part.line} not checked: lines ${part.line} to ${part.endLine} are longer than the source check accepts`);
  const c = report.counts;
  const total = c.supported + c.weak + c.unsupported + c.unchecked;
  const n = (/** @type {number} */ count, /** @type {string} */ word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  lines.push(
    `${lines.length ? '\n' : ''}${n(total, 'statement')} checked against ${n(sources.length, 'excerpt')} from ${n(read.length, 'file')} (citations: ${report.mode}): ${c.supported} supported, ${c.weak} weak, ${c.unsupported} unsupported, ${c.unchecked} unchecked${report.skipped.length ? `, ${n(report.skipped.length, 'part')} not checked` : ''}`,
  );
  if (report.crossLanguage) lines.push('note: some statements are in another language than their excerpts and were compared by their values only');
  out = `${lines.join('\n')}\n`;
}

if (opts.output) {
  try {
    await writeFile(opts.output, out);
  } catch (err) {
    usage(`cannot write ${opts.output}: ${err instanceof Error ? err.message : err}`);
  }
} else process.stdout.write(out);
// exitCode, not exit(): a large report written to a pipe must be flushed first.
process.exitCode = failing ? 1 : 0;
