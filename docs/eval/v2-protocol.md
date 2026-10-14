# Evaluation protocol for the source check of Starpi 2.0

Written on 2026-10-13, before any rule of version 2 of the source check (`starpi-grounding` 2) was
written, and committed together with the answer sets it describes. It fixes how the version 2
rules are developed and measured, so that the published results are not tuned to the answers they
are measured on.

## Answer sets

| Set | File | Answers | Written for | Role |
| --- | --- | --- | --- | --- |
| `dev` | [`eval.json`](../../tests/fixtures/grounding/eval.json) | 129 (50 faithful, 79 with one error) | Starpi 1.2 | Used while the version 2 rules are developed. |
| `holdout` | [`eval.json`](../../tests/fixtures/grounding/eval.json) | 179 (100 faithful, 79 with one error) | Starpi 1.2 | Measured once at the end. Its misses under version 1 were inspected while version 2 was designed, so it is not a clean held-out measure for version 2; its results are published with that note. |
| `v2dev` | [`eval-v2-dev.json`](../../tests/fixtures/grounding/eval-v2-dev.json) | 107 (35 faithful, 72 with one error) | Starpi 2.0 | Used while the version 2 rules are developed. |
| `v2holdout` | [`eval-v2-holdout.json`](../../tests/fixtures/grounding/eval-v2-holdout.json) | 104 (34 faithful, 70 with one error) | Starpi 2.0 | Frozen with this commit: its SHA-256 is in [`eval-v2-holdout.sha256`](../../tests/fixtures/grounding/eval-v2-holdout.sha256). Not read while the rules are developed; measured once at the end. |
| `paraphrases` | [`paraphrases.json`](../../tests/fixtures/grounding/paraphrases.json) | 854, all faithful (844 checked statements) | Starpi 2.0, after the first version 2 rules | Added later, see [Review before the final measurement](#review-before-the-final-measurement). Used while the rules are developed. |

## How the version 2 sets were made

- **Sources.** The sample files and the sample knowledge base of the version 1 sets, and
  [`sources-v2.json`](../../tests/fixtures/grounding/sources-v2.json): fictitious technical
  documents in English and German (an operating specification of an edge gateway and a plant data
  retention policy, 13 sections with headings per language) with people, sites, vendors, products,
  ports, voltages, firmware versions, retention periods and negated, conditional and doubly negated
  rules.
- **Answers.** Written by language-model agents, one agent per set and category, in the language
  of their sources (no answer mixes languages). The agents were instructed not to run the source
  check and not to read the version 1 sets. A faithful answer states only what its cited excerpts
  say. An answer with an error has exactly one planted error in one statement; `original` is the
  source wording it contradicts (verbatim in the sources) and `changed` the wording that replaces
  it.
- **Categories and variants.**
  - Negation: a negator added or dropped, a state turned into its opposite (`antonym`), or a
    double negation that reverses the meaning.
  - Entity: a person, site, vendor or product swapped for another one in the sources
    (`swap_known`), for one in no source (`unknown`), or two swapped with each other (`multi_swap`).
  - Relation: a correct value attached to the wrong thing within a sentence, taken from another
    section, or two values swapped.
  - Faithful answers: legitimate negations, conditional rules, kept double negations, several names,
    and values next to other values.
- **Review.** Two independent reviewer agents judged every item. Only items both approved were
  kept: 107 of 108 in `v2dev` (one faithful answer dropped) and 104 of 108 in `v2holdout` (one
  negation, one entity and two faithful answers dropped). A structural check confirmed for every
  item that its labels exist, that `changed` occurs in exactly one statement and that `original`
  occurs verbatim in the sources. The reviewers and the agent that assembled the held-out file
  reported only counts, item ids, problem codes and the SHA-256, never item text.

## Development

- The version 2 rules are developed on `dev`, `v2dev` and (later) `paraphrases` only:
  `node scripts/eval-source-check.mjs --sets dev,v2dev,paraphrases --grounding 2 --variants`.
  [`scripts/eval-source-check.mjs`](../../scripts/eval-source-check.mjs) refuses the held-out sets
  without `--unblind`, and refuses a held-out file whose SHA-256 differs from the frozen one.
- The session that writes the rules does not read `eval-v2-holdout.json`.
- The unit tests that measure the labelled answers (`tests/unit/source-check-eval.test.mjs`,
  `tests/unit/golden.test.mjs`) measure version 2 of the rules on the development sets only until
  the final measurement, so running them during development shows nothing about version 2 on the
  held-out sets.
- Before this protocol, while version 2 was designed, a read-only analysis looked at the answers of
  the `holdout` set that version 1 misses and simulated candidate rules on them. That is why
  `holdout` is reported as inspected.

## Review before the final measurement

Before the final measurement, two independent reviewer agents tested the first complete version 2
rules (commit `d755246`), without reading `eval-v2-holdout.json` and without `--unblind`:

- A red-team agent wrote 870 faithful statements in English and German against `sources-v2.json`,
  the sample knowledge base, the sample files and sources of its own (policies, contracts, test
  reports, release notes), dropped 16 it judged ambiguous or not faithful, and ran the rest with
  both versions. Version 2 marked **51 of 843 faithful statements unsupported** (version 1: none),
  all through `negation_inversion`, and 65 more weak that version 1 had passed. The `dev` and
  `v2dev` answers had shown none of this.
- A code reviewer found, among others, a false `missing_fact` for version numbers that look like
  dates ("4.2.10"), a regular expression with quadratic run time on long words that mix ASCII and
  other letters, and name checks that depended on the order of statements and on excerpts a
  statement did not cite (so a receipt could recompute another verdict).

Changes made in response, all before the final measurement:

- `negation_inversion` is always **weak**, never unsupported. Reading negations by their words
  cannot tell every restatement of a negated rule ("prohibited until the update" → "only allowed
  after the update") from its reversal, and the rule that a faithful statement is never marked
  unsupported comes first. This lowers no detection count, since detected means caught or flagged.
- The causes found were fixed: negative words with un-, in-, im-, il-, ir- and dis-, "no longer"
  and "nicht mehr", "neither … nor", hyphenated negators, time conditions ("not … until", "bevor"),
  ranges ("from Monday until Friday"), restrictions ("only after", "nur wenn"), questions, clauses
  with different numbers, titles and the German genitive in names, hyphenated names, list parts
  without a subject of their own, date-shaped version numbers, the run time, and the dependence on
  order and on uncited excerpts.
- The 854 statements became the development set `paraphrases`; the unit tests pin its results.

Measured on the development sets after these changes, compared with `d755246`: `paraphrases` 0
unsupported and 27 weak statements (version 1: 0 and 16; `d755246`: 51 and 77); `dev` and `v2dev`
still no statement of a faithful answer marked unsupported or weak; detected errors unchanged in
`dev` and in the negation category of `v2dev` (24 of 24), one fewer in entity (19 of 24) and in
relation (23 of 24) of `v2dev`. The two lost detections are the price of the order-independent
name check and of comparing only clauses with the same numbers.

## Final measurement

- Once, after the version 2 rules and their tests are final, all four sets are measured with
  both versions of the rules:
  `node scripts/eval-source-check.mjs --unblind --grounding 1 --variants` and
  `node scripts/eval-source-check.mjs --unblind --grounding 2 --variants`.
  The output is published as measured, in the README, the architecture atlas and the release
  notes, also where a result stays below the targets.
- **Measures.** For faithful answers: statements marked unsupported (false alarms) and statements
  marked weak. For answers with an error, the statement that contains it: caught (unsupported),
  flagged (weak), missed (supported or unchecked) or not found. "Detected" is caught or flagged.
- **Targets**, not promises: 8 of 10 errors detected in the negation, entity and relation
  categories of `v2holdout`, and no statement of a faithful answer marked unsupported in any set.
- **Ship rule.** A version 2 rule that can mark a statement unsupported ships only if it marks no
  statement of a faithful answer in `dev`, `v2dev` or `paraphrases` unsupported. (After the review
  above, the only such version 2 rule is the reading of version numbers.) If the final measurement still
  shows a statement of a faithful answer marked unsupported by a version 2 reason in any set, that
  reason is lowered to weak, all four sets are measured again, and both measurements are published.
  Nothing else is changed after the final measurement.
- Statements of faithful answers marked weak are reported per set; there is no cap.

## What the numbers do not show

Each category has about 24 answers per version 2 set, written by language models following the
instructions above and reviewed by models; they are not answers from real users, and both version
2 sets were written the same way. The version 2 sets have no answers in another language than
their sources. The version 2 rules compare a statement with the sources in its own language only;
the version 1 sets also contain answers across languages, and those stay limited to the version 1
checks of facts.
