"""Margin memory-mode statistics (R13): warm-start re-certification and
change-check, both driven by remembered baselines from MemoryStore.

  python memory_stats.py recert --job aeo_own_brand --draw 15
      Warm-start: discounted Beta prior from memory + a fresh draw of scored
      responses (replayed from the job's own scores for rehearsal; at the event
      point --scores at a NEW small run). Reports credible interval + drift guard.

  python memory_stats.py change --job pilot_mini --baseline-metric supergoop_category_share
      Change-check: sequential difference-CI of the new run vs the remembered
      baseline. Stops when 0 is excluded (change confirmed) or the interval
      fits inside the equivalence band (no detectable change).
"""

import argparse, json, math, random, time
from pathlib import Path
from memory_store import MemoryStore

Z = 1.96
PRIOR_CAP = 25          # max effective prior sample size (discounted memory)
DRIFT_Z = 2.5           # drift guard threshold on fresh-vs-prior divergence
EQUIV_BAND = 0.05       # 'no detectable change' if |diff| CI within ±5pts


def beta_ci(a, b, level=0.95):
    """Normal approx to Beta credible interval (fine for a,b >= ~5)."""
    m = a / (a + b)
    var = a * b / ((a + b) ** 2 * (a + b + 1))
    h = Z * math.sqrt(var)
    return m, max(0.0, m - h), min(1.0, m + h)


def load_scored(job, agg):
    """(flag, cost) per scored record — cost is gen+judge, the console's definition."""
    scored = [json.loads(l) for l in open(Path("jobs") / job / "scores.jsonl")]
    return [(bool(x["score"].get(agg)),
             (x.get("gen_cost") or 0) + (x.get("judge_cost") or 0))
            for x in scored if x.get("score") is not None]


def job_agg(job):
    cfg = json.load(open(Path("jobs") / job / "job.json"))
    return cfg["metric"]["name"], cfg["metric"]["aggregate_field"], cfg["measured"]["model"]


def recert(args):
    metric, agg, model = job_agg(args.job)
    ms = MemoryStore()
    got = ms.recall_baseline(metric)
    base = got["baseline"]
    if not base:
        raise SystemExit(f"no remembered baseline for {metric} — run memory_store.py --seed")
    print(f"[memory:{got['everos_mode']}] baseline {metric}: "
          f"{base['k']}/{base['n']} = {base['rate']:.1%} "
          f"(model {base['model_version']}, cost ${base['cost']})")

    # discounted prior
    scale = min(1.0, PRIOR_CAP / base["n"])
    a0, b0 = 1 + base["k"] * scale, 1 + (base["n"] - base["k"]) * scale
    print(f"prior: Beta({a0:.1f},{b0:.1f})  (effective n={base['n']*scale:.0f}, capped {PRIOR_CAP})")

    pairs = load_scored(args.scores_job or args.job, agg)
    rng = random.Random(args.seed)
    rng.shuffle(pairs)
    draw = pairs[:args.draw]
    k, n = sum(f for f, _ in draw), len(draw)
    cost = sum(c for _, c in draw)

    # drift guard: fresh-only vs prior mean
    p_prior = base["rate"]
    if n >= 5:
        p_fresh = k / n
        se = math.sqrt(max(p_prior * (1 - p_prior), 1e-6) / n)
        zdiv = abs(p_fresh - p_prior) / se
        if zdiv > DRIFT_Z:
            print(f"DRIFT GUARD FIRED: fresh {p_fresh:.1%} vs prior {p_prior:.1%} "
                  f"(z={zdiv:.1f} > {DRIFT_Z}). Prior discarded — recommend full "
                  f"fresh measurement. (This outcome is the system working.)")
            return
    a, b = a0 + k, b0 + (n - k)
    m, lo, hi = beta_ci(a, b)
    print(f"fresh draw: {k}/{n} (${cost:.2f})  ->  posterior {m:.1%}  95% credible interval "
          f"[{lo:.1%}, {hi:.1%}]  width {hi-lo:.1%}")
    print(f"RE-CERTIFIED with {n} fresh queries (baseline took {base['n']}). "
          f"Label on stage: CREDIBLE interval under a discounted remembered prior.")
    if args.store:
        rec = {"metric": metric, "job_id": args.scores_job or args.job,
               "mode": "warmstart", "model_version": model, "n": n, "k": k,
               "rate": round(m, 4), "ci_lo": round(lo, 4), "ci_hi": round(hi, 4),
               "cost": round(cost, 2), "ts": time.time(),
               "interval": "credible", "prior_n_eff": round(base["n"] * scale),
               "drift": "ok", "baseline_n": base["n"], "baseline_cost": base["cost"],
               "baseline_rate": base["rate"]}
        out = ms.remember_result(rec)
        print(f"stored warmstart result -> memory [{out['mode']}]")


