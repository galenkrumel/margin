// Margin statistics -- ported line-for-line from stats.py + the R4 stopping
// rule in api.py's _measure(). Pure: no I/O, no Date, no env -- runs in a
// Cloudflare Worker same as anywhere else.

const Z = 1.96; // 95%

/** Wilson score interval. Same formula as stats.py:wilson / analyze.py:12. */
export function wilson(k: number, n: number, z = Z): [p: number, lo: number, hi: number] {
  if (n === 0) return [0.0, 0.0, 1.0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + (z * z) / (4 * n * n))) / d;
  return [p, Math.max(0.0, c - h), Math.min(1.0, c + h)];
}

/** Queries needed for a 95% CI of width w at rate p (normal approx). */
export function nForWidth(p: number, w: number, z = Z): number {
  return Math.ceil((4 * z * z * p * (1 - p)) / (w * w));
}

/** Normal approx to Beta credible interval (memory_stats.py's beta_ci / api.py's _beta_ci). */
export function betaCi(a: number, b: number): [m: number, lo: number, hi: number] {
  const m = a / (a + b);
  // normal approx is worst exactly at a==1 or b==1 (a zero-count prior/count
  // at k=0 or k=n) -- Beta(1,b)/Beta(a,1) have closed-form CDFs (1-(1-x)^b,
  // x^a), so use the exact quantiles there instead. a===1&&b===1 (uniform)
  // falls into the first branch and correctly yields [0.025, 0.975].
  if (a === 1) return [m, 1 - Math.pow(0.975, 1 / b), 1 - Math.pow(0.025, 1 / b)];
  if (b === 1) return [m, Math.pow(0.025, 1 / a), Math.pow(0.975, 1 / a)];
  const h = 1.96 * Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return [m, Math.max(0.0, m - h), Math.min(1.0, m + h)];
}

// warm-start constants -- same values as memory_stats.py / api.py (R13)
export const PRIOR_CAP = 25; // max effective prior sample size (discounted memory)
export const DRIFT_Z = 2.5; // drift guard threshold on fresh-vs-prior divergence

/** api.py:247-248 -- a remembered baseline discounted into a Beta prior. */
export function priorFromBaseline(baseline: { n: number; k: number; rate: number }): {
  a0: number;
  b0: number;
} {
  const scale = Math.min(1.0, PRIOR_CAP / baseline.n);
  return { a0: 1 + baseline.k * scale, b0: 1 + (baseline.n - baseline.k) * scale };
}

/** deterministic Fisher–Yates seeded by jobId -- prompts arrive grouped by
 * topic, so in-order sampling measures an unrepresentative head of the
 * population. seeded, not Math.random: step retries must see the same order.
 * (lives here, not workflow.ts: pure + testable without the workers runtime) */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261 >>> 0;   // FNV-1a into a splitmix-ish stream
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface DecideInput {
  n: number; // cumulative scored count after this batch
  k: number; // cumulative true count after this batch
  cost: number; // cumulative cost ($) after this batch
  targetWidth: number; // precision.ci_width
  maxUsd: number; // budget.max_usd
  prior?: { a0: number; b0: number } | null; // active memory prior, if any
  baseRate?: number | null; // baseline rate the prior was discounted from (for drift)
  driftZ?: number;
  // true once this batch reached min(max_executions, population) -- the loop
  // in api.py can't run another batch after this one (api.py:253-301)
  exhausted?: boolean;
}

export interface DecideResult {
  estimate: number;
  lo: number;
  hi: number;
  width: number;
  interval: "wilson" | "credible";
  drift: boolean; // true if the drift guard fired *this* batch (caller should drop the prior from here on)
  stop: null | "precision_met" | "budget_cap" | "population_exhausted";
}

/**
 * The post-batch half of api.py's _measure() loop (api.py:271-301): drift
 * guard -> interval selection -> stopping rule. The pre-batch affordability
 * gate (api.py:258, "skip a batch we can't afford") is a separate decision
 * made with the *previous* batch's numbers, before the next batch is even
 * run -- see canAfford() below.
 */
export function decide(input: DecideInput): DecideResult {
  const { n, k, cost, targetWidth, maxUsd, baseRate, exhausted } = input;
  const driftZ = input.driftZ ?? DRIFT_Z;
  let prior = input.prior ?? null;
  let drift = false;

  // drift guard: fresh-only vs prior mean; firing it IS the system working (api.py:272-277)
  if (prior && baseRate != null && n >= 5) {
    const pp = baseRate;
    const z = Math.abs(k / n - pp) / Math.sqrt(Math.max(pp * (1 - pp), 1e-6) / n);
    if (z > driftZ) {
      prior = null;
      drift = true;
    }
  }

  let estimate: number, lo: number, hi: number, interval: "wilson" | "credible";
  if (prior) {
    // report the observed rate; memory sharpens the interval, not the count (api.py:279-282)
    const [, clo, chi] = betaCi(prior.a0 + k, prior.b0 + (n - k));
    estimate = n ? k / n : 0;
    lo = clo;
    hi = chi;
    interval = "credible";
  } else {
    const [p, wlo, whi] = wilson(k, n);
    estimate = p;
    lo = wlo;
    hi = whi;
    interval = "wilson";
  }

  const width = hi - lo;
  let stop: DecideResult["stop"] = null;
  if (width <= targetWidth) {
    stop = "precision_met"; // api.py:291-293
  } else if (cost >= maxUsd) {
    stop = "budget_cap"; // api.py:294-296
  } else if (exhausted) {
    // api.py:299-301: "precision_met if final width <= target else population_exhausted".
    // The precision_met half is dead code -- it can only be reached when the
    // per-batch check above already caught it and returned. Kept as a comment,
    // not a branch, so nothing here shadows the check above.
    stop = "population_exhausted";
  }

  return { estimate, lo, hi, width, interval, drift, stop };
}

/**
 * api.py:258 -- "a budget cap only checked after spending isn't a cap: skip
 * a batch we can't afford (per_q unknown until the first batch lands)".
 * Called with the numbers from the *last completed* batch, before running
 * the next one.
 */
export function canAfford(
  costSoFar: number,
  perQ: number | null | undefined,
  batch: number,
  maxUsd: number
): boolean {
  if (!perQ) return true;
  return costSoFar + batch * perQ <= maxUsd;
}
