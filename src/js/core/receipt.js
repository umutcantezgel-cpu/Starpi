// @ts-check
// Answer receipts (schema "starpi.receipt/v1"): a JSON file per answer that lists the excerpts the
// answer cited, with SHA-256 fingerprints of the source files, the exact character offsets of each
// passage, the source-check verdicts, and a hash over all of it. Anyone who has the same files can
// reproduce every passage (verifyReceipt below, in the app or with scripts/verify-receipt.mjs).
//
// What a receipt proves: each workspace excerpt is an exact, unchanged passage of the file with the
// recorded fingerprint, at the recorded position, under the recorded extraction rules. What it does
// not prove: that Starpi wrote the answer (receipts are not signed), which excerpts the model read,
// that the answer is correct, or anything about knowledge-base excerpts. See docs/spec/receipts.md.
//
// Pure: WebCrypto (crypto.subtle) only, so it runs in the browser, in workers and in Node 20+.
import { chunkText, CHUNKER } from '../rag/chunker.js';
import { guessLanguage, indexSource } from './facts.js';
import { checkSentence, GROUNDING, THRESHOLDS } from './grounding.js';

export const RECEIPT_SCHEMA = 'starpi.receipt/v1';

export const RECEIPT_LIMITS = Object.freeze({
  bytes: 2_000_000,
  citations: 64,
  sentences: 500,
  reasons: 20,
  sentenceChars: THRESHOLDS.maxChars,
  nameChars: 600,
  answerChars: 200_000,
  questionChars: 10_000,
  excerptChars: 20_000,
  textChars: 1_000,
});

/**
 * @typedef {object} ReceiptDocument
 * @property {string} name
 * @property {string} kind              file type as read: pdf, md, txt, csv, json, log
 * @property {number} bytes
 * @property {string | null} fileSha256  SHA-256 of the file bytes (null without WebCrypto)
 * @property {string} textSha256        SHA-256 of the extracted, normalized text (UTF-8)
 * @property {number} textChars         length of that text in UTF-16 code units
 * @property {number | null} pages
 * @property {{ id: string, version: number, pdfjs: string | null }} extractor
 * @property {{ id: string, version: number, size: number, overlap: number }} chunker
 */

/**
 * @typedef {object} ReceiptCitation
 * @property {string} label
 * @property {string} doc       document name as used in the label
 * @property {string} heading
 * @property {'workspace' | 'knowledge'} source
 * @property {'full' | 'partial' | 'omitted'} delivered  how much of the excerpt reached the model
 * @property {number} [deliveredChars]  for a partly delivered excerpt: how many of its first characters reached the model
 * @property {{ text: string | null, sha256: string, truncated: boolean }} excerpt
 * @property {boolean} verifiable  a workspace excerpt with a file fingerprint
 * @property {ReceiptDocument} [document]
 * @property {{ index: number, start: number, end: number, sha256: string | null }} [chunk]  offsets in UTF-16 code units
 * @property {{ documentId: string | null }} [knowledge]
 */

/**
 * @typedef {object} ReceiptSentence
 * @property {string} text
 * @property {number[]} cites
 * @property {'own' | 'block' | 'leadin' | 'answer' | null} citeSource
 * @property {string} verdict
 * @property {Array<{ code: string, level: string, fact?: string, cites?: number[], other?: number[], found?: string }>} reasons
 */

/**
 * @typedef {object} Receipt
 * @property {string} schema
 * @property {string} id  SHA-256 of the canonical JSON of the receipt without `id`
 * @property {string} createdAt  device clock, ISO 8601
 * @property {{ name: string, version: string }} generator
 * @property {{ text: string, sha256: string, engine: string, locale: string }} answer
 * @property {{ text: string } | null} question
 * @property {ReceiptCitation[]} citations
 * @property {{ algorithm: { id: string, version: number }, counts: Record<string, number>, sentences: ReceiptSentence[] } | null} grounding
 */

