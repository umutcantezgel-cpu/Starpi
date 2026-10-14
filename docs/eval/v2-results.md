# Final measurement of the source check for Starpi 2.0

Measured once, as fixed in the [evaluation protocol](v2-protocol.md), on 2026-10-14 at commit
`a93a934` (the version 2 rules and their tests as released; nothing in the rules was changed
afterwards), with Node.js 22.22.0:

```bash
node scripts/eval-source-check.mjs --unblind --grounding 1 --variants
node scripts/eval-source-check.mjs --unblind --grounding 2 --variants
```

The held-out file matched the SHA-256 frozen before any version 2 rule was written (the script
refuses it otherwise). Measures: for faithful answers, the statements marked unsupported (false
alarms) and weak; for answers with one planted error, the statement that contains it is caught
(unsupported), flagged (weak), missed (supported or unchecked) or not found. "Detected" below is
caught or flagged.

## Summary

| Set | Rules | Faithful statements marked unsupported | marked weak | Changed number, date, time, weekday or code detected | Wrong name or place detected | Value on the wrong thing detected | Negation detected |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `dev` (129 answers, 143 faithful statements) | 2 | 0 | 0 | 47 of 49 | 5 of 10 | 3 of 10 | 8 of 10 |
| | 1 | 0 | 0 | 48 of 49 | 3 of 10 | 2 of 10 | 0 of 10 |
| `holdout` (179, 324), inspected during the design of version 2 | 2 | 0 | 16 | 49 of 49 | 6 of 10 | 7 of 10 | 4 of 10 |
| | 1 | 0 | 15 | 49 of 49 | 4 of 10 | 6 of 10 | 0 of 10 |
| `v2dev` (107, 143) | 2 | 0 | 0 | – | 19 of 24 | 23 of 24 | 24 of 24 |
| | 1 | 1 | 2 | – | 9 of 24 | 13 of 24 | 1 of 24 |
| `v2holdout` (104, 144), held out | 2 | 0 | 8 | – | 17 of 23 | 20 of 24 | 16 of 23 |
| | 1 | 0 | 4 | – | 10 of 23 | 13 of 24 | 0 of 23 |
| `paraphrases` (854, 844), faithful only | 2 | 0 | 27 | – | – | – | – |
| | 1 | 0 | 16 | – | – | – | – |

- **Targets** (protocol): 8 of 10 errors detected in the negation, entity and relation categories of
  `v2holdout`, and no statement of a faithful answer marked unsupported in any set. Reached: no
  faithful statement marked unsupported by version 2 in any set; relation 20 of 24 (83 %). Not
  reached: entity 17 of 23 (74 %), negation 16 of 23 (70 %).
- **Ship rule:** no statement of a faithful answer is marked unsupported by a version 2 reason in
  any set, so no reason was lowered and nothing was measured again.
- **Weak marks on faithful statements** rise with version 2 in `holdout` (15 → 16 of 324),
  `v2holdout` (4 → 8 of 144) and `paraphrases` (16 → 27 of 844).
- **Changed values:** version 2 misses one changed number in `dev` that version 1 flagged: "two
  weeks" for "one week". Version 1 flagged it as a value next to other words, because the excerpt
  has "two" in "within two days"; version 2 does not compare the two passages that way.
- **Version 1 on `v2dev`:** its one false alarm reads "Firmware 3.9.4 am 21. April 2027" as the
  number 3.9 and the time "4 am"; version 2 reads version numbers as codes.
- `v2holdout` has 23 entity and 23 negation answers: the reviewers dropped one of each when the
  set was assembled.

## Output, rules version 1

