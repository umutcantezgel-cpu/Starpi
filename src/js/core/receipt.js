// @ts-check
// Answer receipts: a JSON file per answer that lists the excerpts the answer was given, with SHA-256
// fingerprints of the source files, the exact character offsets of each passage, the source-check
// verdicts, and a hash over all of it. Anyone who has the same files can reproduce every passage
// (verifyReceipt below, in the app or with scripts/verify-receipt.mjs).
//
// Format "starpi.receipt/v2" added a Merkle tree over the citations (RFC 6962, merkle.js) with an
// inclusion proof per citation, and an optional signature (Ed25519 or ECDSA P-256, signature.js) over
// the id and the Merkle root. Format "starpi.receipt/v3" (written by default) keeps all of that and
// adds optional members: `signer` (the key the receipt is meant to be signed with, inside the id, so
// a signature cannot be removed or swapped unnoticed), `gate` (what the sentence gate released and
// withheld), `secondOpinion` (advisory checks of single statements), `relations` (relations between
// statements checked against the excerpts) and, per file, where OCR text came from. v1 and v2
// receipts are still read and verified, and can still be written ({ schema: RECEIPT_SCHEMA_V1 } or
// RECEIPT_SCHEMA_V2).
//
// What a receipt proves: each workspace excerpt is an exact, unchanged passage of the file with the
// recorded fingerprint, at the recorded position, under the recorded extraction rules; a signed
// receipt was not changed after it was signed. What it does not prove: who signed it, unless the
// verifier has the signer's public key from the signer; which excerpts the model read; that the
// answer is correct; or anything about knowledge-base excerpts. See docs/spec/receipts.md.
//
// Pure: WebCrypto (crypto.subtle) only, so it runs in the browser, in workers and in Node 20+.
import { chunkText, CHUNKER } from '../rag/chunker.js';
import { guessLanguage, indexSource } from './facts.js';
import { checkSentence, GROUNDING, GROUNDING_VERSIONS, REASON_CODES, REASON_CODES_V1, THRESHOLDS } from './grounding.js';
import { canonicalJson, sha256Hex } from './hash.js';
import { MERKLE_ALG, merkleLeafHash, merkleTree, verifyMerkleProof } from './merkle.js';
import { signHead, SIGNATURE_ALGS, verifyHead } from './signature.js';

export { canonicalJson, sha256Hex };

/** The format buildReceipt writes. */
export const RECEIPT_SCHEMA = 'starpi.receipt/v3';
/** Merkle tree and signature, without the members v3 added. Still read, verified and, on request, written. */
export const RECEIPT_SCHEMA_V2 = 'starpi.receipt/v2';
/** The first format: no Merkle tree, no signature. Still read, verified and, on request, written. */
export const RECEIPT_SCHEMA_V1 = 'starpi.receipt/v1';
/** Every format this code reads, oldest first. */
export const RECEIPT_SCHEMAS = Object.freeze([RECEIPT_SCHEMA_V1, RECEIPT_SCHEMA_V2, RECEIPT_SCHEMA]);

/** @typedef {typeof RECEIPT_SCHEMA | typeof RECEIPT_SCHEMA_V2 | typeof RECEIPT_SCHEMA_V1} ReceiptSchema */

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
  // An audit path has one hash per tree level: at most ceil(log2(64)) = 6 for 64 citations.
  proof: 6,
  // v3
  secondOpinions: 500,
  relations: 500,
  relationChars: 500,
  modelChars: 100,
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
 * @property {ReceiptExtractor} extractor
 * @property {{ id: string, version: number, size: number, overlap: number }} chunker
 */

/**
 * The extraction rules a document's text was made with. `ocr` (v3) marks text that text recognition
 * produced from an image: it names the service and model, because that text cannot be extracted
 * again from the file without running the recognition again.
 * @typedef {object} ReceiptExtractor
 * @property {string} id
 * @property {number} version
 * @property {string | null} pdfjs
 * @property {{ provider: string, model: string }} [ocr]
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
 * @property {string[]} [proof]  v2: the citation's Merkle audit path (RFC 6962), sibling first
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
 * @typedef {object} ReceiptMerkle
 * @property {'sha256-rfc6962'} alg
 * @property {number} size  number of leaves: one per citation, in order
 * @property {string} root  Merkle tree hash (hex)
 */

/**
 * v3: the key a receipt is meant to be signed with. It is part of the id, so the signature cannot be
 * removed or replaced by one from another key without the verifier noticing.
 * @typedef {{ keyId: string, alg: import('./signature.js').SignatureAlg }} ReceiptSigner
 */

/**
 * v3: what the sentence gate (gate.js) let through for this answer: its mode and how many sentences
 * it released and withheld.
 * @typedef {{ mode: 'sources' | 'web' | 'free', released: number, withheld: number }} ReceiptGate
 */

/**
 * v3: an advisory second check of one statement against its excerpts, by an on-device entailment
 * model (`nli`) or a judge model (`judge`). It never changes a verdict.
 * @typedef {object} ReceiptSecondOpinion
 * @property {number} sentence  index into grounding.sentences
 * @property {number[]} cites   the citations the statement was checked against
 * @property {'nli' | 'judge'} engine
 * @property {string} model
 * @property {'entailed' | 'neutral' | 'contradicted'} result
 */

