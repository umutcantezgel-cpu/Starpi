# AGENTS.md

Instructions for coding agents (and people) working in this repository: what Starpi is, where things
live, the exact commands CI runs, and the rules a change must keep. [CONTRIBUTING.md](CONTRIBUTING.md)
has the full conventions; packages with commands of their own have a short `AGENTS.md` beside them
([packages/core](packages/core/AGENTS.md), [packages/companion](packages/companion/AGENTS.md),
[companion/voice-server](companion/voice-server/AGENTS.md)).

## What Starpi is

Starpi is a knowledge assistant in the browser that shows how far each answer can be trusted. It
answers with the model the user picks: a cloud provider with the user's own key, a free model from the
site's key pools, the user's own server, a model on the device (WebGPU or WebAssembly) or Starpi Core,
the local companion. Grounded answers cite their passages, a deterministic source check (no second
model) compares every statement with the cited text, and a receipt signed on the device lets anyone
verify the answer against the original files. The app is a static site plus stateless server
functions; files and chats stay on the device. The same checks ship as the npm package `@starpi/core`,
and the companion as `@starpi/companion`. MIT licence, UI in six languages.

## Repository map

| Path | What lives there |
| --- | --- |
| `src/index.html`, `src/js/` | The single-page app: framework-less ES modules, boot in `src/js/main.js` |
| `src/js/ai/` | AI layer: adapters per wire format, transports (direct, relay, pool, device), provider and model catalogs, keys and vault, router, tools, MCP, memory |
| `src/js/chat/` | Chat thread: Auto, Free and Grounded turns, branches, attachments, compare, canvas |
| `src/js/core/` | Pure modules (no DOM, network or storage): citation labels, facts, the source check, the sentence gate, receipts, Merkle trees, signatures, language packs |
| `src/js/rag/` | On-device workspace: ingestion worker, parsers, chunker, BM25, citations, receipts UI |
| `src/js/webgpu/`, `src/js/wasm/`, `src/js/models/` | On-device runtimes (WebLLM, Transformers.js) and the pure model data they use |
| `src/locales/` | UI dictionaries: `<lang>.json` plus `<namespace>/<lang>.json` for en, de, fr, es, it, tr |
| `api/` | Vercel Functions: relay, key pools, speech, research steps, health; shared modules in `api/_lib/` |
| `packages/core/` | `@starpi/core`: entry and package files only, bundled from `src/js` by `scripts/build-core.mjs` |
| `packages/companion/` | `@starpi/companion`: the local companion (Node.js service, its own tests in `test/`) |
| `companion/voice-server/` | Optional local voice server (Python, one file, tests with fake engines) |
| `scripts/` | Build, dev server, output verification, provider fakes, gates (headers, licences, EOL, hygiene), SBOMs, evaluations |
| `tests/unit/`, `tests/e2e/` | Node unit tests (`node --test`) and Playwright end-to-end tests |
| `backend/supabase/`, `tools/library-publisher/` | Database schema, migrations and RLS tests; the optional Python library publisher |
| `docs/` | [Walkthrough](docs/WALKTHROUGH.md), [architecture atlas](docs/ARCHITECTURE.md) (the only place diagrams are edited), server functions, migration guide, receipt spec, release notes |

## Setup

- Node.js 22.13 or newer (`engines` in `package.json`; `.nvmrc` says 22). CI uses Node.js 22 and
  also runs the companion on 24. npm 10 or newer.
- Install exactly the lockfile, without install scripts (as CI and Vercel do):
  `npm ci --ignore-scripts`
- End-to-end tests need Chromium: `npx playwright install chromium` (CI adds `--with-deps`), or set
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a Chromium that is already installed.
- Python 3.11 or newer for the voice server; its tests use only the standard library. Lint needs
  `ruff` at the version `.github/workflows/ci.yml` pins. The library publisher needs
  `python -m pip install -r tools/library-publisher/requirements-dev.txt`, best in a `.venv/`
  (ignored by git).
- No secrets are needed for any check: the tests build fake keys at runtime, the end-to-end tests
  run against local provider fakes and a mocked Supabase, and without `STARPI_SUPABASE_URL` and
  `STARPI_SUPABASE_ANON_KEY` the build uses the project's public, RLS-protected defaults.

## Commands

Run them from the repository root.

| Purpose | Command |
| --- | --- |
| Lint (ESLint) | `npm run lint` |
| Typecheck (`tsc --noEmit`, strict, over JSDoc) | `npm run typecheck` |
| Unit tests | `npm test` (one file: `node --test tests/unit/docs.test.mjs`) |
| Production build into `dist/` | `npm run build` |
| Verify the build output (CSP, header parity, assets, service worker, first-load budget, no keys) | `npm run verify:dist` (after a build) |
| All of the above plus `headers:check`, `license:check` and `eol:check` | `npm run verify` |
| Public hygiene (CI runs it after `verify`) | `npm run hygiene:check` |
| `@starpi/core`: typed build and the file list `npm pack` would publish | `npm run pack:core` |
| Companion typecheck and tests (build `@starpi/core` first) | `npm run typecheck:companion`, `npm run test:companion` |
| Companion dependency and licence rules | `node scripts/companion-deps-check.mjs`, `node scripts/companion-license-check.mjs` |
| End-to-end tests | `npm run build && npm run test:e2e` |
| Voice server tests | `python3 -I -B -m unittest discover -s companion/voice-server -v` |
| Voice server lint (in `companion/voice-server`) | `ruff check --no-cache . && ruff format --check --no-cache .` |
| Library publisher | `ruff check tools/library-publisher backend --no-cache && ruff format --check tools/library-publisher backend`, then `python -m unittest discover` in `tools/library-publisher` |
| Database migrations and RLS (PostgreSQL 16 server binaries and pgvector) | `bash backend/supabase/tests/run_rls_tests.sh` |
| Diagram copies from the atlas | `npm run docs:sync` (`npm run docs:sync -- --check` only checks) |
| Headers of `vercel.json` from `scripts/headers.json` | `npm run headers:gen` |
| Dev server with production headers and the functions on `http://127.0.0.1:3000` | `npm run dev` |