```text
== dev (129 answers)
Faithful answers: 50 (143 statements)
  statements wrongly marked unsupported: 0 (in 0 answers)
  statements marked weak: 0
Answers with one planted error (caught = unsupported, flagged = weak):
  code      (fact)  3/6 caught, 2 flagged, 1 missed
  date      (fact)  15/15 caught, 0 flagged, 0 missed
  entity    (meaning)  0/10 caught, 3 flagged, 7 missed
  negation  (meaning)  0/10 caught, 0 flagged, 10 missed
  number    (fact)  15/16 caught, 1 flagged, 0 missed
  relation  (meaning)  0/10 caught, 2 flagged, 8 missed
  time      (fact)  6/6 caught, 0 flagged, 0 missed
  weekday   (fact)  6/6 caught, 0 flagged, 0 missed

== holdout (179 answers)
Faithful answers: 100 (324 statements)
  statements wrongly marked unsupported: 0 (in 0 answers)
  statements marked weak: 15
Answers with one planted error (caught = unsupported, flagged = weak):
  code      (fact)  2/6 caught, 4 flagged, 0 missed
  date      (fact)  16/16 caught, 0 flagged, 0 missed
  entity    (meaning)  0/10 caught, 4 flagged, 6 missed
  negation  (meaning)  0/10 caught, 0 flagged, 10 missed
  number    (fact)  15/15 caught, 0 flagged, 0 missed
  relation  (meaning)  0/10 caught, 6 flagged, 4 missed
  time      (fact)  6/6 caught, 0 flagged, 0 missed
  weekday   (fact)  6/6 caught, 0 flagged, 0 missed

== v2dev (107 answers)
Faithful answers: 35 (143 statements)
  statements wrongly marked unsupported: 1 (in 1 answers)
  statements marked weak: 2
Answers with one planted error (caught = unsupported, flagged = weak):
  entity    (meaning)  0/24 caught, 9 flagged, 15 missed
  negation  (meaning)  0/24 caught, 1 flagged, 23 missed
  relation  (meaning)  0/24 caught, 13 flagged, 11 missed
    entity/multi_swap                  0/8 caught, 0 flagged, 8 missed
    entity/swap_known                  0/8 caught, 4 flagged, 4 missed
    entity/unknown                     0/8 caught, 5 flagged, 3 missed
    negation/add_negator               0/6 caught, 0 flagged, 6 missed
    negation/antonym                   0/6 caught, 0 flagged, 6 missed
    negation/double_negation           0/6 caught, 1 flagged, 5 missed
    negation/drop_negator              0/6 caught, 0 flagged, 6 missed
    relation/multi_value_swap          0/8 caught, 2 flagged, 6 missed
    relation/swap_across_sections      0/8 caught, 8 flagged, 0 missed
    relation/swap_within_sentence      0/8 caught, 3 flagged, 5 missed

== v2holdout (104 answers)
Faithful answers: 34 (144 statements)
  statements wrongly marked unsupported: 0 (in 0 answers)
  statements marked weak: 4
Answers with one planted error (caught = unsupported, flagged = weak):
  entity    (meaning)  0/23 caught, 10 flagged, 13 missed
  negation  (meaning)  0/23 caught, 0 flagged, 23 missed
  relation  (meaning)  0/24 caught, 13 flagged, 11 missed
    entity/multi_swap                  0/7 caught, 2 flagged, 5 missed
    entity/swap_known                  0/8 caught, 2 flagged, 6 missed
    entity/unknown                     0/8 caught, 6 flagged, 2 missed
    negation/add_negator               0/6 caught, 0 flagged, 6 missed
    negation/antonym                   0/5 caught, 0 flagged, 5 missed
    negation/double_negation           0/6 caught, 0 flagged, 6 missed
    negation/drop_negator              0/6 caught, 0 flagged, 6 missed
    relation/multi_value_swap          0/8 caught, 4 flagged, 4 missed
    relation/swap_across_sections      0/8 caught, 8 flagged, 0 missed
    relation/swap_within_sentence      0/8 caught, 1 flagged, 7 missed

== paraphrases (854 answers)
Faithful answers: 854 (844 statements)
  statements wrongly marked unsupported: 0 (in 0 answers)
  statements marked weak: 16
```

## Output, rules version 2

