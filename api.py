"""Margin job API -- R1 contract, R4 stopping rule.

  ./venv/bin/uvicorn api:app --port 8000

  POST /jobs      {prompts[], metric, measured?, precision?, budget?}
  GET  /jobs      list
  GET  /jobs/{id} {status, estimate, ci, executions_used, cost_usd, cost_naive_usd, ...}
  GET  /          the built console (margin-console.html)

The loop shells out to runner.py / scorer.py -- the code that produced the
measured data, untouched. runner.py is resumable and skips completed ids, so
raising --limit by one batch IS the next batch. In-memory job store (R1: no
auth, no tenancy, no database).
"""

import asyncio, json, math, os, sys, time
from pathlib import Path
from typing import Union

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from memory_store import MemoryStore
from scorer import REGISTRY as CHECKS   # built-in deterministic scorers (metric.scorer.type == "function")
from stats import wilson

JOBS = Path("jobs")
PY = sys.executable
STATE = {}  # job_id -> dict

# warm-start constants -- same values as memory_stats.py (R13)
PRIOR_CAP = 25   # max effective prior sample size (discounted memory)
DRIFT_Z = 2.5    # drift guard threshold on fresh-vs-prior divergence


def _beta_ci(a, b):
    """Normal approx to Beta credible interval (memory_stats.py's beta_ci)."""
    m = a / (a + b)
    h = 1.96 * math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)))
    return m, max(0.0, m - h), min(1.0, m + h)


class Measured(BaseModel):
    # Deliberately cheap defaults: gpt-5 + search is an explicit opt-in, never an accident.
    model: str = "gpt-4o-mini"
    web_search: bool = False
    max_output_tokens: int = 400
    reasoning_effort: Union[str, None] = None


class Precision(BaseModel):
    ci_width: float = 0.14      # +/-7pts, LOCKED from rehearsal (R4)
    confidence: float = 0.95    # only 95% supported; declared so the contract is explicit


class Budget(BaseModel):
    max_executions: int = 200
    max_usd: float = 1.00


class Prompt(BaseModel):
    id: Union[str, None] = None
    text: str
    meta: dict = Field(default_factory=dict)


_EX_METRIC_PATH = Path("jobs/aeo_category_share/job.json")
_EX_METRIC = (json.load(_EX_METRIC_PATH.open())["metric"]
              if _EX_METRIC_PATH.exists() else {})


class JobRequest(BaseModel):
    prompts: list[Union[str, Prompt]]
    metric: dict                # full metric block as scorer.py consumes it (R10)
    measured: Measured = Measured()
    precision: Precision = Precision()
    budget: Budget = Budget()
    batch: int = 20             # R4: rule decides after each batch of 20 scored

    model_config = {"json_schema_extra": {"examples": [{
        # a real, runnable job: /docs -> Try it out -> Execute (~$0.02)
        "prompts": ["What's the best face sunscreen?",
                    "What sunscreen won't leave a white cast?",
                    "Best sunscreen to wear under makeup?",
                    "What SPF moisturizer do dermatologists recommend?",
                    "Which sunscreen is best for oily skin?"],
        "metric": _EX_METRIC,
        "measured": {"model": "gpt-4o-mini", "web_search": False},
        "precision": {"ci_width": 0.2},
        "budget": {"max_executions": 20, "max_usd": 0.25},
    }, {
        # the same contract with a built-in check: free, exact, no judge call
        "prompts": ["Return only JSON for: 'Ergonomic chair, $249.99, in stock'.",
                    "Convert to JSON, nothing else: 'Dr. Maya Chen, cardiologist, Boston'.",
                    "Respond with valid JSON only: '2 cups flour, 1 tsp salt, 3 eggs'.",
                    "Output JSON and no prose: 'UA 1123, SFO to DEN, departs 7:45am'.",
                    "JSON only: 'ERROR 2026-03-01 db_timeout retries=3'."],
        "metric": {"name": "json_valid_rate", "aggregate_field": "valid",
                   "scorer": {"type": "function", "name": "json_valid"}},
        "measured": {"model": "gpt-4o-mini", "web_search": False},
        "precision": {"ci_width": 0.2},
        "budget": {"max_executions": 20, "max_usd": 0.10},
    }]}}


app = FastAPI(title="Margin",
              description="Precision-targeted measurement for stochastic systems.")


def _env():
    """OPENAI_API_KEY from .env if not already exported."""
    env = dict(os.environ)
    if "OPENAI_API_KEY" not in env and Path(".env").exists():
        for line in Path(".env").read_text().splitlines():
            if line.startswith("OPENAI_API_KEY="):
                env["OPENAI_API_KEY"] = line.split("=", 1)[1].strip()
    return env


def _read_scores(job_dir, agg):
    """(n, k, cost) from whatever the scorer has written so far."""
    p = job_dir / "scores.jsonl"
    n = k = 0
    cost = 0.0
    if p.exists():
        for line in p.open():
            s = json.loads(line)
            if s.get("score") is None:
                continue
            n += 1
            k += bool(s["score"].get(agg))
            cost += (s.get("gen_cost") or 0) + (s.get("judge_cost") or 0)
    return n, k, cost


