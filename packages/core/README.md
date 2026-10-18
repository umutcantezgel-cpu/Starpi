# @starpi/core

[![npm](https://img.shields.io/npm/v/@starpi/core)](https://www.npmjs.com/package/@starpi/core)
[![CI](https://github.com/umutcantezgel-cpu/Starpi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/umutcantezgel-cpu/Starpi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/umutcantezgel-cpu/Starpi/blob/main/packages/core/LICENSE)

The deterministic parts of [Starpi](https://github.com/umutcantezgel-cpu/Starpi), usable in any
retrieval-augmented generation (RAG) application:

- **Source check:** compares every statement of an answer with the excerpts it cites: numbers in
  English and German formats (480,000 = 480.000 = 480k), dates, times, weekdays, codes, version
  numbers, quotations and wording; and, in English and German, whether a statement reverses a
  negation of its excerpt ("is supported" against "is not supported", "erlaubt" against
  "verboten"), whether it puts a name or a value next to something else than the excerpt does,
  and whether a change, comparison or order in time, within a statement or carried over from the
  statement before, goes the way the excerpts say ("rose from 212,000 to 198,500", "more visits
  than the reading hall", "came out before version 8.0"). It reports `supported`, `weak`,
  `unsupported` or `unchecked` per statement, with a reason that names the missing value or quotes
  the passage that says otherwise.
- **Answer receipts** (`starpi.receipt/v3`): a JSON record of the cited excerpts with SHA-256
  fingerprints of the source files and passage offsets, a Merkle tree (RFC 6962) with an
  inclusion proof per citation, optional Ed25519 or ECDSA P-256 signatures with a named signer,
  and a verifier that reproduces every passage from the original files. Receipts of the earlier
  formats (`starpi.receipt/v2` and `/v1`) are still verified.
- **`starpi-ground`**, a command that checks a Markdown document of any length against source
  files and writes text, JSON or SARIF 2.1.0, so a CI job can fail on an unsupported statement
  and show it in GitHub code scanning.
- **Sentence gate:** releases a streamed answer sentence by sentence (list items, table rows and
  code blocks whole) and only what its sources support: every number and number word must appear
  in a cited excerpt, identifiers as written, no links and no characters outside an allowlist. The
  `starpi-gate` command runs it over a file and writes JSON or SARIF.
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
| Sign a receipt, check a signature | `signReceipt(receipt, privateKey)`, `verifyReceiptSignature(receipt, publicKey)` | [Sign receipts](#sign-receipts) |
| Check a whole document in CI, as SARIF | `npx starpi-ground --answer notes.md --source docs/ --format sarif`, `checkDocument`, `toSarif` | [Check documents in CI](#check-documents-in-ci) |
| Release a streamed answer unit by unit, only what its sources support | `createSentenceGate({ sources }).push(delta)`, `checkText`, `npx starpi-gate` | [Gate a streamed answer](#gate-a-streamed-answer) |
| Split text into chunks with exact offsets | `chunkText(text)` | [Chunk and search](#chunk-and-search) |
| Rank chunks for a question | `new BM25Index()`, `.add(chunks)`, `.search(query)` | [Chunk and search](#chunk-and-search) |
| Read Markdown, text, CSV, JSON and PDF files | `extractText(file)` | [Receipts](#create-and-verify-receipts) |

## What the checks do and do not tell you

The source check is a heuristic. It compares text; it does not understand it. A statement it marks
`supported` can still be wrong (for example when it reverses a meaning with words the check does
not know, or combines two correct passages into a wrong one), and a correct paraphrase can be
marked `weak`. Use a flag as "open the source and look", not as a
verdict on truth. Receipts show that the excerpts are reproducible from the same files, not which
excerpts a model read. A signed receipt shows who signed it only when you check the signature with
the signer's public key, obtained from the signer; the key inside the receipt proves only that it
was not changed after signing. The format is specified in
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
curl -fsSLO https://github.com/umutcantezgel-cpu/Starpi/releases/download/v2.1.0/starpi-core-2.1.0.tgz
curl -fsSLO https://github.com/umutcantezgel-cpu/Starpi/releases/download/v2.1.0/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
npm install ./starpi-core-2.1.0.tgz
```

`npm install https://github.com/umutcantezgel-cpu/Starpi/releases/download/v2.1.0/starpi-core-2.1.0.tgz`
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

Statements that use the excerpt's own words and still say something else:

```js
const spec = [{ label: '[Doc: spec.md, Chunk: 1]', doc: 'spec.md', heading: '', delivered: 'full',
  text: 'Power over Ethernet is not supported. Priya Raman owns this specification; Marcus Hale maintains the network configuration.' }];
const claims = 'Power over Ethernet is supported [Doc: spec.md, Chunk: 1]. Marcus Hale owns the specification [Doc: spec.md, Chunk: 1].';

for (const s of groundAnswer(blocksFromMarkdown(claims, spec), spec).sentences) console.log(s.verdict, s.reasons);
// weak [{ code: 'negation_inversion', level: 'weak', cites: [0], found: 'Power over Ethernet is not supported' }]
// weak [{ code: 'name_context', level: 'weak', fact: 'Marcus Hale', cites: [0], found: 'Priya Raman owns this specification' }]
```

- `negation_inversion`: the statement drops, adds or reverses the negation of the excerpt clause
  it matches, also through opposites (enabled and disabled, allowed and prohibited, increased and
  decreased, reachable and unreachable, erlaubt and verboten, gestiegen and gesunken). Always
  `weak`: reading negations by their words cannot tell every restatement of a negated rule
  ("prohibited until the update" → "only allowed after the update") from its reversal. Negations
  written differently ("unsupported", "no longer", "neither … nor", "may not", "darf … nicht")
  count as the same meaning; "no later than", "not … until", "only if", conditions ("reicht das
  nicht, …") and questions are not reversals, and clauses with different numbers are not
  compared.
- `name_context`: the passage the statement matches names someone or something else; the
  statement's name stands elsewhere in the excerpts or in none of them. Names the question gave
  (`given`) are not checked.
- `fact_context`: the excerpt has the value only next to other words ("75,000 EUR for
  infrastructure" when the excerpt says "95,000 EUR for infrastructure and 75,000 EUR for
  training"), with the passage where it stands in `found`.
- `name_missing`: in English statements, a name (a capitalised word inside the sentence, such as
  "Munich" or "Sarah") that none of the cited excerpts contains.

- `relation_inverted`, `relation_unsupported` (version 3): a relation between two values or two
  events that the excerpts give the other way round, or whose direction they give but not the
  stated factor or share. Changes ("rose", "fell", "doubled", "halved", "stieg", "sank", "from A
  to B", "up from A"), comparisons ("more / fewer / higher / lower … than", "twice as many … as",
  "mehr … als"), orders in time ("before", "after", "earlier than", "bevor", "nachdem") and values
  carried over from the statement before ("it rose to B", "es waren weniger, nämlich B") are
  checked when the excerpts bind both values or dates to their sides without ambiguity; negated
  and conditional clauses are left alone. Always `weak`. `report.relations` lists every relation
  compared, supported ones included.

These checks compare a statement with excerpts in its own language. Relations look at a statement
and the one before it, in answer order; a receipt records the checked statements in that order, so
it recomputes them too. `groundAnswer(blocks, sources, { version: 2 })` runs the rules of
`@starpi/core` 2.x with the same results (no relations); `{ version: 1 }` those of 1.x: no
`negation_inversion` or `name_context`, the earlier `fact_context`, and no version numbers as
facts. `GROUNDING_VERSIONS` lists the versions this release can run.

A **second opinion** for weak statements is available in code (`secondOpinions(report, sources,
engine)`): you pass an engine that classifies statement and passage pairs as entailed, neutral or
contradicted (an NLI model, or a judge model). It is advisory: it runs only on weak statements, a
contradiction keeps a statement weak with `second_opinion_contradiction`, and nothing turns a
verdict better. Receipts record second opinions in `secondOpinion` and relations in `relations`
(`receiptAdvisory(report)` gives both in the receipt's form).

Citations are recognised as `[Doc: <name>, Chunk: <n>]` labels (see `citationLabel`). Statements
inherit citations from their paragraph, from a lead-in line ending in a colon, or from a "Sources:"
line, and table rows are checked one by one. `given` holds the question and earlier turns: a value
found only there is reported as `from_conversation`. `blocksFromMarkdown` parses Markdown; the
Starpi app builds the same blocks from the rendered DOM instead.

Verdicts and reason codes:

| Verdict | Reason codes |
| --- | --- |
| `unsupported` | `missing_fact`, `uncited_missing`, `quote_missing`, `unknown_citation`, `not_delivered` |
| `weak` | `approximate`, `fact_elsewhere`, `fact_context`, `name_missing`, `name_context`, `negation_inversion`, `relation_inverted`, `relation_unsupported`, `uncited_found`, `from_conversation`, `low_overlap`, `label_mismatch`, a partial quotation |
| `supported` | none: every fact is in a cited excerpt and at least half of the content words appear there |
| `unchecked` | none: statement and excerpt are in different languages (facts only) and the statement has no facts |
| `neutral` | not counted: headings, short fragments, statements with neither a citation nor a fact |

## Create and verify receipts

```js
import { buildReceipt, chunkText, CHUNKER, EXTRACTOR, EXTRACTOR_COMPATIBLE, extractText, sha256Hex, validateReceipt, verifyReceipt } from '@starpi/core';

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
  compatible: EXTRACTOR_COMPATIBLE, // earlier extraction rules that give the same text
  extract: async (data, name) => {
    const r = await extractText(new File([data], name));
    return { text: r.text, pdfjs: r.pdfjs };
  },
});
console.log(result.summary); // { reproduced: 1, verifiable: 1 }
```

`verifyReceipt` checks the receipt hash, the answer hash and, per workspace excerpt, the file
fingerprint (files are matched by hash, not by name), the extracted text, the passage at the
recorded offsets and the chunk bounds, and recomputes the source check with the rules version the
receipt records. For a v2 or v3 receipt it also recomputes the Merkle root and checks every
inclusion proof (`result.merkle`, `result.citations[i].proof`) and the signature, if there is one
or the receipt names a signer (`result.signature`, `result.signer`). `buildReceipt(draft, { schema:
RECEIPT_SCHEMA_V2 })` or `RECEIPT_SCHEMA_V1` still writes an earlier format for verifiers that only
read those.

One citation can be checked against the root without the others:

```js
import { verifyCitationProof } from '@starpi/core';

const included = await verifyCitationProof(receipt.citations[2], 2, receipt.merkle); // true or false
```

### Sign receipts

The Starpi app signs the receipts it exports with a key of the device; a deployment that produces
receipts can sign them with a key it controls. Pass `{ signer: { keyId, alg } }` to `buildReceipt`
to name the key inside the receipt, so a removed or swapped signature is detected. Ed25519 and
ECDSA on P-256 (`ES256`) are supported, with WebCrypto only:

```bash
openssl genpkey -algorithm ed25519 -out signer-private.pem
openssl pkey -in signer-private.pem -pubout -out signer.pem   # publish this one
```

```js
import { readFileSync } from 'node:fs';
import { signReceipt, verifyReceiptSignature } from '@starpi/core';

const pem = readFileSync('signer-private.pem', 'utf8');
const der = Buffer.from(pem.replace(/-----[^-]+-----|\s+/g, ''), 'base64');
const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
const signed = await signReceipt(receipt, privateKey);

const check = await verifyReceiptSignature(signed, readFileSync('signer.pem', 'utf8'));
console.log(check); // { status: 'valid', alg: 'Ed25519', keyId: '…', trusted: true }
```

The signature covers the receipt id (and through it everything in the receipt) and the Merkle
root; it is not part of the id. `status` is `valid`, `invalid`, `unsigned`, `key_mismatch` (signed
with another key than the one you gave) or `unsupported_algorithm`; `trusted` is true only for a
key you supplied. `keyId` is the SHA-256 of the public key's SubjectPublicKeyInfo, the same as
`openssl pkey -pubin -in signer.pem -outform DER | sha256sum`. `importPublicKey` and `publicKeyId`
read JWK and PEM public keys.

### Command line

```bash
npx starpi-verify-receipt receipt.json plan.md --json            # with @starpi/core installed
npx -p @starpi/core starpi-verify-receipt receipt.json plan.md   # without installing it
npx -p @starpi/core -p pdfjs-dist@6 starpi-verify-receipt receipt.json plan.md notes.pdf   # with PDFs
```

Add `--public-key signer.pem` (PEM or JWK) to check who signed a receipt. Exit code 0 when every
workspace excerpt was reproduced (and, for v2, the Merkle tree and any signature are valid), 1
when something did not match, a file is missing or the receipt is not signed with the given key,
2 for a usage error or an invalid receipt.

## Check documents in CI

`starpi-ground` checks a Markdown document (release notes, generated documentation, an answer)
against source files with the same source check, and fails when a statement is not supported:

With `notes.md` holding two statements about the sample files of the Starpi repository
(`public/samples/en`):

```markdown
# Nebula status

The approved budget for Project Nebula is 480,000 EUR.
The public launch is planned for 12 June 2027.
```

```bash
npx --yes --package=@starpi/core@2 --package=pdfjs-dist@6 starpi-ground --answer notes.md --source public/samples/en
```

```text
notes.md:4:1 unsupported “The public launch is planned for 12 June 2027.”
    12 June 2027 is not in [Doc: nebula-kickoff.pdf, Chunk: 1], [Doc: nebula-plan.md, Chunk: 1], [Doc: nebula-plan.md, Chunk: 2] and 3 more excerpts.

2 statements checked against 6 excerpts from 3 files (citations: all): 1 supported, 0 weak, 1 unsupported, 0 unchecked
```

The plan says 12 May 2027; the command exits with 1. `pdfjs-dist` is needed only because the
sources include a PDF; a PDF that cannot be read stops the run with exit code 2 instead of being
left out.

Sources are read like the app reads them (Markdown, text, CSV, logs, JSON; PDF with the optional
`pdfjs-dist`), chunked into 500-character excerpts and labelled `[Doc: <file name>, Chunk: <n>]`;
a directory adds every supported file below it, except hidden ones and `node_modules`. A document
with citation labels is checked against the excerpts it cites; a document without labels compares
every statement with every excerpt (`--cite labels|all` overrides). Documents longer than the
check's limits are split at headings and paragraphs; a paragraph that is still too long is
reported as not checked and fails the run.

| Option | Values |
| --- | --- |
| `--format` | `text` (default), `json`, `sarif` (SARIF 2.1.0) |
| `--output` | write the report to a file instead of standard output |
| `--fail-on` | `unsupported` (default), `weak`, `never` |
| `--cite` | `auto` (default), `labels`, `all` |
| `--grounding` | the source-check rules: `3` (default, with relations), `2` or `1` give the output of the release that introduced them |

Exit code 0 when no statement is at or above the `--fail-on` level, 1 when one is, 2 for a usage
error or an unreadable file. In SARIF, every unsupported statement is an `error` and every weak one
a `warning`, at its line and column, with the reason as the rule and a fingerprint that stays the
same when the statement moves. In GitHub Actions (the job needs `security-events: write`):

```yaml
- run: npx --yes --package=@starpi/core@2 starpi-ground --answer docs/release-notes.md --source docs/spec --format sarif --output starpi.sarif
- uses: github/codeql-action/upload-sarif@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
  if: always()
  with:
    sarif_file: starpi.sarif
```

`checkDocument(markdown, sources)` and `toSarif(documents, tool)` do the same in code.

## Gate a streamed answer

```js
import { createSentenceGate, isReleased } from '@starpi/core';

const sources = [{ label: '[Doc: plan.md, Chunk: 1]', text: 'The approved budget is 480,000 EUR. The team has twelve members.' }];
const gate = createSentenceGate({ mode: 'sources', locale: 'en', sources });
const speak = (units) => units.filter(isReleased).forEach((u) => console.log(u.spoken, u.cites));

speak(gate.push('The team has 12 mem'));
speak(gate.push('bers [Doc: plan.md, Chunk: 1]. The budget is 520,000 EUR [Doc: plan.md, Chunk: 1]. '));
// The team has 12 members. [ 0 ]
const { released, withheld } = gate.end();
speak(released);
console.log(withheld.map((w) => [w.reason, w.token]));
// [ [ 'unsupported_number', '520,000' ] ]
```

The gate judges each unit once, as soon as it can no longer change: a sentence, or a whole list
item, table row, heading or code block. In `sources` mode every number, in digits or as a number
word ("twelve", "drei Viertel", "twice"), must appear with the same value in an excerpt the unit
cites; a form whose value depends on the convention ("1.200") must appear as written, and an
identifier ("ISO 9001", "IPv6", "GPT-4o") literally, in a cited excerpt or the question. Ordinals
and adverbs ("first", "once", "einmal") are never claims. `web` mode needs every number inside a
grounded segment with an http(s) source; `free` mode keeps only the rules that hold in every mode:
no links, and no characters outside the allowlist (other scripts, look-alike digits, invisible
characters). Released units are frozen and `isReleased` recognizes them, so a speech queue can
refuse anything else; `spoken` writes out abbreviations and units only when that changes no
number. `checkText(text, options)` judges a complete text, and `canonicalText`, `spokenText` and
`createSentenceReleaser` are the parts the gate is built from.

```sh
npx --yes --package=@starpi/core starpi-gate --text answer.md --source docs/ --format sarif --output gate.sarif
```

`starpi-gate` exits with 1 when it withholds a unit, 0 when it releases everything, 2 on a usage
error.

## Chunk and search

```js
import { BM25Index, chunkText, citationLabel } from '@starpi/core';

const docs = {
  'plan.md': 'The approved budget is 480,000 EUR. The public launch is planned for 12 May 2027.',
  'risks.md': 'R-01: The traffic data supplier delays its delivery. Owner: Marta Silva. R-02: Drivers reject the new app.',
};
const index = new BM25Index(); // Okapi BM25, k1 = 1.2, b = 0.75
for (const [name, text] of Object.entries(docs)) {
  const chunks = chunkText(text); // 500 characters, 50 overlap, breaks at paragraphs, sentences or words
  index.add(chunks.map((c) => ({ docId: name, docName: name, chunkIndex: c.index, start: c.start, end: c.end, text: c.text })));
}

for (const { chunk, score, matchedTerms } of index.search('supplier delays', 3)) {
  console.log(citationLabel(chunk.docName, chunk.chunkIndex + 1), score.toFixed(2), matchedTerms);
}
// [Doc: risks.md, Chunk: 1] 1.32 [ 'supplier', 'delays' ]
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
- `fuseRrf(rankings, { key, k, limit })`: reciprocal rank fusion, score = Σ 1 / (k + rank) with
  k = 60 (`RRF_K`) by default. `hybridSearch(index, vectors, question, vector, k)` fuses the BM25
  top 50 (`HYBRID_DEPTH`) with the cosine top 50 of a `VectorIndex` (int8 vectors from
  `quantizeInt8`); `probeIndex(index, question)` gives the normalised best BM25 score and the share
  of the question's terms in the best chunk.
- `sentenceSpans`, `splitSentences`: deterministic sentence splitting with offsets.
- `languagePack`, `LANGUAGES`, `registerLanguage`: the English and German language packs the
  checks and the gate read; a registered pack is validated, frozen and read from then on.
  `await loadShippedLanguages()` registers the French, Spanish, Italian and Turkish packs as well
  (`SHIPPED_LANGUAGES` lists all six); they leave English and German verdicts unchanged.
  `lowerCase(text, code)` lowercases as the language does (Turkish "I" → "ı", "İ" → "i").
- `GROUNDING`, `EXTRACTOR`, `CHUNKER`: the rule versions recorded in receipts; `GROUNDING_VERSIONS`
  lists the source-check versions `groundAnswer` can run, `REASON_CODES` (and `REASON_CODES_V1`,
  `REASON_CODES_V2`, `reasonCodes(version)`) the reason codes.
- `findRelations`, `changesIn`, `RELATIONS`, `applyRelations`: the relation check of version 3 on
  its own (statements and excerpts in, relations with verdicts out).
- `secondOpinions`, `eligible`, `premiseFor`, `nliResult`, `judgeResult`, `shownVerdict`,
  `ENTAIL`, `SECOND_OPINION_REASON`, `receiptAdvisory`: the rules of the advisory second opinion.

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
`EXTRACTOR`, `CHUNKER`), so a receipt says which rules produced it, and `verifyReceipt` recomputes
the source check with the version a receipt records. The receipt format has its own version
(`starpi.receipt/v2` since 2.0.0; v1 receipts are still read and can still be written). The
`pdfjs-dist` peer range follows the major version the app ships.
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
