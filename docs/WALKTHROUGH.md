# Starpi walkthrough

A guided tour of the repository for new contributors and reviewers: what Starpi does, how to run
it, where each part lives, and how a question and a file travel through the code. Every step links
to the file that implements it; the [architecture atlas](ARCHITECTURE.md) has a checked diagram
for each of them.

## What Starpi is

Starpi is a progressive web app, served as static files plus two server functions, that answers
questions about a company knowledge base and about files the user drops into an on-device
workspace. In verified source mode it retrieves passages, labels each one
`[Doc: <name>, Chunk: <n>]` and answers in one of five modes: a model running in the browser (on
WebGPU, or on the processor with WebAssembly), an NVIDIA NIM cloud model through the site's own
proxy, a cloud assistant with the user's own key, the user's own Chat Completions-compatible
server, or an extractive fallback that only quotes sources. Every citation in an answer can be
opened to the exact passage the answer was given, every answer runs through a source check that
compares its statements with the cited passages, and every answer from workspace files can be
exported as a receipt that anyone can verify against the original files. In free chat the same
models answer from the conversation alone, without retrieval, source check or receipt.

- Frontend: plain ES modules bundled by esbuild, Tailwind CSS, a strict Content-Security-Policy,
  English and German UI.
- Data: Supabase (Postgres with row level security and anonymous sessions, full-text and pgvector
  search).
- Server functions: two Vercel Functions in `api/` that relay NVIDIA NIM requests with keys from
  the server environment.
- Optional library publisher: a Python command line tool that stores text and Markdown files in
  the shared library, with a 384-dimensional vector per section.