/**
 * v3: a relation one or two statements state (a comparison, an order in time, a value carried over
 * from an earlier statement), checked against the cited excerpts.
 * @typedef {object} ReceiptRelation
 * @property {'comparative' | 'temporal' | 'reference'} kind
 * @property {number[]} sentences  one or two indexes into grounding.sentences
 * @property {number[]} cites
 * @property {'supported' | 'inverted' | 'unsupported'} verdict
 * @property {string} text  the words that state the relation
 */

/**
 * @typedef {object} Receipt
 * @property {string} schema
 * @property {string} id  SHA-256 of the canonical JSON of the receipt without `id` and `signature`
 * @property {string} createdAt  device clock, ISO 8601
 * @property {{ name: string, version: string }} generator
 * @property {ReceiptSigner} [signer]  v3, optional
 * @property {{ text: string, sha256: string, engine: string, locale: string }} answer
 * @property {{ text: string } | null} question
 * @property {ReceiptCitation[]} citations
 * @property {{ algorithm: { id: string, version: number }, counts: Record<string, number>, sentences: ReceiptSentence[] } | null} grounding
 * @property {ReceiptGate} [gate]  v3, optional
 * @property {ReceiptSecondOpinion[]} [secondOpinion]  v3, optional
 * @property {ReceiptRelation[]} [relations]  v3, optional
 * @property {ReceiptMerkle} [merkle]  v2 and v3
 * @property {import('./signature.js').ReceiptSignature} [signature]  v2 and v3, optional
 */

/**
 * @typedef {object} ReceiptDraft
 * @property {string} createdAt
 * @property {string} version  app version
 * @property {{ text: string, engine: string, locale: string }} answer
 * @property {string} question
 * @property {Array<{ label: string, doc: string, heading: string, source: 'workspace' | 'knowledge', delivered: 'full' | 'partial' | 'omitted', deliveredChars?: number, text: string, truncated: boolean, document?: ReceiptDocument, chunk?: { index: number, start: number, end: number }, documentId?: string | null }>} citations
 * @property {import('./grounding.js').GroundingReport | null} grounding
 * @property {ReceiptGate | null} [gate]  v3
 * @property {ReceiptSecondOpinion[]} [secondOpinion]  v3
 * @property {ReceiptRelation[]} [relations]  v3
 */

/**
 * @typedef {object} BuildOptions
 * @property {boolean} [includeQuestion]  default true
 * @property {boolean} [includeExcerpts]  default true
 * @property {ReceiptSchema} [schema]     default RECEIPT_SCHEMA (v3)
 * @property {ReceiptSigner} [signer]     v3: the key the receipt will be signed with
 */

const HEX64 = /^[0-9a-f]{64}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/;

/**
 * The receipt id: SHA-256 of the canonical JSON of the receipt without `id` and `signature` (the
 * signature covers the id, so it cannot be part of it).
 * @param {Omit<Receipt, 'id'> & { id?: string }} receipt
 */
async function receiptId(receipt) {
  const body = { ...receipt };
  delete body.id;
  delete body.signature;
  return sha256Hex(canonicalJson(body));
}

/**
 * The Merkle leaf hash of a citation: SHA-256(0x00 ‖ UTF-8(canonical JSON of the citation without
 * its proof and without the excerpt text)). The excerpt text is committed through excerpt.sha256, so
 * a receipt exported without excerpt texts has the same root.
 * @param {ReceiptCitation} citation
 */
export async function citationLeafHash(citation) {
  const leaf = /** @type {ReceiptCitation} */ ({ ...citation, excerpt: { sha256: citation.excerpt.sha256, truncated: citation.excerpt.truncated } });
  delete leaf.proof;
  return merkleLeafHash(canonicalJson(leaf));
}

/**
 * Checks that a citation (with its proof) is the citation at `index` of a receipt with this Merkle
 * root, without the other citations.
 * @param {ReceiptCitation} citation
 * @param {number} index
 * @param {ReceiptMerkle} merkle
 */
export async function verifyCitationProof(citation, index, merkle) {
  return verifyMerkleProof(await citationLeafHash(citation), index, merkle.size, citation.proof ?? [], merkle.root);
}

/** Reasons whose `found` quotes the excerpt: a passage, or the value the excerpt states. */
const FOUND_FROM_EXCERPT = new Set(['fact_context', 'approximate', 'fact_elsewhere', 'negation_inversion', 'name_context']);

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
 * Builds a receipt for one answer: v3 (with a Merkle tree over the citations) unless `schema` asks
 * for v2 or v1. The members v3 added (signer, gate, second opinions, relations, OCR provenance)
 * cannot be written in an older format: a draft that has them is refused there rather than written
 * without them.
 * @param {ReceiptDraft} draft
 * @param {BuildOptions} [options]
 * @returns {Promise<Receipt>}
 */
