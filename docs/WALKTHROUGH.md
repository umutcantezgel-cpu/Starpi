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
opened to the exact passage the answer was given.

- Frontend: plain ES modules bundled by esbuild, Tailwind CSS, a strict Content-Security-Policy,
  English and German UI.
- Data: Supabase (Postgres with row level security and anonymous sessions, full-text and pgvector
  search).
- Optional backend: a dependency-light Python service for server-side ingestion and retrieval.
- License: MIT. Live at [www.starpi.app](https://www.starpi.app).

## Ten minutes to a running app

```bash
npm ci                 # Node.js 20.19+ (22 LTS recommended)
npm run dev            # watch build and local server with the production headers on :3000
```

Open `http://127.0.0.1:3000`. Without any configuration the app runs in the extractive mode and
reads the public knowledge base. Then try:

1. **On-device workspace:** *Add knowledge*, drop a PDF, Markdown, text, JSON or CSV file, ask a
   question about it in the chat and click a citation.
2. **Languages:** the **EN | DE** switch in the header changes the whole UI without a reload.
3. **On-device model:** switch the engine to *On-device (WebGPU)* in Chrome or Edge with a GPU;
   *Diagnostics* measures time to first token and decode speed of the loaded model.

Checks before a pull request: `npm run verify` (lint, typecheck, unit tests, build, output
verification) and `npm run test:e2e`. [CONTRIBUTING.md](../CONTRIBUTING.md) lists the backend and
database checks.

## Repository map

| Path | What lives there |
| --- | --- |
| [`src/index.html`](../src/index.html) | The single page: tabs, forms and dialogs, all text via `data-i18n` keys |
| [`src/js/`](../src/js) | Application modules (one responsibility each, see below) |
| [`src/js/rag/`](../src/js/rag) | On-device workspace: ingestion worker, parser, chunker, BM25 index, citations |
| [`src/js/webgpu/`](../src/js/webgpu) | WebLLM engine lifecycle, its Web Worker and model selection |
| [`src/js/bench/`](../src/js/bench) | WebGPU diagnostics and the inference benchmark |
| [`src/js/i18n/`](../src/js/i18n), [`src/locales/`](../src/locales) | Runtime translation and the English and German dictionaries |
| [`src/sw.js`](../src/sw.js) | Service worker for the same-origin app shell |
| [`scripts/`](../scripts) | Build, output verification, local server with production headers, diagram sync |
| [`tests/unit/`](../tests/unit), [`tests/e2e/`](../tests/e2e) | Node unit tests and Playwright end-to-end tests |
| [`backend/`](../backend) | Optional Python API, ingestion and retrieval pipelines, EC2 deployment |
| [`backend/supabase/`](../backend/supabase) | Schema, idempotent migrations and the RLS test harness |
| [`docs/`](.) | This walkthrough, the architecture atlas, [release notes](releases) and the README artwork |
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
   `searchKnowledge()` (Postgres full-text search) in the cloud and own-server modes, or by ranking
   recent documents in the browser without sending the question in the on-device mode.
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
7. **Store.** [`chat-store.js`](../src/js/chat-store.js) `persistMessage()` syncs the turn to
   Supabase only when an anonymous session exists and the hardened schema is installed. A turn that
   uses the on-device workspace, or any turn in the on-device mode, stays in `localStorage`.

## Follow a file into the workspace

1. [`ingest.js`](../src/js/ingest.js) `addFiles()` (drop zone) or the chat's attach button hands the
   file to `addToWorkspace()` in [`rag/workspace.js`](../src/js/rag/workspace.js).
2. The dedicated worker [`rag/ingest.worker.js`](../src/js/rag/ingest.worker.js) extracts the text
   with [`parser.js`](../src/js/rag/parser.js) `extractText()` (pdf.js runs inside the worker,
   without `eval` or network access), splits it with
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

- **Database:** the browser uses the public anon key and an anonymous session. Grants and row level
  security decide every read and write: chats are visible to their owner only, private knowledge
  rows to their creator, and published rows are read-only for browser roles. The two migrations in
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
| Unit tests (Node) | Chunking, BM25 maths, parsing, prompts, retrieval, citations, i18n key parity, icon and emoji rules, docs diagrams and links | [`tests/unit/`](../tests/unit) |
| End-to-end (Playwright, desktop and mobile) | The built app under the production headers: zero CSP violations, inert XSS payloads, privacy of workspace turns, offline reconnect, settings storage, citations, language switch | [`tests/e2e/`](../tests/e2e) |
| Backend (unittest) | Request guards, body limits, timeouts, shutdown, `.env` parsing, pipelines with mocked upstreams | [`backend/test_*.py`](../backend) |
| Database | 184 RLS, privilege and size-limit assertions per scenario (191 with legacy rows) on fresh, upgraded and legacy schemas, plus schema parity | [`backend/supabase/tests/`](../backend/supabase/tests) |
| Build gate | No inline code, every asset present, no `eval`, versioned service worker | [`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs) |
| Documentation | Every Mermaid block renders; diagram copies match the atlas; links and anchors resolve | [`tests/e2e/docs-diagrams.spec.mjs`](../tests/e2e/docs-diagrams.spec.mjs), [`tests/unit/docs.test.mjs`](../tests/unit/docs.test.mjs) |

CI runs all of them, plus gitleaks, on every push and pull request to `main`
([atlas §11](ARCHITECTURE.md#11-build-test-and-deploy)).

## Where to go next

- [README.md](../README.md): modes, models, configuration and the roadmap.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md): 87 diagrams, one per question about the system.
- [CONTRIBUTING.md](../CONTRIBUTING.md): conventions, checks and the diagram rules.
- [CHANGELOG.md](../CHANGELOG.md): what changed, release by release.