def change(args):
    _, agg_new, model_new = job_agg(args.job)
    ms = MemoryStore()
    got = ms.recall_baseline(args.baseline_metric)
    base = got["baseline"]
    if not base:
        raise SystemExit(f"no remembered baseline for {args.baseline_metric}")
    if base["model_version"] != model_new:
        print(f"NOTE: model_version changed {base['model_version']} -> {model_new} "
              f"(this IS the change event being measured)")
    p0, k0, n0 = base["rate"], base["k"], base["n"]
    print(f"[memory:{got['everos_mode']}] baseline: {k0}/{n0} = {p0:.1%}")

    pairs = load_scored(args.job, agg_new)
    rng = random.Random(args.seed)
    rng.shuffle(pairs)
    k = n = 0
    cost = 0.0
    verdict = "undecided"
    for f, c in pairs:
        k += f; n += 1; cost += c
        if n % args.batch and n != len(pairs):
            continue
        p1 = k / n
        se = math.sqrt(p1 * (1 - p1) / n + p0 * (1 - p0) / n0)
        d = p1 - p0
        lo, hi = d - Z * se, d + Z * se
        if lo > 0 or hi < 0:
            verdict = "changed"
            print(f"CHANGE CONFIRMED at n={n}: diff {d:+.1%} "
                  f"[{lo:+.1%}, {hi:+.1%}] excludes 0. "
                  f"({'up' if d>0 else 'down'} vs remembered baseline)")
            break
        if -EQUIV_BAND < lo and hi < EQUIV_BAND:
            verdict = "no_change"
            print(f"NO DETECTABLE CHANGE at n={n}: diff {d:+.1%} "
                  f"[{lo:+.1%}, {hi:+.1%}] within ±{EQUIV_BAND:.0%} band.")
            break
    else:
        print(f"UNDECIDED at n={n}: diff {d:+.1%} [{lo:+.1%}, {hi:+.1%}] — neither "
              f"confirmed nor equivalent; more samples (or wider band) needed. "
              f"Margin reports exactly this instead of a fake verdict.")
    if args.store:
        from stats import wilson
        p1, wlo, whi = wilson(k, n)
        rec = {"metric": args.baseline_metric, "job_id": args.job,
               "mode": "change_check", "model_version": model_new, "n": n, "k": k,
               "rate": round(p1, 4), "ci_lo": round(wlo, 4), "ci_hi": round(whi, 4),
               "cost": round(cost, 2), "ts": time.time(),
               "verdict": verdict, "diff": round(d, 4),
               "diff_lo": round(lo, 4), "diff_hi": round(hi, 4),
               "baseline_model": base["model_version"], "baseline_rate": p0,
               "baseline_n": n0, "equiv_band": EQUIV_BAND}
        out = ms.remember_result(rec)
        print(f"stored change-check result -> memory [{out['mode']}]")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("recert")
    r.add_argument("--job", required=True)
    r.add_argument("--scores-job", help="draw fresh flags from a different job's scores (event: the new mini-run)")
    r.add_argument("--draw", type=int, default=15)
    r.add_argument("--seed", type=int, default=7)
    r.add_argument("--store", action="store_true",
                   help="write the outcome to memory (event runs; omit for rehearsal replays)")
    c = sub.add_parser("change")
    c.add_argument("--job", required=True)
    c.add_argument("--baseline-metric", required=True)
    c.add_argument("--batch", type=int, default=20)
    c.add_argument("--seed", type=int, default=7)
    c.add_argument("--store", action="store_true",
                   help="write the outcome to memory (event runs; omit for rehearsal replays)")
    a = ap.parse_args()
    (recert if a.cmd == "recert" else change)(a)
