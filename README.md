# Margin — demo runbook

Precision-targeted measurement for stochastic systems. Spec: `margin-hackathon-plan.md`.
Measured data lives in `jobs/` — **read-only**: never re-run `build_jobs.py` /
`build_stratified_jobs.py` against it, they desync `population.json` from the responses.
Statistical memory lives in `memory/mirror.jsonl` (local mirror of EverOS pushes) —
regenerate only with `rm -rf memory && python3 memory_store.py --seed` then re-run the
`--store` commands below, or the falling-cost chart loses its memory-assisted points.

## Demo (offline — no server, no network)

    python3 build_console.py && open margin-console.html

Single ~1.1 MB file, Plotly inlined, opens from file://. This is slides 3–5:
jobs list → convergence, price list, budget-cap demo, leaderboard, raw responses →
memory panel (baselines, re-cert, change detection, falling-cost chart).
If file:// fights the browser: `python3 -m http.server 8123` → localhost:8123/margin-console.html.

Slides: `open slides.html` (7 slides, arrows/click, `n` toggles speaker notes).

## Memory (EverOS — sponsor beat)

    python3 memory_store.py --smoke     # one store + one recall round-trip
    python3 memory_store.py --seed      # jobs/* baselines -> memory (console counting rule)
    python3 memory_store.py --push      # replay the whole mirror to EverOS (run when EVEROS_API_KEY lands)

    # warm-start re-cert (event run used jobs/recert_own_brand, 15 fresh gpt-5+search queries):
    python3 memory_stats.py recert --job aeo_own_brand --scores-job recert_own_brand --draw 15 --store
    # change-check vs remembered baseline (winner pilot: gpt-4o-mini+search, change confirmed −18.2pts @ n=60):
    python3 memory_stats.py change --job pilot_mini --baseline-metric supergoop_category_share --store

Without `EVEROS_API_KEY` everything runs against the local mirror (mode `local`,
labeled on the console badge); with the key, the same commands emit live EverOS
traffic and cache responses to `memory/everos_log.jsonl` (the wifi-proof fallback).
Rebuild the console after any `--store`/`--seed`: `python3 build_console.py`.

## Operate (the live app)

    ../margin-app2/venv/bin/uvicorn api:app --port 8000 > api.log 2>&1 &   # serves console at /

Open **localhost:8000** — the console gains a "Run a live job" panel (http-only; the
file:// artifact stays a static report): prompts, metric preset, precision, budget →
watch the convergence chart fill in live. New measurements pick a **scorer**: an LLM
judge written from your definition, or a built-in check (`scorer.py` `CHECKS`, free and
exact — the quote drops to generation-only). Add a check by adding it to both `REGISTRY`
and `CHECKS`; the launcher menu and the API's validation follow automatically. API docs with a prefilled runnable example:
**localhost:8000/docs** → POST /jobs → Try it out. Or curl:

    curl -s localhost:8000/openapi.json | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['components']['schemas']['JobRequest']['examples'][0]))" > /tmp/job.json
    curl -s -X POST localhost:8000/jobs -H 'Content-Type: application/json' -d @/tmp/job.json
    curl -s localhost:8000/jobs/<job_id>   # poll: {status, estimate, ci, executions_used, cost_usd, trajectory, ...}

Ready-made populations to upload: `prompts/*.txt` (one prompt per line, regenerate with
`python3 make_prompt_packs.py`) — JSON compliance, prompt-injection resistance, and
sycophancy, with the scorer and precision to pick for each in `prompts/README.md`.

Defaults are cheap (gpt-4o-mini, no search, $1 cap). Needs `OPENAI_API_KEY` (env or `.env`).
Rebuild `margin-console.html` after template edits: `python3 build_console.py`.

## Checks

    python3 stats.py                 # interval math selfcheck
    python3 build_console.py --check # console + memory numbers vs locked slide numbers

## Layout

    stats.py          Wilson interval + price-list N (the one shared definition)
    runner.py         generation engine (async, resumable, per-call cost ledger)
    scorer.py         metric-as-config scorer (LLM judge or deterministic fn + regex validator)
    memory_store.py   EverOS-backed MemoryStore + local mirror (--smoke/--seed/--push)
    memory_stats.py   warm-start re-cert + change-check vs remembered baselines (--store)
    make_pilot_job.py clone a population under a different measured model (pilots/re-certs)
    make_prompt_packs.py  prompts/*.txt populations for the launcher's upload box
    api.py            R1 job API + R4 stopping loop (shells out to runner/scorer)
    build_console.py  jobs/*/ + memory/ -> every displayed number -> margin-console.html
    console.html      console template (dark, single-file output)
    analyze.py        CLI analysis / slide numbers (predates the console, kept as-is)