def _rehydrate():
    """Finished live jobs from disk -> STATE, so a restart doesn't empty the
    Jobs table while Memory (durable by design) still shows their results."""
    for d in sorted(JOBS.glob("live_*/")):
        jp, sp = d / "job.json", d / "scores.jsonl"
        if not (jp.exists() and sp.exists()):
            continue
        cfg = json.load(jp.open())
        agg = cfg["metric"]["aggregate_field"]
        # jobs from before "requested" was saved fall back to server defaults
        req = cfg.get("requested") or {
            "metric": cfg["metric"], "measured": cfg["measured"],
            "precision": Precision().model_dump(), "budget": Budget().model_dump(),
            "batch": 20, "prompts": []}
        pq = d / "population.json"
        if not req.get("prompts") and pq.exists():
            # old dirs predate saving the request: the population IS the prompts
            req["prompts"] = [q["text"] for q in json.load(pq.open())["queries"]]
        flags, cost = [], 0.0
        for line in sp.open():
            s = json.loads(line)
            if s.get("score") is None:
                continue
            flags.append(bool(s["score"].get(agg)))
            cost += (s.get("gen_cost") or 0) + (s.get("judge_cost") or 0)
        if not flags:
            continue
        pp = d / "population.json"
        pop = len(json.load(pp.open())["queries"]) if pp.exists() else len(flags)
        batch = req.get("batch", 20)
        traj = []   # replayed in batch chunks, same rule the live loop records
        for i in range(batch, len(flags) + batch, batch):
            m = flags[:min(i, len(flags))]
            p, lo, hi = wilson(sum(m), len(m))
            traj.append({"n": len(m), "p": p, "lo": lo, "hi": hi})
            if len(m) == len(flags):
                break
        n, k = len(flags), sum(flags)
        p, lo, hi = wilson(k, n)
        width = hi - lo
        STATE[d.name] = {
            "id": d.name, "status": "done", "stage": None,
            "executions_used": n, "k": k, "estimate": p, "ci": [lo, hi],
            "ci_width": width, "cost_usd": round(cost, 4),
            "cost_naive_usd": round(cost / n * pop, 4),
            "population": pop, "trajectory": traj, "error": None, "requested": req,
            "memory_prior": None, "interval": "wilson",
            "stop_reason": ("precision_met" if width <= req["precision"]["ci_width"]
                            else "population_exhausted" if n >= pop else "budget_cap")}


_rehydrate()


