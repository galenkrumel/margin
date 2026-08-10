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

## Never commit to a spent branch

A merged PR's branch is finished. Commits pushed to it afterwards land nowhere —
not in `main`, not deployed, and the merged PR will not pick them up. The work
looks shipped (the push succeeds, the commit exists) and isn't.

The trap is timing: the branch is usually live when the work *starts* and spent
by the time it is *committed*, because the merge happened mid-session. So this is
checked at commit time, never at start time:

```bash
gh pr list --head "$(git branch --show-current)" --state all --json number,state
```

- an `OPEN` entry — commit here; that PR carries the work
- only `MERGED` / `CLOSED` entries — spent. Cut a new branch and commit there:
  `git checkout -b <name> origin/main`
- no entries — an unproposed branch, fine to commit

After `git fetch`, `git log --oneline origin/main..HEAD` is a quick second look:
empty means everything here is already in `main`. It is not sufficient on its own
— a **squash-merged** PR puts its commits into `main` under a new hash, so the
branch still shows commits `main` "lacks" while being just as spent. The `gh`
check above is the one that decides.

## Wait for greptile after every push to a PR

Greptile reviews each pushed commit. Don't hand the PR back and stop — start a
background watcher keyed to the SHA just pushed, so its exit re-invokes you and
the findings get addressed in the same session instead of being relayed by hand:

Read the SHA and PR number with two plain commands first (`git rev-parse HEAD`,
`gh pr view --json number -q .number`), then paste both in as literals:

```bash
sha=<sha>; for i in $(seq 1 40); do
  if gh api repos/<owner>/<repo>/pulls/<pr>/reviews --jq ".[] | select(.user.login==\"greptile-apps\" and .commit_id==\"$sha\") | .id" | grep -q .; then echo "greptile reviewed $sha"; exit 0; fi
  sleep 30
done; echo "timeout: no greptile review of $sha after 20m"
```

Run it with `run_in_background: true` — a foreground `sleep` is blocked, and the
point is to keep working while it waits. Matching on `commit_id` is what makes
it correct: the review of the *previous* commit is already sitting on the PR, so
a watcher that only checks the author fires instantly on stale feedback.

The shape of that command is load-bearing in a worktree session, where the
sandbox refuses anything it can't verify stays inside the worktree. An inline
`$(git rev-parse HEAD)`, a `{owner}/{repo}` placeholder, or a `&& { …; exit 0; }`
group all get rejected; the `if … then … fi` form above runs. Push a second
watcher only after stopping the previous SHA's — two live watchers means one
wakes you on a review you have already handled.

Then read the line-level findings (the PR body comment is only a summary):

```bash
gh api "repos/{owner}/{repo}/pulls/$pr/comments" --jq '.[] | {path, line, body}'
```

Each finding is a claim, not a verdict — confirm it against the code before
fixing, and say so in the PR when one is wrong rather than editing to appease it.
A fix push starts the cycle again; watch that SHA too.

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