/**
 * @typedef {object} ReceiptDraft
 * @property {string} createdAt
 * @property {string} version  app version
 * @property {{ text: string, engine: string, locale: string }} answer
 * @property {string} question
 * @property {Array<{ label: string, doc: string, heading: string, source: 'workspace' | 'knowledge', delivered: 'full' | 'partial' | 'omitted', deliveredChars?: number, text: string, truncated: boolean, document?: ReceiptDocument, chunk?: { index: number, start: number, end: number }, documentId?: string | null }>} citations
 * @property {import('./grounding.js').GroundingReport | null} grounding
 */

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * SHA-256 as lowercase hex. Strings are hashed as UTF-8.
 * @param {string | ArrayBuffer | Uint8Array} data
 */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', /** @type {Uint8Array<ArrayBuffer>} */ (bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace, `undefined` members
 * dropped. For values made of strings, integers, booleans, null, arrays and objects this equals
 * RFC 8785 (JCS).
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const obj = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * @param {Omit<Receipt, 'id'>} body
 */
async function receiptId(body) {
  return sha256Hex(canonicalJson(body));
}

/** Reasons whose `found` quotes the excerpt: a passage, or the value the excerpt states. */
const FOUND_FROM_EXCERPT = new Set(['fact_context', 'approximate', 'fact_elsewhere']);

/**
 * A copy of a reason; without excerpts, also without the excerpt text it may quote.
 * @param {import('./grounding.js').Reason} reason
 * @param {boolean} includeExcerpts
 */
function withoutExcerpt(reason, includeExcerpts) {
  const copy = { ...reason };
  if (!includeExcerpts && FOUND_FROM_EXCERPT.has(copy.code)) delete copy.found;
  return copy;
}

/**
 * Builds a receipt for one answer.
 * @param {ReceiptDraft} draft
 * @param {{ includeQuestion?: boolean, includeExcerpts?: boolean }} [options]
 * @returns {Promise<Receipt>}
 */
export async function buildReceipt(draft, options = {}) {
  const includeQuestion = options.includeQuestion ?? true;
  const includeExcerpts = options.includeExcerpts ?? true;
  /** @type {ReceiptCitation[]} */
  const citations = [];
  for (const c of draft.citations) {
    const sha = await sha256Hex(c.text);
    /** @type {ReceiptCitation} */
    const entry = {
      label: c.label,
      doc: c.doc,
      heading: c.heading,
      source: c.source,
      delivered: c.delivered,
      excerpt: { text: includeExcerpts ? c.text : null, sha256: sha, truncated: c.truncated },
      verifiable: c.source === 'workspace' && Boolean(c.document?.fileSha256) && Boolean(c.chunk),
    };
    // The source check of a model answer ran on the part of a cut excerpt that reached the model;
    // its length lets a verifier recompute on exactly that part.
    if (c.delivered === 'partial' && Number.isInteger(c.deliveredChars)) entry.deliveredChars = c.deliveredChars;
    if (c.document) entry.document = c.document;
    if (c.chunk) entry.chunk = { ...c.chunk, sha256: c.truncated ? null : sha };
    if (c.source === 'knowledge') entry.knowledge = { documentId: c.documentId ?? null };
    citations.push(entry);
  }
  const grounding = draft.grounding
    ? {
        algorithm: { ...draft.grounding.algorithm },
        counts: { ...draft.grounding.counts },
        sentences: draft.grounding.sentences
          .filter((s) => s.verdict !== 'neutral')
          .map((s) => ({
            text: s.text,
            cites: s.cites.slice(),
            citeSource: s.citeSource,
            verdict: s.verdict,
            // Verification compares verdicts, which the first reasons already decide.
            reasons: s.reasons.slice(0, RECEIPT_LIMITS.reasons).map((r) => withoutExcerpt(r, includeExcerpts)),
          })),
      }
    : null;
  /** @type {Omit<Receipt, 'id'>} */
  const body = {
    schema: RECEIPT_SCHEMA,
    createdAt: draft.createdAt,
    generator: { name: 'starpi', version: draft.version },
    answer: { text: draft.answer.text, sha256: await sha256Hex(draft.answer.text), engine: draft.answer.engine, locale: draft.answer.locale },
    question: includeQuestion ? { text: draft.question } : null,
    citations,
    grounding,
  };
  const id = await receiptId(body);
  const { schema, ...rest } = body;
  return { schema, id, ...rest };
}

/**
 * Checks that a parsed JSON value is a well-formed v1 receipt within the size limits. Every string
 * that is later shown in the app is bounded; nothing is interpreted as HTML.
 * @param {unknown} value
 * @returns {{ ok: true, receipt: Receipt } | { ok: false, error: string, path: string }}
 */
