## Description of Changes
Explain what changes and why. Link related issues.

## Architectural Area
* [ ] Frontend UI and rendering (`src/js`, `src/index.html`)
* [ ] On-device workspace and citations (`src/js/rag`)
* [ ] Languages (`src/locales`, `src/js/i18n`)
* [ ] WebGPU runtime and model selection (`src/js/webgpu`)
* [ ] On-device model catalog and WASM runtime (`src/js/models/`, `src/js/wasm/`)
* [ ] Vercel Functions and the NVIDIA proxy (`api/`)
* [ ] Retrieval and Supabase access (`src/js/supabase.js`, `src/js/retrieval.js`)
* [ ] Database schema, migrations and RLS (`backend/supabase`)
* [ ] Service worker and PWA (`src/sw.js`, `public/`)
* [ ] Build, CI and security headers (`scripts/`, `.github/`, `vercel.json`)
* [ ] Library publisher (`tools/library-publisher/`)
* [ ] `@starpi/core` package, SBOMs and release assets (`packages/core`, `scripts/build-core.mjs`, `scripts/sbom.mjs`, `.github/workflows/release.yml`)

## Verification
* [ ] `npm run verify` passes (lint, typecheck, unit tests, build, output verification)
* [ ] `npm run test:e2e` passes
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
* [ ] New tables and functions have RLS policies, explicit grants and tests
* [ ] Documentation updated where behaviour changed
* [ ] Diagrams updated in `docs/ARCHITECTURE.md` and copies synced (`npm run docs:sync`)
* [ ] `CHANGELOG.md` updated under `[Unreleased]`
* [ ] Changed extraction, chunking or source-check rules bump `EXTRACTOR`, `CHUNKER` or `GROUNDING`
* [ ] Release only: the same version in `package.json`, `packages/core/package.json`, `package-lock.json` and `CITATION.cff`, and `docs/releases/vX.Y.Z.md` written
* [ ] Release only: new Vercel environment variables set for Production and Preview before the release deploys
* [ ] Commits follow Conventional Commits