async def _run(script, job_id, extra=()):
    proc = await asyncio.create_subprocess_exec(
        PY, script, "--job", job_id, *extra, env=_env(),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    return proc.returncode, out.decode()


async def run_job(job_id, req):
    """Measure, then remember: every completed job becomes a memory record
    (local mirror + EverOS push), same shape memory_store.py --seed writes."""
    st = STATE[job_id]
    await _measure(job_id, req)
    if st["status"] == "done" and st["executions_used"]:
        rec = {"metric": req.metric.get("name") or req.metric["aggregate_field"],
               "job_id": job_id, "mode": "live",
               "model_version": req.measured.model,
               "n": st["executions_used"], "k": st["k"],
               "rate": round(st["estimate"], 4),
               "ci_lo": round(st["ci"][0], 4), "ci_hi": round(st["ci"][1], 4),
               "cost": round(st["cost_usd"], 4), "ts": time.time()}
        if st.get("memory_prior") and st.get("interval") == "credible":
            rec.update(interval="credible",
                       prior_n_eff=st["memory_prior"]["n_eff"],
                       baseline_n=st["memory_prior"]["baseline_n"],
                       baseline_rate=st["memory_prior"]["baseline_rate"])
        # blocking httpx (8s timeout) off the event loop so polling never stalls
        st["memory"] = await asyncio.to_thread(MemoryStore().remember_result, rec)


async def _measure(job_id, req):
    """batch -> generate -> score -> Wilson -> stop. The product loop (R4)."""
    st = STATE[job_id]
    d = JOBS / job_id
    d.mkdir(parents=True)

    queries = [{"id": f"q-{i:03d}", "text": p, "meta": {}} if isinstance(p, str)
               else {"id": p.id or f"q-{i:03d}", "text": p.text, "meta": p.meta}
               for i, p in enumerate(req.prompts)]
    json.dump({"queries": queries}, open(d / "population.json", "w"), indent=2)
    json.dump({"job_id": job_id, "measured": req.measured.model_dump(),
               "metric": req.metric,
               "requested": req.model_dump()},   # full request -> restart rehydration
              open(d / "job.json", "w"), indent=2)
    agg = req.metric["aggregate_field"]

    st["status"] = "running"

    # warm-start: a remembered same-model baseline becomes a discounted Beta
    # prior (memory_stats.py's recert math) -- fewer fresh queries to converge
    st["stage"] = "recalling memory"
    got = await asyncio.to_thread(MemoryStore().recall_baseline,
                                  req.metric.get("name") or agg)
    base = got and got["baseline"]
    a0 = b0 = None
    if base and base["model_version"] == req.measured.model and base["n"] > 0:
        scale = min(1.0, PRIOR_CAP / base["n"])
        a0, b0 = 1 + base["k"] * scale, 1 + (base["n"] - base["k"]) * scale
        st["memory_prior"] = {"baseline_n": base["n"], "baseline_rate": base["rate"],
                              "n_eff": round(base["n"] * scale),
                              "recall_mode": got["everos_mode"], "drift": None}

    limit, per_q = 0, None
    cap = min(req.budget.max_executions, len(queries))
    while limit < cap:
        # a budget cap only checked after spending isn't a cap: skip a batch we
        # can't afford (per_q unknown until the first batch lands)
        if per_q and st["cost_usd"] + req.batch * per_q > req.budget.max_usd:
            st.update(status="done", stop_reason="budget_cap", stage=None)
            return
        limit = min(limit + req.batch, cap)
        st["stage"] = f"generating {limit}/{cap}"
        rc, out = await _run("runner.py", job_id, ("--limit", str(limit)))
        if rc == 0:
            st["stage"] = f"scoring {limit}/{cap}"
            rc, out = await _run("scorer.py", job_id)
        if rc != 0:
            st.update(status="error", stage=None, error=out[-400:])
            return

        n, k, cost = _read_scores(d, agg)
        if a0 is not None and n >= 5:
            # drift guard: fresh-only vs prior mean; firing it IS the system working
            pp = base["rate"]
            if abs(k / n - pp) / math.sqrt(max(pp * (1 - pp), 1e-6) / n) > DRIFT_Z:
                a0 = None
                st["memory_prior"]["drift"] = "fired -- prior discarded, fresh interval"
        if a0 is not None:
            # report the observed rate; memory sharpens the interval, not the count
            _, lo, hi = _beta_ci(a0 + k, b0 + (n - k))
            p = k / n
            st["interval"] = "credible"
        else:
            p, lo, hi = wilson(k, n)
        per_q = cost / n if n else None
        st.update(executions_used=n, k=k, estimate=p, ci=[lo, hi],
                  ci_width=hi - lo, cost_usd=round(cost, 4),
                  cost_naive_usd=round(per_q * len(queries), 4) if per_q else None,
                  trajectory=st["trajectory"] + [{"n": n, "p": p, "lo": lo, "hi": hi}])

        if hi - lo <= req.precision.ci_width:
            st.update(status="done", stop_reason="precision_met", stage=None)
            return
        if cost >= req.budget.max_usd:
            st.update(status="done", stop_reason="budget_cap", stage=None)
            return

    # population or max_executions exhausted before the target narrowed
    st.update(status="done", stage=None,
              stop_reason="precision_met" if st.get("ci_width", 1) <= req.precision.ci_width
              else "population_exhausted")


@app.post("/jobs")
async def create_job(req: JobRequest):
    if not req.prompts:
        raise HTTPException(422, "prompts must be non-empty")
    if "aggregate_field" not in req.metric or "scorer" not in req.metric:
        raise HTTPException(422, "metric needs scorer + aggregate_field (see jobs/*/job.json)")
    sc = req.metric["scorer"]
    if sc.get("type") == "function" and sc.get("name") not in CHECKS:
        # otherwise this only surfaces as a KeyError inside the scorer subprocess
        raise HTTPException(422, f"unknown built-in check {sc.get('name')!r} "
                                 f"(available: {', '.join(CHECKS)})")
    job_id = f"live_{int(time.time())}"
    STATE[job_id] = {"id": job_id, "status": "queued", "stage": "starting",
                     "executions_used": 0, "k": 0, "estimate": None, "ci": None,
                     "ci_width": None, "cost_usd": 0.0, "cost_naive_usd": None,
                     "population": len(req.prompts), "trajectory": [],
                     "stop_reason": None, "error": None,
                     "memory_prior": None, "interval": "wilson",
                     "requested": req.model_dump()}
    asyncio.create_task(run_job(job_id, req))
    return {"job_id": job_id}


@app.get("/jobs")
async def list_jobs():
    return list(STATE.values())


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    if job_id not in STATE:
        raise HTTPException(404, "no such job")
    return STATE[job_id]


@app.get("/memory")
async def live_memory():
    """Live-job records from the mirror -- the console appends them to the baked
    Remembered-baselines table (which only holds curated records)."""
    p = Path("memory/mirror.jsonl")
    if not p.exists():
        return []
    return [r for line in p.open() if (r := json.loads(line)).get("mode") == "live"]


@app.get("/")
async def console():
    if not Path("margin-console.html").exists():
        raise HTTPException(404, "run: python build_console.py")
    return FileResponse("margin-console.html")


@app.get("/slides")
async def slides():
    return FileResponse("slides.html")
