"""Margin analysis -- metric-driven; produces the slide numbers for any job.

  python analyze.py --job aeo_sunscreen
  python analyze.py --job refusal_medical --ci-width 0.10
"""

import argparse, json, math, random, statistics
from collections import Counter
from pathlib import Path


def wilson(k, n, z=1.96):
    if n == 0:
        return 0.0, 0.0, 1.0
    p = k / n
    d = 1 + z*z/n
    c = (p + z*z/(2*n)) / d
    h = z * math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / d
    return p, max(0.0, c-h), min(1.0, c+h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--ci-width", type=float, default=0.10)
    ap.add_argument("--batch", type=int, default=20)
    ap.add_argument("--shuffles", type=int, default=200)
    args = ap.parse_args()

    job_dir = Path("jobs") / args.job
    jobcfg = json.load(open(job_dir / "job.json"))
    metric = jobcfg["metric"]
    agg = metric["aggregate_field"]
    lb_field = metric.get("leaderboard_field")
    mention_field = metric.get("mention_field")

    resp = {json.loads(l)["id"]: json.loads(l) for l in open(job_dir / "responses.jsonl")}
    scores = {json.loads(l)["id"]: json.loads(l) for l in open(job_dir / "scores.jsonl")}
    regex = {}
    if (job_dir / "regex.jsonl").exists():
        regex = {json.loads(l)["id"]: json.loads(l) for l in open(job_dir / "regex.jsonl")}

    # A. quality gate
    completed = [r for r in resp.values() if r.get("status") == "completed"]
    incomplete = [r for r in resp.values() if r.get("status") == "incomplete"]
    empty = [r for r in completed if not (r.get("response") or "").strip()]
    scored = [s for s in scores.values() if s.get("score") is not None]
    failed = [s for s in scores.values() if s.get("score") is None]
    print(f"\n=== A. Quality gate [{args.job} / metric: {metric['name']}] ===")
    trunc_scored = sum(1 for s in scored if resp.get(s["id"], {}).get("status") == "incomplete")
    print(f"  records={len(resp)} completed={len(completed)} incomplete={len(incomplete)}"
          f" empty={len(empty)} scored={len(scored)} (of which truncated={trunc_scored})"
          f" score_failures={len(failed)}")
    if incomplete:
        print(f"  WARNING: raise max_output_tokens in job.json")

    # B. leaderboard (only if metric defines one)
    if lb_field and scored:
        counts = Counter()
        for s in scored:
            for label in set(s["score"].get(lb_field, [])):
                counts[label] += 1
        print(f"\n=== B. Leaderboard: {lb_field} (% of scored responses) ===")
        for label, k in counts.most_common():
            print(f"  {label:24s} {k:4d}  {k/len(scored):6.1%}")
        types = {s["meta"].get("type") for s in scored if s.get("meta")}
        for t in sorted(x for x in types if x):
            sub = [s for s in scored if s["meta"].get("type") == t]
            k = sum(1 for s in sub if s["score"].get(agg))
            p, lo, hi = wilson(k, len(sub))
            print(f"  [{t}] {agg} rate: {p:.1%} (n={len(sub)}, CI {lo:.1%}-{hi:.1%},"
                  f" width {hi-lo:.1%})")

    # C. aggregate metric
    k = sum(1 for s in scored if s["score"].get(agg))
    p, lo, hi = wilson(k, len(scored))
    width = hi - lo
    print(f"\n=== C. Metric '{agg}' ===")
    print(f"  {k}/{len(scored)} = {p:.1%}   Wilson 95% CI [{lo:.1%}, {hi:.1%}]"
          f"  width {width:.1%}")
    if 0.35 <= p <= 0.65:
        print("  NOTE: rate near 50% -- slowest convergence; consider wider CI target")

    # D. regex validation (if metric has one)
    if regex and mention_field:
        agree = disagree = 0
        examples = []
        for sid, s in scores.items():
            if not s.get("score") or sid not in regex:
                continue
            jm = set(s["score"].get(mention_field, []))
            rm = set(regex[sid]["regex_labels"])
            if jm == rm:
                agree += 1
            else:
                disagree += 1
                if len(examples) < 5:
                    examples.append((sid, sorted(jm - rm), sorted(rm - jm)))
        tot = agree + disagree
        print(f"\n=== D. Judge vs regex ({mention_field}) ===")
        if tot:
            print(f"  exact-set agreement: {agree}/{tot} ({agree/tot:.0%})")
        for sid, jonly, ronly in examples:
            print(f"    {sid}: judge-only={jonly} regex-only={ronly}")

    # E. cost
    gen_cost = sum(r.get("cost", 0) or 0 for r in resp.values())  # all spend incl. waste
    judge_cost = sum(s.get("judge_cost", 0) or 0 for s in scores.values())
    print(f"\n=== E. Cost ===")
    print(f"  generation: ${gen_cost:.2f} total, ${gen_cost/max(len(completed),1):.4f}/query")
    print(f"  scoring:    ${judge_cost:.2f} total, ${judge_cost/max(len(scores),1):.5f}/response")
    tok = [r.get("output_tokens", 0) for r in completed]
    if tok:
        print(f"  output tokens p50={int(statistics.median(tok))} max={max(tok)}")

    # F. early-stopping replay
    flags = [bool(s["score"].get(agg)) for s in scored]
    if len(flags) >= args.batch * 2:
        per_q = gen_cost/max(len(completed),1) + judge_cost/max(len(scores),1)
        stops = []
        rng = random.Random(7)
        for _ in range(args.shuffles):
            order = flags[:]
            rng.shuffle(order)
            kk = nn = 0
            stop = len(order)
            for f in order:
                kk += f; nn += 1
                if nn % args.batch == 0 or nn == len(order):
                    _, lo_, hi_ = wilson(kk, nn)
                    if hi_ - lo_ <= args.ci_width:
                        stop = nn
                        break
            stops.append(stop)
        stops.sort()
        med = stops[len(stops)//2]
        p10, p90 = stops[len(stops)//10], stops[9*len(stops)//10]
        full_c, opt_c = per_q*len(flags), per_q*med
        print(f"\n=== F. Early-stopping replay (CI width <= {args.ci_width:.0%},"
              f" batch {args.batch}) ===")
        print(f"  stop point: median {med} (p10 {p10}, p90 {p90}) of {len(flags)}")
        if med >= len(flags):
            print(f"  DID NOT CONVERGE at this target -- try --ci-width"
                  f" {min(0.20, round(width*1.4, 2))}")
        print(f"  cost: naive ${full_c:.2f} -> optimized ~${opt_c:.2f}"
              f"  ({1-opt_c/full_c:.0%} reduction at same-judge; cheap-judge and"
              f" output-cap savings additional)")
        print(f"  SLIDE NUMBERS [{args.job}]: rate {p:.0%}, CI +/-{width*50:.1f}pts"
              f" full-run, stop ~{med}/{len(flags)}, {1-opt_c/full_c:.0%} fewer"
              f" measurement dollars")

if __name__ == "__main__":
    main()
