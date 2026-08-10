# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                              # vitest, all suites
npx vitest run test/golden.test.ts    # one file
npx vitest run -t "warm-start"        # one test by name (substring of the it()/describe() text)
npm run typecheck                     # tsc --noEmit

npx wrangler d1 execute margin --local --file=schema.sql   # first-time local DB
npm run seed:local                    # baselines from fixtures/mirror.jsonl, so warm-start works locally
npx wrangler dev                      # Workflows + D1 under miniflare; needs .dev.vars
```

`.dev.vars` supplies `MARGIN_TOKENS` locally. Deploy happens on push to `main`
(`.github/workflows/deploy.yml`); `npx wrangler deploy` by hand does the same thing.

## What this is

One Cloudflare Worker that measures a rate (refusal rate, JSON-compliance rate, sycophancy
rate) to a *stated precision* rather than a fixed sample size: it runs batches until the
confidence interval is narrow enough, then stops. `src/api.ts` is the entrypoint for both the
HTTP routes and the Workflow class.

## Architecture facts that aren't visible from one file

**The JSON contract is frozen.** Response shapes are copied field-for-field from a since-deleted
Python API so `public/index.html` works unmodified. Fields may be **added**, never renamed or
removed — `src/api.ts`'s header comment lists every field the console dereferences. Changing one
silently breaks the console, which has no build step and no type checking against the API.

**`api.py:NNN` / `runner.py:NNN` comments are provenance, not dead links.** The Python engine was
deleted once the TypeScript replayed it correctly (commit `bb1f2e6`). It is recoverable via
`git show c75bff4:api.py`. See `fixtures/README.md`. Don't treat these as broken references.

**`fixtures/` is read-only evidence.** `test/golden.test.ts` replays five real recorded runs
batch-by-batch through `decide()` and asserts the recorded trajectory, stop point, and stop
reason. That replay is what proves the engine is correct — regenerating any fixture invalidates
it. Two intervals deliberately do *not* match the Python: `betaCi()` uses exact Beta quantiles at
`a===1` / `b===1`, where the Python's normal approximation was too narrow at the k=0 boundary.
The tests assert the exact values on purpose.

**`decide()` is pure and deliberately not a Workflow step.** `src/stats.ts` has no I/O, no `Date`,
no env — it runs identically in a Worker and in Node, which is what makes the golden replay
possible. Keep it that way. The Workflow steps are only the four that touch the network or D1:
`recall baseline`, `generate batch N`, `score batch N`, `remember`.

**Step bodies must be re-entrant.** A retried step re-queries `responses`/`scores` and skips qids
already written, which is how a job resumes mid-batch. Anything added inside `step.do()` has to
tolerate running twice on partially-written state.

**`seededShuffle` is keyed on `jobId`.** Prompts arrive grouped by topic, so in-order sampling
measures an unrepresentative head of the population. It is seeded rather than random because step
replay must see the same order.

**The estimate is always `k/n`.** A warm-start prior sharpens the *interval* only; it never moves
the reported rate. The drift guard (`DRIFT_Z = 2.5`) discards the prior when fresh data disagrees
— that firing is the system working, not a bug to smooth over.

**BYOK key hygiene.** `openai_key` arrives in the POST body and lives only in Workflow params.
`fillDefaults()` deliberately omits it from `requested`, so it can never reach D1 or be echoed by
`GET /jobs`. Don't add it to any persisted object.

**Every API query is tenant-scoped**, from the HTTP Basic `MARGIN_TOKENS` map. Two consequences
that are intentional, not oversights: `/console` rates come only from the caller's own jobs
($/query leaks how long other tenants' prompts are), and there is no list-price fallback — the
console says "no quote" rather than fabricating one.

**Workflow errors matching `Durable Object reset` / `code was updated` are re-thrown unchanged.**
A deploy mid-run triggers a replay, not a failure; tombstoning the job there would kill a run the
platform is about to resume.

**No build step.** `public/` is committed source (`index.html` + `plotly-basic.min.js`) uploaded
as-is. Constants the console used to have baked in at build time now come from `GET /console`
(`src/console.ts`). Don't reintroduce a generator.

## D1 (`schema.sql`, four tables, no ORM or migrations tool)

- `jobs` — `result` holds the whole state blob the console polls; the read path is one `SELECT`.
- `responses`, `scores` — one row per prompt, keyed `(job_id, qid)`; this is what makes step
  retries resumable. Rows with `score IS NULL` are excluded from `n`/`k`.
- `measurements` — completed runs, the warm-start baselines `latestBaseline()` reads.

JSON parsing happens only in `src/db.ts`; everything else deals in plain objects.