```text
== dev (129 answers)
Faithful answers: 50 (143 statements)
  statements wrongly marked unsupported: 0 (in 0 answers)
  statements marked weak: 0
Answers with one planted error (caught = unsupported, flagged = weak):
  code      (fact)  3/6 caught, 2 flagged, 1 missed
  date      (fact)  15/15 caught, 0 flagged, 0 missed
  entity    (meaning)  0/10 caught, 5 flagged, 5 missed
  negation  (meaning)  0/10 caught, 8 flagged, 2 missed
  number    (fact)  15/16 caught, 0 flagged, 1 missed
  relation  (meaning)  0/10 caught, 3 flagged, 7 missed
  time      (fact)  6/6 caught, 0 flagged, 0 missed
  weekday   (fact)  6/6 caught, 0 flagged, 0 missed

== holdout (179 answers)
Faithful answers: 100 (324 statements)
  statements wrongly marked unsupported: 0 (in 0 answers)
  statements marked weak: 16
Answers with one planted error (caught = unsupported, flagged = weak):
  code      (fact)  2/6 caught, 4 flagged, 0 missed
  date      (fact)  16/16 caught, 0 flagged, 0 missed
  entity    (meaning)  0/10 caught, 6 flagged, 4 missed
  negation  (meaning)  0/10 caught, 4 flagged, 6 missed
  number    (fact)  15/15 caught, 0 flagged, 0 missed
  relation  (meaning)  0/10 caught, 7 flagged, 3 missed
  time      (fact)  6/6 caught, 0 flagged, 0 missed
  weekday   (fact)  6/6 caught, 0 flagged, 0 missed

== v2dev (107 answers)
Faithful answers: 35 (143 statements)
  statements wrongly marked unsupported: 0 (in 0 answers)
  statements marked weak: 0
Answers with one planted error (caught = unsupported, flagged = weak):
  entity    (meaning)  0/24 caught, 19 flagged, 5 missed
  negation  (meaning)  0/24 caught, 24 flagged, 0 missed
  relation  (meaning)  0/24 caught, 23 flagged, 1 missed
    entity/multi_swap                  0/8 caught, 5 flagged, 3 missed
    entity/swap_known                  0/8 caught, 7 flagged, 1 missed
    entity/unknown                     0/8 caught, 7 flagged, 1 missed
    negation/add_negator               0/6 caught, 6 flagged, 0 missed
    negation/antonym                   0/6 caught, 6 flagged, 0 missed
    negation/double_negation           0/6 caught, 6 flagged, 0 missed
    negation/drop_negator              0/6 caught, 6 flagged, 0 missed
    relation/multi_value_swap          0/8 caught, 7 flagged, 1 missed
    relation/swap_across_sections      0/8 caught, 8 flagged, 0 missed
    relation/swap_within_sentence      0/8 caught, 8 flagged, 0 missed

== v2holdout (104 answers)
Faithful answers: 34 (144 statements)
  statements wrongly marked unsupported: 0 (in 0 answers)
  statements marked weak: 8
Answers with one planted error (caught = unsupported, flagged = weak):
  entity    (meaning)  0/23 caught, 17 flagged, 6 missed
  negation  (meaning)  0/23 caught, 16 flagged, 7 missed
  relation  (meaning)  0/24 caught, 20 flagged, 4 missed
    entity/multi_swap                  0/7 caught, 6 flagged, 1 missed
    entity/swap_known                  0/8 caught, 4 flagged, 4 missed
    entity/unknown                     0/8 caught, 7 flagged, 1 missed
    negation/add_negator               0/6 caught, 4 flagged, 2 missed
    negation/antonym                   0/5 caught, 5 flagged, 0 missed
    negation/double_negation           0/6 caught, 2 flagged, 4 missed
    negation/drop_negator              0/6 caught, 5 flagged, 1 missed
    relation/multi_value_swap          0/8 caught, 6 flagged, 2 missed
    relation/swap_across_sections      0/8 caught, 8 flagged, 0 missed
    relation/swap_within_sentence      0/8 caught, 6 flagged, 2 missed

== paraphrases (854 answers)
Faithful answers: 854 (844 statements)
  statements wrongly marked unsupported: 0 (in 0 answers)
  statements marked weak: 27
```
