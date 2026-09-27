# Answer receipts (`starpi.receipt/v1`)

An answer receipt is a JSON file that Starpi creates for one answer. It lists the excerpts the answer
cited, with a SHA-256 fingerprint of every source file, the extraction and chunking rules, the exact
character offsets of each passage, and the verdicts of the source check. Anyone who has the same
files can check that every cited workspace excerpt is an exact, unchanged passage of those files:
in the app (**Add knowledge › On-device workspace › Verify an answer receipt**, or the **Receipt**
button under an answer) or with the command-line verifier.

The format is implemented in [`src/js/core/receipt.js`](../../src/js/core/receipt.js) and described
by the JSON Schema [`receipt.schema.json`](receipt.schema.json). A unit test keeps the schema and
the code in step.

## What a receipt shows, and what it does not

| A receipt shows | A receipt does not show |
| --- | --- |
| Each workspace excerpt is a passage of a file with the recorded fingerprint, at the recorded offsets, under the recorded extraction and chunking rules. | That Starpi wrote the answer. Receipts are **not signed**; anyone can write a well-formed receipt. |
| The receipt was not edited after it was created: its `id` is the hash of its contents. | Which excerpts a model actually read, or how it used them. `delivered` records what the app sent, not what the model attended to. |
| How each statement fared in the source check, and whether the same check still gives the same verdict. | That the answer is correct. The source check compares numbers, dates, times, weekdays, codes, quotations and wording with the cited excerpts; a match does not make a statement true. |
| | Anything about excerpts from the shared knowledge base: they are recorded, marked `verifiable: false` and never counted as reproduced. |

## Example

A receipt for the answer "The approved budget for Project Nebula is 480,000 EUR" that cites the
first chunk of the sample file `public/samples/en/nebula-plan.md` (excerpt text shortened):

```json
{
  "schema": "starpi.receipt/v1",
  "id": "aaa5cdffa7c3a15a6456c690fd8555829bcd14aa22d33df3d625081d17fb76db",
  "createdAt": "2026-09-24T09:30:00.000Z",
  "generator": { "name": "starpi", "version": "1.1.0" },
  "answer": {
    "text": "The approved budget for Project Nebula is 480,000 EUR [Doc: nebula-plan.md, Chunk: 1].",
    "sha256": "14550547ad6be5300b154c834a7ae96f0d6c26de984a49b974b32df736442f8e",
    "engine": "cloud",
    "locale": "en"
  },
  "question": { "text": "What is the approved budget?" },
  "citations": [
    {
      "label": "[Doc: nebula-plan.md, Chunk: 1]",
      "doc": "nebula-plan.md",
      "heading": "",
      "source": "workspace",
      "delivered": "full",
      "excerpt": { "text": "# Project Nebula: project plan …", "sha256": "7a049fa1…4925e", "truncated": false },
      "verifiable": true,
      "document": {
        "name": "nebula-plan.md",
        "kind": "md",
        "bytes": 1028,
        "fileSha256": "669f7c82…ab7a5",
        "textSha256": "669f7c82…ab7a5",
        "textChars": 1028,
        "pages": null,
        "extractor": { "id": "starpi-extract", "version": 1, "pdfjs": null },
        "chunker": { "id": "starpi-chunk", "version": 1, "size": 500, "overlap": 50 }
      },
      "chunk": { "index": 0, "start": 0, "end": 427, "sha256": "7a049fa1…4925e" }
    }
  ],
  "grounding": {
    "algorithm": { "id": "starpi-grounding", "version": 1 },
    "counts": { "supported": 1, "weak": 0, "unsupported": 0, "unchecked": 0 },
    "sentences": [
      {
        "text": "The approved budget for Project Nebula is 480,000 EUR.",
        "cites": [0],
        "citeSource": "own",
        "verdict": "supported",
        "reasons": []
      }
    ]
  }
}
```

For a Markdown or text file, `fileSha256` and `textSha256` are equal when the file is already
normalized (UTF-8, `\n` line ends, no control characters); for a PDF they always differ.

## Fields

### Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | Always `starpi.receipt/v1`. A different `starpi.receipt/…` value is rejected as an unsupported version. |
| `id` | hex SHA-256 | Hash of the canonical JSON of the receipt without `id` (see [Canonical JSON](#canonical-json-and-the-receipt-id)). |
| `createdAt` | string | ISO 8601 time from the device clock. Not trusted: the clock of the device that wrote the receipt. |
| `generator` | object | `name` (`starpi`) and `version` (the app version). |
| `answer` | object | `text` (the answer as shown, reasoning blocks removed), `sha256` of that text, `engine` (`cloud`, `client`, `local` or `synthesizer`), `locale` (`en` or `de`). |
| `question` | object or null | `{ "text": … }`, or `null` when the question was left out on export. |
| `citations` | array | One entry per excerpt the answer was given, in context order (at most 64). |
| `grounding` | object or null | The source-check result, or `null` when no check ran. |

### Citation

| Field | Type | Meaning |
| --- | --- | --- |
| `label` | string | The citation label, e.g. `[Doc: plan.pdf, Chunk: 3]`. |
| `doc`, `heading` | string | Document name as used in the label, and the section heading (knowledge base) or `""`. |
| `source` | `workspace` or `knowledge` | Where the excerpt came from. |
| `delivered` | `full`, `partial` or `omitted` | How much of the excerpt reached the model after the app fitted the context to the model's budget. Extractive answers always have `full`. |
| `deliveredChars` | integer, optional | Only with `partial`: how many of the excerpt's first characters reached the model. The source check of the answer ran on exactly that part. |
| `excerpt` | object | `text` (the excerpt, or `null` when excerpts were left out on export), `sha256` of the excerpt text, `truncated` (the excerpt was shortened to 1,600 characters and ends with `…`). |
| `verifiable` | boolean | `true` for a workspace excerpt with a file fingerprint and chunk offsets. |
| `document` | object | Workspace only: `name`, `kind` (`pdf`, `md`, `txt`, `csv`, `json`, `log`), `bytes`, `fileSha256` (null where WebCrypto is unavailable), `textSha256`, `textChars`, `pages` (PDF) or `null`, `extractor` and `chunker` (see [Versions](#versions)). |
| `chunk` | object | Workspace only: `index` (0-based), `start` and `end` offsets in the extracted text, and `sha256` of the passage (null for a truncated excerpt). |
| `knowledge` | object | Knowledge base only: `documentId`, or `null`. |

### Source check record

`grounding.algorithm` names the checker and its version, and `grounding.counts` counts statements per
verdict. `grounding.sentences` lists every checked statement; statements the check skips (verdict
`neutral`, for example headings and short sentences with neither a citation nor a checkable fact)
are left out. Each sentence has:

- `text`: the statement as shown, citation labels removed;
- `cites`: indexes into `citations`;
- `citeSource`: where the citations came from: `own` (in the sentence), `block` (earlier in the
  same paragraph or list item), `leadin` (a line ending in a colon before a list), `answer` (a
  "Sources:" line), or `null`;
- `verdict`: `supported`, `weak`, `unsupported` or `unchecked`;
- `reasons`: objects with `code`, `level` (`weak` or `unsupported`) and, depending on the code,
  `fact` (the value that was looked for), `cites`, `other` (citations where the value was found
  instead) and `found`. At most the first 20 reasons of a statement are recorded; they already
  decide its verdict.

Reason codes: `missing_fact`, `fact_elsewhere`, `fact_context`, `name_missing`, `uncited_found`,
`uncited_missing`, `low_overlap`, `unknown_citation`, `label_mismatch`, `quote_missing`,
`approximate`, `from_conversation` and `not_delivered`. For `fact_context`, `found` holds the
passage of the cited excerpt where the value stands (at most 160 characters). Their wording in the
app is in `src/locales/*.json` under `grounding.reason_*`.

## Hashing and offsets

- SHA-256, written as 64 lowercase hex characters.
- Strings are hashed as UTF-8.
- `fileSha256` is taken over the file bytes **before** parsing (pdf.js takes ownership of the buffer
  it reads).
- `textSha256` is taken over the extracted, normalized text that the chunker received.
- `chunk.start` and `chunk.end` count UTF-16 code units in that text, i.e. JavaScript string
  indexes: `text.slice(start, end)` is the passage.

## Canonical JSON and the receipt id

`id` is the SHA-256 of the receipt without its `id` member, serialized as canonical JSON:

- object keys sorted by UTF-16 code units;
- no whitespace;
- members whose value is `undefined` dropped.

Receipts contain only strings, integers, booleans, `null`, arrays and objects. For such values this
serialization equals [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS), so any JCS library
reproduces the id. The id detects a changed or truncated receipt; it is not a signature.

## Versions

A receipt can only be reproduced with the rules that created it, so each rule set has an id and a
version:

| Rules | Recorded as | Current |
| --- | --- | --- |
| Text extraction (`extractText`, [`src/js/rag/parser.js`](../../src/js/rag/parser.js)) | `document.extractor` | `starpi-extract` 1, plus the pdf.js version for PDFs |
| Chunking (`chunkText`, [`src/js/rag/chunker.js`](../../src/js/rag/chunker.js)) | `document.chunker` | `starpi-chunk` 1, size 500, overlap 50 |
| Source check ([`src/js/core/grounding.js`](../../src/js/core/grounding.js)) | `grounding.algorithm` | `starpi-grounding` 1 |

Golden tests (`tests/unit/golden.test.mjs`) pin the output of all three. A change that alters their
output must bump the version, so an old receipt is reported as "made with other rules" instead of
failing without explanation. An incompatible change of the receipt format itself gets a new
`schema` value.

## Verifying a receipt

The verifier first checks the receipt against the schema and its size limits, then:

1. **Receipt**: recomputes `id` and `answer.sha256`.
2. **L0, file**: hashes every file provided and looks for the recorded `fileSha256`. Files are
   matched by fingerprint, never by name, so a renamed copy still matches and a changed file with
   the same name does not.
3. **L1, text**: extracts the matching file with the current rules and compares `textSha256`. When
   the rules differ from the recorded ones the result is `version_differs`, not `mismatch`.
4. **L2, passage**: hashes `text.slice(start, end)` and compares it with `chunk.sha256` (or the
   excerpt hash). This is the check that counts: an excerpt is **reproduced** when its file matches
   and its passage matches. If the excerpt text occurs elsewhere in the text (ignoring whitespace),
   the result is `moved`.
5. **L3, chunk**: chunks the text with the recorded size and overlap and compares the bounds of the
   recorded chunk.
6. **Source check**: recomputes the verdict of every statement whose cited excerpts are available
   and lists the statements whose verdict differs. For a partly delivered excerpt it uses the first
   `deliveredChars` characters; without that field, statements citing it are not recomputed. Verdicts that depended on earlier chat turns
   (`from_conversation`) cannot be reproduced, because receipts do not contain the conversation.

Knowledge-base excerpts are reported as not verifiable. An excerpt whose text does not match its
own fingerprint is reported in every case.

### In the app

**Add knowledge › On-device workspace › Verify an answer receipt** opens the receipt dialog. Choose
the receipt and the original files; everything is read and checked in the ingest worker on the
device. The result lists every citation with its checks, "n/n workspace excerpts reproduced from
your files", and any differences in the source check.

### On the command line

```bash
npm run verify:receipt -- receipt.json plan.pdf notes.md
node scripts/verify-receipt.mjs receipt.json plan.pdf notes.md --json
```

```text
receipt aaa5cdffa7c3a15a… (2026-09-24T09:30:00.000Z, cloud)
ok   receipt hash matches its contents
ok   answer hash matches the answer text
ok   [Doc: nebula-plan.md, Chunk: 1]: file match (nebula-plan.md), text match, passage match, chunk match

1/1 workspace excerpts reproduced from the given files
source check recomputed for 1 statements: same verdicts as recorded
```

The verifier uses the same extraction and chunking code as the app. It warns when the recorded pdf.js
version differs from the installed one.

| Exit code | Meaning |
| --- | --- |
| 0 | The receipt hash and answer hash match, and every workspace excerpt was reproduced. |
| 1 | Something did not match, or a file with a recorded fingerprint was not given. |
| 2 | Usage error, unreadable file, or not a valid receipt. |

`--json` prints the full report (`ok`, `receipt`, `idMatches`, `answerMatches`, `citations`,
`summary`, `grounding`, `warnings`).

## Privacy

A receipt contains the answer and, unless left out on export, the question and the excerpt texts.
Its fingerprints identify the source files: whoever has a file can tell that it was the source,
even if the excerpts are left out. The app never uploads a receipt. It keeps receipt drafts only in
memory for the current page (at most 50) and writes a file only when you choose **Download
receipt**.

## Limits

| Limit | Value |
| --- | --- |
| Receipt file | 2,000,000 bytes |
| Citations | 64 |
| Checked statements | 500, each at most 20,000 characters with at most 20 reasons |
| Answer text | 200,000 characters |
| Question text | 10,000 characters |
| Excerpt text | 20,000 characters |
| Labels and document names | 600 characters |
| Other strings | 1,000 characters or less, depending on the field |

A receipt above a limit, or with a field of the wrong type, is rejected with the path of the first
problem (for example `citations[2].chunk.end`).
