---
name: "@starpi/core package"
about: Report a problem with the npm package or its starpi-verify-receipt command
title: "[CORE]: "
labels: bug, package
assignees: ''
---

<!-- Security problems (a check or the receipt verifier accepting text or files that do not match,
a release asset that differs from SHA256SUMS): do not open an issue, report them privately as
described in https://github.com/umutcantezgel-cpu/Starpi/security/policy -->

### Problem Description
What happened, and what you expected instead.

### Minimal Reproduction
```js
// The smallest code, answer and sources that show the problem.
import { blocksFromMarkdown, groundAnswer } from '@starpi/core';
```

For a receipt problem, attach the receipt (or the output of
`npx starpi-verify-receipt receipt.json <files> --json`) and say which files you verified it against.

### Environment
* **@starpi/core version**: [such as 1.3.0, from `npm ls @starpi/core`]
* **Installed from**: [npm registry, or the release tarball starpi-core-X.Y.Z.tgz]
* **Runtime**: [such as Node.js 22.13, Chrome 141, a Web Worker]
* **Bundler or framework**: [such as Vite 7, esbuild, none]
* **pdfjs-dist version** (PDF extraction only): [such as 6.4.299]

### Additional Context
Anything else that helps, such as the language of the answer and the sources.
