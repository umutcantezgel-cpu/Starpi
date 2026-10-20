## Description of Changes
Explain what changes and why. Link related issues.

## Architectural Area
* [ ] Frontend UI and rendering (`src/js`, `src/index.html`)
* [ ] AI layer, providers, keys and the router (`src/js/ai`)
* [ ] Chat thread, tools and canvas (`src/js/chat`)
* [ ] Source check, sentence gate and receipts (`src/js/core`)
* [ ] On-device workspace and citations (`src/js/rag`)
* [ ] Voice, Live and research (`src/js/voice`, `src/js/live`, `src/js/research`)
* [ ] Storage and the encrypted sync (`src/js/store`, `src/js/sync`)
* [ ] Languages (`src/locales`, `src/js/i18n`)
* [ ] WebGPU runtime and model selection (`src/js/webgpu`)
* [ ] On-device model catalog and WASM runtime (`src/js/models/`, `src/js/wasm/`)
* [ ] Server functions: relay, pools, speech, research (`api/`)
* [ ] Retrieval and Supabase access (`src/js/supabase.js`, `src/js/retrieval.js`)
* [ ] Database schema, migrations and RLS (`backend/supabase`)
* [ ] Service worker and PWA (`src/sw.js`, `public/`)
* [ ] Build, CI and security headers (`scripts/`, `.github/`, `vercel.json`)
* [ ] Library publisher (`tools/library-publisher/`)
* [ ] `@starpi/core` package, SBOMs and release assets (`packages/core`, `scripts/build-core.mjs`, `scripts/sbom.mjs`, `.github/workflows/release.yml`)
* [ ] Local companion (`packages/companion`, `src/js/companion`) or the voice server (`companion/voice-server`)

## Verification
* [ ] `npm run verify` passes (lint, typecheck, unit tests, build, output verification, headers, licence and end-of-life gates)
* [ ] `npm run hygiene:check` passes
* [ ] `npm run test:e2e` passes
* [ ] Companion: `npm run typecheck:companion`, `npm run test:companion` and `node scripts/companion-deps-check.mjs` pass (if touched)
* [ ] Voice server: ruff and `python3 -I -B -m unittest discover -s companion/voice-server` pass (if touched)
* [ ] `npm run pack:core` lists the expected files (if `packages/core` or the modules it bundles changed)
* [ ] Library publisher: `ruff check tools/library-publisher backend`, `ruff format --check tools/library-publisher backend` and `python -m unittest discover` in `tools/library-publisher` pass (if touched)
* [ ] Dependencies: `npm audit --omit=dev` and `pip-audit -r backend/requirements-dev.txt` report nothing (if dependencies changed)
* [ ] Database: `bash backend/supabase/tests/run_rls_tests.sh` passes (if touched)
* [ ] Tested in a WebGPU browser (if the local model path changed)
* [ ] NVIDIA model list: the README T4 table matches (if `src/js/models/nvidia-catalog.js` changed)

### Benchmark Measurements (if inference performance is affected)
* Model and device:
* Time to first token:
* Tokens per second (prefill / decode):
* Peak GPU memory:

## Checklist
* [ ] No inline scripts, event handlers or styles; new actions registered via `onAction()` / `onChange()`
* [ ] Untrusted content rendered only through `escapeHtml()` / `renderMarkdown()`
* [ ] No API key or token in code, tests, logs or this description (test keys are built at runtime)
* [ ] New user-visible text added to `src/locales` in all six languages
* [ ] New tables and functions have RLS policies, explicit grants and tests
* [ ] Documentation updated where behaviour changed
* [ ] Diagrams updated in `docs/ARCHITECTURE.md` and copies synced (`npm run docs:sync`)
* [ ] `CHANGELOG.md` updated under `[Unreleased]`
* [ ] Changed extraction, chunking or source-check rules bump `EXTRACTOR`, `CHUNKER` or `GROUNDING`
* [ ] Release only: the same version in `package.json`, `packages/core/package.json`, `packages/companion/package.json`, `package-lock.json` and `CITATION.cff`, and `docs/releases/vX.Y.Z.md` written
* [ ] Release only: new Vercel environment variables set for Production and Preview before the release deploys
* [ ] Commits follow Conventional Commits