End-to-end details: Playwright starts `node scripts/serve.mjs` for `dist/` on `STARPI_E2E_PORT`
(default 4173) and the provider fakes (`scripts/fakes/index.mjs`, also `npm run fakes`) on
`STARPI_FAKES_PORT` (default 4610) and the seven ports above it. Outside CI it reuses a server that
already listens on those ports, so stop stale servers or choose other ports, for example
`STARPI_E2E_PORT=5371 STARPI_FAKES_PORT=5372 npx playwright test --project=desktop-chromium tests/e2e/app.spec.mjs`.
The projects are `desktop-chromium` and `mobile-chromium`. The specs never reach a real provider.

## Conventions

- **ES modules, no TypeScript build.** Modules start with `// @ts-check` and carry JSDoc types;
  every checked module under `src/js/` and `api/` must be listed in `tsconfig.json` (a unit test
  checks this). Strict mode, `any` is not accepted.
- **CSP-safe code.** No inline scripts, event handlers or styles, no `eval`: clicks and changes go
  through `data-action` / `data-change` registered with `onAction()` / `onChange()` in
  `src/js/dom.js`; styles through CSSOM or complete Tailwind (v3) class names. Untrusted text goes
  through `escapeHtml()`, Markdown only through `renderMarkdown()`.
- **Pure parts stay pure.** `src/js/core/` and `src/js/models/` use no DOM, network or storage APIs.
  `api/` uses Web `Request` and `Response` only and reads the environment only in `api/_lib/env.js`.
- **i18n.** Every user-visible string lives in `src/locales/` and exists in all six languages (en,
  de, fr, es, it, tr) with the same `{placeholders}`; markup uses `data-i18n*` attributes, code uses
  `t()` or `setText()`. Code, comments and docs are English. No emoji in `src/`; icons are Lucide
  icons registered in `src/js/icons.js`.
- **Generated files.** Response headers are edited in `scripts/headers.json`, then
  `npm run headers:gen` writes `vercel.json`. Diagrams are edited only in `docs/ARCHITECTURE.md`,
  then `npm run docs:sync` refreshes the copies. Relative links in Markdown must resolve
  (`tests/unit/docs.test.mjs`).
- **Versioned rules.** A change to text extraction, chunking or the source check that moves the
  golden tests bumps `EXTRACTOR`, `CHUNKER` or `GROUNDING` (see CONTRIBUTING).
- **Budgets and gates.** `verify:dist` enforces the first-load bundle budget, so load heavy code
  lazily. Dependencies are exact pins; the lockfile changes only through npm. New production
  dependencies must pass the licence gate (`scripts/license-allowlist.json`) and the end-of-life
  register.
- **Public repository.** `npm run hygiene:check` keeps absolute home-directory paths and internal
  identifiers of other projects out of every tracked file and commit message. A legitimate hit is
  allowed only with a `hygiene-allow: <reason>` comment or an entry in
  `scripts/public-hygiene.allow.json`.
- Do not claim capabilities the code does not have (privacy, locality, hosting region).

## Security rules

- Never put a real key, token or password in code, tests, fixtures, logs, commit messages or pull
  request text. Tests build fake keys at runtime; gitleaks (`.gitleaks.toml`) and a unit test scan
  the repository, and `verify:dist` fails on a site key in the bundles.
- Bring your own key: a user's key lives in the tab's session storage, or encrypted in the key vault
  when a passphrase is set, and goes only to its provider, directly or through the relay. Keys never
  go into URLs, receipts, syncs, exports or logs. The site's own keys exist only in the server
  environment.
- The relay forwards only to the fixed hosts, methods and paths in `api/_lib/relay/upstreams.js`;
  never to a URL from the request. The pools forward only allowlisted models
  (`api/_lib/pool/allowlist.js`). Extend these tables with tests, never bypass them.
- Never log a secret, a request body or a provider answer. The relay returns only an error
  identifier of the upstream's answer, the pools name a key by its index only, and key-shaped text
  goes through `api/_lib/relay/scrub.js` before it reaches a log line or an error answer.
- The browser gets only the publishable (or `anon`) Supabase key; the build refuses others. New
  tables and functions need RLS policies, explicit grants and tests.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in issues.

## Commits and pull requests

- Branch from `main`, keep a change focused and use
  [Conventional Commits](https://www.conventionalcommits.org/) (`fix(chat): …`, `feat(ai): …`,
  `docs: …`).
- Before a pull request: `npm run verify`, `npm run hygiene:check` and the end-to-end tests, plus the
  package, Python or database checks above for the parts you touched.
- Fill in the [pull request template](.github/pull_request_template.md); update the docs and the
  `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) when behaviour changes.
- Contributions made with AI tools are welcome under the same rules as any other: the author
  understands the change, it follows these conventions and it passes the checks.
