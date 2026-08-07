"""Margin pre-event readiness test for a funded OpenAI account.

Answers four questions before Thursday:
  1. What tier/limits does this key actually have? (headers, not assumptions)
  2. Which candidate models can this key see?
  3. Does a 20-concurrent burst survive? (the event-day runner uses Semaphore(10-20))
  4. What will the 312-query naive baseline cost and how long will it take?

Usage:
  pip install httpx
  export OPENAI_API_KEY=sk-...
  python rate_limit_test.py                     # default: burst of 20 on gpt-4o
  python rate_limit_test.py --model gpt-5 --burst 20
  python rate_limit_test.py --skip-search       # skip the web-search probe

No files written; read the verdict at the end. Total spend for a default run: well under $0.50.
"""

import argparse
import asyncio
import json
import os
import statistics
import sys
import time

try:
    import httpx
except ImportError:
    sys.exit("pip install httpx")

API = "https://api.openai.com/v1"
KEY = os.environ.get("OPENAI_API_KEY")
if not KEY:
    sys.exit("export OPENAI_API_KEY first")
HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# $/1M tokens (input, output). Verified Aug 2026 vs. secondary sources —
# confirm against https://openai.com/api/pricing before the event; batch = 50% off.
PRICES = {
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-5": (1.25, 10.00),
}
CANDIDATE_PREFIXES = ("gpt-4o", "gpt-5", "o3", "o4")
SEARCH_HINTS = ("search",)

# Baseline-run assumptions (mirror the plan): 312 queries, ~60 in / ~250 out tokens each.
BASELINE_N, TOK_IN, TOK_OUT = 312, 60, 250

RL_HEADERS = [
    "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests",
    "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens",
]


def price_for(model):
    for k, v in PRICES.items():
        if model.startswith(k):
            return v
    return None


async def probe_headers(client, model):
    print(f"\n=== 1. Rate-limit headers (single {model} call) ===")
    r = await client.post(f"{API}/chat/completions", json={
        "model": model, "max_tokens": 5,
        "messages": [{"role": "user", "content": "ping"}],
    })
    if r.status_code != 200:
        print(f"  FAILED {r.status_code}: {r.text[:300]}")
        return None
    limits = {}
    for h in RL_HEADERS:
        if h in r.headers:
            limits[h] = r.headers[h]
            print(f"  {h}: {r.headers[h]}")
    rpm = int(limits.get("x-ratelimit-limit-requests", 0) or 0)
    tpm = int(limits.get("x-ratelimit-limit-tokens", 0) or 0)
    print(f"  -> RPM={rpm or '?'}  TPM={tpm or '?'}"
          f"  (tier-1 gpt-4o is typically ~500 RPM / 30k TPM; higher tiers scale up)")
    return {"rpm": rpm, "tpm": tpm}


async def list_models(client):
    print("\n=== 2. Candidate models visible to this key ===")
    r = await client.get(f"{API}/models")
    if r.status_code != 200:
        print(f"  FAILED {r.status_code}: {r.text[:200]}")
        return []
    ids = sorted(m["id"] for m in r.json().get("data", []))
    cands = [m for m in ids if m.startswith(CANDIDATE_PREFIXES)]
    search = [m for m in ids if any(h in m for h in SEARCH_HINTS)]
    for m in cands:
        print(f"  {m}")
    if search:
        print("  search-capable model ids:")
        for m in search:
            print(f"    {m}")
    else:
        print("  (no model id containing 'search' — web search likely lives on the"
              " Responses API as a tool; see probe 4)")
    return cands


async def one_call(client, model, i, sem, results):
    async with sem:
        t0 = time.perf_counter()
        try:
            r = await client.post(f"{API}/chat/completions", json={
                "model": model, "max_tokens": 40, "temperature": 1,
                "messages": [{"role": "user",
                              "content": f"Reply with one short sentence. Marker {i}."}],
            })
            dt = time.perf_counter() - t0
            usage = r.json().get("usage", {}) if r.status_code == 200 else {}
            results.append({"i": i, "status": r.status_code, "latency": dt,
                            "in": usage.get("prompt_tokens", 0),
                            "out": usage.get("completion_tokens", 0),
                            "err": None if r.status_code == 200 else r.text[:150]})
        except Exception as e:
            results.append({"i": i, "status": -1, "latency": time.perf_counter() - t0,
                            "in": 0, "out": 0, "err": repr(e)[:150]})


