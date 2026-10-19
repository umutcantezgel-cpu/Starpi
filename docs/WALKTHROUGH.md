# Starpi walkthrough

A guided tour of the repository for new contributors and reviewers: what Starpi does, how to run
it, where each part lives, and how a question and a file travel through the code. Every step links
to the file that implements it; the [architecture atlas](ARCHITECTURE.md) has a checked diagram
for each of them.

## What Starpi is

Starpi is a progressive web app, served as static files plus stateless server functions, that
answers questions about the files a user keeps in an on-device workspace and about a shared
knowledge base. Each question takes one of three routes: **Grounded** retrieves passages, labels
each one `[Doc: <name>, Chunk: <n>]`, answers from them and checks the answer; **Free** talks with
the model without sources and marks every answer as not checked; **Auto** picks the route per
question without an extra model call, or answers mixed and marks which parts the sources hold.
The answer comes from one AI layer for every provider (Anthropic, OpenAI, Gemini, xAI, Groq,
Mistral, DeepSeek, OpenRouter, NVIDIA), a model on the device (WebGPU, or the processor with
WebAssembly), the user's own Chat Completions-compatible server, the free models of the site's
pools, or the paired local companion; without any model the sources are quoted. Every citation
opens the exact passage, every grounded answer runs through a source check that compares its
statements with the cited passages, read-aloud and Live speak only what the sentence gate released,
and an answer from workspace files can be exported as a signed receipt that anyone can verify
against the original files.

- Frontend: plain ES modules bundled by esbuild, Tailwind CSS, a strict Content-Security-Policy,
  cross-origin isolation, six interface languages (English, German, French, Spanish, Italian,
  Turkish).
- On the device: conversations and workspace files in IndexedDB and OPFS, workers for parsing,
  search and the on-device models.
- Data: Supabase (Postgres with row level security and anonymous sessions, full-text and pgvector
  search) for the shared library and the end-to-end encrypted sync, which is off until turned on.
- Server functions: Vercel Functions in `api/` for the relay of keys of your own, the site's key
  pools, speech, Live tokens and research steps; none of them stores a request, an answer or a key.
- Optional: the local companion `@starpi/companion` on the user's own machine, and a library
  publisher, a Python command line tool that stores text and Markdown files in the shared library
  with a 384-dimensional vector per section.
