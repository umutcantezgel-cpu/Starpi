# Changelog

All notable changes to Starpi. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **On-device workspace.** PDF, text, Markdown, JSON and CSV files are parsed in a dedicated
  worker (pdf.js without `eval` or font loading), split into 500-character chunks with a
  50-character overlap and exact offsets, and indexed with Okapi BM25 (k1 = 1.2, b = 0.75). Files
  live in memory only; nothing is uploaded.
- **Verifiable citations.** Every passage an answer is given carries a `[Doc: <name>, Chunk: <n>]`
  label. Only labels the app registered itself become citation buttons, and the drawer shows the
  exact chunk inside its source text, with offsets and score.
- **Diagnostics and benchmark.** WebGPU adapter report (vendor, architecture, limits,
  `shader-f16`) and a benchmark on the loaded model: warm-up, fixed prompt, time to first token
  and decode tokens per second.
- **English and German UI.** English by default, an instant EN | DE switch without a reload,
  dictionaries with identical keys, and language-specific system prompts. Lucide icons replace
  every emoji.
- **Architecture atlas.** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) with 87 diagrams checked
  against the code, exact copies in the README and the guides (`npm run docs:sync`), a new
  [`backend/README.md`](backend/README.md) and a [walkthrough](docs/WALKTHROUGH.md).
- **Documentation tests.** CI renders every Mermaid block with the pinned Mermaid release and
  fails when a diagram copy differs from the atlas or a link or anchor is broken.

### Changed

- **Database** (migration `20260924000000`): published rows are read-only for browser roles,
  `brain_settings` is service role only, and CHECK constraints bound every text and JSON column the
  browser can write.
- **Privacy notices** state where the question goes in each mode, including the knowledge-base
  search.
- **Backend:** request threads are no longer daemonic, so a shutdown finishes requests in flight.
  The service reads its `.env` itself instead of through systemd, so quotes and inline comments
  are parsed the same way everywhere, and the last assignment of a key wins.

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
- The backend behind a reverse proxy failed open without a token; it now refuses proxied requests,
  bounds `Content-Length`, answers 408 on slow bodies and rejects non-finite embeddings.
- `deploy_ec2.sh` generates `BRAIN_API_TOKEN` when missing, refuses to rewrite an unreadable
  `.env`, and fails when the health check does not answer.
- Chat history is restored on boot again, and the knowledge graph is reachable on phones.

## [1.1.0] - 2026-09-23

### Added

- Anonymous Supabase sessions with owner-based row level security, and full-text search through
  the `search_knowledge` RPC (migration `20260923000000`, with a PostgreSQL test harness).
- esbuild and Tailwind build with a strict Content-Security-Policy and no inline code, verified
  after every build.
- WebLLM in a dedicated Web Worker with load sequencing, cancellation, quota checks, device-loss
  handling and a 32-bit fallback for adapters without `shader-f16`.
- Unit tests, Playwright end-to-end tests on desktop and mobile, and CI jobs for the frontend,
  end-to-end, backend, database and secret scanning.
- Security policy and code of conduct; the contributor guide was rewritten.

### Changed

- All rendered Markdown passes through DOMPurify with a restrictive profile, and provider keys
  stay in the tab unless the user opts in.
- The backend binds to loopback by default and requires a bearer token on any other interface.

## [1.0.0] - 2026-09-12

- First public release: knowledge base on Supabase with pgvector, knowledge graph, voice input,
  cloud and on-device (WebGPU) answers, and an installable PWA.

[Unreleased]: https://github.com/umutcantezgel-cpu/Starpi/compare/b8601b5...HEAD
[1.1.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.0.0...b8601b5
[1.0.0]: https://github.com/umutcantezgel-cpu/Starpi/releases/tag/v1.0.0
