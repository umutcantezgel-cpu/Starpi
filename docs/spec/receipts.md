# Answer receipts (`starpi.receipt/v2`)

An answer receipt is a JSON file that Starpi creates for one answer. It lists the excerpts the answer
was given (cited or not), with a SHA-256 fingerprint of every source file, the extraction and chunking rules, the exact
character offsets of each passage, and the verdicts of the source check. A Merkle tree over the
excerpts gives every citation an inclusion proof, and a receipt can carry a signature. Anyone who
has the same files can check that every workspace excerpt is an exact, unchanged passage of those
files: in the app (**Add knowledge › On-device workspace › Verify an answer receipt**, or the
**Receipt** button under an answer) or with the command-line verifier.

The format is implemented in [`src/js/core/receipt.js`](../../src/js/core/receipt.js) (with
[`merkle.js`](../../src/js/core/merkle.js) and [`signature.js`](../../src/js/core/signature.js))
and described by the JSON Schema [`receipt-v2.schema.json`](receipt-v2.schema.json). Receipts in
the first format, `starpi.receipt/v1`, are still read and verified; see [Version 1](#version-1). A
unit test keeps both schemas and the code in step.

## What a receipt shows, and what it does not

| A receipt shows | A receipt does not show |
| --- | --- |
| Each workspace excerpt is a passage of a file with the recorded fingerprint, at the recorded offsets, under the recorded extraction and chunking rules. | Who made it, unless it is signed and you check the signature with the signer's public key obtained from the signer. Anyone can write a well-formed receipt, and anyone can sign one with their own key. |
| The receipt was not edited after it was created: its `id` is the hash of its contents, and the Merkle root covers every citation. A signed receipt was not edited after it was signed. | Which excerpts a model actually read, or how it used them. `delivered` records what the app sent, not what the model attended to. |
| That one citation belongs to the receipt, from that citation alone: its inclusion proof leads to the Merkle root. | That the answer is correct. The source check compares numbers, dates, times, weekdays, codes, quotations and wording with the cited excerpts; a match does not make a statement true. |
| How each statement fared in the source check, and whether the same check still gives the same verdict. | Anything about excerpts from the shared knowledge base: they are recorded, marked `verifiable: false` and never counted as reproduced. |

## Example

A signed receipt for the answer "The approved budget for Project Nebula is 480,000 EUR" that cites
the first chunk of the sample file `public/samples/en/nebula-plan.md` (excerpt text shortened):

```json
{
  "schema": "starpi.receipt/v2",
  "id": "849c6516594c0b5ff4b0e49508d4c1068260b73c08359c3a14b4ff294277ead2",
  "createdAt": "2026-10-13T09:30:00.000Z",
  "generator": { "name": "starpi", "version": "2.0.0" },
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
      "chunk": { "index": 0, "start": 0, "end": 427, "sha256": "7a049fa1…4925e" },
      "proof": []
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
  },
  "merkle": { "alg": "sha256-rfc6962", "size": 1, "root": "f99102a2e18f07bd7ca75cc10a6bc480276261068ffb52290532981f103f1bca" },
  "signature": {
    "alg": "Ed25519",
    "keyId": "280157ae9935c93ef9d96ede3293bfc45166e80eaaa76d6bb7b92bee511c30ce",
    "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": "jbneUZQVb6QGrSwGV7xO7Gcrg-Q8aiDnPKg86szpFY0" },
    "value": "oAMg70OIIakkrk4934hqsPI-7VKBjC45n7pMtORueb2K4fcys84dyuArAkxgUDuESN7rjzU5PBM4BsKHaoBSAg"
  }
}
```

With one citation the tree is a single leaf: the root is that leaf's hash and the proof is empty.
For a Markdown or text file, `fileSha256` and `textSha256` are equal when the file is already
normalized (UTF-8, `\n` line ends, no control characters); for a PDF they always differ.

## Fields

### Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | `starpi.receipt/v2`, or `starpi.receipt/v1` for the first format. Another `starpi.receipt/…` value is rejected as an unsupported version. |
| `id` | hex SHA-256 | Hash of the canonical JSON of the receipt without `id` and `signature` (see [Canonical JSON](#canonical-json-and-the-receipt-id)). |
| `createdAt` | string | ISO 8601 time from the device clock. Not trusted: the clock of the device that wrote the receipt. |
| `generator` | object | `name` (`starpi`) and `version` (the app version). |
| `answer` | object | `text` (the answer as shown, reasoning blocks removed), `sha256` of that text, `engine` (`cloud`, `client`, `local` or `synthesizer`), `locale` (`en` or `de`). |
| `question` | object or null | `{ "text": … }`, or `null` when the question was left out on export. |
| `citations` | array | One entry per excerpt the answer was given, in context order (at most 64). |
| `grounding` | object or null | The source-check result, or `null` when no check ran. |
| `merkle` | object | `alg` (`sha256-rfc6962`), `size` (the number of citations) and `root`, the Merkle tree hash over the citations (see [Merkle tree](#merkle-tree-and-inclusion-proofs)). |
| `signature` | object, optional | `alg`, `keyId`, `publicKey` and `value` (see [Signatures](#signatures)). |

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
| `proof` | array of hex SHA-256 | The citation's audit path in the Merkle tree, from its sibling up (at most 6 hashes). |

### Source check record

`grounding.algorithm` names the checker and its version, and `grounding.counts` counts statements per
verdict. `grounding.sentences` lists every checked statement; statements the check skips (verdict
`neutral`, for example headings and short sentences with neither a citation nor a checkable fact)
are left out. Each sentence has:

- `text`: the statement as shown, citation labels removed;
- `cites`: indexes into `citations`;
- `citeSource`: where the citations came from: `own` (in the sentence), `block` (the nearest cited
  sentence of the same paragraph or list item, the following one first), `leadin` (a line ending in a colon before a list), `answer` (a
  "Sources:" line), or `null`;
- `verdict`: `supported`, `weak`, `unsupported` or `unchecked`;
- `reasons`: objects with `code`, `level` (`weak` or `unsupported`) and, depending on the code,
  `fact` (the value that was looked for), `cites`, `other` (citations where the value was found
  instead) and `found`. At most the first 20 reasons of a statement are recorded; they already
  decide its verdict.

Reason codes: `missing_fact`, `fact_elsewhere`, `fact_context`, `name_missing`, `uncited_found`,
`uncited_missing`, `low_overlap`, `unknown_citation`, `label_mismatch`, `quote_missing`,
`approximate`, `from_conversation` and `not_delivered`, and in format v2 also
`negation_inversion` (the statement reverses a negation of the excerpt) and `name_context` (the
passage the statement matches names someone or something else; `fact` is the statement's name).
For `fact_context`, `negation_inversion` and `name_context`, `found` holds the passage of the cited
excerpt the reason refers to (at most 160 characters). A v1 receipt with a v2 reason code is
refused. Their wording in the app is in `src/locales/*.json` under `grounding.reason_*`.

## Hashing and offsets

- SHA-256, written as 64 lowercase hex characters.
- Strings are hashed as UTF-8.
- `fileSha256` is taken over the file bytes **before** parsing (pdf.js takes ownership of the buffer
  it reads).
- `textSha256` is taken over the extracted, normalized text that the chunker received.
- `chunk.start` and `chunk.end` count UTF-16 code units in that text, i.e. JavaScript string
  indexes: `text.slice(start, end)` is the passage.

## Canonical JSON and the receipt id

`id` is the SHA-256 of the receipt without its `id` and `signature` members, serialized as
canonical JSON:

- object keys sorted by UTF-16 code units;
- no whitespace;
- members whose value is `undefined` dropped.

Receipts contain only strings, integers, booleans, `null`, arrays and objects. For such values this
serialization equals [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS), so any JCS library
reproduces the id. The id covers the Merkle tree and every proof. It detects a changed or truncated
receipt; it is not a signature, and signing a receipt does not change it.

## Merkle tree and inclusion proofs

The citations form a Merkle tree as defined in
[RFC 6962, section 2.1](https://www.rfc-editor.org/rfc/rfc6962#section-2.1) (the tree of
Certificate Transparency), with SHA-256:

- one leaf per citation, in the order of `citations`; `merkle.size` is their number;
- the leaf hash of a citation is SHA-256(`0x00` ‖ UTF-8 of the canonical JSON of the citation
  without `proof` and with `excerpt` reduced to `sha256` and `truncated`);
- an interior node is SHA-256(`0x01` ‖ left ‖ right); a tree of n > 1 leaves splits at the largest
  power of two smaller than n; a receipt without citations has the root SHA-256 of the empty string.

The excerpt text enters the leaf through its hash, so a receipt exported without excerpt texts has
the same root as one with them. `proof` is the citation's audit path
([RFC 6962, section 2.1.1](https://www.rfc-editor.org/rfc/rfc6962#section-2.1.1)), checked with the
algorithm of [RFC 9162, section 2.1.3.2](https://www.rfc-editor.org/rfc/rfc9162#section-2.1.3.2).
With it, one citation can be checked against the root without the other citations:

```js
import { verifyCitationProof } from '@starpi/core';

// citation: one entry of receipt.citations, index: its position, receipt.merkle: { alg, size, root }
const included = await verifyCitationProof(citation, index, receipt.merkle);
```

Because a signature covers the root and the size (see below), a citation with its proof, together
with the receipt's `id`, `merkle` and `signature`, shows that this excerpt is part of the receipt
the key signed, without disclosing the other excerpts. The unit tests check the tree against the
Certificate Transparency test vectors and against an independent implementation for 0 to 64 leaves.

## Signatures

A v2 receipt can be signed with Ed25519 ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)) or
with ECDSA on P-256 with SHA-256 (`ES256`), using WebCrypto. The app does not sign the receipts it
writes; signatures are for a deployment that produces receipts with a key it controls, through
`signReceipt` in `@starpi/core`.

| Field | Meaning |
| --- | --- |
| `alg` | `Ed25519` or `ES256`. |
| `keyId` | SHA-256 of the public key in SubjectPublicKeyInfo (DER) form, the same value as `openssl pkey -pubin -in key.pem -outform DER \| sha256sum`. |
| `publicKey` | The public key as a JWK with its public members only: `kty` `OKP`, `crv` `Ed25519`, `x`; or `kty` `EC`, `crv` `P-256`, `x`, `y`. |
| `value` | The 64-byte signature, base64url without padding (86 characters). For `ES256` it is r ‖ s (IEEE P1363), the form WebCrypto produces. |

The signature is over the UTF-8 bytes of

```text
starpi.receipt/v2 signature\n + canonical JSON of { "alg", "id", "keyId", "merkle" }
```

so it covers the id (and through it everything in the receipt), the Merkle root and size, the
algorithm and the key id. Signing again replaces the signature; ECDSA signatures differ each time
they are made, and each one verifies.

`verifyReceiptSignature(receipt, publicKey?)` recomputes the id and the Merkle root and checks the
signature. It returns a status and `trusted`:

| Status | Meaning |
| --- | --- |
| `valid` | The signature verifies, and the id and root match the receipt's contents. |
| `invalid` | The receipt was changed after signing, or the signature, its key id or its embedded key is wrong. |
| `unsigned` | The receipt has no signature (always for v1). |
| `key_mismatch` | You gave a public key, and the receipt was signed with another one. |
| `unsupported_algorithm` | This runtime cannot check the algorithm, e.g. a browser without Ed25519 in WebCrypto. |

`trusted` is `true` only for a valid signature checked with a public key you supplied. Without
one, the key embedded in the receipt is used: that shows the receipt is unchanged since it was
signed with the key `keyId` names, not who holds that key. Compare the key id with one the signer
published, or pass the signer's key.

Signing with a key made by OpenSSL, in Node 22:

```bash
openssl genpkey -algorithm ed25519 -out signer-private.pem
openssl pkey -in signer-private.pem -pubout -out signer.pem   # publish this one
```

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { signReceipt } from '@starpi/core';

const receipt = JSON.parse(readFileSync('receipt.json', 'utf8'));
const pem = readFileSync('signer-private.pem', 'utf8');
const der = Buffer.from(pem.replace(/-----[^-]+-----|\s+/g, ''), 'base64');
const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
writeFileSync('receipt.signed.json', JSON.stringify(await signReceipt(receipt, privateKey), null, 2));
```

For P-256 use `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256` and
`{ name: 'ECDSA', namedCurve: 'P-256' }`. A private key that cannot be exported needs its public key
as well: `signReceipt(receipt, privateKey, { publicKey })`. Check the result with
`starpi-verify-receipt receipt.signed.json <files> --public-key signer.pem`.

## Versions

A receipt can only be reproduced with the rules that created it, so each rule set has an id and a
version:

| Rules | Recorded as | Current |
| --- | --- | --- |
| Receipt format ([`src/js/core/receipt.js`](../../src/js/core/receipt.js)) | `schema` | `starpi.receipt/v2`; v1 is still read and verified |
| Text extraction (`extractText`, [`src/js/rag/parser.js`](../../src/js/rag/parser.js)) | `document.extractor` | `starpi-extract` 1, plus the pdf.js version for PDFs |
| Chunking (`chunkText`, [`src/js/rag/chunker.js`](../../src/js/rag/chunker.js)) | `document.chunker` | `starpi-chunk` 1, size 500, overlap 50 |
| Source check ([`src/js/core/grounding.js`](../../src/js/core/grounding.js)) | `grounding.algorithm` | `starpi-grounding` 2; version 1 can still be run |

Golden tests (`tests/unit/golden.test.mjs`) pin the output of the last three: extraction and chunking of
the sample files, and the verdicts and reasons of the source check on every statement of the
labelled answers in `tests/fixtures/grounding/` (version 1 on the 308 answers of `eval.json`,
version 2 on the answer sets listed in [`docs/eval/v2-protocol.md`](../eval/v2-protocol.md)). A
change that alters their output must bump the version, so an old receipt is reported as "made
with other rules" instead of failing without explanation. An incompatible change of the receipt
format itself gets a new `schema` value.

The source check keeps every earlier version it can still run (`GROUNDING_VERSIONS`): the
verifier recomputes a receipt with the version the receipt records, so a receipt made by Starpi
1.x (`starpi-grounding` 1) is recomputed with the rules of 1.x. Only a version the verifier does
not know is recomputed with the current rules, with a warning.

### Version 1

`starpi.receipt/v1`, written by Starpi 1.1 to 1.3, has no `merkle`, no `proof` and no `signature`;
its `id` is the hash of the receipt without `id`. It is described by
[`receipt.schema.json`](receipt.schema.json). The verifier checks v1 receipts with their own list of
members, so a v1 receipt that carries a Merkle tree, a proof or a signature is refused, and reports
them without a tree and as not signed. `buildReceipt(draft, { schema: RECEIPT_SCHEMA_V1 })` still
writes v1 for verifiers that only read v1. A receipt written by the released 1.3.0 code is kept in
`tests/fixtures/receipts/` and verified by the unit tests.

## Verifying a receipt

The verifier first checks the receipt against the schema and its size limits, then:

1. **Receipt**: recomputes `id` and `answer.sha256`; for v2, recomputes the Merkle root from the
   citations, checks every citation's inclusion proof and, if the receipt is signed, the signature.
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
the receipt and the original files, and for a signed receipt optionally the signer's public key;
everything is read and checked in the ingest worker on the device. The result lists every citation
with its checks, "n/n workspace excerpts reproduced from your files", the Merkle tree and the
signature, and any differences in the source check.

### On the command line

```bash
npm run verify:receipt -- receipt.json plan.pdf notes.md
node scripts/verify-receipt.mjs receipt.json plan.pdf notes.md --public-key signer.pem --json
npx -p @starpi/core starpi-verify-receipt receipt.json plan.pdf notes.md
```

```text
receipt 849c6516594c0b5f… (2026-10-13T09:30:00.000Z, cloud)
ok   receipt hash matches its contents
ok   answer hash matches the answer text
ok   Merkle root over 1 citation matches, 1/1 inclusion proofs valid
ok   signature valid (Ed25519, key 280157ae9935c93e…, the public key you gave)
ok   [Doc: nebula-plan.md, Chunk: 1]: file match (nebula-plan.md), text match, passage match, chunk match

1/1 workspace excerpts reproduced from the given files
source check recomputed for 1 statements: same verdicts as recorded
```

The verifier uses the same extraction and chunking code as the app. It warns when the recorded pdf.js
version differs from the installed one. `--public-key` takes a public key file as a JWK or as PEM
(`-----BEGIN PUBLIC KEY-----`); a file with a private key is refused.

| Exit code | Meaning |
| --- | --- |
| 0 | The receipt hash and answer hash match, every workspace excerpt was reproduced, the Merkle root and every proof match (v2), and a signature, if present, is valid. |
| 1 | Something did not match, a file with a recorded fingerprint was not given, or a public key was given and the receipt is not signed with it. |
| 2 | Usage error, unreadable file or key, or not a valid receipt. |

`--json` prints the full report (`ok`, `receipt`, `schema`, `idMatches`, `answerMatches`,
`citations`, `summary`, `grounding`, `merkle`, `signature`, `warnings`).

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
| Inclusion proof | 6 hashes per citation |
| Checked statements | 500, each at most 20,000 characters with at most 20 reasons |
| Answer text | 200,000 characters |
| Question text | 10,000 characters |
| Excerpt text | 20,000 characters |
| Labels and document names | 600 characters |
| Signature | 86 base64url characters; key coordinates 43 |
| Other strings | 1,000 characters or less, depending on the field |

A receipt above a limit, or with a field of the wrong type, is rejected with the path of the first
problem (for example `citations[2].chunk.end`).