async def burst(client, model, n, concurrency):
    print(f"\n=== 3. Burst: {n} requests, concurrency {concurrency}, model {model} ===")
    sem = asyncio.Semaphore(concurrency)
    results = []
    t0 = time.perf_counter()
    await asyncio.gather(*(one_call(client, model, i, sem, results) for i in range(n)))
    wall = time.perf_counter() - t0

    ok = [r for r in results if r["status"] == 200]
    r429 = [r for r in results if r["status"] == 429]
    other = [r for r in results if r["status"] not in (200, 429)]
    lats = sorted(r["latency"] for r in ok)
    print(f"  ok={len(ok)}  429={len(r429)}  other_errors={len(other)}  wall={wall:.1f}s")
    if lats:
        print(f"  latency p50={statistics.median(lats):.2f}s"
              f"  p95={lats[int(0.95 * (len(lats) - 1))]:.2f}s  max={lats[-1]:.2f}s")
    for r in (r429 + other)[:5]:
        print(f"    [{r['status']}] {r['err']}")

    tok_in = sum(r["in"] for r in ok)
    tok_out = sum(r["out"] for r in ok)
    p = price_for(model)
    if p and ok:
        cost = tok_in / 1e6 * p[0] + tok_out / 1e6 * p[1]
        print(f"  measured: {tok_in} in / {tok_out} out tokens, ${cost:.4f} for this burst")
    return {"ok": len(ok), "n": n, "wall": wall, "429": len(r429)}


async def search_probe(client):
    print("\n=== 4. Web-search probe (Responses API) ===")
    payloads = [
        {"model": "gpt-4o", "tools": [{"type": "web_search"}],
         "input": "In one sentence: what sunscreen is trending this summer?"},
        {"model": "gpt-4o", "tools": [{"type": "web_search_preview"}],
         "input": "In one sentence: what sunscreen is trending this summer?"},
    ]
    for pl in payloads:
        r = await client.post(f"{API}/responses", json=pl)
        tool = pl["tools"][0]["type"]
        if r.status_code == 200:
            u = r.json().get("usage", {})
            print(f"  OK with tool '{tool}'. usage={json.dumps(u)}")
            print("  -> search-enabled generation WORKS on this key. Note the token usage:"
                  " search responses cost more per query — good for the savings story,"
                  " budget accordingly.")
            return True
        print(f"  tool '{tool}': {r.status_code} {r.text[:200]}")
    print("  -> No search variant worked. Decide tonight: plain generation model +"
          " one-sentence limitation in the demo (the plan's stated fallback).")
    return False


def verdict(limits, burst_res, model):
    print("\n=== VERDICT: extrapolation to the 312-query naive baseline ===")
    p = price_for(model) or (2.50, 10.00)
    cost = BASELINE_N * (TOK_IN / 1e6 * p[0] + TOK_OUT / 1e6 * p[1])
    print(f"  est. baseline cost on {model}: ${cost:.2f}"
          f"  ({BASELINE_N} q x ~{TOK_IN} in / {TOK_OUT} out tokens)")
    if burst_res and burst_res["ok"]:
        rate = burst_res["ok"] / burst_res["wall"]
        print(f"  observed throughput: {rate:.1f} req/s -> full baseline in"
              f" ~{BASELINE_N / rate / 60:.1f} min at this concurrency")
    if limits and limits["tpm"]:
        need_tpm = int((TOK_IN + TOK_OUT) * BASELINE_N)  # if run within one minute (it won't be)
        per_min_at_obs = int((TOK_IN + TOK_OUT) * (burst_res["ok"] / burst_res["wall"]) * 60) \
            if burst_res and burst_res["ok"] else 0
        print(f"  TPM limit {limits['tpm']} vs ~{per_min_at_obs} tokens/min at observed rate"
              f"  ({'OK' if limits['tpm'] >= per_min_at_obs else 'WILL THROTTLE —'
                  ' lower concurrency or add sleep between batches'})")
    if burst_res and burst_res["429"]:
        print(f"  {burst_res['429']}/{burst_res['n']} calls got 429 at this concurrency:"
              " drop the runner's Semaphore or add jittered retries (already in the plan).")
    if burst_res and burst_res["ok"] == burst_res["n"] and not burst_res["429"]:
        print("  PASS: 20-concurrent survives. Event-day runner config is safe.")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gpt-4o")
    ap.add_argument("--burst", type=int, default=20)
    ap.add_argument("--concurrency", type=int, default=20)
    ap.add_argument("--skip-search", action="store_true")
    args = ap.parse_args()

    async with httpx.AsyncClient(headers=HEADERS, timeout=60) as client:
        limits = await probe_headers(client, args.model)
        cands = await list_models(client)
        if args.model not in cands:
            print(f"\n  NOTE: '{args.model}' not in this key's model list — burst will"
                  " likely fail. Rerun with --model <one of the listed ids>.")
        b = await burst(client, args.model, args.burst, args.concurrency)
        if not args.skip_search:
            await search_probe(client)
        verdict(limits, b, args.model)

if __name__ == "__main__":
    asyncio.run(main())
