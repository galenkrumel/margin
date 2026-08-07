"""Margin MemoryStore — EverOS-backed statistical memory with local mirror.

Design: local jsonl mirror is ALWAYS written/read (stats never blocked by wifi);
EverOS Cloud calls are made live and their raw responses cached, so the demo
shows real memory-layer traffic with a labeled cached fallback.

  export EVEROS_API_KEY=...            # from everos.evermind.ai
  python memory_store.py --smoke       # store one memory + search it back
  python memory_store.py --seed        # write all completed jobs' baselines to memory

Env: EVEROS_BASE_URL (default https://api.evermind.ai; set http://localhost:1995
for self-hosted). Engine code uses MemoryStore.remember_result() / recall_baseline().
"""

import argparse, json, os, time, uuid
from pathlib import Path

try:
    import httpx
except ImportError:
    raise SystemExit("pip install httpx")

def _env(name, default=""):
    """os.environ first, then .env -- server and CLI must work without an export."""
    if os.environ.get(name):
        return os.environ[name]
    if Path(".env").exists():
        for line in Path(".env").read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    return default


BASE = _env("EVEROS_BASE_URL", "https://api.evermind.ai")
KEY = _env("EVEROS_API_KEY")
MIRROR = Path("memory/mirror.jsonl")
EVERLOG = Path("memory/everos_log.jsonl")   # raw request/response cache (demo fallback)
GROUP = "margin-measurements"               # memory API v2 session_id
SENDER = "margin-engine"                    # v2 sender_id/user_id the memories belong to


def _add_payload(content):
    """Memory API v2 add-message payload (the account is v2-only; v1 returns 403)."""
    return {"session_id": GROUP,
            "messages": [{"sender_id": SENDER, "role": "user", "content": content,
                          "timestamp": int(time.time() * 1000)}]}


