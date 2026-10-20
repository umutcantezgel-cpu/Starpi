# Relations in the source check (version 3): sets and results

Version 3 of the source check (`starpi-grounding` 3) adds one family of checks to version 2:
relations between values or events, within a statement and with the statement before it. This page
describes the two answer sets that measure them, how they were made and used, and what they show.
Every number below comes from `npm run eval:source-check` and is checked by
`tests/unit/source-check-eval.test.mjs`.

## What is checked

- **Changes:** "rose / fell / doubled / halved from A to B", "rose to B", "B, up from A", and the
  German "stieg / sank / verdoppelte sich von A auf B". The direction must be the one the excerpt's
  values give, and a stated factor must be the ratio of the values (within 10 %). "By half" or "um
  ein Viertel" is read with the verb ("rose by half" is 1.5, "fell by half" 0.5), and a hedged
  factor as the bound it states: "more than doubled" wants at least about 2, "nearly halved" a
  little above 0.5, "roughly tripled" about 3 within 20 %.
- **Comparisons:** "more / fewer / higher / lower … than", "twice as many … as" ("mehr … als",
  "doppelt so viele … wie") between two things, two periods or two stated values. Each side is bound
  to the excerpt passage that names it, and the two values are compared.
- **Orders in time:** "before / after / earlier than / later than / followed / preceded" ("bevor /
  nachdem / vor / nach / früher als / später als / gefolgt von") between two events the excerpt
  dates. The passive and the participle turn the order around: "X was followed by Y" and "X,
  followed by Y" put X first, "X followed Y" puts it second.
- **Carried-over values:** "it rose to B", "that number shrank to B", "es waren weniger, nämlich
  B": compared with the single value of a matching unit in the statement before.
- **Shares:** "X % of …" with both values in the statement.

A relation is reported only when the excerpts bind both values or dates to their sides without
ambiguity; negated and conditional clauses are left alone. `relation_inverted` (the other way
round) and `relation_unsupported` (direction right, factor or share not) are always `weak`.

## Answer sets

| Set | File | Answers | Role |
| --- | --- | --- | --- |
| `relations` | [`relations-dev.json`](../../tests/fixtures/grounding/relations-dev.json) | 55 (23 faithful, 32 with one error) | Used while the relation rules were written, and extended after a review with passive orders in time and factor phrases. |
| `relholdout` | [`relations-holdout.json`](../../tests/fixtures/grounding/relations-holdout.json) | 38 (14 faithful, 24 with one error) | Written and frozen before the first relation rule ([SHA-256](../../tests/fixtures/grounding/relations-holdout.sha256)); measured once after the rules were final, and again after the review corrections (same result). |

Both sets answer questions about [`relations-sources.json`](../../tests/fixtures/grounding/relations-sources.json):
fictitious annual and quarterly reports in English and German (a public library, a software company,
a weather station) with visits, loans, revenue, users, costs, release and opening dates. Each answer
has two or three statements with citations. An answer with an error has exactly one planted error
in one statement, in one of five categories: a comparison the wrong way round, a change with the
verb or the values turned around, an order in time reversed, a value carried over from the
statement before that the next statement moves the wrong way, a factor ("tripled") the values do
not give. Every value of a planted statement is in the excerpts, so the fact check alone does not
see the error. Faithful answers state relations the excerpts support, in the same five forms.

The sets were written for this release by the same author as the rules, so they show that the rules
catch the patterns they were designed for and leave faithful statements of the same shapes alone;
they are small and are not an estimate of how often real answers contain such errors. The held-out
set guards against rules tuned to individual answers: its misses were not inspected.

## Results

Detected means marked unsupported or weak. Each cell gives version 3 / version 2.

| | `relations` | `relholdout` |
| --- | --- | --- |
| Statements of faithful answers | 44 | 29 |
| … marked unsupported | 0 / 0 | 0 / 0 |
| … marked weak | 0 / 0 | 0 / 0 |
| Comparison the wrong way round | 8 / 0 of 8 | 7 / 0 of 7 |
| Change turned around | 8 / 1 of 8 | 6 / 4 of 6 |
| Order in time reversed | 7 / 0 of 7 | 3 / 0 of 4 |
| Carried-over value moved the wrong way | 4 / 1 of 4 | 4 / 1 of 4 |
| Factor the values do not give | 5 / 0 of 5 | 3 / 0 of 3 |
| **All planted errors** | **32 / 2 of 32** | **23 / 5 of 24** |

Version 2 sees some turned-around changes as reversed negations ("rose" against "fell"). On every
set version 2 was measured on (the sets for 1.2 and 2.0 and the paraphrases), version 3 gives the
same results, except one more value attached to the wrong thing detected in the set for 2.0 (24
instead of 23 of 24), and it marks no further faithful statement weak.

## Receipts and earlier versions

A relation looks at a statement and the statement before it, in answer order. A receipt records
the checked statements in that order, so `verifyReceipt` recomputes the relation reasons with the
version the receipt records; a statement whose relation rests on an excerpt that is not available
is left out instead of reported as changed. Version 1 and version 2 reports are unchanged by
version 3 (`tests/unit/grounding-v3.test.mjs` pins the whole reports of every labelled answer), and
`starpi-ground --grounding 2` writes what Starpi 2.x wrote.

Reproduce: `node scripts/eval-source-check.mjs --sets relations --grounding 3 --variants`, and with
`--unblind --sets relholdout` the held-out set.
