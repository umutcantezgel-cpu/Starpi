# Porting code from related projects

Starpi is public and MIT licensed. Its author also builds related projects, some of them private,
and generic infrastructure sometimes starts in one of them: a parser, a gate, a retry wheel, a build
script. Such code may come into Starpi, under these rules.

## The rule

- **Generic mechanisms only.** What moves is the mechanism: an algorithm, a protocol, a data
  structure, a build or security script. Domain content stays where it was written: vocabularies and
  word lists of a field, catalogs, prompts, examples, fixtures, thresholds tuned on private data.
- **Re-expressed, never copied.** A ported file is written anew for Starpi: neutral names and
  vocabulary, fresh comments, fresh tests and test data, fresh prompts in English and German. No file
  is copied byte for byte. The first line after `// @ts-check` notes the origin in one generic
  sentence, for example
  `// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.`
- **Nothing private.** No names of private projects, packages, customers or people; no private file
  paths or home directories; no internal identifiers (decision, work-package or requirement
  numbers); no private run documents. This holds for code, tests, fixtures, documentation, commit
  messages and pull request texts alike.

A change that would need private context to be understood is not ready to be ported.

## How it is enforced

Before a branch is merged, the public hygiene check scans the repository:

```sh
node scripts/public-hygiene.mjs                    # every tracked file: content and path
node scripts/public-hygiene.mjs --range main..HEAD # also the commit messages of the branch
```

[`scripts/public-hygiene.mjs`](../scripts/public-hygiene.mjs) holds only generic patterns, no list of
private terms: absolute paths into personal home directories (macOS, Linux, Windows; the CI runner's
home directory is allowed in workflow files), the identifier, header and marker prefixes of a related
private project, and the shapes of internal ids. It prints one `file:line:column` line per finding
and exits with code 1; it exits with 0 when the repository is clean and with 2 on a usage or git
error.

A legitimate hit is allowed explicitly, with a reason:

- on the same line, in a comment: `hygiene-allow: <reason>`;
- for a file that cannot carry a comment, with an entry in
  [`scripts/public-hygiene.allow.json`](../scripts/public-hygiene.allow.json) that names the path (or
  the commit), optionally the rule and the line, and the reason. The entry does not repeat the
  matched text.

The check does not replace review: if something looks like it came from somewhere else, ask.