export function validateReceipt(value) {
  /** @type {{ error: string, path: string } | null} */
  let failure = null;
  const fail = (/** @type {string} */ path, /** @type {string} */ error) => {
    failure ??= { error, path };
    return false;
  };
  const isObj = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  /**
   * @param {unknown} v
   * @param {string} path
   * @param {number} [max]
   */
  const str = (v, path, max = RECEIPT_LIMITS.textChars) => (typeof v === 'string' && v.length <= max) || fail(path, 'string');
  /**
   * @param {unknown} v
   * @param {string} path
   * @param {number} [max]
   */
  const optStr = (v, path, max = RECEIPT_LIMITS.textChars) => v === null || str(v, path, max);
  /**
   * @param {unknown} v
   * @param {string} path
   * @param {number} [min]
   */
  const int = (v, path, min = 0) => (Number.isInteger(v) && /** @type {number} */ (v) >= min) || fail(path, 'integer');
  const hex = (/** @type {unknown} */ v, /** @type {string} */ path) => (typeof v === 'string' && HEX64.test(v)) || fail(path, 'sha256');
  const oneOf = (/** @type {unknown} */ v, /** @type {string} */ path, /** @type {Array<string | null>} */ list) =>
    list.includes(/** @type {string | null} */ (v)) || fail(path, `one of ${list.join('|')}`);

  if (!isObj(value)) return { ok: false, error: 'not_a_receipt', path: '' };
  const r = /** @type {Record<string, any>} */ (value);
  if (r.schema !== RECEIPT_SCHEMA) {
    return typeof r.schema === 'string' && r.schema.startsWith('starpi.receipt/')
      ? { ok: false, error: 'unsupported_version', path: 'schema' }
      : { ok: false, error: 'not_a_receipt', path: 'schema' };
  }
  hex(r.id, 'id');
  str(r.createdAt, 'createdAt', 64);
  if (!isObj(r.generator)) fail('generator', 'object');
  else str(r.generator.name, 'generator.name', 40) && str(r.generator.version, 'generator.version', 40);
  if (!isObj(r.answer)) fail('answer', 'object');
  else {
    str(r.answer.text, 'answer.text', RECEIPT_LIMITS.answerChars);
    hex(r.answer.sha256, 'answer.sha256');
    str(r.answer.engine, 'answer.engine', 40);
    str(r.answer.locale, 'answer.locale', 10);
  }
  if (r.question !== null && !(isObj(r.question) && str(r.question.text, 'question.text', RECEIPT_LIMITS.questionChars))) fail('question', 'object');
  if (!Array.isArray(r.citations) || r.citations.length > RECEIPT_LIMITS.citations) fail('citations', 'array');
  else {
    r.citations.forEach((c, i) => {
      const p = `citations[${i}]`;
      if (!isObj(c)) return fail(p, 'object');
      str(c.label, `${p}.label`, RECEIPT_LIMITS.nameChars);
      str(c.doc, `${p}.doc`, RECEIPT_LIMITS.nameChars);
      str(c.heading, `${p}.heading`, 1000);
      oneOf(c.source, `${p}.source`, ['workspace', 'knowledge']);
      oneOf(c.delivered, `${p}.delivered`, ['full', 'partial', 'omitted']);
      if (c.deliveredChars !== undefined) {
        if (c.delivered !== 'partial') fail(`${p}.deliveredChars`, 'only for a partly delivered excerpt');
        else if (int(c.deliveredChars, `${p}.deliveredChars`) && c.deliveredChars > RECEIPT_LIMITS.excerptChars) fail(`${p}.deliveredChars`, 'integer');
      }
      if (typeof c.verifiable !== 'boolean') fail(`${p}.verifiable`, 'boolean');
      if (!isObj(c.excerpt)) fail(`${p}.excerpt`, 'object');
      else {
        optStr(c.excerpt.text, `${p}.excerpt.text`, RECEIPT_LIMITS.excerptChars);
        hex(c.excerpt.sha256, `${p}.excerpt.sha256`);
        if (typeof c.excerpt.truncated !== 'boolean') fail(`${p}.excerpt.truncated`, 'boolean');
      }
      if (c.document !== undefined) {
        const d = c.document;
        if (!isObj(d)) return fail(`${p}.document`, 'object');
        str(d.name, `${p}.document.name`, RECEIPT_LIMITS.nameChars);
        str(d.kind, `${p}.document.kind`, 20);
        int(d.bytes, `${p}.document.bytes`);
        if (d.fileSha256 !== null) hex(d.fileSha256, `${p}.document.fileSha256`);
        hex(d.textSha256, `${p}.document.textSha256`);
        int(d.textChars, `${p}.document.textChars`);
        if (d.pages !== null) int(d.pages, `${p}.document.pages`);
        if (!isObj(d.extractor)) fail(`${p}.document.extractor`, 'object');
        else str(d.extractor.id, `${p}.document.extractor.id`, 40) && int(d.extractor.version, `${p}.document.extractor.version`) && optStr(d.extractor.pdfjs, `${p}.document.extractor.pdfjs`, 40);
        if (!isObj(d.chunker)) fail(`${p}.document.chunker`, 'object');
        else {
          str(d.chunker.id, `${p}.document.chunker.id`, 40);
          int(d.chunker.version, `${p}.document.chunker.version`);
          int(d.chunker.size, `${p}.document.chunker.size`, 1);
          int(d.chunker.overlap, `${p}.document.chunker.overlap`);
        }
      }
      if (c.chunk !== undefined) {
        const k = c.chunk;
        if (!isObj(k)) return fail(`${p}.chunk`, 'object');
        int(k.index, `${p}.chunk.index`);
        int(k.start, `${p}.chunk.start`);
        int(k.end, `${p}.chunk.end`, Number.isInteger(k.start) ? k.start : 0);
        if (k.sha256 !== null) hex(k.sha256, `${p}.chunk.sha256`);
      }
      if (c.knowledge !== undefined && !(isObj(c.knowledge) && optStr(c.knowledge.documentId, `${p}.knowledge.documentId`, 100))) fail(`${p}.knowledge`, 'object');
      return true;
    });
  }
  if (r.grounding !== null) {
    const g = r.grounding;
    if (!isObj(g) || !isObj(g.algorithm) || !isObj(g.counts) || !Array.isArray(g.sentences) || g.sentences.length > RECEIPT_LIMITS.sentences) fail('grounding', 'object');
    else {
      str(g.algorithm.id, 'grounding.algorithm.id', 40);
      int(g.algorithm.version, 'grounding.algorithm.version');
      for (const [k, v] of Object.entries(g.counts)) int(v, `grounding.counts.${k}`);
      const n = Array.isArray(r.citations) ? r.citations.length : 0;
      const cites = (/** @type {unknown} */ list, /** @type {string} */ path) =>
        (Array.isArray(list) && list.every((i) => Number.isInteger(i) && i >= 0 && i < n)) || fail(path, 'citation indexes');
      g.sentences.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        const p = `grounding.sentences[${i}]`;
        if (!isObj(s)) return fail(p, 'object');
        str(s.text, `${p}.text`, RECEIPT_LIMITS.sentenceChars);
        cites(s.cites, `${p}.cites`);
        oneOf(s.citeSource, `${p}.citeSource`, ['own', 'block', 'leadin', 'answer', null]);
        oneOf(s.verdict, `${p}.verdict`, ['supported', 'weak', 'unsupported', 'unchecked']);
        if (!Array.isArray(s.reasons) || s.reasons.length > RECEIPT_LIMITS.reasons) return fail(`${p}.reasons`, 'array');
        s.reasons.forEach((/** @type {any} */ reason, /** @type {number} */ j) => {
          const q = `${p}.reasons[${j}]`;
          if (!isObj(reason)) return fail(q, 'object');
          str(reason.code, `${q}.code`, 40);
          oneOf(reason.level, `${q}.level`, ['weak', 'unsupported']);
          for (const key of ['fact', 'found']) if (reason[key] !== undefined) str(reason[key], `${q}.${key}`, 500);
          for (const key of ['cites', 'other']) if (reason[key] !== undefined) cites(reason[key], `${q}.${key}`);
          return true;
        });
        return true;
      });
    }
  }
  if (failure) return { ok: false, .../** @type {{ error: string, path: string }} */ (failure) };
  return { ok: true, receipt: /** @type {Receipt} */ (/** @type {unknown} */ (value)) };
}

