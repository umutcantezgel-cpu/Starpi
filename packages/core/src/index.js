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
  groundAnswer,
  resolveLabel,
  THRESHOLDS,
} from '../../../src/js/core/grounding.js';

// Answer receipts.
export { buildReceipt, canonicalJson, RECEIPT_LIMITS, RECEIPT_SCHEMA, sha256Hex, validateReceipt, verifyReceipt } from '../../../src/js/core/receipt.js';

// Text extraction (PDFs need the optional peer dependency pdfjs-dist), chunking and BM25.
export {
  csvToText,
  extensionOf,
  EXTRACTOR,
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
