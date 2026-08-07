"""Build the Margin console: jobs/*/ artifacts -> margin-console.html.

  python build_console.py

Reads only the measured artifacts on disk (never the live API) -- the offline
demo guarantee (N1). Computes every displayed number here, injects the data
and Plotly into console.html, and writes one self-contained file that opens
from file:// with no server and no network.

jobs/ is read-only to this script. The budget-capped demo view is a replay of
the category job's scores -- nothing is written back.
"""

import json
import random
from collections import Counter
from pathlib import Path

from scorer import CHECKS      # the launcher's built-in checks, straight from the scorer
from stats import wilson, n_for_width

JOBS = Path("jobs")
BATCH = 20      # R4: the stopping rule decides after each batch of 20
SEED = 7        # fixed replay order -> the console is deterministic
SHUFFLES = 200  # median stop point, like analyze.py's replay

# Which jobs the console shows, in order, with each stopping rule's CI-width
# target. aeo_sunscreen is the blended parent population: shown, but its
# headline is suppressed (mix-dependent number -- deliberately not reported).
PANEL = [
    ("aeo_category_share", 0.14),   # hero: +/-7pts, LOCKED from rehearsal
    ("aeo_own_brand",      0.10),
    ("refusal_medical",    0.10),
]
SUPPRESSED = "aeo_sunscreen"
CAP_N = 40                          # slide-4 budget-cap failure demo
PRICE_WIDTHS = [0.20, 0.16, 0.14, 0.10]   # +/-10, 8, 7, 5 pts
SAMPLE_IDS = {"aeo_own_brand": ["b-003"]}  # pitch-named raw response


def read_jsonl(path):
    return [json.loads(l) for l in open(path)] if path.exists() else []


def replay(flags, target, order=None):
    """Walk flags batch-by-batch computing Wilson; return (trajectory, stop_n).
    stop_n is len(flags) if the target was never reached."""
    traj, k = [], 0
    stop = None
    for i, f in enumerate(flags if order is None else (flags[j] for j in order), 1):
        k += f
        if i % BATCH == 0 or i == len(flags):
            p, lo, hi = wilson(k, i)
            traj.append({"n": i, "p": p, "lo": lo, "hi": hi})
            if stop is None and hi - lo <= target:
                stop = i
    return traj, stop or len(flags)


