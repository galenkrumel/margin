// THE test: replays real recorded runs through decide() and checks bit-level
// (well, 4-decimal -- the mirror itself is rounded) parity with the Python
// engine's output. Node-only (fs, path, import.meta.url) -- stats.ts/scorers.ts
// stay node-free, only this test needs the filesystem.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canAfford, decide, priorFromBaseline, wilson, type DecideResult } from "../src/stats.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const JOBS = join(REPO_ROOT, "jobs");

function readJsonl(path: string): any[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

// -- curated jobs (build_console.py's conservative_flags AND-with-leaderboard
// logic is skipped here -- see report; asserting the plain Wilson numbers off
// the mirror instead, which is what stats.py's own selfcheck already proves
// the formula produces) -------------------------------------------------
describe("curated jobs -- headline Wilson numbers vs mirror.jsonl lines 1-3", () => {
  const mirror = readJsonl(join(REPO_ROOT, "memory", "mirror.jsonl"));

  it("aeo_category_share: 131/254", () => {
    const rec = mirror.find((r) => r.job_id === "aeo_category_share");
    const [p, lo, hi] = wilson(131, 254);
    expect(p).toBeCloseTo(rec.rate, 4);
    expect(lo).toBeCloseTo(rec.ci_lo, 4);
    expect(hi).toBeCloseTo(rec.ci_hi, 4);
  });

  it("aeo_own_brand: 38/39", () => {
    const rec = mirror.find((r) => r.job_id === "aeo_own_brand");
    const [p, lo, hi] = wilson(38, 39);
    expect(p).toBeCloseTo(rec.rate, 4);
    expect(lo).toBeCloseTo(rec.ci_lo, 4);
    expect(hi).toBeCloseTo(rec.ci_hi, 4);
  });

  it("refusal_medical: 0/120", () => {
    const rec = mirror.find((r) => r.job_id === "refusal_medical");
    const [p, lo, hi] = wilson(0, 120);
    expect(p).toBeCloseTo(rec.rate, 4);
    expect(lo).toBeCloseTo(rec.ci_lo, 4);
    expect(hi).toBeCloseTo(rec.ci_hi, 4);
  });
});

// -- live jobs: full batch-by-batch replay through decide() -------------

interface LiveJobFixture {
  agg: string;
  targetWidth: number;
  maxUsd: number;
  batch: number;
  maxExecutions: number;
  population: number;
  flags: boolean[];
  costs: number[];
}

function loadLiveJob(jobId: string): LiveJobFixture {
  const dir = join(JOBS, jobId);
  const cfg = readJson(join(dir, "job.json"));
  const req = cfg.requested;
  const agg = req.metric.aggregate_field;
  const population = readJson(join(dir, "population.json")).queries.length;

  const rows = readJsonl(join(dir, "scores.jsonl")).filter((s) => s.score != null);
  const flags = rows.map((s) => Boolean(s.score[agg]));
  const costs = rows.map((s) => (s.gen_cost || 0) + (s.judge_cost || 0));

  return {
    agg,
    targetWidth: req.precision.ci_width,
    maxUsd: req.budget.max_usd,
    batch: req.batch ?? 20,
    maxExecutions: req.budget.max_executions,
    population,
    flags,
    costs,
  };
}

/** api.py:253-301, replayed batch-by-batch through decide()/canAfford(). */
function replay(
  job: LiveJobFixture,
  prior0: { a0: number; b0: number } | null,
  baseRate: number | null
) {
  const cap = Math.min(job.maxExecutions, job.population);
  let prior = prior0;
  let n = 0,
    k = 0,
    cost = 0;
  let perQ: number | null = null;
  let limit = 0;
  let last: DecideResult | null = null;
  let stop: DecideResult["stop"] = null;

  while (limit < cap) {
    if (!canAfford(cost, perQ, job.batch, job.maxUsd)) {
      stop = "budget_cap";
      break;
    }
    const newLimit = Math.min(limit + job.batch, cap);
    for (let i = limit; i < newLimit; i++) {
      n++;
      k += job.flags[i] ? 1 : 0;
      cost += job.costs[i];
    }
    limit = newLimit;
    const exhausted = limit >= cap;

    const result = decide({
      n,
      k,
      cost,
      targetWidth: job.targetWidth,
      maxUsd: job.maxUsd,
      prior,
      baseRate,
      exhausted,
    });
    if (result.drift) prior = null; // discard for the rest of the run (api.py:276)
    perQ = n ? cost / n : null;
    last = result;
    if (result.stop) {
      stop = result.stop;
      break;
    }
  }
  return { n, k, cost, last: last!, stop };
}

describe("live jobs -- golden replay vs mirror.jsonl", () => {
  const mirror = readJsonl(join(REPO_ROOT, "memory", "mirror.jsonl"));
  const mirrorRec = (jobId: string) => mirror.find((r) => r.job_id === jobId);

  it("live_1786134788: fresh, no prior -- stops at n=20", () => {
    const job = loadLiveJob("live_1786134788");
    const rec = mirrorRec("live_1786134788");
    const { n, k, last, stop } = replay(job, null, null);

    expect(n).toBe(20);
    expect(n).toBe(rec.n);
    expect(k).toBe(rec.k);
    expect(last.interval).toBe("wilson");
    expect(stop).toBe("precision_met");
    // current api.py semantics: estimate is always the observed rate k/n
    expect(last.estimate).toBeCloseTo(k / n, 4);
    expect(last.lo).toBeCloseTo(rec.ci_lo, 4);
    expect(last.hi).toBeCloseTo(rec.ci_hi, 4);
  });

  it("live_1786136605: warm-start from live_1786134788 (n=20,k=0) -- stops at n=20", () => {
    const job = loadLiveJob("live_1786136605");
    const rec = mirrorRec("live_1786136605");
    const prior = priorFromBaseline({ n: 20, k: 0, rate: 0.0 });
    const { n, k, last, stop } = replay(job, prior, 0.0);

    expect(n).toBe(20);
    expect(n).toBe(rec.n);
    expect(k).toBe(rec.k);
    expect(last.interval).toBe("credible");
    expect(last.drift).toBe(false);
    expect(stop).toBe("precision_met");
    // NOTE: mirror.jsonl's "rate" field for this record (0.0238) is the
    // posterior mean, not k/n -- it predates the api.py display-rule change
    // at line 279-282 ("report the observed rate; memory sharpens the
    // interval, not the count"). Current api.py, which decide() ports,
    // always reports k/n. So we assert against k/n, not rec.rate, and only
    // check the CI (which the display-rule change never touched).
    expect(last.estimate).toBeCloseTo(k / n, 4);
    expect(last.lo).toBeCloseTo(rec.ci_lo, 4);
    expect(last.hi).toBeCloseTo(rec.ci_hi, 4);
    expect(rec.prior_n_eff).toBe(Math.round(20 * Math.min(1, 25 / 20)));
  });

  it("live_1786137379: warm-start from live_1786136605 (n=20,k=0,rate=0.0238) -- stops at n=20", () => {
    const job = loadLiveJob("live_1786137379");
    const rec = mirrorRec("live_1786137379");
    // the prior is built from the *preceding mirror record's* n/k (raw counts,
    // unaffected by the display quirk above) -- api.py:246-251 reads base["k"]
    // straight off the mirror, not the "rate" field
    const prior = priorFromBaseline({ n: 20, k: 0, rate: 0.0238 });
    const { n, k, last, stop } = replay(job, prior, 0.0238);

    expect(n).toBe(20);
    expect(n).toBe(rec.n);
    expect(k).toBe(rec.k);
    expect(last.interval).toBe("credible");
    expect(last.drift).toBe(false);
    expect(stop).toBe("precision_met");
    expect(last.estimate).toBeCloseTo(k / n, 4); // same display-rule note as above
    expect(last.lo).toBeCloseTo(rec.ci_lo, 4);
    expect(last.hi).toBeCloseTo(rec.ci_hi, 4);
  });

  it("live_1786138212: fresh, no prior -- population_exhausted at n=120", () => {
    const job = loadLiveJob("live_1786138212");
    const rec = mirrorRec("live_1786138212");
    const { n, k, last, stop } = replay(job, null, null);

    expect(n).toBe(120);
    expect(n).toBe(rec.n);
    expect(k).toBe(rec.k);
    expect(last.interval).toBe("wilson");
    expect(stop).toBe("population_exhausted");
    expect(last.estimate).toBeCloseTo(rec.rate, 4); // fresh run: rate really is k/n here
    expect(last.lo).toBeCloseTo(rec.ci_lo, 4);
    expect(last.hi).toBeCloseTo(rec.ci_hi, 4);
  });

  it("live_1786138476: warm-start from live_1786138212 (n=120,k=11,rate=0.0917) -- stops at n=80", () => {
    const job = loadLiveJob("live_1786138476");
    const rec = mirrorRec("live_1786138476");
    const prior = priorFromBaseline({ n: 120, k: 11, rate: 0.0917 });
    const { n, k, last, stop } = replay(job, prior, 0.0917);

    expect(n).toBe(80);
    expect(n).toBe(rec.n);
    expect(k).toBe(rec.k);
    expect(last.interval).toBe("credible");
    expect(last.drift).toBe(false);
    expect(stop).toBe("precision_met");
    // this one postdates the display-rule change: rate IS k/n (0.05 = 4/80)
    expect(rec.rate).toBeCloseTo(4 / 80, 4);
    expect(last.estimate).toBeCloseTo(rec.rate, 4);
    expect(last.lo).toBeCloseTo(rec.ci_lo, 4);
    expect(last.hi).toBeCloseTo(rec.ci_hi, 4);
    expect(rec.prior_n_eff).toBe(Math.round(120 * Math.min(1, 25 / 120)));
  });
});
