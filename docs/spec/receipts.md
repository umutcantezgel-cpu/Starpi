# Answer receipts (`starpi.receipt/v3`)

An answer receipt is a JSON file that Starpi creates for one answer. It lists the excerpts the answer
was given (cited or not), with a SHA-256 fingerprint of every source file, the extraction and chunking rules, the exact
character offsets of each passage, and the verdicts of the source check. A Merkle tree over the
excerpts gives every citation an inclusion proof, and a receipt can carry a signature: the app signs
the receipts it exports with a key of the device (**Settings › Trust**). Anyone who
has the same files can check that every workspace excerpt is an exact, unchanged passage of those
files: in the app (**Add knowledge › On-device workspace › Verify an answer receipt**, or the
**Receipt** button under an answer) or with the command-line verifier.

The format is implemented in [`src/js/core/receipt.js`](../../src/js/core/receipt.js) (with
[`merkle.js`](../../src/js/core/merkle.js) and [`signature.js`](../../src/js/core/signature.js))
and described by the JSON Schema [`receipt-v3.schema.json`](receipt-v3.schema.json). Receipts in
the earlier formats, `starpi.receipt/v2` ([`receipt-v2.schema.json`](receipt-v2.schema.json)) and
`starpi.receipt/v1` ([`receipt.schema.json`](receipt.schema.json)), are still read and verified;
see [Earlier formats](#earlier-formats). A unit test keeps the three schemas and the code in step.

## What a receipt shows, and what it does not

| A receipt shows | A receipt does not show |
| --- | --- |
| Each workspace excerpt is a passage of a file with the recorded fingerprint, at the recorded offsets, under the recorded extraction and chunking rules. | Who made it, unless it is signed and you check the signature with the signer's public key obtained from the signer. Anyone can write a well-formed receipt, and anyone can sign one with their own key. |
| The receipt was not edited after it was created: its `id` is the hash of its contents, and the Merkle root covers every citation. A signed receipt was not edited after it was signed, and a receipt that names its signer was not stripped of its signature or re-signed with another key. | Which excerpts a model actually read, or how it used them. `delivered` records what the app sent, not what the model attended to. |
| That one citation belongs to the receipt, from that citation alone: its inclusion proof leads to the Merkle root. | That the answer is correct. The source check compares numbers, dates, times, weekdays, codes, quotations and wording with the cited excerpts; a match does not make a statement true. |
| How each statement fared in the source check, and whether the same check still gives the same verdict. | Anything about excerpts from the shared knowledge base: they are recorded, marked `verifiable: false` and never counted as reproduced. The same holds for text that OCR recognised in an image: only the image's fingerprint can be checked. |
| What the sentence gate, second opinions and relation checks recorded for the answer (v3). | That those records are right: the verifier shows them as recorded and does not recompute them. |

## Example

A signed receipt for the answer "The approved budget for Project Nebula is 480,000 EUR" that cites
the first chunk of the sample file `public/samples/en/nebula-plan.md` (excerpt text shortened):

```json
{
  "schema": "starpi.receipt/v3",
  "id": "fa9960d0fa84d2af717f2929abe1135bbf5c65c165813c79dc2acdf235449fe8",
  "createdAt": "2026-10-17T09:30:00.000Z",
  "generator": { "name": "starpi", "version": "3.0.0" },
  "signer": { "keyId": "7f2c309fe627139c4cfa69fea8722be6be5ff1b72d8c32ca7d5a63528ad1b32d", "alg": "Ed25519" },
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
        "extractor": { "id": "starpi-extract", "version": 2, "pdfjs": null },
        "chunker": { "id": "starpi-chunk", "version": 1, "size": 500, "overlap": 50 }
      },
      "chunk": { "index": 0, "start": 0, "end": 427, "sha256": "7a049fa1…4925e" },
      "proof": []
    }
  ],
  "grounding": {
    "algorithm": { "id": "starpi-grounding", "version": 2 },
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
  "gate": { "mode": "sources", "released": 1, "withheld": 0 },
  "merkle": { "alg": "sha256-rfc6962", "size": 1, "root": "44d4876a48448acf1568b82bc7a2c4e8ba2aa5cda0a5176a69ace9ae88ec07f7" },
  "signature": {
    "alg": "Ed25519",
    "keyId": "7f2c309fe627139c4cfa69fea8722be6be5ff1b72d8c32ca7d5a63528ad1b32d",
    "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": "Npk33WGXS07hlw4pS3lYXUQvrFidKny1Ht-BxuB0Hs0" },
    "value": "KhUBUZFHIOiicy0J6x41jCEdYTF-Imc5WlPUA5SSOOpUN2PJucFgokmV4dZsM17eavyV0dZXGqaZa2uH7ElbCw"
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
| `schema` | string | `starpi.receipt/v3`, or `starpi.receipt/v2` and `starpi.receipt/v1` for the earlier formats. Another `starpi.receipt/…` value is rejected as an unsupported version. |
| `id` | hex SHA-256 | Hash of the canonical JSON of the receipt without `id` and `signature` (see [Canonical JSON](#canonical-json-and-the-receipt-id)). |
| `createdAt` | string | ISO 8601 time from the device clock. Not trusted: the clock of the device that wrote the receipt. |
| `generator` | object | `name` (`starpi`) and `version` (the app version). |
| `signer` | object, optional | `keyId` and `alg` of the key the receipt is meant to be signed with (see [Signer](#signer)). |
| `answer` | object | `text` (the answer as shown, reasoning blocks removed), `sha256` of that text, `engine` (`cloud`, `client`, `wasm`, `local`, `nvidia` or `synthesizer`), `locale` (`en` or `de`). |
| `question` | object or null | `{ "text": … }`, or `null` when the question was left out on export. |
| `citations` | array | One entry per excerpt the answer was given, in context order (at most 64). |
| `grounding` | object or null | The source-check result, or `null` when no check ran. |
| `gate` | object, optional | What the sentence gate let through: `mode` (`sources`, `web` or `free`), and how many sentences it `released` and `withheld`. |
| `secondOpinion` | array, optional | Advisory second checks of single statements (see [Second opinions](#second-opinions)); at most 500. |
| `relations` | array, optional | Relations between statements checked against the excerpts (see [Relations](#relations)); at most 500. |
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
| `verifiable` | boolean | `true` for a workspace excerpt with a file fingerprint and chunk offsets whose text the extractor can produce again (not OCR text). |
| `document` | object | Workspace only: `name`, `kind` (`pdf`, `md`, `txt`, `csv`, `json`, `log`, `docx`, `xlsx`, `pptx`, `html`; `png`, `jpg`, `gif` or `webp` for text recognised by OCR), `bytes`, `fileSha256` (null where WebCrypto is unavailable), `textSha256`, `textChars`, `pages` (PDF) or `null`, `extractor` and `chunker` (see [Versions](#versions)). |
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
`approximate`, `from_conversation` and `not_delivered`, and in formats v2 and v3 also
`negation_inversion` (the statement reverses a negation of the excerpt) and `name_context` (the
passage the statement matches names someone or something else; `fact` is the statement's name).
For `fact_context`, `negation_inversion` and `name_context`, `found` holds the passage of the cited
excerpt the reason refers to (at most 160 characters). A v1 receipt with a v2 reason code is
refused. Their wording in the app is in `src/locales/*.json` under `grounding.reason_*`.

### Text from OCR

An image holds no text the extractor can read; its text comes from text recognition (OCR) by a
model, which the user agrees to per file. In v3, `document.extractor` of such a file has an `ocr`
member with the `provider` and `model` that recognised it:

```json
"extractor": { "id": "starpi-extract", "version": 2, "pdfjs": null, "ocr": { "provider": "example-provider", "model": "example-vision-model" } }
```

The same image can give different text on another run or with another model, so the verifier does
not extract it again: it checks the image's fingerprint and reports the text as `ocr`. Such
citations are written with `verifiable: false` and are not counted as reproduced; a missing image
still fails. v1 and v2 cannot record OCR text.

### Signer

`signer` names the key a receipt is meant to be signed with: `keyId` (as in the signature) and
`alg`. Unlike `signature` it is part of the `id`, so it is covered by the Merkle-root signature as
well. A receipt that names a signer verifies only with a valid signature by exactly that key:
without a signature the status is `missing` (it was removed), with a signature by another key it is
`invalid`. The app writes `signer` when "Sign exported receipts" is on. `signReceipt` refuses to sign
a receipt that names another key.

### Gate

`gate` records the sentence gate of the answer as it ran: its `mode` and the number of sentences it
released and withheld. The verifier shows it as recorded.

### Second opinions

Each entry of `secondOpinion` is an advisory check of one statement against its excerpts:

| Field | Meaning |
| --- | --- |
| `sentence` | Index into `grounding.sentences`. |
| `cites` | The citations the statement was checked against. |
| `engine` | `nli` (an entailment model on the device) or `judge` (a model asked to judge). |
| `model` | The model, at most 100 characters. |
| `result` | `entailed`, `neutral` or `contradicted`. |

A second opinion never changes a verdict and is never counted as a source check. The verifier
counts the entries and the contradictions and does not recompute them.

### Relations

Each entry of `relations` is a relation one or two statements state, checked against the cited
excerpts:

| Field | Meaning |
| --- | --- |
| `kind` | `comparative` (higher, lower, more, less, a multiple or a share), `temporal` (before or after) or `reference` (a value carried over from an earlier statement). |
| `sentences` | One or two indexes into `grounding.sentences`. |
| `cites` | The citations it was checked against. |
| `verdict` | `supported`, `inverted` (the excerpts state the opposite) or `unsupported`. |
| `text` | The words that state the relation, at most 500 characters. |

The entries themselves are shown as recorded. With version 3 of the source check, a relation that
is `inverted` or `unsupported` is also a reason of its last statement (`relation_inverted`,
`relation_unsupported`); those reasons, and the verdicts they give, are recomputed like every other
reason, over the recorded statements in their order. A statement whose relation rests on a citation
that cannot be reproduced is not recomputed.

## Hashing and offsets

- SHA-256, written as 64 lowercase hex characters.
- Strings are hashed as UTF-8.
- `fileSha256` is taken over the file bytes **before** parsing (pdf.js takes ownership of the buffer
  it reads).
- `textSha256` is taken over the extracted, normalized text that the chunker received.
- `chunk.start` and `chunk.end` count UTF-16 code units in that text, i.e. JavaScript string
  indexes: `text.slice(start, end)` is the passage.

## Canonical JSON and the receipt id

`id` is the SHA-256 of the receipt without its `id` and `signature` members (a `signer` member is
included), serialized as canonical JSON:

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

A v3 or v2 receipt can be signed with Ed25519 ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)) or
with ECDSA on P-256 with SHA-256 (`ES256`), using WebCrypto.

**In the app.** **Settings › Trust** holds one signing key per device: Ed25519, or P-256 in a
browser without Ed25519. WebCrypto makes it non-extractable and IndexedDB keeps the key handle, so
the private key never exists as bytes the page could read or send. With **Sign exported receipts**
(on by default) every downloaded receipt names the key as its `signer` and carries its signature;
the receipt dialog says which key signs. The same view exports the public key as a JWK (with the
key id as `kid`) or a PEM file, makes a new key (the old one never signs again; its public key stays
exportable) and deletes keys. Give the public key to whoever checks your receipts: only a key
obtained from you shows that your device signed. In a private window the key lasts as long as the
page.

**Elsewhere.** A deployment can sign receipts with a key it controls through `signReceipt` in
`@starpi/core`.

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

for both formats (the id covers `schema`, so a v2 signature cannot be passed off as a v3 one), so it
covers the id (and through it everything in the receipt, a `signer` included), the Merkle root and
size, the algorithm and the key id. Signing again replaces the signature; ECDSA signatures differ each time
they are made, and each one verifies.

`verifyReceiptSignature(receipt, publicKey?)` recomputes the id and the Merkle root and checks the
signature. It returns a status and `trusted`:

| Status | Meaning |
| --- | --- |
| `valid` | The signature verifies, and the id and root match the receipt's contents. |
| `invalid` | The receipt was changed after signing, the signature, its key id or its embedded key is wrong, or a v3 receipt was signed with another key than the `signer` it names. |
| `unsigned` | The receipt has no signature (always for v1). |
| `missing` | A v3 receipt names a `signer` but has no signature: it was removed. |
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
`starpi-verify-receipt receipt.signed.json <files> --public-key signer.pem --require-signature`.

## Versions

A receipt can only be reproduced with the rules that created it, so each rule set has an id and a
version:

| Rules | Recorded as | Current |
| --- | --- | --- |
| Receipt format ([`src/js/core/receipt.js`](../../src/js/core/receipt.js)) | `schema` | `starpi.receipt/v3`; v2 and v1 are still read and verified |
| Text extraction (`extractText`, [`src/js/rag/parser.js`](../../src/js/rag/parser.js)) | `document.extractor` | `starpi-extract` 2, plus the pdf.js version for PDFs and the OCR provider and model for images |
| Chunking (`chunkText`, [`src/js/rag/chunker.js`](../../src/js/rag/chunker.js)) | `document.chunker` | `starpi-chunk` 1, size 500, overlap 50 |
| Source check ([`src/js/core/grounding.js`](../../src/js/core/grounding.js)) | `grounding.algorithm` | `starpi-grounding` 2; version 1 can still be run |

Golden tests (`tests/unit/golden.test.mjs`) pin the output of the last three: extraction and chunking of
the sample files, and the verdicts and reasons of the source check on every statement of the
labelled answers in `tests/fixtures/grounding/` (version 1 on the 308 answers of `eval.json`,
version 2 on the answer sets listed in [`docs/eval/v2-protocol.md`](../eval/v2-protocol.md)). A
change that alters their output must bump the version, so an old receipt is reported as "made
with other rules" instead of failing without explanation. An incompatible change of the receipt
format itself gets a new `schema` value.

`starpi-extract` 2 added Word (`docx`: paragraphs, headings, tables as "column: value" lines), Excel
(`xlsx`: "Sheet / A1: value" lines), PowerPoint (`pptx`: the text of each slide and its notes) and
HTML (`html`: tags removed, scripts and styles dropped, entities decoded, headings kept), and images
through OCR. The text of TXT, Markdown, CSV, JSON, log and PDF files is byte for byte that of version
1 (`EXTRACTOR_COMPATIBLE`), so the verifier treats a text recorded with version 1 of those kinds as
made by the current rules: a matching text gives no note, and a different text is a `mismatch`, not
`version_differs`.

The source check keeps every earlier version it can still run (`GROUNDING_VERSIONS`): the
verifier recomputes a receipt with the version the receipt records, so a receipt made by Starpi
1.x (`starpi-grounding` 1) is recomputed with the rules of 1.x. Only a version the verifier does
not know is recomputed with the current rules, with a warning.

### Earlier formats

`starpi.receipt/v2`, written by Starpi 2.0 and 2.1, has the Merkle tree, the proofs and the optional
signature, but none of the members v3 added (`signer`, `gate`, `secondOpinion`, `relations`,
`extractor.ocr`); the verifier checks it with its own list of members and refuses a v2 receipt that
carries one of them. `buildReceipt(draft, { schema: RECEIPT_SCHEMA_V2 })` still writes v2, and refuses
a draft with content only v3 can record. A signed v2 receipt written before v3 is kept in
`tests/fixtures/receipts/` with its public key and verified by the unit tests.

`starpi.receipt/v1`, written by Starpi 1.1 to 1.3, has no `merkle`, no `proof` and no `signature`;
its `id` is the hash of the receipt without `id`. It is described by
[`receipt.schema.json`](receipt.schema.json). The verifier checks v1 receipts with their own list of
members, so a v1 receipt that carries a Merkle tree, a proof or a signature is refused, and reports
them without a tree and as not signed. `buildReceipt(draft, { schema: RECEIPT_SCHEMA_V1 })` still
writes v1 for verifiers that only read v1. A receipt written by the released 1.3.0 code is kept in
`tests/fixtures/receipts/` and verified by the unit tests.

## Verifying a receipt

The verifier first checks the receipt against the schema and its size limits, then:

1. **Receipt**: recomputes `id` and `answer.sha256`; for v2 and v3, recomputes the Merkle root from
   the citations, checks every citation's inclusion proof and, if the receipt is signed or names a
   signer, the signature.
2. **L0, file**: hashes every file provided and looks for the recorded `fileSha256`. Files are
   matched by fingerprint, never by name, so a renamed copy still matches and a changed file with
   the same name does not.
3. **L1, text**: extracts the matching file with the current rules and compares `textSha256`. When
   the rules differ from the recorded ones (and are not listed as giving the same text) the result is
   `version_differs`, not `mismatch`, with one note per file. Text recognised by OCR is not extracted
   again: the result is `ocr`, and the next two steps are skipped.
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
own fingerprint is reported in every case. The `gate`, `secondOpinion` and `relations` records of a
v3 receipt are shown as recorded (with the number of contradictions and of inverted or unsupported
relations), not recomputed.

### In the app

**Add knowledge › On-device workspace › Verify an answer receipt** opens the receipt dialog. Choose
the receipt and the original files, and for a signed receipt optionally the signer's public key;
everything is read and checked in the ingest worker on the device. The result lists every citation
with its checks, "n/n workspace excerpts reproduced from your files", the Merkle tree, the signer the
receipt names, the signature and whether it is trusted, and any differences in the source check. A
signature counts as trusted only when it was checked with a public key you chose; the dialog also
says when the signing key is one of this device's own.

### On the command line

```bash
npm run verify:receipt -- receipt.json plan.pdf notes.md
node scripts/verify-receipt.mjs receipt.json plan.pdf notes.md --public-key signer.pem --require-signature --json
npx -p @starpi/core starpi-verify-receipt receipt.json plan.pdf notes.md
```

```text
receipt fa9960d0fa84d2af… (2026-10-17T09:30:00.000Z, cloud)
ok   receipt hash matches its contents
ok   answer hash matches the answer text
ok   Merkle root over 1 citation matches, 1/1 inclusion proofs valid
n/a  names its signer: Ed25519, key 7f2c309fe627139c…
ok   signature valid (Ed25519, key 7f2c309fe627139c…, the public key you gave)
ok   [Doc: nebula-plan.md, Chunk: 1]: file match (nebula-plan.md), text match, passage match, chunk match

1/1 workspace excerpts reproduced from the given files
source check recomputed for 1 statements: same verdicts as recorded
sentence gate (sources mode, as recorded): 1 released, 0 withheld
```

The verifier uses the same extraction and chunking code as the app. It warns when the recorded pdf.js
version differs from the installed one. `--public-key` takes a public key file as a JWK or as PEM
(`-----BEGIN PUBLIC KEY-----`), such as the files **Settings › Trust** exports; a file with a private
key is refused. `--require-signature` fails a receipt without a valid signature; together with
`--public-key` the signature must be by that key.

| Exit code | Meaning |
| --- | --- |
| 0 | The receipt hash and answer hash match, every workspace excerpt was reproduced (OCR text: its file matched), the Merkle root and every proof match (v2, v3), and a signature, if present or named, is valid. |
| 1 | Something did not match, a file with a recorded fingerprint was not given, a public key was given and the receipt is not signed with it, a named signer's signature is missing, or `--require-signature` was given and there is no valid signature. |
| 2 | Usage error, unreadable file or key, or not a valid receipt. |

`--json` prints the full report (`ok`, `receipt`, `schema`, `idMatches`, `answerMatches`,
`citations`, `summary`, `grounding`, `merkle`, `signature`, `signer`, `gate`, `advisory`,
`warnings`).

## Privacy

A receipt contains the answer and, unless left out on export, the question and the excerpt texts.
Its fingerprints identify the source files: whoever has a file can tell that it was the source,
even if the excerpts are left out. The app never uploads a receipt. It keeps receipt drafts only in
memory for the current page (at most 50) and writes a file only when you choose **Download
receipt**. A signed receipt carries the device's public key and key id, which identify the device
to whoever has seen its public key before; turn signing off in **Settings › Trust** to export
receipts without them. The private key never leaves the browser and is never synced.

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
| Second opinions, relations (v3) | 500 each; relation text 500 characters, model names 100 |
| Other strings | 1,000 characters or less, depending on the field |

A receipt above a limit, or with a field of the wrong type, is rejected with the path of the first
problem (for example `citations[2].chunk.end`).
