# Starpi walkthrough

A guided tour of the repository for new contributors and reviewers: what Starpi does, how to run
it, where each part lives, and how a question and a file travel through the code. Every step links
to the file that implements it; the [architecture atlas](ARCHITECTURE.md) has a checked diagram
for each of them.

## What Starpi is

Starpi is a static progressive web app that answers questions about a company knowledge base and
about files the user drops into an on-device workspace. It retrieves passages, labels each one
`[Doc: <name>, Chunk: <n>]` and answers in one of four modes: a model running in the browser on
WebGPU, a cloud assistant with the user's own key, the user's own Chat Completions-compatible
server, or an extractive fallback that only quotes sources. Every citation in an answer can be
opened to the exact passage the answer was given, every answer runs through a source check that
compares its statements with the cited passages, and every answer from workspace files can be
exported as a receipt that anyone can verify against the original files.

- Frontend: plain ES modules bundled by esbuild, Tailwind CSS, a strict Content-Security-Policy,
  English and German UI.
- Data: Supabase (Postgres with row level security and anonymous sessions, full-text and pgvector
  search).
- Optional backend: a dependency-light Python service for server-side ingestion and retrieval.
- License: MIT. Live at [www.starpi.app](https://www.starpi.app).

## Ten minutes to a running app

```bash
npm ci                 # Node.js 22.13+ (see .nvmrc)
npm run dev            # watch build and local server with the production headers on :3000
```

Open `http://127.0.0.1:3000`. Without any configuration the app runs in the extractive mode and
reads the public knowledge base. Then try:

1. **Sample files:** *Try with sample files* in the welcome message reads three files of a
   fictitious project into the on-device workspace. Ask a suggested question, click a citation,
   and open the **Source check** under the answer.
2. **Source check and receipts:** *See the source check catch an error* shows a prepared answer
   with one wrong number being flagged. *Receipt* under an answer downloads a receipt; verify it in
   the same dialog, or with `npm run verify:receipt -- receipt.json public/samples/en/*`.
3. **Your own files:** *Add knowledge*, drop a PDF, Markdown, text, JSON or CSV file, and ask about
   it in the chat.
4. **Languages:** the **EN | DE** switch in the header changes the whole UI without a reload.
5. **On-device model:** switch the engine to *On-device (WebGPU)* in Chrome or Edge with a GPU;
   *Diagnostics* measures time to first token and decode speed of the loaded model.

Checks before a pull request: `npm run verify` (lint, typecheck, unit tests, build, output
verification) and `npm run test:e2e`. [CONTRIBUTING.md](../CONTRIBUTING.md) lists the backend,
database and dependency checks.

## Repository map

| Path | What lives there |
| --- | --- |
| [`src/index.html`](../src/index.html) | The single page: tabs, forms and dialogs, all text via `data-i18n` keys |
| [`src/js/`](../src/js) | Application modules (one responsibility each, see below) |
| [`src/js/core/`](../src/js/core) | Pure modules shared by the page, the workers and Node: citation labels, sentences, facts, the source check, answer receipts |
| [`src/js/rag/`](../src/js/rag) | On-device workspace: ingestion worker, parser, chunker, BM25 index, citations, the source-check panel and receipts |
| [`src/js/webgpu/`](../src/js/webgpu) | WebLLM engine lifecycle, its Web Worker and model selection |
| [`src/js/bench/`](../src/js/bench) | WebGPU diagnostics and the inference benchmark |
| [`src/js/i18n/`](../src/js/i18n), [`src/locales/`](../src/locales) | Runtime translation and the English and German dictionaries |
| [`src/sw.js`](../src/sw.js) | Service worker for the same-origin app shell |
| [`public/samples/`](../public/samples) | The English and German sample files (plan, risk register, kickoff PDF) |
| [`packages/core/`](../packages/core) | `@starpi/core`: the source check, receipts, extraction, chunking and BM25 as an npm package, built from `src/js` |
| [`scripts/`](../scripts) | Build, output verification, local server with production headers, diagram sync, receipt verifier, source-check evaluation |
| [`tests/unit/`](../tests/unit), [`tests/e2e/`](../tests/e2e) | Node unit tests and Playwright end-to-end tests |
| [`backend/`](../backend) | Optional Python API, ingestion and retrieval pipelines, EC2 deployment |
| [`backend/supabase/`](../backend/supabase) | Schema, idempotent migrations and the RLS test harness |
| [`docs/`](.) | This walkthrough, the architecture atlas, the [receipt format](spec/receipts.md), [release notes](releases) and the README artwork |
| [`.github/`](../.github) | CI workflow, Dependabot, issue and pull request templates |

## Follow a question through the code

1. **Boot.** [`main.js`](../src/js/main.js) `boot()` sets the language, wires every view, restores
   the engine choice without downloading anything, and calls `connect()` in
   [`supabase.js`](../src/js/supabase.js). That creates or reuses an anonymous session, probes the
   schema, and keeps retrying while Supabase is unreachable. The chat history is then restored
   ([atlas §2](ARCHITECTURE.md#2-boot-and-settings)).
2. **Submit.** [`chat.js`](../src/js/chat.js) `submitChat()` shows the question and reads the mode
   once.
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
5. **Answer.** `answerWithCloud()`, `answerWithLocalModel()` or `answerWithOwnServer()` produce the
   answer. Any failure falls back to `synthesizeAnswer()` in
   [`synthesizer.js`](../src/js/synthesizer.js), which only quotes sources
   ([atlas §3](ARCHITECTURE.md#3-answering-a-question)).
6. **Render.** [`render.js`](../src/js/render.js) `renderMarkdown()` sanitizes the answer with
   DOMPurify, and `linkifyCitations()` turns only registered labels into citation buttons, so model
   output cannot forge a citation.
7. **Check.** [`rag/grounding-view.js`](../src/js/rag/grounding-view.js) `applyGrounding()` reads
   the rendered answer, assigns each statement the citations that belong to it, and
   [`core/grounding.js`](../src/js/core/grounding.js) compares each one with the excerpts it cites:
   the facts through [`core/facts.js`](../src/js/core/facts.js), then the wording. For model
   answers it uses `contextCoverage()` to compare only with what actually reached the model. The
   *Source check* panel lists what did not match and why, marks the citations of those statements
   and highlights them ([atlas §12](ARCHITECTURE.md#12-source-check-answer-receipts-and-sample-files)).
8. **Receipt.** `storeReceiptDraft()` in [`rag/receipts.js`](../src/js/rag/receipts.js) keeps what
   is needed for a receipt in memory; the *Receipt* dialog builds it with `buildReceipt()` in
   [`core/receipt.js`](../src/js/core/receipt.js) and verifies receipts in the ingest worker.
9. **Store.** [`chat-store.js`](../src/js/chat-store.js) `persistMessage()` syncs the turn to
   Supabase only when an anonymous session exists and the hardened schema is installed. A turn that
   uses the on-device workspace, or any turn in the on-device mode, stays in `localStorage` and is
   never sent to a cloud provider or an own server as chat history.

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
   text with `getChunkContext()` and highlights the exact span. Files live in worker memory only
   and are gone after a reload ([atlas §4](ARCHITECTURE.md#4-on-device-workspace-and-citations)).

## On-device inference

[`webgpu/engine.js`](../src/js/webgpu/engine.js) owns the WebLLM worker. `probeWebGPU()` reads the
adapter, and `chooseModel()` in [`webgpu/models.js`](../src/js/webgpu/models.js) picks a model for
the device, falling back to 32-bit shaders when the adapter lacks `shader-f16`. `loadModel()` asks
before a download, checks the storage quota, and sequences loads, so a cancelled or superseded load
never changes the state. `runBenchmark()` reuses the loaded model: a warm-up, then a fixed prompt,
reporting time to first token and decode speed through
[`bench/diagnostics.js`](../src/js/bench/diagnostics.js)
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
- **Backend:** the only component with the service role key. It binds to loopback, requires a
  bearer token on any other interface, and refuses proxied requests without one
  ([backend/README.md](../backend/README.md)).

## Quality gates

| Layer | What it proves | Where |
| --- | --- | --- |
| Unit tests (Node) | Facts and the source check in English and German, receipts (round trip, tampering, the command-line verifier, the JSON Schema), golden pins for extraction, chunking and the source check, chunking, BM25 maths, parsing, prompts, retrieval, citations, the sample files, i18n key parity, icon and emoji rules, docs diagrams and links | [`tests/unit/`](../tests/unit) |
| End-to-end (Playwright, desktop and mobile) | The built app under the production headers: zero CSP violations, sample files, the source check on model answers, a downloaded receipt verified against the original file, axe accessibility scan, inert XSS payloads, privacy of workspace turns, offline reconnect, settings storage, citations, language switch | [`tests/e2e/`](../tests/e2e) |
| Source-check evaluation | Labelled answers, faithful or with one planted error: no statement of a faithful answer is flagged as unsupported, and nearly every changed number, date, time, weekday or code is flagged | [`scripts/eval-source-check.mjs`](../scripts/eval-source-check.mjs), [`tests/fixtures/grounding/eval.json`](../tests/fixtures/grounding/eval.json) |
| Backend (unittest) | Request guards, body limits, timeouts, shutdown, `.env` parsing, pipelines with mocked upstreams | [`backend/test_*.py`](../backend) |
| Database | 191 RLS, privilege, search and size-limit assertions per scenario (198 with legacy rows) on fresh, upgraded and legacy schemas, plus schema parity | [`backend/supabase/tests/`](../backend/supabase/tests) |
| Build gate | No inline code, every asset present, no `eval`, the service worker version recomputed from the build | [`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs) |
| Documentation | Every Mermaid block renders; diagram copies match the atlas; links and anchors resolve | [`tests/e2e/docs-diagrams.spec.mjs`](../tests/e2e/docs-diagrams.spec.mjs), [`tests/unit/docs.test.mjs`](../tests/unit/docs.test.mjs) |
| Dependency audit | No known advisory in a runtime npm dependency (`npm audit`) or in the backend requirements (`pip-audit`); advisories in development tooling are reported | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |

CI runs all of them, plus gitleaks, on every push and pull request to `main`
([atlas §11](ARCHITECTURE.md#11-build-test-and-deploy)).

## Where to go next

- [README.md](../README.md): what is different, modes, models, configuration and the roadmap.
- [docs/spec/receipts.md](spec/receipts.md): the receipt format and how verification works.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md): 117 diagrams, one per question about the system.
- [CONTRIBUTING.md](../CONTRIBUTING.md): conventions, checks and the diagram rules.
- [CHANGELOG.md](../CHANGELOG.md): what changed, release by release.