export async function buildReceipt(draft, options = {}) {
  const includeQuestion = options.includeQuestion ?? true;
  const includeExcerpts = options.includeExcerpts ?? true;
  const schema = options.schema ?? RECEIPT_SCHEMA;
  if (!RECEIPT_SCHEMAS.includes(schema)) throw new TypeError(`buildReceipt: unknown schema ${schema}`);
  const v3 = schema === RECEIPT_SCHEMA;
  if (!v3) {
    const newer = [
      options.signer && 'signer',
      draft.gate && 'gate',
      draft.secondOpinion?.length && 'secondOpinion',
      draft.relations?.length && 'relations',
      draft.citations.some((c) => c.document?.extractor.ocr) && 'OCR text',
    ].find(Boolean);
    if (newer) throw new TypeError(`buildReceipt: ${newer} needs ${RECEIPT_SCHEMA}`);
  }
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
      // OCR text cannot be extracted again from the file alone, so its passages are not verifiable.
      verifiable: c.source === 'workspace' && Boolean(c.document?.fileSha256) && Boolean(c.chunk) && !c.document?.extractor.ocr,
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
  const answerSha256 = await sha256Hex(draft.answer.text);
  /** @type {Omit<Receipt, 'id'>} */
  const body = {
    schema,
    createdAt: draft.createdAt,
    generator: { name: 'starpi', version: draft.version },
    // Next to the generator, for people reading the file; the id covers it wherever it stands.
    ...(v3 && options.signer ? { signer: { keyId: options.signer.keyId, alg: options.signer.alg } } : {}),
    answer: { text: draft.answer.text, sha256: answerSha256, engine: draft.answer.engine, locale: draft.answer.locale },
    question: includeQuestion ? { text: draft.question } : null,
    citations,
    grounding,
  };
  if (v3) {
    if (draft.gate) body.gate = { mode: draft.gate.mode, released: draft.gate.released, withheld: draft.gate.withheld };
    if (draft.secondOpinion?.length) body.secondOpinion = draft.secondOpinion.map((o) => ({ sentence: o.sentence, cites: o.cites.slice(), engine: o.engine, model: o.model, result: o.result }));
    if (draft.relations?.length) body.relations = draft.relations.map((r) => ({ kind: r.kind, sentences: r.sentences.slice(), cites: r.cites.slice(), verdict: r.verdict, text: r.text }));
  }
  if (schema !== RECEIPT_SCHEMA_V1) {
    const tree = await merkleTree(await Promise.all(citations.map(citationLeafHash)));
    citations.forEach((c, i) => {
      c.proof = tree.proofs[i];
    });
    body.merkle = { alg: MERKLE_ALG, size: citations.length, root: tree.root };
  }
  const id = await receiptId(body);
  // schema and id first, for people reading the file.
  return Object.assign({ schema, id }, body);
}

/**
 * Signs a v3 or v2 receipt (Ed25519, or ECDSA P-256 with SHA-256) and returns a copy with
 * `signature`. The signature covers the receipt id and the Merkle root; the public key is embedded
 * as a JWK, and its key id is the SHA-256 of its SPKI. A v3 receipt that names a `signer` can only be
 * signed with that key. Signing again replaces the signature.
 * @param {Receipt} receipt  a v3 or v2 receipt from buildReceipt
 * @param {CryptoKey} privateKey
 * @param {{ publicKey?: CryptoKey | JsonWebKey | string }} [options]  needed unless the private key is extractable
 * @returns {Promise<Receipt>}
 */
export async function signReceipt(receipt, privateKey, options = {}) {
  if ((receipt.schema !== RECEIPT_SCHEMA && receipt.schema !== RECEIPT_SCHEMA_V2) || !receipt.merkle) throw new TypeError(`signReceipt: only ${RECEIPT_SCHEMA_V2} and ${RECEIPT_SCHEMA} receipts can be signed`);
  // A signature over an id or root that does not match the contents would vouch for nothing.
  if ((await receiptId(receipt)) !== receipt.id) throw new Error('signReceipt: the receipt id does not match its contents');
  const tree = await merkleTree(await Promise.all(receipt.citations.map(citationLeafHash)));
  if (tree.root !== receipt.merkle.root || receipt.merkle.size !== receipt.citations.length) throw new Error('signReceipt: the Merkle root does not match the citations');
  const signature = await signHead({ id: receipt.id, merkle: receipt.merkle }, privateKey, options.publicKey);
  if (receipt.signer && (receipt.signer.keyId !== signature.keyId || receipt.signer.alg !== signature.alg)) throw new Error('signReceipt: the receipt names another signer key');
  return { ...receipt, signature };
}

/**
 * The result of a receipt's signature check: the statuses of signature.js, plus `missing` for a v3
 * receipt that names a signer but carries no signature (it was removed).
 * @typedef {Omit<import('./signature.js').SignatureCheck, 'status'> & { status: import('./signature.js').SignatureCheck['status'] | 'missing' }} ReceiptSignatureCheck
 */

/**
 * Checks the signature of a receipt: `valid` when the signature verifies and the id and Merkle root
 * still match the receipt's contents. `trusted` is true only for a public key the caller supplies;
 * without one, the key embedded in the receipt is used, which shows that the receipt is unchanged
 * since signing, not who signed it. A v3 receipt that names a signer must carry a signature by that
 * key: without one the status is `missing`, with another key's it is `invalid`.
 * @param {Receipt} receipt  validated with validateReceipt()
 * @param {CryptoKey | JsonWebKey | string} [publicKey]
 * @returns {Promise<ReceiptSignatureCheck>}
 */