/** @param {string} text */
const squash = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * @typedef {object} CitationCheck
 * @property {number} index
 * @property {string} label
 * @property {'workspace' | 'knowledge'} source
 * @property {'match' | 'missing' | 'not_verifiable'} file        L0: a provided file has the recorded fingerprint
 * @property {'match' | 'mismatch' | 'version_differs' | null} text  L1: extracting it gives the recorded text
 * @property {'match' | 'moved' | 'mismatch' | null} passage      L2: the passage at the recorded offsets is the excerpt
 * @property {'match' | 'mismatch' | 'version_differs' | null} chunk  L3: chunking gives the recorded bounds
 * @property {boolean | null} excerptConsistent  the excerpt text in the receipt matches its fingerprint
 * @property {string | null} fileName  name of the provided file that matched
 */

/**
 * @typedef {object} VerifyReport
 * @property {boolean} idMatches      the receipt hash matches its contents
 * @property {boolean} answerMatches  the answer hash matches the answer text
 * @property {CitationCheck[]} citations
 * @property {{ reproduced: number, verifiable: number }} summary  workspace passages reproduced from the provided files
 * @property {{ recomputed: number, differences: Array<{ sentence: number, recorded: string, now: string }>, needsConversation: boolean } | null} grounding
 * @property {string[]} warnings
 */

