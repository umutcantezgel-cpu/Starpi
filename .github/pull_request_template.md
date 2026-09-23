## Description of Changes
Explain what changes and why. Link related issues.

## Architectural Area
* [ ] Frontend UI and rendering (`src/js`, `src/index.html`)
* [ ] WebGPU runtime and model selection (`src/js/webgpu`)
* [ ] Retrieval and Supabase access (`src/js/supabase.js`, `src/js/retrieval.js`)
* [ ] Database schema, migrations and RLS (`backend/supabase`)
* [ ] Service worker and PWA (`src/sw.js`, `public/`)
* [ ] Build, CI and security headers (`scripts/`, `.github/`, `vercel.json`)
* [ ] Python backend (`backend/`)

## Verification
* [ ] `npm run verify` passes (lint, typecheck, unit tests, build, output verification)
* [ ] `npm run test:e2e` passes
* [ ] Backend: `ruff check backend` and `python -m unittest discover -s backend -p 'test_*.py'` pass (if touched)
* [ ] Database: `bash backend/supabase/tests/run_rls_tests.sh` passes (if touched)
* [ ] Tested in a WebGPU browser (if the local model path changed)

### Benchmark Measurements (if inference performance is affected)
* Model and device:
* Time to first token:
* Tokens per second (prefill / decode):
* Peak GPU memory:

## Checklist
* [ ] No inline scripts, event handlers or styles; new actions registered via `onAction()` / `onChange()`
* [ ] Untrusted content rendered only through `escapeHtml()` / `renderMarkdown()`
* [ ] New tables and functions have RLS policies, explicit grants and tests
* [ ] Documentation updated where behaviour changed
* [ ] Commits follow Conventional Commits
