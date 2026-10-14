# Changelog

All notable changes to Starpi. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.0.0] - 2026-10-14

### Breaking changes

- **Receipts are written in format `starpi.receipt/v2`** (Merkle tree, inclusion proofs, optional
  signature). Verifiers of 1.x refuse them; `buildReceipt(draft, { schema: RECEIPT_SCHEMA_V1 })`
  still writes v1, and v1 receipts are still read and verified.
- **The source check runs version 2 of its rules** (`GROUNDING` = `starpi-grounding` 2) by
  default. Verdicts change: new reasons can mark statements weak, version numbers are compared as
  codes, and the value-context check reads the passage around each value instead of the section.
  `groundAnswer(blocks, sources, { version: 1 })` runs the rules of 1.x unchanged (byte-identical
  output, pinned by the golden tests), and receipts are recomputed with the version they record.
- **Two new reason codes**, `negation_inversion` and `name_context`, in reports, receipts, the
  JSON Schema and SARIF; code that switches over reason codes needs to handle them. A receipt in
  format v1 with one of them is refused.

### Added

- **Source check version 2** (`src/js/core/polarity.js`, `src/js/core/binding.js`), in English and
  German, deterministic and without dependencies, each statement checked on its own so receipts
  recompute it:
  - `negation_inversion` (weak): the statement drops, adds or reverses the negation of the excerpt
    clause it matches, also through opposites (enabled/disabled, allowed/prohibited,
    increased/decreased, un-/in-/dis- words, erlaubt/verboten, gestiegen/gesunken). Negations
    written differently count as the same meaning; "no later than", "not … until", "only after",
    ranges, questions and clauses with different numbers are not read as reversals.
  - `name_context` (weak): the passage the statement matches names someone or something else;
    titles ("Frau", "Mr"), the German genitive and hyphenated names are matched, names the
    question gave are not checked.
  - `fact_context` in version 2: the value's own passage without the section heading; a list part
    without a subject of its own shares the first part's words; version numbers ("firmware
    4.2.1", also date-shaped ones such as "4.2.10") are codes.
- **Receipts v2** (`src/js/core/merkle.js`, `src/js/core/signature.js`, `src/js/core/hash.js`): an
  RFC 6962 Merkle tree over the citations with an inclusion proof per citation
  (`verifyCitationProof`), Ed25519 or ECDSA P-256 signatures with WebCrypto (`signReceipt`,
  `verifyReceiptSignature`, `importPublicKey`, `publicKeyId`), statuses `valid`, `invalid`,
  `unsigned`, `key_mismatch` and `unsupported_algorithm`, and `trusted` only for a key the caller
  supplied. `docs/spec/receipt-v2.schema.json` and a rewritten `docs/spec/receipts.md`.
- **`starpi-ground`**, a second command of `@starpi/core`: checks a Markdown document of any length
  against source files and writes text, JSON or SARIF 2.1.0 (`--format`, `--output`, `--fail-on`,
  `--cite`), exit codes 0, 1 and 2; `checkDocument` and `toSarif` in the API. A GitHub Actions
  snippet with `upload-sarif` is in both READMEs.
- **App:** the source-check panel names the new reasons in English and German; the receipt
  dialog shows the Merkle root, verifies inclusion proofs and, with an optional public key, the
  signature. `starpi-verify-receipt --public-key` does the same on the command line.
- **Evaluation for 2.0:** `tests/fixtures/grounding/sources-v2.json` (technical specifications in
  English and German), `eval-v2-dev.json` (107 answers), `eval-v2-holdout.json` (104 answers,
  frozen by SHA-256 before any version 2 rule was written), `paraphrases.json` (854 faithful
  paraphrases from a red-team review), `docs/eval/v2-protocol.md` and `docs/eval/v2-results.md`
  (the one final measurement). `scripts/eval-source-check.mjs` gains `--sets`, `--grounding`,
  `--variants` and `--unblind`, and refuses a changed held-out file.
