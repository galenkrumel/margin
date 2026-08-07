"""Probe search-capable models: which endpoint works, what the rate limits are,
and what one query actually costs. Run after rate_limit_test.py passed auth.

  export OPENAI_API_KEY=sk-...
  python search_model_probe.py

Spends a few cents total (one query per variant).
"""

import asyncio
import json
import os
import sys

try:
    import httpx
except ImportError:
    sys.exit("pip install httpx")

API = "https://api.openai.com/v1"
HEADERS = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
           "Content-Type": "application/json"}

PROMPT = "In two sentences: what's a good everyday face sunscreen?"

# $/1M (input, output) + per-call search fee. Verify vs. openai pricing page.
PRICES = {
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-5-search-api": (1.25, 10.00),
    "gpt-4o-search-preview": (2.50, 10.00),
    "gpt-4o-mini-search-preview": (0.15, 0.60),
}
SEARCH_CALL_FEE = 0.01  # $10 / 1k calls

# (label, endpoint, payload)
VARIANTS = [
    ("gpt-5-search-api / responses", "responses",
     {"model": "gpt-5-search-api", "input": PROMPT}),
    ("gpt-5-search-api / chat", "chat/completions",
     {"model": "gpt-5-search-api", "max_tokens": 150,
      "messages": [{"role": "user", "content": PROMPT}]}),
    ("gpt-4o-search-preview / chat", "chat/completions",
     {"model": "gpt-4o-search-preview", "web_search_options": {},
      "messages": [{"role": "user", "content": PROMPT}]}),
    ("gpt-4o-mini-search-preview / chat", "chat/completions",
     {"model": "gpt-4o-mini-search-preview", "web_search_options": {},
      "messages": [{"role": "user", "content": PROMPT}]}),
    ("gpt-4o-mini + web_search tool / responses", "responses",
     {"model": "gpt-4o-mini", "tools": [{"type": "web_search"}], "input": PROMPT}),
    ("gpt-5 + web_search tool / responses", "responses",
     {"model": "gpt-5", "tools": [{"type": "web_search"}], "input": PROMPT}),
]

RL = ["x-ratelimit-limit-requests", "x-ratelimit-limit-tokens",
      "x-ratelimit-remaining-tokens"]


def cost(model_key, tin, tout, searched=True):
    for k, (pi, po) in PRICES.items():
        if model_key.startswith(k):
            c = tin / 1e6 * pi + tout / 1e6 * po
            return c + (SEARCH_CALL_FEE if searched else 0)
    return None


async def probe(client, label, endpoint, payload):
    print(f"\n--- {label} ---")
    try:
        r = await client.post(f"{API}/{endpoint}", json=payload)
    except Exception as e:
        print(f"  transport error: {e!r}")
        return
    for h in RL:
        if h in r.headers:
            print(f"  {h}: {r.headers[h]}")
    if r.status_code != 200:
        print(f"  {r.status_code}: {r.text[:250]}")
        return
    data = r.json()
    u = data.get("usage", {})
    tin = u.get("input_tokens") or u.get("prompt_tokens") or 0
    tout = u.get("output_tokens") or u.get("completion_tokens") or 0
    c = cost(payload["model"], tin, tout)
    print(f"  OK  in={tin} out={tout}"
          + (f"  est ${c:.4f}/query (incl $0.01 search fee)" if c else ""))
    tpm = int(r.headers.get("x-ratelimit-limit-tokens", 0) or 0)
    if tpm and tin:
        qpm = tpm / tin
        print(f"  -> at TPM={tpm}: ~{qpm:.1f} queries/min"
              f" -> 312-query baseline in ~{312 / qpm:.0f} min")


async def main():
    async with httpx.AsyncClient(headers=HEADERS, timeout=120) as client:
        for v in VARIANTS:
            await probe(client, *v)
    print("\nDecision rule: pick the highest-realism variant whose baseline time"
          " fits the event (<45 min) and whose $/query you can afford x ~600"
          " queries of dress rehearsal + event runs.")

if __name__ == "__main__":
    asyncio.run(main())