- License: MIT. Live at [www.starpi.app](https://www.starpi.app).

## Ten minutes to a running app

```bash
npm ci --ignore-scripts   # Node.js 22.13+ (see .nvmrc); no install scripts, as in CI
npm run dev               # watch build and local server with the production headers on :3000
```

Open `http://127.0.0.1:3000`. Without any configuration the app runs in the extractive mode and
reads the public knowledge base. With `NVIDIA_API_KEYS=nvapi-<64 characters> npm run dev` the
local server also relays the NVIDIA models. Then try:

1. **Sample files:** *Try with sample files* in the welcome message reads three files of a
   fictitious project into the on-device workspace. Ask a suggested question, click a citation,
   and open the **Source check** under the answer.
2. **Source check and receipts:** *See the source check catch an error* shows a prepared answer
   with one wrong number being flagged. *Receipt* under an answer downloads a receipt; verify it in
   the same dialog, or with `npm run verify:receipt -- receipt.json public/samples/en/*`.
3. **Your own files:** *Add knowledge*, drop a PDF, Markdown, text, JSON or CSV file, and ask about
   it in the chat.
4. **Languages:** the **EN | DE** switch in the header changes the whole UI without a reload.
5. **On-device model:** pick a model under *In this browser (WebGPU/WASM)* in the model menu.
   Without WebGPU the recommended model is a processor (WASM) model; *Diagnostics* measures time
   to first token and decode speed of the loaded model.
6. **Free chat:** switch the composer from *Verified source mode* to *Free chat* and talk with the
   model without sources; the answers are marked as not checked.

Checks before a pull request: `npm run verify` (lint, typecheck, unit tests, build, output
verification) and `npm run test:e2e`. [CONTRIBUTING.md](../CONTRIBUTING.md) lists the library publisher,
database and dependency checks.

## Repository map

| Path | What lives there |
| --- | --- |
| [`src/index.html`](../src/index.html) | The single page: tabs, forms and dialogs, all text via `data-i18n` keys |
| [`src/js/`](../src/js) | Application modules (one responsibility each, see below) |
| [`src/js/core/`](../src/js/core) | Pure modules shared by the page, the workers and Node: citation labels, sentences, facts, the source check, answer receipts |
| [`src/js/rag/`](../src/js/rag) | On-device workspace: ingestion worker, parser, chunker, BM25 index, citations, the source-check panel and receipts |
| [`src/js/webgpu/`](../src/js/webgpu) | Engine lifecycle for both on-device runtimes, the WebLLM Web Worker, the WebGPU presets and model selection |
| [`src/js/wasm/`](../src/js/wasm) | Processor (WASM) runtime: Transformers.js and a self-hosted, single-threaded ONNX Runtime in a Web Worker, and its main-thread client |
| [`src/js/models/`](../src/js/models) | Pure model data and rules: device classes and recommendations, the choices of the model menu, the pinned WASM presets and the NVIDIA model allowlist with its limits and timings |
| [`src/js/bench/`](../src/js/bench) | WebGPU diagnostics and the inference benchmark |
| [`src/js/i18n/`](../src/js/i18n), [`src/locales/`](../src/locales) | Runtime translation and the English and German dictionaries |
| [`src/sw.js`](../src/sw.js) | Service worker for the same-origin app shell |
| [`public/samples/`](../public/samples) | The English and German sample files (plan, risk register, kickoff PDF) |
| [`packages/core/`](../packages/core) | `@starpi/core`: the source check, receipts, extraction, chunking and BM25 as an npm package (a workspace of the root package), built from `src/js` |
| [`api/`](../api) | The two Vercel Functions of the NVIDIA proxy (`api/chat/nvidia.js`, `api/models/nvidia.js`) and their shared modules in `api/_lib/`: environment, request guards, validation, key rotation and the stream relay |
| [`scripts/`](../scripts) | Build, output verification, local server with production headers (and the NVIDIA routes for `npm run dev` and `preview`), diagram sync, receipt verifier, `starpi-ground` (documents against sources, SARIF), source-check evaluation, `@starpi/core` build, CycloneDX SBOMs and the NVIDIA model check |
| [`tests/unit/`](../tests/unit), [`tests/e2e/`](../tests/e2e) | Node unit tests and Playwright end-to-end tests |
| [`backend/`](../backend) | Database files and the documentation of the library publisher |
| [`tools/library-publisher/`](../tools/library-publisher) | Optional Python publisher: sections, multilingual-e5-small vectors, Supabase writes with the service role |
| [`backend/supabase/`](../backend/supabase) | Schema, idempotent migrations and the RLS test harness |
| [`docs/`](.) | This walkthrough, the architecture atlas, the [receipt format](spec/receipts.md), [release notes](releases) and the README artwork |
| [`.github/`](../.github) | CI and release workflows, Dependabot, issue and pull request templates |

## Follow a question through the code

1. **Boot.** [`main.js`](../src/js/main.js) `boot()` sets the language, wires every view, restores
   the engine choice without downloading anything, and calls `connect()` in
   [`supabase.js`](../src/js/supabase.js). That creates or reuses an anonymous session, probes the
   schema, and keeps retrying while Supabase is unreachable. The chat history is then restored
   ([atlas §2](ARCHITECTURE.md#2-boot-and-settings)).
2. **Submit.** [`chat.js`](../src/js/chat.js) `submitChat()` shows the question and reads the mode
   (which model answers) and the chat mode once. A suggested question, quick prompt or graph
   entity question switches to source mode first. Steps 3, 4, 7 and 8 run in verified source mode
   only; free chat follows below.
3. **Retrieve.** `retrieve()` asks the on-device workspace first (`searchWorkspace()` in
   [`rag/workspace.js`](../src/js/rag/workspace.js)). It then searches the knowledge base: with
   `searchKnowledge()` (Postgres full-text search, falling back to passages that share at least two
   search terms) in the cloud and own-server modes, or by ranking recent documents in the browser
   without sending the question in the on-device mode. `mergeHits()` keeps slots for both sources,
   and the suggested questions about the sample files search only the workspace.
4. **Label and fence.** [`retrieval.js`](../src/js/retrieval.js) `assignCitations()` gives every
   passage its `[Doc: …, Chunk: …]` label, and `buildContext()` wraps the passages in excerpt fences
   that the prompts from [`prompts.js`](../src/js/prompts.js) tell the model to treat as data, not
   instructions. [`rag/citations.js`](../src/js/rag/citations.js) `registerCitations()` remembers
   exactly what was given.
5. **Answer.** `answerWithCloud()`, `answerWithLocalModel()` (WebGPU or WASM),
   `answerWithOwnServer()` or `answerWithNvidia()` produce the answer. `answerWithNvidia()` fits
   the messages to the proxy's limits with `fitNvidiaMessages()`, and `callNvidia()` in
   [`providers.js`](../src/js/providers.js) posts them to `/api/chat/nvidia` without a key and
   streams the reply into the bubble: [`chat-stream.js`](../src/js/chat-stream.js) parses the
   server-sent events and keeps the model's reasoning apart from the answer, and error codes become
   the app's own messages. Any failure falls back to `synthesizeAnswer()` in
   [`synthesizer.js`](../src/js/synthesizer.js), which only quotes sources
   ([atlas §3](ARCHITECTURE.md#3-answering-a-question)).
6. **Render.** [`render.js`](../src/js/render.js) `renderMarkdown()` sanitizes the answer with
   DOMPurify, and `linkifyCitations()` turns only registered labels into citation buttons, so model
   output cannot forge a citation.
7. **Check.** [`rag/grounding-view.js`](../src/js/rag/grounding-view.js) `applyGrounding()` reads
   the rendered answer, assigns each statement the citations that belong to it, and
   [`core/grounding.js`](../src/js/core/grounding.js) compares each one with the excerpts it cites:
   the facts through [`core/facts.js`](../src/js/core/facts.js), then the wording, then (rules
   version 2) reversed negations through [`core/polarity.js`](../src/js/core/polarity.js) and names
   and values next to something else through [`core/binding.js`](../src/js/core/binding.js). For model
   answers it uses `contextCoverage()` to compare only with what actually reached the model. The
   *Source check* panel lists what did not match and why, marks the citations of those statements
   and highlights them ([atlas §12](ARCHITECTURE.md#12-source-check-answer-receipts-and-sample-files)).
8. **Receipt.** `storeReceiptDraft()` in [`rag/receipts.js`](../src/js/rag/receipts.js) keeps what
   is needed for a receipt in memory; the *Receipt* dialog builds it with `buildReceipt()` in
   [`core/receipt.js`](../src/js/core/receipt.js), with a Merkle tree over the citations from
   [`core/merkle.js`](../src/js/core/merkle.js), and verifies receipts in the ingest worker, with
   signatures checked by [`core/signature.js`](../src/js/core/signature.js).
9. **Store.** [`chat-store.js`](../src/js/chat-store.js) `persistMessage()` syncs the turn to
   Supabase only when an anonymous session exists and the hardened schema is installed. A turn that
   uses the on-device workspace, or any turn in the on-device mode, stays in `localStorage` and is
   never sent to a cloud provider, the NVIDIA proxy or an own server as chat history.

In **free chat**, `answerFree()` skips steps 3, 4, 7 and 8: nothing is retrieved, and the system
prompt from `buildChatPrompt()` in [`prompts.js`](../src/js/prompts.js) carries an attached file
fenced as data (`attachmentForChat()`, at most 12,000 characters). The model gets up to 16 earlier
messages (a model outside the device only those that may leave it), and `markFreeAnswer()` in
[`messages.js`](../src/js/messages.js) labels the answer as not checked against sources. Without a
model there is no answer, only a notice that says how to set one up. The chat menu exports the
conversation as Markdown or JSON ([`chat-export.js`](../src/js/chat-export.js)) or deletes it, and
[`code-blocks.js`](../src/js/code-blocks.js) adds a copy button to each code block of an answer.

## Follow a file into the workspace

1. [`ingest.js`](../src/js/ingest.js) `addFiles()` (drop zone) or the chat's attach button hands the
   file to `addToWorkspace()` in [`rag/workspace.js`](../src/js/rag/workspace.js).
2. The dedicated worker [`rag/ingest.worker.js`](../src/js/rag/ingest.worker.js) first takes the
   SHA-256 fingerprint of the file (the same file added twice is not indexed twice), extracts the
   text with [`parser.js`](../src/js/rag/parser.js) `extractText()` (pdf.js runs inside the worker,
   without `eval`; CSV rows become `column: value` lines), fingerprints the text, splits it with
   [`chunker.js`](../src/js/rag/chunker.js) `chunkText()` into 500-character windows with a
   50-character overlap and exact offsets, and indexes the chunks with
   [`bm25.js`](../src/js/rag/bm25.js) `BM25Index` (k1 = 1.2, b = 0.75).
3. Searches return chunks with their real BM25 scores. Opening a citation fetches the surrounding
   text with `getChunkContext()` and highlights the exact span. Files stay on this device after a
   reload unless you choose "Memory only", and "Forget all" removes them; with semantic search on
   this device turned on, searches also find passages by meaning
   ([atlas §4](ARCHITECTURE.md#keeping-files-on-this-device-and-searching-by-meaning)).

## On-device inference

[`webgpu/engine.js`](../src/js/webgpu/engine.js) owns both on-device runtimes. `probeDevice()`
reads the adapter and the browser's memory hint; the model menu waits for it at most 2.5 s and a
load at most 10 s, and a device whose adapter does not answer in time counts as having no WebGPU.
`classifyDevice()` and `recommendModels()` in
[`models/device.js`](../src/js/models/device.js) sort the device into a class (`cpu-only`, `mobile`,
`low`, `laptop`, `desktop`, `desktop-pro`) and pick the preset that *automatic* stands for: a T1 or
T2 WebGPU preset, never a T3 one (a strong GPU gets a T3 preset suggested), and a processor (WASM)
preset when there is no WebGPU. [`models/choices.js`](../src/js/models/choices.js) builds the
groups of the model menu, [`model-picker.js`](../src/js/model-picker.js) shows them in the header
and in Settings, and NVIDIA models (tier T4) come from the proxy's list. `chooseModel()` in
[`webgpu/models.js`](../src/js/webgpu/models.js) falls back to 32-bit shaders when the adapter
lacks `shader-f16`. A WASM preset runs in [`wasm/worker.js`](../src/js/wasm/worker.js) with
Transformers.js and a single-threaded ONNX Runtime whose binary the build copies into `/assets`;
the worker downloads only the files of the pinned Hugging Face revision and reads them from the
Cache API first, so a stored model loads offline. `loadModel()` asks before a download, checks the
storage quota, and sequences loads, so a cancelled or superseded load never changes the state.
`runBenchmark()` reuses the loaded model: a warm-up, then a fixed prompt, reporting time to first
token and decode speed through [`bench/diagnostics.js`](../src/js/bench/diagnostics.js)
([atlas §5](ARCHITECTURE.md#5-on-device-inference)).

## Data and security model

- **Database:** the browser uses the public key and an anonymous session. Grants and row level
  security decide every read and write: chats are visible to their owner only, private knowledge
  rows to their creator, and published rows are read-only for browser roles. The migrations in
  [`backend/supabase/migrations/`](../backend/supabase/migrations) are idempotent and tested in CI
  on PostgreSQL 16 with pgvector ([atlas §8](ARCHITECTURE.md#8-supabase)).
- **Browser:** the CSP forbids inline scripts, handlers and styles and remote images. All Markdown
  passes through DOMPurify, and text extracted from files is only ever set as text. Provider keys
  stay in the tab unless the user opts in to keep them
  ([atlas §9](ARCHITECTURE.md#9-security-layers), [SECURITY.md](../SECURITY.md)).
- **NVIDIA proxy:** the keys exist only in the server environment (`NVIDIA_API_KEYS`), never in
  the bundle. [`api/_lib/handlers.js`](../api/_lib/handlers.js) checks the origin, a per-IP rate
  limit, the body size and the request against the model allowlist before any upstream call, then
  rotates keys until a stream starts and relays it; nothing is stored and no content is logged.
  ([SECURITY.md](../SECURITY.md#relay-pools-and-the-other-server-functions)).
- **Library publisher:** the only component with the service role key. It is a command line tool
  for a machine the operator controls, opens no port and reads only published rows and rows
  without an owner ([backend/README.md](../backend/README.md#library-publisher)).

## Quality gates

| Layer | What it proves | Where |
| --- | --- | --- |
| Unit tests (Node) | Facts and the source check in English and German (both rules versions), receipts (round trip, tampering, Merkle trees against RFC 6962 test vectors, Ed25519 and ES256 signatures, v1 receipts of 1.3.0, the command-line verifier, the JSON Schemas), `starpi-ground` and its SARIF, golden pins for extraction, chunking and the source check, chunking, BM25 maths, parsing, prompts (both chat modes, fitting requests to the NVIDIA limits), retrieval, citations, the sample files, the model catalogs (WebGPU, the pinned WASM files and the NVIDIA allowlist, each against its README table), device classes and the model menu, the streaming parser, chat export, code copy buttons, the NVIDIA client, the NVIDIA proxy (guards, validation, key rotation, failover and the stream relay, with an injected `fetch`), no NVIDIA key in any tracked file, i18n key parity, icon and emoji rules, docs diagrams and links | [`tests/unit/`](../tests/unit) |
| End-to-end (Playwright, desktop and mobile) | The built app under the production headers: zero CSP violations, sample files, the source check on model answers, a downloaded receipt verified against the original file, axe accessibility scan, inert XSS payloads, privacy of workspace turns, offline reconnect, settings storage, citations, language switch, the model menu (recommendation, WASM fallback, no switch during an answer), both chat modes, chat export and delete, NVIDIA answers streamed from a mocked proxy and checked in source mode | [`tests/e2e/`](../tests/e2e) |
| Source-check evaluation | Labelled answers, faithful or with one planted error, in four sets (two of them held out, see the [protocol](eval/v2-protocol.md)): no statement of a faithful answer is flagged as unsupported, and no published result may get worse | [`scripts/eval-source-check.mjs`](../scripts/eval-source-check.mjs), [`tests/fixtures/grounding/`](../tests/fixtures/grounding) |
| Library publisher (unittest) | Chunking, `.env` parsing, the e5 prefixes, pooling and normalisation with a fake model, the pinned model files, Supabase payloads and shared-row filters, and every command, with `httpx.MockTransport` | [`tools/library-publisher/publisher/tests/`](../tools/library-publisher/publisher/tests) |
| Database | 220 RLS, privilege, search, vector and size-limit assertions per scenario (227 with legacy rows) on fresh, upgraded and legacy schemas, plus schema parity | [`backend/supabase/tests/`](../backend/supabase/tests) |
| Build gate | No inline code, every asset present, no `eval`, the service worker version recomputed from the build, the WASM worker and the ONNX Runtime binary present and kept out of the precached app shell, no NVIDIA API key in the JavaScript bundles, `index.html`, `sw.js` or the build manifest | [`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs) |
| Documentation | Every Mermaid block renders; diagram copies match the atlas; links and anchors resolve | [`tests/e2e/docs-diagrams.spec.mjs`](../tests/e2e/docs-diagrams.spec.mjs), [`tests/unit/docs.test.mjs`](../tests/unit/docs.test.mjs) |
| Dependency audit | No known advisory in a runtime npm dependency (`npm audit`) or in the library publisher's requirements (`pip-audit`); advisories in development tooling are reported | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| SBOM and package | CycloneDX SBOMs of the app and of `@starpi/core` on every CI run, deterministic and checked; the package's typed build and file list on every pull request; each release built read-only, smoke-tested and listed in `SHA256SUMS` | [`scripts/sbom.mjs`](../scripts/sbom.mjs), [`.github/workflows/release.yml`](../.github/workflows/release.yml) |

CI runs all of them, plus gitleaks, on every push and pull request to `main`
([atlas §11](ARCHITECTURE.md#11-build-test-and-deploy)).

## Where to go next

- [README.md](../README.md): what is different, modes, models, configuration and the roadmap.
- [docs/spec/receipts.md](spec/receipts.md): the receipt format and how verification works.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md): 130 diagrams, one per question about the system.
- [CONTRIBUTING.md](../CONTRIBUTING.md): conventions, checks and the diagram rules.
- [CHANGELOG.md](../CHANGELOG.md): what changed, release by release.