- `@starpi/core` exports `GROUNDING_VERSIONS`, `REASON_CODES`, `REASON_CODES_V1`, the receipt,
  Merkle and signature functions, `checkDocument`, `toSarif`, `describeReason` and
  `REASON_MESSAGES`.
- Tests: `merkle.test.mjs` (RFC 6962 vectors, an independent implementation for 0 to 64 leaves),
  `receipt-v2.test.mjs` (round trips, tampering, both signature algorithms, the receipt written by
  1.3.0), `ground.test.mjs`, `grounding-v2.test.mjs`; golden pins of version 2 on every answer
  set; end-to-end tests for the new reasons and for a v2 receipt with an ES256 signature.

### Changed

- The release workflow smoke-tests both commands of the packed tarball and a SARIF run.
- The panel's note says what the check compares; the README, the package README, the receipt
  specification, `SECURITY.md`, the walkthrough and the architecture atlas describe version 2.
- `@starpi/core` and the app are 2.0.0; `CITATION.cff` follows.

### Results

Measured once on the held-out set written for 2.0 (`docs/eval/v2-results.md`): version 2
detects 17 of 23 wrong names (version 1: 10), 20 of 24 correct values attached to the wrong thing
(13) and 16 of 23 reversed statements (0), and marks no statement of a faithful answer unsupported
in any set; statements of faithful answers marked weak there rise from 4 to 8 of 144. The targets
of 8 of 10 are reached for values, not for names (74 %) or negations (70 %).

## [1.3.0] - 2026-10-13

### Added

- **Dependency audit in CI.** A new `audit` job fails on any advisory in runtime npm dependencies
  and on any advisory in the backend requirements (`pip-audit`, pinned in
  `backend/requirements-dev.txt`). Advisories in development tooling are reported as a warning.
- **README model table is checked against the WebLLM catalog.** `tests/unit/models.test.mjs`
  compares the VRAM figures with `vram_required_MB` of the pinned catalog and the context window
  with the one the app requests.
- **"Reproduce the published numbers"** in the README: the commands and the test that pins each
  figure.
- `.mailmap` with the maintainer's canonical name and address.
- **`@starpi/core` ready for npm.** The package is a workspace of the root package (so
  `npm pack --workspace=@starpi/core` and `npm publish --workspace=@starpi/core` work), has the
  app's version (1.3.0, raised from 0.1.0; both are released together from now on), declares
  `publishConfig.access: public`, `main`, a `bin` path npm does not have to correct, and keywords
  for search. Its README covers installing from npm or from the release tarball with its
  checksum, every task with its function, chunking and BM25 search, the command line, the supply
  chain and versioning; every example in it was run against the packed tarball.
- **Release assets.** `release.yml` now builds the `@starpi/core` tarball and the SBOMs in a
  `prepare` job with read-only permissions, smoke-tests the tarball (file list, version banner, an
  offline install into an empty project, the exports, the `starpi-verify-receipt` command) and
  writes `SHA256SUMS`; the `release` job, the only one with write access, installs and runs
  nothing from the repository, checks the checksums and attaches `starpi-core-X.Y.Z.tgz`,
  `starpi-X.Y.Z.cdx.json`, `starpi-core-X.Y.Z.cdx.json` and `SHA256SUMS`. A tag pushed ahead of
  the release must point at the commit CI tested, and both packages must have the same version.
- **CycloneDX SBOMs.** `npm run sbom` (`scripts/sbom.mjs`, `scripts/lib/sbom.mjs`) writes
  CycloneDX 1.5 SBOMs of the app (every package in the lockfile, development tooling marked) and
  of `@starpi/core` (no components: the package has no dependencies) from `package-lock.json`,
  without installing anything. npm's random serial number and timestamp, directory-based names
  and a package listed twice under one `bom-ref` are normalized, so the files are byte-identical
  for one commit and one npm version; each document is checked before it is written. The CI
  `audit` job uploads them as the `sbom` artifact on every run; `tests/unit/sbom.test.mjs` covers
  the normalization and runs the command twice.
