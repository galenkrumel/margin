"""Margin generation runner — job-based, workload-agnostic.

  export OPENAI_API_KEY=sk-...
  python runner.py --job aeo_sunscreen --limit 10    # smoke
  python runner.py --job aeo_sunscreen               # full; resumable (skips done ids)
  python runner.py --job refusal_medical

Reads  jobs/<job>/population.json + job.json (measured-model settings)
Writes jobs/<job>/responses.jsonl (append-only, per-call cost ledger)
CLI flags override job.json settings.
"""

import argparse, asyncio, json, os, random, sys, time
from pathlib import Path

try:
    import httpx
except ImportError:
    sys.exit("pip install httpx")

API = "https://api.openai.com/v1"
HEADERS = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
           "Content-Type": "application/json"}
PRICES = {"gpt-5": (1.25, 10.00), "gpt-4o": (2.50, 10.00), "gpt-4o-mini": (0.15, 0.60)}
SEARCH_FEE = 0.01
MAX_RETRIES = 5


def price(model):
    for k in sorted(PRICES, key=len, reverse=True):
        if model.startswith(k):
            return PRICES[k]
    raise SystemExit(f"no price for {model} -- add to PRICES")


def extract_text(data):
    text, searches = [], 0
    for item in data.get("output", []):
        t = item.get("type", "")
        if "web_search" in t:
            searches += 1
        if t == "message":
            for c in item.get("content", []):
                if c.get("type") == "output_text":
                    text.append(c.get("text", ""))
    return "\n".join(text), searches


async def run_one(client, q, cfg, sem, out_path, lock, stats):
    async with sem:
        payload = {"model": cfg["model"], "input": q["text"],
                   "max_output_tokens": cfg["max_output_tokens"]}
        if cfg["web_search"]:
            payload["tools"] = [{"type": "web_search"}]
        if cfg.get("reasoning_effort"):
            payload["reasoning"] = {"effort": cfg["reasoning_effort"]}

        rec = {"id": q["id"], "meta": q.get("meta", {}), "query": q["text"],
               "model": cfg["model"]}
        t0 = time.perf_counter()
        for attempt in range(MAX_RETRIES):
            try:
                r = await client.post(f"{API}/responses", json=payload)
            except Exception as e:
                await asyncio.sleep(min(2 ** attempt + random.random(), 30))
                rec["error"] = repr(e)[:200]
                continue
            if r.status_code == 200:
                data = r.json()
                u = data.get("usage", {})
                text, searches = extract_text(data)
                pi, po = price(cfg["model"])
                tin, tout = u.get("input_tokens", 0), u.get("output_tokens", 0)
                rec.update({
                    "status": data.get("status", "completed"),
                    "incomplete_details": data.get("incomplete_details"),
                    "response": text,
                    "input_tokens": tin, "output_tokens": tout,
                    "search_calls": searches,
                    "cost": round(tin/1e6*pi + tout/1e6*po + searches*SEARCH_FEE, 6),
                    "latency": round(time.perf_counter() - t0, 2),
                    "error": None,
                })
                break
            if r.status_code in (429, 500, 502, 503):
                await asyncio.sleep(min(2 ** attempt + random.random(), 30))
                rec["error"] = f"{r.status_code} after retries"
                continue
            rec.update({"status": "error", "error": f"{r.status_code}: {r.text[:200]}"})
            break
        else:
            rec.setdefault("status", "error")

        async with lock:
            with open(out_path, "a") as f:
                f.write(json.dumps(rec) + "\n")
            stats["done"] += 1
            stats["cost"] += rec.get("cost", 0)
            ok = rec.get("status") == "completed"
            stats["ok"] += ok
            n = stats["done"]
            if n % 10 == 0 or not ok:
                print(f"  [{n}/{stats['total']}] ok={stats['ok']} "
                      f"${stats['cost']:.2f}  last={rec['id']}"
                      f"{'' if ok else '  <-- ' + str(rec.get('error') or rec.get('status'))}")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--concurrency", type=int, default=15)
    ap.add_argument("--model")
    ap.add_argument("--max-output-tokens", type=int)
    ap.add_argument("--reasoning-effort")
    ap.add_argument("--no-search", action="store_true")
    args = ap.parse_args()

    job_dir = Path("jobs") / args.job
    jobcfg = json.load(open(job_dir / "job.json"))
    m = jobcfg["measured"]
    cfg = {"model": args.model or m["model"],
           "web_search": (not args.no_search) and m.get("web_search", False),
           "max_output_tokens": args.max_output_tokens or m.get("max_output_tokens", 400),
           "reasoning_effort": args.reasoning_effort or m.get("reasoning_effort")}

    queries = json.load(open(job_dir / "population.json"))["queries"]
    if args.limit:
        queries = queries[:args.limit]

    out_path = job_dir / "responses.jsonl"
    done_ids = set()
    if out_path.exists():
        for line in open(out_path):
            try:
                r = json.loads(line)
                if r.get("status") == "completed":
                    done_ids.add(r["id"])
            except json.JSONDecodeError:
                pass
    todo = [q for q in queries if q["id"] not in done_ids]
    print(f"job={args.job} model={cfg['model']} search={cfg['web_search']} "
          f"total={len(queries)} done={len(done_ids)} todo={len(todo)}")
    if not todo:
        print("nothing to do")
        return

    sem = asyncio.Semaphore(args.concurrency)
    lock = asyncio.Lock()
    stats = {"done": 0, "ok": 0, "cost": 0.0, "total": len(todo)}
    t0 = time.perf_counter()
    async with httpx.AsyncClient(headers=HEADERS, timeout=180) as client:
        await asyncio.gather(*(run_one(client, q, cfg, sem, out_path, lock, stats)
                               for q in todo))
    print(f"\nDONE: {stats['ok']}/{len(todo)} completed, ${stats['cost']:.2f}, "
          f"{time.perf_counter()-t0:.0f}s -> {out_path}")
    if stats["ok"] < len(todo):
        print("  rerun the same command to retry failed ids (resumable)")

if __name__ == "__main__":
    asyncio.run(main())
