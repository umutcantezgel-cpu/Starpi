// @ts-check
// @starpi/core: the pure parts of Starpi that are useful outside the app. The source of every
// module lives in the app (src/js); this entry re-exports it and scripts/build-core.mjs bundles it.

// Citation labels and sentence splitting.
export { citationLabel, CITATION_PATTERN, labelName, LOOSE_LABEL_PATTERN, parseLabel } from '../../../src/js/core/labels.js';
export { sentenceSpans, splitSentences } from '../../../src/js/core/sentences.js';

// Source check: facts and statement-by-statement comparison with cited excerpts.
export { contentTokens, extractFacts, fold, guessLanguage, indexSource, lookupFact, numKey, parseNumber, tokenMatches } from '../../../src/js/core/facts.js';
export {
  associate,
  blocksFromMarkdown,
  checkSentence,
  contextCoverage,
  GROUNDING,
  GROUNDING_VERSIONS,
  groundAnswer,
  REASON_CODES,
  REASON_CODES_V1,
  resolveLabel,
  THRESHOLDS,
} from '../../../src/js/core/grounding.js';

// Language packs: the words and conventions the checks read a language with; English and German
// are built in, registerLanguage() adds one.
export { languagePack, LANGUAGES, registerLanguage } from '../../../src/js/core/lang/index.js';

// Sentence gate: releases a streamed answer unit by unit, only what its sources support (the
// starpi-gate command), with the canonical and spoken forms it judges and the streaming releaser.
export { checkText, createSentenceGate, isReleased } from '../../../src/js/core/gate.js';
export { canonicalText } from '../../../src/js/core/canonical.js';
export { spokenText } from '../../../src/js/core/spoken.js';
export { createSentenceReleaser } from '../../../src/js/core/release.js';

// Whole documents of any length, and SARIF 2.1.0 for code scanning (the starpi-ground command).
export { checkDocument } from '../../../src/js/core/document.js';
export { describeReason, REASON_MESSAGES, SARIF_SCHEMA, SARIF_VERSION, toSarif } from '../../../src/js/core/sarif.js';

// Answer receipts, their Merkle tree (RFC 6962) and signatures (Ed25519, ECDSA P-256).
export {
  buildReceipt,
  canonicalJson,
  citationLeafHash,
  RECEIPT_LIMITS,
  RECEIPT_SCHEMA,
  RECEIPT_SCHEMA_V1,
  RECEIPT_SCHEMA_V2,
  RECEIPT_SCHEMAS,
  sha256Hex,
  signReceipt,
  validateReceipt,
  verifyCitationProof,
  verifyReceipt,
  verifyReceiptSignature,
} from '../../../src/js/core/receipt.js';
export { MERKLE_ALG, merkleLeafHash, merkleTree, verifyMerkleProof } from '../../../src/js/core/merkle.js';
export { importPublicKey, publicKeyId, SIGNATURE_ALGS } from '../../../src/js/core/signature.js';

// Text extraction (PDFs need the optional peer dependency pdfjs-dist), chunking and BM25.
export {
  csvToText,
  extensionOf,
  EXTRACTOR,
  EXTRACTOR_COMPATIBLE,
  extractText,
  jsonToText,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  normalizeText,
  ParseError,
  parseCsv,
  SUPPORTED_EXTENSIONS,
} from '../../../src/js/rag/parser.js';
export { CHUNKER, chunkText, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from '../../../src/js/rag/chunker.js';
export { BM25_PARAMS, BM25Index, STOPWORDS, STOPWORDS_DE, STOPWORDS_EN, tokenize } from '../../../src/js/rag/bm25.js';

// Office documents, HTML pages and images (extraction rules version 2): the readers behind
// extractText, usable on their own, and the dependency-free ZIP reader with its ZIP bomb limits.
export { HTML_EXTENSIONS, IMAGE_EXTENSIONS, OFFICE_EXTENSIONS } from '../../../src/js/rag/parser.js';
export { docxToText } from '../../../src/js/rag/formats/docx.js';
export { decodeHtmlBytes, htmlToText } from '../../../src/js/rag/formats/html.js';
export { describeImage, imageToText, OCR_PURPOSE } from '../../../src/js/rag/formats/image.js';
export { pptxToText } from '../../../src/js/rag/formats/pptx.js';
export { xlsxToText } from '../../../src/js/rag/formats/xlsx.js';
export { isZip, openZip, ZIP_LIMITS } from '../../../src/js/rag/formats/zip.js';
