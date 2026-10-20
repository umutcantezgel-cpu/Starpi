# AGENTS.md: @starpi/core

The root [AGENTS.md](../../AGENTS.md) applies; this file lists what differs here.

- **The source is not in this folder.** `src/index.js` only re-exports modules of the app
  (`src/js/core/` and `src/js/rag/`). Change the module in `src/js`, then the export
  here if the public API changes. `scripts/build-core.mjs` bundles it into `dist/` (ignored by git).
- **The three CLIs are bundled from `scripts/`:** `starpi-gate` from `scripts/gate.mjs`,
  `starpi-ground` from `scripts/ground.mjs` and `starpi-verify-receipt` from
  `scripts/verify-receipt.mjs`; change a CLI there.
- **No dependencies, platform-neutral.** The bundle may import nothing but the optional peer
  `pdfjs-dist`, and must run in browsers, workers and Node.js (no DOM, network or storage APIs in the
  exported code paths).
- **Commands** (from the repository root):
  - `npm run build:core`: build `dist/` with type declarations generated from the JSDoc types;
  - `npm run pack:core`: the same build, then the file list `npm pack` would publish;
  - `node --test tests/unit/core-package.test.mjs`: builds the package into a temporary folder and
    uses it the way a consumer would (also part of `npm test`).
- **Verdicts are versioned.** A change that can change a verdict, the extracted text or the chunks
  bumps `GROUNDING`, `EXTRACTOR` or `CHUNKER` and updates the golden pins
  (`tests/unit/golden.test.mjs`); receipts record these versions. The receipt format is specified in
  [docs/spec/receipts.md](../../docs/spec/receipts.md).
- **Docs.** Public API changes go into [README.md](README.md) here. The package is released with the
  app and has the same version number; do not change the version outside a release.