export async function verifyReceiptSignature(receipt, publicKey) {
  const signer = receipt.schema === RECEIPT_SCHEMA ? receipt.signer : undefined;
  if (receipt.schema === RECEIPT_SCHEMA_V1 || !receipt.merkle || !receipt.signature) {
    return signer ? { status: 'missing', alg: signer.alg, keyId: signer.keyId, trusted: false } : { status: 'unsigned', alg: null, keyId: null, trusted: false };
  }
  const check = await verifyHead({ id: receipt.id, merkle: receipt.merkle }, receipt.signature, publicKey);
  if (check.status !== 'valid') return check;
  const tree = await merkleTree(await Promise.all(receipt.citations.map(citationLeafHash)));
  const unchanged = (await receiptId(receipt)) === receipt.id && tree.root === receipt.merkle.root && receipt.merkle.size === receipt.citations.length;
  const bySigner = !signer || (signer.keyId === check.keyId && signer.alg === check.alg);
  return unchanged && bySigner ? check : { ...check, status: 'invalid', trusted: false };
}

/**
 * Checks that a parsed JSON value is a well-formed v1, v2 or v3 receipt within the size limits.
 * Every string that is later shown in the app is bounded; nothing is interpreted as HTML. Each
 * version has its own allowlist of members: a v1 receipt with a Merkle tree or a signature, or a v2
 * receipt with a member v3 added, is refused.
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
  const oneOf = (/** @type {unknown} */ v, /** @type {string} */ path, /** @type {ReadonlyArray<string | null>} */ list) =>
    list.includes(/** @type {string | null} */ (v)) || fail(path, `one of ${list.join('|')}`);
  // Members the format does not define are refused, as in the JSON Schema: a receipt cannot carry
  // extra fields (a fake "signature", say) that a verifier would silently accept.
  const only = (/** @type {Record<string, unknown>} */ v, /** @type {string} */ path, /** @type {string[]} */ keys) => {
    const extra = Object.keys(v).find((k) => !keys.includes(k));
    return extra === undefined || fail(path ? `${path}.${extra}` : extra, 'unknown member');
  };

  if (!isObj(value)) return { ok: false, error: 'not_a_receipt', path: '' };
  const r = /** @type {Record<string, any>} */ (value);
  if (!RECEIPT_SCHEMAS.includes(r.schema)) {
    return typeof r.schema === 'string' && r.schema.startsWith('starpi.receipt/')
      ? { ok: false, error: 'unsupported_version', path: 'schema' }
      : { ok: false, error: 'not_a_receipt', path: 'schema' };
  }
  // v2 and v3 have the Merkle tree and the signature; v3 adds the optional members below.
  const v2 = r.schema !== RECEIPT_SCHEMA_V1;
  const v3 = r.schema === RECEIPT_SCHEMA;
  only(r, '', ['schema', 'id', 'createdAt', 'generator', 'answer', 'question', 'citations', 'grounding', ...(v2 ? ['merkle', 'signature'] : []), ...(v3 ? ['signer', 'gate', 'secondOpinion', 'relations'] : [])]);
  hex(r.id, 'id');
  str(r.createdAt, 'createdAt', 64);
  if (!isObj(r.generator)) fail('generator', 'object');
  else only(r.generator, 'generator', ['name', 'version']) && str(r.generator.name, 'generator.name', 40) && str(r.generator.version, 'generator.version', 40);
  if (!isObj(r.answer)) fail('answer', 'object');
  else {
    only(r.answer, 'answer', ['text', 'sha256', 'engine', 'locale']);
    str(r.answer.text, 'answer.text', RECEIPT_LIMITS.answerChars);
    hex(r.answer.sha256, 'answer.sha256');
    str(r.answer.engine, 'answer.engine', 40);
    str(r.answer.locale, 'answer.locale', 10);
  }
  if (r.question !== null && !(isObj(r.question) && only(r.question, 'question', ['text']) && str(r.question.text, 'question.text', RECEIPT_LIMITS.questionChars))) fail('question', 'object');
  if (!Array.isArray(r.citations) || r.citations.length > RECEIPT_LIMITS.citations) fail('citations', 'array');
  else {
    r.citations.forEach((c, i) => {
      const p = `citations[${i}]`;
      if (!isObj(c)) return fail(p, 'object');
      only(c, p, ['label', 'doc', 'heading', 'source', 'delivered', 'deliveredChars', 'excerpt', 'verifiable', 'document', 'chunk', 'knowledge', ...(v2 ? ['proof'] : [])]);
      if (v2 && !(Array.isArray(c.proof) && c.proof.length <= RECEIPT_LIMITS.proof && c.proof.every((/** @type {unknown} */ h, /** @type {number} */ j) => hex(h, `${p}.proof[${j}]`)))) fail(`${p}.proof`, 'array');
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
        only(c.excerpt, `${p}.excerpt`, ['text', 'sha256', 'truncated']);
        optStr(c.excerpt.text, `${p}.excerpt.text`, RECEIPT_LIMITS.excerptChars);
        hex(c.excerpt.sha256, `${p}.excerpt.sha256`);
        if (typeof c.excerpt.truncated !== 'boolean') fail(`${p}.excerpt.truncated`, 'boolean');
      }
      if (c.document !== undefined) {
        const d = c.document;
        if (!isObj(d)) return fail(`${p}.document`, 'object');
        only(d, `${p}.document`, ['name', 'kind', 'bytes', 'fileSha256', 'textSha256', 'textChars', 'pages', 'extractor', 'chunker']);
        str(d.name, `${p}.document.name`, RECEIPT_LIMITS.nameChars);
        str(d.kind, `${p}.document.kind`, 20);
        int(d.bytes, `${p}.document.bytes`);
        if (d.fileSha256 !== null) hex(d.fileSha256, `${p}.document.fileSha256`);
        hex(d.textSha256, `${p}.document.textSha256`);
        int(d.textChars, `${p}.document.textChars`);
        if (d.pages !== null) int(d.pages, `${p}.document.pages`);
        if (!isObj(d.extractor)) fail(`${p}.document.extractor`, 'object');
        else {
          const e = d.extractor;
          only(e, `${p}.document.extractor`, ['id', 'version', 'pdfjs', ...(v3 ? ['ocr'] : [])]) && str(e.id, `${p}.document.extractor.id`, 40) && int(e.version, `${p}.document.extractor.version`) && optStr(e.pdfjs, `${p}.document.extractor.pdfjs`, 40);
          if (e.ocr !== undefined && !(isObj(e.ocr) && only(e.ocr, `${p}.document.extractor.ocr`, ['provider', 'model']) && str(e.ocr.provider, `${p}.document.extractor.ocr.provider`, 40) && str(e.ocr.model, `${p}.document.extractor.ocr.model`, RECEIPT_LIMITS.modelChars))) {
            fail(`${p}.document.extractor.ocr`, 'object');
          }
        }
        if (!isObj(d.chunker)) fail(`${p}.document.chunker`, 'object');
        else {
          only(d.chunker, `${p}.document.chunker`, ['id', 'version', 'size', 'overlap']);
          str(d.chunker.id, `${p}.document.chunker.id`, 40);
          int(d.chunker.version, `${p}.document.chunker.version`);
          int(d.chunker.size, `${p}.document.chunker.size`, 1);
          int(d.chunker.overlap, `${p}.document.chunker.overlap`);
        }
      }
      if (c.chunk !== undefined) {
        const k = c.chunk;
        if (!isObj(k)) return fail(`${p}.chunk`, 'object');
        only(k, `${p}.chunk`, ['index', 'start', 'end', 'sha256']);
        int(k.index, `${p}.chunk.index`);
        int(k.start, `${p}.chunk.start`);
        int(k.end, `${p}.chunk.end`, Number.isInteger(k.start) ? k.start : 0);
        if (k.sha256 !== null) hex(k.sha256, `${p}.chunk.sha256`);
      }
      if (c.knowledge !== undefined && !(isObj(c.knowledge) && only(c.knowledge, `${p}.knowledge`, ['documentId']) && optStr(c.knowledge.documentId, `${p}.knowledge.documentId`, 100))) fail(`${p}.knowledge`, 'object');
      return true;
    });
  }
  if (r.grounding !== null) {
    const g = r.grounding;
    if (!isObj(g) || !isObj(g.algorithm) || !isObj(g.counts) || !Array.isArray(g.sentences) || g.sentences.length > RECEIPT_LIMITS.sentences) fail('grounding', 'object');
    else {
      only(g, 'grounding', ['algorithm', 'counts', 'sentences']);
      only(g.algorithm, 'grounding.algorithm', ['id', 'version']);
      only(g.counts, 'grounding.counts', ['supported', 'weak', 'unsupported', 'unchecked']);
      for (const k of ['supported', 'weak', 'unsupported', 'unchecked']) int(g.counts[k], `grounding.counts.${k}`);
      str(g.algorithm.id, 'grounding.algorithm.id', 40);
      int(g.algorithm.version, 'grounding.algorithm.version');
      const n = Array.isArray(r.citations) ? r.citations.length : 0;
      const cites = (/** @type {unknown} */ list, /** @type {string} */ path) =>
        (Array.isArray(list) && list.every((i) => Number.isInteger(i) && i >= 0 && i < n)) || fail(path, 'citation indexes');
      g.sentences.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        const p = `grounding.sentences[${i}]`;
        if (!isObj(s)) return fail(p, 'object');
        only(s, p, ['text', 'cites', 'citeSource', 'verdict', 'reasons']);
        str(s.text, `${p}.text`, RECEIPT_LIMITS.sentenceChars);
        cites(s.cites, `${p}.cites`);
        oneOf(s.citeSource, `${p}.citeSource`, ['own', 'block', 'leadin', 'answer', null]);
        oneOf(s.verdict, `${p}.verdict`, ['supported', 'weak', 'unsupported', 'unchecked']);
        if (!Array.isArray(s.reasons) || s.reasons.length > RECEIPT_LIMITS.reasons) return fail(`${p}.reasons`, 'array');
        s.reasons.forEach((/** @type {any} */ reason, /** @type {number} */ j) => {
          const q = `${p}.reasons[${j}]`;
          if (!isObj(reason)) return fail(q, 'object');
          only(reason, q, ['code', 'level', 'fact', 'found', 'cites', 'other']);
          oneOf(reason.code, `${q}.code`, v2 ? REASON_CODES : REASON_CODES_V1);
          oneOf(reason.level, `${q}.level`, ['weak', 'unsupported']);
          for (const key of ['fact', 'found']) if (reason[key] !== undefined) str(reason[key], `${q}.${key}`, 500);
          for (const key of ['cites', 'other']) if (reason[key] !== undefined) cites(reason[key], `${q}.${key}`);
          return true;
        });
        return true;
      });
    }
  }
  if (v2) {
    const m = r.merkle;
    if (!isObj(m)) fail('merkle', 'object');
    else {
      only(m, 'merkle', ['alg', 'size', 'root']);
      oneOf(m.alg, 'merkle.alg', [MERKLE_ALG]);
      if (int(m.size, 'merkle.size') && Array.isArray(r.citations) && m.size !== r.citations.length) fail('merkle.size', 'number of citations');
      hex(m.root, 'merkle.root');
    }
    if (r.signature !== undefined) {
      const sig = r.signature;
      if (!isObj(sig)) fail('signature', 'object');
      else {
        only(sig, 'signature', ['alg', 'keyId', 'publicKey', 'value']);
        oneOf(sig.alg, 'signature.alg', SIGNATURE_ALGS);
        hex(sig.keyId, 'signature.keyId');
        if (typeof sig.value !== 'string' || !B64URL_64.test(sig.value)) fail('signature.value', 'base64url signature');
        const k = sig.publicKey;
        const b64 = (/** @type {unknown} */ v, /** @type {string} */ path) => (typeof v === 'string' && B64URL_32.test(v)) || fail(path, 'base64url coordinate');
        if (!isObj(k)) fail('signature.publicKey', 'object');
        else if (sig.alg === 'Ed25519') only(k, 'signature.publicKey', ['kty', 'crv', 'x']) && oneOf(k.kty, 'signature.publicKey.kty', ['OKP']) && oneOf(k.crv, 'signature.publicKey.crv', ['Ed25519']) && b64(k.x, 'signature.publicKey.x');
        else if (sig.alg === 'ES256') only(k, 'signature.publicKey', ['kty', 'crv', 'x', 'y']) && oneOf(k.kty, 'signature.publicKey.kty', ['EC']) && oneOf(k.crv, 'signature.publicKey.crv', ['P-256']) && b64(k.x, 'signature.publicKey.x') && b64(k.y, 'signature.publicKey.y');
      }
    }
  }
  if (v3) {
    const sentenceCount = isObj(r.grounding) && Array.isArray(r.grounding.sentences) ? r.grounding.sentences.length : 0;
    const citationCount = Array.isArray(r.citations) ? r.citations.length : 0;
    const indexes = (/** @type {unknown} */ list, /** @type {string} */ path, /** @type {number} */ n, /** @type {string} */ what) =>
      (Array.isArray(list) && list.every((i) => Number.isInteger(i) && i >= 0 && i < n)) || fail(path, what);
    if (r.signer !== undefined) {
      if (!isObj(r.signer)) fail('signer', 'object');
      else only(r.signer, 'signer', ['keyId', 'alg']) && hex(r.signer.keyId, 'signer.keyId') && oneOf(r.signer.alg, 'signer.alg', SIGNATURE_ALGS);
    }
    if (r.gate !== undefined) {
      if (!isObj(r.gate)) fail('gate', 'object');
      else only(r.gate, 'gate', ['mode', 'released', 'withheld']) && oneOf(r.gate.mode, 'gate.mode', ['sources', 'web', 'free']) && int(r.gate.released, 'gate.released') && int(r.gate.withheld, 'gate.withheld');
    }
    if (r.secondOpinion !== undefined) {
      if (!Array.isArray(r.secondOpinion) || r.secondOpinion.length > RECEIPT_LIMITS.secondOpinions) fail('secondOpinion', 'array');
      else {
        r.secondOpinion.forEach((/** @type {any} */ o, /** @type {number} */ i) => {
          const p = `secondOpinion[${i}]`;
          if (!isObj(o)) return fail(p, 'object');
          only(o, p, ['sentence', 'cites', 'engine', 'model', 'result']);
          indexes([o.sentence], `${p}.sentence`, sentenceCount, 'statement index');
          indexes(o.cites, `${p}.cites`, citationCount, 'citation indexes');
          oneOf(o.engine, `${p}.engine`, ['nli', 'judge']);
          str(o.model, `${p}.model`, RECEIPT_LIMITS.modelChars);
          return oneOf(o.result, `${p}.result`, ['entailed', 'neutral', 'contradicted']);
        });
      }
    }
    if (r.relations !== undefined) {
      if (!Array.isArray(r.relations) || r.relations.length > RECEIPT_LIMITS.relations) fail('relations', 'array');
      else {
        r.relations.forEach((/** @type {any} */ rel, /** @type {number} */ i) => {
          const p = `relations[${i}]`;
          if (!isObj(rel)) return fail(p, 'object');
          only(rel, p, ['kind', 'sentences', 'cites', 'verdict', 'text']);
          oneOf(rel.kind, `${p}.kind`, ['comparative', 'temporal', 'reference']);
          if (!Array.isArray(rel.sentences) || rel.sentences.length < 1 || rel.sentences.length > 2) fail(`${p}.sentences`, 'one or two statement indexes');
          else indexes(rel.sentences, `${p}.sentences`, sentenceCount, 'statement indexes');
          indexes(rel.cites, `${p}.cites`, citationCount, 'citation indexes');
          oneOf(rel.verdict, `${p}.verdict`, ['supported', 'inverted', 'unsupported']);
          return str(rel.text, `${p}.text`, RECEIPT_LIMITS.relationChars);
        });
      }
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
 * @property {'match' | 'mismatch' | 'version_differs' | 'ocr' | null} text  L1: extracting it gives the recorded text ('ocr': text recognition made it, so it cannot be extracted again)
 * @property {'match' | 'moved' | 'mismatch' | null} passage      L2: the passage at the recorded offsets is the excerpt
 * @property {'match' | 'mismatch' | 'version_differs' | null} chunk  L3: chunking gives the recorded bounds
 * @property {boolean | null} excerptConsistent  the excerpt text in the receipt matches its fingerprint
 * @property {string | null} fileName  name of the provided file that matched
 * @property {boolean | null} proof  v2 and v3: the citation's inclusion proof leads to the recorded Merkle root
 */

/**
 * @typedef {object} VerifyReport
 * @property {string} schema          the receipt format, starpi.receipt/v1, /v2 or /v3
 * @property {boolean} idMatches      the receipt hash matches its contents
 * @property {boolean} answerMatches  the answer hash matches the answer text
 * @property {CitationCheck[]} citations
 * @property {{ reproduced: number, verifiable: number }} summary  workspace passages reproduced from the provided files
 * @property {{ recomputed: number, differences: Array<{ sentence: number, recorded: string, now: string }>, needsConversation: boolean } | null} grounding
 * @property {{ size: number, rootMatches: boolean, validProofs: number } | null} merkle  v2 and v3: the root recomputed from the citations, and how many inclusion proofs lead to it
 * @property {ReceiptSignatureCheck | null} signature  v2 and v3: the signature check (status `unsigned` without one); null for v1
 * @property {ReceiptSigner | null} signer  v3: the signer the receipt names
 * @property {ReceiptGate | null} gate  v3: what the sentence gate released and withheld, as recorded
 * @property {{ secondOpinions: number, contradicted: number, relations: number, flagged: number }} advisory  v3: recorded second opinions (and how many contradict) and relations (and how many are inverted or unsupported); not recomputed
 * @property {string[]} warnings
 */

/**
 * What verifyReceipt needs to extract a file again: the extraction code, its rules and, optionally,
 * the earlier rule versions whose text equals that of the current ones per document kind (a text
 * recorded with such a version is then compared without a note).
 * @typedef {object} VerifyTools
 * @property {(bytes: Uint8Array, name: string) => Promise<{ text: string, pdfjs: string | null }>} extract
 * @property {{ id: string, version: number }} extractor
 * @property {Readonly<Record<number, readonly string[]>>} [compatible]
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
 * each offset, the chunk bounds, and the source-check verdicts (recomputed, not trusted). For a v2 or
 * v3 receipt also the Merkle root, every inclusion proof and the signature, if there is one. Text
 * that OCR recognised (v3) is not extracted again: only its file fingerprint is checked.
 * @param {Receipt} receipt  validated with validateReceipt()
 * @param {Array<{ name: string, bytes: Uint8Array }>} files
 * @param {VerifyTools} tools
 * @param {{ publicKey?: CryptoKey | JsonWebKey | string }} [options]  the signer's public key, to check who signed
 * @returns {Promise<VerifyReport>}
 */
export async function verifyReceipt(receipt, files, tools, options = {}) {
  /** @type {string[]} */
  const warnings = [];
  const idMatches = (await receiptId(receipt)) === receipt.id;
  const answerMatches = (await sha256Hex(receipt.answer.text)) === receipt.answer.sha256;

  /** @type {VerifyReport['merkle']} */
  let merkle = null;
  /** @type {boolean[]} */
  let proofs = [];
  if (receipt.schema !== RECEIPT_SCHEMA_V1 && receipt.merkle) {
    const recorded = receipt.merkle;
    const leaves = await Promise.all(receipt.citations.map(citationLeafHash));
    const tree = await merkleTree(leaves);
    proofs = await Promise.all(receipt.citations.map((c, i) => verifyMerkleProof(leaves[i], i, recorded.size, c.proof ?? [], recorded.root)));
    merkle = { size: recorded.size, rootMatches: tree.root === recorded.root && recorded.size === leaves.length, validProofs: proofs.filter(Boolean).length };
  }
  const signature = receipt.schema !== RECEIPT_SCHEMA_V1 ? await verifyReceiptSignature(receipt, options.publicKey) : null;

  /** @type {Map<string, { name: string, bytes: Uint8Array }>} */
  const byHash = new Map();
  for (const f of files) byHash.set(await sha256Hex(f.bytes), f);
  /** @type {Map<string, Promise<{ text: string, pdfjs: string | null } | null>>} */
  const extracted = new Map();
  /** One note per file, not one per citation of it. */
  const noted = new Set();
  const note = (/** @type {string} */ key, /** @type {string} */ text) => {
    if (noted.has(key)) return;
    noted.add(key);
    warnings.push(text);
  };

  /** @type {CitationCheck[]} */
  const checks = [];
  /** @type {Array<string | null>} */
  const sourceTexts = [];
  for (const [index, c] of receipt.citations.entries()) {
    const excerptConsistent = c.excerpt.text === null ? null : (await sha256Hex(c.excerpt.text)) === c.excerpt.sha256;
    if (excerptConsistent === false) warnings.push(`citation ${index + 1}: the excerpt text does not match its fingerprint`);
    /** @type {CitationCheck} */
    const check = { index, label: c.label, source: c.source, file: 'not_verifiable', text: null, passage: null, chunk: null, excerptConsistent, fileName: null, proof: merkle ? proofs[index] : null };
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
    const ocr = c.document.extractor.ocr;
    if (ocr) {
      check.text = 'ocr';
      note(`ocr:${key}`, `${file.name}: text recognised by OCR (${ocr.provider}, ${ocr.model}); it cannot be extracted again, only the file fingerprint was checked`);
      continue;
    }
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
    const recordedRules = c.document.extractor;
    // An earlier version whose text equals the current one for this kind counts as the same rules.
    const sameRules =
      recordedRules.id === tools.extractor.id && (recordedRules.version === tools.extractor.version || (tools.compatible?.[recordedRules.version]?.includes(c.document.kind) ?? false));
    const pdfjsDiffers = recordedRules.pdfjs !== null && result.pdfjs !== null && recordedRules.pdfjs !== result.pdfjs;
    const versionDiffers = !sameRules || pdfjsDiffers;
    const textMatches = (await sha256Hex(text)) === c.document.textSha256;
    // The note explains a text that may differ for that reason; compatible rules that gave the same text need none.
    if (versionDiffers && !(textMatches && sameRules)) {
      note(`rules:${key}`, `${file.name}: extracted with ${recordedRules.id} ${recordedRules.version}${recordedRules.pdfjs ? ` (pdf.js ${recordedRules.pdfjs})` : ''}, verified with ${tools.extractor.id} ${tools.extractor.version}${result.pdfjs ? ` (pdf.js ${result.pdfjs})` : ''}`);
    }
    check.text = textMatches ? 'match' : versionDiffers ? 'version_differs' : 'mismatch';

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
    // The verdicts are recomputed with the rules that recorded them when this code still has them
    // (every earlier version of starpi-grounding), else with the current rules and a warning.
    const recorded = receipt.grounding.algorithm;
    const version = recorded.id === GROUNDING.id && GROUNDING_VERSIONS.includes(recorded.version) ? recorded.version : GROUNDING.version;
    if (recorded.id !== GROUNDING.id || recorded.version !== version) {
      warnings.push(`source check recorded with ${recorded.id} ${recorded.version}, recomputed with ${GROUNDING.id} ${version}`);
    }
    const sources = receipt.citations.map((c, i) => ({
      label: c.label,
      doc: c.doc,
      heading: c.heading,
      text: sourceTexts[i] ?? '',
      delivered: /** @type {'full' | 'partial' | 'omitted'} */ (sourceTexts[i] === null ? 'omitted' : c.delivered),
    }));
    const indexes = sources.map((s) => (s.delivered === 'omitted' ? null : indexSource(`${s.text}\n${s.doc}\n${s.heading}`, { version })));
    const given = receipt.question ? indexSource(receipt.question.text, { version }) : null;
    /** @type {import('./grounding.js').CheckContext} */
    const ctx = { sources, indexes, given, citedOnly: false, lang: guessLanguage(receipt.answer.text), version };
    const differences = [];
    let recomputed = 0;
    let needsConversation = false;
    for (const [i, s] of receipt.grounding.sentences.entries()) {
      if (s.reasons.some((r) => r.code === 'from_conversation')) needsConversation = true;
      // A verdict can also depend on excerpts the statement does not cite (a value found in another
      // excerpt): when one of those is not available either, the statement cannot be recomputed.
      if (s.cites.some((c) => sourceTexts[c] === null) || s.reasons.some((r) => r.other?.some((c) => sourceTexts[c] === null))) continue;
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

  const v3 = receipt.schema === RECEIPT_SCHEMA;
  const opinions = v3 ? (receipt.secondOpinion ?? []) : [];
  const relations = v3 ? (receipt.relations ?? []) : [];
  const advisory = {
    secondOpinions: opinions.length,
    contradicted: opinions.filter((o) => o.result === 'contradicted').length,
    relations: relations.length,
    flagged: relations.filter((r) => r.verdict !== 'supported').length,
  };
  return {
    schema: receipt.schema,
    idMatches,
    answerMatches,
    citations: checks,
    summary: { reproduced, verifiable },
    grounding,
    merkle,
    signature,
    signer: v3 && receipt.signer ? { ...receipt.signer } : null,
    gate: v3 && receipt.gate ? { ...receipt.gate } : null,
    advisory,
    warnings,
  };
}