- License: MIT. Live at [www.starpi.app](https://www.starpi.app).

## Ten minutes to a running app

```bash
npm ci --ignore-scripts   # Node.js 22.13+ (see .nvmrc); no install scripts, as in CI
npm run dev               # watch build and local server with the production headers on :3000
```

Open `http://127.0.0.1:3000`. Without any configuration grounded questions are answered by quoting
the sources, and the app reads the public knowledge base. A key under **Settings › Model providers
and keys**, a model on this device or your own server gives it a model; keys of the site's pools in
the environment (for example `GROQ_API_KEYS=<key> npm run dev`) let the local server offer the free
models too ([docs/SERVER.md](SERVER.md) lists every variable). Then try:

1. **Sample files:** *Try with sample files* in the welcome message reads three files of a
   fictitious project into the on-device workspace. Ask a suggested question, click a citation,
   and open the **Source check** under the answer.
2. **Source check and receipts:** *See the source check catch an error* shows a prepared answer
   with one wrong number being flagged. *Receipt* under an answer downloads a signed receipt;
   verify it in the same dialog, or with `npm run verify:receipt -- receipt.json public/samples/en/*`.
3. **Your own files:** *Add knowledge*, drop a PDF, Markdown, text, JSON, CSV, Word, Excel,
   PowerPoint or HTML file, and ask about it in the chat. *Find in my files* in the knowledge graph
   tab names the entities of your files and how they relate.
4. **Auto, Free and Grounded:** switch the composer between the three modes; the label under each
   answer says which route it took.
5. **Languages:** the language select in the header changes the whole UI without a reload.
6. **On-device model:** pick a model of this device in the model menu. Without WebGPU the
   recommended model is a processor (WASM) model; *Diagnostics* measures time to first token and
   decode speed of the loaded model and keeps a history.
7. **Voice and Live:** dictate a question, let answers be read aloud, or open Live for a spoken
   conversation, free or from your sources.

Checks before a pull request: `npm run verify` (lint, typecheck, unit tests, build, output
verification, generated headers, licence gate, end-of-life register) and `npm run test:e2e`.
[CONTRIBUTING.md](../CONTRIBUTING.md) lists the companion, library publisher, database and
dependency checks.

## Repository map

| Path | What lives there |
| --- | --- |
| [`src/index.html`](../src/index.html) | The single page: the shell, tabs, forms and dialogs, all text via `data-i18n` keys |
| [`src/js/`](../src/js) | Application modules (one responsibility each, see below) and the boot in `main.js` |
| [`src/js/ai/`](../src/js/ai) | The AI layer: the contract, an adapter per wire format, transports (direct, relay, pool, device), the provider and model catalogs, keys and their vault, the router with its purposes and roles, the model wheel, context packs, tools, MCP and memory |
| [`src/js/chat/`](../src/js/chat) | The chat thread: Auto, Free and Grounded turns, the runner, branches and the conversation store, attachments, compare and the council, canvas, projects and assistants |
| [`src/js/core/`](../src/js/core) | Pure modules shared by the page, the workers and Node: citation labels, sentences, facts, the source check, the sentence gate, receipts, Merkle trees, signatures and the language packs |
| [`src/js/rag/`](../src/js/rag) | On-device workspace: ingestion worker, parser and the Office and HTML readers, chunker, BM25 index, search by meaning, citations, the source-check panel and receipts |
| [`src/js/voice/`](../src/js/voice), [`src/js/live/`](../src/js/live), [`src/js/research/`](../src/js/research) | Dictation, read-aloud and speech sources; Live conversations; research jobs |
| [`src/js/companion/`](../src/js/companion) | Pairing with the local companion, its client, and its place as a model and a source of the chat |
| [`src/js/store/`](../src/js/store), [`src/js/sync/`](../src/js/sync), [`src/js/trust/`](../src/js/trust) | The app database (IndexedDB, OPFS, quota), the end-to-end encrypted sync, the receipt signing key and model integrity |
| [`src/js/webgpu/`](../src/js/webgpu), [`src/js/wasm/`](../src/js/wasm) | Engine lifecycle for both on-device runtimes: WebLLM on WebGPU, Transformers.js with a self-hosted ONNX Runtime on the processor |
| [`src/js/models/`](../src/js/models) | Pure model data and rules: device classes and recommendations, the choices of the model menu, the pinned WASM presets, the model lock, the benchmark history and the NVIDIA model list of the site's pool |
| [`src/js/features/`](../src/js/features), [`src/js/ui/`](../src/js/ui), [`src/js/settings/`](../src/js/settings) | Feature registrations that mount lazily, the shell (sidebar, theme, kit) and the settings views |
| [`src/js/bench/`](../src/js/bench) | Diagnostics, the inference benchmark and its history |
| [`src/js/i18n/`](../src/js/i18n), [`src/locales/`](../src/locales) | Runtime translation and the dictionaries of six languages, a root file and namespaces each |
| [`src/sw.js`](../src/sw.js) | Service worker for the same-origin app shell |
| [`public/samples/`](../public/samples) | The English and German sample files (plan, risk register, kickoff PDF) |
| [`packages/core/`](../packages/core) | `@starpi/core`: the source check, the sentence gate, receipts, extraction, chunking and BM25 as an npm package with `starpi-ground`, `starpi-gate` and `starpi-verify-receipt`, built from `src/js` |
| [`packages/companion/`](../packages/companion) | `@starpi/companion`, the local companion: a sealed vault, a signed audit chain and zero network egress by default |
| [`companion/voice-server/`](../companion/voice-server) | The optional local voice server for speech on the user's own machine |
| [`api/`](../api) | The server functions: the relay (`api/relay.js`), the pools (`api/pool.js`, `api/models/pool.js`), speech and Live tokens (`api/voice/`), research steps (`api/research/step.js`), health and the NVIDIA routes of 2.x, with their shared modules in `api/_lib/` |
| [`scripts/`](../scripts) | Build, output verification, local server with production headers and the functions, provider fakes, diagram sync, receipt verifier, `starpi-ground` and `starpi-gate`, evaluations, `@starpi/core` build, SBOMs, header, licence and hygiene gates, model catalog and lock tools |
| [`tests/unit/`](../tests/unit), [`tests/e2e/`](../tests/e2e) | Node unit tests and Playwright end-to-end tests |
| [`backend/`](../backend) | Database files and the documentation of the library publisher |
| [`tools/library-publisher/`](../tools/library-publisher) | Optional Python publisher: sections, multilingual-e5-small vectors, Supabase writes with the service role |
| [`backend/supabase/`](../backend/supabase) | Schema, idempotent migrations and the RLS test harness |
| [`docs/`](.) | This walkthrough, the architecture atlas, the [server functions](SERVER.md), the [migration guide](MIGRATION-3.md), the [receipt format](spec/receipts.md), [release notes](releases) and the README artwork |
| [`.github/`](../.github) | CI and release workflows, Dependabot, issue and pull request templates |

## Follow a question through the code

1. **Boot.** [`main.js`](../src/js/main.js) `boot()` sets the language, builds the shell, wires
   every view and mounts the feature modules, restores the engine choice without downloading
   anything, and calls `connect()` in [`supabase.js`](../src/js/supabase.js). That creates or
   reuses an anonymous session, probes the schema, and keeps retrying while Supabase is
   unreachable. The conversations are then restored from the app database
   ([atlas §2](ARCHITECTURE.md#2-boot-and-settings)).
2. **Send.** `sendQuestion()` in [`chat/thread.js`](../src/js/chat/thread.js) takes the composer's
   draft with its attachments, or a question from elsewhere (a suggested question, a graph entity,
   the canvas), and the model picker's value. A turn runs inside `withTurn()`: one at a time, with
   Stop and the busy state around it.
3. **Route.** An explicit mode wins; in Auto, `decideRoute()` in
   [`ai/hybrid.js`](../src/js/ai/hybrid.js) decides without a model call, from attached documents,
   phrases that point at the sources, the titles of the library and a keyword probe of the
   workspace: grounded, mixed or free. Suggested questions and questions about a graph entity
   always run grounded.
4. **Retrieve.** For a grounded or mixed answer, `retrieve()` searches the on-device workspace
   (`searchWorkspace()` in [`rag/workspace.js`](../src/js/rag/workspace.js): BM25, and by meaning
   when that is on), the registered sources such as the companion's documents, and the shared
   library: by full text when the question may leave the device, otherwise by a query vector made
   on the device or by ranking recent documents in the browser. `mergeHits()` in
   [`retrieval.js`](../src/js/retrieval.js) keeps slots for every source
   ([atlas §3](ARCHITECTURE.md#3-answering-a-question)).
5. **Label and fence.** `assignCitations()` gives every passage its `[Doc: …, Chunk: …]` label.
   A model with a large window gets the passages in excerpt fences (`buildContext()`); models on
   the device, the own server, smaller windows and mixed answers get a context pack sized by the
   window (`buildContextPack()` in [`ai/context-pack.js`](../src/js/ai/context-pack.js), whose short
   labels `expandLabels()` turns back into the canonical ones). Either way the prompts tell the model
   to treat the passages as data, not instructions, and
   [`rag/citations.js`](../src/js/rag/citations.js) `registerCitations()` remembers exactly what was
   given.
6. **Answer.** `answerGrounded()` and `answerFree()` ask `chatCandidates()` in
   [`chat/runner.js`](../src/js/chat/runner.js) for the models the picker allows, in order, and
   `runAnswer()` streams the first one that answers: a call that fails before any text moves on to
   the next candidate. The request goes through the AI layer ([`ai/index.js`](../src/js/ai/index.js))
   with the adapter of the provider's wire format and a transport: direct from the browser, through
   the relay for providers that refuse browser calls, the site's pool, or a worker, the own server
   or the companion on the device. A grounded answer without a model or after a failure falls back
   to `synthesizeAnswer()` in [`synthesizer.js`](../src/js/synthesizer.js), which only quotes
   sources ([atlas §14](ARCHITECTURE.md#14-ai-layer-and-providers)).
7. **Render.** [`render.js`](../src/js/render.js) `renderMarkdown()` sanitizes the answer with
   DOMPurify, and `linkifyCitations()` turns only registered labels into citation buttons, so model
   output cannot forge a citation.
8. **Check.** [`rag/grounding-view.js`](../src/js/rag/grounding-view.js) `applyGrounding()` reads
   the rendered answer, assigns each statement the citations that belong to it, and
   [`core/grounding.js`](../src/js/core/grounding.js) compares each one with the part of the
   excerpts that reached the model: the facts through [`core/facts.js`](../src/js/core/facts.js),
   then the wording, reversed negations through [`core/polarity.js`](../src/js/core/polarity.js),
   names and values next to something else through [`core/binding.js`](../src/js/core/binding.js),
   and, since rules version 3, changes, comparisons and orders in time through
   [`core/relations.js`](../src/js/core/relations.js). The *Source check* panel lists what did not
   match and why, marks the citations of those statements and highlights them
   ([atlas §12](ARCHITECTURE.md#12-source-check-answer-receipts-and-sample-files)). What is spoken
   goes through the sentence gate in [`core/gate.js`](../src/js/core/gate.js) first.
9. **Receipt.** `storeReceiptDraft()` in [`rag/receipts.js`](../src/js/rag/receipts.js) keeps what
   is needed for a receipt in memory; the *Receipt* dialog builds it with `buildReceipt()` in
   [`core/receipt.js`](../src/js/core/receipt.js), with a Merkle tree over the citations from
   [`core/merkle.js`](../src/js/core/merkle.js), signs it with the device key of
   [`trust/signing.js`](../src/js/trust/signing.js), and verifies receipts in the ingest worker,
   with signatures checked by [`core/signature.js`](../src/js/core/signature.js).
10. **Store.** The turn becomes nodes of the conversation in
    [`chat/store.js`](../src/js/chat/store.js), in the app database on this device; editing a
    question or regenerating an answer adds a branch. A turn that stays on the device (a model of
    this device, a workspace passage, a quoted answer naming a workspace file, the companion's
    turns) is never sent to another model as history and never enters the encrypted sync of
    [`sync/`](../src/js/sync) ([atlas §15](ARCHITECTURE.md#15-chat-thread-and-conversations)).

In **free** mode, steps 4, 5, 8 and 9 are skipped: nothing is retrieved, and the request carries
the free system prompt, the history the model may see, the question with its attachments and, when
memory is on, the saved notes. The registered tool runner may run the tool calls the model stopped
for, with approval cards in the bubble, and the answer is labelled as not checked against sources.
Without a model there is no answer, only a notice that says how to set one up. The chat menu
exports the conversation ([`chat/export.js`](../src/js/chat/export.js)) or deletes it, and
[`code-blocks.js`](../src/js/code-blocks.js) adds a copy button to each code block of an answer.

## Follow a file into the workspace

1. [`ingest.js`](../src/js/ingest.js) `addFiles()` (drop zone) or the chat's attach button hands the
   file to `addToWorkspace()` in [`rag/workspace.js`](../src/js/rag/workspace.js).
2. The dedicated worker [`rag/ingest.worker.js`](../src/js/rag/ingest.worker.js) first takes the
   SHA-256 fingerprint of the file (the same file added twice is not indexed twice), extracts the
   text with [`parser.js`](../src/js/rag/parser.js) `extractText()` (pdf.js runs inside the worker,
   without `eval`; Word, Excel, PowerPoint and HTML files go to the dependency-free readers of
   [`rag/formats/`](../src/js/rag/formats), whose ZIP reader has limits against ZIP bombs; CSV rows
   become `column: value` lines; an image is read only by a model that sees, after the user agreed),
   fingerprints the text, splits it with [`chunker.js`](../src/js/rag/chunker.js) `chunkText()` into
   500-character windows with a 50-character overlap and exact offsets, and indexes the chunks with
   [`bm25.js`](../src/js/rag/bm25.js) `BM25Index` (k1 = 1.2, b = 0.75).
3. [`rag/workspace-core.js`](../src/js/rag/workspace-core.js) keeps the document, its chunks and the
   original file in the app database and OPFS, so it is still there after a reload, unless the user
   chose "Memory only"; "Forget all" removes everything. With search by meaning turned on, an
   embedding model in a worker of its own adds a vector to every chunk, and searches fuse BM25 with
   the vectors ([atlas §4](ARCHITECTURE.md#keeping-files-on-this-device-and-searching-by-meaning)).
4. Searches return chunks with their real scores. Opening a citation fetches the surrounding text
   with `getChunkContext()` and highlights the exact span. *Find in my files*
   ([`graph-extract.js`](../src/js/graph-extract.js)) builds the knowledge graph from the same
   chunks, and keeps each relation only when the passage it cites names both ends
   ([atlas §6](ARCHITECTURE.md#knowledge-graph-tab-find-in-my-files)).

## On-device inference

[`webgpu/engine.js`](../src/js/webgpu/engine.js) owns both on-device runtimes. `probeDevice()`
reads the adapter and the browser's memory hint; the model menu waits for it at most 2.5 s and a
load at most 10 s, and a device whose adapter does not answer in time counts as having no WebGPU.
`classifyDevice()` and `recommendModels()` in
[`models/device.js`](../src/js/models/device.js) sort the device into a class (`cpu-only`, `mobile`,
`low`, `laptop`, `desktop`, `desktop-pro`) and pick the preset that *automatic* stands for: a T1 or
T2 WebGPU preset, never a T3 one (a strong GPU gets a T3 preset suggested), and a processor (WASM)
preset when there is no WebGPU; the benchmark history informs the recommendation.
[`models/choices.js`](../src/js/models/choices.js) builds the groups of the model menu (this device,
the companion, the site's pools, the providers with a key and the own server), and
[`model-picker.js`](../src/js/model-picker.js) shows them in the header and in Settings.
`chooseModel()` in [`webgpu/models.js`](../src/js/webgpu/models.js) falls back to 32-bit shaders when
the adapter lacks `shader-f16`. A WASM preset runs in [`wasm/worker.js`](../src/js/wasm/worker.js)
with Transformers.js and a single-threaded ONNX Runtime whose binary the build copies into
`/assets`; the worker downloads only the files of the pinned Hugging Face revision and reads them
from the Cache API first, so a stored model loads offline. Every model file is checked against its
SHA-256 pin in [`models/model-lock.json`](../src/js/models/model-lock.json) before the model answers.
`loadModel()` asks before a download, checks the storage quota, and sequences loads, so a cancelled
or superseded load never changes the state. `runBenchmark()` reuses the loaded model: a warm-up,
then a fixed prompt, reporting time to first token and decode speed through
[`bench/diagnostics.js`](../src/js/bench/diagnostics.js), and the run is kept in the history
([atlas §5](ARCHITECTURE.md#5-on-device-inference)).

## Data and security model

- **Database:** the browser uses the public key and an anonymous session. Grants and row level
  security decide every read and write: sync rows are visible to their owner only and hold only
  ciphertext, private knowledge rows belong to their creator, and published rows are read-only for
  browser roles. The migrations in
  [`backend/supabase/migrations/`](../backend/supabase/migrations) are idempotent and tested in CI
  on PostgreSQL 16 with pgvector ([atlas §8](ARCHITECTURE.md#8-supabase)).
- **Browser:** the CSP forbids inline scripts, handlers and styles and remote images. All Markdown
  passes through DOMPurify, diagrams and HTML previews render in a sandboxed frame, and text
  extracted from files is only ever set as text. Provider keys stay in the tab unless the user sets
  a vault passphrase ([atlas §9](ARCHITECTURE.md#9-security-layers), [SECURITY.md](../SECURITY.md)).
- **Server functions:** the site's keys exist only in the server environment, never in the bundle.
  [`api/_lib/origins.js`](../api/_lib/origins.js) checks the origin, a per-IP rate limit, an
  optional daily budget and an optional access code before anything else; the relay reaches only a fixed table of provider hosts
  and keeps nothing, and the pools check every request against their allowlist and rotate keys until
  a stream starts. Nothing is stored and no content is logged
  ([atlas §13](ARCHITECTURE.md#13-server-functions),
  [SECURITY.md](../SECURITY.md#relay-pools-and-the-other-server-functions)).
- **The companion:** listens on the loopback interface only, answers paired browsers only, keeps
  its data sealed and makes no network connection by default
  ([`packages/companion/README.md`](../packages/companion/README.md)).
- **Library publisher:** the only component with the service role key. It is a command line tool
  for a machine the operator controls, opens no port and reads only published rows and rows
  without an owner ([backend/README.md](../backend/README.md#library-publisher)).

## Quality gates

| Layer | What it proves | Where |
| --- | --- | --- |
| Unit tests (Node) | The AI layer (adapters per wire format, transports, the router, Auto's routing, context packs), providers, pools, the relay and keys, the chat thread and its store, tools and MCP, voice, Live and research, the companion's browser side, storage and the encrypted sync, the source check in six languages with golden pins, the sentence gate, receipts (Merkle trees against RFC 6962 test vectors, signatures, every earlier format, the JSON Schemas), `starpi-ground` and its SARIF, workspace formats and retrieval, graph extraction, the model catalogs against their README tables, i18n key parity, documentation, hygiene and release gates | [`tests/unit/`](../tests/unit) |
| End-to-end (Playwright, desktop and mobile) | The built app under the production headers against a mocked Supabase and local provider fakes: zero CSP violations, cross-origin isolation, the thread and its modes, providers, pools and the relay, tools, canvas and compare, voice, Live, research, sync, the companion, persistence, graph extraction, the move from 2.1, offline use, axe accessibility scans and inert XSS payloads | [`tests/e2e/`](../tests/e2e) |
| Source-check evaluation | Labelled answers, faithful or with one planted error, in several sets and languages (some of them held out, see the [protocol](eval/v2-protocol.md)): no statement of a faithful answer is flagged as unsupported, and no published result may get worse | [`scripts/eval-source-check.mjs`](../scripts/eval-source-check.mjs), [`tests/fixtures/grounding/`](../tests/fixtures/grounding) |
| Companion | Typecheck, tests, dependency and licence checks, and an install of the offline bundle, on Node.js 22 and 24 | [`packages/companion/test/`](../packages/companion/test) |
| Library publisher (unittest) | Chunking, `.env` parsing, the e5 prefixes, pooling and normalisation with a fake model, the pinned model files, Supabase payloads and shared-row filters, and every command, with `httpx.MockTransport` | [`tools/library-publisher/publisher/tests/`](../tools/library-publisher/publisher/tests) |
| Database | RLS, privilege, search, vector and size-limit assertions on fresh, upgraded and legacy schemas, plus schema parity | [`backend/supabase/tests/`](../backend/supabase/tests) |
| Build gate | No inline code, every asset present, no `eval`, the service worker version recomputed from the build, header parity, the first-load budget, the WASM worker and the ONNX Runtime binary present and kept out of the precached app shell, no key of the site in the JavaScript bundles, `index.html`, `sw.js` or the build manifest | [`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs) |
| Documentation | Every Mermaid block renders; diagram copies match the atlas; links and anchors resolve | [`tests/e2e/docs-diagrams.spec.mjs`](../tests/e2e/docs-diagrams.spec.mjs), [`tests/unit/docs.test.mjs`](../tests/unit/docs.test.mjs) |
| Dependency audit | No known advisory in a runtime npm dependency (`npm audit`) or in the library publisher's requirements (`pip-audit`); advisories in development tooling are reported | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| SBOM, package and release | CycloneDX SBOMs of the app and of `@starpi/core` on every CI run, deterministic and checked; the package's typed build and file list on every pull request; each release built read-only, smoke-tested, listed in `SHA256SUMS`, signed and attested | [`scripts/sbom.mjs`](../scripts/sbom.mjs), [`.github/workflows/release.yml`](../.github/workflows/release.yml) |

CI runs all of them, plus gitleaks, CodeQL and a workflow lint, on every push and pull request to
`main` ([atlas §11](ARCHITECTURE.md#11-build-test-and-deploy)).

## Where to go next

- [README.md](../README.md): what is different, modes, models, configuration and the roadmap.
- [docs/MIGRATION-3.md](MIGRATION-3.md): what changed from 2.x for operators, forks and users of
  `@starpi/core`.
- [docs/spec/receipts.md](spec/receipts.md): the receipt format and how verification works.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md): 138 diagrams, one per question about the system.
- [CONTRIBUTING.md](../CONTRIBUTING.md): conventions, checks and the diagram rules.
- [CHANGELOG.md](../CHANGELOG.md): what changed, release by release.
