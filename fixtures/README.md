# fixtures

Frozen recorded output of real measurement runs. **Read-only** — nothing in this
repo writes here, and re-generating any of it would invalidate the tests.

- `jobs/<id>/` — one directory per recorded run: `job.json` (the request),
  `population.json` (the prompts), `responses.jsonl`, `scores.jsonl`.
- `mirror.jsonl` — one line per completed measurement (the baseline store that
  the `measurements` table replaced).

`test/golden.test.ts` replays five of these runs batch-by-batch through
`decide()` and asserts it reproduces the recorded trajectory, stop point, and
stop reason — plus one curated Wilson number off `mirror.jsonl`. That replay is
what proves the measurement engine is correct; these files are the evidence it
checks against.

Some earlier recorded runs were dropped from `jobs/` and `mirror.jsonl`. Nothing
replayed them; the Wilson values two of them pinned are kept as literals in
`test/stats.test.ts`, so no coverage went with them.

Two of the recorded intervals are **deliberately not** reproduced: the runs that
warm-start from a zero-rate baseline recorded a normal-approximation credible
interval that is too narrow at the k=0 boundary. `betaCi()` uses exact Beta
quantiles there instead, and the tests assert the exact values with a comment
saying so.

## `api.py:NNN` references in the source

Comments throughout `src/` cite line numbers in `api.py`, `runner.py`,
`scorer.py`, and friends. Those files were the original Python implementation,
deleted once the TypeScript port passed this replay. They remain in git history —
`git show c75bff4:api.py` — and the citations are kept as provenance for *why* a
given rule is shaped the way it is. The TypeScript is the implementation; the
Python is the archaeology.
