# Changelog

All notable changes to Starpi. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-09-27

### Added

- **Source check on every answer.** Each statement is compared with the excerpts it cites:
  numbers in English and German formats (also written as words), dates, times, weekdays, codes,
  quotations and wording, and names in English statements. Statements whose values are not in the
  cited excerpts are listed with the reason ("520,000 is not in [Doc: plan.md, Chunk: 1]"),
  highlighted, and their citations marked. A value the excerpt contains only next to other words
  ("75,000 EUR for infrastructure" when the excerpt says "95,000 EUR for infrastructure and 75,000
  EUR for training") is reported with the passage where it stands. Model answers are compared
  only with the part of each excerpt that reached the model. Deterministic, in the browser, no
  second model (`src/js/core/facts.js`, `src/js/core/grounding.js`, `src/js/rag/grounding-view.js`).
- **Answer receipts** (`starpi.receipt/v1`). A JSON file per answer with SHA-256 fingerprints of
  the source files and their extracted text, passage offsets and the source-check verdicts. The
  receipt dialog downloads receipts and verifies them against the original files in the ingest
  worker; `npm run verify:receipt` does the same on the command line. Format and verification
  levels are specified in [`docs/spec/receipts.md`](docs/spec/receipts.md), with a JSON Schema.
- **`@starpi/core`** (`packages/core`): the source check, receipts, text extraction, chunking and
  BM25 as a dependency-free ESM package with type declarations and a `starpi-verify-receipt`
  command, built from the app's own modules (`npm run build:core`).
- **Sample files.** *Try with sample files* reads a plan, a risk register (CSV) and kickoff notes
  (PDF) of a fictitious project into the workspace, in English or German, and suggests questions
  about them; *See the source check catch an error* shows a prepared answer with one wrong number.
- **Evaluation of the source check** (`npm run eval:source-check`) on 308 labelled answers about
  the sample data, faithful or with one planted error, including a held-out set written after the
  rules were fixed. Held out: no statement of 100 faithful answers marked unsupported (15 of 324
  weak), all 49 changed numbers, dates, times, weekdays and codes flagged; 4 of 10 wrong names,
  6 of 10 misplaced values and none of 10 negations flagged.
- **Accessibility.** Skip link, labelled landmarks, dialogs that keep and return focus, a keyboard
  list of the graph's entities, visible focus rings, and an axe scan of every view in the
  end-to-end tests.
- **Release workflow.** A GitHub release is created for the version in `package.json` once CI has
  passed on `main`, with the notes from `docs/releases/`.
- **Documentation.** Section 12 of the [architecture atlas](docs/ARCHITECTURE.md) on the source
  check, answer receipts and the sample files, every other section checked against the current
  code (117 diagrams), the receipt format in [`docs/spec/`](docs/spec/receipts.md), and a README
  that shows the source check, receipts and their evaluation.

### Changed

- **Knowledge-base search** (migration `20260924120000`): when no row contains every search term,
  `search_knowledge` returns the rows that share at least two of them, so questions in natural
  language find their passages instead of falling back to the newest documents.
- **Retrieval** keeps slots for both the workspace and the knowledge base, so many weak workspace
  hits no longer push out a strong knowledge-base hit; the model context always closes its excerpt
  fences; extractive answers quote only the excerpt that was delivered.
- **Service worker:** versioned by the content of the page, the assets, every public file and the
  worker itself; prunes assets of older builds; stores only the real page as the offline shell. A
  new worker takes over at once only when no page is open, so an open tab keeps its in-memory
  workspace.
- **Keys:** the build accepts Supabase publishable keys (`sb_publishable_…`) and refuses secret and
  service-role keys. Node.js 22.13 or newer.
- **First visit:** without a browser session the sidebar says *Public knowledge*, and actions that
  need one are disabled with an explanation instead of failing.

### Fixed

- A question that starts with a greeting ("Hi, what is the budget?") is answered from the
  sources; a file still being read belongs to the question it was attached to.
- The same file added twice is indexed once; a different file with the same name gets its own
  name, so a citation never points at an invented chunk number.
- Late replies no longer overwrite a citation or document opened after them; error messages
  follow a language switch; several files added at once are reported one by one.
- Synced chat history loads the newest messages, and on-device turns are merged by time.
- Phones and tablets: the knowledge graph scrolls and its labels no longer overlap, wide tables
  scroll inside the answer, the page title and mode selector fit, the message box grows with its
  text, and citation chips keep their chunk number visible.
- Testing an OpenRouter key that is typed but not saved yet uses that key.

### Security

- An answer quoted without a model that lists the names of workspace files (a greeting, the
  document list) stays on the device like the turns that use the files: never synced, never sent
  to a cloud provider or an own server as chat history.
- The Python backend runs with the service role, which bypasses RLS; its document list and search
  results are now limited to published rows, like the browser's.
- Receipts are validated against size and field limits and refused with members the format does
  not define; the app renders them as text only, and the command-line verifier escapes control and
  bidirectional characters. A receipt exported without excerpt texts quotes no excerpt text in its
  source-check reasons either.

## [1.1.0] - 2026-09-24

### Added

- **On-device workspace.** PDF, text, Markdown, JSON and CSV files are parsed in a dedicated
  worker (pdf.js without `eval` or font loading), split into 500-character chunks with a
  50-character overlap and exact offsets, and indexed with Okapi BM25 (k1 = 1.2, b = 0.75). Files
  live in memory only; nothing is uploaded.
- **Verifiable citations.** Every passage an answer is given carries a `[Doc: <name>, Chunk: <n>]`
  label. Only labels the app registered itself become citation buttons, and the drawer shows the
  exact chunk inside its source text, with offsets and score.
- **WebLLM engine in a dedicated Web Worker** with load sequencing, cancellation, quota checks,
  device-loss handling and a 32-bit fallback for adapters without `shader-f16`.
- **Diagnostics and benchmark.** WebGPU adapter report (vendor, architecture, limits,
  `shader-f16`) and a benchmark on the loaded model: warm-up, fixed prompt, time to first token
  and decode tokens per second.
- **English and German UI.** English by default, an instant EN | DE switch without a reload,
  dictionaries with identical keys, and language-specific system prompts. Lucide icons replace
  every emoji.
- **Anonymous Supabase sessions** with owner-based row level security, and full-text search
  through the `search_knowledge` RPC (migration `20260923000000`).
- **Build and quality gates.** esbuild and Tailwind build with a strict Content-Security-Policy and
  no inline code, verified after every build; unit tests, Playwright end-to-end tests on desktop
  and mobile, and CI jobs for the frontend, end-to-end, backend, database (PostgreSQL 16 with
  pgvector) and secret scanning.
- **Documentation.** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) with 87 diagrams checked
  against the code (copies in the README and guides stay in sync through `npm run docs:sync`), a
  [walkthrough](docs/WALKTHROUGH.md), [`backend/README.md`](backend/README.md), an animated
  pipeline overview in the README, a security policy and a code of conduct. CI renders every
  Mermaid block and fails on a diagram copy that differs from the atlas or on a broken link or
  anchor.