def _headers():
    return {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def _log_ever(kind, payload, resp_status, resp_body):
    EVERLOG.parent.mkdir(exist_ok=True)
    with open(EVERLOG, "a") as f:
        f.write(json.dumps({"ts": time.time(), "kind": kind, "payload": payload,
                            "status": resp_status, "body": resp_body}) + "\n")


class MemoryStore:
    def __init__(self, live=True, timeout=8.0):
        self.live = live and bool(KEY)
        self.timeout = timeout
        self.last_mode = None  # 'live' | 'cached' | 'local'

    # ---- engine-facing API -------------------------------------------------
    def remember_result(self, record):
        """record: {metric, job_id, mode, model_version, n, k, rate, ci_lo,
        ci_hi, cost, ts}. Mirrors locally, best-effort pushes to EverOS."""
        MIRROR.parent.mkdir(exist_ok=True)
        with open(MIRROR, "a") as f:
            f.write(json.dumps(record) + "\n")
        if not self.live:
            self.last_mode = "local"
            return {"ok": True, "mode": "local"}
        payload = _add_payload("MEASUREMENT RESULT " + json.dumps(record))
        try:
            r = httpx.post(f"{BASE}/api/v2/memory/add", json=payload,
                           headers=_headers(), timeout=self.timeout)
            _log_ever("store", payload, r.status_code, r.text[:2000])
            self.last_mode = "live"
            return {"ok": r.status_code in (200, 201, 202), "mode": "live",
                    "status": r.status_code}
        except Exception as e:
            _log_ever("store", payload, -1, repr(e)[:500])
            self.last_mode = "local"
            return {"ok": True, "mode": "local", "error": repr(e)[:200]}

    def recall_baseline(self, metric, model_version=None):
        """Latest remembered result for a metric. Tries EverOS search live
        (proves the memory layer is real); statistics always come from the
        parsed content / local mirror so async extraction can't break math."""
        ever_hit = None
        if self.live:
            try:
                r = httpx.post(f"{BASE}/api/v2/memory/search",
                               json={"query": f"MEASUREMENT RESULT {metric}",
                                     "user_id": SENDER, "method": "vector", "top_k": 5},
                               headers=_headers(), timeout=self.timeout)
                _log_ever("search", {"metric": metric}, r.status_code, r.text[:2000])
                if r.status_code == 200:
                    ever_hit = r.json()
                    self.last_mode = "live"
            except Exception as e:
                _log_ever("search", {"metric": metric}, -1, repr(e)[:500])
        if ever_hit is None:
            self.last_mode = "cached" if EVERLOG.exists() else "local"
        # authoritative numbers from mirror (same data we pushed):
        best = None
        if MIRROR.exists():
            for line in open(MIRROR):
                rec = json.loads(line)
                if rec["metric"] != metric:
                    continue
                if model_version and rec.get("model_version") != model_version:
                    continue
                if best is None or rec["ts"] >= best["ts"]:
                    best = rec
        return {"baseline": best, "everos_mode": self.last_mode,
                "everos_raw": ever_hit}


# ---- CLI -------------------------------------------------------------------

def seed_from_jobs():
    """Write every completed job's headline result into memory. Counting and
    interval math are the console's shared definitions (no drift)."""
    from stats import wilson
    from build_console import conservative_flags, SUPPRESSED
    ms = MemoryStore()
    for job_dir in sorted(Path("jobs").glob("*/")):
        sp = job_dir / "scores.jsonl"
        if not sp.exists() or job_dir.name == SUPPRESSED:
            continue  # blended mix: console withholds its headline, memory must too
        if job_dir.name.startswith("live_"):
            continue  # ad-hoc launcher jobs are not curated baselines
        cfg = json.load(open(job_dir / "job.json"))
        scored = [json.loads(l) for l in open(sp)]
        scored = [x for x in scored if x.get("score") is not None]
        if not scored:
            continue
        flags, _, _ = conservative_flags(cfg, scored)
        k, n = sum(flags), len(flags)
        p, lo, hi = wilson(k, n)
        cost = sum((x.get("gen_cost") or 0) + (x.get("judge_cost") or 0)
                   for x in scored)
        rec = {"metric": cfg["metric"]["name"], "job_id": cfg["job_id"],
               "mode": "fresh", "model_version": cfg["measured"]["model"],
               "n": n, "k": k, "rate": round(p, 4), "ci_lo": round(lo, 4),
               "ci_hi": round(hi, 4), "cost": round(cost, 2), "ts": time.time()}
        out = ms.remember_result(rec)
        print(f"  {rec['metric']}: {k}/{n} = {p:.1%}  ${rec['cost']:.2f} -> memory [{out['mode']}]")


def smoke():
    ms = MemoryStore()
    print(f"BASE={BASE}  key={'set' if KEY else 'MISSING'}")
    rec = {"metric": "smoke_test", "job_id": "smoke", "mode": "fresh",
           "model_version": "none", "n": 10, "k": 5, "rate": 0.5,
           "ci_lo": 0.24, "ci_hi": 0.76, "cost": 0.0, "ts": time.time()}
    print("store:", ms.remember_result(rec))
    time.sleep(2)  # async extraction grace
    got = ms.recall_baseline("smoke_test")
    print("recall mode:", got["everos_mode"])
    print("baseline:", got["baseline"])
    if got["everos_raw"] is not None:
        print("everos raw (truncated):", json.dumps(got["everos_raw"])[:400])
    print("\nIf store/search returned 4xx: endpoint shape differs on Cloud —"
          " show this output to the EverMind team on-site; local mirror keeps"
          " everything working meanwhile.")


def push_mirror():
    """Replay every mirror record to EverOS (run once when the API key lands).
    Pushes only; does not re-append to the mirror."""
    if not KEY:
        raise SystemExit("EVEROS_API_KEY not set")
    for line in open(MIRROR):
        rec = json.loads(line)
        payload = _add_payload("MEASUREMENT RESULT " + json.dumps(rec))
        try:
            r = httpx.post(f"{BASE}/api/v2/memory/add", json=payload,
                           headers=_headers(), timeout=8.0)
            _log_ever("store", payload, r.status_code, r.text[:2000])
            print(f"  {rec['metric']} [{rec['mode']}] -> {r.status_code}")
        except Exception as e:
            _log_ever("store", payload, -1, repr(e)[:500])
            print(f"  {rec['metric']} [{rec['mode']}] -> FAILED {repr(e)[:100]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--seed", action="store_true")
    ap.add_argument("--push", action="store_true",
                    help="replay the local mirror to EverOS (run when the key lands)")
    a = ap.parse_args()
    if a.smoke:
        smoke()
    elif a.seed:
        seed_from_jobs()
    elif a.push:
        push_mirror()
    else:
        print(__doc__)