- **CI packs `@starpi/core` on every pull request** (`npm run pack:core` in the `frontend` job:
  a typed build and the list of published files), so a broken declaration fails before a
  release.
- **Documentation.** README sections *Use the checks in your own app* and *Ecosystem and
  downstream use*; a *Supply chain* section in `SECURITY.md` (SBOMs, audit gates, pins, release
  assets and how to check them); a *Releases* section in `CONTRIBUTING.md`; an issue template for
  `@starpi/core`.

### Changed

- `SECURITY.md`: email channel next to GitHub private advisories, disclosure targets
  (acknowledgement within 7 days, triage within 14, fix within 90) and a safe-harbor statement.
  The Code of Conduct lists the same address for enforcement reports.
- Copyright holder and package author use the maintainer's full name.
- `npm run typecheck` passes `--noEmit` explicitly.
- `source-map-js` 1.2.1 → 1.2.2 in the lockfile (development dependency, GHSA-68fv-2mgg-jv7q).
- npm `overrides` pin `katex` 0.18.11 under mermaid (GHSA-238p-pmpm-9mq7) and
  `postcss-selector-parser` 7.1.6 under Tailwind CSS 3 (GHSA-rj75-hqrm-r3gf). Both are
  development dependencies; the built `dist/` is byte-identical.
- Dependencies: `pdfjs-dist` 6.3.289 → 6.4.299, `lucide` 1.47.0 → 1.52.0, `dompurify` 3.4.15 →
  3.4.16, `@supabase/supabase-js` 2.117.0 → 2.117.2; development tooling `eslint` 10.11.0 →
  10.12.0, `globals` 17.12.0 → 17.13.0, `jsdom` 30.1.1 → 30.1.2, `mermaid` 12.0.0 → 12.1.0,
  `ruff` 0.16.8 → 0.16.10. The source-check evaluation output is
  unchanged.
- The architecture atlas and `CONTRIBUTING.md` describe the `audit` job (six CI jobs), the
  explicit `--noEmit`, and name mermaid 12.1.0 and ruff 0.16.10.
- `pack:core` runs `npm pack --workspace=@starpi/core --dry-run`; its `prepack` script builds the
  package once, with type declarations.
- `tests/unit/core-package.test.mjs` also checks that `files` covers every entry point, that the
  package is public, a workspace of the root and has the app's version (in `package.json` and in
  the lockfile), and that its `pdfjs-dist` peer range has the major version the app ships.
- `SECURITY.md`: supported versions for the web app and for `@starpi/core`; the package, its
  command and the release assets are in scope; release assets are checksummed, not signed (known
  limitation).
- Issue and pull request templates: a security pointer in the bug report, `@starpi/core` and
  release in the affected areas, `ruff format --check`, the dependency audit, `pack:core`, rule
  version bumps and a release checklist.
- The architecture atlas, `CONTRIBUTING.md`, `docs/WALKTHROUGH.md` and the README describe the
  SBOM steps, the dry-run pack, the two release jobs and 25 unit test files.

### Fixed

- README: the first answer set flags 48 of 49 changed values, not 47; the floor in
  `tests/unit/source-check-eval.test.mjs` is raised to match.
- `docs/WALKTHROUGH.md` counted 117 diagrams in the atlas; it has 118.

### Security

- The release job that holds `contents: write` still installs and runs no dependency code: the
  package is built and tested in a separate read-only job, and the assets are checked against
  `SHA256SUMS` before they are attached.
- `npm audit` reports GHSA-vfj7-8cjw-p6xm (braces 3.0.3, denial of service through deeply nested
  patterns, no patched release yet) in Tailwind CSS 3's file watcher and glob matching, which are
  development dependencies. The CSS build only expands the globs of `tailwind.config.js`, and
  nothing of them is shipped in `dist/`; the runtime audit reports no known vulnerabilities.

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

[Unreleased]: https://github.com/umutcantezgel-cpu/Starpi/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.3.0...v2.0.0
[1.3.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/umutcantezgel-cpu/Starpi/releases/tag/v1.0.0
