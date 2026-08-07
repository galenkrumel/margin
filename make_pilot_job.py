"""Clone the category population into a pilot job with a different measured
model — for choosing the change-check comparison system.

  python make_pilot_job.py --name pilot_mini --model gpt-4o-mini --limit 60
  python make_pilot_job.py --name pilot_nosearch --model gpt-5 --no-search --limit 60
Then: runner.py --job <name> ; scorer.py --job <name> ;
      memory_stats.py change --job <name> --baseline-metric supergoop_category_share
"""
import argparse, json
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True)
ap.add_argument("--model", required=True)
ap.add_argument("--no-search", action="store_true")
ap.add_argument("--limit", type=int, default=60)
ap.add_argument("--source", default="aeo_category_share")
a = ap.parse_args()

src = Path("jobs") / a.source
cfg = json.load(open(src / "job.json"))
pop = json.load(open(src / "population.json"))["queries"][: a.limit]
cfg["job_id"] = a.name
cfg["measured"]["model"] = a.model
cfg["measured"]["web_search"] = not a.no_search
cfg["metric"]["name"] = f'{cfg["metric"]["name"]}@{a.model}{"-nosearch" if a.no_search else ""}'  # never collide with baseline metric in memory
if a.model.startswith("gpt-4o"):
    cfg["measured"].pop("reasoning_effort", None)  # 4o family: no reasoning param
d = Path("jobs") / a.name
d.mkdir(parents=True, exist_ok=True)
json.dump({"queries": pop}, open(d / "population.json", "w"), indent=2)
json.dump(cfg, open(d / "job.json", "w"), indent=2)
print(f"jobs/{a.name}: {len(pop)} queries, model={a.model}, search={not a.no_search}")
