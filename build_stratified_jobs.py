"""Build the two stratified AEO jobs from existing artifacts. Run AFTER the
aeo_sunscreen baseline + scoring are complete.

  python build_stratified_jobs.py

Creates:
  jobs/aeo_own_brand/       39 Supergoop-branded queries — responses+scores COPIED
                            from aeo_sunscreen (zero new API cost; just analyze it)
  jobs/aeo_category_share/  ~300 unbranded category queries — the 80 existing ones
                            pre-seeded with their responses+scores; runner will
                            generate only the ~220 new ones (~$6)

Then:
  python analyze.py --job aeo_own_brand --ci-width 0.10
  python runner.py  --job aeo_category_share          # runs only the new ~220
  python scorer.py  --job aeo_category_share
  python analyze.py --job aeo_category_share --ci-width 0.14
"""

import json
import itertools
from pathlib import Path

SRC = Path("jobs/aeo_sunscreen")

# ---------------------------------------------------------------- expansion --
SKIN = ["oily skin", "dry skin", "sensitive skin", "acne-prone skin",
        "combination skin", "mature skin", "rosacea-prone skin",
        "eczema-prone skin", "melasma", "darker skin tones"]
CONTEXT = ["the beach", "daily office wear", "running", "hiking", "golf",
           "swimming", "skiing", "gardening", "a tropical vacation",
           "long drives", "cycling", "tennis"]
ATTR = ["no white cast", "a matte finish", "a dewy finish", "fragrance-free",
        "reef-safe", "water-resistant", "non-greasy", "non-comedogenic",
        "mineral-only", "lightweight texture"]
VENUE = ["Target", "CVS", "Costco", "Sephora", "Ulta", "Amazon", "Walgreens", "Walmart"]
AUDIENCE = ["a toddler", "a teenager", "a man who hates lotions", "a senior with thin skin",
            "a newborn", "someone pregnant", "a kid who plays outdoor sports"]

def expansion():
    out = []
    for s in SKIN:
        out += [f"What's the best face sunscreen for {s}?",
                f"Recommend a daily sunscreen for {s}.",
                f"I have {s} — which sunscreen should I buy?"]
    for c in CONTEXT:
        out += [f"What's the best sunscreen for {c}?",
                f"Recommend a sunscreen that holds up for {c}."]
    for a in ATTR:
        out += [f"What's the best face sunscreen with {a}?",
                f"Looking for a sunscreen with {a} — suggestions?"]
    for v in VENUE:
        out += [f"What's the best sunscreen I can buy at {v}?",
                f"I'm at {v} right now — which sunscreen do I grab?"]
    for aud in AUDIENCE:
        out += [f"What's the best sunscreen for {aud}?",
                f"Which sunscreen should I buy for {aud}?"]
    for s, a in itertools.islice(itertools.product(SKIN, ATTR), 60):
        out.append(f"Best sunscreen for {s} with {a}?")
    # light curated tail for phrasing variety
    out += [
        "If you could only recommend one sunscreen, what would it be?",
        "What sunscreen do most dermatologists tell their patients to buy?",
        "What's the most popular face sunscreen right now?",
        "What sunscreen has the best reviews this year?",
        "Which sunscreen brand is winning right now and why?",
        "What's the best value sunscreen — good protection without the markup?",
        "I've never worn sunscreen daily. What should my first bottle be?",
        "What sunscreen should go in my gym bag?",
        "Which SPF moisturizer can replace a separate sunscreen for everyday?",
        "What's the best sunscreen under twenty dollars?",
    ]
    # dedupe, preserve order
    seen, uniq = set(), []
    for q in out:
        if q not in seen:
            seen.add(q); uniq.append(q)
    return uniq


def load_jsonl(p):
    return [json.loads(l) for l in open(p)] if Path(p).exists() else []


def dump_jsonl(p, records):
    with open(p, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def main():
    jobcfg = json.load(open(SRC / "job.json"))
    pop = json.load(open(SRC / "population.json"))["queries"]
    responses = load_jsonl(SRC / "responses.jsonl")
    scores = load_jsonl(SRC / "scores.jsonl")
    if not responses or not scores:
        raise SystemExit("aeo_sunscreen responses/scores not found — run the baseline first")

    # ---- job: aeo_own_brand (filter, zero cost) ----
    own_ids = {q["id"] for q in pop
               if q["meta"].get("type") == "branded" and q["meta"].get("brand") == "Supergoop"}
    d = Path("jobs/aeo_own_brand"); d.mkdir(parents=True, exist_ok=True)
    json.dump({"queries": [q for q in pop if q["id"] in own_ids]},
              open(d / "population.json", "w"), indent=2)
    own_job = json.loads(json.dumps(jobcfg))
    own_job["job_id"] = "aeo_own_brand"
    own_job["description"] = "Own-brand endorsement: shopper asks about Supergoop directly — is it recommended?"
    own_job["metric"]["name"] = "supergoop_endorsed_when_asked"
    json.dump(own_job, open(d / "job.json", "w"), indent=2)
    dump_jsonl(d / "responses.jsonl", [r for r in responses if r["id"] in own_ids])
    dump_jsonl(d / "scores.jsonl", [s for s in scores if s["id"] in own_ids])
    print(f"  jobs/aeo_own_brand: {len(own_ids)} queries, artifacts copied (no API cost)")

    # ---- job: aeo_category_share (80 seeded + ~220 new) ----
    cat_existing = [q for q in pop if q["meta"].get("type") == "category"]
    existing_texts = {q["text"] for q in cat_existing}
    new_qs = [q for q in expansion() if q not in existing_texts]
    d = Path("jobs/aeo_category_share"); d.mkdir(parents=True, exist_ok=True)
    # NOTE: source ids are numbered globally (category ids are c-233..c-312, not
    # c-001..c-080) — new queries get a separate cx- namespace to guarantee no
    # collision with seeded ids regardless of source numbering.
    existing_ids = {q["id"] for q in cat_existing}
    new_pop = cat_existing + [
        {"id": f"cx-{i + 1:03d}", "text": q, "meta": {"type": "category"}}
        for i, q in enumerate(new_qs)]
    assert len({q["id"] for q in new_pop}) == len(new_pop), "id collision"
    json.dump({"queries": new_pop}, open(d / "population.json", "w"), indent=2)
    cat_job = json.loads(json.dumps(jobcfg))
    cat_job["job_id"] = "aeo_category_share"
    cat_job["description"] = "Category share of voice: unbranded shopping questions — is Supergoop recommended?"
    cat_job["metric"]["name"] = "supergoop_category_share"
    json.dump(cat_job, open(d / "job.json", "w"), indent=2)
    cat_ids = {q["id"] for q in cat_existing}
    dump_jsonl(d / "responses.jsonl", [r for r in responses if r["id"] in cat_ids])
    dump_jsonl(d / "scores.jsonl", [s for s in scores if s["id"] in cat_ids])
    print(f"  jobs/aeo_category_share: {len(new_pop)} queries "
          f"({len(cat_existing)} seeded with artifacts, {len(new_qs)} new to run ~${len(new_qs)*0.029:.0f})")

if __name__ == "__main__":
    main()
