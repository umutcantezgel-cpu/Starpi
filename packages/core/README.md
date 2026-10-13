# @starpi/core

[![npm](https://img.shields.io/npm/v/@starpi/core)](https://www.npmjs.com/package/@starpi/core)
[![CI](https://github.com/umutcantezgel-cpu/Starpi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/umutcantezgel-cpu/Starpi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/umutcantezgel-cpu/Starpi/blob/main/packages/core/LICENSE)

The deterministic parts of [Starpi](https://github.com/umutcantezgel-cpu/Starpi), usable in any
retrieval-augmented generation (RAG) application:

- **Source check:** compares every statement of an answer with the excerpts it cites: numbers in
  English and German formats (480,000 = 480.000 = 480k), dates, times, weekdays, codes, quotations
  and wording, and names in English statements. It reports `supported`, `weak`, `unsupported` or
  `unchecked` per statement, with a reason that names the missing value.
- **Answer receipts** (`starpi.receipt/v1`): a JSON record of the cited excerpts with SHA-256
  fingerprints of the source files and passage offsets, and a verifier that reproduces every
  passage from the original files.
- The **text extraction** (Markdown, text, CSV, JSON, PDF), **chunking** with exact offsets and
  **BM25** index that produce those excerpts in Starpi.

No dependencies; ESM; runs in browsers, Web Workers and Node.js 22.13+ (the version pdf.js 6
requires). PDF extraction needs the optional peer dependency `pdfjs-dist` 6.

This is the same code the Starpi app runs: the package is built from the app's modules
([`scripts/build-core.mjs`](https://github.com/umutcantezgel-cpu/Starpi/blob/main/scripts/build-core.mjs)),
so its behaviour is covered by the app's tests.

## At a glance

| Task | Function | Section |
| --- | --- | --- |
| Check an answer against the excerpts it cites | `groundAnswer(blocksFromMarkdown(answer, sources), sources)` | [Check an answer](#check-an-answer-against-its-sources) |
| Record which excerpts an answer was given | `buildReceipt({ … })` | [Receipts](#create-and-verify-receipts) |
| Reproduce every excerpt from the original files | `verifyReceipt(receipt, files, { extractor: EXTRACTOR, extract })`, `npx starpi-verify-receipt` | [Receipts](#create-and-verify-receipts) |
| Split text into chunks with exact offsets | `chunkText(text)` | [Chunk and search](#chunk-and-search) |
| Rank chunks for a question | `new BM25Index()`, `.add(chunks)`, `.search(query)` | [Chunk and search](#chunk-and-search) |
| Read Markdown, text, CSV, JSON and PDF files | `extractText(file)` | [Receipts](#create-and-verify-receipts) |

## What the checks do and do not tell you

The source check is a heuristic. It compares text; it does not understand it. A statement it marks
`supported` can still be wrong (for example with the right number attached to the wrong thing), and
a correct paraphrase can be marked `weak`. Use a flag as "open the source and look", not as a
verdict on truth. Receipts are not signed: they show that the excerpts are reproducible from the
same files, not who produced the answer or which excerpts a model read. The format is specified in
[docs/spec/receipts.md](https://github.com/umutcantezgel-cpu/Starpi/blob/main/docs/spec/receipts.md).

## Install

```bash
npm install @starpi/core
npm install pdfjs-dist@6   # only if you extract text from PDFs
```

Every [GitHub release](https://github.com/umutcantezgel-cpu/Starpi/releases) also carries the
package tarball, built and tested by CI, with its SHA-256 in `SHA256SUMS`. The npm package is that
same file. To install from the release instead of the registry:

```bash
curl -fsSLO https://github.com/umutcantezgel-cpu/Starpi/releases/download/v1.3.0/starpi-core-1.3.0.tgz
curl -fsSLO https://github.com/umutcantezgel-cpu/Starpi/releases/download/v1.3.0/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
npm install ./starpi-core-1.3.0.tgz
```

`npm install https://github.com/umutcantezgel-cpu/Starpi/releases/download/v1.3.0/starpi-core-1.3.0.tgz`
works too, without the checksum step.

## Check an answer against its sources

```js
import { blocksFromMarkdown, groundAnswer } from '@starpi/core';

const sources = [
  {
    label: '[Doc: plan.md, Chunk: 1]',
    doc: 'plan.md',
    heading: '',
    text: 'The approved budget is 480,000 EUR. The steering group meets every Tuesday at 10:00.',
    delivered: 'full', // how much of the excerpt reached the model: full, partial or omitted
  },
];
const answer = 'The budget is 520,000 EUR [Doc: plan.md, Chunk: 1]. The group meets on Tuesdays [Doc: plan.md, Chunk: 1].';

const report = groundAnswer(blocksFromMarkdown(answer, sources), sources, { given: ['What is the budget?'] });
console.log(report.counts); // { supported: 1, weak: 0, unsupported: 1, unchecked: 0 }
console.log(report.sentences[0].reasons); // [{ code: 'missing_fact', level: 'unsupported', fact: '520,000', cites: [0] }]
```

A value the excerpt contains only next to other words ("75,000 EUR for infrastructure" when the
excerpt says "95,000 EUR for infrastructure and 75,000 EUR for training") is reported as
`fact_context`, with the passage where it stands in `found`. In English statements, a name (a
capitalised word inside the sentence, such as "Munich" or "Sarah") that none of the cited excerpts
contains is reported as `name_missing`.

Citations are recognised as `[Doc: <name>, Chunk: <n>]` labels (see `citationLabel`). Statements
inherit citations from their paragraph, from a lead-in line ending in a colon, or from a "Sources:"
line, and table rows are checked one by one. `given` holds the question and earlier turns: a value
found only there is reported as `from_conversation`. `blocksFromMarkdown` parses Markdown; the
Starpi app builds the same blocks from the rendered DOM instead.

Verdicts and reason codes:

| Verdict | Reason codes |
| --- | --- |
| `unsupported` | `missing_fact`, `uncited_missing`, `quote_missing`, `unknown_citation`, `not_delivered` |
| `weak` | `approximate`, `fact_elsewhere`, `fact_context`, `name_missing`, `uncited_found`, `from_conversation`, `low_overlap`, `label_mismatch`, a partial quotation |
| `supported` | none: every fact is in a cited excerpt and at least half of the content words appear there |
| `unchecked` | none: statement and excerpt are in different languages (facts only) and the statement has no facts |
| `neutral` | not counted: headings, short fragments, statements with neither a citation nor a fact |

## Create and verify receipts

```js
import { buildReceipt, chunkText, CHUNKER, EXTRACTOR, extractText, sha256Hex, validateReceipt, verifyReceipt } from '@starpi/core';

// When indexing: fingerprint the file before parsing, then the extracted text.
const file = new File([bytes], 'plan.md');
const fileSha256 = await sha256Hex(bytes);
const { text, kind, pages, pdfjs } = await extractText(file);
const chunks = chunkText(text); // 500 characters, 50 overlap, exact offsets

// After answering: a receipt for the excerpts the answer cited.
const chunk = chunks[0];
const receipt = await buildReceipt({
  createdAt: new Date().toISOString(),
  version: 'my-app 1.0.0',
  answer: { text: answerText, engine: 'cloud', locale: 'en' },
  question: 'What is the budget?',
  grounding: report,
  citations: [
    {
      label: '[Doc: plan.md, Chunk: 1]', doc: 'plan.md', heading: '', source: 'workspace', delivered: 'full',
      text: chunk.text, truncated: false,
      document: {
        name: 'plan.md', kind, bytes: bytes.length, fileSha256, textSha256: await sha256Hex(text), textChars: text.length, pages,
        extractor: { ...EXTRACTOR, pdfjs }, chunker: { ...CHUNKER, size: 500, overlap: 50 },
      },
      chunk: { index: chunk.index, start: chunk.start, end: chunk.end },
    },
  ],
});

// Later, anywhere: check the receipt against the original files.
const parsed = validateReceipt(JSON.parse(json));
if (!parsed.ok) throw new Error(`${parsed.error} at ${parsed.path}`);
const result = await verifyReceipt(parsed.receipt, [{ name: 'plan.md', bytes }], {
  extractor: EXTRACTOR,
  extract: async (data, name) => {
    const r = await extractText(new File([data], name));
    return { text: r.text, pdfjs: r.pdfjs };
  },
});
console.log(result.summary); // { reproduced: 1, verifiable: 1 }
```

`verifyReceipt` checks the receipt hash, the answer hash and, per workspace excerpt, the file
fingerprint (files are matched by hash, not by name), the extracted text, the passage at the
recorded offsets and the chunk bounds, and recomputes the source check.

### Command line

```bash
npx starpi-verify-receipt receipt.json plan.md --json            # with @starpi/core installed
npx -p @starpi/core starpi-verify-receipt receipt.json plan.md   # without installing it
npx -p @starpi/core -p pdfjs-dist@6 starpi-verify-receipt receipt.json plan.md notes.pdf   # with PDFs
```

Exit code 0 when every workspace excerpt was reproduced, 1 when something did not match or a file
is missing, 2 for a usage error or an invalid receipt.

## Chunk and search

```js
import { readFile } from 'node:fs/promises';
import { BM25Index, chunkText, citationLabel } from '@starpi/core';

const index = new BM25Index(); // Okapi BM25, k1 = 1.2, b = 0.75
for (const name of ['plan.md', 'risks.md']) {
  const text = await readFile(name, 'utf8');
  const chunks = chunkText(text); // 500 characters, 50 overlap, breaks at paragraphs, sentences or words
  index.add(chunks.map((c) => ({ docId: name, docName: name, chunkIndex: c.index, start: c.start, end: c.end, text: c.text })));
}

for (const { chunk, score, matchedTerms } of index.search('supplier delays', 3)) {
  console.log(citationLabel(chunk.docName, chunk.chunkIndex + 1), score.toFixed(2), matchedTerms);
}
// for example: [Doc: risks.md, Chunk: 1] 3.17 [ 'supplier', 'delays' ]
```

`chunk.start` and `chunk.end` are offsets into the text, so `text.slice(start, end)` is the chunk;
receipts record the same offsets. `index.remove(docId)` drops a document again. `tokenize`
lowercases (after Unicode NFKC), strips punctuation and drops English and German stop words and
single characters, the same way for documents and queries.

## Other exports

- `extractFacts`, `indexSource`, `lookupFact`, `parseNumber`, `fold`, `guessLanguage`: the fact
  reader behind the source check.
- `contextCoverage(citations, context)`: which excerpts reached the model in full, cut or not at
  all, from the context text actually sent.
- `canonicalJson`: RFC 8785 compatible serialization for the values receipts contain.
- `BM25Index`, `tokenize`, `STOPWORDS_EN`, `STOPWORDS_DE`: Okapi BM25 (k1 = 1.2, b = 0.75).
- `sentenceSpans`, `splitSentences`: deterministic sentence splitting with offsets.
- `GROUNDING`, `EXTRACTOR`, `CHUNKER`: the rule versions recorded in receipts.

Type declarations are included.

## Supply chain

- **No dependencies.** The package installs nothing else; `pdfjs-dist` is an optional peer that
  you add only for PDFs. Its CycloneDX SBOM (`starpi-core-<version>.cdx.json` on each release) lists
  no component besides the package.
- **Built by CI, from the tagged commit.** The release workflow packs the tarball in a job without
  write access, installs it offline into an empty project, imports it and runs the command line,
  then attaches it with `SHA256SUMS` and the SBOMs. The npm package is that tarball, so
  `npm view @starpi/core@<version> dist.integrity` matches the SHA-512 of the release asset.
- Checksums are not signatures, and the package has no npm provenance attestation yet. See the
  [security policy](https://github.com/umutcantezgel-cpu/Starpi/blob/main/SECURITY.md#supply-chain)
  for how to report a vulnerability and what CI checks.

## Versioning

`@starpi/core` is released together with the Starpi app and has the same version number. A change
to a check that can change a verdict bumps the rule version recorded in receipts (`GROUNDING`,
`EXTRACTOR`, `CHUNKER`), so a receipt says which rules produced it. The receipt format has its own
version (`starpi.receipt/v1`). The `pdfjs-dist` peer range follows the major version the app ships.
Changes are listed in the
[changelog](https://github.com/umutcantezgel-cpu/Starpi/blob/main/CHANGELOG.md).

## Ecosystem and downstream use

Starpi itself is the first user of this package's code: the app runs the same modules in the
browser and in its ingestion worker. The first downstream project is **Fluid Systems**, a local AI
assistant for production management and shift supervisors in plastics processing (injection
moulding and extrusion), by the same maintainer. It is built on Starpi 1.2.0 and takes over the
source check, answer receipts, text extraction, chunking and BM25: answers about the user's own
documents are checked by the source check and can be exported as `starpi.receipt/v1` receipts.
The sentence gate in development for its next version, which lets a sentence about machine or
shift figures through only when every number comes from its deterministic engine or from a cited
excerpt, builds on Starpi's citation-label and sentence rules. Fluid Systems is at demo stage (v0.1.0, simulated operating
data) and not public yet.

If you use `@starpi/core`, an [issue](https://github.com/umutcantezgel-cpu/Starpi/issues/new/choose)
with a link is welcome.

## License

MIT