### Changed

- **Database** (migration `20260924000000`): published rows are read-only for browser roles,
  `brain_settings` is service role only, and CHECK constraints bound every text and JSON column the
  browser can write.
- **Rendering:** all Markdown passes through DOMPurify with a restrictive profile.
- **Privacy notices** state where the question goes in each mode, including the knowledge-base
  search.
- **Backend:** binds to loopback by default and requires a bearer token on any other interface.
  Request threads are no longer daemonic, so a shutdown finishes requests in flight. The service
  reads its `.env` itself instead of through systemd, so quotes and inline comments are parsed the
  same way everywhere, and the last assignment of a key wins.

### Fixed

- Chat turns that use the on-device workspace (the question, a named attachment and the answer)
  are never synced to Supabase.
- The local preview server, which also runs the end-to-end tests, applied the production headers
  only to `/`; scripts, workers and the manifest now get the CSP as in production.
- After *Clear workspace* or a worker crash, an earlier citation could open a newer file with the
  same id; document ids are now unique per worker.
- A superseded cache-only model load could reset the status of a newer load.
- *Settings saved* appeared even when the browser refused to store the settings.
- After an offline start the app never reconnected; it now retries when the browser is back
  online and with a growing delay.
- `http://[::1]` own-server URLs passed validation but were blocked by the CSP; they are now
  rejected with a clear message.
- `deploy_ec2.sh` generates `BRAIN_API_TOKEN` when missing, refuses to rewrite an unreadable
  `.env`, works when the file belongs to the service user, and fails when the health check does
  not answer.
- Chat history is restored on boot, and the knowledge graph is reachable on phones.

### Security

- Browser roles only see public rows or their own; chats are visible to their owner only, and
  browser roles cannot execute SECURITY DEFINER functions.
- Provider API keys stay in the browser tab unless the user opts in to keep them.
- The backend refuses requests forwarded by a reverse proxy when no token is set, bounds
  `Content-Length`, answers 408 on slow bodies and rejects non-finite embeddings.
- Development dependencies: Mermaid 12 pulled `lodash-es` 4.17.23 (GHSA-r5fr-rjxr-66jc,
  GHSA-f23m-r3pf-42rh); an npm override pins the patched 4.18.1. `npm audit` reports no known
  vulnerabilities.

## [1.0.0] - 2026-09-12

- First public release: knowledge base on Supabase with pgvector, knowledge graph, voice input,
  cloud and on-device (WebGPU) answers, and an installable PWA.

[Unreleased]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/umutcantezgel-cpu/Starpi/releases/tag/v1.0.0