/**
 * The text the source check of the answer ran on: the whole excerpt, or for a cut excerpt its
 * delivered first part. Null when that part is not known (the statement is then not recomputed).
 * @param {ReceiptCitation} c
 * @param {string} text
 * @returns {string | null}
 */
function deliveredPart(c, text) {
  if (c.delivered !== 'partial') return text;
  return Number.isInteger(c.deliveredChars) && /** @type {number} */ (c.deliveredChars) <= text.length ? text.slice(0, c.deliveredChars) : null;
}

/**
 * Re-checks a receipt against the original files: file fingerprints, extracted text, the passage at
 * each offset, the chunk bounds, and the source-check verdicts (recomputed, not trusted).
 * @param {Receipt} receipt  validated with validateReceipt()
 * @param {Array<{ name: string, bytes: Uint8Array }>} files
 * @param {{ extract: (bytes: Uint8Array, name: string) => Promise<{ text: string, pdfjs: string | null }>, extractor: { id: string, version: number } }} tools
 * @returns {Promise<VerifyReport>}
 */
export async function verifyReceipt(receipt, files, tools) {
  /** @type {string[]} */
  const warnings = [];
  const body = /** @type {Omit<Receipt, 'id'> & { id?: string }} */ ({ ...receipt });
  delete body.id;
  const idMatches = (await receiptId(body)) === receipt.id;
  const answerMatches = (await sha256Hex(receipt.answer.text)) === receipt.answer.sha256;

  /** @type {Map<string, { name: string, bytes: Uint8Array }>} */
  const byHash = new Map();
  for (const f of files) byHash.set(await sha256Hex(f.bytes), f);
  /** @type {Map<string, Promise<{ text: string, pdfjs: string | null } | null>>} */
  const extracted = new Map();

  /** @type {CitationCheck[]} */
  const checks = [];
  /** @type {Array<string | null>} */
  const sourceTexts = [];
  for (const [index, c] of receipt.citations.entries()) {
    const excerptConsistent = c.excerpt.text === null ? null : (await sha256Hex(c.excerpt.text)) === c.excerpt.sha256;
    if (excerptConsistent === false) warnings.push(`citation ${index + 1}: the excerpt text does not match its fingerprint`);
    /** @type {CitationCheck} */
    const check = { index, label: c.label, source: c.source, file: 'not_verifiable', text: null, passage: null, chunk: null, excerptConsistent, fileName: null };
    checks.push(check);
    sourceTexts.push(excerptConsistent ? deliveredPart(c, /** @type {string} */ (c.excerpt.text)) : null);
    if (c.source !== 'workspace' || !c.document || !c.chunk || !c.document.fileSha256) continue;

    const file = byHash.get(c.document.fileSha256);
    if (!file) {
      check.file = 'missing';
      continue;
    }
    check.file = 'match';
    check.fileName = file.name;
    const key = c.document.fileSha256;
    if (!extracted.has(key)) {
      extracted.set(
        key,
        tools.extract(file.bytes, `document.${c.document.kind}`).catch((err) => {
          warnings.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
      );
    }
    const result = await extracted.get(key);
    if (!result) continue;
    const { text } = result;
    const versionDiffers =
      c.document.extractor.id !== tools.extractor.id ||
      c.document.extractor.version !== tools.extractor.version ||
      (c.document.extractor.pdfjs !== null && result.pdfjs !== null && c.document.extractor.pdfjs !== result.pdfjs);
    if (versionDiffers) warnings.push(`${file.name}: extracted with ${c.document.extractor.id} ${c.document.extractor.version}${c.document.extractor.pdfjs ? ` (pdf.js ${c.document.extractor.pdfjs})` : ''}, verified with ${tools.extractor.id} ${tools.extractor.version}${result.pdfjs ? ` (pdf.js ${result.pdfjs})` : ''}`);
    check.text = (await sha256Hex(text)) === c.document.textSha256 ? 'match' : versionDiffers ? 'version_differs' : 'mismatch';

    const passage = text.slice(c.chunk.start, c.chunk.end);
    const expected = c.chunk.sha256 ?? c.excerpt.sha256;
    if ((await sha256Hex(passage)) === expected) {
      check.passage = 'match';
      if (sourceTexts[index] === null && c.delivered !== 'omitted' && !c.excerpt.truncated) sourceTexts[index] = deliveredPart(c, passage);
    } else if (c.excerpt.text && excerptConsistent && squash(text).includes(squash(c.excerpt.text.replace(/…$/, '')))) {
      check.passage = 'moved';
    } else {
      check.passage = 'mismatch';
    }

    const recorded = c.document.chunker;
    let chunkMatch;
    try {
      const chunk = chunkText(text, { chunkSize: recorded.size, chunkOverlap: recorded.overlap })[c.chunk.index];
      chunkMatch = Boolean(chunk && chunk.start === c.chunk.start && chunk.end === c.chunk.end);
    } catch {
      chunkMatch = false;
    }
    check.chunk = chunkMatch ? 'match' : recorded.id !== CHUNKER.id || recorded.version !== CHUNKER.version ? 'version_differs' : 'mismatch';
  }

  const verifiable = receipt.citations.filter((c) => c.verifiable).length;
  const reproduced = checks.filter((c) => c.passage === 'match').length;

  /** @type {VerifyReport['grounding']} */
  let grounding = null;
  if (receipt.grounding) {
    if (receipt.grounding.algorithm.id !== GROUNDING.id || receipt.grounding.algorithm.version !== GROUNDING.version) {
      warnings.push(`source check recorded with ${receipt.grounding.algorithm.id} ${receipt.grounding.algorithm.version}, recomputed with ${GROUNDING.id} ${GROUNDING.version}`);
    }
    const sources = receipt.citations.map((c, i) => ({
      label: c.label,
      doc: c.doc,
      heading: c.heading,
      text: sourceTexts[i] ?? '',
      delivered: /** @type {'full' | 'partial' | 'omitted'} */ (sourceTexts[i] === null ? 'omitted' : c.delivered),
    }));
    const indexes = sources.map((s) => (s.delivered === 'omitted' ? null : indexSource(`${s.text}\n${s.doc}\n${s.heading}`)));
    const given = receipt.question ? indexSource(receipt.question.text) : null;
    /** @type {import('./grounding.js').CheckContext} */
    const ctx = { sources, indexes, given, citedOnly: false, lang: guessLanguage(receipt.answer.text) };
    const differences = [];
    let recomputed = 0;
    let needsConversation = false;
    for (const [i, s] of receipt.grounding.sentences.entries()) {
      if (s.reasons.some((r) => r.code === 'from_conversation')) needsConversation = true;
      if (s.cites.some((c) => sourceTexts[c] === null)) continue;
      const bad = s.reasons
        .filter((r) => r.code === 'unknown_citation' || r.code === 'label_mismatch')
        .map((r) => ({ label: r.found ?? '', resolved: r.code === 'label_mismatch' && r.cites?.length ? r.cites[0] : null }));
      const result = checkSentence(
        { block: 0, kind: 'p', start: 0, end: s.text.length, text: s.text, own: s.citeSource === 'own' ? s.cites.slice() : [], bad, cites: s.cites.filter((c) => !bad.some((b) => b.resolved === c)), citeSource: s.citeSource },
        ctx,
      );
      recomputed += 1;
      if (result.verdict !== s.verdict) differences.push({ sentence: i, recorded: s.verdict, now: result.verdict });
    }
    grounding = { recomputed, differences, needsConversation };
  }

  return { idMatches, answerMatches, citations: checks, summary: { reproduced, verifiable }, grounding, warnings };
}
