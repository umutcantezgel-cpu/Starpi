# Changelog

All notable changes to Starpi. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/umutcantezgel-cpu/Starpi/releases/tag/v1.0.0