def median_stop(flags, target):
    rng = random.Random(SEED)
    stops = []
    for _ in range(SHUFFLES):
        order = list(range(len(flags)))
        rng.shuffle(order)
        _, s = replay(flags, target, order)
        stops.append(s)
    stops.sort()
    return stops[len(stops) // 2]


def conservative_flags(cfg, scored):
    """The one shared counting rule (also used by memory_store --seed).

    Conservative flag: when the metric also names the target in a recommended-
    list field, require bool AND list to agree. A judge self-contradiction
    (bool true, list missing) counts as False and is reported as measured
    judge noise -- this reproduces the locked 38/39 own-brand number.
    Returns (flags, contradictions, target_brand)."""
    metric = cfg["metric"]
    agg = metric["aggregate_field"]
    lb_field = metric.get("leaderboard_field")
    target_brand = next((b for b in metric.get("labels", [])
                         if b.lower() in metric["name"].lower()
                         or b.lower() in cfg.get("description", "").lower()), None)
    if lb_field and target_brand:
        flags = [bool(s["score"].get(agg)) and target_brand in s["score"].get(lb_field, [])
                 for s in scored]
        contradictions = sum(1 for s in scored
                             if bool(s["score"].get(agg))
                             != (target_brand in s["score"].get(lb_field, [])))
    else:
        flags = [bool(s["score"].get(agg)) for s in scored]
        contradictions = 0
    return flags, contradictions, target_brand


def load_job(job_id, target):
    d = JOBS / job_id
    cfg = json.load(open(d / "job.json"))
    metric = cfg["metric"]
    agg = metric["aggregate_field"]
    lb_field = metric.get("leaderboard_field")
    popq = json.load(open(d / "population.json"))["queries"]
    responses = {r["id"]: r for r in read_jsonl(d / "responses.jsonl")
                 if r.get("status") in ("completed", "incomplete")}
    scored = [s for s in read_jsonl(d / "scores.jsonl") if s.get("score") is not None]

    flags, contradictions, target_brand = conservative_flags(cfg, scored)
    n, k = len(flags), sum(flags)
    p, lo, hi = wilson(k, n)
    gen = sum(s.get("gen_cost") or 0 for s in scored)
    judge = sum(s.get("judge_cost") or 0 for s in scored)
    cost = gen + judge
    per_q = cost / n if n else 0

    # deterministic single trajectory for the chart; median-of-shuffles for the
    # stated stop point (a single order can stop lucky or unlucky)
    order = list(range(n))
    random.Random(SEED).shuffle(order)
    traj, _ = replay(flags, target, order)
    stop = median_stop(flags, target)
    met = stop < n or hi - lo <= target

    # leaderboard (emphasis: the target brand vs context), if the metric has one
    leaderboard = None
    if lb_field:
        counts = Counter()
        for s in scored:
            for label in set(s["score"].get(lb_field, [])):
                counts[label] += 1
        leaderboard = [{"brand": b, "k": c, "pct": c / n,
                        "target": b == target_brand}
                       for b, c in counts.most_common()]

    # judge-vs-regex exact-set agreement (Q&A pocket), if the validator ran
    judge_check = None
    regex = {r["id"]: set(r["regex_labels"]) for r in read_jsonl(d / "regex.jsonl")}
    mf = metric.get("mention_field")
    if regex and mf:
        pairs = [(set(s["score"].get(mf, [])), regex[s["id"]])
                 for s in scored if s["id"] in regex]
        agree = sum(1 for a, b in pairs if a == b)
        judge_check = {"agree": agree, "total": len(pairs)}
    if contradictions:
        judge_check = {**(judge_check or {}), "contradictions": contradictions}

    # raw response samples: pitch-named ids first, then one positive + one
    # negative in file order
    want = list(SAMPLE_IDS.get(job_id, []))
    for positive in (True, False):
        for s in scored:
            if len(want) >= 3:
                break
            if bool(s["score"].get(agg)) == positive and s["id"] not in want:
                want.append(s["id"])
                break
    samples = [{"id": i, "query": responses[i]["query"],
                "text": responses[i].get("response", "")[:1200],
                "searches": responses[i].get("search_calls", 0),
                "flag": bool(next(s["score"].get(agg) for s in scored if s["id"] == i))}
               for i in want if i in responses]

    return {
        "id": job_id, "metric": metric["name"], "description": cfg.get("description", ""),
        "agg": agg, "model": cfg["measured"]["model"], "metric_cfg": metric,
        "scorer": {"type": metric["scorer"]["type"],
                   "model": metric["scorer"].get("model", ""),
                   "system": metric["scorer"].get("system", "")},
        "target_brand": target_brand if (lb_field and target_brand) else None,
        "search": bool(cfg["measured"].get("web_search")),
        "n": n, "k": k, "pop": len(popq),
        "population_texts": [q["text"] for q in popq],
        "estimate": p, "lo": lo, "hi": hi, "width": hi - lo,
        "target_width": target, "stop": stop, "met": met,
        "gen_cost": gen, "judge_cost": judge, "cost": cost, "per_q": per_q,
        "cost_at_stop": per_q * stop,
        "trajectory": traj, "leaderboard": leaderboard,
        "judge_check": judge_check, "samples": samples,
    }


def build_data():
    jobs = [load_job(job_id, target) for job_id, target in PANEL]

    # suppressed blended row -- listed to make the point, headline withheld
    sup_cfg = json.load(open(JOBS / SUPPRESSED / "job.json"))
    sup_scores = [s for s in read_jsonl(JOBS / SUPPRESSED / "scores.jsonl")
                  if s.get("score") is not None]
    suppressed = {
        "id": SUPPRESSED, "metric": sup_cfg["metric"]["name"],
        "n": len(sup_scores),
        "cost": sum((s.get("gen_cost") or 0) + (s.get("judge_cost") or 0)
                    for s in sup_scores),
    }

    # budget-capped demo: same category job, first CAP_N of the replay order
    hero = jobs[0]
    d = JOBS / hero["id"]
    scored = [s for s in read_jsonl(d / "scores.jsonl") if s.get("score") is not None]
    flags = [bool(s["score"].get(hero["agg"])) for s in scored]
    order = list(range(len(flags)))
    random.Random(SEED).shuffle(order)
    capped_flags = [flags[i] for i in order[:CAP_N]]
    ck = sum(capped_flags)
    cp, clo, chi = wilson(ck, CAP_N)
    capped = {"n": CAP_N, "k": ck, "estimate": cp, "lo": clo, "hi": chi,
              "width": chi - clo, "cost": hero["per_q"] * CAP_N,
              "true_p": hero["estimate"], "true_lo": hero["lo"], "true_hi": hero["hi"]}

    # precision price list from the hero job's measured rate + $/query
    # the measured row shows what the full run actually achieved; other rows are
    # quotes from the normal approximation at the measured rate and $/query
    widths = sorted(set(PRICE_WIDTHS + [round(hero["width"], 3)]), reverse=True)
    price_list = [
        {"width": hero["width"], "n": hero["n"], "cost": hero["cost"],
         "measured": True, "feasible": True}
        if abs(w - hero["width"]) < 1e-3 else
        {"width": w, "n": n_for_width(hero["estimate"], w),
         "cost": n_for_width(hero["estimate"], w) * hero["per_q"],
         "measured": False, "feasible": n_for_width(hero["estimate"], w) <= hero["pop"]}
        for w in widths]

    rates, rates_gen = rate_table()
    return {"jobs": jobs, "suppressed": suppressed, "capped": capped,
            "price_list": price_list, "batch": BATCH, "memory": memory_section(),
            "rates": rates, "rates_gen": rates_gen,
            "checks": [{"name": n, "field": c["field"], "label": c["label"],
                        "desc": c["desc"]}
                       for n, c in CHECKS.items() if c["ui"]]}


def rate_table():
    """Measured per-query cost by model|web_search combo -- feeds the launcher's
    pre-run quote. Max per combo: the quote stays conservative. Returns
    (gen+judge, gen only): a built-in check pays no judge."""
    rates, gen_only = {}, {}
    for d in sorted(JOBS.glob("*/")):
        sp = d / "scores.jsonl"
        if d.name.startswith("live_") or not sp.exists():
            continue
        cfg = json.load(open(d / "job.json"))
        scored = [s for s in read_jsonl(sp) if s.get("score") is not None]
        if not scored:
            continue
        gen = sum(s.get("gen_cost") or 0 for s in scored) / len(scored)
        judge = sum(s.get("judge_cost") or 0 for s in scored) / len(scored)
        key = f"{cfg['measured']['model']}|{1 if cfg['measured'].get('web_search') else 0}"
        rates[key] = max(rates.get(key, 0), round(gen + judge, 5))
        gen_only[key] = max(gen_only.get(key, 0), round(gen, 5))
    return rates, gen_only


def memory_section():
    """What Margin remembers -- rendered straight from memory/mirror.jsonl
    (the local mirror of what was pushed to EverOS). Renders gracefully at any
    stage: baselines only -> + warm-start re-cert -> + change-check."""
    mirror = read_jsonl(Path("memory/mirror.jsonl"))
    if not mirror:
        return None
    log = read_jsonl(Path("memory/everos_log.jsonl"))
    live = any(e.get("status") in (200, 201, 202) for e in log)
    mode = "live" if live else ("cached" if log else "local")

    by_metric = {}
    for r in mirror:
        by_metric.setdefault(r["metric"], []).append(r)
    for v in by_metric.values():
        v.sort(key=lambda r: r["ts"])

    baselines = [v[0] for v in by_metric.values() if v[0]["mode"] == "fresh"]

    warm = [r for r in mirror if r["mode"] == "warmstart"]
    recert = None
    if warm:
        w = warm[-1]
        base = next((r for r in by_metric[w["metric"]] if r["mode"] == "fresh"), None)
        if base:
            recert = {"metric": w["metric"], "week1": base, "week2": w,
                      "saved": 1 - w["cost"] / base["cost"] if base["cost"] else 0}

    chg = [r for r in mirror if r["mode"] == "change_check"]
    change = chg[-1] if chg else None

    # falling cost-per-certified-answer: metrics certified more than once
    series = [{"metric": m,
               "points": [{"mode": r["mode"], "cost": r["cost"], "n": r["n"]} for r in v]}
              for m, v in by_metric.items() if len(v) > 1]

    return {"mode": mode, "baselines": baselines, "recert": recert,
            "change": change, "series": series}


def selfcheck(data):
    hero, own, ref = data["jobs"]
    assert hero["n"] == 254 and abs(hero["estimate"] - 0.516) < 0.01, hero["estimate"]
    assert abs(hero["cost"] - 10.42) < 0.15, hero["cost"]
    assert 160 <= hero["stop"] <= 254, hero["stop"]
    assert own["k"] == 38 and own["n"] == 39
    assert ref["k"] == 0 and ref["n"] == 120 and ref["stop"] == 40
    assert abs(ref["hi"] - 0.031) < 0.002          # honest nonzero upper bound at k=0
    assert data["capped"]["width"] > hero["width"]  # capped = wider = honest
    assert not data["price_list"][-1]["feasible"]   # +/-5pts exceeds the population

    # memory panel: the mirror must agree with the console's own numbers
    mem = data["memory"]
    if mem:
        bl = {b["metric"]: b for b in mem["baselines"]}
        own_b = bl.get(own["metric"])
        assert own_b and own_b["k"] == own["k"] and own_b["n"] == own["n"], \
            "mirror disagrees with console counting -- reseed memory (rm -rf memory; --seed)"
        hero_b = bl.get(hero["metric"])
        assert hero_b and abs(hero_b["rate"] - hero["estimate"]) < 0.001
        if mem["recert"]:
            r = mem["recert"]
            assert r["week2"]["cost"] < r["week1"]["cost"]   # the price of certainty fell
            assert r["week2"]["n"] < r["week1"]["n"]
            assert r["week2"].get("interval") == "credible"  # honesty label present
        if mem["change"]:
            assert mem["change"].get("verdict") in ("changed", "no_change", "undecided")
    print("console selfcheck OK")


def main():
    data = build_data()
    selfcheck(data)
    html = Path("console.html").read_text()
    html = html.replace("/*__PLOTLY__*/", Path("vendor/plotly-basic.min.js").read_text())
    html = html.replace("/*__DATA__*/null", json.dumps(data))
    out = Path("margin-console.html")
    out.write_text(html)
    print(f"wrote {out} ({out.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    import sys
    if "--check" in sys.argv:
        selfcheck(build_data())
    else:
        main()
